package works.windmill.gym.store

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.TrainingSet
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException

class WriteOutcomeTests {
    @Test
    fun testARefusalCarriesTheLogsSentenceAndEverythingElseIsNoAnswer() {
        assertEquals(WriteFailure.Refused("That workout has finished."),
            WriteFailure(TrainingRefused("session-finished", "That workout has finished.")))
        assertEquals(WriteFailure.Refused("no such share"),
            WriteFailure(WindmillApiException.Refused(404, Refusal(message = "no such share"))))
        assertEquals(WriteFailure.NoAnswer, WriteFailure(TrainingUnanswered))
        assertEquals(WriteFailure.NoAnswer, WriteFailure(WindmillApiException.Offline))
        assertEquals(WriteFailure.NoAnswer, WriteFailure(IOException("offline")))
        assertEquals("the log didn’t answer — the session is still open",
            WriteFailure.NoAnswer.line("the session is still open"))
        assertEquals("no such share", WriteFailure.Refused("no such share").line("unused"))
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
    fun testARefusedSetCarriesTheMovementAndTheNumbersWithTheReason() {
        val set = TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5, reps = 8,
            completedAtMs = 1_000)
        assertEquals(
            RefusedSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5, reps = 8,
                reason = "the session closed before this set reached it"),
            RefusedSet(set, "the session closed before this set reached it"))
    }
}
