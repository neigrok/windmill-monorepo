package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.platform.net.WindmillJson

// §O — ASK HAS A PAST, and these are the rules a list of conversations has to get right with no
// screen around them: the title is the lifter's own words, every subtitle is something the SERVER
// observed, and nothing here is an inbox.
//
// THE ONE THE BOARD GETS WRONG is the dismissed row, drawn as `built it myself instead`. Nothing
// observes why a lifter dismissed a proposal and this product does not ask, so the line is a motive
// narrated onto somebody's evening. The test below pins what a dismissed row says instead — what was
// dismissed, and nothing about why — and there is no field on the wire a reason could even be read
// out of.

class ThreadTests {
    private fun thread(
        id: String = "thr_1",
        title: String = "Bench has been stuck at 82.5 for three weeks. What do you see?",
        askedAtMs: Long = 0,
        outcome: ThreadOutcome = ThreadOutcome(),
    ) = AskThread(id = id, title = title, createdAtMs = askedAtMs, askedAtMs = askedAtMs, outcome = outcome)

    // 4 Aug 2026 at MIDDAY UTC, and midday rather than midnight on purpose: every date below is
    // spelled in the device's own zone, and an instant near a boundary would read as 3 Aug on a
    // machine west of London and pass at home while failing in CI.
    private val august = 1_785_844_800_000L
    private val july = august - 21L * 24 * 3_600_000

    // THE TITLE IS THE FIRST MESSAGE, BYTE FOR BYTE. The whole point of the row is that it is the
    // question in the lifter's words, so nothing on this phone trims it for meaning, sentence-cases
    // it, strips its punctuation or adds any — emoji, capitals and a trailing question mark all
    // survive, because a client that improved one would be writing the summary §O refuses.
    @Test
    fun theTitleIsTheLiftersFirstMessageVerbatim() {
        val asked = "  bench STUCK at 82.5 💀 — what do you see??  "

        val read = WindmillJson.decodeFromString(
            AskThread.serializer(),
            """{"id":"thr_1","title":"  bench STUCK at 82.5 💀 — what do you see??  "}""",
        )

        assertEquals(asked, read.title)
    }

    // THE SUBTITLE OF EVERY ROW, and each one is a fact: a count the server made, and a routine the
    // server named. `applied` is the only one that names a routine at all, and it drops to the count
    // when the changes spanned more than one day of the program — a subtitle that named one of two
    // would be the row picking a winner.
    @Test
    fun everySubtitleIsSomethingTheServerObserved() {
        assertEquals("4 changes → Push A",
            ThreadOutcome("applied", changes = 4, routineId = "rt_1", routine = "Push A").detail)
        assertEquals("6 changes",
            ThreadOutcome("applied", changes = 6).detail)
        assertEquals("no changes proposed", ThreadOutcome("read-only").detail)
        assertEquals("4 changes waiting", ThreadOutcome("proposed", changes = 4).detail)
        assertEquals("3 changes superseded", ThreadOutcome("superseded", changes = 3).detail)
        assertEquals("one change is counted as one", "1 change → Legs",
            ThreadOutcome("applied", changes = 1, routine = "Legs").detail)
    }

    // A DISMISSED ROW CARRIES WHAT WAS DISMISSED AND NOTHING ABOUT WHY. The board draws `built it
    // myself instead`; nothing in this product observes a motive, and there is no field on the wire
    // one could be written into — which is what this test also proves, by reading a thread whose
    // dismissal is the whole of what the log knows about it.
    @Test
    fun aDismissedRowSaysWhatWasDismissedAndNeverWhy() {
        val dismissed = ThreadOutcome("dismissed", changes = 4)

        assertEquals("4 changes dismissed", dismissed.detail)
        assertEquals("dismissed", dismissed.label)
        assertEquals(
            "no motive survives the wire",
            ThreadOutcome("dismissed", changes = 4),
            WindmillJson.decodeFromString(
                ThreadOutcome.serializer(),
                """{"kind":"dismissed","changes":4,"reason":"built it myself instead"}""",
            ),
        )
    }

    // ZERO CHANGES IS A REAL ANSWER and never a missing field: a conversation that proposed nothing
    // is an evening that happened, and `no changes proposed` is the true thing to say about it.
    @Test
    fun aReadOnlyConversationSaysNothingWasProposedRatherThanNothingAtAll() {
        val read = WindmillJson.decodeFromString(
            AskThread.serializer(),
            """{"id":"thr_2","title":"Is my squat volume too low?","outcome":{"kind":"read-only","changes":0}}""",
        )

        assertEquals("no changes proposed", read.outcome.detail)
        assertEquals(0, read.outcome.changes)
        assertEquals("read only", read.outcome.label)
    }

