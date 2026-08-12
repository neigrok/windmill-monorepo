package works.windmill.gym.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.gym.domain.TrainingSet

// Refusals as the wire delivers them — a sentence for a human under "error", and, for the reasons
// a client must branch on, a machine word under "code". The tests below deliberately reword the
// sentences: the code is the contract and nothing here may read English to decide what to do.
private fun refusal(status: Int, code: String? = null, message: String) =
    RefusalFacts(status = status, code = code, sentence = message)

private val storageFailure = refusal(500, message = "internal error")

// The four verdicts, derived from the status and the machine word and NEVER from the sentence. The
// wording is copy and may be edited any day; a queue that string-compared it would degrade to
// "terminal, reason unknown" the first time one was reworded — and drop a set it should have
// minted a fresh id for.
class VerdictTests {
    @Test
    fun testTheTwoSpentIdRefusalsAskForAFreshIdWhateverTheySay() {
        assertEquals(Verdict.Remint("anything at all"),
            Verdict.refusing(refusal(409, code = "set-id-taken", message = "anything at all")))
        assertEquals(Verdict.Remint("anything at all"),
            Verdict.refusing(refusal(409, code = "session-id-taken", message = "anything at all")))
    }

    @Test
    fun testAClosedSessionDropsTheSetForeverAndCarriesASentenceToSay() {
        assertEquals(Verdict.Dropped("the session closed before this set reached it"),
            Verdict.refusing(refusal(409, code = "session-finished", message = "reworded")))
        assertNotNull(Verdict.refusing(refusal(409, code = "session-finished", message = "reworded"))
            .terminalReason(afterRemints = 0))
    }

    @Test
    fun testAStorageFailureAndATransportFailureAreBothRetries() {
        assertEquals(Verdict.Retry, Verdict.refusing(storageFailure))
        assertEquals(Verdict.Retry, Verdict.refusing(RefusalFacts(offline = true)))
        assertEquals(Verdict.Retry, Verdict.refusing(RefusalFacts(malformed = true)))
        assertEquals("no reply at all is only waiting",
            Verdict.Retry, Verdict.refusing(RefusalFacts()))
        assertNull(Verdict.refusing(RefusalFacts(offline = true)).terminalReason(afterRemints = 0))
    }

    // 401 waits for a sign-in and 404 for a session to exist. Terminal and retryable never both
    // hold, and neither follows from the other's absence — reading "not retryable" as "lost"
    // throws away a set that was only waiting for the session secret to come back.
    @Test
    fun testASetWaitingForASignInIsNeitherLostNorRefused() {
        assertEquals(Verdict.Retry,
            Verdict.refusing(refusal(401, message = "sign in to open your training log")))
        assertEquals(Verdict.Retry, Verdict.refusing(refusal(404, message = "no such session")))
    }

    @Test
    fun testAnUnreadableBodyIsTerminalBecauseRetryingNeverMakesItReadable() {
        assertEquals(Verdict.Refused("that movement is not in the catalog"),
            Verdict.refusing(refusal(400, code = "unknown-exercise", message = "no such exercise")))
        assertEquals(Verdict.Refused("could not read that set"),
            Verdict.refusing(refusal(400, message = "could not read that set")))
    }

    @Test
    fun testARefusalThatArrivedWithoutASentenceStillHasOneToSay() {
        assertEquals(Verdict.Refused("the log refused this set"),
            Verdict.refusing(RefusalFacts(status = 400)))
    }

    // The repair budget is its own counter, and it is bounded: a collision that keeps happening is
    // not a coincidence, and re-minting forever would hammer the log instead of telling the lifter.
    @Test
    fun testTheIdRepairBudgetRunsOutAndThenTheSetIsSaid() {
        val verdict = Verdict.refusing(
            refusal(409, code = "set-id-taken", message = "that set id is already used"))
        assertNull(verdict.terminalReason(afterRemints = SetQueue.maxRemints - 1))
        assertEquals("that set id is already used",
            verdict.terminalReason(afterRemints = SetQueue.maxRemints))
    }

    // How a write reports itself, to the word. These lines are mirrored BY HAND across surfaces —
    // nothing checks them, so the test does.
    @Test
    fun testTheSaveLinesAreExactAndSilenceIsAState() {
        assertNull(SaveState.Idle.line)
        assertEquals("on the log", SaveState.OnTheLog.line)
        assertEquals("saved on this device", SaveState.OnThisDevice.line)
        assertEquals("offline · saved here", SaveState.Offline.line)
        assertEquals("the log's own words, never a paraphrase",
            "no such routine", SaveState.Refused("no such routine").line)
    }

    // §G18'S OWN WORD, and it is a different question from the four above: those ask whether a set
    // will ever land, this asks what happened to a row that is already there. Told apart by `code`
    // for the same reason — the sentence is copy and may be reworded any day.
    @Test
    fun testAFixMeetingARowTheLogDoesNotHoldIsGoneAndNotRetryable() {
        assertEquals("absent, another account's, already deleted, or a set in a different workout — " +
            "one answer, and the screen drops the row rather than offering a retry onto nothing",
            FixVerdict.Gone("that set is no longer on the log"),
            FixVerdict.refusing(refusal(404, code = "set-not-found", message = "reworded on a Tuesday")))
        assertEquals("a 404 with no word on it is still the route saying it has no such row",
            FixVerdict.Gone("that set is no longer on the log"),
            FixVerdict.refusing(refusal(404, message = "no such set")))
    }

    @Test
    fun testAFixTheLogCannotReadIsTerminalAndKeepsTheRowStanding() {
        assertEquals(FixVerdict.Unwritable("could not read that fix"),
            FixVerdict.refusing(refusal(400, code = "fix-unreadable", message = "could not read that fix")))
        assertEquals(FixVerdict.Unwritable("the log refused this fix"),
            FixVerdict.refusing(RefusalFacts(status = 400)))
    }

    // A 5xx is the server's, a 401 wants a sign-in, and no reply at all is not an answer. None of
    // the three has cost the correction anything, so none of them may be said as a loss.
    @Test
    fun testEverythingElseIsOnlyWaiting() {
        assertEquals(FixVerdict.Retry, FixVerdict.refusing(storageFailure))
        assertEquals(FixVerdict.Retry, FixVerdict.refusing(RefusalFacts(offline = true)))
        assertEquals(FixVerdict.Retry, FixVerdict.refusing(RefusalFacts(malformed = true)))
        assertEquals(FixVerdict.Retry, FixVerdict.refusing(RefusalFacts()))
        assertEquals(FixVerdict.Retry,
            FixVerdict.refusing(refusal(401, message = "sign in to open your training log")))
    }

    // The server publishes no `session-finished` on either route — corrections are allowed after
    // the workout ends — so nothing here may branch on one. A 409 that arrived anyway is the
    // client's own and terminal, exactly as an unreadable body is.
    @Test
    fun testAFinishedSessionIsNotARefusalThisVocabularyKnows() {
        assertEquals(FixVerdict.Unwritable("reworded"),
            FixVerdict.refusing(refusal(409, code = "session-finished", message = "reworded")))
    }

    // The movement and the numbers travel with the reason because a RefusedSet is the LAST COPY of
    // a set somebody lifted.
    @Test
    fun testARefusedSetCarriesTheMovementAndTheNumbersWithTheReason() {
        val set = TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5, reps = 8,
            completedAtMs = 1_000)
        assertEquals(
            RefusedSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5, reps = 8,
                reason = "the session closed before this set reached it"),
            RefusedSet(set, "the session closed before this set reached it"))
    }
}
