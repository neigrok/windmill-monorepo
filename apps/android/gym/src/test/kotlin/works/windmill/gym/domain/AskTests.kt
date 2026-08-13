package works.windmill.gym.domain

import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.platform.net.WindmillJson

// THE RULES A CHAT OVER A LOG HAS TO GET RIGHT, with no screen around them: what may be sent at all,
// the receipt that makes an answer checkable, and what a question the room went down under says.
//
// THE COMPOSING RULES THAT USED TO BE HERE ARE GONE WITH THE CODE THEY TESTED. W7 built Ask stateless
// — the client re-sent the whole alternating thread on every question — and §O reverses it: the log
// keeps the turns and assembles the prompt from them, so one question goes out against a thread id
// this phone minted. What a stored conversation is and how it is drawn are ThreadTests'.

class AskTests {
    private fun answered(question: String, said: String) =
        AskExchange(question = question, answer = AskAnswer(answer = said, read = ReadTally()))


    // THE DAILY LIMIT IS SAID BEFORE IT IS MET. Ask is the first thing in this product with a cost
    // per use, so the cap is a fact a lifter reads in the opening chrome — in the server's own
    // numbers, so the sentence read before and the 429 read after cannot disagree — and nothing is
    // sold against it, because there is nothing in this product to buy.
    @Test
    fun theDailyLimitIsStatedInTheOpeningChromeAndNotOnlyInTheRefusal() {
        assertEquals(
            "It answers about ten questions a day, three back to back — the cap that keeps Ask " +
                "open to everyone. There is nothing to buy here.",
            Ask.dailyCap,
        )
    }

    // Asked before the send rather than after the refusal: a blank question is not a question, and
    // one over the ceiling is a question the log will not take.
    @Test
    fun theDoorIsShutOnABlankQuestionAndOnOneOverTheCeiling() {
        assertFalse(Ask.sendable("   "))
        assertTrue(Ask.sendable("what's stalled?"))
        assertTrue(Ask.sendable("x".repeat(Ask.maxTurnBytes)))
        assertFalse(Ask.sendable("x".repeat(Ask.maxTurnBytes + 1)))
        assertEquals("the ceiling is bytes, not characters",
            false, Ask.sendable("é".repeat(Ask.maxTurnBytes / 2 + 1)))
    }


    // THE RECEIPT, AND IT IS THE SERVER'S NUMBER SPELLED — never a number this room worked out. The
    // design's own order, and a bucket at zero is left out rather than drawn: "0 weeks" reads as a
    // claim about the log when it is a fact about the question.
    @Test
    fun theReceiptSpellsWhatWasServedAndLeavesOutWhatWasNot() {
        assertEquals("read 214 sets · 12 weeks · 34 sessions",
            Ask.receipt(ReadTally(sets = 214, sessions = 34, weeks = 12)))
        assertEquals("read 1 set · 1 week · 1 session",
            Ask.receipt(ReadTally(sets = 1, sessions = 1, weeks = 1)))
        assertEquals("read 34 sessions", Ask.receipt(ReadTally(sessions = 34)))
    }

    // An answer standing on no rows at all is the strongest fact on the screen, so it is said in
    // words rather than left as a blank line the eye slides past.
    @Test
    fun anAnswerThatReadNothingSaysSo() {
        assertEquals("read nothing from your log", Ask.receipt(ReadTally()))
        assertFalse(ReadTally().anything)
        assertTrue(ReadTally(weeks = 1).anything)
    }

    // WHAT THE ANSWER WAS STEERED BY, in the tools' own MCP names — the names a lifter's own Claude
    // sees over the other door. A read that came back empty-handed says so beside its own name,
    // because it changes how much of the answer above it stands.
    @Test
    fun aStepIsNamedAsTheCatalogNamesItAndAFailedOneSaysSo() {
        assertEquals("list_sessions", AskStep("list_sessions").line)
        assertEquals("get_stats · no answer", AskStep("get_stats", failed = true).line)
    }

    // A STEP IS A NAME, so a step with no name is not one. Defaulted to the empty string it would
    // draw as a blank row under an answer, or as a bare " · no answer" — a tool call the lifter is
    // shown and cannot identify. Required, the reply fails the read and the room says nobody
    // answered, which is the same rule the receipt above lives under and the same one the iOS room
    // decodes this field by.
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

    // WHOSE THREAD THIS IS, and the frame that made the naive answer wrong. `/v1/me` has not
    // answered on the first pass of every launch — the one after an activity recreation included,
    // where the saved thread is already back — so a null seat there is the app not knowing yet and
    // never a different lifter. Read as a change, it would empty the conversation on every restart
    // and make the saver, the interrupted question and its retry unreachable code.
    @Test
    fun aSeatNobodyHasReadYetIsNotAChangeOfLifter() {
        assertFalse("the frame before /v1/me answers, with u1's thread restored",
            Ask.handedOver("u1", standing = null, known = false))
        assertFalse("and then it answers, and it is the same lifter",
            Ask.handedOver("u1", standing = "u1", known = false))
        assertFalse("nobody has ever signed in on this install",
            Ask.handedOver("", standing = null, known = false))
    }

    // AND THE HAZARD THE RULE EXISTS FOR IS STILL CLOSED. Once the room has met the lifter, an empty
    // seat is a real sign-out and a different id is a different person — both take the thread, which
    // is somebody's own training read out loud.
    @Test
    fun aSeatTheRoomHasReadTakesTheThreadWithIt() {
        assertTrue("signed out with the room already standing",
            Ask.handedOver("u1", standing = null, known = true))
        assertTrue("somebody else signed in", Ask.handedOver("u1", standing = "u2", known = false))
        assertTrue("and the first sign-in of a room that opened anonymous",
            Ask.handedOver("", standing = "u1", known = false))
    }

    // THE RECEIPT IS NOT OPTIONAL. A body with no `read` in it is not an answer this room may draw:
    // defaulted to zeros it would print "read nothing from your log", which is a claim ABOUT THE LOG
    // made out of a missing field. Required, the parse fails and the room says nobody answered.
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

    // THE CONVERSATION THROUGH AN ACTIVITY RECREATION. The LOG keeps the turns now (§O), but it does
    // not keep what a receipt, a tool step or a failed question were as they happened — none of them
    // is on the threads read — so the evening in progress is still held in memory and saved as JSON,
    // and this is that round trip.
    //
    // The `encodeDefaults` landmine bites from BOTH sides here: a receipt equal to its default would
    // be omitted on the way out and unreadable on the way back, so `read` carries no default and is
    // written even when it is all zeros. That is asserted rather than described.
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

    // A QUESTION THE ACTIVITY WENT DOWN UNDER. The thread is saved and the request is not, so a
    // rotation mid-answer restores a question with nothing under it — and left alone it would sit
    // there un-retryable for the life of the install, the one way this room could lose something a
    // lifter typed. It comes back as the silence it is, with the retry.
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
