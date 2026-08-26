package works.windmill.gym.domain

import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.platform.net.WindmillJson

class ProposalTests {
    private val zone: ZoneId = ZoneId.systemDefault()
    private val nowMs = LocalDate.parse("2025-08-01").atStartOfDay(zone).plusHours(12)
        .toInstant().toEpochMilli()
    private val yesterdayMs = nowMs - 86_400_000
    private val threeDaysAgoMs = nowMs - 3 * 86_400_000

    private fun targets(sets: Int, reps: Int? = null, weightKg: Double? = null, restSeconds: Int? = null) =
        ProposalTargets(sets = sets, reps = reps, weightKg = weightKg, restSeconds = restSeconds)

    private fun proposal(
        changes: List<ProposalChange> = emptyList(),
        changeCount: Int = changes.count { it.kind != ChangeKind.Kept },
        state: ProposalState = ProposalState.Pending,
        intent: ProposalIntent = ProposalIntent.Revise,
        baseRevision: Int = 1,
        baseName: String = "Push A",
        name: String = "Push A",
        settledAtMs: Long? = null,
        source: ProposalSource = ProposalSource(agent = "Claude"),
    ) = Proposal(
        id = "prop_1", routineId = "rt_1", intent = intent, state = state,
        summary = "Four weeks of heavier bench triples.", changeCount = changeCount,
        createdAtMs = yesterdayMs, settledAtMs = settledAtMs, source = source,
        baseRevision = baseRevision, baseName = baseName, name = name, changes = changes)

    @Test
    fun testARoutineCarriesItsRevisionAndTheCardWaitingOnIt() {
        val wire = """
            {"id":"rt_1","name":"Push A","position":0,"revision":4,
             "entries":[{"position":1,"exerciseId":"bench-press","targetSets":5,"targetReps":5,"targetWeightKg":82.5}],
             "pendingProposal":{"id":"prop_1","routineId":"rt_1","intent":"revise","state":"pending",
               "summary":"Heavier triples.","changeCount":4,"createdAt":1700000000000,
               "source":{"door":"mcp","agent":"Claude"}}}
        """.trimIndent()

        val routine = WindmillJson.decodeFromString<Routine>(wire)

        assertEquals(4, routine.revision)
        assertNotNull("the card rides on the routine", routine.pendingProposal)
        val waiting = routine.pendingProposal!!
        assertEquals("prop_1", waiting.id)
        assertEquals(ProposalState.Pending, waiting.state)
        assertEquals(ProposalIntent.Revise, waiting.intent)
        assertEquals(4, waiting.changeCount)
        assertEquals("Claude", waiting.source.name)
        assertTrue("a head carries no diff", waiting.changes.isEmpty())
        assertEquals("Review", waiting.reviewLabel)
        assertEquals("Heavier triples.", waiting.summaryLine("Push A"))
        assertNull("a head carries no base either", waiting.baseRevision)
        assertFalse("so it is never read as superseded", waiting.supersededBy(routine))
    }

    @Test
    fun testARoutineWithNoCardAndNoRevisionStillReads() {
        val routine = WindmillJson.decodeFromString<Routine>(
            """{"id":"rt_2","name":"Pull A","entries":[]}""")

        assertNull(routine.pendingProposal)
        assertEquals(1, routine.revision)
    }

    @Test
    fun testAStateWordFromAFutureLogDrawsNoDecision() {
        assertEquals(ProposalState.Superseded, ProposalState.parse("expired"))
        assertEquals(ProposalState.Superseded, ProposalState.parse(null))
        assertFalse(proposal(state = ProposalState.parse("expired")).isPending)

        assertEquals(ProposalState.Pending, ProposalState.parse("pending"))
        assertEquals(ProposalState.Applied, ProposalState.parse("applied"))
        assertEquals(ProposalState.Dismissed, ProposalState.parse("dismissed"))
        assertEquals(ProposalState.Superseded, ProposalState.parse("superseded"))
    }

    @Test
    fun testAChangeKindFromAFutureLogIsStillARowOnTheScreen() {
        assertEquals(ChangeKind.Retargeted, ChangeKind.parse("reordered"))
        val unknown = ProposalChange(position = 1, kind = ChangeKind.parse("reordered"),
            exerciseId = "bench-press", after = targets(5, 3, 87.5))

        assertEquals(listOf(unknown), proposal(listOf(unknown)).drawn)
    }

