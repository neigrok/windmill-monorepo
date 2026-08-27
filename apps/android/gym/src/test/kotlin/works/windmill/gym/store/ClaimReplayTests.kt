package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.Units
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.ClaimReplay.Outcome
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException

class ClaimReplayTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun shelf() = LocalLog(File(tmp.root, "local-${System.nanoTime()}.json"))
    private fun settings() = LocalPreferences(File(tmp.root, "prefs-${System.nanoTime()}.json"))
    private fun queue() = SetQueue(File(tmp.root, "queue-${System.nanoTime()}.json"))
    private fun weights() = LocalBodyweight(File(tmp.root, "bodyweight-${System.nanoTime()}.json"))

    private fun refusal(status: Int, code: String, message: String = "a sentence") =
        WindmillApiException.Refused(status, Refusal(message = message, code = code))

    private fun aSet(id: String, exerciseId: String = "bench-press", at: Long) = TrainingSet(
        id = id, exerciseId = exerciseId, weightKg = 82.5, reps = 5, completedAtMs = at)

    @Test
    fun testTheShelvesClaimInOrderAndSessionsOldestFirst() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(Exercise(id = "ex_1", name = "Zercher Squat", custom = true))
        localLog.hold(Routine(id = "rt_1", name = "Legs",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "ex_1", targetSets = 3))))
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_new", startedAtMs = 5_000, finishedAtMs = 6_000),
            listOf(aSet("set_b", at = 5_100))))
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_old", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))

        val outcome = ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals(listOf("createExercise", "createRoutine", "start", "append", "finish",
            "start", "append", "finish"), server.calls)
        assertEquals("oldest first", listOf("ses_old", "ses_new"), server.started.map { it.id })
        assertTrue(outcome.said.isEmpty())
        assertTrue(outcome.liveLanded)
        assertTrue(localLog.finished.isEmpty() && localLog.routines.isEmpty() && localLog.exercises.isEmpty())
    }

    @Test
    fun testTheRackClaimsBeforeAnythingElseAndOnlyWhenItIsOwed() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        val settings = settings()
        settings.save(GymPreferences(units = Units.Pounds, restSeconds = 90))
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))

        ClaimReplay(server, localLog, queue(), settings, weights()).run()

        assertEquals("savePreferences", server.calls.first())
        assertEquals(listOf(Units.Pounds), server.settingsWritten.map { it.units })
        assertEquals(90, server.settings?.restSeconds)
        assertFalse("the log took them — nothing is owed", settings.owed)

        server.calls.clear()
        ClaimReplay(server, localLog, queue(), settings, weights()).run()
        assertFalse("savePreferences" in server.calls)
    }

    @Test
    fun testARackThatCannotBeSentStopsNothingBehindIt() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        val settings = settings()
        settings.save(GymPreferences(restSeconds = 90))
        server.refusePreferences = IOException("offline")
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))

        val outcome = ClaimReplay(server, localLog, queue(), settings, weights()).run()

        assertEquals(listOf("set_a"), server.sets.getValue("ses_1").map { it.id })
        assertTrue("the session went, the rack did not", localLog.finished.isEmpty())
        assertTrue("still owed, and the cadence carries it", settings.owed)
        assertFalse("the SHELF is settled — a rack does not put the walk on a poll", outcome.retryable)
        assertTrue("nothing was lost, so nothing is said", outcome.said.isEmpty())
    }

    @Test
    fun testAnOwedRackDoesNotPutTheHaltsOnACadence() = runTest {
        for (answer in listOf(refusal(409, code = "session-already-open"),
                              refusal(400, code = "session-start", message = "that start cannot be taken"))) {
            val server = FakeTraining()
            val settings = settings()
            val queue = queue()
            settings.save(GymPreferences(restSeconds = 90))
            server.refusePreferences = IOException("offline")
            queue.hold(Session(id = "ses_live", startedAtMs = 9_000), unclaimed = true)
            server.refuseStart = { answer }

            val outcome = ClaimReplay(server, shelf(), queue, settings, weights()).run()

            assertFalse("halted at $answer with a rack owed", outcome.retryable)
            assertFalse(outcome.liveLanded)
            assertTrue("the rack is still the cadence's to send", settings.owed)
        }
    }

    @Test
    fun testTheRackRetriesByItselfWithoutWalkingTheShelf() = runTest {
        val server = FakeTraining()
        val settings = settings()
        val queue = queue()
        settings.save(GymPreferences(restSeconds = 90))
        queue.hold(Session(id = "ses_live", startedAtMs = 9_000), unclaimed = true)

        val said = ClaimReplay(server, shelf(), queue, settings, weights()).runPreferences()

        assertEquals(listOf("savePreferences"), server.calls)
        assertEquals(90, server.settings?.restSeconds)
        assertFalse(settings.owed)
        assertTrue(said.isEmpty())
    }

    @Test
    fun testARackTheLogRefusesOutrightIsSaidAndLetGo() = runTest {
        val server = FakeTraining()
        val settings = settings()
        settings.save(GymPreferences(restSeconds = 90))
        server.refusePreferences = refusal(400, code = "rest-target", message = "a rest target runs from 15 to 900 seconds")

        val outcome = ClaimReplay(server, shelf(), queue(), settings, weights()).run()

        assertEquals(listOf("a rest target runs from 15 to 900 seconds"), outcome.said.map { it.reason })
        assertFalse("let go — not re-sent on every connect", settings.owed)
        assertEquals("and still drawn, because it is what the lifter chose",
            90, settings.document.restSeconds)
        assertFalse("nothing here is worth another pass", outcome.retryable)
    }

    @Test
    fun testBrokenTimestampsAreRepairedBeforeTheyRide() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 0, finishedAtMs = -5),
            listOf(aSet("set_a", at = 0))))

        ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals(1L, server.started.single().startedAt)
        assertEquals(1L, server.appended.single().completedAt)
        assertEquals(listOf("ses_1" to 1L), server.finished)
    }

    @Test
    fun testASpentSetIdIsMintedAgainAndTheShelfLearnsTheFreshId() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_spent", at = 1_100))))
        var refused = false
        server.refuse = { write ->
            if (write.id == "set_spent" && !refused) {
                refused = true
                refusal(409, code = "set-id-taken")
            } else null
        }

        ClaimReplay(server, localLog, queue(), settings(), weights(), mintSet = { "set_fresh" }).run()

        assertEquals(listOf("set_spent", "set_fresh"), server.appended.map { it.id })
        assertEquals(listOf("set_fresh"), server.sets.getValue("ses_1").map { it.id })
        assertTrue("the session settled and left the shelf", localLog.finished.isEmpty())
    }

    @Test
    fun testASpentRoutineIdIsMintedAgainAndItsSessionsFollow() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(Routine(id = "rt_spent", name = "Push Day",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5))))
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000, routineId = "rt_spent"),
            listOf(aSet("set_a", at = 1_100))))
        var refused = false
        server.refuseRoutine = { write ->
            if (write.id == "rt_spent" && !refused) {
                refused = true
                refusal(409, code = "routine-id-taken")
            } else null
        }

        ClaimReplay(server, localLog, queue(), settings(), weights(), mintRoutine = { "rt_fresh" }).run()

        assertEquals(listOf("rt_fresh"), server.written.keys.toList())
        assertEquals("rt_fresh", server.started.single().routineId)
        assertNull(server.written["rt_spent"])
    }

    @Test
    fun testARoutineRefusedOutrightIsSaidOrphanedAndItsSessionsReplayAdHoc() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(Routine(id = "rt_stuck", name = "Push Day",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5))))
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000, routineId = "rt_stuck"),
            emptyList()))
        server.refuseRoutine = { refusal(400, code = "bad-routine", message = "that document is unclaimable") }

        val outcome = ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertNull("the start names no routine the account lacks", server.started.single().routineId)
        assertEquals("the loss is said under the routine's name",
            listOf(RefusedClaim("rt_stuck", "Push Day", "that document is unclaimable")), outcome.said)
        assertTrue("the shelf let go — a terminal write is not re-sent every connect",
            localLog.routines.isEmpty())
        assertTrue("the session itself still settled", localLog.finished.isEmpty())
    }

    @Test
    fun testAMovementRefusedOutrightIsSaidLetGoAndTheClaimMovesOn() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(Exercise(id = "ex_bad", name = "Zercher Squat", custom = true))
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", exerciseId = "ex_bad", at = 1_100))))
        server.refuseCreate = refusal(400, code = "bad-movement", message = "that name is unclaimable")

        val outcome = ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals("the loss is said under the movement's name",
            listOf(RefusedClaim("ex_bad", "Zercher Squat", "that name is unclaimable")), outcome.said)
        assertTrue("the shelf let go — a terminal write is not re-sent every connect",
            localLog.exercises.isEmpty())
        assertTrue("and the claim moved on to the sessions", localLog.finished.isEmpty())
        assertEquals(listOf("set_a"), server.sets.getValue("ses_1").map { it.id })
    }

    @Test
    fun testASetCorrectedBeforeTheClaimReplaysCorrectedAndNeverTwice() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))
        localLog.fixSet("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Drop))

        ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals("one row, and it is the one the lifter fixed it to",
            listOf("set_a"), server.sets.getValue("ses_1").map { it.id })
        assertEquals(listOf(90.0), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals(listOf(3), server.sets.getValue("ses_1").map { it.reps })
        assertEquals(listOf(SetKind.Drop), server.sets.getValue("ses_1").map { it.kind })
        assertEquals("the original never went out at all", listOf(90.0), server.appended.map { it.weightKg })
        assertTrue("and nothing needed correcting after the fact", server.fixes.isEmpty())
    }

    @Test
    fun testASetCorrectedAfterItAlreadyLandedIsMovedOnTheAccountRatherThanLostToTheReplay() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        server.onFinish = { throw IOException("offline") }
        assertTrue(ClaimReplay(server, localLog, queue(), settings(), weights()).run().retryable)
        server.onFinish = {}

        localLog.fixSet("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))
        ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals("still one row per set — a correction is never a second row",
            listOf("set_a", "set_b"), server.sets.getValue("ses_1").map { it.id })
        assertEquals(listOf(90.0, 82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals("only the set that actually moved was corrected, and the replay restates the " +
            "whole stored row rather than a diff — the account's copy must end up saying what the " +
            "shelf says, rpe and note included",
            listOf(Triple("ses_1", "set_a", SetFix(aSet("set_a", at = 1_100)
                .copy(weightKg = 90.0, reps = 3, kind = SetKind.Working)))),
            server.fixes)
        assertTrue("and the session settled", localLog.finished.isEmpty())
    }

    @Test
    fun testASetDeletedAfterItAlreadyLandedIsTakenOffTheAccountByItsTombstone() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        server.onFinish = { throw IOException("offline") }
        assertTrue(ClaimReplay(server, localLog, queue(), settings(), weights()).run().retryable)
        server.onFinish = {}

        localLog.deleteSet("ses_1", "set_a")
        ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals(listOf("set_b"), server.sets.getValue("ses_1").map { it.id })
        assertEquals(listOf("ses_1" to "set_a"), server.removed)
        assertTrue("the session settled and left the shelf with its tombstones",
            localLog.finished.isEmpty())
    }

    @Test
    fun testASetCorrectedWhileTheClaimIsWalkingIsCarriedRatherThanForgottenWithTheRow() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        server.onAppend = { write ->
            if (write.id == "set_b") {
                localLog.fixSet("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))
            }
        }

        ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals("one row per set, still", listOf("set_a", "set_b"),
            server.sets.getValue("ses_1").map { it.id })
        assertEquals("and the account holds what the lifter fixed it to",
            listOf(90.0, 82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals(listOf(Triple("ses_1", "set_a", SetFix(aSet("set_a", at = 1_100)
            .copy(weightKg = 90.0, reps = 3, kind = SetKind.Working)))), server.fixes)
        assertTrue(localLog.finished.isEmpty())
    }

    @Test
    fun testASetDeletedWhileTheClaimIsClosingTheSessionIsStillTakenOffTheAccount() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        server.onFinish = { localLog.deleteSet("ses_1", "set_a") }

        ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals(listOf("set_b"), server.sets.getValue("ses_1").map { it.id })
        assertEquals(listOf("ses_1" to "set_a"), server.removed)
        assertTrue("the row is not forgotten with a repair still standing on it",
            localLog.finished.isEmpty())
    }

    @Test
    fun testATombstoneForASetTheLogNeverHadIsStillSentAndCostsNothing() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        localLog.deleteSet("ses_1", "set_a")

        val outcome = ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals("only the surviving set was ever appended",
            listOf("set_b"), server.appended.map { it.id })
        assertEquals(listOf("ses_1" to "set_a"), server.removed)
        assertTrue(outcome.said.isEmpty())
        assertTrue(localLog.finished.isEmpty())
    }

    @Test
    fun testADeleteTheLogCouldNotTakeKeepsTheSessionOnTheShelfForAnotherPass() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))
        localLog.deleteSet("ses_1", "set_a")
        server.refuseDelete = refusal(500, code = "storage", message = "internal error")

        val first = ClaimReplay(server, localLog, queue(), settings(), weights()).run()
        assertTrue("retryable, and the row is still here to try with", first.retryable)
        assertEquals(listOf("set_a"), localLog.finished.single().deleted)
        assertTrue("nothing was said — a 500 has cost the delete nothing", first.said.isEmpty())

        server.refuseDelete = null
        ClaimReplay(server, localLog, queue(), settings(), weights()).run()
        assertTrue(localLog.finished.isEmpty())
    }

    @Test
    fun testACorrectionRefusedOutrightIsSaidAndTheSessionStillSettles() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))
        server.onFinish = { throw IOException("offline") }
        ClaimReplay(server, localLog, queue(), settings(), weights()).run()
        server.onFinish = {}

        localLog.fixSet("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))
        server.refuseFix = { refusal(400, code = "fix-unreadable", message = "could not read that fix") }

        val outcome = ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals(listOf(RefusedSet(id = "set_a", exerciseId = "bench-press", weightKg = 90.0,
            reps = 3, reason = "the log kept the numbers this set was logged with")), outcome.said)
        assertEquals("the account keeps what it had rather than losing the set",
            listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertTrue(localLog.finished.isEmpty())
    }

    @Test
    fun testAClaimedStartMeetingADeletedRoutine404OrphansItAndRetries() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000, routineId = "rt_gone"),
            listOf(aSet("set_a", at = 1_100))))
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_2", startedAtMs = 3_000, finishedAtMs = 4_000, routineId = "rt_gone"),
            emptyList()))
        server.refuseStart = { start ->
            if (start.routineId != null) refusal(404, code = "not-found", message = "no such routine")
            else null
        }

        val outcome = ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals("the 404 start retried without the routine, and the orphan reached ses_2 too",
            listOf("rt_gone", null, null), server.started.map { it.routineId })
        assertEquals(listOf("ses_1", "ses_1", "ses_2"), server.started.map { it.id })
        assertTrue("both sessions settled", localLog.finished.isEmpty())
        assertTrue("a deterministic 404 is a repair, not a loss", outcome.said.isEmpty())
        assertEquals(listOf("set_a"), server.sets.getValue("ses_1").map { it.id })
    }
    @Test
    fun testTheClaimCarriesTheRoutineAndNeverACardOnIt() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(Routine(
            id = "rt_1", name = "Push A", revision = 7,
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5)),
            pendingProposal = Proposal(id = "prop_1", routineId = "rt_1", changeCount = 3)))

        val outcome = ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals(listOf("createRoutine"), server.calls)
        assertTrue("no proposal door was opened", server.ledger.isEmpty())
        val landed = server.written.getValue("rt_1")
        assertNull("the card did not ride", landed.pendingProposal)
        assertEquals("the revision is the log's to keep", 1, landed.revision)
        assertTrue(outcome.said.isEmpty())
        assertTrue(localLog.routines.isEmpty())
    }

    @Test
    fun testAClaimedLiveSessionIsNeverReStartedAndAnUnclaimedOneIsClaimedOnce() = runTest {
        val server = FakeTraining()
        val queue = queue()
        queue.hold(Session(id = "ses_live", startedAtMs = 9_000))
        assertFalse(queue.sessionIsUnclaimed)

        val first = ClaimReplay(server, shelf(), queue, settings(), weights()).run()
        assertEquals("no start went out for a session the log answered for", emptyList<String>(), server.calls)
        assertTrue(first.liveLanded)

        queue.hold(Session(id = "ses_mine", startedAtMs = 9_500), unclaimed = true)
        assertTrue(queue.sessionIsUnclaimed)
        val second = ClaimReplay(server, shelf(), queue, settings(), weights()).run()
        assertEquals(listOf("start"), server.calls)
        assertEquals(listOf(false), server.started.map { it.joinOpenSession })
        assertTrue(second.liveLanded)
        assertFalse("written claimed for its id, and on disk", queue.sessionIsUnclaimed)

        val third = ClaimReplay(server, shelf(), queue, settings(), weights()).run()
        assertEquals("the next pass skips it", listOf("start"), server.calls)
        assertTrue(third.liveLanded)
    }

    @Test
    fun testAShelfStartMeetingThePhonesOwnLiveWorkoutSkipsItRatherThanHalting() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_live", startedAtMs = 9_000))
        val queue = queue()
        queue.hold(Session(id = "ses_live", startedAtMs = 9_000))
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_past", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))
        localLog.hold(Routine(id = "rt_1", name = "Legs",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "back-squat", targetSets = 3))))

        val outcome = ClaimReplay(server, localLog, queue, settings(), weights()).run()

        assertEquals("the routine landed, the past session's start was refused, and nothing waited",
            listOf("createRoutine", "start"), server.calls)
        assertEquals(1, localLog.finished.size)
        assertEquals("nothing filed into the live workout", null, server.sets["ses_past"])
        assertEquals(Outcome(said = emptyList(), liveLanded = true, retryable = false), outcome)
        assertFalse("and the live session stays the log's", queue.sessionIsUnclaimed)

        queue.hold(null)
        val waited = ClaimReplay(server, localLog, queue, settings(), weights()).run()
        assertEquals(Outcome(said = emptyList(), liveLanded = false, retryable = false), waited)
        assertEquals(1, localLog.finished.size)
    }

    @Test
    fun testAClockAheadStartRetriesAndAnyOther400IsSaidAndLetGo() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_early", startedAtMs = 1_000, finishedAtMs = 2_000,
                plan = PlanSnapshot(routine = "Push Day")),
            listOf(aSet("set_a", at = 1_100))))

        server.refuseStart = { refusal(400, code = "clock-ahead", message = "that start is in the future") }
        val transient = ClaimReplay(server, localLog, queue(), settings(), weights()).run()
        assertEquals(Outcome(said = emptyList(), liveLanded = false, retryable = true), transient)
        assertEquals("the row waits for the cadence", 1, localLog.finished.size)

        server.refuseStart = { refusal(400, code = "bad-start", message = "that start cannot be taken") }
        val terminal = ClaimReplay(server, localLog, queue(), settings(), weights()).run()
        assertEquals(Outcome(
            said = listOf(RefusedClaim("ses_early", "Push Day · ${Readout.date(1_000)}", "that start cannot be taken")),
            liveLanded = true, retryable = false), terminal)
        assertTrue("let go, so no later connect re-sends it", localLog.finished.isEmpty())

        server.refuseStart = { null }
        ClaimReplay(server, localLog, queue(), settings(), weights()).run()
        assertEquals("nothing left to walk", listOf("start", "start"), server.calls)
    }

    @Test
    fun testAnAppend404AfterTheStartAnsweredIsTheWorkoutGoneAndIsSaidOnce() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        server.onAppend = { server.stored.remove("ses_1") }

        val outcome = ClaimReplay(server, localLog, queue(), settings(), weights()).run()

        assertEquals(listOf("start", "append"), server.calls)
        assertEquals(Outcome(
            said = listOf(RefusedClaim("ses_1", "workout · ${Readout.date(1_000)}", "that workout is no longer on the log")),
            liveLanded = true, retryable = false), outcome)
        assertTrue(localLog.finished.isEmpty())
    }
}
