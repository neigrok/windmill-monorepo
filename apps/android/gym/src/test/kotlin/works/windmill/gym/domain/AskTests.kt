package works.windmill.gym.domain

import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.platform.net.WindmillJson

class AskTests {
    private fun answered(question: String, said: String) =
        AskExchange(question = question, answer = AskAnswer(answer = said, read = ReadTally()))


    @Test
    fun theDailyLimitIsStatedInTheOpeningChromeAndNotOnlyInTheRefusal() {
        assertEquals(
            "It answers about ten questions a day, three back to back — the cap that keeps Ask " +
                "open to everyone. There is nothing to buy here.",
            Ask.dailyCap,
        )
    }

    @Test
    fun theDoorIsShutOnABlankQuestionAndOnOneOverTheCeiling() {
        assertFalse(Ask.sendable("   "))
        assertTrue(Ask.sendable("what's stalled?"))
        assertTrue(Ask.sendable("x".repeat(Ask.maxTurnBytes)))
        assertFalse(Ask.sendable("x".repeat(Ask.maxTurnBytes + 1)))
        assertEquals("the ceiling is bytes, not characters",
            false, Ask.sendable("é".repeat(Ask.maxTurnBytes / 2 + 1)))
    }


    @Test
    fun theReceiptSpellsWhatWasServedAndLeavesOutWhatWasNot() {
        assertEquals("read 214 sets · 12 weeks · 34 sessions",
            Ask.receipt(ReadTally(sets = 214, sessions = 34, weeks = 12)))
        assertEquals("read 1 set · 1 week · 1 session",
            Ask.receipt(ReadTally(sets = 1, sessions = 1, weeks = 1)))
        assertEquals("read 34 sessions", Ask.receipt(ReadTally(sessions = 34)))
    }

    @Test
    fun anAnswerThatReadNothingSaysSo() {
        assertEquals("read nothing from your log", Ask.receipt(ReadTally()))
        assertFalse(ReadTally().anything)
        assertTrue(ReadTally(weeks = 1).anything)
    }

    @Test
    fun aStepIsNamedAsTheCatalogNamesItAndAFailedOneSaysSo() {
        assertEquals("list_sessions", AskStep("list_sessions").line)
        assertEquals("get_stats · no answer", AskStep("get_stats", failed = true).line)
    }

    @Test
    fun aStepWithNoNameIsNotAStep() {
        assertEquals(
            listOf(AskStep("get_stats"), AskStep("last_time", failed = true)),
            WindmillJson.decodeFromString(
                AskAnswer.serializer(),
                """{"answer":"bench is flat.","read":{"sets":1,"sessions":1,"weeks":1},""" +
                    """"steps":[{"tool":"get_stats"},{"tool":"last_time","failed":true}]}""",
            ).steps,
        )

        assertThrows(SerializationException::class.java) {
            WindmillJson.decodeFromString(
                AskAnswer.serializer(),
                """{"answer":"a","read":{"sets":1,"sessions":1,"weeks":1},"steps":[{"failed":true}]}""",
            )
        }
    }

    @Test
    fun aSeatNobodyHasReadYetIsNotAChangeOfLifter() {
        assertFalse("the frame before /v1/me answers, with u1's thread restored",
            Ask.handedOver("u1", standing = null, known = false))
        assertFalse("and then it answers, and it is the same lifter",
            Ask.handedOver("u1", standing = "u1", known = false))
        assertFalse("nobody has ever signed in on this install",
            Ask.handedOver("", standing = null, known = false))
    }

    @Test
    fun aSeatTheRoomHasReadTakesTheThreadWithIt() {
        assertTrue("signed out with the room already standing",
            Ask.handedOver("u1", standing = null, known = true))
        assertTrue("somebody else signed in", Ask.handedOver("u1", standing = "u2", known = false))
        assertTrue("and the first sign-in of a room that opened anonymous",
            Ask.handedOver("", standing = "u1", known = false))
    }

    @Test
    fun anAnswerWithNoReceiptIsNotAnAnswer() {
        val whole = """{"answer":"bench is flat.","read":{"sets":214,"sessions":34,"weeks":12}}"""
        assertEquals(
            AskAnswer(answer = "bench is flat.", read = ReadTally(sets = 214, sessions = 34, weeks = 12)),
            WindmillJson.decodeFromString(AskAnswer.serializer(), whole),
        )

        assertThrows(SerializationException::class.java) {
            WindmillJson.decodeFromString(AskAnswer.serializer(), """{"answer":"bench is flat."}""")
        }
    }

    @Test
    fun aThreadSurvivesBeingWrittenOutAndReadBack() {
        val thread = listOf(
            AskExchange(
                question = "what's stalled?",
                answer = AskAnswer(
                    answer = "bench, three weeks.",
                    read = ReadTally(sets = 214, sessions = 34, weeks = 12),
                    steps = listOf(AskStep("get_stats"), AskStep("last_time", failed = true)),
                    proposals = listOf("prop_0a1b2c3d"),
                ),
            ),
            AskExchange(question = "why?", trouble = Ask.interrupted, again = true),
        )
        val serializer = ListSerializer(AskExchange.serializer())

        val written = WindmillJson.encodeToString(serializer, thread)

        assertTrue("a receipt of zeros still travels", WindmillJson.encodeToString(
            serializer, listOf(AskExchange(question = "q", answer = AskAnswer("a", ReadTally()))),
        ).contains("\"read\""))
        assertEquals(thread, WindmillJson.decodeFromString(serializer, written))
    }

    @Test
    fun aQuestionTheRoomWasTornDownUnderComesBackRetryable() {
        val thread = listOf(
            answered("what's stalled?", "bench, three weeks."),
            AskExchange(question = "why?"),
        )

        val settled = Ask.settled(thread)

        assertEquals(
            listOf(
                answered("what's stalled?", "bench, three weeks."),
                AskExchange(question = "why?", trouble = Ask.interrupted, again = true),
            ),
            settled,
        )
        assertTrue("a thread with nothing pending is handed back untouched",
            Ask.settled(settled) === settled)
    }
}
