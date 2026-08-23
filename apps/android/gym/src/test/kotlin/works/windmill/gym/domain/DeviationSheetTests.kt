package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private fun aSet(exerciseId: String, weightKg: Double, kind: SetKind = SetKind.Working,
                 at: Long = 1_000): TrainingSet =
    TrainingSet(id = "set_${exerciseId}_${weightKg.toInt()}_$at", exerciseId = exerciseId,
                weightKg = weightKg, reps = 5, kind = kind, completedAtMs = at)

private val pushA = Session(
    id = "ses_1", startedAtMs = 1_000, routineId = "rt_push_a",
    plan = PlanSnapshot(routine = "Push A", entries = listOf(
        PlanEntry(exerciseId = "bench-press", sets = 5, reps = 5, weightKg = 82.5),
        PlanEntry(exerciseId = "chin-up", sets = 3, reps = 8),
    ))
)

class DeviationTests {
    @Test
    fun testAHeavierWorkingSetRaisesTheOfferAgainstThePlansWeight() {
        val deviation = DeviationOffer.leaving("bench-press", session = pushA,
                                               sets = listOf(aSet("bench-press", 82.5),
                                                             aSet("bench-press", 87.5, at = 2_000)),
                                               asked = emptySet())
        assertEquals(82.5, deviation?.plannedKg)
        assertEquals(87.5, deviation?.liftedKg)
        assertEquals("Push A", deviation?.routine)
        assertEquals("rt_push_a", deviation?.routineId)
        assertEquals("the plan's first line is the routine's position 1", 1, deviation?.position)
        assertEquals("Save 87.5 to Push A", deviation?.saveLabel)
        assertEquals("Today’s Bench Press ran at 87.5 against a planned 82.5. "
                     + "Today’s session already has it. Push A does not.",
                     deviation?.sentence(movement = "Bench Press"))
    }

    @Test
    fun testALighterSessionIsNeverOfferedToTheProgram() {
        assertNull(DeviationOffer.leaving("bench-press", session = pushA,
                                          sets = listOf(aSet("bench-press", 75.0)), asked = emptySet()))
    }

    @Test
    fun testMatchingThePlanAsksNothing() {
        assertNull(DeviationOffer.leaving("bench-press", session = pushA,
                                          sets = listOf(aSet("bench-press", 82.5)), asked = emptySet()))
    }

    @Test
    fun testAWarmupOrADropNeverRaisesTheOffer() {
        assertNull(DeviationOffer.leaving("bench-press", session = pushA,
                                          sets = listOf(aSet("bench-press", 100.0, kind = SetKind.Warmup),
                                                        aSet("bench-press", 100.0, kind = SetKind.Drop, at = 2_000),
                                                        aSet("bench-press", 100.0, kind = SetKind.Failure, at = 3_000)),
                                          asked = emptySet()))
    }

    @Test
    fun testAMovementAlreadyAskedAboutIsNotAskedAgain() {
        assertNull(DeviationOffer.leaving("bench-press", session = pushA,
                                          sets = listOf(aSet("bench-press", 87.5)),
                                          asked = setOf("bench-press")))
    }

    @Test
    fun testWithNothingWrittenDownThereIsNothingToChange() {
        val adHoc = Session(id = "ses_2", startedAtMs = 1_000)
        assertNull(DeviationOffer.leaving("bench-press", session = adHoc,
                                          sets = listOf(aSet("bench-press", 87.5)), asked = emptySet()))
        assertNull(DeviationOffer.leaving("chin-up", session = pushA,
                                          sets = listOf(aSet("chin-up", 10.0)), asked = emptySet()))
        assertNull("a movement the plan never named cannot have been deviated from",
                   DeviationOffer.leaving("cable-fly", session = pushA,
                                          sets = listOf(aSet("cable-fly", 30.0)), asked = emptySet()))
    }

    @Test
    fun testTheOfferCarriesTheHeaviestWorkingSetAndNotTheLast() {
        val deviation = DeviationOffer.leaving("bench-press", session = pushA,
                                               sets = listOf(aSet("bench-press", 90.0, at = 2_000),
                                                             aSet("bench-press", 85.0, at = 3_000)),
                                               asked = emptySet())
        assertEquals(90.0, deviation?.liftedKg)
    }

    @Test
    fun testAMovementPlannedTwiceIsMeasuredAgainstItsHeaviestLine() {
        val topAndBackOff = Session(
            id = "ses_3", startedAtMs = 1_000, routineId = "rt_push_b",
            plan = PlanSnapshot(routine = "Push B", entries = listOf(
                PlanEntry(exerciseId = "overhead-press", sets = 3, reps = 8, weightKg = 45.0),
                PlanEntry(exerciseId = "bench-press", sets = 3, reps = 8, weightKg = 80.0),
                PlanEntry(exerciseId = "bench-press", sets = 1, reps = 3, weightKg = 100.0),
            ))
        )

        val deviation = DeviationOffer.leaving("bench-press", session = topAndBackOff,
                                               sets = listOf(aSet("bench-press", 105.0),
                                                             aSet("bench-press", 82.5, at = 2_000)),
                                               asked = emptySet())
        assertEquals(
            DeviationOffer(exerciseId = "bench-press", routineId = "rt_push_b", routine = "Push B",
                           position = 3, plannedKg = 100.0, liftedKg = 105.0),
            deviation)

        assertNull("beating only the back-off is not a deviation from the program",
                   DeviationOffer.leaving("bench-press", session = topAndBackOff,
                                          sets = listOf(aSet("bench-press", 90.0)), asked = emptySet()))
    }
}