    @Test
    fun testAnAgentThatDidNotNameItselfStillHasAByline() {
        assertEquals("your connected agent", ProposalSource().name)
        assertEquals("your connected agent", ProposalSource(agent = "  ").name)
        assertEquals("Claude Desktop", ProposalSource(connection = "Claude Desktop").name)
        assertEquals("Claude", ProposalSource(connection = "Claude Desktop", agent = "Claude").name)
    }

    @Test
    fun testAProposalMintedInCoachSaysSo() {
        assertEquals("Coach", ProposalSource(door = "ask").name)
        assertEquals("Claude", ProposalSource(door = "ask", agent = "Claude").name)
        assertEquals("your connected agent", ProposalSource(door = "mcp").name)
        assertEquals("a door this build has never heard of is somebody's own agent",
            "your connected agent", ProposalSource(door = "carrier-pigeon").name)
    }

    @Test
    fun testTheKickerAttributesTheProseByWhoWroteIt() {
        assertEquals("Coach wrote:", ProposalSource(door = "ask").kicker)
        assertEquals("Claude Desktop wrote:", ProposalSource(door = "mcp", agent = "Claude Desktop").kicker)
        assertEquals("Claude Desktop wrote:", ProposalSource(door = "mcp", connection = "Claude Desktop").kicker)
        assertEquals("Your agent wrote:", ProposalSource(door = "mcp").kicker)
        assertEquals("Your agent wrote:", ProposalSource(door = "mcp", agent = " ").kicker)
        assertEquals("Your agent wrote:", ProposalSource(door = "mcp", agent = "", connection = " ").kicker)
        assertEquals("the agent's own name outranks the connection's",
            "Claude Desktop wrote:", ProposalSource(door = "mcp", agent = "Claude Desktop", connection = "Claude Code").kicker)
        assertEquals("the sheet reads it off the proposal", "Coach wrote:",
            proposal(source = ProposalSource(door = "ask")).kicker)
    }

