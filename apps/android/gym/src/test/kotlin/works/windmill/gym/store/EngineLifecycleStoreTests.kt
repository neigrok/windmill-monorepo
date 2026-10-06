package works.windmill.gym.store

import kotlin.time.Duration.Companion.minutes
import java.io.File
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.sync.core.*
import works.windmill.sync.engine.*
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// These are the former TrainingStore claim cases. The room still draws the same workout,
// catalogue, settings and history; the engine now owns admission and account decisions.
class EngineLifecycleStoreTests {
    @get:Rule val tmp = TemporaryFolder()
    private var clockMs = 1_800_000_000_000L
    private var nextSet = 0
    private var nextSession = 0
    private fun account(id: String? = null, verified: Boolean = true) =
        Account("https://windmill.works", id?.let { User(it, "$it@example.com") }, verified = verified)
    private fun engine(snapshot: Json? = null) = Engine.memory(SyncSchema.registry, snapshot,
        clock = object : EngineClock { override fun now() = clockMs },
        commandResultWrites = WorkoutImports.commandResultWrites,
        pendingDeviceWork = WorkoutImports.pendingDeviceWork,
        rewriteDeviceValue = WorkoutImports.rewriteDeviceValue)
    private data class Room(val gym: EngineTraining, val store: TrainingStore)
    private fun TestScope.room(engine: Engine): Room {
        val gym = EngineTraining(engine)
        return Room(gym, TrainingStore(WorkoutControls(File(tmp.root, "control.json")), gym, backgroundScope,
            now = { ++clockMs }, mintSession = { "session${++nextSession}" }, mintSet = { "set${(++nextSet).toString().padStart(5, '0')}" },
            undoWindowMs = 0))
    }
    private suspend fun Room.workout(weight: Double = 82.5, movement: String = "bench-press", finish: Boolean = true): Session {
        val opened = (store.start() as GymResult.Ok).value
        store.choose(movement)
        store.logSet(weight, 5)
        clockMs += 60_000
        if (finish) store.finish()
        return opened
    }
    private suspend fun Room.add(engine: Engine, id: String = "A") {
        store.prepareEngineTransition()
        assertTrue(engine.signIn(id, mapOf("gym" to true), mapOf("gym" to "add")).member("complete").bool())
        store.connect(account(id))
    }
    private fun finished(start: Long = clockMs - 10_000, finish: Long = clockMs - 5_000) =
        SavedWorkout(Session("session1", start, finish), listOf(TrainingSet("set00001", "bench-press",
            weightKg = 82.5, reps = 5, completedAtMs = start + 1_000)))
    private fun outbox(engine: Engine) = engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }

    @Test fun customMovementSurvivesRelaunchAndAddWithTheSameIdentity() = runTest {
        val first = engine()
        val initial = room(first)
        initial.store.connect(account())
        val made = (initial.store.create("Sled Push", "machine", "exercise1") as GymResult.Ok).value
        val snapshot = first.snapshot(); first.close()
        engine(snapshot).use { restored ->
            val room = room(restored)
            room.store.connect(account())
            assertEquals(made, room.store.catalog.single { it.id == made.id })
            room.add(restored)
            assertEquals(made, room.store.catalog.single { it.id == made.id })
        }
    }

    @Test fun addPreservesFinishedAndLiveWorkoutsAndFrozenRoutineLineage() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account())
            val routine = (room.store.keep(listOf(TrainingSet("seed0001", "bench-press", weightKg = 100.0, reps = 5,
                completedAtMs = clockMs - 1)), "Push Day", creationId = "routine1") as GymResult.Ok).value
            val first = (room.store.start(routine.id) as GymResult.Ok).value
            room.store.choose("bench-press"); room.store.logSet(100.0, 5); room.store.logSet(102.5, 3)
            clockMs += 60_000; room.store.finish()
            val live = room.workout(140.0, "back-squat", finish = false)
            room.add(engine)
            val detail = room.gym.session(first.id)!!
            assertEquals(first.startedAtMs, detail.session.startedAtMs)
            assertEquals(routine.id, detail.session.routineId)
            assertEquals(PlanSnapshot(routine), detail.session.plan)
            assertEquals(listOf(100.0, 102.5), detail.sets.map { it.weightKg })
            assertFalse(detail.session.isOpen)
            assertEquals(live.id, room.store.session!!.id)
            assertEquals(listOf(140.0), room.store.sets.map { it.weightKg })
            assertEquals(setOf(first.id, live.id), room.store.recent.map { it.id }.toSet())
        }
    }

    @Test fun offlineAddKeepsTheWholeWorkoutDurableUntilConnectivityReturns() = runTest {
        val first = engine(); val room = room(first); room.store.connect(account())
        val session = room.workout(); room.add(first)
        val snapshot = first.snapshot(); first.close()
        engine(snapshot).use { reopened ->
            val restored = room(reopened); restored.store.connect(account("A"))
            assertEquals(listOf(82.5), restored.gym.session(session.id)!!.sets.map { it.weightKg })
            assertFalse(restored.gym.session(session.id)!!.session.isOpen)
            assertTrue(outbox(reopened).isNotEmpty())
        }
    }

    @Test fun anUnfixedStrictRefusalCanRetryRepeatedlyWithoutAlteringItsSource() = runTest {
        engine().use { engine ->
            val source = finished(clockMs + 1_000, clockMs + 5_000)
            val imports = WorkoutImports(engine)
            imports.prepare(source)
            repeat(3) { imports.retry(source.session.id) }
            assertEquals(source.session, imports.refusals().single().session)
            assertEquals(source.sets, imports.refusals().single().sets)
            assertTrue(outbox(engine).isEmpty())
        }
    }

    @Test fun finishingDuringAnAttemptNeverAdoptsTheEarlierWorkout() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account())
            val first = room.workout()
            val second = room.workout(199.0, "back-squat", finish = false)
            room.add(engine); engine.releaseHeld(true); engine.nextPush()
            assertTrue(room.store.finish() is FinishOutcome.Closed)
            assertFalse(room.gym.session(first.id)!!.session.isOpen)
            assertFalse(room.gym.session(second.id)!!.session.isOpen)
            assertEquals(listOf(82.5), room.gym.session(first.id)!!.sets.map { it.weightKg })
            assertEquals(listOf(199.0), room.gym.session(second.id)!!.sets.map { it.weightKg })
            assertNull(room.store.session)
        }
    }

    @Test fun repeatedConnectNeverDuplicatesAnAddedWorkout() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account()); val session = room.workout(); room.add(engine)
            val before = outbox(engine).size
            repeat(3) { room.store.connect(account("A")) }
            assertEquals(before, outbox(engine).size)
            assertEquals(listOf(session.id), room.store.recent.map { it.id })
            assertEquals(1, room.gym.session(session.id)!!.sets.size)
        }
    }

    @Test fun importRefusalSurvivesRelaunchWithoutAFormerClaimScreen() = runTest {
        val first = engine(); WorkoutImports(first).prepare(finished(clockMs + 1_000, clockMs + 5_000))
        val original = WorkoutImports(first).refusals().single()
        val snapshot = first.snapshot(); first.close()
        engine(snapshot).use { restored ->
            val room = room(restored); room.store.connect(account())
            assertEquals(original, WorkoutImports(restored).refusals().single())
            assertEquals(listOf(original.session!!.id), room.store.recent.map { it.id })
        }
    }

    // Two hundred and one engine commits make this the slowest store test; it keeps a generous clock.
    @Test fun tooManyImportedSetsRefuseTheWholeWorkoutWithoutDroppingAnyRows() = runTest(timeout = 5.minutes) {
        engine().use { engine ->
            val gym = EngineTraining(engine)
            gym.startSession(SessionStart("session1", clockMs - 300_000))
            repeat(201) { gym.appendSet("session1", SetWrite("set${it.toString().padStart(5, '0')}", "bench-press", 82.5, 5, SetKind.Working, clockMs - 299_000 + it)) }
            gym.finishSession("session1", clockMs - 1_000)
            val row = gym.session("session1")!!
            gym.prepareAdoption()
            assertEquals(row.sets, WorkoutImports(engine).refusals().single().sets)
            engine.read(ScopeRef(Gym.scope)) { reader ->
                assertNull(reader.drawn(Gym.Types.session, RecordID(row.session.id)))
                assertNull(reader.confirmed(Gym.Types.session, RecordID(row.session.id)))
                assertTrue(reader.drawn(Gym.Types.set).isEmpty())
                assertTrue(reader.stored(Gym.Types.set).isEmpty())
            }
            assertEquals(SessionDetail(row.session, row.sets), EngineTraining(engine).session(row.session.id))
            assertTrue(outbox(engine).isEmpty())
        }
    }

    @Test fun startingAfterHistoryWasAddedKeepsTheNewWorkoutSeparate() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account()); val first = room.workout(); room.add(engine)
            val second = room.workout(199.0, "back-squat", finish = false)
            assertEquals(second.id, room.store.session!!.id)
            assertEquals(listOf(82.5), room.gym.session(first.id)!!.sets.map { it.weightKg })
            assertEquals(listOf(199.0), room.gym.session(second.id)!!.sets.map { it.weightKg })
        }
    }

    @Test fun keptUnansweredWorkCannotAppearInAnotherAccount() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account()); val session = room.workout(finish = false); room.add(engine)
            engine.releaseHeld(true); engine.nextPush(); room.store.prepareEngineTransition(); engine.signOut("keep")
            room.store.connect(account()); engine.signIn("B", mapOf("gym" to false)); room.store.connect(account("B"))
            assertNull(room.store.session); assertTrue(room.store.recent.isEmpty())
            assertNull(room.gym.session(session.id)); assertTrue(engine.dormantReplicas().single { it.account == "A" }.sent > 0)
        }
    }

    @Test fun accountHistoryRefillsLastTimeForTheMovementInHand() = runTest {
        engine().use { engine ->
            val room = room(engine); engine.signIn("A", mapOf("gym" to false)); room.store.connect(account("A"))
            room.workout(); room.store.prepareEngineTransition(); engine.signOut("keep"); room.store.connect(account())
            val current = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press"); assertTrue(room.store.lastTime!!.isFirstTime)
            room.add(engine)
            assertEquals(current.id, room.store.session!!.id)
            assertEquals("bench-press", room.store.exerciseId)
            assertFalse(room.store.lastTime!!.isFirstTime)
            assertEquals(listOf(82.5), room.store.lastTime!!.sets.map { it.weightKg })
            assertEquals(Prefill(82.5, 5), room.store.prefill)
        }
    }

    @Test fun signedOutCorrectionAndDeletionSurviveAddWithTheirOriginalIds() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account()); val session = room.workout(finish = false)
            room.store.logSet(60.0, 12); clockMs += 60_000; room.store.finish()
            val sets = room.gym.session(session.id)!!.sets
            room.store.fixSet(session.id, sets.first().id, SetFix(weightKg = 90.0, reps = 3))
            room.store.deleteSet(session.id, sets.last().id); room.add(engine)
            val left = room.gym.session(session.id)!!.sets.single()
            assertEquals(sets.first().id, left.id); assertEquals(90.0, left.weightKg, 0.0); assertEquals(3, left.reps)
            assertEquals("dead", engine.read(ScopeRef(Gym.scope)) { it.drawn(Gym.Types.set, RecordID(sets.last().id)) }!!.life!!.state)
        }
    }

    @Test fun correctionDuringAnUnansweredAttemptRemainsDurable() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account()); val session = room.workout(); room.add(engine)
            engine.releaseHeld(true); engine.nextPush()
            val set = room.gym.session(session.id)!!.sets.single()
            val answer = room.store.fixSet(session.id, set.id, SetFix(weightKg = 90.0, reps = 3))
            assertTrue(answer is FixOutcome.Corrected)
            assertEquals(90.0, room.gym.session(session.id)!!.sets.single().weightKg, 0.0)
            assertTrue(outbox(engine).any { it.member("state") == Json.of("sent") })
            assertTrue(outbox(engine).any { it.member("state") != Json.of("sent") })
        }
    }

    @Test fun signedOutRoomSettingsSurviveRelaunchAndAdd() = runTest {
        val first = engine(); val room = room(first); room.store.connect(account())
        assertNull(room.store.savePreferences(GymPreferences(Units.Pounds, confirmSound = true)))
        val snapshot = first.snapshot(); first.close()
        engine(snapshot).use { engine ->
            val restored = room(engine); restored.store.connect(account()); restored.add(engine)
            assertEquals(Units.Pounds, restored.store.preferences.units); assertTrue(restored.store.preferences.confirmSound)
        }
    }

    @Test fun failedSettingStorageNeverReplaysOrReplacesTheWorkout() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account()); val session = room.workout(finish = false); room.add(engine)
            val before = room.gym.session(session.id)
            engine.failNextCommit()
            assertNotNull(room.store.savePreferences(GymPreferences(confirmSound = true)))
            assertEquals(before, room.gym.session(session.id)); assertFalse(room.gym.settings().confirmSound)
            assertNull(room.store.savePreferences(GymPreferences(confirmSound = true)))
            assertEquals(before, room.gym.session(session.id)); assertTrue(room.gym.settings().confirmSound)
        }
    }

    @Test fun pickerMetaIsSparseAndUsesTheLaterHistoryAfterAdd() = runTest {
        engine().use { engine ->
            val room = room(engine); engine.signIn("A", mapOf("gym" to false)); room.store.connect(account("A"))
            room.workout(90.0, "back-squat"); room.workout(80.0)
            room.store.prepareEngineTransition(); engine.signOut("keep"); room.store.connect(account())
            val newest = room.workout(102.5, "back-squat"); room.store.loadLastSets()
            assertEquals(setOf("back-squat"), room.store.lastSets!!.keys)
            room.add(engine); room.store.loadLastSets()
            assertEquals(setOf("back-squat", "bench-press"), room.store.lastSets!!.keys)
            assertEquals(LastSet("back-squat", 102.5, 5, newest.startedAtMs), room.store.lastSets!!["back-squat"])
            assertEquals(80.0, room.store.lastSets!!["bench-press"]!!.weightKg, 0.0)
            assertNull(room.store.lastSets!!["chin-up"])
        }
    }

    @Test fun unavailableNetworkDoesNotAssertNeverLoggedOverKnownReplicaHistory() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account()); room.workout(80.0); room.add(engine)
            room.store.loadLastSets()
            assertEquals(80.0, room.store.lastSets!!.getValue("bench-press").weightKg, 0.0)
            room.store.refreshEngine()
            assertEquals(80.0, room.store.lastSets!!.getValue("bench-press").weightKg, 0.0)
        }
    }

    @Test fun signingInUnderAnOpenPickerRefillsMetaWithoutLeavingTheScreen() = runTest {
        engine().use { engine ->
            val room = room(engine); engine.signIn("A", mapOf("gym" to false)); room.store.connect(account("A")); room.workout(100.0)
            room.store.prepareEngineTransition(); engine.signOut("keep"); room.store.connect(account()); room.workout(140.0, "back-squat")
            room.store.loadLastSets(); assertEquals(setOf("back-squat"), room.store.lastSets!!.keys)
            room.add(engine)
            assertEquals(setOf("back-squat", "bench-press"), room.store.lastSets!!.keys)
        }
    }

    @Test fun anAccountAliasPromiseNeverChangesTheMovementIdentity() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account())
            val made = (room.store.create("Hammer row", "machine", "exercise1") as GymResult.Ok).value
            assertFalse(room.store.renameKeepsAnAlias(made.id)); room.add(engine)
            assertTrue(room.store.renameKeepsAnAlias(made.id))
            val renamed = (room.store.rename(made.id, "Hammer pull") as GymResult.Ok).value
            assertEquals(made.id, renamed.id); assertEquals("Hammer pull", renamed.name)
        }
    }

    @Test fun aRecordReadUsesTheWholeLocalWorkoutDuringAnUnansweredAttempt() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account()); val session = room.workout(); room.add(engine)
            engine.releaseHeld(true); engine.nextPush()
            val record = (room.store.record("bench-press") as GymResult.Ok).value
            assertEquals(session.id, record.recentDays.single().sessionId)
            assertEquals(82.5, record.bestE1rm!!.weightKg, 0.0)
        }
    }

    @Test fun accountWithTrainingRequiresAnExplicitPinnedAddOrDiscardDecision() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account()); val session = room.workout()
            room.store.prepareEngineTransition()
            val pending = engine.signIn("A", mapOf("gym" to true))
            assertFalse(pending.member("complete").bool())
            val question = pending.member("due").arr().single()
            assertEquals(Json.of(1), question.member("count").member("session"))
            assertEquals(Json.of(1), question.member("count").member("set"))
            assertEquals(session.id, room.gym.sessions(50, null, null).single().id)
            room.add(engine); assertEquals(session.id, room.store.recent.single().id)
        }
    }

    @Test fun anUnresolvedDecisionNeverReassignsAnonymousWorkToTheRememberedAccount() = runTest {
        engine().use { engine ->
            val room = room(engine); room.store.connect(account()); val session = room.workout()
            room.store.prepareEngineTransition(); engine.signIn("A", mapOf("gym" to true))
            val snapshot = engine.snapshot()
            val active = snapshot.member("replicas").arr().single { it.member("meta").member("replica") == snapshot.member("active") }
            assertEquals(Json.of("anon"), active.member("meta").member("state"))
            assertNull(active.member("meta")["account"])
            assertEquals(session.id, room.gym.sessions(50, null, null).single().id)
        }
    }

}
