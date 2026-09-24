package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
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
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.storage.AtomicDocument

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class GymRuntimeTests {
    @get:Rule val tmp = TemporaryFolder()

    private fun store(queue: SetQueue, scope: CoroutineScope, clock: WorkoutClock) = TrainingStore(
        queue, DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
        LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "bodyweight")),
        scope, now = { clock.now().wallMs }, workoutClock = clock,
        sync = { error("local restoration must never request a transport") },
    )

    @Test
    fun twoConcurrentDeliveriesAndAColdDuplicatePersistOneOfferedSet() = runTest {
        var moment = WorkoutMoment(101_000, 1_000, "boot")
        val file = File(tmp.root, "sets")
        val queue = SetQueue(file)
        queue.hold(Session("session", 100_000))
        queue.choose("bench-press")
        val first = store(queue, backgroundScope, WorkoutClock { moment })
        val runtime = GymRuntime(first, { null }, { true }, StandardTestDispatcher(testScheduler))
        runtime.restoreLocal()
        val offered = requireNotNull(runtime.notification.value?.offer)
        val command = LogSetCommand(offered.key, offered.id)
        val one = async { runtime.logSet(command) }
        val two = async { runtime.logSet(command) }
        assertEquals(LogSetAcceptance.Accepted(offered.id), one.await())
        assertEquals(LogSetAcceptance.Stale, two.await())
        val original = TrainingSet(offered.id, "bench-press", weightKg = 20.0, reps = 5, completedAtMs = moment.wallMs)
        assertEquals(listOf(original), first.sets)
        val disk = SetQueue(file)
        assertEquals(listOf(original), disk.pending.map { it.set })
        assertEquals(setOf(offered.id), disk.workout.consumed)
        moment = moment.copy(wallMs = 801_000, elapsedMs = 4_000)
        val next = store(SetQueue(file), backgroundScope, WorkoutClock { moment })
        val cold = GymRuntime(next, { null }, { true }, StandardTestDispatcher(testScheduler))
        assertEquals(LogSetAcceptance.Stale, cold.logSet(command))
        assertEquals(listOf(original), next.sets)
        assertEquals(listOf(original), SetQueue(file).sets)
    }

    @Test
    fun coldUnresolvedAccountCannotMutateAnAnonymousOfferAndEditorSuppressionSurvivesRecovery() = runTest {
        val moment = WorkoutMoment(101_000, 1_000, "boot")
        val file = File(tmp.root, "sets")
        val queue = SetQueue(file)
        queue.hold(Session("session", 100_000))
        queue.choose("bench-press")
        queue.prepare(null, moment, true) { "old-offer" }
        val before = file.readText()
        val blocked = GymRuntime(store(SetQueue(file), backgroundScope, WorkoutClock { moment }),
            { null }, { false }, StandardTestDispatcher(testScheduler))
        val command = LogSetCommand(WorkoutKey("anon", "session"), "old-offer")
        assertTrue(blocked.logSet(command) is LogSetAcceptance.Unavailable)
        assertNull(blocked.notification.value)
        assertFalse(blocked.openWorkout(command.key))
        assertEquals(before, file.readText())
        val opened = store(SetQueue(file), backgroundScope, WorkoutClock { moment })
        val runtime = GymRuntime(opened, { null }, { true }, StandardTestDispatcher(testScheduler))
        runtime.restoreLocal()
        assertEquals(WorkoutChange.Saved, opened.editWorkout(true))
        val edited = file.readText()
        val cold = GymRuntime(store(SetQueue(file), backgroundScope, WorkoutClock { moment }),
            { null }, { true }, StandardTestDispatcher(testScheduler))
        assertEquals(LogSetAcceptance.Stale, cold.logSet(command))
        assertNull(cold.notification.value?.offer)
        assertEquals(edited, file.readText())
        assertEquals(emptyList<TrainingSet>(), SetQueue(file).sets)
    }

    @Test
    fun currentIdentityRevokesOldActionsBeforeReconnectInEitherOwnerSwitchOrder() = runTest {
        for (connectFirst in listOf(false, true)) {
            val file = File(tmp.root, "switch-$connectFirst")
            val moment = WorkoutMoment(101_000, 1_000, "boot")
            val queue = SetQueue(file, "A")
            queue.hold(Session("session-A", 100_000)); queue.choose("bench-press")
            var owner: String? = "A"
            var allowed = true
            var revision = 0L
            val store = TrainingStore(queue, DeviceCopy(File(tmp.root, "copy-$connectFirst")),
                LocalLog(File(tmp.root, "log-$connectFirst")), LocalPreferences(File(tmp.root, "prefs-$connectFirst")),
                LocalBodyweight(File(tmp.root, "weight-$connectFirst")), backgroundScope,
                now = { moment.wallMs }, workoutClock = WorkoutClock { moment }, sync = { null })
            val runtime = GymRuntime(store, { owner }, { allowed }, StandardTestDispatcher(testScheduler),
                authorityRevision = { revision })
            fun account() = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }),
                owner?.let { User(it, "$it@example.com") }, locallyTrusted = allowed, identityRevision = revision)
            runtime.restoreLocal()
            val original = requireNotNull(runtime.notification.value?.offer)
            val command = LogSetCommand(original.key, original.id)
            owner = "B"; revision += 1
            if (connectFirst) store.connect(account())
            assertTrue(runtime.logSet(command) !is LogSetAcceptance.Accepted)
            assertNull(runtime.notification.value)
            assertFalse(runtime.openWorkout(original.key))
            if (!connectFirst) store.connect(account())
            owner = "A"; revision += 1
            if (!connectFirst) store.connect(account())
            runtime.restoreLocal()
            if (connectFirst) store.connect(account())
            assertEquals(LogSetAcceptance.Stale, runtime.logSet(command))
            assertEquals(emptyList<TrainingSet>(), SetQueue(file, "A").sets)
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
                completedAtMs = moment.wallMs)), SetQueue(file, "A").sets)
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
            val file = File(tmp.root, "direct-logger")
            val queue = SetQueue(file, "A")
            val moment = WorkoutMoment(101_000, 1_000, "boot")
            queue.hold(Session("session-A", 100_000), unclaimed = true)
            queue.choose("bench-press"); queue.append("overhead-press")
            val logFile = File(tmp.root, "direct-log")
            val local = LocalLog(logFile, "A")
            val previous = LocalLog.FinishedSession(Session("past-A", 1_000, 2_000),
                listOf(TrainingSet("past-set", "bench-press", weightKg = 30.0, reps = 8, completedAtMs = 1_500)))
            local.hold(previous)
            val preferencesFile = File(tmp.root, "direct-prefs")
            val preferences = LocalPreferences(preferencesFile)
            preferences.adopt("A"); preferences.save(GymPreferences(confirmSound = true))
            val store = TrainingStore(queue, DeviceCopy(File(tmp.root, "direct-copy")),
                local, preferences,
                LocalBodyweight(File(tmp.root, "direct-weight")), backgroundScope, now = { moment.wallMs },
                workoutClock = WorkoutClock { moment }, sync = { null },
                workoutAuthority = { selected -> (sessions.localSession as? LocalSession.Owned)?.user?.id == selected })
            val runtime = GymRuntime(store, { sessions.user()?.id }, { sessions.localSession is LocalSession.Owned },
                StandardTestDispatcher(testScheduler), authorityRevision = { auth.identityRevision })
            runtime.restoreLocal()
            val first = requireNotNull(runtime.notification.value?.offer)
            assertEquals(LogSetAcceptance.Accepted(first.id), runtime.logSet(LogSetCommand(first.key, first.id)))
            val accepted = store.sets.single()
            val original = requireNotNull(runtime.notification.value?.offer)
            val shelfBefore = logFile.readText()
            val preferencesBefore = preferencesFile.readText()
            val before = file.readText()
            server.enqueue(MockResponse().setBody("""{"user":{"id":"B","email":"b@example.com"}}""")
                .addHeader("Set-Cookie", "wm_session=secret-B; Path=/; HttpOnly"))
            auth.completeCode("b@example.com", "222222")
            assertEquals(AuthStatus.SignedIn(bea), auth.status)
            assertEquals("u.A", store.accountKey)
            assertTrue(store.acceptSet(LogSetCommand(original.key, original.id)) is LogSetAcceptance.Unavailable)
            store.logSet(30.0, 8, SetKind.Warmup)
            assertEquals(FinishOutcome.Failed(WriteFailure.Refused("The account must be restored first.")), store.finish())
            store.choose("overhead-press")
            store.reorder(0, 1)
            assertFalse(store.drop("overhead-press"))
            assertEquals(FixOutcome.Failed(WriteFailure.Refused("the account changed while fixing")),
                store.fixSet("session-A", accepted.id, SetFix(weightKg = 40.0)))
            assertEquals(WriteFailure.Refused("the account changed while deleting"), store.deleteSet("session-A", accepted.id))
            assertFalse(store.discard("past-A"))
            assertTrue(store.savePreferences(GymPreferences(confirmHaptic = false)) is WriteFailure.Refused)
            store.connect(Account(auth.accountApi(ana), ana))
            assertEquals("u.A", store.accountKey)
            assertEquals(preferencesBefore, preferencesFile.readText())
            assertEquals(listOf(accepted), store.sets)
            assertEquals(listOf("bench-press", "overhead-press"), store.order)
            assertEquals("bench-press", store.exerciseId)
            assertEquals("session-A", store.session?.id)
            assertEquals(shelfBefore, logFile.readText())
            assertEquals(before, file.readText())
            assertNull(store.notification.value)
            assertEquals("Bearer secret-A", server.takeRequest().getHeader("Authorization"))
            assertFalse(runtime.openWorkout(original.key))
            store.connect(Account(auth.accountApi(bea), bea))
            assertTrue(runtime.logSet(LogSetCommand(original.key, original.id)) !is LogSetAcceptance.Accepted)
            assertEquals(listOf(accepted), SetQueue(file, "A").sets)
            assertEquals(previous, LocalLog(logFile, "A").finished.single())
        } finally { server.shutdown() }
    }

    @Test
    fun approvedOwnerPreflightClearsTheAnonymousCardBeforeItsSuspendedRead() = runTest {
        val file = File(tmp.root, "preflight")
        var moment = WorkoutMoment(101_000, 1_000, "boot")
        val queue = SetQueue(file)
        queue.hold(Session("anonymous", 100_000), unclaimed = true); queue.choose("bench-press")
        val release = CompletableDeferred<Unit>()
        val server = FakeTraining().apply { nowMs = { moment.wallMs } }
        val wire = object : TrainingSyncing by server {
            override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
                release.await()
                return server.sessions(limit, before, beforeId)
            }
        }
        var owner: String? = null
        val local = LocalLog(File(tmp.root, "local-preflight"))
        val preferences = LocalPreferences(File(tmp.root, "prefs-preflight"))
        preferences.save(GymPreferences(confirmSound = true))
        val store = TrainingStore(queue, DeviceCopy(File(tmp.root, "copy-preflight")), local,
            preferences, LocalBodyweight(File(tmp.root, "weight-preflight")),
            backgroundScope, now = { moment.wallMs }, workoutClock = WorkoutClock { moment }, sync = { wire })
        val runtime = GymRuntime(store, { owner }, { true }, StandardTestDispatcher(testScheduler))
        runtime.restoreLocal()
        val first = requireNotNull(runtime.notification.value?.offer)
        assertEquals(LogSetAcceptance.Accepted(first.id), runtime.logSet(LogSetCommand(first.key, first.id)))
        val original = TrainingSet(first.id, "bench-press", weightKg = 20.0, reps = 5, completedAtMs = moment.wallMs)
        val old = requireNotNull(runtime.notification.value?.offer)
        val flow = requireNotNull(store.requestClaimSignIn())
        store.approveSignIn("B", flow)
        owner = "B"
        val connect = async { store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), User("B", "b@example.com"))) }
        runCurrent()
        assertFalse(connect.isCompleted)
        assertNull(store.notification.value)
        assertNull(store.session)
        assertNull(store.rack)
        assertEquals(emptyList<TrainingSet>(), store.sets)
        assertFalse(runtime.openWorkout(old.key))
        assertTrue(runtime.logSet(LogSetCommand(old.key, old.id)) !is LogSetAcceptance.Accepted)
        assertEquals(emptyList<SessionStart>(), server.started)
        assertEquals(listOf(original), SetQueue(file).sets)
        release.complete(Unit)
        connect.await()
        assertEquals(LogSetAcceptance.Stale, runtime.logSet(LogSetCommand(old.key, old.id)))
        assertEquals("u.B", store.accountKey)
        assertEquals("anonymous", store.session?.id)
        val claimed = SetQueue(file, "B")
        assertEquals("the claim delivers the set at once", listOf(original.copy(setNumber = 1)), claimed.sets)
        assertEquals(emptyList<SetQueue.Entry>(), claimed.pending)
        assertEquals(first.id, claimed.latestSet(moment)?.id)
        assertNull(SetQueue(file).session)
        moment = moment.copy(wallMs = moment.wallMs + 90_000, elapsedMs = moment.elapsedMs + 90_000)
    }

    @Test
    fun failedOrUncertainAcceptanceNeverReportsSuccessAndOnlyDiskRecoveryCanResolveIt() = runTest {
        for (afterReplace in listOf(false, true)) {
            val file = File(tmp.root, "sets-$afterReplace")
            val moment = WorkoutMoment(101_000, 1_000, "boot")
            var fail = false
            val queue = SetQueue(file, write = { path, text ->
                if (fail && !afterReplace) throw IOException("before write")
                AtomicDocument.write(path, text)
                if (fail) throw IOException("after replacement")
            })
            queue.hold(Session("session", 100_000))
            queue.choose("bench-press")
            val held = store(queue, backgroundScope, WorkoutClock { moment })
            val runtime = GymRuntime(held, { null }, { true }, StandardTestDispatcher(testScheduler))
            runtime.restoreLocal()
            val offer = requireNotNull(runtime.notification.value?.offer)
            val command = LogSetCommand(offer.key, offer.id)
            val before = file.readText()
            fail = true
            assertTrue(runtime.logSet(command) is LogSetAcceptance.Unavailable)
            assertTrue(runtime.logSet(command) is LogSetAcceptance.Unavailable)
            assertEquals(emptyList<TrainingSet>(), held.sets)
            assertNull(runtime.notification.value?.offer)
            val reopened = SetQueue(file)
            if (!afterReplace) {
                assertEquals(before, file.readText())
                assertEquals(emptyList<TrainingSet>(), reopened.sets)
            } else {
                assertEquals(listOf(TrainingSet(offer.id, "bench-press", weightKg = 20.0, reps = 5,
                    completedAtMs = moment.wallMs)), reopened.sets)
                assertEquals(setOf(offer.id), reopened.workout.consumed)
                assertEquals(offer.id, reopened.latestSet(moment)?.id)
            }
        }
    }

    @Test
    fun aLegacyWorkoutWithARecentSetStaysOpenAcrossUpgradeAndWallClockChanges() = runTest {
        val started = 1_000_000L
        val setAt = started + AutoClose.AFTER_MS
        val set = TrainingSet("recent", "bench-press", weightKg = 60.0, reps = 8, completedAtMs = setAt)
        for (wallShift in listOf(0L, -3_600_000L)) {
            val file = File(tmp.root, "legacy-$wallShift")
            file.writeText("""{"queues":{"anon":{"session":{"id":"session","startedAt":$started},"entries":{"recent":{"set":{"id":"recent","exerciseId":"bench-press","weightKg":60.0,"reps":8,"completedAt":$setAt},"sessionId":"session","needsPush":true,"remints":0,"loggedAtMs":$setAt,"event":{"id":"recent","origin":{"wallMs":$setAt,"elapsedMs":14401000,"bootId":"boot"}},"eventOrder":3}},"order":["bench-press"],"chosenMovement":"bench-press","unclaimed":true,"workout":{"bootId":"boot","started":{"wallMs":$started,"elapsedMs":1000,"bootId":"boot"},"rest":{"id":"recent","origin":{"wallMs":$setAt,"elapsedMs":14401000,"bootId":"boot"},"targetSeconds":90,"alertRevision":3,"attempted":false}}}}}""")
            val now = WorkoutMoment(setAt + 60_000 + wallShift, 14_461_000, "boot")
            val coldStore = store(SetQueue(file), backgroundScope, WorkoutClock { now })
            val cold = GymRuntime(coldStore, { null }, { true }, StandardTestDispatcher(testScheduler))
            cold.restoreLocal()
            assertEquals(Session("session", started), coldStore.session)
            assertEquals(listOf(set), coldStore.sets)
            assertEquals("session", cold.notification.value?.key?.sessionId)
            assertTrue(SetQueue(file).writable)
            assertNotNull(cold.notification.value?.offer)
            assertEquals(Session("session", started), SetQueue(file).session)
        }
    }

    @Test
    fun the093SavedWorkoutReconnectsAndContinuesItsNextSetExactlyOnce() = runTest {
        val raw = requireNotNull(javaClass.getResourceAsStream("/works/windmill/gym/store/set-queue-0.9.3.json"))
            .bufferedReader().use { it.readText() }
        val file = File(tmp.root, "sets.json").apply { writeText(raw) }
        val queue = SetQueue(file)
        assertTrue(queue.writable)
        assertEquals(raw, file.readText())
        val started = 1_790_281_042_943L
        val setAt = 1_790_281_045_070L
        val moment = WorkoutMoment(setAt + 60_000, 821_156, "boot:8")
        val live = Session("ses_2a4af890d6847b7f", started, routineId = "rt_d8b732ed2a49f4ff",
            plan = PlanSnapshot("Cleanliness upgrade", entries = listOf(PlanEntry("bench-press"))))
        val original = TrainingSet("set_f5cd00cda9ab6976", "bench-press", weightKg = 20.0,
            reps = 5, completedAtMs = setAt)
        val store = TrainingStore(queue, DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "bodyweight")),
            backgroundScope, now = { moment.wallMs }, workoutClock = WorkoutClock { moment },
            mintSet = { "next-set" }, sync = { null })
        val runtime = GymRuntime(store, { null }, { true }, StandardTestDispatcher(testScheduler))
        runtime.restoreLocal()
        store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), null))
        assertNull(store.workoutFailure)
        assertEquals(live, store.session)
        assertEquals(listOf(original), store.sets)
        assertEquals(listOf(SetQueue.Entry(original, live.id, true, 0, setAt,
            WorkoutEvent(original.id, WorkoutMoment(setAt, 761_156, "boot:8")), eventOrder = 4)), queue.pending)
        val offered = requireNotNull(runtime.notification.value?.offer)
        assertEquals(LogSetOffer(WorkoutKey("anon", live.id), "set_cf23e0d077731ad8", 6,
            "bench-press", 2, 20.0, 5), offered)
        val command = LogSetCommand(offered.key, offered.id)
        assertEquals(LogSetAcceptance.Accepted(offered.id), runtime.logSet(command))
        assertEquals(LogSetAcceptance.Stale, runtime.logSet(command))
        val second = TrainingSet(offered.id, "bench-press", weightKg = 20.0, reps = 5, completedAtMs = moment.wallMs)
        val reopened = SetQueue(file)
        assertTrue(reopened.writable)
        assertEquals(live, reopened.session)
        assertEquals(listOf(original, second), reopened.sets)
        assertEquals(setOf(original.id, second.id), reopened.workout.consumed)
        assertEquals(3, reopened.workout.offer?.workingOrdinal)
        assertEquals("next-set", reopened.workout.offer?.id)
    }

    @Test
    fun anUnreadableSavedWorkoutReportsRecoveryInsteadOfCrashingDuringReconnect() = runTest {
        val raw = """{"queues":{"anon":{"session":{"id":"session","startedAt":100000},"order":["bench-press"],"chosenMovement":"bench-press","workout":{"version":2}}}}"""
        val file = File(tmp.root, "sets.json").apply { writeText(raw) }
        val queue = SetQueue(file)
        val moment = WorkoutMoment(101_000, 1_000, "boot")
        val store = TrainingStore(queue, DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "bodyweight")),
            backgroundScope, now = { moment.wallMs }, workoutClock = WorkoutClock { moment }, sync = { null })
        val runtime = GymRuntime(store, { null }, { true }, StandardTestDispatcher(testScheduler))
        runtime.restoreLocal()
        store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), null))
        assertFalse(store.isLoading)
        assertEquals("The workout could not be saved safely. Restart the app to recover it.", store.workoutFailure)
        assertNull(runtime.notification.value)
        assertFalse(queue.writable)
        assertEquals(raw, file.readText())
        assertTrue(store.start() is GymResult.Failed)
        assertEquals(raw, file.readText())
    }

    @Test
    fun coldAutoCloseRetiresTheOldWorkoutWithoutLosingSets() = runTest {
        var moment = WorkoutMoment(101_000, 1_000, "boot")
        val file = File(tmp.root, "sets")
        val queue = SetQueue(file)
        queue.hold(Session("session", 100_000), unclaimed = true)
        queue.choose("bench-press")
        val prefs = LocalPreferences(File(tmp.root, "prefs"))
        prefs.save(GymPreferences(confirmSound = true))
        val first = store(queue, backgroundScope, WorkoutClock { moment })
        val runtime = GymRuntime(first, { null }, { true }, StandardTestDispatcher(testScheduler))
        runtime.restoreLocal()
        val offer = requireNotNull(runtime.notification.value?.offer)
        runtime.logSet(LogSetCommand(offer.key, offer.id))
        moment = moment.copy(wallMs = moment.wallMs + AutoClose.AFTER_MS, elapsedMs = moment.elapsedMs + AutoClose.AFTER_MS)
        val coldStore = store(SetQueue(file), backgroundScope, WorkoutClock { moment })
        val cold = GymRuntime(coldStore, { null }, { true }, StandardTestDispatcher(testScheduler))
        cold.restoreLocal()
        assertNull(cold.notification.value)
        val snapshot = file.readText()
        cold.restoreLocal()
        assertFalse(cold.openWorkout(offer.key))
        assertEquals(snapshot, file.readText())
        val saved = requireNotNull(LocalLog(File(tmp.root, "log")).detail("session"))
        assertEquals(101_000L, saved.session.finishedAtMs)
        assertEquals(listOf(offer.id), saved.sets.map { it.id })
        assertNull(SetQueue(file).session)
    }
}
