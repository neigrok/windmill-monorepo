package works.windmill.gym.store

import org.junit.Assert.assertEquals
import org.junit.Test

private fun refusal(status: Int, code: String? = null, message: String? = null) =
    RefusalFacts(status = status, code = code, sentence = message)

class AskVerdictTests {
    @Test
    fun testTheDailyCapAndTheAiCeilingAreBothSaidAndNeitherIsRetried() {
        assertEquals(
            AskVerdict.Said("that's Ask for now — it answers about ten questions a day"),
            AskVerdict.refusing(refusal(429, code = "ask-daily-limit",
                message = "that's Ask for now — it answers about ten questions a day")),
        )
        assertEquals(
            AskVerdict.Said("this account has reached its AI ceiling for the last 30 days"),
            AskVerdict.refusing(refusal(429, code = "ask-out-of-budget",
                message = "this account has reached its AI ceiling for the last 30 days")),
        )
    }

    @Test
    fun testAWorkoutStillOpenIsAnAnswerAndNotAFailure() {
        assertEquals(
            AskVerdict.Said("finish your workout first — Ask reads a log that has stopped moving"),
            AskVerdict.refusing(refusal(409, code = "ask-session-open",
                message = "finish your workout first — Ask reads a log that has stopped moving")),
        )
    }

    @Test
    fun testABare404IsTheFeatureBeingAbsentAndNotAnError() {
        assertEquals(AskVerdict.Absent, AskVerdict.refusing(refusal(404)))
        assertEquals(AskVerdict.Absent, AskVerdict.refusing(refusal(404, message = "not found")))
    }

    @Test
    fun testOnlyALogThatWentQuietIsWorthAnotherTap() {
        assertEquals(AskVerdict.Again("Ask didn't answer. Try again in a moment"),
            AskVerdict.refusing(RefusalFacts(offline = true)))
        assertEquals(AskVerdict.Again("Ask didn't answer. Try again in a moment"),
            AskVerdict.refusing(RefusalFacts(malformed = true)))
        assertEquals(AskVerdict.Again("Ask didn't answer. Try again in a moment"),
            AskVerdict.refusing(RefusalFacts()))
        assertEquals(AskVerdict.Again("Ask didn't answer. Try again in a moment"),
            AskVerdict.refusing(refusal(502, message = "Ask didn't answer. Try again in a moment")))
    }

    @Test
    fun testATerminalRefusalCarriesTheLogsOwnSentence() {
        assertEquals(AskVerdict.Said("that isn't a conversation Ask can answer"),
            AskVerdict.refusing(refusal(400, message = "that isn't a conversation Ask can answer")))
        assertEquals(AskVerdict.Said("sign in to open your training log"),
            AskVerdict.refusing(refusal(401, message = "sign in to open your training log")))
        assertEquals("a refusal that arrived wordless still says something true",
            AskVerdict.Said("Ask couldn't take that one"), AskVerdict.refusing(refusal(400)))
    }
}
