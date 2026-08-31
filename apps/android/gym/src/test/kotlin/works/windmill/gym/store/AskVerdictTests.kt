package works.windmill.gym.store

import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.domain.AskCap

private fun refusal(status: Int, code: String? = null, message: String? = null) =
    RefusalFacts(status = status, code = code, sentence = message)

class AskVerdictTests {
    // BOTH 429s take the composer down, because the one unrationed way on — the connect door — is
    // drawn in that state and nowhere else. Which ceiling it was rides along, told apart by the CODE,
    // and the two wordless fallbacks never say the same thing.
    @Test
    fun testBothCeilingsTakeTheComposerDownWithTheirOwnSentenceAndNeitherIsRetried() {
        assertEquals(
            AskVerdict.Capped("the next question frees up in a couple of hours", AskCap.Daily),
            AskVerdict.refusing(refusal(429, code = "ask-daily-limit",
                message = "the next question frees up in a couple of hours")),
        )
        assertEquals("a wordless cap still says what to do next",
            AskVerdict.Capped("The next question frees up in a couple of hours.", AskCap.Daily),
            AskVerdict.refusing(refusal(429, code = "ask-daily-limit")))
        assertEquals(
            AskVerdict.Capped("this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on", AskCap.Ceiling),
            AskVerdict.refusing(refusal(429, code = "ask-out-of-budget",
                message = "this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on")),
        )
        assertEquals("a wordless ceiling may never borrow the daily bucket's sentence",
            AskVerdict.Capped(
                "This account has reached its AI ceiling for the last 30 days. Coach will answer " +
                    "again as that window rolls on.",
                AskCap.Ceiling,
            ),
            AskVerdict.refusing(refusal(429, code = "ask-out-of-budget")))
    }

    @Test
    fun testAFullConversationIsAnsweredByANewOneAndTheCeilingSaysFour() {
        assertEquals(
            AskVerdict.Fresh("this conversation holds four questions — start a new one"),
            AskVerdict.refusing(refusal(409, code = "ask-thread-full",
                message = "this conversation holds four questions — start a new one")),
        )
        assertEquals(AskVerdict.Fresh("This conversation holds four questions. Start a new one."),
            AskVerdict.refusing(refusal(409, code = "ask-thread-full")))
        assertEquals(
            AskVerdict.Fresh("that conversation id is already in use — start a new one"),
            AskVerdict.refusing(refusal(409, code = "ask-thread-taken",
                message = "that conversation id is already in use — start a new one")),
        )
    }

    @Test
    fun testAWorkoutStillOpenIsAnAnswerAndNotAFailure() {
        assertEquals(
            AskVerdict.Said("finish your workout first — Coach reads a log that has stopped moving"),
            AskVerdict.refusing(refusal(409, code = "ask-session-open",
                message = "finish your workout first — Coach reads a log that has stopped moving")),
        )
    }

    @Test
    fun testABare404IsTheFeatureBeingAbsentAndNotAnError() {
        assertEquals(AskVerdict.Absent, AskVerdict.refusing(refusal(404)))
        assertEquals(AskVerdict.Absent, AskVerdict.refusing(refusal(404, message = "not found")))
    }

    @Test
    fun testOnlyALogThatWentQuietIsWorthAnotherTap() {
        assertEquals(AskVerdict.Again("Coach didn’t answer. Try again in a moment"),
            AskVerdict.refusing(RefusalFacts(offline = true)))
        assertEquals(AskVerdict.Again("Coach didn’t answer. Try again in a moment"),
            AskVerdict.refusing(RefusalFacts(malformed = true)))
        assertEquals(AskVerdict.Again("Coach didn’t answer. Try again in a moment"),
            AskVerdict.refusing(RefusalFacts()))
        assertEquals(AskVerdict.Again("Coach didn’t answer. Try again in a moment"),
            AskVerdict.refusing(refusal(502, message = "Coach didn’t answer. Try again in a moment")))
    }

    @Test
    fun testATerminalRefusalCarriesTheLogsOwnSentence() {
        assertEquals(AskVerdict.Said("that isn’t a conversation Coach can answer"),
            AskVerdict.refusing(refusal(400, message = "that isn’t a conversation Coach can answer")))
        assertEquals(AskVerdict.Said("sign in to open your training log"),
            AskVerdict.refusing(refusal(401, message = "sign in to open your training log")))
        assertEquals("a refusal that arrived wordless still says something true",
            AskVerdict.Said("Coach couldn’t take that one"), AskVerdict.refusing(refusal(400)))
    }
}
