package works.windmill.gym.domain

import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.platform.net.WindmillJson

// THE RULES A CHAT OVER A LOG HAS TO GET RIGHT, with no screen around them: the shape of the thread
// the server will accept, the ceiling on one turn, and the receipt that makes an answer checkable.
//
// The server keeps NO conversation, so the whole thread goes out every time — which makes composing
// it the client's job and these the tests that stand behind it. A thread that is not alternating,
// not lifter-first, not lifter-last, or one byte over the ceiling is refused outright, and a lifter
// would meet that as a question that vanished.

class AskTests {
    private fun answered(question: String, said: String) =
        AskExchange(question = question, answer = AskAnswer(answer = said, read = ReadTally()))

    // Alternating, lifter-first, lifter-last, and inside the ceiling. Seven and not eight: the wire
    // takes eight turns, but a conversation that begins and ends with the lifter can only be an odd
    // number of them, so the real ceiling is three answered exchanges and the question in hand.
    @Test
    fun theThreadAlternatesAndBeginsAndEndsWithTheLifter() {
        val settled = listOf(
            answered("what's stalled?", "bench, three weeks."),
            answered("why?", "the last set is where it goes."),
            answered("and squat?", "still moving."),
        )

        val turns = Ask.thread(settled, "write the triples block")

        assertEquals(
            listOf(
                AskTurn("lifter", "what's stalled?"),
                AskTurn("ask", "bench, three weeks."),
                AskTurn("lifter", "why?"),
                AskTurn("ask", "the last set is where it goes."),
                AskTurn("lifter", "and squat?"),
                AskTurn("ask", "still moving."),
                AskTurn("lifter", "write the triples block"),
            ),
            turns,
        )
        assertEquals(Ask.maxTurns, turns.size)
    }

    // The oldest go, because a conversation is about where it has got to — and Ask re-reads the log
    // on every turn, so context dropped here is context it can fetch again.
    @Test
    fun theOldestExchangesAreTheOnesDropped() {
        val settled = (1..5).map { answered("q$it", "a$it") }

        val turns = Ask.thread(settled, "and now?")

        assertEquals(
            listOf("q3", "a3", "q4", "a4", "q5", "a5", "and now?"),
            turns.map { it.text },
        )
    }

    // AN EXCHANGE THAT NEVER GOT AN ANSWER IS NOT CARRIED. It has a question and no reply, and
    // putting it in would break the alternation the whole shape rests on — the server refuses the
    // thread, and the lifter loses a question that was on screen.
    @Test
    fun aQuestionThatWasNeverAnsweredIsNotCarriedAsContext() {
        val settled = listOf(
            answered("what's stalled?", "bench, three weeks."),
            AskExchange(question = "why?", trouble = "Ask didn't answer. Try again in a moment", again = true),
        )

        val turns = Ask.thread(settled, "why?")

        assertEquals(listOf("what's stalled?", "bench, three weeks.", "why?"), turns.map { it.text })
        assertEquals(listOf("lifter", "ask", "lifter"), turns.map { it.from })
    }

    // THE CEILING IS PER TURN AND THE SERVER REFUSES THE WHOLE THREAD OVER ONE TURN THAT BREAKS IT,
    // so BOTH sides of a carried exchange are held to it — an oversized answer, and an oversized
    // question from an older build or a seed nobody typed, would each kill the question being asked
    // now over bytes from three questions ago.
    //
    // THE LIVE QUESTION IS THE ONE THING NEVER CLIPPED: what a lifter just typed goes as typed, and
    // the log's own refusal is a better answer than a question sent in words they did not write.
    @Test
    fun bothSidesOfACarriedExchangeAreClippedAndTheLiveQuestionIsNot() {
        val longAnswer = "x".repeat(Ask.maxTurnBytes * 2)
        val longQuestion = "q".repeat(Ask.maxTurnBytes * 2)
        val asking = "y".repeat(Ask.maxTurnBytes)

        val turns = Ask.thread(listOf(answered(longQuestion, longAnswer)), asking)

        assertEquals(Ask.maxTurnBytes, turns[0].text.toByteArray(Charsets.UTF_8).size)
        assertTrue(turns[0].text.endsWith("…"))
        assertEquals(Ask.maxTurnBytes, turns[1].text.toByteArray(Charsets.UTF_8).size)
        assertTrue(turns[1].text.endsWith("…"))
        assertEquals(asking, turns[2].text)
    }

    // The ceiling is BYTES and the text is UTF-8, so the cut lands on a character boundary: a cut
    // through the middle of a two-byte letter is a sequence no reader can decode.
    @Test
    fun clippingCutsWholeCharactersAndNeverBytes() {
        val clipped = Ask.clipped("é".repeat(600))

        assertTrue(clipped.toByteArray(Charsets.UTF_8).size <= Ask.maxTurnBytes)
        assertEquals("…", clipped.takeLast(1))
        assertTrue(clipped.dropLast(1).all { it == 'é' })
        assertEquals("nothing that fits is touched", "short", Ask.clipped("short"))
    }

    // A CLIP NEVER HANDS BACK MORE THAN IT WAS ASKED FOR, which is the whole promise of the word. A
    // budget too small to hold the mark keeps nothing rather than returning the mark alone — three
    // bytes where two were the ceiling is the one failure a byte ceiling may not have.
    @Test
    fun aClipNeverReturnsMoreThanTheBudget() {
        assertEquals("", Ask.clipped("abcdef", 2))
        assertEquals("", Ask.clipped("abcdef", 3))
        assertEquals("a…", Ask.clipped("abcdef", 4))
        assertTrue((0..8).all { Ask.clipped("abcdef", it).toByteArray(Charsets.UTF_8).size <= it })
    }

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

    // THE LANDMINE THIS FILE EXISTS TO KEEP CLOSED. The app's one Json omits any value equal to its
    // declared default, so a `from` with a default would travel as an absent key and every turn
    // would be refused as malformed — a whole feature dead on a field nobody typed.
    @Test
    fun everyTurnCarriesItsSpeakerOnTheWire() {
        val encoded = WindmillJson.encodeToString(
            AskThread.serializer(),
            AskThread(listOf(AskTurn("lifter", "what's stalled?"))),
        )

        assertEquals("""{"turns":[{"from":"lifter","text":"what's stalled?"}]}""", encoded)
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

    // THE CONVERSATION THROUGH AN ACTIVITY RECREATION. A thread is the one thing in this room that
    // exists nowhere but in memory — the log is on disk and on the account, and the server keeps no
    // conversation at all — so the room saves it as JSON, and this is that round trip.
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
