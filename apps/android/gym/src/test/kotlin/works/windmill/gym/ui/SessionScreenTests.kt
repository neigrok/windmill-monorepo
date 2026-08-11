package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet

// A session read back is the workout as it was LIVED: movements in the order they were first
// touched, sets inside a movement in the order they were performed. Nothing here re-sorts by load,
// by number or by name — an order that disagreed with the session would be a second account of it.
//
// And beside every set, what the FROZEN plan asked for. The snapshot is the only source: a routine
// retargeted since must not rewrite what the log says about a session that already happened.

class SessionScreenTests {
    private val catalog = listOf(
        Exercise(id = "bench-press", name = "Bench press"),
        Exercise(id = "row", name = "Barbell row"),
    )

    private fun set(
        id: String,
        exerciseId: String,
        weightKg: Double,
        reps: Int,
        at: Long,
        kind: SetKind = SetKind.Working,
    ) = TrainingSet(id = id, exerciseId = exerciseId, weightKg = weightKg,
                    reps = reps, kind = kind, completedAtMs = at)

    private fun plan(vararg entries: PlanEntry) = PlanSnapshot(routine = "Push A", entries = entries.toList())

    private fun notes(movement: Performed.Movement) = movement.rows.map { it.note?.text }

    private fun line(movement: Performed.Movement) =
        (movement.against as? Performed.Against.Plan)?.line

    // Interleaved on the clock — a lifter supersetting two movements — and grouped on screen, with
    // the movement order taken from when each was FIRST touched.
    @Test
    fun setsAreGroupedByMovementInTheOrderTheyWereFirstTouched() {
        val movements = Performed.movements(listOf(
            set("s4", "row", 60.0, 10, at = 4_000),
            set("s1", "bench-press", 80.0, 5, at = 1_000),
            set("s3", "bench-press", 82.5, 5, at = 3_000),
            set("s2", "row", 60.0, 10, at = 2_000),
        ), catalog)

        assertEquals(listOf("Bench press", "Barbell row"), movements.map { it.movement })
        assertEquals(listOf("s1", "s3"), movements[0].rows.map { it.id })
        assertEquals(listOf("s2", "s4"), movements[1].rows.map { it.id })
        assertEquals(listOf("80 × 5", "82.5 × 5"), movements[0].rows.map { it.effort })
    }

    // A set the plan never asked for is not measured against it and still says what it was: only a
    // WORKING set is read against a target, because only a working set counts toward one.
    @Test
    fun onlyAWorkingSetIsReadAgainstThePlan() {
        val movements = Performed.movements(listOf(
            set("s1", "bench-press", 40.0, 8, at = 1_000, kind = SetKind.Warmup),
            set("s2", "bench-press", 80.0, 5, at = 2_000),
            set("s3", "bench-press", 80.0, 3, at = 3_000, kind = SetKind.Failure),
        ), catalog, plan(PlanEntry(exerciseId = "bench-press", sets = 3, reps = 5, weightKg = 80.0)))

        assertEquals(listOf(SetKind.Warmup, SetKind.Working, SetKind.Failure),
                     movements[0].rows.map { it.kind })
        assertEquals(listOf("40 × 8", "80 × 5", "80 × 3"), movements[0].rows.map { it.effort })
        assertEquals("a set taken to failure is not two reps short of anything",
                     listOf("warmup", "on plan", "failure"), notes(movements[0]))
    }

    // THE WHOLE OF §G17: what the plan said beside what was done, fail-fast in the order the facts
    // outrank each other. A set that is both heavier and short reads as HEAVIER — the load is the
    // claim the plan makes, and two clauses on one row is the scolding this screen refuses.
    @Test
    fun aSetIsReadAgainstTheFrozenPlansTargetInOneLine() {
        val movements = Performed.movements(listOf(
            set("s1", "bench-press", 82.5, 5, at = 1_000),
            set("s2", "bench-press", 85.0, 5, at = 2_000),
            set("s3", "bench-press", 80.0, 5, at = 3_000),
            set("s4", "bench-press", 82.5, 3, at = 4_000),
            set("s5", "bench-press", 85.0, 3, at = 5_000),
        ), catalog, plan(PlanEntry(exerciseId = "bench-press", sets = 4, reps = 5, weightKg = 82.5)))

        assertEquals("plan 5 × 82.5", line(movements[0]))
        assertEquals(
            "the word carries the direction, so the number beside it is a magnitude — " +
                "\"−2.5 under plan\" says the opposite of what happened",
            listOf("on plan", "+2.5 over plan", "2.5 under plan", "two short", "+2.5 over plan"),
            notes(movements[0]),
        )
        assertEquals("only the shortfall is drawn one step brighter",
                     listOf(false, false, false, true, false),
                     movements[0].rows.map { it.note?.short ?: false })
    }