    @Test
    fun testTheReceiptIsDerivedFromTheServersReplyAndNeverFromTheProse() {
        val applied = """{"proposal":{"id":"prop_1","routineId":"rt_1","intent":"revise","state":"applied",
            "summary":"the model said twelve things","changeCount":4,"createdAt":1000,"settledAt":2000,
            "source":{"agent":"Claude"},"baseName":"Push A","name":"Push A"}}"""
        fun decoded(wire: String) = WindmillJson.decodeFromString<ProposalDecision>(wire).proposal

        assertEquals("Applied · Push A · 4 changes", decoded(applied).receipt)
        assertEquals("Applied · Push Day · 1 change", decoded(applied
            .replace(""""name":"Push A"""", """"name":"Push Day"""")
            .replace(""""changeCount":4""", """"changeCount":1""")).receipt)
        assertEquals("Applied · Push A · routine removed", decoded(applied.replace("revise", "remove")).receipt)
        assertEquals("Turned down · nothing changed.", decoded(applied.replace("applied", "dismissed")).receipt)
        assertNull(decoded(applied.replace("applied", "pending")).receipt)
    }

    @Test
    fun testTheRowsDrawnAreEveryChangeExceptTheLinesLeftAlone() {
        val kept = ProposalChange(position = 1, kind = ChangeKind.Kept, exerciseId = "chin-up",
            before = targets(3), after = targets(3))
        val moved = ProposalChange(position = 2, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
            before = targets(5, 5, 82.5), after = targets(5, 3, 87.5))
        val added = ProposalChange(position = 3, kind = ChangeKind.Added, exerciseId = "incline-db-press",
            after = targets(3, 10, 24.0))
        val gone = ProposalChange(position = 4, kind = ChangeKind.Removed, exerciseId = "cable-fly",
            before = targets(3, 12, 22.5), loggedSets = 41)

        val whole = proposal(listOf(kept, moved, added, gone))

        assertEquals(listOf(moved, added, gone), whole.drawn)
        assertEquals("the button counts what the screen shows", whole.drawn.size, whole.changeCount)
    }

    @Test
    fun testARenameIsAChangeTheScreenHasToDraw() {
        val moved = ProposalChange(position = 1, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
            before = targets(5, 5, 82.5), after = targets(5, 3, 87.5))

        val renamed = proposal(listOf(moved), changeCount = 2, name = "Push A — heavy")
        assertTrue(renamed.renames)
        assertEquals("Push A", renamed.baseName)
        assertEquals(renamed.drawn.size + 1, renamed.changeCount)

        assertFalse(proposal(listOf(moved)).renames)
        assertFalse(Proposal(id = "prop_2", routineId = "rt_1").renames)
    }

    @Test
    fun testAFieldMoveNamesOnlyWhatChanged() {
        val moved = Proposal.moves(
            before = targets(5, 5, 82.5, restSeconds = 180),
            after = targets(5, 3, 87.5, restSeconds = 180))

        assertEquals(2, moved.size)
        assertEquals(FieldMove("sets", "5 × 5", "5 × 3"), moved[0])
        assertEquals(FieldMove("weight", "82.5", "87.5"), moved[1])
        assertEquals("nothing moved", emptyList<FieldMove>(),
            Proposal.moves(targets(5, 5, 82.5), targets(5, 5, 82.5)))
    }

    @Test
    fun testALoadThatOnlyMovedInFloatingPointDidNotMove() {
        assertTrue(Proposal.moves(targets(5, 5, 82.5), targets(5, 5, 82.500000001)).isEmpty())
        assertEquals(listOf(FieldMove("weight", "82.5", "82.51")),
            Proposal.moves(targets(5, 5, 82.5), targets(5, 5, 82.51)))
    }

    @Test
    fun testAnAbsentTargetIsSaidRatherThanLeftBlank() {
        assertEquals(
            listOf(FieldMove("sets", "3 × max", "3 × 8")),
            Proposal.moves(targets(3, null), targets(3, 8)))
        assertEquals(
            listOf(FieldMove("weight", "last time", "60")),
            Proposal.moves(targets(3, 8), targets(3, 8, 60.0)))
        assertEquals(
            listOf(FieldMove("rest", "the dial", "180s")),
            Proposal.moves(targets(3, 8, 60.0), targets(3, 8, 60.0, restSeconds = 180)))
        assertEquals("3 × 10 · 24", Proposal.asks(targets(3, 10, 24.0)))
    }

    @Test
    fun testAnAddedLineNamesTheMovementItLandsBehind() {
        val bench = ProposalChange(position = 1, kind = ChangeKind.Kept, exerciseId = "bench-press",
            before = targets(5, 5), after = targets(5, 5))
        val incline = ProposalChange(position = 2, kind = ChangeKind.Added, exerciseId = "incline-db-press",
            after = targets(3, 10, 24.0))
        val gone = ProposalChange(position = 3, kind = ChangeKind.Removed, exerciseId = "cable-fly",
            before = targets(3, 12, 22.5), loggedSets = 41)
        val orphan = ProposalChange(position = 4, kind = ChangeKind.Added, exerciseId = "face-pull",
            after = targets(3, 15))

        val whole = proposal(listOf(bench, incline, gone, orphan))

        assertEquals("bench-press", whole.landsAfter(incline))
        assertNull("the first line of the day follows nothing", whole.landsAfter(bench))
        assertNull("what is taken away is not part of the run", whole.landsAfter(orphan))
    }

    @Test
    fun testARoutineThatMovedPastTheBaseHasSupersededTheDiff() {
        val written = proposal(baseRevision = 2)
        val routine = Routine(id = "rt_1", name = "Push A")

        assertFalse("the base it was written on", written.supersededBy(routine.copy(revision = 2)))
        assertTrue("the lifter's own save moved it", written.supersededBy(routine.copy(revision = 3)))
        assertFalse("stale here, not moved there", written.supersededBy(routine.copy(revision = 1)))
        assertFalse("nothing to compare against", written.supersededBy(null))
    }

    @Test
    fun testTheButtonAndTheAtomicLineAgreeAtEveryCount() {
        val four = proposal(changeCount = 4)
        assertEquals("Apply all 4", four.applyLabel)
        assertEquals("Review", four.reviewLabel)
        assertEquals("All four or none. Nothing is applied until you tap.", four.atomicLine)

        val one = proposal(changeCount = 1)
        assertEquals("Apply", one.applyLabel)
        assertEquals("Review", one.reviewLabel)
        assertEquals("Nothing is applied until you tap.", one.atomicLine)

        assertEquals("Apply all 2", proposal(changeCount = 2).applyLabel)

        assertEquals("All 14 or none. Nothing is applied until you tap.",
            proposal(changeCount = 14).atomicLine)
    }

    @Test
    fun testARemovalIsNamedRatherThanCounted() {
        val removal = proposal(intent = ProposalIntent.Remove, changeCount = 6, baseName = "Push B")

        assertEquals("a removal", removal.counted)
        assertEquals("Applied · Push B · routine removed", removal.copy(state = ProposalState.Applied).receipt)
        assertEquals("Review", removal.reviewLabel)
        assertEquals("Remove Push B", removal.applyLabel)
        assertEquals("The routine goes and your logged sets stay. Nothing is removed until you tap.",
            removal.atomicLine)
        assertEquals("A proposal to remove Push B.",
            removal.copy(summary = "").summaryLine("Push B"))
    }

    @Test
    fun testACardWithNoSummarySaysTheCountAndNeverInventsASentence() {
        assertEquals("3 changes to Push A.", proposal(changeCount = 3).copy(summary = "").summaryLine("Push A"))
        assertEquals("1 change to Push A.", proposal(changeCount = 1).copy(summary = "").summaryLine("Push A"))
        assertEquals("the agent's own words win", "Four weeks of heavier bench triples.",
            proposal(changeCount = 3).summaryLine("Push A"))
    }

    @Test
    fun testAnAddedLineAndARemovedLineSpellThemselves() {
        val added = ProposalChange(position = 2, kind = ChangeKind.Added,
            exerciseId = "incline-db-press", after = targets(3, 10, 24.0))
        assertEquals("added · 3 × 10 · 24 · after Bench Press", added.addedLine(follows = "Bench Press"))
        assertEquals("added · 3 × 10 · 24 · first in the routine", added.addedLine(follows = null))

        val gone = ProposalChange(position = 4, kind = ChangeKind.Removed, exerciseId = "cable-fly",
            before = targets(3, 12, 22.5), loggedSets = 41)
        assertEquals("removed from the routine · 41 logged sets kept", gone.removedLine)
        assertEquals("removed from the routine · 1 logged set kept", gone.copy(loggedSets = 1).removedLine)
        assertEquals("removed from the routine · never logged", gone.copy(loggedSets = 0).removedLine)
        assertEquals("a count the log did not send is not a zero", "removed from the routine",
            gone.copy(loggedSets = null).removedLine)
    }

    @Test
    fun testAChangeSpellsItselfAtCardSizeInTheDiffScreensOwnGrammar() {
        val added = ProposalChange(position = 2, kind = ChangeKind.Added,
            exerciseId = "incline-db-press", after = targets(3, 10, 24.0))
        assertEquals("+ added · 3 × 10 · 24", added.compactLine)
        assertEquals("+ added", added.copy(after = null).compactLine)

        val gone = ProposalChange(position = 4, kind = ChangeKind.Removed, exerciseId = "cable-fly",
            before = targets(3, 12, 22.5), loggedSets = 41)
        assertEquals("− removed from the routine · 41 logged sets kept", gone.compactLine)

        val moved = ProposalChange(position = 1, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
            before = targets(5, 5, 82.5), after = targets(5, 3, 90.0))
        assertEquals("5 × 5 → 5 × 3 · 82.5 → 90", moved.compactLine)

        assertEquals("a row with one side missing prints what the line would end up asking for",
            "5 × 3 · 90", moved.copy(before = null).compactLine)
        assertEquals("and a row with neither says so rather than drawing a blank",
            "no targets", moved.copy(before = null, after = null).compactLine)
    }

    @Test
    fun testEveryDecisionKeepsADatedRowThatSaysWhoAndWhat() {
        val settled = threeDaysAgoMs                                 // 29 Jul 2025
        val applied = proposal(changeCount = 3, state = ProposalState.Applied, settledAtMs = settled)
        assertEquals("29 Jul · applied 3 changes from Claude", applied.historyLine(nowMs))

        val dismissed = proposal(changeCount = 3, state = ProposalState.Dismissed, settledAtMs = settled)
        assertEquals("29 Jul · turned down 3 changes from Claude", dismissed.historyLine(nowMs))

        val superseded = proposal(changeCount = 3, state = ProposalState.Superseded, settledAtMs = settled)
        assertEquals("29 Jul · set aside 3 changes from Claude", superseded.historyLine(nowMs))

        val removed = proposal(changeCount = 6, intent = ProposalIntent.Remove,
            state = ProposalState.Applied, settledAtMs = settled)
        assertEquals("29 Jul · applied a removal from Claude", removed.historyLine(nowMs))

        val waiting = proposal(changeCount = 1, source = ProposalSource())
        assertEquals("31 Jul · 1 change from your connected agent, waiting", waiting.historyLine(nowMs))
    }

    @Test
    fun testASettledProposalSaysWhatHappenedAndAPendingOneSaysNothing() {
        val settled = threeDaysAgoMs
        val on = "29 Jul at ${Readout.time(settled)}"
        assertEquals(
            "Applied to Push A $on. Kept on the routine as a dated record — the program’s history, not a toast that disappears.",
            proposal(state = ProposalState.Applied, settledAtMs = settled).settledNote(nowMs))
        assertEquals(
            "Turned down $on. Nothing changed, and it stays in the routine’s history as a record.",
            proposal(state = ProposalState.Dismissed, settledAtMs = settled).settledNote(nowMs))
        assertEquals(
            "Push A changed after this was written, so it was set aside $on. None of it was applied, and it stays in the routine’s history.",
            proposal(state = ProposalState.Superseded, settledAtMs = settled).settledNote(nowMs))
        assertTrue(proposal(state = ProposalState.Dismissed, settledAtMs = nowMs)
            .settledNote(nowMs)!!.startsWith("Turned down today at ${Readout.time(nowMs)}."))
        assertNull(proposal().settledNote(nowMs))
        assertNull(proposal(state = ProposalState.Applied).settledNote(nowMs))
    }

    @Test
    fun testTheWholeDiffDecodesIntoTheRowsTheScreenDraws() {
        val wire = """
            {"id":"prop_1","routineId":"rt_1","intent":"revise","state":"pending",
             "summary":"Heavier triples, incline in place of flies.","changeCount":4,
             "createdAt":1700000000000,"source":{"door":"mcp"},
             "baseRevision":1,"baseName":"Push A","name":"Push A",
             "changes":[
               {"position":1,"kind":"retargeted","exerciseId":"bench-press",
                "before":{"sets":5,"reps":5,"weightKg":82.5,"restSeconds":180},
                "after":{"sets":5,"reps":3,"weightKg":87.5,"restSeconds":180}},
               {"position":2,"kind":"kept","exerciseId":"overhead-press",
                "before":{"sets":3,"reps":8,"weightKg":45},"after":{"sets":3,"reps":8,"weightKg":45}},
               {"position":3,"kind":"added","exerciseId":"incline-db-press",
                "after":{"sets":3,"reps":10,"weightKg":24}},
               {"position":4,"kind":"removed","exerciseId":"cable-fly",
                "before":{"sets":3,"reps":12,"weightKg":22.5},"loggedSets":41}]}
        """.trimIndent()

        val whole = WindmillJson.decodeFromString<Proposal>(wire)

        assertEquals(listOf("bench-press", "incline-db-press", "cable-fly"), whole.drawn.map { it.exerciseId })
        assertEquals(listOf(FieldMove("sets", "5 × 5", "5 × 3"), FieldMove("weight", "82.5", "87.5")),
            Proposal.moves(whole.changes[0].before!!, whole.changes[0].after!!))
        assertNull("an added line has no before", whole.changes[2].before)
        assertEquals("overhead-press", whole.landsAfter(whole.changes[2]))
        assertNull("a removed line has no after", whole.changes[3].after)
        assertEquals(41, whole.changes[3].loggedSets)
        assertNull("only a removal keeps sets", whole.changes[0].loggedSets)
        assertEquals("your connected agent", whole.source.name)
        assertFalse(whole.renames)
    }

    @Test
    fun testTurningDownIsConfirmedInTheSameWordsAsEverySurface() {
        assertEquals("Turn this down", Proposal.turnDownVerb)
        assertEquals("Turn this down?", Proposal.turnDownAsk)
        assertEquals("Nothing changes, and it stays in the routine’s history as a record.", Proposal.turnDownBody)
        assertEquals("Turn down", Proposal.turnDown)
    }

    @Test
    fun testARemovalCarriesItsIntentAndNotAnEmptyDocument() {
        val wire = """
            {"id":"prop_2","routineId":"rt_1","intent":"remove","state":"pending","summary":"",
             "changeCount":1,"createdAt":1700000000000,"baseRevision":1,"baseName":"Push B"}
        """.trimIndent()

        val whole = WindmillJson.decodeFromString<Proposal>(wire)

        assertEquals(ProposalIntent.Remove, whole.intent)
        assertEquals("Push B", whole.routineName)
        assertTrue(whole.summary.isEmpty())
    }
}