    // AN OUTCOME THIS BUILD CANNOT NAME DRAWS NO SUBTITLE AND NO CHIP. Every closed word here is a
    // claim about somebody's evening — "read only" would say nothing was proposed — so a word from a
    // newer server leaves the row as the title alone, which is still entirely true.
    @Test
    fun anOutcomeThisBuildCannotNameSaysNothingRatherThanGuessing() {
        val unknown = ThreadOutcome("half-applied", changes = 2)

        assertNull(unknown.detail)
        assertNull(unknown.label)
        assertEquals("and it is not the one the accent is spent on", false, unknown.moved)
    }

    // GROUPED BY THE MONTH IT HAPPENED IN, newest month first and newest conversation first inside
    // it — the only grouping on the screen. The year is printed outside the one being lived in, for
    // the reason the log's foot prints one: `July` three years back is the fact somebody came for
    // with the interesting half missing.
    @Test
    fun conversationsAreGroupedByMonthNewestFirst() {
        val months = Threads.months(
            listOf(
                thread(id = "thr_july", askedAtMs = july),
                thread(id = "thr_old", askedAtMs = august),
                thread(id = "thr_new", askedAtMs = august + 3_600_000),
            ),
            august + 7_200_000,
        )

        assertEquals(listOf("August", "July"), months.map { it.label })
        assertEquals(listOf("thr_new", "thr_old"), months[0].threads.map { it.id })
        assertEquals(listOf("thr_july"), months[1].threads.map { it.id })
        assertEquals("a year the lifter is not standing in is named",
            "July 2025", Readout.month(july - 365L * 24 * 3_600_000, august))
    }

    // THE HEADER COUNTS CONVERSATIONS AND NOTHING ELSE. Not unread, not new, not waiting: there is
    // nothing here waiting for anybody, and the second half of the line is what a lifter is owed
    // about their own past — it is theirs to delete.
    @Test
    fun theHeaderCountsConversationsAndNeverAnythingUnread() {
        assertEquals("9 conversations · yours to delete", Threads.counted(9))
        assertEquals("1 conversation · yours to delete", Threads.counted(1))
        assertEquals("0 conversations · yours to delete", Threads.counted(0))
        assertTrue("nothing on this screen speaks of unread anything",
            listOf(Threads.counted(9), Threads.none, Threads.past, Threads.deleteRule, Threads.open,
                Threads.outOfReach)
                .none { it.contains("unread", ignoreCase = true) || it.contains("new message", ignoreCase = true) })
        // AND NOTHING HERE IS NAMED FOR ONE EITHER. A list that could not be READ is `outOfReach`;
        // an `unread` on this object is the seam a later wave grows a badge out of without ever
        // deciding to, so the word is refused as an identifier and not only as copy.
        assertTrue("no member of Threads is named for an unread anything",
            Threads::class.java.declaredFields.map { it.name }
                .none { it.contains("unread", ignoreCase = true) })
    }

    // A ROW NEVER ASSERTS AN EVENING NOBODY LOGGED. Today's log writes both instants on every row,
    // so an absent one is the shape of a reply from a server that stopped rather than one anybody
    // has met — and the answer is NOTHING rather than `1 Jan 1970`: no day on the row, no heading
    // over it, no date on the proposal line. Everything else about the row is true and is drawn.
    @Test
    fun aConversationTheLogGaveNoInstantForIsDrawnWithoutADateRatherThanIn1970() {
        val undated = thread(id = "thr_x", title = "what's stalled?")
        val months = Threads.months(listOf(thread(id = "thr_aug", askedAtMs = august), undated), august)

        assertNull(undated.day(august))
        assertEquals("4 Aug", thread(id = "thr_aug", askedAtMs = august).day(august + 86_400_000))
        assertEquals(listOf("August", null), months.map { it.label })
        assertEquals(listOf(listOf("thr_aug"), listOf("thr_x")), months.map { it.threads.map { held -> held.id } })
        assertEquals("4 changes to Push A · applied",
            ThreadProposal(id = "prop_1", state = ProposalState.Applied, changeCount = 4,
                routineId = "rt_1", routine = "Push A").line(august))
    }

