package works.windmill.gym.domain

import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// §M's rules, which are the two this wave turns on: a routine built at home has NO history, so
// nothing here reaches for one; and a row with no set target is a first-class answer that survives
// the whole path — the draft, the wire, and the sentence the routine's own page makes out of it.

private val json = Json { ignoreUnknownKeys = true }

// A local instant, so a test does not assert a date the machine's zone would move.
private fun at(year: Int, month: Int, day: Int, hour: Int = 9): Long =
    ZonedDateTime.of(year, month, day, hour, 0, 0, 0, ZoneId.systemDefault()).toInstant().toEpochMilli()

class ProgramTests {
    @Test
    fun testTheNameCapRefusesTheOverflowAndKeepsEverythingAlreadyTyped() {
        val sixty = "a".repeat(60)
        assertEquals(sixty, Program.capped(sixty))
        assertEquals("the 61st character is refused, the first sixty stand", sixty, Program.capped(sixty + "b"))
        assertEquals("60/60", Program.counter(sixty))
        assertEquals("14/60", Program.counter("Heavy Thursday"))
    }

    // The cap is a promise about CHARACTERS. An emoji is one character to the person typing it and
    // two UTF-16 units to the machine, and a counter that read 2/60 for one glyph would be the room
    // arguing with the keyboard.
    @Test
    fun testTheCounterCountsCharactersAndNotUtf16Units() {
        assertEquals("2/60", Program.counter("💪A"))
        val wide = "💪".repeat(30)
        assertEquals("30/60", Program.counter(wide))
        assertEquals("the 31st emoji still fits", 31, Program.length(Program.capped(wide + "💪")))
        assertEquals("and the 61st does not", 60, Program.length(Program.capped("💪".repeat(61))))
    }

    @Test
    fun testANameIsTrimmedAndAnEmptyOneIsNotAName() {
        assertEquals("Heavy Thursday", Program.named("  Heavy Thursday  "))
        assertNull(Program.named("   "))
        assertNull(Program.named(""))
    }

    // A RENAME TO THE NAME IT ALREADY HAS IS NOT A RENAME, and on a routine it is not free either:
    // the write is the whole document, so it moves the revision and supersedes the proposal sitting
    // on that day. Opening the sheet, changing nothing and tapping the accent word would have cost
    // an agent's diff — so the sheet has nothing to do and its button says so.
    @Test
    fun testARenameToTheSameNameIsNotAChangeAndIsNotOffered() {
        assertNull(Program.renamed("Push A", "Push A"))
        assertNull("the trimmed name is the one that would be written", Program.renamed("Push A", "  Push A  "))
        assertNull(Program.renamed("Push A", "   "))
        assertEquals("Push B", Program.renamed("Push A", " Push B "))
        assertEquals("case is a change: it is the lifter's own spelling", "PUSH A",
            Program.renamed("Push A", "PUSH A"))
    }

    // The fact under the list, and it says nothing at all where there is nothing to say — never a
    // reassurance that a complete routine is complete.
    @Test
    fun testTheOpenLineNamesEveryRowThatWillAskAtTheRack() {
        assertNull(Program.openLine(emptyList()))
        assertEquals("Barbell Row has no target — it will ask at the rack.",
            Program.openLine(listOf("Barbell Row")))
        assertEquals("Deadlift and Barbell Row have no targets — they will ask at the rack.",
            Program.openLine(listOf("Deadlift", "Barbell Row")))
        assertEquals("Deadlift, Barbell Row and Chin Up have no targets — they will ask at the rack.",
            Program.openLine(listOf("Deadlift", "Barbell Row", "Chin Up")))
    }

