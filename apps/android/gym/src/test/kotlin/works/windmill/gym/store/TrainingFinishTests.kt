package works.windmill.gym.store

import works.windmill.gym.coach.AskThread
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.*
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.GymRest
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TrainingFinishTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun finishBeforeFirstPullPreservesTheAdoptedSet() = runTest { verifyAdoptedFinish(false) }
    @Test fun finishAfterFirstPullBeforeStartReceiptPreservesTheAdoptedSet() = runTest { verifyAdoptedFinish(true) }

    private suspend fun TestScope.verifyAdoptedFinish(pullFirst: Boolean) {
        val directory = tmp.newFolder()
        val server = EngineRoomFixture.server()
        lateinit var sessionId: String
        lateinit var accepted: TrainingSet
        var at = 0L
        val snapshot = EngineRoomFixture(directory, backgroundScope).use { room ->
            room.select(null)
            sessionId = room.startExternalWorkout().id
            room.store.choose("bench-press")
            room.store.logSet(80.0, 5)
            val performed = room.store.sets.single()
            accepted = room.training.fixSet(sessionId, performed.id, SetFix(note = "Keep this set", rpe = 7.5, rpeNamed = true))
            room.store.prepareEngineTransition()
            room.training.prepareAdoption()
            assertTrue(room.engine.signIn("alice", mapOf("gym" to false)).member("complete").bool())
            room.selected = "alice"
            room.store.connect(room.account())
            assertEquals(listOf(accepted.id), room.training.imports.operations().map { it.entry.set.id })
            if (pullFirst) room.pull(server)
            room.now += 60_000
            assertEquals(FinishOutcome.Failed(WriteFailure.NoAnswer), room.store.finish())
            assertEquals(sessionId, WorkoutControls(room.controlsFile, "alice").session!!.id)
            assertEquals(listOf(accepted), WorkoutControls(room.controlsFile, "alice").sets(sessionId))
            assertTrue(room.outbox().none { it["intent"]?.get("cmd")?.get("name") == works.windmill.sync.core.Json.of("gym.finish") })
            room.sync(server)
            val closed = room.store.finish() as FinishOutcome.Closed
            assertEquals(listOf(accepted), closed.detail.sets)
            room.sync(server)
            room.store.refreshEngine()
            runCurrent()
            assertEquals(emptyList<ImportRefusal>(), room.training.imports.refusals())
            at = room.now
            room.engine.snapshot()
        }
        EngineRoomFixture(directory, backgroundScope, snapshot).use { cold ->
            cold.selected = "alice"
            cold.now = at + 1000
            cold.store.restoreWorkout("alice", true)
            cold.store.connect(cold.account())
            if (cold.training.imports.refusals().any { it.id == accepted.id }) {
                cold.training.imports.retry(accepted.id)
                cold.training.reconcileImports()
                cold.sync(server)
                cold.store.refreshEngine()
            }
            assertEquals("A successfully finished workout must retain its accepted adopted set",
                listOf(accepted.copy(setNumber = 1)), cold.training.session(sessionId)!!.sets)
        }
    }

    @Test fun aFailedAdoptedSetCommitKeepsFinishRetryableAcrossRestartAndAccountChanges() = runTest {
        val directory = tmp.newFolder()
        val server = EngineRoomFixture.server()
        lateinit var accepted: TrainingSet
        lateinit var sessionId: String
        var at = 0L
        val snapshot = EngineRoomFixture(directory, backgroundScope).use { room ->
            room.select(null)
            sessionId = room.startExternalWorkout().id
            room.store.choose("bench-press")
            room.store.logSet(80.0, 5)
            accepted = room.store.sets.single()
            room.store.prepareEngineTransition()
            room.training.prepareAdoption()
            room.engine.signIn("alice", mapOf("gym" to false))
            room.selected = "alice"
            room.store.connect(room.account())
            room.now += 60_000
            repeat(2) {
                assertEquals(FinishOutcome.Failed(WriteFailure.NoAnswer), room.store.finish())
                assertEquals(listOf(accepted), WorkoutControls(room.controlsFile, "alice").sets(sessionId))
            }
            room.sync(server)
            room.engine.failNextCommit()
            assertTrue(runCatching { room.training.finishSession(sessionId, room.now) }.exceptionOrNull() is works.windmill.sync.api.CommitFailure)
            assertTrue(room.training.session(sessionId)!!.session.isOpen)
            assertEquals(listOf(accepted), WorkoutControls(room.controlsFile, "alice").sets(sessionId))
            assertTrue(room.outbox().none { it["intent"]?.get("cmd")?.get("name") == works.windmill.sync.core.Json.of("gym.finish") })
            at = room.now
            room.engine.snapshot()
        }
        EngineRoomFixture(directory, backgroundScope, snapshot).use { cold ->
            cold.selected = "alice"
            cold.now = at + 1000
            cold.store.restoreWorkout("alice", true)
            cold.store.connect(cold.account())
            assertNull(cold.store.workoutFailure)
            assertEquals(sessionId, cold.store.session?.id)
            cold.select("bob")
            assertEquals(emptyList<SessionDetail>(), cold.training.details())
            cold.select("alice")
            cold.pull(server)
            cold.store.refreshEngine()
            assertNull(cold.store.workoutFailure)
            assertEquals(sessionId, cold.store.session?.id)
            val outcome = cold.store.finish()
            assertTrue(outcome.toString(), outcome is FinishOutcome.Closed)
            val closed = outcome as FinishOutcome.Closed
            assertEquals(listOf(accepted), closed.detail.sets)
            cold.sync(server)
            assertEquals(listOf(accepted.copy(setNumber = 1)), cold.training.session(sessionId)!!.sets)
            assertEquals(emptyList<ImportRefusal>(), cold.training.imports.refusals())
        }
    }

    @Test fun finishRecoversAnAcceptedSetAfterATransientEngineCommitFailure() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.editRack(82.5, 5)
            val offer = room.store.notification.value!!.offer!!
            room.engine.failNextCommit()
            assertTrue(room.store.acceptSet(LogSetCommand(offer.key, offer.id)) is LogSetAcceptance.Unavailable)
            val accepted = WorkoutControls(room.controlsFile).sets(live.id).single()
            assertEquals(offer.id, accepted.id)
            assertEquals(emptyList<TrainingSet>(), room.training.session(live.id)!!.sets)

            room.now += 60_000
            val closed = room.store.finish() as FinishOutcome.Closed
            runCurrent()
            assertEquals("the receipt must come from the committed replica", room.training.session(live.id), closed.detail)
            assertEquals("the durable accepted set must survive", listOf(accepted), closed.detail.sets)
            assertNull(WorkoutControls(room.controlsFile).session)
            assertEquals(emptyList<TrainingSet>(), WorkoutControls(room.controlsFile).sets(live.id))
        }
    }

    @Test fun finishKeepsTheDurableAcceptedSetWhenEngineFailurePersistsUntilRetry() = runTest {
        val events = mutableListOf<String>()
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select(null)
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Workout").adding("bench-press")) as GymResult.Ok).value
            events.clear()
            val live = (room.store.start(routine.id) as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.editRack(82.5, 5)
            val offer = room.store.notification.value!!.offer!!
            room.engine.failNextCommit()
            assertTrue(room.store.acceptSet(LogSetCommand(offer.key, offer.id)) is LogSetAcceptance.Unavailable)
            val accepted = WorkoutControls(room.controlsFile).sets(live.id).single()
            room.now += 60_000

            repeat(2) {
                room.engine.failNextCommit()
                assertEquals(FinishOutcome.Failed(WriteFailure.NoAnswer), room.store.finish())
                runCurrent()
                assertEquals(SessionDetail(live, emptyList()), room.training.session(live.id))
                val durable = WorkoutControls(room.controlsFile)
                assertEquals(live, durable.session)
                assertEquals(listOf(accepted), durable.sets(live.id))
                assertEquals(setOf(accepted.id), durable.workout.consumed)
                assertEquals(live, room.store.session)
                assertFalse(room.store.isFinishing)
            }
            assertEquals(listOf("gym.acceptSet", "gym.finish", "gym.finish"), failures)
            assertEquals(listOf("gym_session_started"), events)

            val closed = room.store.finish() as FinishOutcome.Closed
            runCurrent()
            assertEquals(listOf(accepted), closed.detail.sets)
            assertEquals(room.training.session(live.id), closed.detail)
            assertEquals(emptyList<TrainingSet>(), WorkoutControls(room.controlsFile).sets(live.id))
            assertEquals(listOf("gym_session_started", "gym_session_finished"), events)
        }
    }

    @Test fun restartBeforeFinishRecoversTheAcceptedSetFromDisk() = runTest {
        for (owner in listOf(null, "alice")) {
            val directory = tmp.newFolder()
            val (snapshot, accepted, at) = EngineRoomFixture(directory, backgroundScope).use { room ->
                room.select(owner)
                val live = room.startExternalWorkout()
                room.store.choose("bench-press")
                room.store.editRack(82.5, 5)
                val offer = room.store.notification.value!!.offer!!
                room.engine.failNextCommit()
                assertTrue(room.store.acceptSet(LogSetCommand(offer.key, offer.id)) is LogSetAcceptance.Unavailable)
                assertEquals(emptyList<TrainingSet>(), room.training.session(live.id)!!.sets)
                Triple(room.engine.snapshot(), WorkoutControls(room.controlsFile, owner).sets(live.id).single(), room.now)
            }
            EngineRoomFixture(directory, backgroundScope, snapshot).use { cold ->
                cold.now = at + 60_000
                cold.selected = owner
                cold.store.restoreWorkout(owner, authorized = true)
                cold.store.connect(cold.account())
                assertEquals(listOf(accepted), cold.store.sets)
                val closed = cold.store.finish() as FinishOutcome.Closed
                runCurrent()
                assertEquals(listOf(accepted), closed.detail.sets)
                assertEquals(closed.detail, cold.training.session(closed.session.id))
                val durable = WorkoutControls(cold.controlsFile, owner)
                assertNull(durable.session)
                assertEquals(emptyList<TrainingSet>(), durable.sets(closed.session.id))
            }
        }
    }

    @Test fun finishReadsEngineCorrectionsAndDeletionsWithoutRevivingStaleControls() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            room.store.logSet(62.5, 6)
            val (kept, deleted) = room.store.sets
            val corrected = room.training.fixSet(live.id, kept.id, SetFix(reps = 9))
            room.training.deleteSet(live.id, deleted.id)
            val added = room.training.appendSet(live.id,
                SetWrite("engineSet", "back-squat", 100.0, 5, ++room.now))
            assertEquals(listOf(kept, deleted), room.store.sets)

            room.now += 60_000
            val closed = room.store.finish() as FinishOutcome.Closed
            runCurrent()
            assertEquals(listOf(corrected, added), closed.detail.sets)
            assertEquals(room.training.session(live.id), closed.detail)
        }
    }

    @Test fun refreshAndAccountChangeRecoverAnAcceptedSetAfterEngineFailure() = runTest {
        for (changeAccount in listOf(false, true)) EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            val offer = room.store.notification.value!!.offer!!
            room.engine.failNextCommit()
            assertTrue(room.store.acceptSet(LogSetCommand(offer.key, offer.id)) is LogSetAcceptance.Unavailable)
            val accepted = WorkoutControls(room.controlsFile).sets(live.id).single()

            if (changeAccount) room.select("alice") else room.store.refreshEngine()
            assertEquals(listOf(accepted), WorkoutControls(room.controlsFile, room.selected).sets(live.id))
            assertEquals(listOf(accepted), room.store.sets)
            assertEquals(listOf(accepted), room.training.session(live.id)!!.sets)
            room.now += 60_000
            val closed = room.store.finish() as FinishOutcome.Closed
            assertEquals(listOf(accepted), closed.detail.sets)
            assertEquals(room.training.session(live.id), closed.detail)
        }
    }

    @Test fun startingAfterAutoCloseRecoversThePreviousWorkoutsAcceptedSet() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Workout").adding("bench-press")) as GymResult.Ok).value
            val live = (room.store.start(routine.id) as GymResult.Ok).value
            room.store.choose("bench-press")
            val offer = room.store.notification.value!!.offer!!
            room.engine.failNextCommit()
            assertTrue(room.store.acceptSet(LogSetCommand(offer.key, offer.id)) is LogSetAcceptance.Unavailable)
            val accepted = WorkoutControls(room.controlsFile).sets(live.id).single()
            room.now += AutoClose.AFTER_MS + 60_000

            val next = (room.store.start(routine.id) as GymResult.Ok).value
            assertNotEquals(live.id, next.id)
            assertEquals(SessionDetail(live.copy(finishedAtMs = accepted.completedAtMs), listOf(accepted)), room.training.session(live.id))
            assertEquals(next, room.store.session)
            assertEquals(emptyList<TrainingSet>(), room.store.sets)
        }
    }

    @Test fun autoCloseKeepsTheAcceptedSetUntilRecoverySucceeds() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            val offer = room.store.notification.value!!.offer!!
            room.engine.failNextCommit()
            assertTrue(room.store.acceptSet(LogSetCommand(offer.key, offer.id)) is LogSetAcceptance.Unavailable)
            val accepted = WorkoutControls(room.controlsFile).sets(live.id).single()

            room.now += AutoClose.AFTER_MS + 60_000
            room.engine.failNextCommit()
            room.store.reconcileWorkoutTime()
            assertEquals(live, room.store.session)
            assertEquals(listOf(accepted), WorkoutControls(room.controlsFile).sets(live.id))
            assertEquals(emptyList<TrainingSet>(), room.training.session(live.id)!!.sets)
            room.store.reconcileWorkoutTime()
            assertEquals(SessionDetail(live.copy(finishedAtMs = accepted.completedAtMs), listOf(accepted)), room.training.session(live.id))
            assertNull(room.store.session)
            assertEquals(emptyList<TrainingSet>(), WorkoutControls(room.controlsFile).sets(live.id))
        }
    }

    @Test fun aRefusedRecoveryKeepsTheAcceptedSetEvenIfItsWorkoutIsGone() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            val offer = room.store.notification.value!!.offer!!
            room.engine.failNextCommit()
            assertTrue(room.store.acceptSet(LogSetCommand(offer.key, offer.id)) is LogSetAcceptance.Unavailable)
            val accepted = WorkoutControls(room.controlsFile).sets(live.id).single()
            room.now += AutoClose.AFTER_MS + 60_000
            room.training.discardSession(live.id)

            assertEquals(FinishOutcome.Failed(WriteFailure.Refused("That is no longer on the log.")), room.store.finish())
            assertNull(room.training.session(live.id))
            assertEquals(listOf(accepted), WorkoutControls(room.controlsFile).sets(live.id))
            assertEquals(live, room.store.session)
        }
    }

    @Test fun finishCarriesItsRowsAndKeepsTheHeldDeletionDeadline() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            val local = room.store.sets.single()
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val hold = room.store.withheld.single()
            val closed = room.store.finish() as FinishOutcome.Closed
            assertEquals(room.training.session(live.id), closed.detail)
            assertEquals(listOf(local), closed.detail.sets)
            assertEquals(listOf(hold), room.store.withheld)
            assertEquals(room.store.withheld.single(), room.store.keepWithheld())
            assertEquals(closed.detail, room.store.retainedSession(closed.detail))
            assertEquals("nothing was deleted", listOf(local), room.training.session(live.id)!!.sets)
            assertNull(room.store.session)
        }
    }

    @Test fun aFinishedWorkoutsQueuedRefreshCannotReadOrReplaceTheNextAccount() = runTest {
        val server = EngineRoomFixture.server()
        val secondHistory = EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("b")
            other.training.startSession(SessionStart("remote01", other.now - 10_000))
            other.training.appendSet("remote01", SetWrite("remoteset", "back-squat", 80.0, 5, other.now - 9_000))
            other.training.finishSession("remote01", other.now - 5_000)
            other.sync(server)
            other.training.sessions(TrainingStore.logPage, null, null)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Workout").adding("bench-press")) as GymResult.Ok).value
            assertTrue(room.store.start(routine.id) is GymResult.Ok)
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            val performed = room.store.sets.single()
            room.now += 60_000
            val receipt = room.store.finish() as FinishOutcome.Closed
            assertEquals(listOf(performed), receipt.detail.sets)
            assertEquals(receipt.detail, room.store.retainedSession(receipt.detail))
            assertNull(room.store.session)
            assertFalse(room.store.isFinishing)
            assertEquals("the finish's refresh is still queued", emptyList<SessionSummary>(), room.store.logged)
            room.select("b"); room.pull(server); room.store.refreshEngine()
            assertEquals(secondHistory, room.store.allSessions)
            runCurrent()
            assertEquals(secondHistory, room.store.allSessions)
            assertEquals(listOf("remote01"), room.training.details().map { it.session.id })
            assertNull(room.store.session)
            assertEquals(emptyList<TrainingSet>(), room.store.sets)
            room.select("a")
            assertEquals(listOf(receipt.detail), room.training.details())
        }
    }

    @Test fun aQueuedFinishRefreshCannotCloseTheNextWorkoutOrReplaceItsOffer() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Workout").adding("bench-press")) as GymResult.Ok).value
            assertTrue(room.store.start(routine.id) is GymResult.Ok)
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            room.now += 60_000
            val receipt = room.store.finish() as FinishOutcome.Closed
            assertTrue(room.store.start(routine.id) is GymResult.Ok)
            room.store.choose("back-squat")
            room.store.logSet(100.0, 5)
            val live = room.store.session!!
            val rows = room.store.sets.toList()
            val notification = room.store.notification.value!!
            val queueFile = File(room.directory, "control.json")
            val queue = queueFile.readText()
            assertEquals("the finish's refresh is still queued", emptyList<SessionSummary>(), room.store.logged)
            runCurrent()

            assertEquals("session02", live.id)
            assertEquals(live, room.store.session)
            assertEquals(rows, room.store.sets)
            assertEquals(notification, room.store.notification.value)
            assertEquals(queue, queueFile.readText())
            assertEquals(receipt.detail, room.store.retainedSession(receipt.detail))
            assertEquals(mapOf(receipt.detail.session.id to receipt.detail.session, live.id to live),
                room.training.details().associate { it.session.id to it.session })
            assertTrue(room.training.session(live.id)!!.session.isOpen)
        }
    }

    @Test fun aNewerHistoryReadWinsOverTheQueuedPostFinishRefresh() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
                room.select("a")
                other.now = room.now + 600_000
                other.select("a")
                val routine = (room.store.saveRoutine(RoutineDraft(name = "Workout").adding("bench-press")) as GymResult.Ok).value
                assertTrue(room.store.start(routine.id) is GymResult.Ok)
                room.store.choose("bench-press")
                room.store.logSet(60.0, 8)
                room.now += 60_000
                val receipt = room.store.finish() as FinishOutcome.Closed
                other.training.startSession(SessionStart("remote01", other.now - 10_000))
                other.training.appendSet("remote01", SetWrite("remoteset", "back-squat", 100.0, 5, other.now - 9_000))
                other.training.finishSession("remote01", other.now - 5_000)
                other.sync(server)
                room.sync(server)
                assertEquals("the finish's refresh is still queued", emptyList<SessionSummary>(), room.store.logged)
                room.store.refreshEngine()
                val expected = room.training.sessions(TrainingStore.logPage, null, null)
                assertEquals(listOf("remote01", receipt.detail.session.id), expected.map { it.id })
                assertEquals(expected, room.store.allSessions)
                runCurrent()
                assertEquals(expected, room.store.allSessions)
                assertEquals(Older.End, room.store.older)
                assertEquals(room.training.session(receipt.detail.session.id), room.store.retainedSession(receipt.detail))
                assertEquals(receipt.detail.sets.map { it.id }, room.store.retainedSession(receipt.detail).sets.map { it.id })
                assertNull(room.store.session)
            }
        }
    }

    @Test fun aQueuedPostFinishRefreshCannotReplaceAWorkoutAdoptedByANewerRead() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
                room.select("a")
                other.now = room.now + 600_000
                other.select("a")
                val routine = (room.store.saveRoutine(RoutineDraft(name = "Workout").adding("bench-press")) as GymResult.Ok).value
                assertTrue(room.store.start(routine.id) is GymResult.Ok)
                room.store.choose("bench-press")
                room.store.logSet(60.0, 8)
                room.now += 60_000
                room.store.finish()
                other.training.startSession(SessionStart("remote01", other.now - 10_000))
                other.training.appendSet("remote01", SetWrite("remoteset", "bench-press", 80.0, 5, other.now - 9_000))
                other.training.finishSession("remote01", other.now - 8_000)
                other.training.startSession(SessionStart("remote02", other.now - 5_000))
                other.training.appendSet("remote02", SetWrite("remotenext", "back-squat", 100.0, 5, other.now - 4_000))
                other.sync(server)
                room.sync(server)
                assertEquals("the finish's refresh is still queued", emptyList<SessionSummary>(), room.store.logged)
                room.store.refreshEngine()
                val next = room.training.session("remote02")!!
                assertEquals(next.session, room.store.session)
                assertEquals(next.sets, room.store.sets)
                val notification = room.store.notification.value!!
                val history = room.store.allSessions.toList()
                val queueFile = File(room.directory, "control.json")
                val queue = queueFile.readText()
                runCurrent()

                assertEquals(next.session, room.store.session)
                assertEquals(next.sets, room.store.sets)
                assertEquals(notification, room.store.notification.value)
                assertEquals(history, room.store.allSessions)
                assertEquals(queue, queueFile.readText())
                assertEquals(next, room.training.session("remote02"))
                assertTrue(next.session.isOpen)
            }
        }
    }

    @Test fun aCorrectionNotYetOnTheLogStaysOwedAndLandsOnTheNextSync() = runTest {
        val server = EngineRoomFixture.server()
        val (sessionId, corrected) = EngineRoomFixture(tmp.newFolder(), backgroundScope, undoWindowMs = 0).use { room ->
            room.select("a")
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            val logged = room.store.sets.single()
            val fix = SetFix(reps = 9, note = "kept input")
            assertEquals(FixOutcome.Corrected(fix.corrected(logged)), room.store.fixSet(live.id, logged.id, fix))
            runCurrent()
            assertEquals(listOf(fix.corrected(logged)), room.store.sets)
            assertEquals(listOf(fix.corrected(logged)), room.training.session(live.id)!!.sets)
            assertEquals(setOf(logged.id), room.store.stalled)
            assertEquals(0, room.store.strandedCount)
            room.sync(server); room.store.refreshEngine()
            val numbered = fix.corrected(logged).copy(setNumber = 1)
            assertEquals("the log numbers the set it took", listOf(numbered), room.store.sets)
            assertEquals(0, room.store.strandedCount)
            live.id to numbered
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            assertEquals(listOf(corrected), other.training.session(sessionId)!!.sets)
        }
    }

    // A correction filed on the live session lands before the finish closes it, so the closed
    // workout shows it.
    @Test fun finishCarriesAnOwedCorrectionAndTheClosedWorkoutShowsIt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope, undoWindowMs = 0).use { room ->
            room.select("a")
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            val logged = room.store.sets.single()
            assertEquals(FixOutcome.Corrected(logged.copy(reps = 9)), room.store.fixSet(live.id, logged.id, SetFix(reps = 9)))
            val fixed = logged.copy(reps = 9)
            val closed = room.store.finish() as FinishOutcome.Closed
            assertEquals(listOf(fixed), closed.detail.sets)
            assertEquals(listOf(fixed), room.training.session(live.id)!!.sets)
            assertEquals(listOf(fixed), (room.store.sessionDetail(live.id) as GymResult.Ok).value.sets)
        }
    }

    @Test fun finishCarriesAnOwedDeleteAndTheClosedWorkoutLacksTheRow() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope, undoWindowMs = 0).use { room ->
            room.select("a")
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            room.store.logSet(62.5, 6)
            val (kept, deleted) = room.store.sets
            assertNull(room.store.deleteSet(live.id, deleted.id))
            val closed = room.store.finish() as FinishOutcome.Closed
            assertEquals(listOf(kept), closed.detail.sets)
            assertEquals(listOf(kept), room.training.session(live.id)!!.sets)
            assertEquals(listOf(kept), (room.store.sessionDetail(live.id) as GymResult.Ok).value.sets)
        }
    }

    @Test fun anAccountChangeAfterACorrectionKeepsItWithItsOwnAccount() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope, undoWindowMs = 0).use { room ->
            room.select("a")
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            val logged = room.store.sets.single()
            assertEquals(FixOutcome.Corrected(logged.copy(reps = 9)), room.store.fixSet(live.id, logged.id, SetFix(reps = 9)))
            assertEquals("the correction is in the replica at once", listOf(logged.copy(reps = 9)), room.training.session(live.id)!!.sets)
            room.select("b")
            runCurrent()
            assertEquals(emptyList<TrainingSet>(), room.store.sets)
            assertNull(room.store.session)
            assertEquals(emptyList<SessionDetail>(), room.training.details())
            room.select("a")
            assertEquals(live.id, room.store.session!!.id)
            assertEquals(listOf(logged.copy(reps = 9)), room.store.sets)
            assertEquals(listOf(logged.copy(reps = 9)), room.training.session(live.id)!!.sets)
        }
    }

    @Test fun aReceiptAlreadyShownKeepsItsIdentityAndDeletedSetDuringEngineDelivery() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            room.workout(60.0)
            val live = room.workout(100.0, "back-squat", finish = false)
            val performed = room.store.sets.single()
            room.engine.releaseHeld(true)
            val pending = room.engine.nextPush()!!
            val finish = async { room.store.finish() }
            runCurrent()
            assertTrue("local finish remains independent of the older push", finish.isCompleted)
            val receipt = (finish.await() as FinishOutcome.Closed).detail
            assertEquals(live.id, receipt.session.id)
            assertEquals(listOf(performed), receipt.sets)
            assertNull(room.store.delete(Deletion.Set(live.id, performed)))
            val server = EngineRoomFixture.server()
            val response = server.push(pending, works.windmill.sync.modelserver.Credential.Account("alice"), room.now)
            val reading = works.windmill.sync.core.ClockReading(room.now, room.now, "test")
            room.engine.onPushResponse(pending, works.windmill.sync.engine.SyncResponse(response.status, response.body),
                works.windmill.sync.engine.RequestTiming(reading, reading))
            room.sync(server); room.store.refreshEngine()
            val expected = (room.store.sessionDetail(live.id) as GymResult.Ok).value
            assertEquals(receipt.session.id, expected.session.id)
            assertEquals(emptyList<String>(), expected.sets.map { it.id })
            assertEquals(expected, room.store.retainedSession(receipt))
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertNull(room.store.session)
        }
    }

    @Test fun finishDuringAnEngineIdentityRefusalKeepsTheOriginalReceiptAndExplainsTheFailure() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val live = room.workout(60.0, finish = false)
            val performed = room.store.sets.single()
            val finish = async { room.store.finish() }
            runCurrent()
            assertTrue(finish.isCompleted)
            val receipt = (finish.await() as FinishOutcome.Closed).detail
            assertEquals(live.id, receipt.session.id)
            assertEquals(listOf(performed), receipt.sets)
            val server = EngineRoomFixture.server()
            server.refuse(code = "id-taken")
            room.sync(server)
            withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }
            room.store.refreshEngine()
            assertEquals("a refusal never remints the receipt", receipt, room.store.retainedSession(receipt))
            assertTrue(room.store.refusals.isNotEmpty())
            assertTrue("the engine retains the refused original source", room.engine.notices("gym").notices.value.any {
                it.content.command?.args?.get("id") == works.windmill.sync.core.Json.of(live.id)
            })
            assertNull(room.store.session)
        }
    }
    @Test fun theHeldDeletionFiresAtItsOriginalDeadlineAfterTheFinish() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val live = room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            val set = room.store.sets.single()
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val deadline = room.store.withheld.single().untilMs
            room.now += 1_000
            val receipt = (room.store.finish() as FinishOutcome.Closed).detail
            assertEquals(deadline, room.store.withheld.single().untilMs)
            room.now = deadline - 1
            assertEquals(emptyList<String>(), room.engine.releaseHeld())
            room.now = deadline
            assertEquals(1, room.engine.releaseHeld().size)
            room.store.refreshEngine()
            assertTrue(room.store.withheld.isEmpty())
            assertEquals(listOf(set), room.store.retainedSession(receipt).sets)
            assertEquals(listOf(set), room.training.session(live.id)!!.sets)
            assertEquals(emptyList<Any>(), room.store.bodyweight)
        }
    }

    @Test fun aStaleSeedCannotOverwriteAnAcceptedCorrection() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            room.startExternalWorkout(); room.store.choose("bench-press"); room.store.logSet(60.0, 8)
            room.now += 60_000
            val receipt = (room.store.finish() as FinishOutcome.Closed).detail
            val fixed = room.store.fixSet(receipt.session.id, receipt.sets.single().id, SetFix(weightKg = 62.5, note = "steady"))
            val expected = receipt.copy(sets = listOf((fixed as FixOutcome.Corrected).set))
            assertEquals(GymResult.Ok(expected), room.store.sessionDetail(receipt.session.id, receipt))
            assertEquals(expected, room.store.retainedSession(receipt))
            assertEquals(expected.sets, room.training.session(receipt.session.id)!!.sets)
        }
    }

    @Test fun eachAccountResumesItsOwnCursorWhenTheirMovementOrdersOverlap() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val pushA = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press").adding("overhead-press"))
                as GymResult.Ok).value
            assertTrue(room.store.start(pushA.id) is GymResult.Ok)
            room.store.choose("overhead-press")
            room.select("b")
            val pushB = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press").adding("overhead-press"))
                as GymResult.Ok).value
            assertTrue(room.store.start(pushB.id) is GymResult.Ok)
            room.store.choose("bench-press")
            room.select("a")
            assertEquals("overhead-press", room.store.exerciseId)
            room.select("b")
            assertEquals("bench-press", room.store.exerciseId)
        }
    }

    @Test fun retryingAnExplicitRoutineSaveKeepsOneCreationDocument() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val draft = RoutineDraft(name = "Push A", creationId = "rt_editor").adding("bench-press")
                .targeting("bench-press", listOf(SetTarget(8, 60.0)))
            val first = room.store.saveRoutine(draft.capturingMovements(room.store.catalog))
            val retried = room.store.saveRoutine(draft.capturingMovements(room.store.catalog))
            assertEquals(first, retried)
            assertEquals(listOf("rt_editor"), room.training.program().map { it.id })
            assertEquals(listOf("rt_editor"), room.store.allRoutines.map { it.id })
            assertEquals(listOf(RoutineEntry(exerciseId = "bench-press", position = 1, sets = listOf(SetTarget(8, 60.0)))),
                room.training.program().single().entries)
        }
    }

    @Test fun aRetriedRoutineSaveCannotClaimADifferentNameUnderItsOriginalIdentity() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val draft = RoutineDraft(name = "Push A", creationId = "rt_editor").adding("bench-press")
                .targeting("bench-press", listOf(SetTarget(8, 60.0)))
            val kept = room.store.saveRoutine(draft.capturingMovements(room.store.catalog)) as GymResult.Ok
            val retry = room.store.saveRoutine(draft.named("Push B").capturingMovements(room.store.catalog))
            assertEquals(GymResult.Failed(WriteFailure.Refused(
                "this save already holds different details — reopen the saved routine to edit it")), retry)
            assertEquals(listOf(kept.value), room.training.program())
            assertEquals(listOf(kept.value), room.store.allRoutines)
            assertEquals("Push A", kept.value.name)
        }
    }
    @Test
    fun discardFailureReportsOnceAndRetryRemovesTheCommittedWorkoutWithoutAHold() = runTest {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select(null)
            val workout = room.workout()
            val saved = room.training.session(workout.id)!!
            room.engine.failNextCommit()
            assertEquals(WriteFailure.NoAnswer, room.store.discardWorkout(workout.id, "finish"))
            assertEquals(saved, room.training.session(workout.id))
            assertEquals(listOf("gym.discard"), failures)
            assertEquals(null, room.store.discardWorkout(workout.id, "finish"))
            assertEquals(null, room.training.session(workout.id))
            assertEquals(emptyList<Withheld>(), room.store.withheld)
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "finish", "action" to "discard", "outcome" to "failed"),
                "gym_action" to mapOf("screen" to "finish", "action" to "discard", "outcome" to "ok"),
            ), events.filter { it.first == "gym_action" })
        }
    }

    @Test
    fun anOfflineDiscardIsImmediatelyReleasedAndLaterSyncKeepsTheServerAbsent() = runTest {
        val rest = FakeGymRest().apply { online = false }
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select("u1")
            room.pull(server)
            val workout = room.workout()
            room.sync(server)
            assertTrue(room.training.session(workout.id) != null)
            assertEquals(null, room.store.discardWorkout(workout.id, "finish"))
            assertEquals(null, room.training.session(workout.id))
            assertEquals(emptyList<String>(), rest.calls)
            assertEquals(emptyList<Withheld>(), room.store.withheld)
            assertTrue(room.outbox().isNotEmpty())
            assertTrue(room.outbox().all { it.member("state") == works.windmill.sync.core.Json.of("ready") })
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { beforeDelivery ->
                beforeDelivery.select("u1"); beforeDelivery.pull(server)
                assertTrue(beforeDelivery.training.session(workout.id) != null)
            }
            room.sync(server)
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { observer ->
                observer.select("u1"); observer.pull(server)
                assertEquals(null, observer.training.session(workout.id))
            }
        }
    }

    @Test
    fun deletingBeforeTheFirstPublicationCannotResurrectAfterRestartAndSync() = runTest {
        val server = EngineRoomFixture.server()
        val directory = tmp.newFolder()
        var at = 0L
        lateinit var id: String
        val snapshot = EngineRoomFixture(directory, backgroundScope).use { room ->
            room.select("u1"); room.pull(server)
            id = room.workout().id
            assertEquals(null, room.store.discardWorkout(id, "finish"))
            assertEquals(null, room.training.session(id))
            assertTrue(room.outbox().all { it.member("state") == works.windmill.sync.core.Json.of("ready") })
            at = room.now
            room.engine.snapshot()
        }
        EngineRoomFixture(directory, backgroundScope, snapshot).use { cold ->
            cold.now = at; cold.selected = "u1"; cold.store.connect(cold.account())
            assertEquals(null, cold.training.session(id))
            cold.sync(server)
            assertEquals(null, cold.training.session(id))
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { observer ->
                observer.select("u1"); observer.pull(server)
                assertEquals(null, observer.training.session(id))
            }
        }
    }

    @Test
    fun anAnonymousWorkoutDeletedBeforeSignInIsNotAdoptedOrResurrected() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val id = room.workout().id
            assertEquals(null, room.store.discardWorkout(id, "finish"))
            assertEquals(null, room.training.session(id))
            room.training.prepareAdoption()
            room.select("u1")
            room.sync(server)
            assertEquals(null, room.training.session(id))
            assertEquals(emptyList<ImportRefusal>(), room.training.imports.refusals())
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { observer ->
                observer.select("u1"); observer.pull(server)
                assertEquals(null, observer.training.session(id))
            }
        }
    }

    @Test
    fun failureToDurablyReleaseTheExactDeleteRestoresTheWorkout() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val id = room.workout().id
            val saved = room.training.session(id)
            val failing = EngineTraining(room.engine) { throw IOException("local-release-failed") }
            assertTrue(runCatching { failing.discardSession(id) }.exceptionOrNull() is IOException)
            assertEquals(saved, room.training.session(id))
            assertEquals(emptyList<works.windmill.sync.api.UndoOffer>(), room.engine.undoOffers())
        }
    }

    @Test
    fun acceptedDeleteSurvivesAControlsPublicationFailureWithoutReopeningTheWorkout() = runTest {
        val directory = tmp.newFolder()
        var fail = false
        val failures = mutableListOf<String>()
        val outcomes = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action" && properties["action"] == "discard") outcomes += properties
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        lateinit var id: String
        var at = 0L
        val snapshot = EngineRoomFixture(directory, backgroundScope, telemetry = telemetry,
            controlsWrite = { file, raw -> if (fail) throw IOException("local-controls-publication") else works.windmill.platform.storage.AtomicDocument.write(file, raw) }).use { room ->
            room.select(null)
            id = room.startExternalWorkout().id
            room.store.choose("bench-press"); room.store.logSet(80.0, 5)
            room.training.finishSession(id, room.now + 1_000)
            fail = true
            assertEquals(null, room.store.discardWorkout(id, "finish"))
            assertEquals(null, room.training.session(id))
            assertEquals(null, room.store.session)
            assertEquals(null, room.store.rack)
            assertEquals(null, room.store.notification.value)
            assertEquals(listOf(mapOf("screen" to "finish", "action" to "discard", "outcome" to "ok")), outcomes)
            assertEquals(listOf("gym.discard"), failures)
            room.store.refreshEngine()
            assertEquals(null, room.store.session)
            assertEquals(listOf("gym.discard"), failures)
            at = room.now
            room.engine.snapshot()
        }
        EngineRoomFixture(directory, backgroundScope, snapshot).use { cold ->
            cold.now = at
            cold.select(null)
            assertEquals(null, cold.training.session(id))
            assertEquals(null, cold.store.session)
        }
    }

}
