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

private val json = Json { ignoreUnknownKeys = true }

private fun at(year: Int, month: Int, day: Int, hour: Int = 9): Long =
    ZonedDateTime.of(year, month, day, hour, 0, 0, 0, ZoneId.systemDefault()).toInstant().toEpochMilli()

class ProgramTests {
    @Test
    fun testTheNameCapRefusesTheOverflowAndKeepsEverythingAlreadyTyped() {
        val sixty = "a".repeat(60)
        assertEquals(sixty, Program.capped(sixty))
        assertEquals("the 61st character is refused, the first sixty stand", sixty, Program.capped(sixty + "b"))
        assertEquals("60/60", Program.counter(sixty))
        assertNull("a name nowhere near the cap counts nothing out loud",
                   Program.counter("Heavy Thursday"))
    }

    // The last fifth and no sooner — the same threshold and the same silence as the note editor's
    // byte counter, because a lifter should not have to learn two rules for one idea.
    @Test
    fun testTheCounterAppearsInTheLastFifthAndIsSilentBeforeIt() {
        assertEquals(48, Program.counterFrom)
        assertNull(Program.counter("a".repeat(47)))
        assertEquals("48/60", Program.counter("a".repeat(48)))
        assertEquals("53/60", Program.counter("a".repeat(53)))
    }

    @Test
    fun testTheCounterCountsCharactersAndNotUtf16Units() {
        assertNull("two characters, whatever their width", Program.counter("💪A"))
        val wide = "💪".repeat(30)
        assertNull("thirty characters is below the threshold, not sixty units", Program.counter(wide))
        assertEquals("50/60", Program.counter("💪".repeat(50)))
        assertEquals("the 31st emoji still fits", 31, Program.length(Program.capped(wide + "💪")))
        assertEquals("and the 61st does not", 60, Program.length(Program.capped("💪".repeat(61))))
    }

    @Test
    fun testANameIsTrimmedAndAnEmptyOneIsNotAName() {
        assertEquals("Heavy Thursday", Program.named("  Heavy Thursday  "))
        assertNull(Program.named("   "))
        assertNull(Program.named(""))
    }

    @Test
    fun testARenameToTheSameNameIsNotAChangeAndIsNotOffered() {
        assertNull(Program.renamed("Push A", "Push A"))
        assertNull("the trimmed name is the one that would be written", Program.renamed("Push A", "  Push A  "))
        assertNull(Program.renamed("Push A", "   "))
        assertEquals("Push B", Program.renamed("Push A", " Push B "))
        assertEquals("case is a change: it is the lifter's own spelling", "PUSH A",
            Program.renamed("Push A", "PUSH A"))
    }

    // The roll-up that named every open row is gone: one sentence, `TargetEntry.openLine`, is drawn
    // once, on the target sheet, and the row's own target column says WHICH row is open.
    @Test
    fun testTheOpenLineIsOneSentenceAndTheRowNamesItselfOpen() {
        assertEquals("You decide the numbers at the rack.", TargetEntry.openLine)
        assertEquals("open", Readout.openTarget)
    }

