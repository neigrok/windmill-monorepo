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
import works.windmill.gym.domain.*
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
            sessionId = (room.store.start() as GymResult.Ok).value.id
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
            sessionId = (room.store.start() as GymResult.Ok).value.id
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
            val live = (room.store.start() as GymResult.Ok).value
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
            val live = (room.store.start() as GymResult.Ok).value
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
                val live = (room.store.start() as GymResult.Ok).value
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
            val live = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            room.store.logSet(62.5, 6)
            val (kept, deleted) = room.store.sets
            val corrected = room.training.fixSet(live.id, kept.id, SetFix(reps = 9))
            room.training.deleteSet(live.id, deleted.id)
            val added = room.training.appendSet(live.id,
                SetWrite("engineSet", "back-squat", 100.0, 5, SetKind.Working, ++room.now))
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
            val live = (room.store.start() as GymResult.Ok).value
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
            val live = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            val offer = room.store.notification.value!!.offer!!
            room.engine.failNextCommit()
            assertTrue(room.store.acceptSet(LogSetCommand(offer.key, offer.id)) is LogSetAcceptance.Unavailable)
            val accepted = WorkoutControls(room.controlsFile).sets(live.id).single()
            room.now += AutoClose.AFTER_MS + 60_000

            val next = (room.store.start() as GymResult.Ok).value
            assertNotEquals(live.id, next.id)
            assertEquals(SessionDetail(live.copy(finishedAtMs = accepted.completedAtMs), listOf(accepted)), room.training.session(live.id))
            assertEquals(next, room.store.session)
            assertEquals(emptyList<TrainingSet>(), room.store.sets)
        }
    }

    @Test fun autoCloseKeepsTheAcceptedSetUntilRecoverySucceeds() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val live = (room.store.start() as GymResult.Ok).value
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
            val live = (room.store.start() as GymResult.Ok).value
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
            val live = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            val local = room.store.sets.single()
            room.store.withhold(Deletion.Set(live.id, local))
            val deadline = room.store.withheld.single().untilMs
            val closed = room.store.finish() as FinishOutcome.Closed
            assertEquals(room.training.session(live.id), closed.detail)
            assertEquals(listOf(local), closed.detail.sets)
            assertEquals(listOf(WithheldDelete(Deletion.Set(live.id, local), deadline)), room.store.withheld)
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
            other.training.appendSet("remote01", SetWrite("remoteset", "back-squat", 80.0, 5, SetKind.Working, other.now - 9_000))
            other.training.finishSession("remote01", other.now - 5_000)
            other.sync(server)
            other.training.sessions(TrainingStore.logPage, null, null)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            room.store.start()
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
            room.store.start()
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            room.now += 60_000
            val receipt = room.store.finish() as FinishOutcome.Closed
            room.store.start()
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
                room.store.start()
                room.store.choose("bench-press")
                room.store.logSet(60.0, 8)
                room.now += 60_000
                val receipt = room.store.finish() as FinishOutcome.Closed
                other.training.startSession(SessionStart("remote01", other.now - 10_000))
                other.training.appendSet("remote01", SetWrite("remoteset", "back-squat", 100.0, 5, SetKind.Working, other.now - 9_000))
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
                room.store.start()
                room.store.choose("bench-press")
                room.store.logSet(60.0, 8)
                room.now += 60_000
                room.store.finish()
                other.training.startSession(SessionStart("remote01", other.now - 10_000))
                other.training.appendSet("remote01", SetWrite("remoteset", "bench-press", 80.0, 5, SetKind.Working, other.now - 9_000))
                other.training.finishSession("remote01", other.now - 8_000)
                other.training.startSession(SessionStart("remote02", other.now - 5_000))
                other.training.appendSet("remote02", SetWrite("remotenext", "back-squat", 100.0, 5, SetKind.Working, other.now - 4_000))
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
            val live = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            val logged = room.store.sets.single()
            val fix = SetFix(reps = 9, note = "kept input")
            assertEquals(FixOutcome.Corrected(fix.corrected(logged)), room.store.fixSet(live.id, logged.id, fix))
            runCurrent()
            assertEquals(listOf(fix.corrected(logged)), room.store.sets)
            assertEquals(listOf(fix.corrected(logged)), room.training.session(live.id)!!.sets)
            assertEquals(1, room.store.strandedCount)
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
            val live = (room.store.start() as GymResult.Ok).value
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
            val live = (room.store.start() as GymResult.Ok).value
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
            val live = (room.store.start() as GymResult.Ok).value
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

    @Test fun aReceiptAlreadyShownKeepsItsIdentityAndDeletionDeadlineDuringEngineDelivery() = runTest {
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
            room.store.withhold(Deletion.Set(live.id, performed))
            val deadline = room.store.withheld.single().untilMs
            val server = EngineRoomFixture.server()
            val response = server.push(pending, works.windmill.sync.modelserver.Credential.Account("alice"), room.now)
            val reading = works.windmill.sync.core.ClockReading(room.now, room.now, "test")
            room.engine.onPushResponse(pending, works.windmill.sync.engine.SyncResponse(response.status, response.body),
                works.windmill.sync.engine.RequestTiming(reading, reading))
            room.sync(server); room.store.refreshEngine()
            val expected = (room.store.sessionDetail(live.id) as GymResult.Ok).value
            assertEquals(receipt.session.id, expected.session.id)
            assertEquals(listOf(performed.id), expected.sets.map { it.id })
            assertEquals(expected, room.store.retainedSession(receipt))
            assertEquals(listOf(WithheldDelete(Deletion.Set(live.id, expected.sets.single()), deadline)), room.store.withheld)
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
            val live = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(60.0, 8)
            val set = room.store.sets.single()
            room.store.withhold(Deletion.Set(live.id, set))
            runCurrent()
            val window = room.store.withheld.single().untilMs - room.now
            room.now += 60_000
            val receipt = (room.store.finish() as FinishOutcome.Closed).detail
            advanceTimeBy(window - 1)
            runCurrent()
            assertEquals(listOf(set), room.training.session(live.id)!!.sets)
            advanceTimeBy(1)
            runCurrent()
            assertTrue(room.store.withheld.isEmpty())
            assertEquals(emptyList<TrainingSet>(), room.store.retainedSession(receipt).sets)
            assertEquals(emptyList<TrainingSet>(), room.training.session(live.id)!!.sets)
        }
    }

    @Test fun aConversationDeleteTimerCannotPublishItsOldAccountsFailureIntoTheNextSeat() = runTest {
        val fake = FakeGymRest()
        fake.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val gate = CompletableDeferred<Unit>()
        val log = object : GymRest by fake {
            override suspend fun deleteThread(id: String) {
                gate.await()
                throw IOException("offline")
            }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = log).use { room ->
            room.select("a")
            room.store.withhold(Deletion.Thread("thr_1"))
            advanceTimeBy(Withheld.windowMs)
            runCurrent()
            assertFalse("the delete is on the wire", room.store.withheld.single().takeable)
            val arrival = launch { room.select("b") }
            runCurrent()
            gate.complete(Unit)
            arrival.join()
            runCurrent()
            assertNull(room.store.deleteRefused)
            assertTrue(room.store.withheld.isEmpty())
            assertEquals(setOf("thr_1"), fake.conversations.keys)
        }
    }

    @Test fun aStaleSeedCannotOverwriteAnAcceptedCorrection() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            room.store.start(); room.store.choose("bench-press"); room.store.logSet(60.0, 8)
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

    @Test fun keepingTheReceiptRetriesOneCreationDocumentEvenAfterTheProgramGrows() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val rows = listOf(TrainingSet("set_a", "bench-press", weightKg = 60.0, reps = 8, completedAtMs = 1_000))
            val first = room.store.keep(rows, "Push A", "rt_receipt", position = 0)
            val retried = room.store.keep(rows, "Push A", "rt_receipt", position = 0)
            assertEquals(first, retried)
            assertEquals(listOf("rt_receipt"), room.training.program().map { it.id })
            assertEquals(listOf("rt_receipt"), room.store.allRoutines.map { it.id })
            assertEquals(listOf(RoutineEntry(exerciseId = "bench-press", position = 1, sets = listOf(SetTarget(8, 60.0)))),
                room.training.program().single().entries)
        }
    }

    @Test fun aRetriedKeepCannotClaimADifferentNameUnderItsOriginalIdentity() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val rows = listOf(TrainingSet("set_a", "bench-press", weightKg = 60.0, reps = 8, completedAtMs = 1_000))
            val kept = room.store.keep(rows, "Push A", "rt_receipt", position = 0) as GymResult.Ok
            val retry = room.store.keep(rows, "Push B", "rt_receipt", position = 0)
            assertEquals(GymResult.Failed(WriteFailure.Refused(
                "this save already holds different details — reopen the saved routine to edit it")), retry)
            assertEquals(listOf(kept.value), room.training.program())
            assertEquals(listOf(kept.value), room.store.allRoutines)
            assertEquals("Push A", kept.value.name)
        }
    }
}
