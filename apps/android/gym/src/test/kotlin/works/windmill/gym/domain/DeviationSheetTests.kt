package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The one question gym asks that it did not have to. What is pinned here is mostly what it does NOT
// ask: not without a routine, not about a warmup, not twice, and not when the weight went down.

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
        assertEquals("Save 87.5 to Push A", deviation?.saveLabel)
        assertEquals("Today’s Bench Press ran at 87.5 against a planned 82.5. "
                     + "Today’s session already has it. Push A does not.",
                     deviation?.sentence(movement = "Bench Press"))
    }

    // ONLY HEAVIER. Dropping the weight mid-exercise is a bad night far more often than it is a
    // decision, and writing that back would lower next week's target off one session.
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

    // Warmups, drops and failures are not what the session was, so none of them can raise the offer:
    // a ramp-up above the working weight is not a program change.
    @Test
    fun testAWarmupOrADropNeverRaisesTheOffer() {
        assertNull(DeviationOffer.leaving("bench-press", session = pushA,
                                          sets = listOf(aSet("bench-press", 100.0, kind = SetKind.Warmup),
                                                        aSet("bench-press", 100.0, kind = SetKind.Drop, at = 2_000),
                                                        aSet("bench-press", 100.0, kind = SetKind.Failure, at = 3_000)),
                                          asked = emptySet()))
    }

    // Asked ONCE, when you leave the exercise — never again this session.
    @Test
    fun testAMovementAlreadyAskedAboutIsNotAskedAgain() {
        assertNull(DeviationOffer.leaving("bench-press", session = pushA,
                                          sets = listOf(aSet("bench-press", 87.5)),
                                          asked = setOf("bench-press")))
    }

    // An ad-hoc session has no program to change, and a routine line that named no weight named no
    // target to deviate from — 3 × max is a movement taken to whatever it gives that day.
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

    // The heaviest working set is what the offer carries, not the last one — a back-off set after a
    // top single is not the number next week should be aimed at.
    @Test
    fun testTheOfferCarriesTheHeaviestWorkingSetAndNotTheLast() {
        val deviation = DeviationOffer.leaving("bench-press", session = pushA,
                                               sets = listOf(aSet("bench-press", 90.0, at = 2_000),
                                                             aSet("bench-press", 85.0, at = 3_000)),
                                               asked = emptySet())
        assertEquals(90.0, deviation?.liftedKg)
    }
}
