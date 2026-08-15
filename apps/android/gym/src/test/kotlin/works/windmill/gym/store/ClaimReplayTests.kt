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

// The claim's own fine grain, driven directly: the order of the shelves, the timestamp repairs,
// and the id remints with their references re-pointed. The through-the-store paths live in
// TrainingStoreTests; this file is where each rule is the subject.
class ClaimReplayTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun shelf() = LocalLog(File(tmp.root, "local-${System.nanoTime()}.json"))
    // Untouched, and that is the ordinary case: a seat that never opened the settings screen holds
    // no document, so the claim's first step sends nothing and every `calls` assertion below reads
    // exactly as it did before preferences joined the order.
    private fun settings() = LocalPreferences(File(tmp.root, "prefs-${System.nanoTime()}.json"))
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

        val outcome = ClaimReplay(server, localLog, queue(), settings()).run()

        assertEquals(listOf("createExercise", "createRoutine", "start", "append", "finish",
            "start", "append", "finish"), server.calls)
        assertEquals("oldest first", listOf("ses_old", "ses_new"), server.started.map { it.id })
        assertTrue(outcome.said.isEmpty())
        assertTrue(outcome.liveLanded)
        assertTrue(localLog.finished.isEmpty() && localLog.routines.isEmpty() && localLog.exercises.isEmpty())
    }

    // PREFERENCES RIDE FIRST, and only when this device owes them. Nothing downstream references
    // them, so they lead because they are one cheap PUT and because a lifter who set their rack
    // before signing in should see it survive the moment the account arrives.
    @Test
    fun testTheRackClaimsBeforeAnythingElseAndOnlyWhenItIsOwed() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        val settings = settings()
        settings.save(GymPreferences(units = Units.Pounds, restSeconds = 90))
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))

        ClaimReplay(server, localLog, queue(), settings).run()

        assertEquals("savePreferences", server.calls.first())
        assertEquals(listOf(Units.Pounds), server.settingsWritten.map { it.units })
        assertEquals(90, server.settings?.restSeconds)
        assertFalse("the log took them — nothing is owed", settings.owed)

        // And a second pass over a settled device sends nothing at all: the claim is not a heartbeat.
        server.calls.clear()
        ClaimReplay(server, localLog, queue(), settings).run()
        assertFalse("savePreferences" in server.calls)
    }

    // A RACK THAT DID NOT LAND MAY NOT PARK A WORKOUT, and it may not re-arm one either. The claim
    // carries on past it and every session behind it still replays; what stays owed is the
    // DOCUMENT, on LocalPreferences, and `runPreferences` is what carries it. `retryable` keeps
    // meaning "another pass of the shelf could change this" — folding the rack into it would put
    // the whole walk on a four-second poll, including the two stops that must never be polled.
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

        val outcome = ClaimReplay(server, localLog, queue(), settings).run()

        assertEquals(listOf("set_a"), server.sets.getValue("ses_1").map { it.id })
        assertTrue("the session went, the rack did not", localLog.finished.isEmpty())
        assertTrue("still owed, and the cadence carries it", settings.owed)
        assertFalse("the SHELF is settled — a rack does not put the walk on a poll", outcome.retryable)
        assertTrue("nothing was lost, so nothing is said", outcome.said.isEmpty())
    }

    // THE TWO STOPS THAT MUST NEVER BE POLLED, with a rack owed behind them. A live workout the
    // account already has open WAITS for that workout to close, and a live start the log refuses
    // outright is over — both wait for the next connect, and neither becomes a four-second retry
    // because a settings PUT could not land in the same pass.
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

            val outcome = ClaimReplay(server, shelf(), queue, settings).run()

            assertFalse("halted at $answer with a rack owed", outcome.retryable)
            assertFalse(outcome.liveLanded)
            assertTrue("the rack is still the cadence's to send", settings.owed)
        }
    }

    // ...and the step that stands alone sends alone: no start, no append, one PUT.
    @Test
    fun testTheRackRetriesByItselfWithoutWalkingTheShelf() = runTest {
        val server = FakeTraining()
        val settings = settings()
        val queue = queue()
        settings.save(GymPreferences(restSeconds = 90))
        queue.hold(Session(id = "ses_live", startedAtMs = 9_000), unclaimed = true)

        val said = ClaimReplay(server, shelf(), queue, settings).runPreferences()

        assertEquals(listOf("savePreferences"), server.calls)
        assertEquals(90, server.settings?.restSeconds)
        assertFalse(settings.owed)
        assertTrue(said.isEmpty())
    }

    // A DOCUMENT THE LOG WILL NEVER TAKE AS WRITTEN is said out loud and let go, exactly as a
    // refused movement or routine is — a terminal write re-sent on every connect would jam the
    // claim forever behind an answer that cannot change. The device keeps drawing what the lifter
    // set; the account's own copy replaces it on the next read.
    @Test
    fun testARackTheLogRefusesOutrightIsSaidAndLetGo() = runTest {
        val server = FakeTraining()
        val settings = settings()
        settings.save(GymPreferences(restSeconds = 90))
        server.refusePreferences = refusal(400, code = "rest-target", message = "a rest target runs from 15 to 900 seconds")

        val outcome = ClaimReplay(server, shelf(), queue(), settings).run()

        assertEquals(listOf("a rest target runs from 15 to 900 seconds"), outcome.said.map { it.reason })
        assertFalse("let go — not re-sent on every connect", settings.owed)
        assertEquals("and still drawn, because it is what the lifter chose",
            90, settings.document.restSeconds)
        assertFalse("nothing here is worth another pass", outcome.retryable)
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

        ClaimReplay(server, localLog, queue(), settings()).run()

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

        ClaimReplay(server, localLog, queue(), settings(), mintSet = { "set_fresh" }).run()

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

        ClaimReplay(server, localLog, queue(), settings(), mintRoutine = { "rt_fresh" }).run()

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

        val outcome = ClaimReplay(server, localLog, queue(), settings()).run()

        assertNull("the start names no routine the account lacks", server.started.single().routineId)
        assertEquals("the loss is said under the routine's name",
            listOf(RefusedClaim("rt_stuck", "Push Day", "that document is unclaimable")), outcome.said)
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

        val outcome = ClaimReplay(server, localLog, queue(), settings()).run()

        assertEquals("the loss is said under the movement's name",
            listOf(RefusedClaim("ex_bad", "Zercher Squat", "that name is unclaimable")), outcome.said)
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

        ClaimReplay(server, localLog, queue(), settings()).run()

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
        assertTrue(ClaimReplay(server, localLog, queue(), settings()).run().retryable)
        server.onFinish = {}

        localLog.fixSet("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))
        ClaimReplay(server, localLog, queue(), settings()).run()

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
        assertTrue(ClaimReplay(server, localLog, queue(), settings()).run().retryable)
        server.onFinish = {}

        localLog.deleteSet("ses_1", "set_a")
        ClaimReplay(server, localLog, queue(), settings()).run()

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

        ClaimReplay(server, localLog, queue(), settings()).run()

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

        ClaimReplay(server, localLog, queue(), settings()).run()

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

        val outcome = ClaimReplay(server, localLog, queue(), settings()).run()

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

        val first = ClaimReplay(server, localLog, queue(), settings()).run()
        assertTrue("retryable, and the row is still here to try with", first.retryable)
        assertEquals(listOf("set_a"), localLog.finished.single().deleted)
        assertTrue("nothing was said — a 500 has cost the delete nothing", first.said.isEmpty())

        server.refuseDelete = null
        ClaimReplay(server, localLog, queue(), settings()).run()
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
        ClaimReplay(server, localLog, queue(), settings()).run()
        server.onFinish = {}

        localLog.fixSet("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))
        server.refuseFix = { refusal(400, code = "fix-unreadable", message = "could not read that fix") }

        val outcome = ClaimReplay(server, localLog, queue(), settings()).run()

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

        val outcome = ClaimReplay(server, localLog, queue(), settings()).run()

        assertEquals("the 404 start retried without the routine, and the orphan reached ses_2 too",
            listOf("rt_gone", null, null), server.started.map { it.routineId })
        assertEquals(listOf("ses_1", "ses_1", "ses_2"), server.started.map { it.id })
        assertTrue("both sessions settled", localLog.finished.isEmpty())
        assertTrue("a deterministic 404 is a repair, not a loss", outcome.said.isEmpty())
        assertEquals(listOf("set_a"), server.sets.getValue("ses_1").map { it.id })
    }
    // NO PROPOSAL IS EVER REPLAYED, and the shelf is why: a proposal needs an account for an agent
    // to have been granted anything against, so nothing signed out can hold one. A routine that
    // somehow arrived on the shelf wearing a card — a disk file written by a build that held one,
    // a routine copied from a read — lands on the account as the plain document it is: the write
    // is `RoutineWrite`, which carries neither the card nor the revision, and no proposal door is
    // touched by the claim at all.
    @Test
    fun testTheClaimCarriesTheRoutineAndNeverACardOnIt() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(Routine(
            id = "rt_1", name = "Push A", revision = 7,
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5)),
            pendingProposal = Proposal(id = "prop_1", routineId = "rt_1", changeCount = 3)))

        val outcome = ClaimReplay(server, localLog, queue(), settings()).run()

        assertEquals(listOf("createRoutine"), server.calls)
        assertTrue("no proposal door was opened", server.ledger.isEmpty())
        val landed = server.written.getValue("rt_1")
        assertNull("the card did not ride", landed.pendingProposal)
        assertEquals("the revision is the log's to keep", 1, landed.revision)
        assertTrue(outcome.said.isEmpty())
        assertTrue(localLog.routines.isEmpty())
    }

    // R2 — A LIVE SESSION THE LOG ALREADY HOLDS IS NEVER RE-STARTED. The queue's persisted bit says
    // whether the log answered for it: a claimed one is skipped outright — no start replay, which
    // is a settling call, goes out for it — and an unclaimed one is started once and then written
    // claimed for its id, so the next pass skips it too.
    @Test
    fun testAClaimedLiveSessionIsNeverReStartedAndAnUnclaimedOneIsClaimedOnce() = runTest {
        val server = FakeTraining()
        val queue = queue()
        queue.hold(Session(id = "ses_live", startedAtMs = 9_000))
        assertFalse(queue.sessionIsUnclaimed)

        val first = ClaimReplay(server, shelf(), queue, settings()).run()
        assertEquals("no start went out for a session the log answered for", emptyList<String>(), server.calls)
        assertTrue(first.liveLanded)

        queue.hold(Session(id = "ses_mine", startedAtMs = 9_500), unclaimed = true)
        assertTrue(queue.sessionIsUnclaimed)
        val second = ClaimReplay(server, shelf(), queue, settings()).run()
        assertEquals(listOf("start"), server.calls)
        assertEquals(listOf(false), server.started.map { it.joinOpenSession })
        assertTrue(second.liveLanded)
        assertFalse("written claimed for its id, and on disk", queue.sessionIsUnclaimed)

        val third = ClaimReplay(server, shelf(), queue, settings()).run()
        assertEquals("the next pass skips it", listOf("start"), server.calls)
        assertTrue(third.liveLanded)
    }

    // R2 — A SHELF START THAT MEETS THE PHONE'S OWN LIVE WORKOUT SKIPS THAT SESSION AND CARRIES ON.
    // The queue holds a session the log has answered for, so the account's one open workout is this
    // phone's: the shelf session stays on the shelf for the finish and the next connect to walk, the
    // walk continues past it, and the pass ends without a wait — the live session's own state is
    // never derived from that stop.
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

        val outcome = ClaimReplay(server, localLog, queue, settings()).run()

        assertEquals("the routine landed, the past session's start was refused, and nothing waited",
            listOf("createRoutine", "start"), server.calls)
        assertEquals(1, localLog.finished.size)
        assertEquals("nothing filed into the live workout", null, server.sets["ses_past"])
        assertEquals(Outcome(said = emptyList(), liveLanded = true, retryable = false), outcome)
        assertFalse("and the live session stays the log's", queue.sessionIsUnclaimed)

        // Somebody ELSE'S open workout is still the wait.
        queue.hold(null)
        val waited = ClaimReplay(server, localLog, queue, settings()).run()
        assertEquals(Outcome(said = emptyList(), liveLanded = false, retryable = false), waited)
        assertEquals(1, localLog.finished.size)
    }

    // R4 — A START REFUSED FOR A CLOCK AHEAD OF THE LOG'S RETRIES ON THE CADENCE, because it is
    // transient by construction: the instant ages into the past. Any OTHER 400 on a shelf start is
    // said under the session's name and the row let go — never a silent skip re-sent every connect.
    @Test
    fun testAClockAheadStartRetriesAndAnyOther400IsSaidAndLetGo() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_early", startedAtMs = 1_000, finishedAtMs = 2_000,
                plan = PlanSnapshot(routine = "Push Day")),
            listOf(aSet("set_a", at = 1_100))))

        server.refuseStart = { refusal(400, code = "clock-ahead", message = "that start is in the future") }
        val transient = ClaimReplay(server, localLog, queue(), settings()).run()
        assertEquals(Outcome(said = emptyList(), liveLanded = false, retryable = true), transient)
        assertEquals("the row waits for the cadence", 1, localLog.finished.size)

        server.refuseStart = { refusal(400, code = "bad-start", message = "that start cannot be taken") }
        val terminal = ClaimReplay(server, localLog, queue(), settings()).run()
        assertEquals(Outcome(
            said = listOf(RefusedClaim("ses_early", "Push Day · ${Readout.date(1_000)}", "that start cannot be taken")),
            liveLanded = true, retryable = false), terminal)
        assertTrue("let go, so no later connect re-sends it", localLog.finished.isEmpty())

        server.refuseStart = { null }
        ClaimReplay(server, localLog, queue(), settings()).run()
        assertEquals("nothing left to walk", listOf("start", "start"), server.calls)
    }

    // R5 — AN APPEND 404 AFTER THE START ANSWERED IS THE WORKOUT GONE FROM THE LOG, discarded from
    // another surface between the two calls: said once under the session's name, forgotten, and
    // never re-sent against an id the log will never know again.
    @Test
    fun testAnAppend404AfterTheStartAnsweredIsTheWorkoutGoneAndIsSaidOnce() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        server.onAppend = { server.stored.remove("ses_1") }

        val outcome = ClaimReplay(server, localLog, queue(), settings()).run()

        assertEquals(listOf("start", "append"), server.calls)
        assertEquals(Outcome(
            said = listOf(RefusedClaim("ses_1", "workout · ${Readout.date(1_000)}", "that workout is no longer on the log")),
            liveLanded = true, retryable = false), outcome)
        assertTrue(localLog.finished.isEmpty())
    }
}
