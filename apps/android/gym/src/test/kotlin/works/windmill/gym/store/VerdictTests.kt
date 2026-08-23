package works.windmill.gym.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.TrainingSet

private fun refusal(status: Int, code: String? = null, message: String) =
    RefusalFacts(status = status, code = code, sentence = message)

private val storageFailure = refusal(500, message = "internal error")

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

    @Test
    fun testTheIdRepairBudgetRunsOutAndThenTheSetIsSaid() {
        val verdict = Verdict.refusing(
            refusal(409, code = "set-id-taken", message = "that set id is already used"))
        assertNull(verdict.terminalReason(afterRemints = SetQueue.maxRemints - 1))
        assertEquals("that set id is already used",
            verdict.terminalReason(afterRemints = SetQueue.maxRemints))
    }

    @Test
    fun testTheSaveLinesAreExactAndSilenceIsAState() {
        assertNull(SaveState.Idle.line)
        assertEquals("on the log", SaveState.OnTheLog.line)
        assertEquals("saved on this device", SaveState.OnThisDevice.line)
        assertEquals("offline · saved here", SaveState.Blocked(Blocker.Offline).line)
        assertEquals("the log’s own trouble is not a missing signal",
            "the log didn’t answer · saved here", SaveState.Blocked(Blocker.LogFailed).line)
        assertEquals("sign in again · saved here", SaveState.Blocked(Blocker.SignInLapsed).line)
        assertEquals("the log's own words, never a paraphrase",
            "no such routine", SaveState.Refused("no such routine").line)
    }

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

    @Test
    fun testEverythingElseIsOnlyWaiting() {
        assertEquals(FixVerdict.Retry, FixVerdict.refusing(storageFailure))
        assertEquals(FixVerdict.Retry, FixVerdict.refusing(RefusalFacts(offline = true)))
        assertEquals(FixVerdict.Retry, FixVerdict.refusing(RefusalFacts(malformed = true)))
        assertEquals(FixVerdict.Retry, FixVerdict.refusing(RefusalFacts()))
        assertEquals(FixVerdict.Retry,
            FixVerdict.refusing(refusal(401, message = "sign in to open your training log")))
    }

    @Test
    fun testAFinishedSessionIsNotARefusalThisVocabularyKnows() {
        assertEquals(FixVerdict.Unwritable("reworded"),
            FixVerdict.refusing(refusal(409, code = "session-finished", message = "reworded")))
    }

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
