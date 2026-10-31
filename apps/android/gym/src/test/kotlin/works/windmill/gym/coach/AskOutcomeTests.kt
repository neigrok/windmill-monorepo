package works.windmill.gym.coach

import works.windmill.gym.store.*
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonObject

class AskOutcomeTests {
    private fun refused(status: Int, code: String? = null, message: String? = null) =
        AskOutcome.refusing(WindmillApiException.Refused(status, Refusal(message, code = code)), null)

    @Test fun allowanceCapSurvivesMissingOrMalformedTimingAndUsesOnlyItsOwn429Code() {
        for (value in listOf("null", "{}", "[]", "true", "{\"resetsAtMs\":null}", "{\"resetsAtMs\":\"1800000000000\"}",
            "{\"resetsAtMs\":-1}", "{\"resetsAtMs\":1.5}", "{\"resetsAtMs\":true}", "{\"resetsAtMs\":{}}")) {
            val wire = "{\"code\":\"subject_exhausted\",\"allowance\":" + value + "}"
            val refusal = works.windmill.platform.net.WindmillJson.decodeFromString(Refusal.serializer(), wire)
            assertEquals(AskOutcome.Capped(AskCap.Allowance.wordless, AskCap.Allowance),
                AskOutcome.refusing(WindmillApiException.Refused(429, refusal), null))
        }
        val cap = AskOutcome.refusing(WindmillApiException.Refused(429, Refusal(code = "subject_exhausted",
            allowance = JsonObject(mapOf("resetsAtMs" to JsonPrimitive(1_800_000_000_123L))))), null)
        assertEquals(AskOutcome.Capped(AskCap.Allowance.wordless, AskCap.Allowance, retryAtMs = 1_800_000_000_123L), cap)
        for (code in listOf("free_day_exhausted", "free_month_exhausted", "concurrency_exhausted", "funding_required"))
            assertEquals(AskOutcome.Refused("Server sentence", terminal = true), refused(429, code, "Server sentence"))
        assertEquals(AskOutcome.Refused("Server sentence", terminal = true), refused(403, "subject_exhausted", "Server sentence"))
    }

    @Test
    fun capsKeepDistinctNoticesAndMissingDailyTimingDoesNotInventAWait() {
        assertEquals(
            AskOutcome.Capped(Ask.capReached, AskCap.Daily),
            refused(429, code = "ask-daily-limit", message = "the next question frees up in a couple of hours"),
        )
        assertEquals("a wordless cap still says what to do next",
            AskOutcome.Capped(Ask.capReached, AskCap.Daily),
            refused(429, code = "ask-daily-limit"))
        assertEquals(
            AskOutcome.Capped("this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on", AskCap.Ceiling),
            refused(429, code = "ask-out-of-budget",
                message = "this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on"),
        )
        assertEquals("a wordless ceiling may never borrow the daily bucket's sentence",
            AskOutcome.Capped(
                "This account has reached its AI ceiling for the last 30 days. Coach will answer " +
                    "again as that window rolls on.",
                AskCap.Ceiling,
            ),
            refused(429, code = "ask-out-of-budget"))
    }

    @Test
    fun testAFullConversationIsAnsweredByANewOneAndTheCeilingSaysFour() {
        assertEquals(
            AskOutcome.Fresh("this conversation holds four questions — start a new one"),
            refused(409, code = "ask-thread-full", message = "this conversation holds four questions — start a new one"),
        )
        assertEquals(AskOutcome.Fresh("This conversation is unavailable. Start a new one."),
            refused(409, code = "ask-thread-full"))
        assertEquals(
            AskOutcome.Fresh("that conversation id is already in use — start a new one"),
            refused(409, code = "ask-thread-taken", message = "that conversation id is already in use — start a new one"),
        )
    }

