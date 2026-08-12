package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException

// The claim's own fine grain, driven directly: the order of the shelves, the timestamp repairs,
// and the id remints with their references re-pointed. The through-the-store paths live in
// TrainingStoreTests; this file is where each rule is the subject.
class ClaimReplayTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun shelf() = LocalLog(File(tmp.root, "local-${System.nanoTime()}.json"))
    private fun queue() = SetQueue(File(tmp.root, "queue-${System.nanoTime()}.json"))

    private fun refusal(status: Int, code: String, message: String = "a sentence") =
        WindmillApiException.Refused(status, Refusal(message = message, code = code))

    private fun aSet(id: String, exerciseId: String = "bench-press", at: Long) = TrainingSet(
        id = id, exerciseId = exerciseId, weightKg = 82.5, reps = 5, completedAtMs = at)

    // Movements before routines before sessions, sessions oldest first — a set may not reach the
    // log before the movement it names, and a start may not name a routine the account lacks.
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

        val outcome = ClaimReplay(server, localLog, queue()).run()

        assertEquals(listOf("createExercise", "createRoutine", "start", "append", "finish",
            "start", "append", "finish"), server.calls)
        assertEquals("oldest first", listOf("ses_old", "ses_new"), server.started.map { it.id })
        assertTrue(outcome.said.isEmpty())
        assertTrue(outcome.liveLanded)
        assertTrue(localLog.finished.isEmpty() && localLog.routines.isEmpty() && localLog.exercises.isEmpty())
    }

    // A clock that lied once may not cost the session: every instant is repaired into the server's
    // (0, 253402300799000] bound, and a finish never lands before its own start.
    @Test
    fun testBrokenTimestampsAreRepairedBeforeTheyRide() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 0, finishedAtMs = -5),
            listOf(aSet("set_a", at = 0))))

        ClaimReplay(server, localLog, queue()).run()

        assertEquals(1L, server.started.single().startedAt)
        assertEquals(1L, server.appended.single().completedAt)
        assertEquals(listOf("ses_1" to 1L), server.finished)
    }

    // A spent set id is re-minted under the claim's own budget, and the fresh id is written back
    // to the shelf — so a claim that dies mid-way replays under the SAME repaired id and the log
    // still converges on one row.
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

        ClaimReplay(server, localLog, queue(), mintSet = { "set_fresh" }).run()

        assertEquals(listOf("set_spent", "set_fresh"), server.appended.map { it.id })
        assertEquals(listOf("set_fresh"), server.sets.getValue("ses_1").map { it.id })
        assertTrue("the session settled and left the shelf", localLog.finished.isEmpty())
    }

    // A spent routine id re-points the sessions that ran it before any of them replays, so a
    // claimed start still names the routine that actually landed.
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

        ClaimReplay(server, localLog, queue(), mintRoutine = { "rt_fresh" }).run()

        assertEquals(listOf("rt_fresh"), server.written.keys.toList())
        assertEquals("rt_fresh", server.started.single().routineId)
        assertNull(server.written["rt_spent"])
    }

    // A routine the server refuses outright would be re-sent identically on every connect
    // forever. It is SAID and orphaned instead: the document leaves the shelf, and the sessions
    // that named it keep their frozen plan and replay ad-hoc.
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

        val outcome = ClaimReplay(server, localLog, queue()).run()

        assertNull("the start names no routine the account lacks", server.started.single().routineId)
        assertEquals("the loss is said under the routine's name",
            listOf(RefusedClaim("Push Day", "that document is unclaimable")), outcome.said)
        assertTrue("the shelf let go — a terminal write is not re-sent every connect",
            localLog.routines.isEmpty())
        assertTrue("the session itself still settled", localLog.finished.isEmpty())
    }

    // A movement the server refuses outright ends the same way: SAID and let go, and the claim
    // moves on to the shelves behind it — its sets keep the id and are refused by name if the
    // log turns them away when they replay.
    @Test
    fun testAMovementRefusedOutrightIsSaidLetGoAndTheClaimMovesOn() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(Exercise(id = "ex_bad", name = "Zercher Squat", custom = true))
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", exerciseId = "ex_bad", at = 1_100))))
        server.refuseCreate = refusal(400, code = "bad-movement", message = "that name is unclaimable")

        val outcome = ClaimReplay(server, localLog, queue()).run()

        assertEquals("the loss is said under the movement's name",
            listOf(RefusedClaim("Zercher Squat", "that name is unclaimable")), outcome.said)
        assertTrue("the shelf let go — a terminal write is not re-sent every connect",
            localLog.exercises.isEmpty())
        assertTrue("and the claim moved on to the sessions", localLog.finished.isEmpty())
        assertEquals(listOf("set_a"), server.sets.getValue("ses_1").map { it.id })
    }

    // THE CORRECTION MADE SIGNED OUT SURVIVES THE CLAIM, and it is the whole of §G18's hard half.
    // The session was never sent, so the fix rewrote the row that WILL be sent: the corrected set
    // replays, the original never does, and there is exactly one row at the end of it.
    @Test
    fun testASetCorrectedBeforeTheClaimReplaysCorrectedAndNeverTwice() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))
        localLog.fixSet("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Drop))

        ClaimReplay(server, localLog, queue()).run()

        assertEquals("one row, and it is the one the lifter fixed it to",
            listOf("set_a"), server.sets.getValue("ses_1").map { it.id })
        assertEquals(listOf(90.0), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals(listOf(3), server.sets.getValue("ses_1").map { it.reps })
        assertEquals(listOf(SetKind.Drop), server.sets.getValue("ses_1").map { it.kind })
        assertEquals("the original never went out at all", listOf(90.0), server.appended.map { it.weightKg })
        assertTrue("and nothing needed correcting after the fact", server.fixes.isEmpty())
    }

    // THE HALF-CLAIMED SESSION, which is the case that silently loses a correction. An earlier pass
    // landed the set and then stopped retryably, so the shelf still holds the row — and a replay of
    // an already-stored id answers with the row AS IT WAS LOGGED. The shelf is what the lifter
    // fixed it to, so the account is moved to the shelf rather than the other way round.
    @Test
    fun testASetCorrectedAfterItAlreadyLandedIsMovedOnTheAccountRatherThanLostToTheReplay() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        // A first pass that landed both sets and then could not close the session.
        server.onFinish = { throw IOException("offline") }
        assertTrue(ClaimReplay(server, localLog, queue()).run().retryable)
        server.onFinish = {}

        localLog.fixSet("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))
        ClaimReplay(server, localLog, queue()).run()

        assertEquals("still one row per set — a correction is never a second row",
            listOf("set_a", "set_b"), server.sets.getValue("ses_1").map { it.id })
        assertEquals(listOf(90.0, 82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals("only the set that actually moved was corrected",
            listOf(Triple("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))),
            server.fixes)
        assertTrue("and the session settled", localLog.finished.isEmpty())
    }

    // ...and the delete's own half. Dropping the set from the shelf alone would let the survivors
    // replay and leave the deleted one standing on the account forever — the delete undoing itself.
    // The tombstone is what tells the log, and a DELETE is 204 for a set it never had.
    @Test
    fun testASetDeletedAfterItAlreadyLandedIsTakenOffTheAccountByItsTombstone() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        server.onFinish = { throw IOException("offline") }
        assertTrue(ClaimReplay(server, localLog, queue()).run().retryable)
        server.onFinish = {}

        localLog.deleteSet("ses_1", "set_a")
        ClaimReplay(server, localLog, queue()).run()

        assertEquals(listOf("set_b"), server.sets.getValue("ses_1").map { it.id })
        assertEquals(listOf("ses_1" to "set_a"), server.removed)
        assertTrue("the session settled and left the shelf with its tombstones",
            localLog.finished.isEmpty())
    }

    // THE CORRECTION MADE WHILE THE CLAIM IS WALKING, which is the window a snapshot of the shelf
    // loses. `connect` publishes the shelf's rows BEFORE the claim starts and the deliver cadence
    // re-runs it every few seconds, so a session being replayed is a session on screen: the lifter
    // fixes a set while the pass is out on the wire, and it is written to the row behind the walk.
    // A snapshot would send the numbers they fixed away from and then forget the row holding the
    // repair — the correction lost with nothing said. Every pass re-reads instead.
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

        ClaimReplay(server, localLog, queue()).run()

        assertEquals("one row per set, still", listOf("set_a", "set_b"),
            server.sets.getValue("ses_1").map { it.id })
        assertEquals("and the account holds what the lifter fixed it to",
            listOf(90.0, 82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals(listOf(Triple("ses_1", "set_a",
            SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))), server.fixes)
        assertTrue(localLog.finished.isEmpty())
    }

    // ...and the same window over the CLOSE, which is the last round trip before the row is
    // forgotten. Neither route refuses a set in a finished session — a lifter reads the log after
    // the workout, which is exactly when they see the typo — so the delete still goes, and the row
    // is forgotten only by a pass that found nothing left to do.
    @Test
    fun testASetDeletedWhileTheClaimIsClosingTheSessionIsStillTakenOffTheAccount() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        server.onFinish = { localLog.deleteSet("ses_1", "set_a") }

        ClaimReplay(server, localLog, queue()).run()

        assertEquals(listOf("set_b"), server.sets.getValue("ses_1").map { it.id })
        assertEquals(listOf("ses_1" to "set_a"), server.removed)
        assertTrue("the row is not forgotten with a repair still standing on it",
            localLog.finished.isEmpty())
    }

    // A tombstone for a set that never reached the log costs one 204 and nothing else — the route
    // answers the same for a set that never existed as for one it just took away.
    @Test
    fun testATombstoneForASetTheLogNeverHadIsStillSentAndCostsNothing() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        localLog.deleteSet("ses_1", "set_a")

        val outcome = ClaimReplay(server, localLog, queue()).run()

        assertEquals("only the surviving set was ever appended",
            listOf("set_b"), server.appended.map { it.id })
        assertEquals(listOf("ses_1" to "set_a"), server.removed)
        assertTrue(outcome.said.isEmpty())
        assertTrue(localLog.finished.isEmpty())
    }

    // A delete the log could not take is not a delete that is lost: the route has no terminal
    // refusal at all, so the session stays on the shelf and a later pass carries it.
    @Test
    fun testADeleteTheLogCouldNotTakeKeepsTheSessionOnTheShelfForAnotherPass() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))
        localLog.deleteSet("ses_1", "set_a")
        server.refuseDelete = refusal(500, code = "storage", message = "internal error")

        val first = ClaimReplay(server, localLog, queue()).run()
        assertTrue("retryable, and the row is still here to try with", first.retryable)
        assertEquals(listOf("set_a"), localLog.finished.single().deleted)
        assertTrue("nothing was said — a 500 has cost the delete nothing", first.said.isEmpty())

        server.refuseDelete = null
        ClaimReplay(server, localLog, queue()).run()
        assertTrue(localLog.finished.isEmpty())
    }

    // A correction the log will never read is a repair that is lost, and it is SAID: the account
    // keeps the numbers the set was logged with, and this banner is the last copy of what the
    // lifter meant instead. The session still settles — a terminal write re-sent on every connect
    // would jam the claim behind an answer that cannot change.
    @Test
    fun testACorrectionRefusedOutrightIsSaidAndTheSessionStillSettles() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))
        server.onFinish = { throw IOException("offline") }
        ClaimReplay(server, localLog, queue()).run()
        server.onFinish = {}

        localLog.fixSet("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))
        server.refuseFix = { refusal(400, code = "fix-unreadable", message = "could not read that fix") }

        val outcome = ClaimReplay(server, localLog, queue()).run()

        assertEquals(listOf(RefusedSet(id = "set_a", exerciseId = "bench-press", weightKg = 90.0,
            reps = 3, reason = "the log kept the numbers this set was logged with")), outcome.said)
        assertEquals("the account keeps what it had rather than losing the set",
            listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertTrue(localLog.finished.isEmpty())
    }

    // The one 404 a claimed start can meet: the routine was claimed on an earlier connect, then
    // deleted from another surface. The plan is a frozen snapshot, so the id that will never
    // resolve is orphaned — everywhere the shelf wrote it — and the start retries plain rather
    // than jamming the whole claim behind a deterministic refusal forever.
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

        val outcome = ClaimReplay(server, localLog, queue()).run()

        assertEquals("the 404 start retried without the routine, and the orphan reached ses_2 too",
            listOf("rt_gone", null, null), server.started.map { it.routineId })
        assertEquals(listOf("ses_1", "ses_1", "ses_2"), server.started.map { it.id })
        assertTrue("both sessions settled", localLog.finished.isEmpty())
        assertTrue("a deterministic 404 is a repair, not a loss", outcome.said.isEmpty())
        assertEquals(listOf("set_a"), server.sets.getValue("ses_1").map { it.id })
    }
}
