package works.windmill.gym.store

import androidx.test.core.app.ApplicationProvider
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.R
import works.windmill.gym.presentation.Blocker
import works.windmill.gym.presentation.TrainingSet
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.text
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WriteOutcomeTests {
    @Test
    fun testARefusalCarriesTheLogsSentenceAndEverythingElseIsNoAnswer() {
        assertEquals(WriteFailure.Refused(Words.Plain("That workout has finished.")),
            WriteFailure(TrainingRefused("session-finished", Words.Plain("That workout has finished."))))
        assertEquals(WriteFailure.Refused(Words.Plain("no such share")),
            WriteFailure(WindmillApiException.Refused(404, Refusal(message = "no such share"))))
        assertEquals(WriteFailure.NoAnswer, WriteFailure(TrainingUnanswered))
        assertEquals(WriteFailure.NoAnswer, WriteFailure(WindmillApiException.Offline))
        assertEquals(WriteFailure.NoAnswer, WriteFailure(IOException("offline")))
        assertEquals("the log didn’t answer — the session is still open",
            WriteFailure.NoAnswer.says(R.string.gym_room_finish_no_answer).spelled())
        assertEquals("no such share", WriteFailure.Refused(Words.Plain("no such share")).says(R.string.gym_room_finish_no_answer).spelled())
    }

    @Test
    fun testTheSaveLinesAreExactAndSilenceIsAState() {
        assertNull(SaveState.Idle.words)
        assertEquals("on the log", SaveState.OnTheLog.words.spelled())
        assertEquals("saved on this device", SaveState.OnThisDevice.words.spelled())
        assertEquals("offline · saved here", SaveState.Blocked(Blocker.Offline).words.spelled())
        assertEquals("the log’s own trouble is not a missing signal",
            "the log didn’t answer · saved here", SaveState.Blocked(Blocker.LogFailed).words.spelled())
        assertEquals("sign in again · saved here", SaveState.Blocked(Blocker.SignInLapsed).words.spelled())
        assertEquals("the log's own words, never a paraphrase",
            "no such routine", SaveState.Refused(Words.Plain("no such routine")).words.spelled())
    }

    @Test
    fun testARefusedSetCarriesTheMovementAndTheNumbersWithTheReason() {
        val set = TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5, reps = 8,
            completedAtMs = 1_000)
        assertEquals(
            RefusedSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5, reps = 8,
                why = Words.Plain("the session closed before this set reached it")),
            RefusedSet(set, Words.Plain("the session closed before this set reached it")))
    }
}

private fun Words?.spelled(): String? = this?.text(ApplicationProvider.getApplicationContext())
