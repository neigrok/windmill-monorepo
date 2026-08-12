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

// WHAT THE LIFTER IS BEING ASKED, read off the wire and turned into rows a person can disagree
// with. Everything here is about the ONE screen that decides whether an agent's work reaches a
// program — so what is pinned is the reading: which rows are changes, what actually moved inside
// one, where an added line lands, and when a diff has stopped being applicable at all.
//
// Nothing in this file writes a proposal, because nothing in the app can: the types are read-only
// on the wire and the two verbs are decisions rather than documents.
class ProposalTests {
    // Midday local on a fixed date, and every instant below is an offset from it: a date printed by
    // this product is a LOCAL date (`Readout.shortDate`), so an instant near midnight would print
    // one day here and another in CI. Midday is the same day in every zone the JVM has.
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

    // THE WHOLE CARD ARRIVES ON THE ROUTINE, which is why nothing in this product polls for one and
    // why there is no notification: the read that draws the routines list is the read that draws
    // every card in it. The head carries no diff at all, and that is not an empty diff — the screen
    // that decides fetches the whole thing.
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
        assertEquals("Review 4 changes", waiting.reviewLabel)
        assertEquals("Heavier triples.", waiting.summaryLine("Push A"))
        // AND NO BASE, WHICH IS NOT A BASE OF ZERO. A zero would be a revision every routine alive
        // has already moved past, so this card — hanging on its own routine, at revision 4 — would
        // read as superseded, and so would every other card in the product.
        assertNull("a head carries no base either", waiting.baseRevision)
        assertFalse("so it is never read as superseded", waiting.supersededBy(routine))
    }

    // A ROUTINE WITH NOTHING WAITING SAYS SO BY SAYING NOTHING, and it still reads as revision 1 —
    // the field is the log's and an older reply that never sent one is not a routine at revision
    // zero.
    @Test
    fun testARoutineWithNoCardAndNoRevisionStillReads() {
        val routine = WindmillJson.decodeFromString<Routine>(
            """{"id":"rt_2","name":"Pull A","entries":[]}""")

        assertNull(routine.pendingProposal)
        assertEquals(1, routine.revision)
    }

    // A WORD THIS BUILD HAS NEVER HEARD OF IS SETTLED AND NOT PENDING. `pending` is the only state
    // that can grow a successor, so anything else is already decided — and the safe direction for a
    // state we cannot describe is a screen with no Apply on it rather than one offering a decision
    // it does not understand. A release APK outlives a deploy, and this is the shape that failure
    // takes.
    @Test
    fun testAStateWordFromAFutureLogDrawsNoDecision() {
        assertEquals(ProposalState.Superseded, ProposalState.parse("expired"))
        assertEquals(ProposalState.Superseded, ProposalState.parse(null))
        assertFalse(proposal(state = ProposalState.parse("expired")).isPending)

        // And the four that exist parse as themselves, in both directions.
        assertEquals(ProposalState.Pending, ProposalState.parse("pending"))
        assertEquals(ProposalState.Applied, ProposalState.parse("applied"))
        assertEquals(ProposalState.Dismissed, ProposalState.parse("dismissed"))
        assertEquals(ProposalState.Superseded, ProposalState.parse("superseded"))
    }

    // AN UNKNOWN KIND IS STILL DRAWN, which is the opposite default from the state word and for the
    // opposite reason: a row nobody can name is a row the lifter is about to apply, and hiding it
    // would make the button count one more thing than the screen shows.
    @Test
    fun testAChangeKindFromAFutureLogIsStillARowOnTheScreen() {
        assertEquals(ChangeKind.Retargeted, ChangeKind.parse("reordered"))
        val unknown = ProposalChange(position = 1, kind = ChangeKind.parse("reordered"),
            exerciseId = "bench-press", after = targets(5, 3, 87.5))

        assertEquals(listOf(unknown), proposal(listOf(unknown)).drawn)
    }

    // THE BYLINE IS NEVER BLANK. The transport carries no connection identity today, so both names
    // are omitted — and "from" followed by nothing would read as a change from nobody, which is the
    // one thing provenance exists to prevent.
    @Test
    fun testAnAgentThatDidNotNameItselfStillHasAByline() {
        assertEquals("your connected agent", ProposalSource().name)
        assertEquals("your connected agent", ProposalSource(agent = "  ").name)
        assertEquals("Claude Desktop", ProposalSource(connection = "Claude Desktop").name)
        assertEquals("Claude", ProposalSource(connection = "Claude Desktop", agent = "Claude").name)
    }

    // KEPT ROWS EXIST AND ARE NOT CHANGES. They are context the routine already shows, and a screen
    // that drew them under a header saying "changes" would be arguing with its own button.
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

    // A RENAMED ROUTINE IS A CHANGE WITH NO ROW ON THE WIRE, and the log counts it — so the screen
    // draws one, or `Apply all 4` would promise one more change than a lifter can read.
    @Test
    fun testARenameIsAChangeTheScreenHasToDraw() {
        val moved = ProposalChange(position = 1, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
            before = targets(5, 5, 82.5), after = targets(5, 3, 87.5))

        val renamed = proposal(listOf(moved), changeCount = 2, name = "Push A — heavy")
        assertTrue(renamed.renames)
        assertEquals("Push A", renamed.baseName)
        assertEquals(renamed.drawn.size + 1, renamed.changeCount)

        // The same name on both sides is not a rename, and a head — which carries neither — never
        // claims one.
        assertFalse(proposal(listOf(moved)).renames)
        assertFalse(Proposal(id = "prop_2", routineId = "rt_1").renames)
    }

    // THE FIELDS THAT MOVED, and only those: a card listing every target would make the lifter diff
    // it by eye, which is the work this object exists to have already done.
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

    // THE LOAD IS COMPARED ON THE LADDER'S GRID AND NEVER ON RAW DOUBLES — the same law a set's
    // correction is read by (SetFix.moves). A weight that went out, was stored and came back is the
    // same weight, and a hundredth of a gram's disagreement would draw a change nobody proposed on
    // every proposal, forever.
    @Test
    fun testALoadThatOnlyMovedInFloatingPointDidNotMove() {
        assertTrue(Proposal.moves(targets(5, 5, 82.5), targets(5, 5, 82.500000001)).isEmpty())
        assertEquals(listOf(FieldMove("weight", "82.5", "82.51")),
            Proposal.moves(targets(5, 5, 82.5), targets(5, 5, 82.51)))
    }

    // AN ABSENCE IS A WORD AND NEVER A BLANK. No reps is `max`, no weight is "whatever you did last
    // time", no rest is the global dial — and a diff row with one side empty would read as a field
    // being emptied, which is a different and false claim.
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

    // WHERE AN ADDED LINE LANDS is half of what makes it reviewable. The proposed run is the rows up
    // to the first removal; what the routine takes away is listed after it and is not part of the
    // order, so a removal cannot be read as the thing an addition follows.
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

    // THE BASE IS THE WHOLE SAFETY RULE. A routine that has moved past the revision this diff was
    // written against has already superseded it, and applying it would write next week from a
    // routine that no longer stands. A routine this phone holds BEHIND the base is not the same
    // fact — the device is one read stale, and the log is what decides.
    @Test
    fun testARoutineThatMovedPastTheBaseHasSupersededTheDiff() {
        val written = proposal(baseRevision = 2)
        val routine = Routine(id = "rt_1", name = "Push A")

        assertFalse("the base it was written on", written.supersededBy(routine.copy(revision = 2)))
        assertTrue("the lifter's own save moved it", written.supersededBy(routine.copy(revision = 3)))
        assertFalse("stale here, not moved there", written.supersededBy(routine.copy(revision = 1)))
        assertFalse("nothing to compare against", written.supersededBy(null))
    }

    // ALL OF IT OR NONE, and the button and the sentence under it count the same thing. The one is
    // spelled as a word rather than as `Apply all 1`, which reads like an inventory.
    @Test
    fun testTheButtonAndTheAtomicLineAgreeAtEveryCount() {
        val four = proposal(changeCount = 4)
        assertEquals("Apply all 4", four.applyLabel)
        assertEquals("Review 4 changes", four.reviewLabel)
        assertEquals("All four or none. Nothing is applied until you tap.", four.atomicLine)

        // One change says the promise without counting to one out loud — "all one or none" is an
        // inventory, and the sentence is about atomicity rather than about arithmetic.
        val one = proposal(changeCount = 1)
        assertEquals("Apply all 1", one.applyLabel)
        assertEquals("Review 1 change", one.reviewLabel)
        assertEquals("Nothing is applied until you tap.", one.atomicLine)

        assertEquals("All 14 or none. Nothing is applied until you tap.",
            proposal(changeCount = 14).atomicLine)
    }

    // A REMOVAL IS COUNTED AS ONE ACT however many lines it takes away, and every label says so: the
    // button names the routine it would remove, and the sentence under it makes the promise that
    // matters — the log is not what is being removed.
    @Test
    fun testARemovalIsNamedRatherThanCounted() {
        val removal = proposal(intent = ProposalIntent.Remove, changeCount = 6, baseName = "Push B")

        assertEquals("a removal", removal.counted)
        assertEquals("Review the removal", removal.reviewLabel)
        assertEquals("Remove Push B", removal.applyLabel)
        assertEquals("The routine goes and your logged sets stay. Nothing is removed until you tap.",
            removal.atomicLine)
        assertEquals("A proposal to remove Push B.",
            removal.copy(summary = "").summaryLine("Push B"))
    }

    // AN AGENT THAT WROTE NO SUMMARY IS NOT GIVEN ONE. The card says a count and a routine name
    // rather than a sentence this room invented — the agent's own words are the only voice allowed
    // to describe its own diff.
    @Test
    fun testACardWithNoSummarySaysTheCountAndNeverInventsASentence() {
        assertEquals("3 changes to Push A.", proposal(changeCount = 3).copy(summary = "").summaryLine("Push A"))
        assertEquals("1 change to Push A.", proposal(changeCount = 1).copy(summary = "").summaryLine("Push A"))
        assertEquals("the agent's own words win", "Four weeks of heavier bench triples.",
            proposal(changeCount = 3).summaryLine("Push A"))
    }

    // THE TWO LINES A CHANGED ROW SPELLS FOR ITSELF, because all three surfaces draw the same
    // sentence. A removal names what it does NOT touch, and zero logged sets is a real answer rather
    // than a reassurance about nothing.
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

    // APPLIED OR DISMISSED, IT IS A DATED RECORD ON THE ROUTINE — the program's history rather than
    // a toast that disappeared. A dismissal keeps its row exactly as an apply does, and a superseded
    // one is here too: nothing piles up and nothing vanishes.
    @Test
    fun testEveryDecisionKeepsADatedRowThatSaysWhoAndWhat() {
        val settled = threeDaysAgoMs                                 // 29 Jul 2025
        val applied = proposal(changeCount = 3, state = ProposalState.Applied, settledAtMs = settled)
        assertEquals("29 Jul · applied 3 changes from Claude", applied.historyLine(nowMs))

        val dismissed = proposal(changeCount = 3, state = ProposalState.Dismissed, settledAtMs = settled)
        assertEquals("29 Jul · dismissed 3 changes from Claude", dismissed.historyLine(nowMs))

        // "Set aside" rather than the wire's own word: it is the only outcome a lifter did not
        // choose, and `superseded` is a thing that happens to a row in a table.
        val superseded = proposal(changeCount = 3, state = ProposalState.Superseded, settledAtMs = settled)
        assertEquals("29 Jul · set aside 3 changes from Claude", superseded.historyLine(nowMs))

        // A removal is one act in the history too, however many lines it took away.
        val removed = proposal(changeCount = 6, intent = ProposalIntent.Remove,
            state = ProposalState.Applied, settledAtMs = settled)
        assertEquals("29 Jul · applied a removal from Claude", removed.historyLine(nowMs))

        // A pending one is drawn as the card and not as history, but it can still say what it is —
        // and with no agent named it says the fallback rather than nothing.
        val waiting = proposal(changeCount = 1, source = ProposalSource())
        assertEquals("31 Jul · 1 change from your connected agent, waiting", waiting.historyLine(nowMs))
    }

    // WHAT WAS DECIDED, SAID ON THE SCREEN THAT DECIDED IT, with the instant it happened. A pending
    // proposal has no note at all — nothing has happened to it yet, and a screen that said so would
    // be filling silence.
    @Test
    fun testASettledProposalSaysWhatHappenedAndAPendingOneSaysNothing() {
        val settled = threeDaysAgoMs
        val on = "29 Jul at ${Readout.time(settled)}"
        assertEquals(
            "Applied to Push A $on. Kept on the routine as a dated record — the program's history, not a toast that disappears.",
            proposal(state = ProposalState.Applied, settledAtMs = settled).settledNote(nowMs))
        assertEquals(
            "Dismissed $on. No reason asked for, nothing changed, and it stays in the routine's history in case you want it back.",
            proposal(state = ProposalState.Dismissed, settledAtMs = settled).settledNote(nowMs))
        assertEquals(
            "Push A changed after this was written, so it was set aside $on. None of it was applied, and it stays in the routine's history.",
            proposal(state = ProposalState.Superseded, settledAtMs = settled).settledNote(nowMs))
        // A decision taken today is placed by its hour instead, which is the same phrase one word
        // shorter — the design's own "Dismissed today at 07:12."
        assertTrue(proposal(state = ProposalState.Dismissed, settledAtMs = nowMs)
            .settledNote(nowMs)!!.startsWith("Dismissed today at ${Readout.time(nowMs)}."))
        assertNull(proposal().settledNote(nowMs))
        // Settled with no instant is the one shape a note cannot be written from, and it says
        // nothing rather than dating a decision from the device's own clock.
        assertNull(proposal(state = ProposalState.Applied).settledNote(nowMs))
    }

    // THE DIFF, WHOLE, OFF THE WIRE — the shape the decision screen actually reads, including the
    // two absences that carry meaning: no `before` on an added line, no `after` on a removed one,
    // and `loggedSets` on the removal alone.
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
        // It lands behind the line above it in the RUN, kept rows included — a line the proposal
        // leaves alone is still a line of the day, and skipping it would name the wrong movement.
        assertEquals("overhead-press", whole.landsAfter(whole.changes[2]))
        assertNull("a removed line has no after", whole.changes[3].after)
        assertEquals(41, whole.changes[3].loggedSets)
        assertNull("only a removal keeps sets", whole.changes[0].loggedSets)
        assertEquals("your connected agent", whole.source.name)
        assertFalse(whole.renames)
    }

    // A REMOVAL IS A PROPOSAL TOO, and it says so in its intent rather than by being an empty diff.
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