    // DELETING THE CONVERSATION KEEPS THE CONSEQUENCE, and the screen says so before it offers the
    // button rather than after the fact: an applied change stays in the routine's history, because
    // that is a fact about the program rather than a message.
    @Test
    fun theDeleteSaysWhatItKeepsBeforeItIsOffered() {
        assertEquals(
            "Deleting the conversation keeps what it changed: an applied change stays in the " +
                "routine's history. There is no undoing the delete.",
            Threads.deleteRule,
        )
    }

    // THE LANDMINE. The app's one Json omits any value equal to its declared default
    // (`encodeDefaults` off), so a thread id or a question defaulted to the empty string would travel
    // as an ABSENT key and the log would refuse the question as malformed — a whole feature dead on a
    // field nobody typed.
    @Test
    fun aQuestionCarriesBothItsThreadAndItsWordsOnTheWire() {
        val encoded = WindmillJson.encodeToString(
            AskQuestion.serializer(),
            AskQuestion(thread = "thr_1", question = "what's stalled?"),
        )

        assertEquals("""{"thread":"thr_1","question":"what's stalled?"}""", encoded)
    }

    // A THREAD ID IS THIS PHONE'S TO MINT, and it has to satisfy the log's own rule — 8..64 of
    // [A-Za-z0-9_-] — or the conversation is refused before a word of it is read.
    @Test
    fun aMintedThreadIdIsOneTheLogWillTake() {
        val minted = Ids.thread()

        assertTrue(minted.startsWith("thr_"))
        assertTrue(minted.length in 8..64)
        assertTrue(minted.all { it.isLetterOrDigit() || it == '_' || it == '-' })
        assertTrue("a fresh id every time — a spent one would land in somebody's old evening",
            minted != Ids.thread())
    }

    // THE LIST CARRIES NO TURNS AND THE DETAIL DOES. A table of contents does not need every word of
    // every evening, and a client that drew a conversation from the list read would draw an empty one.
    @Test
    fun turnsArriveOnTheDetailReadAndTheListHasNone() {
        val listed = WindmillJson.decodeFromString(
            AskThread.serializer(),
            """{"id":"thr_1","title":"what's stalled?","askedAt":10}""",
        )
        val opened = WindmillJson.decodeFromString(
            AskThread.serializer(),
            """{"id":"thr_1","title":"what's stalled?","turns":[
                 {"from":"lifter","text":"what's stalled?","at":10},
                 {"from":"ask","text":"bench, three weeks.","at":12}]}""",
        )

        assertEquals(emptyList<AskTurn>(), listed.turns)
        assertEquals(
            listOf(AskTurn("lifter", "what's stalled?", 10), AskTurn("ask", "bench, three weeks.", 12)),
            opened.turns,
        )
        assertEquals(listOf(true, false), opened.turns.map { it.fromLifter })
    }

    // WHAT A CONVERSATION MINTED, in the same nouns and the same words the routine's own history
    // prints for the same object — one change described two ways is two accounts of it.
    @Test
    fun aMintedProposalIsCountedTheWayTheProgramCountsIt() {
        val minted = ThreadProposal(id = "prop_1", state = ProposalState.Applied, changeCount = 4,
            routineId = "rt_1", routine = "Push A", createdAtMs = august)

        assertEquals("4 Aug · 4 changes to Push A · applied", minted.line(august))
        assertEquals("4 Aug · 1 change to Push A · dismissed",
            minted.copy(state = ProposalState.Dismissed, changeCount = 1).line(august))
        assertEquals("a routine the reply could not name is left unnamed rather than guessed",
            "4 Aug · 2 changes · waiting",
            minted.copy(state = ProposalState.Pending, changeCount = 2, routine = "").line(august))
    }

    // THE LINK BACK TO THE CONVERSATION IS OFFERED ONLY WHERE THERE IS ONE. `thread` absent means
    // there is nothing to open — the MCP door has no conversation, and a thread the lifter deleted
    // has none left — and the row still says the change came from Ask either way, because deleting
    // the conversation does not delete the consequence.
    @Test
    fun theDoorOntoAConversationIsDrawnOnlyWhereTheLogCarriesOne() {
        val fromAsk = ProposalSource(door = "ask", thread = "thr_1")
        val deleted = ProposalSource(door = "ask")
        val fromMcp = ProposalSource(door = "mcp", thread = "thr_1")

        assertEquals("thr_1", fromAsk.conversation)
        assertNull(deleted.conversation)
        assertNull("a thread id under another door is not a door this room opens", fromMcp.conversation)
        assertEquals("Ask", deleted.name)
    }
}