    @Test
    fun testAWorkoutStillOpenIsAnAnswerAndNotAFailure() {
        assertEquals(
            AskOutcome.Refused("finish your workout first — Coach reads a log that has stopped moving", terminal = true),
            refused(409, code = "ask-session-open", message = "finish your workout first — Coach reads a log that has stopped moving"),
        )
    }

    @Test
    fun testABare404IsTheFeatureBeingAbsentAndNotAnError() {
        assertEquals(AskOutcome.Absent, refused(404))
        assertEquals(AskOutcome.Absent, refused(404, message = "not found"))
    }

    @Test
    fun testOnlyALogThatWentQuietIsWorthAnotherTap() {
        val quiet = AskOutcome.Failed("Coach didn’t answer. Try again in a moment")
        assertEquals(quiet, AskOutcome.refusing(WindmillApiException.Offline, null))
        assertEquals(quiet, AskOutcome.refusing(WindmillApiException.Malformed, null))
        assertEquals(quiet, AskOutcome.refusing(WindmillApiException.Transport(IOException("reset")), null))
        assertEquals(quiet, AskOutcome.refusing(IOException("offline"), null))
        assertEquals(quiet, refused(502, message = "Coach didn’t answer. Try again in a moment"))
        assertEquals(AskOutcome.Failed("Coach is answering another message. Try again when it finishes."),
            refused(409, code = "ask-generation-active"))
    }

    @Test
    fun testATerminalRefusalCarriesTheLogsOwnSentence() {
        assertEquals(AskOutcome.Refused("that isn’t a conversation Coach can answer", terminal = true),
            refused(400, message = "that isn’t a conversation Coach can answer"))
        assertEquals(AskOutcome.Refused("sign in to open your training log", terminal = true),
            refused(401, message = "sign in to open your training log"))
        assertEquals("a refusal that arrived wordless still says something true",
            AskOutcome.Refused("Coach couldn’t take that one", terminal = true), refused(400))
    }

    // The partial reply already on screen stays with every outcome that can still show it.
    @Test
    fun testTheSnapshotInHandRidesWithEveryOutcomeThatCanStillShowIt() {
        val partial = AskGeneration("generation-a", "request-a", "Question", "running", "Half an answer", revision = 2)
        fun refusing(error: Throwable) = AskOutcome.refusing(error, partial)
        assertEquals(AskOutcome.Failed("Coach didn’t answer. Try again in a moment", partial), refusing(WindmillApiException.Offline))
        assertEquals(AskOutcome.Capped(Ask.capReached, AskCap.Daily, partial),
            refusing(WindmillApiException.Refused(429, Refusal(code = "ask-daily-limit"))))
        assertEquals(AskOutcome.Refused("Coach couldn’t take that one", partial, terminal = true), refusing(WindmillApiException.Refused(400, Refusal())))
        assertEquals(AskOutcome.Fresh("This conversation is unavailable. Start a new one."),
            refusing(WindmillApiException.Refused(409, Refusal(code = "ask-thread-full"))))
        assertEquals(AskOutcome.Absent, refusing(WindmillApiException.Refused(404, Refusal())))
    }

    @Test fun dailyDeadlinePrefersActualJsonTimeThenTheDeadlineCapturedWithRetryAfter() {
        val receivedDeadline = 1_800_000_020_000L
        val actual = 1_800_000_030_000L
        for ((raw, expected) in listOf(JsonPrimitive(actual) to actual, JsonPrimitive(-1) to receivedDeadline,
            JsonPrimitive("1800000030000") to receivedDeadline, JsonPrimitive(true) to receivedDeadline, JsonObject(emptyMap()) to receivedDeadline)) {
            val outcome = AskOutcome.refusing(WindmillApiException.Refused(429,
                Refusal(code = "ask-daily-limit", retryAtMs = raw), receivedDeadline), null) as AskOutcome.Capped
            assertEquals(AskOutcome.Capped(Ask.capReached, AskCap.Daily, retryAtMs = expected), outcome)
            assertEquals(expected, outcome.exchange(AskExchange("Question")).retryAtMs)
        }
    }
}