    @Test
    fun testAnUntestedRoutineSaysWhenItWasBuiltAndATrainedOneSaysWhenItRan() {
        val now = at(2026, 8, 10)
        val built = Routine(id = "rt_1", name = "Heavy Thursday",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "deadlift")))
        val history = listOf(RoutineEvent(kind = "created", atMs = at(2026, 8, 9), movements = 4))

        val head = Program.head(built, history, now)
        assertTrue(head.untested)
        assertEquals("built yesterday · 4 movements", head.line)

        assertEquals(1, built.entries.size)

        val trained = built.copy(lastTrainedAtMs = at(2026, 8, 9))
        val ran = Program.head(trained, history, now)
        assertFalse(ran.untested)
        assertEquals("1 movement · trained yesterday", ran.line)
    }

    @Test
    fun testARoutineWithNoStoredCountSaysWhatItHoldsAndNothingItCannotKnow() {
        val now = at(2026, 8, 10)
        val old = Routine(id = "rt_1", name = "Push A",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5),
                             RoutineEntry(position = 2, exerciseId = "chin-up")))

        assertEquals("built 1 Jun · 2 movements",
            Program.head(old, listOf(RoutineEvent(kind = "created", atMs = at(2026, 6, 1))), now).line)
    }

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

    @Test
    fun testAnEventThisBuildCannotNameDrawsNoRowAtAll() {
        assertNull(RoutineEvent(kind = "merged", atMs = 1_000).line(2_000))
        assertNull("a proposal row with no proposal on it has nothing to say",
            RoutineEvent(kind = "proposal", atMs = 1_000).line(2_000))
    }

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
        assertEquals("11 Aug", Readout.recentDay(at(2026, 8, 11), monday))
    }

    @Test
    fun testATargetWithNoSetsIsTheWordOpenAndNothingElse() {
        assertEquals("open", Readout.target(null, null, null))
        assertEquals("open", Readout.target(null, 5, 140.0))
        assertEquals("3 × 5 · 140", Readout.target(3, 5, 140.0))
        assertEquals("3 × max", Readout.target(3, null, null))
    }

    @Test
    fun testAnOpenLineFreezesAsAnAbsenceAndTheCounterCountsWithoutIt() {
        val routine = Routine(id = "rt_1", name = "Heavy Thursday", entries = listOf(
            RoutineEntry(position = 1, exerciseId = "barbell-row"),
            RoutineEntry(position = 2, exerciseId = "back-squat", targetSets = 5, targetReps = 3),
        ))
        val plan = PlanSnapshot(routine)

        assertEquals(PlanEntry(exerciseId = "barbell-row"), plan.entry("barbell-row"))
        assertEquals("set 3", LiveLines.counter(workingSetsToday = 2, planEntry = plan.entry("barbell-row")))
        assertEquals("set 3 of 5", LiveLines.counter(workingSetsToday = 2, planEntry = plan.entry("back-squat")))
    }

    @Test
    fun testAnOpenPlanLineIsNotJustAdded() {
        val plan = PlanSnapshot("Heavy Thursday", listOf(PlanEntry(exerciseId = "barbell-row")))
        val rows = LiveLines.assemblyRows(order = listOf("barbell-row"), sets = emptyList(),
            plan = plan, catalog = emptyList(), current = null)

        assertEquals(1, rows.size)
        assertFalse("a written line was not just added", rows.single().justAdded)
        assertNull(rows.single().tag)
    }

    @Test
    fun testAnOpenRowLeavesThePrefillToTheLog() {
        val history = LastTime(exerciseId = "barbell-row", sets = listOf(
            TrainingSet(id = "set_a", exerciseId = "barbell-row", weightKg = 60.0, reps = 10,
                completedAtMs = 1_000)))
        val prefill = Prefill.of(todaySets = emptyList(),
            planEntry = PlanEntry(exerciseId = "barbell-row"), lastTime = history)

        assertEquals(Prefill(60.0, 10), prefill)
    }

    @Test
    fun testRetargetingLeavesAnOpenRowOpen() {
        val routine = Routine(id = "rt_1", name = "Heavy Thursday", entries = listOf(
            RoutineEntry(position = 1, exerciseId = "back-squat", targetSets = 5, targetWeightKg = 110.0),
            RoutineEntry(position = 2, exerciseId = "barbell-row"),
        ))

        assertEquals(
            Routine(id = "rt_1", name = "Heavy Thursday", entries = listOf(
                RoutineEntry(position = 1, exerciseId = "back-squat", targetSets = 5, targetWeightKg = 115.0),
                RoutineEntry(position = 2, exerciseId = "barbell-row"),
            )),
            routine.retargeting(1, "back-squat", toWeightKg = 115.0))

        assertNull("no sets, so no weight — the log would refuse the pair, so nothing is written",
            routine.retargeting(2, "barbell-row", toWeightKg = 60.0))
    }
}