    // A movement the session added is named as added — once, on the first set that COUNTS, because
    // the header above already says it was not in the plan and a per-row repeat would be scolding
    // somebody for work they chose to do.
    @Test
    fun aMovementTheSessionAddedIsNamedOnceAndNeverMeasured() {
        val movements = Performed.movements(listOf(
            set("s1", "row", 40.0, 10, at = 1_000, kind = SetKind.Warmup),
            set("s2", "row", 60.0, 10, at = 2_000),
            set("s3", "row", 60.0, 9, at = 3_000),
        ), catalog, plan(PlanEntry(exerciseId = "bench-press", sets = 3, reps = 5, weightKg = 82.5)))

        assertEquals(Performed.Against.Unplanned, movements[0].against)
        assertEquals(listOf("warmup", "added today", null), notes(movements[0]))
    }

    // A PlanEntry carries no id, so the same movement written twice in one routine — a heavy triple
    // and a back-off set — cannot be matched to the set in front of us. Nothing is annotated rather
    // than annotating against whichever line came first: a wrong "on plan" is a worse answer than
    // no answer at all.
    @Test
    fun aMovementThePlanNamesTwiceIsAnnotatedWithNothing() {
        val movements = Performed.movements(listOf(
            set("s1", "bench-press", 100.0, 3, at = 1_000),
            set("s2", "bench-press", 80.0, 8, at = 2_000),
        ), catalog, plan(
            PlanEntry(exerciseId = "bench-press", sets = 1, reps = 3, weightKg = 100.0),
            PlanEntry(exerciseId = "bench-press", sets = 3, reps = 8, weightKg = 80.0),
        ))

        assertEquals(Performed.Against.Silent, movements[0].against)
        assertEquals(listOf(null, null), notes(movements[0]))
    }

    // A session nobody planned is measured against nothing at all. A movement the plan asked for
    // without a load — a chin-up, written `3 × max` — is measured only on the axis it named, and
    // every set of it is on plan, because "max" is whatever the movement gives that day.
    @Test
    fun aSessionWithNoPlanIsMeasuredAgainstNothingAndMaxRepsIsAlwaysMet() {
        val unplanned = Performed.movements(listOf(set("s1", "row", 60.0, 10, at = 1_000)), catalog)
        assertEquals(Performed.Against.Silent, unplanned[0].against)
        assertEquals(listOf(null), notes(unplanned[0]))

        val openEnded = Performed.movements(
            listOf(set("s1", "row", 0.0, 9, at = 1_000), set("s2", "row", 0.0, 7, at = 2_000)),
            catalog,
            plan(PlanEntry(exerciseId = "row", sets = 3, reps = null, weightKg = null)),
        )
        assertEquals("plan max reps", line(openEnded[0]))
        assertEquals(listOf("on plan", "on plan"), notes(openEnded[0]))
    }

    // The catalog has not answered yet, or never will: a slug a lifter can still recognise beats a
    // blank where the movement should be. The same fallback the whole product uses.
    @Test
    fun aMovementTheCatalogHasNoNameForKeepsItsId() {
        val movements = Performed.movements(listOf(set("s1", "zercher-squat", 60.0, 5, at = 1_000)),
                                            catalog)

        assertEquals(listOf("zercher-squat"), movements.map { it.movement })
        assertEquals(listOf("zercher-squat"), movements.map { it.id })
    }

    @Test
    fun aSessionWithNoSetsGroupsIntoNothing() {
        assertEquals(emptyList<Performed.Movement>(), Performed.movements(emptyList(), catalog))
    }
}
