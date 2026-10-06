package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.LocalSession
import works.windmill.platform.auth.MemorySessions
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.storage.AtomicDocument
import works.windmill.sync.core.Json
import works.windmill.sync.engine.signIn

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class GymRuntimeTests {
    @get:Rule val tmp = TemporaryFolder()

    private fun TestScope.room(directory: File, clock: WorkoutClock, snapshot: Json? = null,
        workoutAuthority: (String?) -> Boolean = { true }, write: (File, String) -> Unit = AtomicDocument::write) =
        EngineRoomFixture(directory, backgroundScope, snapshot, workoutClock = clock, workoutAuthority = workoutAuthority,
            controlsWrite = write).apply { now = 100_000 }

    private suspend fun EngineRoomFixture.startWorkout(vararg movements: String) {
        select(null)
        val started = store.start()
        assertTrue(started.toString(), started is GymResult.Ok)
        movements.reversed().forEach { store.choose(it) }
    }

    @Test
    fun twoConcurrentDeliveriesAndAColdDuplicatePersistOneOfferedSet() = runTest {
        var moment = WorkoutMoment(101_000, 1_000, "boot")
        val directory = tmp.newFolder()
        room(directory, WorkoutClock { moment }).use { first ->
            first.startWorkout("bench-press")
            val runtime = GymRuntime(first.store, { null }, { true }, StandardTestDispatcher(testScheduler))
            runtime.restoreLocal()
            val offered = requireNotNull(runtime.notification.value?.offer)
            val command = LogSetCommand(offered.key, offered.id)
            val one = async { runtime.logSet(command) }
            val two = async { runtime.logSet(command) }
            assertEquals(LogSetAcceptance.Accepted(offered.id), one.await())
            assertEquals(LogSetAcceptance.Stale, two.await())
            val original = TrainingSet(offered.id, "bench-press", weightKg = 20.0, reps = 5, completedAtMs = moment.wallMs)
            assertEquals(listOf(original), first.store.sets)
            assertEquals(listOf(original), first.training.openWorkout()!!.sets)
            moment = moment.copy(wallMs = 801_000, elapsedMs = 4_000)
            room(directory, WorkoutClock { moment }, first.engine.snapshot()).use { next ->
                val cold = GymRuntime(next.store, { null }, { true }, StandardTestDispatcher(testScheduler))
                assertEquals(LogSetAcceptance.Stale, cold.logSet(command))
                assertEquals(listOf(original), next.store.sets)
                assertEquals(listOf(original), next.training.openWorkout()!!.sets)
            }
        }
    }

    @Test
    fun coldUnresolvedAccountCannotMutateAnAnonymousOfferAndEditorSuppressionSurvivesRecovery() = runTest {
        val moment = WorkoutMoment(101_000, 1_000, "boot")
        val directory = tmp.newFolder()
        val offered = room(directory, WorkoutClock { moment }).use { prepared ->
            prepared.startWorkout("bench-press")
            GymRuntime(prepared.store, { null }, { true }, StandardTestDispatcher(testScheduler)).restoreLocal()
            requireNotNull(prepared.store.notification.value?.offer) to prepared.engine.snapshot()
        }
        val (offer, snapshot) = offered
        val command = LogSetCommand(offer.key, offer.id)
        val before = File(directory, "control.json").readText()
        room(directory, WorkoutClock { moment }, snapshot).use { cold ->
            val blocked = GymRuntime(cold.store, { null }, { false }, StandardTestDispatcher(testScheduler))
            assertTrue(blocked.logSet(command) is LogSetAcceptance.Unavailable)
            assertNull(blocked.notification.value)
            assertFalse(blocked.openWorkout(command.key))
            assertEquals(before, cold.controlsFile.readText())
            assertEquals(emptyList<TrainingSet>(), cold.training.openWorkout()!!.sets)
        }
        val edited = room(directory, WorkoutClock { moment }, snapshot).use { opened ->
            val runtime = GymRuntime(opened.store, { null }, { true }, StandardTestDispatcher(testScheduler))
            runtime.restoreLocal()
            assertEquals(WorkoutChange.Saved, opened.store.editWorkout(true))
            opened.controlsFile.readText() to opened.engine.snapshot()
        }
        room(directory, WorkoutClock { moment }, edited.second).use { cold ->
            val runtime = GymRuntime(cold.store, { null }, { true }, StandardTestDispatcher(testScheduler))
            assertEquals(LogSetAcceptance.Stale, runtime.logSet(command))
            assertNull(runtime.notification.value?.offer)
            assertEquals(edited.first, cold.controlsFile.readText())
            assertEquals(emptyList<TrainingSet>(), cold.training.openWorkout()!!.sets)
        }
    }

    @Test
    fun currentIdentityRevokesOldActionsBeforeReconnectInEitherOwnerSwitchOrder() = runTest {
        for (connectFirst in listOf(false, true)) {
            val moment = WorkoutMoment(101_000, 1_000, "boot")
            room(tmp.newFolder(), WorkoutClock { moment }).use { room ->
                room.select("A")
                assertTrue(room.store.start() is GymResult.Ok)
                room.store.choose("bench-press")
                var owner: String? = "A"
                var allowed = true
                var revision = 0L
                val runtime = GymRuntime(room.store, { owner }, { allowed }, StandardTestDispatcher(testScheduler),
                    authorityRevision = { revision })
                runtime.restoreLocal()
                val original = requireNotNull(runtime.notification.value?.offer)
                val command = LogSetCommand(original.key, original.id)
                owner = "B"; revision += 1
                if (connectFirst) room.select("B")
                assertTrue(runtime.logSet(command) !is LogSetAcceptance.Accepted)
                assertNull(runtime.notification.value)
                assertFalse(runtime.openWorkout(original.key))
                if (!connectFirst) room.select("B")
                owner = "A"; revision += 1
                if (!connectFirst) room.select("A")
                runtime.restoreLocal()
                if (connectFirst) room.select("A")
                assertEquals(LogSetAcceptance.Stale, runtime.logSet(command))
                assertEquals(emptyList<TrainingSet>(), room.training.openWorkout()!!.sets)
                val fresh = requireNotNull(runtime.notification.value?.offer)
                assertNotEquals(original.id, fresh.id)
                allowed = false; revision += 1
                assertTrue(runtime.logSet(LogSetCommand(fresh.key, fresh.id)) is LogSetAcceptance.Unavailable)
                assertNull(runtime.notification.value)
                assertFalse(runtime.openWorkout(fresh.key))
                allowed = true; revision += 1
                runtime.restoreLocal()
                assertEquals(LogSetAcceptance.Stale, runtime.logSet(LogSetCommand(fresh.key, fresh.id)))
                val valid = requireNotNull(runtime.notification.value?.offer)
                assertEquals(LogSetAcceptance.Accepted(valid.id), runtime.logSet(LogSetCommand(valid.key, valid.id)))
                assertEquals(listOf(TrainingSet(valid.id, "bench-press", weightKg = 20.0, reps = 5,
                    completedAtMs = moment.wallMs)), room.training.openWorkout()!!.sets)
            }
        }
    }

    @Test
    fun actualAccountCommitRejectsDirectWorkoutMutationsBeforeAnyAccountObserverRuns() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            val ana = User("A", "a@example.com")
            val bea = User("B", "b@example.com")
            val sessions = MemorySessions("secret-A", ana)
            val auth = AuthStore(server.url("/"), sessions)
            val moment = WorkoutMoment(101_000, 1_000, "boot")
            room(tmp.newFolder(), WorkoutClock { moment },
                workoutAuthority = { selected -> (sessions.localSession as? LocalSession.Owned)?.user?.id == selected }).use { room ->
                room.select("A")
                room.now = 1_000
                assertTrue(room.store.start() is GymResult.Ok)
                room.store.choose("bench-press"); room.store.logSet(30.0, 8)
                room.now = 2_000
                val previous = (room.store.finish() as FinishOutcome.Closed).session
                room.now = 100_000
                assertTrue(room.store.start() is GymResult.Ok)
                val live = requireNotNull(room.store.session)
                room.store.choose("bench-press"); room.store.choose("overhead-press"); room.store.choose("bench-press")
                assertNull(room.store.savePreferences(GymPreferences(confirmSound = true)))
                val runtime = GymRuntime(room.store, { sessions.user()?.id }, { sessions.localSession is LocalSession.Owned },
                    StandardTestDispatcher(testScheduler), authorityRevision = { auth.identityRevision })
                runtime.restoreLocal()
                val first = requireNotNull(runtime.notification.value?.offer)
                assertEquals(LogSetAcceptance.Accepted(first.id), runtime.logSet(LogSetCommand(first.key, first.id)))
                val accepted = room.store.sets.single()
                val original = requireNotNull(runtime.notification.value?.offer)
                val before = room.engine.snapshot()
                val controlsBefore = room.controlsFile.readText()
                server.enqueue(MockResponse().setBody("""{"user":{"id":"B","email":"b@example.com"}}""")
                    .addHeader("Set-Cookie", "wm_session=secret-B; Path=/; HttpOnly"))
                auth.completeCode("b@example.com", "222222")
                assertEquals(AuthStatus.SignedIn(bea), auth.status)
                assertEquals("u.A", room.store.accountKey)
                assertTrue(room.store.acceptSet(LogSetCommand(original.key, original.id)) is LogSetAcceptance.Unavailable)
                room.store.logSet(30.0, 8, SetKind.Warmup)
                assertEquals(FinishOutcome.Failed(WriteFailure.Refused("The account must be restored first.")), room.store.finish())
                room.store.choose("overhead-press")
                room.store.reorder(0, 1)
                assertFalse(room.store.drop("overhead-press"))
                assertEquals(FixOutcome.Failed(WriteFailure.Refused("the account changed while fixing")),
                    room.store.fixSet(live.id, accepted.id, SetFix(weightKg = 40.0)))
                assertEquals(WriteFailure.Refused("the account changed while deleting"), room.store.deleteSet(live.id, accepted.id))
                assertFalse(room.store.discard(previous.id))
                assertTrue(room.store.savePreferences(GymPreferences(confirmHaptic = false)) is WriteFailure.Refused)
                room.store.connect(Account(auth.accountApi(ana), ana))
                assertEquals("u.A", room.store.accountKey)
                assertEquals(GymPreferences(confirmSound = true), room.training.settings())
                assertEquals(listOf(accepted), room.store.sets)
                assertEquals(listOf("bench-press", "overhead-press"), room.store.order)
                assertEquals("bench-press", room.store.exerciseId)
                assertEquals(live.id, room.store.session?.id)
                assertEquals(before, room.engine.snapshot())
                assertEquals(controlsBefore, room.controlsFile.readText())
                assertNull(room.store.notification.value)
                assertEquals("Bearer secret-A", server.takeRequest().getHeader("Authorization"))
                assertFalse(runtime.openWorkout(original.key))
                room.store.connect(Account(auth.accountApi(bea), bea))
                assertTrue(runtime.logSet(LogSetCommand(original.key, original.id)) !is LogSetAcceptance.Accepted)
                assertEquals(listOf(accepted), room.training.session(live.id)!!.sets)
                assertEquals(previous, room.training.session(previous.id)!!.session)
            }
        } finally { server.shutdown() }
    }

    @Test
    fun addedOwnerPreflightRevokesTheAnonymousCardBeforeAccountProjection() = runTest {
        val moment = WorkoutMoment(101_000, 1_000, "boot")
        room(tmp.newFolder(), WorkoutClock { moment }).use { room ->
            room.startWorkout("bench-press")
            val anonymous = requireNotNull(room.store.session)
            var owner: String? = null
            val runtime = GymRuntime(room.store, { owner }, { true }, StandardTestDispatcher(testScheduler))
            runtime.restoreLocal()
            val first = requireNotNull(runtime.notification.value?.offer)
            assertEquals(LogSetAcceptance.Accepted(first.id), runtime.logSet(LogSetCommand(first.key, first.id)))
            val original = TrainingSet(first.id, "bench-press", weightKg = 20.0, reps = 5, completedAtMs = moment.wallMs)
            val old = requireNotNull(runtime.notification.value?.offer)
            room.store.prepareEngineTransition()
            room.engine.signIn("B", mapOf("gym" to true), mapOf("gym" to "add"))
            owner = "B"
            runtime.restoreLocal()
            assertNull(room.store.notification.value)
            assertFalse(runtime.openWorkout(old.key))
            assertTrue(runtime.logSet(LogSetCommand(old.key, old.id)) !is LogSetAcceptance.Accepted)
            room.selected = "B"
            room.store.connect(room.account("B"))
            assertEquals(LogSetAcceptance.Stale, runtime.logSet(LogSetCommand(old.key, old.id)))
            assertEquals("u.B", room.store.accountKey)
            assertEquals(anonymous.id, room.store.session?.id)
            assertEquals("Add keeps the original set identity and its own workout", listOf(original), room.store.sets)
            assertEquals(listOf(original), room.training.session(anonymous.id)!!.sets)
            assertTrue(room.engine.snapshot().member("replicas").arr().none { it.member("meta").member("state") == Json.of("anon") })
        }
    }

    @Test
    fun failedOrUncertainAcceptanceNeverReportsSuccessAndOnlyDiskRecoveryCanResolveIt() = runTest {
        for (afterReplace in listOf(false, true)) {
            val moment = WorkoutMoment(101_000, 1_000, "boot")
            var fail = false
            room(tmp.newFolder(), WorkoutClock { moment }, write = { path, text ->
                if (fail && !afterReplace) throw IOException("before write")
                AtomicDocument.write(path, text)
                if (fail) throw IOException("after replacement")
            }).use { room ->
                room.startWorkout("bench-press")
                val runtime = GymRuntime(room.store, { null }, { true }, StandardTestDispatcher(testScheduler))
                runtime.restoreLocal()
                val offer = requireNotNull(runtime.notification.value?.offer)
                val command = LogSetCommand(offer.key, offer.id)
                val before = room.controlsFile.readText()
                fail = true
                assertTrue(runtime.logSet(command) is LogSetAcceptance.Unavailable)
                assertTrue(runtime.logSet(command) is LogSetAcceptance.Unavailable)
                assertEquals(emptyList<TrainingSet>(), room.store.sets)
                assertNull(runtime.notification.value?.offer)
                assertEquals("the engine never holds a set the phone could not save", emptyList<TrainingSet>(),
                    room.training.openWorkout()!!.sets)
                val reopened = SetQueue(room.controlsFile)
                if (!afterReplace) {
                    assertEquals(before, room.controlsFile.readText())
                    assertEquals(emptyList<TrainingSet>(), reopened.sets)
                } else {
                    assertEquals(listOf(TrainingSet(offer.id, "bench-press", weightKg = 20.0, reps = 5,
                        completedAtMs = moment.wallMs)), reopened.sets)
                    assertEquals(setOf(offer.id), reopened.workout.consumed)
                    assertEquals(offer.id, reopened.latestSet(moment)?.id)
                }
            }
        }
    }

    @Test
    fun anUnreadableSavedWorkoutReportsRecoveryInsteadOfCrashingDuringReconnect() = runTest {
        val raw = """{"queues":{"anon":{"session":{"id":"session","startedAt":100000},"order":["bench-press"],"chosenMovement":"bench-press","workout":{"version":2}}}}"""
        val directory = tmp.newFolder()
        val file = File(directory, "control.json").apply { writeText(raw) }
        val moment = WorkoutMoment(101_000, 1_000, "boot")
        room(directory, WorkoutClock { moment }).use { room ->
            val runtime = GymRuntime(room.store, { null }, { true }, StandardTestDispatcher(testScheduler))
            runtime.restoreLocal()
            room.select(null)
            assertFalse(room.store.isLoading)
            assertEquals("The workout could not be saved safely. Restart the app to recover it.", room.store.workoutFailure)
            assertNull(runtime.notification.value)
            assertEquals(raw, file.readText())
            assertTrue(room.store.start() is GymResult.Failed)
            assertEquals(raw, file.readText())
            assertNull(room.training.openWorkout())
        }
    }

    @Test
    fun coldAutoCloseRetiresTheOldWorkoutWithoutLosingSets() = runTest {
        var moment = WorkoutMoment(101_000, 1_000, "boot")
        val directory = tmp.newFolder()
        val (offer, snapshot) = room(directory, WorkoutClock { moment }).use { first ->
            first.startWorkout("bench-press")
            assertNull(first.store.savePreferences(GymPreferences(confirmSound = true)))
            val runtime = GymRuntime(first.store, { null }, { true }, StandardTestDispatcher(testScheduler))
            runtime.restoreLocal()
            val offer = requireNotNull(runtime.notification.value?.offer)
            assertEquals(LogSetAcceptance.Accepted(offer.id), runtime.logSet(LogSetCommand(offer.key, offer.id)))
            offer to first.engine.snapshot()
        }
        moment = moment.copy(wallMs = moment.wallMs + AutoClose.AFTER_MS, elapsedMs = moment.elapsedMs + AutoClose.AFTER_MS)
        room(directory, WorkoutClock { moment }, snapshot).use { cold ->
            cold.now = moment.wallMs
            val runtime = GymRuntime(cold.store, { null }, { true }, StandardTestDispatcher(testScheduler))
            runtime.restoreLocal()
            assertNull(runtime.notification.value)
            val controls = cold.controlsFile.readText()
            runtime.restoreLocal()
            assertFalse(runtime.openWorkout(offer.key))
            assertEquals(controls, cold.controlsFile.readText())
            val saved = cold.training.details().single()
            assertEquals(101_000L, saved.session.finishedAtMs)
            assertEquals(listOf(offer.id), saved.sets.map { it.id })
            assertNull(cold.training.openWorkout())
            assertNull(SetQueue(cold.controlsFile).session)
        }
    }
}
