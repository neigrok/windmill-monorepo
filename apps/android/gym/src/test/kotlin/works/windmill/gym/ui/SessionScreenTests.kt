package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.PlanEntry
import works.windmill.gym.presentation.PlanSnapshot
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.presentation.SetTarget

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
        ) = TrainingSet(id = id, exerciseId = exerciseId, weightKg = weightKg,
                    reps = reps, completedAtMs = at)

    private fun plan(vararg entries: PlanEntry) = PlanSnapshot(routine = "Push A", entries = entries.toList())

    private fun notes(movement: Performed.Movement) = movement.rows.map { it.note?.text }

    private fun line(movement: Performed.Movement) =
        (movement.against as? Performed.Against.Plan)?.line

    @Test
    fun movementHeadersRetainStoredEquipmentAndItsLoadBasis() {
        val choices = listOf("barbell", "dumbbell", "other", "cable", "kettlebell")
        val catalogue = choices.map { Exercise(id = it, name = it, equipment = it) }
        val movements = Performed.movements(choices.mapIndexed { index, equipment ->
            set("set$index", equipment, -20.0, 8, index.toLong())
        }, catalogue, plan(*choices.map { PlanEntry(exerciseId = it, sets = List(3) { SetTarget(8, -20.0) }) }.toTypedArray()))
        assertEquals(choices, movements.map { it.equipment })
        assertEquals(listOf("Plan 3 × 8 · −20 kg total", "Plan 3 × 8 · −20 kg each", "Plan 3 × 8 · −20 kg",
            "Plan 3 × 8 · −20 kg", "Plan 3 × 8 · −20 kg"), movements.map(::line))
    }

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

    @Test
    fun everySetIsReadAgainstThePlan() {
        val movements = Performed.movements(listOf(
            set("s1", "bench-press", 40.0, 8, at = 1_000),
            set("s2", "bench-press", 80.0, 5, at = 2_000),
            set("s3", "bench-press", 80.0, 3, at = 3_000),
        ), catalog, plan(PlanEntry(exerciseId = "bench-press", sets = List(3) { SetTarget(5, 80.0) })))

        assertEquals(listOf("40 × 8", "80 × 5", "80 × 3"), movements[0].rows.map { it.effort })
        assertEquals(listOf("40 under plan", "on plan", "two short"), notes(movements[0]))
    }

    @Test
    fun aSetIsReadAgainstTheFrozenPlansTargetInOneLine() {
        val movements = Performed.movements(listOf(
            set("s1", "bench-press", 82.5, 5, at = 1_000),
            set("s2", "bench-press", 85.0, 5, at = 2_000),
            set("s3", "bench-press", 80.0, 5, at = 3_000),
            set("s4", "bench-press", 82.5, 3, at = 4_000),
            set("s5", "bench-press", 85.0, 3, at = 5_000),
        ), catalog, plan(PlanEntry(exerciseId = "bench-press", sets = List(4) { SetTarget(5, 82.5) })))

        assertEquals("Plan 4 × 5 · 82.5 kg total", line(movements[0]))
        assertEquals(
            "the word carries the direction, so the number beside it is a magnitude — " +
                "\"−2.5 under plan\" says the opposite of what happened; and the fifth set, past a " +
                "four-set plan, fills no slot and is read against nothing",
            listOf("on plan", "+2.5 over plan", "2.5 under plan", "two short", null),
            notes(movements[0]),
        )
        assertEquals("only the shortfall is drawn one step brighter",
                     listOf(false, false, false, true, false),
                     movements[0].rows.map { it.note?.short ?: false })
    }

    // The plan line is the scheme in the readout formula, and each set is read against the
    // slot it filled: the fourth set against the plan's fourth, never against set 3.
    @Test
    fun aRampIsReadSlotBySlotUnderOnePlanLine() {
        val movements = Performed.movements(listOf(
            set("s1", "bench-press", 60.0, 5, at = 1_000),
            set("s2", "bench-press", 80.0, 5, at = 2_000),
            set("s3", "bench-press", 90.0, 3, at = 3_000),
            set("s4", "bench-press", 102.5, 1, at = 4_000),
            set("s5", "bench-press", 80.0, 4, at = 5_000),
        ), catalog, plan(PlanEntry(exerciseId = "bench-press", sets = listOf(
            SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0)))))

        assertEquals("Plan 5 × 1–5 · 60–100 kg total", line(movements[0]))
        assertEquals(listOf("on plan", "on plan", "on plan", "+2.5 over plan", "one short"), notes(movements[0]))
    }

    // A sixth set under a five-set plan fills no slot: it is read against nothing, neither
    // on plan nor over it.
    @Test
    fun aSetPastThePlanIsReadAgainstNothing() {
        val ramp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))
        val movements = Performed.movements(
            (1..6).map { set("s$it", "bench-press", ramp.getOrNull(it - 1)?.weightKg ?: 120.0, 5, at = it * 1_000L) },
            catalog, plan(PlanEntry(exerciseId = "bench-press", sets = ramp)))

        assertEquals("Plan 5 × 1–5 · 60–100 kg total", line(movements[0]))
        assertEquals(listOf("on plan", "on plan", "on plan", "on plan", "on plan", null), notes(movements[0]))
    }

    @Test
    fun aMovementTheSessionAddedIsNamedOnceAndNeverMeasured() {
        val movements = Performed.movements(listOf(
            set("s1", "row", 40.0, 10, at = 1_000),
            set("s2", "row", 60.0, 10, at = 2_000),
            set("s3", "row", 60.0, 9, at = 3_000),
        ), catalog, plan(PlanEntry(exerciseId = "bench-press", sets = List(3) { SetTarget(5, 82.5) })))

        assertEquals(Performed.Against.Unplanned, movements[0].against)
        assertEquals(listOf("added today", null, null), notes(movements[0]))
    }

    @Test
    fun aMovementThePlanNamesTwiceIsAnnotatedWithNothing() {
        val movements = Performed.movements(listOf(
            set("s1", "bench-press", 100.0, 3, at = 1_000),
            set("s2", "bench-press", 80.0, 8, at = 2_000),
        ), catalog, plan(
            PlanEntry(exerciseId = "bench-press", sets = List(1) { SetTarget(3, 100.0) }),
            PlanEntry(exerciseId = "bench-press", sets = List(3) { SetTarget(8, 80.0) }),
        ))

        assertEquals(Performed.Against.Silent, movements[0].against)
        assertEquals(listOf(null, null), notes(movements[0]))
    }

    @Test
    fun aSessionWithNoPlanIsMeasuredAgainstNothingAndMaxRepsIsAlwaysMet() {
        val unplanned = Performed.movements(listOf(set("s1", "row", 60.0, 10, at = 1_000)), catalog)
        assertEquals(Performed.Against.Silent, unplanned[0].against)
        assertEquals(listOf(null), notes(unplanned[0]))

        val openEnded = Performed.movements(
            listOf(set("s1", "row", 0.0, 9, at = 1_000), set("s2", "row", 0.0, 7, at = 2_000)),
            catalog,
            plan(PlanEntry(exerciseId = "row", sets = List(3) { SetTarget() })),
        )
        assertEquals("Plan 3 × max", line(openEnded[0]))
        assertEquals(listOf("on plan", "on plan"), notes(openEnded[0]))
    }

    @Test
    fun anOpenRowIsMeasuredAgainstNothingAndInventsNoTargetAfterTheFact() {
        val movements = Performed.movements(
            listOf(set("s1", "row", 60.0, 10, at = 1_000), set("s2", "row", 60.0, 8, at = 2_000)),
            catalog,
            plan(PlanEntry(exerciseId = "row")),
        )

        assertEquals(Performed.Against.Silent, movements[0].against)
        assertEquals(listOf(null, null), notes(movements[0]))
    }

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

    @Test
    fun aSetIsNamedByTheLogsOwnNumberAndFallsBackToItsPositionOnly() {
        val numbered = Performed.movements(listOf(
            set("s1", "bench-press", 40.0, 8, at = 1_000).copy(setNumber = 1),
            set("s3", "bench-press", 82.5, 5, at = 3_000).copy(setNumber = 3),
            set("s4", "bench-press", 82.5, 5, at = 4_000).copy(setNumber = 4),
        ), catalog)
        assertEquals("the gap a delete left is the log's own and stands",
                     listOf(1, 3, 4), numbered[0].rows.map { it.number })

        val shelved = Performed.movements(listOf(
            set("s1", "bench-press", 40.0, 8, at = 1_000),
            set("s2", "bench-press", 82.5, 5, at = 2_000),
        ), catalog)
        assertEquals("a session no account has numbered counts from one",
                     listOf(1, 2), shelved[0].rows.map { it.number })
    }

    @Test
    fun everyRowCarriesTheSetItselfSoTheSheetCanEditIt() {
        val logged = set("s1", "bench-press", 82.5, 5, at = 1_000)
            .copy(rpe = 9.5, note = "left shoulder")
        val movements = Performed.movements(listOf(logged), catalog)

        assertEquals(logged, movements[0].rows.single().set)
        assertEquals("s1", movements[0].rows.single().id)
        assertEquals("82.5 × 5", movements[0].rows.single().effort)
    }
}