    // `untested` is DERIVED: no last-trained instant is a routine nobody has run, and the day the
    // first session starts the word goes on its own. There is no flag to keep true.
    //
    // THE HISTORY IS HANDED IN, and that is the whole of why this line ever reaches the glass: the
    // routine on screen 30 came off the LIST read, which carries no history at all, so a head that
    // read `routine.history` drew the fallback every single time and the board's line never once.
    @Test
    fun testAnUntestedRoutineSaysWhenItWasBuiltAndATrainedOneSaysWhenItRan() {
        val now = at(2026, 8, 10)
        val built = Routine(id = "rt_1", name = "Heavy Thursday",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "deadlift")))
        val history = listOf(RoutineEvent(kind = "created", atMs = at(2026, 8, 9), movements = 4))

        val head = Program.head(built, history, now)
        assertTrue(head.untested)
        assertEquals("built yesterday · 4 movements", head.line)

        // The count is the one the day was BUILT with and never today's, which is a different number
        // the moment a movement is added.
        assertEquals(1, built.entries.size)

        val trained = built.copy(lastTrainedAtMs = at(2026, 8, 9))
        val ran = Program.head(trained, history, now)
        assertFalse(ran.untested)
        assertEquals("1 movement · trained yesterday", ran.line)
    }

    // A routine made before the count was stored draws the row without one — never today's entry
    // count dressed as the day it was built with.
    @Test
    fun testARoutineWithNoStoredCountSaysWhatItHoldsAndNothingItCannotKnow() {
        val now = at(2026, 8, 10)
        val old = Routine(id = "rt_1", name = "Push A",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5),
                             RoutineEntry(position = 2, exerciseId = "chin-up")))

        assertEquals("built 1 Jun · 2 movements",
            Program.head(old, listOf(RoutineEvent(kind = "created", atMs = at(2026, 6, 1))), now).line)
    }

    // Signed out, on a routine the shelf still holds, and on every frame before the routine read
    // lands: there is no created row to date the day with — so the head falls back to what the lists
    // print rather than inventing a build date this device does not have.
    @Test
    fun testWithNoCreatedRowTheHeadFallsBackToWhatTheListsPrint() {
        val now = at(2026, 8, 10)
        val shelved = Routine(id = "rt_1", name = "Push A",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5)))

        val head = Program.head(shelved, emptyList(), now)
        assertTrue(head.untested)
        assertEquals("a routine holds movements, never exercises — the 13 Aug vocabulary lock",
            "1 movement · never trained", head.line)
    }

    // `created by you` IS THE ABSENCE OF `by`. `create_routine` lands immediately over MCP, so a row
    // that named the lifter's own hand over an agent-typed day would be putting words in their mouth.
    @Test
    fun testAHistoryRowNamesWhoseHandItWasFromTheAbsenceOfBy() {
        val now = at(2026, 8, 10)
        assertEquals("9 Aug · created by you · 4 movements",
            RoutineEvent(kind = "created", atMs = at(2026, 8, 9), movements = 4).line(now))
        assertEquals("9 Aug · created by an agent · 4 movements",
            RoutineEvent(kind = "created", atMs = at(2026, 8, 9), by = "mcp", movements = 4).line(now))
        assertEquals("9 Aug · created by you",
            RoutineEvent(kind = "created", atMs = at(2026, 8, 9)).line(now))
    }

    // A kind this build has never heard of draws NOTHING. A row it cannot name is a row it cannot
    // describe, and a fallback that picked either sentence would date somebody's program with a guess.
    @Test
    fun testAnEventThisBuildCannotNameDrawsNoRowAtAll() {
        assertNull(RoutineEvent(kind = "merged", atMs = 1_000).line(2_000))
        assertNull("a proposal row with no proposal on it has nothing to say",
            RoutineEvent(kind = "proposal", atMs = 1_000).line(2_000))
    }

    // THE DRAFT. A movement lands open, and `Leave it open` clears the WHOLE row — the log refuses a
    // half-open line, and a row reading `open` beside a weight it still carried would be two answers
    // to one question.
    @Test
    fun testLeavingARowOpenClearsEveryTargetOnIt() {
        val draft = RoutineDraft(name = "Heavy Thursday")
            .adding("back-squat")
            .adding("deadlift")
            .targeting("deadlift", sets = 3, reps = 5, weightKg = 140.0)

        assertEquals(RoutineEntry(position = 2, exerciseId = "deadlift", targetSets = 3,
            targetReps = 5, targetWeightKg = 140.0), draft.entry("deadlift"))

        val opened = draft.opening("deadlift")
        assertEquals(RoutineEntry(position = 2, exerciseId = "deadlift"), opened.entry("deadlift"))
        assertNull(opened.entry("deadlift")?.targetSets)
        assertNull(opened.entry("deadlift")?.targetReps)
        assertNull(opened.entry("deadlift")?.targetWeightKg)
    }

    // A target lands on the LADDER's grid, so a weight typed at the kitchen table and the same
    // weight dialled at the rack are the same number.
    @Test
    fun testATypedTargetIsRoundedOnTheLaddersOwnGrid() {
        val draft = RoutineDraft(name = "Push A").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 5, weightKg = 82.499999999999996)
        assertEquals(82.5, draft.entry("bench-press")?.targetWeightKg)
    }

    @Test
    fun testAMovementIsNotAddedTwiceAndTheDayHasACeiling() {
        val twice = RoutineDraft(name = "Push A").adding("bench-press").adding("bench-press")
        assertEquals(1, twice.entries.size)

        var full = RoutineDraft(name = "Everything")
        repeat(Program.maxEntries + 5) { full = full.adding("ex_$it") }
        assertEquals(Program.maxEntries, full.entries.size)
        assertTrue(full.full)
    }

    // Removing renumbers, because the position of a line IS its place in the day and the wire takes
    // the list in order.
    @Test
    fun testRemovingAMovementRenumbersTheDay() {
        val draft = RoutineDraft(name = "Push A")
            .adding("bench-press").adding("deadlift").adding("chin-up")
            .removing("deadlift")

        assertEquals(listOf("bench-press" to 1, "chin-up" to 2),
            draft.entries.map { it.exerciseId to it.position })
        assertEquals(listOf(2, 2), listOf(draft.placeOf("chin-up"), draft.entries.size))
    }

    @Test
    fun testAnEmptyDayIsNotSavableAndAnIncompleteOneIs() {
        assertFalse("no name, no movements", RoutineDraft().savable)
        assertFalse("a name is not a day", RoutineDraft(name = "Heavy Thursday").savable)
        assertFalse("a day needs a name", RoutineDraft().adding("deadlift").savable)
        assertTrue("one open movement is a routine",
            RoutineDraft(name = "Heavy Thursday").adding("deadlift").savable)
    }

    // THE ENCODER'S LANDMINE, pinned. WindmillJson omits a value equal to its declared default, so an
    // open row must reach the wire as an ABSENT key and a real target must never be dropped.
    @Test
    fun testAnOpenRowTravelsAsAnAbsentKeyAndATargetNeverVanishes() {
        val draft = RoutineDraft(name = "Heavy Thursday")
            .adding("back-squat")
            .adding("barbell-row")
            .targeting("back-squat", sets = 5, reps = 3, weightKg = 110.0)

        val written = json.encodeToString(
            kotlinx.serialization.builtins.ListSerializer(RoutineEntryWrite.serializer()), draft.write)
        assertEquals(
            """[{"exerciseId":"back-squat","targetSets":5,"targetReps":3,"targetWeightKg":110.0},""" +
                """{"exerciseId":"barbell-row"}]""",
            written)
    }

    // An edit carries the whole document — including the id, which is what makes the save a PUT —
    // and a duplicate deliberately carries no name: a copy is a new day, and §M asks for every
    // day's name. The copy is taken off the DRAFT as it stands, so nothing typed tonight is thrown
    // away by making one.
    @Test
    fun testEditCarriesTheDocumentAndDuplicateCarriesEverythingButTheName() {
        val routine = Routine(id = "rt_1", name = "Heavy Thursday", position = 2,
            lastTrainedAtMs = 5_000,
            entries = listOf(
                RoutineEntry(position = 1, exerciseId = "back-squat", targetSets = 5, targetReps = 3),
                RoutineEntry(position = 2, exerciseId = "barbell-row"),
            ))

        val edit = RoutineDraft.of(routine)
        assertEquals("rt_1", edit.id)
        assertEquals("Heavy Thursday", edit.name)
        assertEquals(2, edit.position)
        assertEquals(routine.entries, edit.entries)
        assertTrue("a day that has run does not say it has never been logged", edit.trained)

        val copy = edit.duplicated(position = 7)
        assertNull("a copy is a routine that does not exist yet", copy.id)
        assertEquals("", copy.name)
        assertEquals(7, copy.position)
        assertEquals(routine.entries, copy.entries)
        assertFalse("and a copy has never been trained", copy.trained)
    }

    // A day said the way somebody says one they can still picture — and a DATE the moment a name can
    // no longer place it. `built Sunday` is true on Monday and a lie in September.
    @Test
    fun testARecentDayIsAWeekdayOnlyWhileAWeekdayStillPlacesIt() {
        val monday = at(2026, 8, 10)
        assertEquals("today", Readout.recentDay(monday, monday))
        assertEquals("yesterday", Readout.recentDay(at(2026, 8, 9), monday))
        assertEquals("Saturday", Readout.recentDay(at(2026, 8, 8), monday))
        assertEquals("Tuesday", Readout.recentDay(at(2026, 8, 4), monday))
        assertEquals("8 Aug is seven days back and is a date again",
            "3 Aug", Readout.recentDay(at(2026, 8, 3), monday))
        assertEquals("13 Jul 2025", Readout.recentDay(at(2025, 7, 13), monday))
        // A stamp from the future — a clock that lied once — is a date rather than a weekday nobody
        // has reached yet.
        assertEquals("11 Aug", Readout.recentDay(at(2026, 8, 11), monday))
    }

    // The word `open` is spelled in one place, so four screens cannot invent four words for one
    // absence. An open row carries no reps and no weight, so nothing else is read.
    @Test
    fun testATargetWithNoSetsIsTheWordOpenAndNothingElse() {
        assertEquals("open", Readout.target(null, null, null))
        assertEquals("open", Readout.target(null, 5, 140.0))
        assertEquals("3 × 5 · 140", Readout.target(3, 5, 140.0))
        assertEquals("3 × max", Readout.target(3, null, null))
    }

    // The frozen plan keeps the absence, so the logger's counter has no zero to print.
    @Test
    fun testAnOpenLineFreezesAsAnAbsenceAndTheCounterSaysNoTarget() {
        val routine = Routine(id = "rt_1", name = "Heavy Thursday", entries = listOf(
            RoutineEntry(position = 1, exerciseId = "barbell-row"),
            RoutineEntry(position = 2, exerciseId = "back-squat", targetSets = 5, targetReps = 3),
        ))
        val plan = PlanSnapshot(routine)

        assertEquals(PlanEntry(exerciseId = "barbell-row"), plan.entry("barbell-row"))
        val open = LiveLines.counter(workingSetsToday = 2, planEntry = plan.entry("barbell-row"))
        assertEquals("set 3", open.count)
        assertEquals("no target", open.plan)

        val named = LiveLines.counter(workingSetsToday = 2, planEntry = plan.entry("back-squat"))
        assertEquals("set 3 of 5", named.count)
        assertEquals("plan 5 × 3", named.plan)
    }

    // An open line is a movement the PROGRAM wrote down, so the assembly list must not date it to
    // this afternoon: `just added` belongs to a movement appended on the bench and to no other row.
    @Test
    fun testAnOpenPlanLineIsNotJustAdded() {
        val plan = PlanSnapshot("Heavy Thursday", listOf(PlanEntry(exerciseId = "barbell-row")))
        val rows = LiveLines.assemblyRows(order = listOf("barbell-row"), sets = emptyList(),
            plan = plan, catalog = emptyList(), current = null)

        assertEquals(1, rows.size)
        assertFalse("a written line was not just added", rows.single().justAdded)
        assertNull(rows.single().tag)
    }

    // Nothing on this path reaches for a last time — an open row has no weight, so the number in
    // front of the lifter comes from their own history exactly as it does with no plan at all.
    @Test
    fun testAnOpenRowLeavesThePrefillToTheLog() {
        val history = LastTime(exerciseId = "barbell-row", sets = listOf(
            TrainingSet(id = "set_a", exerciseId = "barbell-row", weightKg = 60.0, reps = 10,
                completedAtMs = 1_000)))
        val prefill = Prefill.of(todaySets = emptyList(),
            planEntry = PlanEntry(exerciseId = "barbell-row"), lastTime = history)

        assertEquals(Prefill(60.0, 10), prefill)
    }

    // THE MID-SESSION RETARGET MAY NOT BUILD A DOCUMENT THE LOG REFUSES. A weight on a row with no
    // sets is a half-open line and is a 400 — so an open row stays open, and the routine keeps
    // saying the thing it now says: decide at the rack.
    @Test
    fun testRetargetingLeavesAnOpenRowOpen() {
        val routine = Routine(id = "rt_1", name = "Heavy Thursday", entries = listOf(
            RoutineEntry(position = 1, exerciseId = "back-squat", targetSets = 5, targetWeightKg = 110.0),
            RoutineEntry(position = 2, exerciseId = "barbell-row"),
        ))

        val moved = routine.retargeting("back-squat", toWeightKg = 115.0)
        assertEquals(115.0, moved.entries.first().targetWeightKg)

        val open = routine.retargeting("barbell-row", toWeightKg = 60.0)
        assertNull("no sets, so no weight — the log would refuse the pair",
            open.entries.last().targetWeightKg)
        assertNull(open.entries.last().targetSets)
    }
}
