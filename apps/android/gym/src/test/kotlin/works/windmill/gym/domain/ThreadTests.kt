package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.platform.net.WindmillJson

class ThreadTests {
    private fun thread(
        id: String = "thr_1",
        title: String = "Bench has been stuck at 82.5 for three weeks. What do you see?",
        askedAtMs: Long = 0,
        outcome: ThreadOutcome = ThreadOutcome(),
    ) = AskThread(id = id, title = title, createdAtMs = askedAtMs, askedAtMs = askedAtMs, outcome = outcome)

    private val august = 1_785_844_800_000L
    private val july = august - 21L * 24 * 3_600_000

    @Test
    fun theTitleIsTheLiftersFirstMessageVerbatim() {
        val asked = "  bench STUCK at 82.5 💀 — what do you see??  "

        val read = WindmillJson.decodeFromString(
            AskThread.serializer(),
            """{"id":"thr_1","title":"  bench STUCK at 82.5 💀 — what do you see??  "}""",
        )

        assertEquals(asked, read.title)
    }

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

    @Test
    fun anOutcomeThisBuildCannotNameSaysNothingRatherThanGuessing() {
        val unknown = ThreadOutcome("half-applied", changes = 2)

        assertNull(unknown.detail)
        assertNull(unknown.label)
        assertEquals("and it is not the one the accent is spent on", false, unknown.moved)
    }

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

    @Test
    fun theHeaderCountsConversationsAndNeverAnythingUnread() {
        assertEquals("9 conversations · yours to delete", Threads.counted(9))
        assertEquals("1 conversation · yours to delete", Threads.counted(1))
        assertEquals("0 conversations · yours to delete", Threads.counted(0))
        assertTrue("nothing on this screen speaks of unread anything",
            listOf(Threads.counted(9), Threads.none, Threads.past, Threads.deleteRule, Threads.open,
                Threads.outOfReach)
                .none { it.contains("unread", ignoreCase = true) || it.contains("new message", ignoreCase = true) })
        assertTrue("no member of Threads is named for an unread anything",
            Threads::class.java.declaredFields.map { it.name }
                .none { it.contains("unread", ignoreCase = true) })
    }

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

    @Test
    fun theDeleteSaysWhatItKeepsBeforeItIsOffered() {
        assertEquals(
            "Deleting the conversation keeps what it changed: an applied change stays in the " +
                "routine's history. There is no undoing the delete.",
            Threads.deleteRule,
        )
    }

    @Test
    fun aQuestionCarriesBothItsThreadAndItsWordsOnTheWire() {
        val encoded = WindmillJson.encodeToString(
            AskQuestion.serializer(),
            AskQuestion(thread = "thr_1", question = "what's stalled?"),
        )

        assertEquals("""{"thread":"thr_1","question":"what's stalled?"}""", encoded)
    }

    @Test
    fun aMintedThreadIdIsOneTheLogWillTake() {
        val minted = Ids.thread()

        assertTrue(minted.startsWith("thr_"))
        assertTrue(minted.length in 8..64)
        assertTrue(minted.all { it.isLetterOrDigit() || it == '_' || it == '-' })
        assertTrue("a fresh id every time — a spent one would land in somebody's old evening",
            minted != Ids.thread())
    }

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
