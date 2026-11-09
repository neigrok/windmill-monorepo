package works.windmill.gym.presentation

import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.plain
import works.windmill.gym.spelled
import works.windmill.gym.string
import works.windmill.domain.kit.Id
import works.windmill.gym.R
import works.windmill.gym.domain.sync.Exercise as DomainExercise
import works.windmill.gym.domain.sync.ProposalDiff
import works.windmill.gym.domain.sync.RoutineChange
import works.windmill.gym.domain.sync.RoutineEntry as DomainEntry
import works.windmill.gym.domain.sync.SetTarget as DomainTarget
import works.windmill.platform.i18n.Words
import works.windmill.platform.net.WindmillJson

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ProposalTests {
    // The sheet's own rows over random proposals: a count on the card is the rows it opens on, with a rename's row beside them.
    @Test fun theCountIsTheRowsTheSheetDrawsOverRandomProposals() {
        val random = java.util.Random(20261105)
        val movements = (0 until 12).map { Id("movement$it", DomainExercise) }
        repeat(2000) {
            val base = List(1 + random.nextInt(8)) { DomainEntry(movements[random.nextInt(12)], listOf(DomainTarget(5, 60.0))) }
            val proposed = base.filter { random.nextInt(5) > 0 }.toMutableList()
            repeat(random.nextInt(3)) { proposed.add(random.nextInt(proposed.size + 1), DomainEntry(movements[random.nextInt(12)], listOf(DomainTarget(8, 40.0)))) }
            for (at in proposed.indices) if (random.nextInt(5) == 0) proposed[at] = proposed[at].copy(sets = listOf(DomainTarget(3, 70.0)))
            repeat(random.nextInt(3)) { if (proposed.size > 1) { val at = random.nextInt(proposed.size); proposed.add(random.nextInt(proposed.size), proposed.removeAt(at)) } }
            val lines = RoutineChange.between(base, proposed)
            val moves = ProposalDiff.moves(lines, base)
            val renamed = random.nextBoolean()
            val drawn = Proposal(id = "prop_1", routineId = "rt_1", baseName = "Push A", name = if (renamed) "Push B" else "Push A",
                changeCount = RoutineChange.count(base, lines) + if (renamed) 1 else 0,
                changes = lines.mapIndexed { index, line -> ProposalChange(index + 1, ChangeKind.parse(line.kind), line.exerciseId.record.string!!,
                    order = moves[index]?.field?.let { FieldMove(Words.Plain(it.label), Words.Plain(it.before.orEmpty()), Words.Plain(it.after.orEmpty())) }) })
            assertEquals("$lines", drawn.drawn.size + if (drawn.renames) 1 else 0, drawn.changeCount)
            assertEquals("$lines", drawn.document.filterIsInstance<DocumentRow.Changed>().size + if (drawn.renames) 1 else 0, drawn.changeCount)
        }
    }

    private val zone: ZoneId = ZoneId.systemDefault()
    private val nowMs = LocalDate.parse("2025-08-01").atStartOfDay(zone).plusHours(12)
        .toInstant().toEpochMilli()
    private val yesterdayMs = nowMs - 86_400_000
    private val threeDaysAgoMs = nowMs - 3 * 86_400_000

    // A straight scheme of `sets` sets, each `reps` × `weightKg`.
    private fun targets(sets: Int, reps: Int? = null, weightKg: Double? = null) =
        ProposalTargets(sets = List(sets) { SetTarget(reps, weightKg) })

    private val lowerARamp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0),
                                    SetTarget(1, 100.0), SetTarget(5, 80.0))

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

    // A kept movement that moved is a row where it lands; only what stands is counted among the unchanged (08.71).
    @Test fun aMovedMovementIsARowWhereItLandsAndTheCountOfWhatStandsLeavesItOut() {
        val moved = ProposalChange(1, ChangeKind.Kept, "overhead-press", targets(3, 6), targets(3, 6), order = FieldMove(Words.Plain("Order"), Words.Plain("3rd"), Words.Plain("1st")))
        val stood = listOf("bench-press", "cable-fly").mapIndexed { at, id -> ProposalChange(at + 2, ChangeKind.Kept, id, targets(3, 8), targets(3, 8)) }
        val added = ProposalChange(4, ChangeKind.Added, "dips", null, targets(3, 8))
        val changed = ProposalChange(5, ChangeKind.Retargeted, "triceps-pushdown", targets(3, 8), targets(4, 8))
        val whole = proposal(listOf(moved) + stood + listOf(added, changed), changeCount = 3)
        assertEquals(listOf(DocumentRow.Changed(moved), DocumentRow.Unchanged(stood), DocumentRow.Changed(added), DocumentRow.Changed(changed)), whole.document)
        assertEquals(listOf(DocumentRow.Changed(moved), DocumentRow.Changed(changed), DocumentRow.Changed(added), DocumentRow.Unchanged(stood)), whole.changesFirst)
        assertEquals(listOf(moved, added, changed), whole.drawn)
        assertEquals("and 2 lines unchanged", DocumentRow.Unchanged(stood).said.spelled())
        assertEquals("3 changes", whole.counting.spelled())
    }

    // A place is read against the base where it is read; a stored proposal carries none of it.
    @Test fun aMoveIsNeverStoredWithTheProposal() {
        val moved = ProposalChange(1, ChangeKind.Kept, "overhead-press", targets(3, 6), targets(3, 6), order = FieldMove(Words.Plain("Order"), Words.Plain("3rd"), Words.Plain("1st")))
        val stored = WindmillJson.decodeFromString<ProposalChange>(WindmillJson.encodeToString(moved))
        assertEquals(moved.copy(order = null), stored)
    }

    @Test
    fun testARoutineCarriesItsRevisionAndTheCardWaitingOnIt() {
        val wire = """
            {"id":"rt_1","name":"Push A","position":0,"revision":4,
             "entries":[{"position":1,"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":82.5}]}],
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
        assertEquals("Claude", waiting.source.named.spelled())
        assertTrue("a head carries no diff", waiting.changes.isEmpty())
        assertEquals("Heavier triples.", waiting.summarized(Words.Plain("Push A")).spelled())
        assertNull("a head carries no base either", waiting.baseRevision)
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
        assertEquals("your connected agent", ProposalSource().named.spelled())
        assertEquals("your connected agent", ProposalSource(agent = "  ").named.spelled())
        assertEquals("Claude Desktop", ProposalSource(connection = "Claude Desktop").named.spelled())
        assertEquals("Claude", ProposalSource(connection = "Claude Desktop", agent = "Claude").named.spelled())
    }

    @Test
    fun testAProposalMintedInCoachSaysSo() {
        assertEquals("Coach", ProposalSource(door = "ask").named.spelled())
        assertEquals("Claude", ProposalSource(door = "ask", agent = "Claude").named.spelled())
        assertEquals("your connected agent", ProposalSource(door = "mcp").named.spelled())
        assertEquals("a door this build has never heard of is somebody's own agent",
            "your connected agent", ProposalSource(door = "carrier-pigeon").named.spelled())
    }

    @Test
    fun testTheKickerAttributesTheProseByWhoWroteIt() {
        assertEquals("Coach wrote:", ProposalSource(door = "ask").wrote.spelled())
        assertEquals("Claude Desktop wrote:", ProposalSource(door = "mcp", agent = "Claude Desktop").wrote.spelled())
        assertEquals("Claude Desktop wrote:", ProposalSource(door = "mcp", connection = "Claude Desktop").wrote.spelled())
        assertEquals("Your agent wrote:", ProposalSource(door = "mcp").wrote.spelled())
        assertEquals("Your agent wrote:", ProposalSource(door = "mcp", agent = " ").wrote.spelled())
        assertEquals("Your agent wrote:", ProposalSource(door = "mcp", agent = "", connection = " ").wrote.spelled())
        assertEquals("the agent's own name outranks the connection's",
            "Claude Desktop wrote:", ProposalSource(door = "mcp", agent = "Claude Desktop", connection = "Claude Code").wrote.spelled())
        assertEquals("the sheet reads it off the proposal", "Coach wrote:",
            proposal(source = ProposalSource(door = "ask")).source.wrote.spelled())
    }

    @Test
    fun testTheReceiptIsDerivedFromTheServersReplyAndNeverFromTheProse() {
        val applied = """{"id":"prop_1","routineId":"rt_1","intent":"revise","state":"applied",
            "summary":"the model said twelve things","changeCount":4,"createdAt":1000,"settledAt":2000,
            "source":{"agent":"Claude"},"baseName":"Push A","name":"Push A"}"""
        fun decoded(wire: String) = WindmillJson.decodeFromString<Proposal>(wire)

        assertEquals(ProposalReceipt(applied = true, Words.Plain("Applied · Push A · 4 changes")), decoded(applied).settledReceipt.spelled())
        assertEquals(ProposalReceipt(applied = true, Words.Plain("Applied · Push Day · 1 change")), decoded(applied
            .replace(""""name":"Push A"""", """"name":"Push Day"""")
            .replace(""""changeCount":4""", """"changeCount":1""")).settledReceipt.spelled())
        assertEquals(ProposalReceipt(applied = true, Words.Plain("Applied · Push A · routine removed")),
            decoded(applied.replace("revise", "remove")).settledReceipt.spelled())
        assertEquals(ProposalReceipt(applied = false, Words.Plain("Turned down · nothing changed.")),
            decoded(applied.replace("applied", "dismissed")).settledReceipt.spelled())
        assertNull(decoded(applied.replace("applied", "pending")).settledReceipt)
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
    fun testASchemeThatChangedShapePrintsBothSchemesAndNothingElseThatHeld() {
        val moved = Proposal.moves(
            before = targets(5, 5, 80.0),
            after = ProposalTargets(sets = lowerARamp))

        assertEquals(listOf(FieldMove(Words.Plain("sets"), Words.Plain("5 × 5 · 80"), Words.Plain("5 × 1–5 · 60–100"), scheme = true)), moved.map { it.spelled() })
        assertEquals("nothing moved", emptyList<FieldMove>(),
            Proposal.moves(targets(5, 5, 82.5), targets(5, 5, 82.5)))
    }

    @Test
    fun testASchemeWhoseShapeHeldAndWhoseOneSetMovedPrintsThatSet() {
        val heavierTop = ProposalTargets(sets = lowerARamp.mapIndexed { index, set ->
            if (index == 3) SetTarget(1, 102.5) else set
        })

        assertEquals(listOf(FieldMove(Words.Plain("set 4"), Words.Plain("100 × 1"), Words.Plain("102.5 × 1"))),
            Proposal.moves(ProposalTargets(sets = lowerARamp), heavierTop).map { it.spelled() })
        assertEquals("two sets moved is a shape change again",
            listOf(FieldMove(Words.Plain("sets"), Words.Plain("5 × 5 · 82.5"), Words.Plain("5 × 5 · 82.5–87.5"), scheme = true)),
            Proposal.moves(targets(5, 5, 82.5), ProposalTargets(sets = List(5) { SetTarget(5, if (it < 3) 82.5 else 87.5) })).map { it.spelled() })
        assertEquals("a sixth set is a shape change",
            listOf(FieldMove(Words.Plain("sets"), Words.Plain("5 × 5 · 82.5"), Words.Plain("6 × 5 · 82.5"), scheme = true)),
            Proposal.moves(targets(5, 5, 82.5), targets(6, 5, 82.5)).map { it.spelled() })
    }

    @Test
    fun testALoadThatOnlyMovedInFloatingPointDidNotMove() {
        assertTrue(Proposal.moves(targets(5, 5, 82.5), targets(5, 5, 82.500000001)).isEmpty())
        assertEquals(listOf(FieldMove(Words.Plain("sets"), Words.Plain("5 × 5 · 82.5"), Words.Plain("5 × 5 · 82.51"), scheme = true)),
            Proposal.moves(targets(5, 5, 82.5), targets(5, 5, 82.51)).map { it.spelled() })
        assertEquals(listOf(FieldMove(Words.Plain("set 1"), Words.Plain("82.5 × 5"), Words.Plain("82.51 × 5"))),
            Proposal.moves(targets(1, 5, 82.5), targets(1, 5, 82.51)).map { it.spelled() })
    }

    @Test
    fun testAnAbsentTargetIsSaidRatherThanLeftBlank() {
        assertEquals(
            listOf(FieldMove(Words.Plain("sets"), Words.Plain("3 × max"), Words.Plain("3 × 8"), scheme = true)),
            Proposal.moves(targets(3, null), targets(3, 8)).map { it.spelled() })
        assertEquals(
            listOf(FieldMove(Words.Plain("sets"), Words.Plain("3 × 8"), Words.Plain("3 × 8 · 60"), scheme = true)),
            Proposal.moves(targets(3, 8), targets(3, 8, 60.0)).map { it.spelled() })
        assertEquals(
            listOf(FieldMove(Words.Plain("sets"), Words.Plain("open"), Words.Plain("3 × 8 · 60"), scheme = true)),
            Proposal.moves(ProposalTargets(), targets(3, 8, 60.0)).map { it.spelled() })
        assertEquals(emptyList<FieldMove>(), Proposal.moves(targets(3, 8, 60.0), targets(3, 8, 60.0)))
        assertEquals("sets", string(R.string.gym_proposal_sets))
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
    fun testTheButtonAndTheAtomicLineAgreeAtEveryCount() {
        val four = proposal(changeCount = 4)
        assertEquals("Apply all 4", four.applying.spelled())
        assertEquals("All four or none. Nothing is applied until you tap.", four.atomic.spelled())

        val one = proposal(changeCount = 1)
        assertEquals("Apply", one.applying.spelled())
        assertEquals("Nothing is applied until you tap.", one.atomic.spelled())

        assertEquals("Apply all 2", proposal(changeCount = 2).applying.spelled())

        assertEquals("All 14 or none. Nothing is applied until you tap.",
            proposal(changeCount = 14).atomic.spelled())
    }

    @Test
    fun testARemovalIsNamedRatherThanCounted() {
        val removal = proposal(intent = ProposalIntent.Remove, changeCount = 6, baseName = "Push B")

        assertEquals("a removal", removal.counting.spelled())
        assertEquals(ProposalReceipt(applied = true, Words.Plain("Applied · Push B · routine removed")),
            removal.copy(state = ProposalState.Applied).settledReceipt.spelled())
        assertEquals("Remove Push B", removal.applying.spelled())
        assertEquals("The routine goes and your logged sets stay. Nothing is removed until you tap.",
            removal.atomic.spelled())
        assertEquals("A proposal to remove Push B.",
            removal.copy(summary = "").summarized(Words.Plain("Push B")).spelled())
    }

    @Test
    fun testACardWithNoSummarySaysTheCountAndNeverInventsASentence() {
        assertEquals("3 changes to Push A.", proposal(changeCount = 3).copy(summary = "").summarized(Words.Plain("Push A")).spelled())
        assertEquals("1 change to Push A.", proposal(changeCount = 1).copy(summary = "").summarized(Words.Plain("Push A")).spelled())
        assertEquals("the agent's own words win", "Four weeks of heavier bench triples.",
            proposal(changeCount = 3).summarized(Words.Plain("Push A")).spelled())
    }

    @Test
    fun testARemovedLineSpellsItself() {
        val routine = Words.Message(R.string.gym_proposal_the_routine)
        val gone = ProposalChange(position = 4, kind = ChangeKind.Removed, exerciseId = "cable-fly",
            before = targets(3, 12, 22.5), loggedSets = 41)
        assertEquals("removed from the routine · 41 logged sets kept", gone.removed(routine).spelled())
        assertEquals("removed from the routine · 1 logged set kept", gone.copy(loggedSets = 1).removed(routine).spelled())
        assertEquals("removed from the routine · never logged", gone.copy(loggedSets = 0).removed(routine).spelled())
        assertEquals("a count the log did not send is not a zero", "removed from the routine",
            gone.copy(loggedSets = null).removed(routine).spelled())
    }

    @Test
    fun testASettledProposalSaysWhatHappenedAndAPendingOneSaysNothing() {
        val settled = threeDaysAgoMs
        val on = "29 Jul at ${Readout.time(settled)}"
        assertEquals(
            "Applied to Push A $on.",
            proposal(state = ProposalState.Applied, settledAtMs = settled).settled(nowMs).spelled())
        assertEquals(
            "Turned down $on. Nothing changed.",
            proposal(state = ProposalState.Dismissed, settledAtMs = settled).settled(nowMs).spelled())
        assertEquals(
            "Push A changed after this was written, so it was set aside $on. None of it was applied.",
            proposal(state = ProposalState.Superseded, settledAtMs = settled).settled(nowMs).spelled())
        assertTrue(proposal(state = ProposalState.Dismissed, settledAtMs = nowMs)
            .settled(nowMs).spelled()!!.startsWith("Turned down today at ${Readout.time(nowMs)}."))
        assertNull(proposal().settled(nowMs))
        assertNull(proposal(state = ProposalState.Applied).settled(nowMs))
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
                "before":{"sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5}],"restSeconds":180},
                "after":{"sets":[{"reps":5,"weightKg":82.5},{"reps":3,"weightKg":87.5}],"restSeconds":180}},
               {"position":2,"kind":"kept","exerciseId":"overhead-press",
                "before":{"sets":[{"reps":8,"weightKg":45}]},"after":{"sets":[{"reps":8,"weightKg":45}]}},
               {"position":3,"kind":"added","exerciseId":"incline-db-press",
                "after":{"sets":[{"reps":10,"weightKg":24},{"reps":10,"weightKg":24}]}},
               {"position":4,"kind":"removed","exerciseId":"cable-fly",
                "before":{"sets":[{"reps":12,"weightKg":22.5}]},"loggedSets":41}]}
        """.trimIndent()

        val whole = WindmillJson.decodeFromString<Proposal>(wire)

        assertEquals(listOf("bench-press", "incline-db-press", "cable-fly"), whole.drawn.map { it.exerciseId })
        assertEquals(ProposalTargets(sets = listOf(SetTarget(5, 82.5), SetTarget(3, 87.5))),
            whole.changes[0].after)
        assertEquals(listOf(FieldMove(Words.Plain("set 2"), Words.Plain("82.5 × 5"), Words.Plain("87.5 × 3"))),
            Proposal.moves(whole.changes[0].before!!, whole.changes[0].after!!).map { it.spelled() })
        assertNull("an added line has no before", whole.changes[2].before)
        assertEquals("overhead-press", whole.landsAfter(whole.changes[2]))
        assertNull("a removed line has no after", whole.changes[3].after)
        assertEquals(41, whole.changes[3].loggedSets)
        assertNull("only a removal keeps sets", whole.changes[0].loggedSets)
        assertEquals("your connected agent", whole.source.named.spelled())
        assertFalse(whole.renames)
    }

    // Apply is shut until the diff has been read to its end, and a refusal that only says no is a
    // defect: the sentence names the way out. The same bytes on all three surfaces.
    @Test
    fun testTheShutGateSaysWhyAndNamesTheWayOut() {
        assertEquals("Scroll to the end to apply.", string(R.string.gym_proposal_apply_hint))
        assertTrue("twelve words or fewer, which is the refusal row's budget",
            string(R.string.gym_proposal_apply_hint).split(" ").size <= 12)
    }

    @Test
    fun testTurningDownIsConfirmedInTheSameWordsAsEverySurface() {
        assertEquals("Turn this down", string(R.string.gym_proposal_turn_down_verb))
        assertEquals("Turn this down?", string(R.string.gym_proposal_turn_down_ask))
        assertEquals("Nothing changes.", string(R.string.gym_proposal_turn_down_body))
        assertEquals("Turn down", string(R.string.gym_proposal_turn_down))
    }

    @Test
    fun testARemovalCarriesItsIntentAndNotAnEmptyDocument() {
        val wire = """
            {"id":"prop_2","routineId":"rt_1","intent":"remove","state":"pending","summary":"",
             "changeCount":1,"createdAt":1700000000000,"baseRevision":1,"baseName":"Push B"}
        """.trimIndent()

        val whole = WindmillJson.decodeFromString<Proposal>(wire)

        assertEquals(ProposalIntent.Remove, whole.intent)
        assertEquals("Push B", whole.routineNamed.spelled())
        assertTrue(whole.summary.isEmpty())
    }

    private fun workoutProposal(changes: List<ProposalChange>, state: ProposalState = ProposalState.Pending) = Proposal(
        id = "wp_1", routineId = "session_1", state = state, changeCount = changes.count { it.kind != ChangeKind.Kept },
        changes = changes, target = ProposalTarget.Workout)

    private val swap = listOf(
        ProposalChange(1, ChangeKind.Kept, "bench-press", targets(3, 5), targets(3, 5)),
        ProposalChange(2, ChangeKind.Added, "floor-press", after = targets(3, 10, 20.0)),
        ProposalChange(3, ChangeKind.Kept, "fly", targets(3, 12), targets(3, 12)),
        ProposalChange(4, ChangeKind.Removed, "incline-press", before = targets(3, 8), loggedSets = 0),
    )

    @Test
    fun aWorkoutProposalIsAddressedToThisWorkoutInEveryLine() {
        val proposal = workoutProposal(swap)
        assertEquals("This workout", proposal.addressed.spelled())
        assertEquals("2 changes to this workout.", proposal.summarized(proposal.routineNamed).spelled())
        assertEquals("Apply all 2", proposal.applying.spelled())
        assertEquals("All two or none. Nothing is applied until you tap.", proposal.atomic.spelled())
        assertEquals("removed from this workout · never logged", swap[3].removed(proposal.landsIn).spelled())
        assertEquals(ProposalReceipt(applied = true, Words.Plain("Applied · this workout · 2 changes")),
            workoutProposal(swap, ProposalState.Applied).settledReceipt.spelled())
        assertEquals(ProposalReceipt(applied = false, Words.Plain("Turned down · nothing changed.")),
            workoutProposal(swap, ProposalState.Dismissed).settledReceipt.spelled())
    }

    @Test
    fun aRoutineProposalStillSpeaksOfTheRoutine() {
        val routine = proposal(swap)
        assertEquals("Push A", routine.addressed.spelled())
        assertEquals("removed from the routine · never logged", swap[3].removed(routine.landsIn).spelled())
    }

    @Test
    fun aMovementLoggedSinceSaysItsSetsStayRatherThanNeverLogged() {
        assertEquals("removed from this workout · 2 logged sets kept", swap[3].copy(loggedSets = 2).removed(Words.Message(R.string.gym_proposal_this_workout)).spelled())
    }

    @Test
    fun aWorkoutsSheetReadsWhatChangesFirstThenOneCountOfWhatStands() {
        val retargeted = ProposalChange(5, ChangeKind.Retargeted, "dip", targets(3, 8), targets(3, 6))
        assertEquals(listOf(
            DocumentRow.Changed(retargeted), DocumentRow.Changed(swap[3]), DocumentRow.Changed(swap[1]),
            DocumentRow.Unchanged(listOf(swap[0], swap[2])),
        ), workoutProposal(swap + retargeted).changesFirst)
        assertEquals("and 2 lines unchanged", (workoutProposal(swap).changesFirst.last() as DocumentRow.Unchanged).said.spelled())
    }

    @Test
    fun aChangeThatKeepsNothingEndsOnItsChanges() {
        assertEquals(listOf(DocumentRow.Changed(swap[3]), DocumentRow.Changed(swap[1])), workoutProposal(listOf(swap[1], swap[3])).changesFirst)
    }

    @Test
    fun whyAProposalIsOutOfDateSaysOneCauseThenThatNothingWasApplied() {
        assertEquals("A newer suggestion replaced this one. Nothing was applied.", Stale("replaced", null).why.spelled())
        assertEquals("This workout changed after this suggestion. Nothing was applied.", Stale("workout-changed", null).why.spelled())
        assertEquals("This workout has finished. Nothing was applied.", Stale("workout-finished", null).why.spelled())
        assertEquals("You logged Incline Dumbbell Press since this suggestion. Nothing was applied.", Stale("workout-moved", "Incline Dumbbell Press").why.spelled())
        assertEquals("You logged a movement since this suggestion. Nothing was applied.", Stale("workout-moved", null).why.spelled())
    }
}

private fun FieldMove.spelled() = copy(field = field.plain(), was = was.plain(), becomes = becomes.plain())

private fun ProposalReceipt?.spelled() = this?.copy(words = words.plain())
