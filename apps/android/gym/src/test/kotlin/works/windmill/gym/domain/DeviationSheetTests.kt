package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun aSet(exerciseId: String, weightKg: Double, kind: SetKind = SetKind.Working,
                 at: Long = 1_000): TrainingSet =
    TrainingSet(id = "set_${exerciseId}_${weightKg.toInt()}_$at", exerciseId = exerciseId,
                weightKg = weightKg, reps = 5, kind = kind, completedAtMs = at)

private val pushA = Session(
    id = "ses_1", startedAtMs = 1_000, routineId = "rt_push_a",
    plan = PlanSnapshot(routine = "Push A", entries = listOf(
        PlanEntry(exerciseId = "bench-press", sets = List(5) { SetTarget(5, 82.5) }),
        PlanEntry(exerciseId = "chin-up", sets = List(3) { SetTarget(8) }),
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
                PlanEntry(exerciseId = "overhead-press", sets = List(3) { SetTarget(8, 45.0) }),
                PlanEntry(exerciseId = "bench-press", sets = List(3) { SetTarget(8, 80.0) }),
                PlanEntry(exerciseId = "bench-press", sets = List(1) { SetTarget(3, 100.0) }),
            ))
        )

        val deviation = DeviationOffer.leaving("bench-press", session = topAndBackOff,
                                               sets = listOf(aSet("bench-press", 105.0),
                                                             aSet("bench-press", 82.5, at = 2_000)),
                                               asked = emptySet())
        assertEquals(
            DeviationOffer(exerciseId = "bench-press", routineId = "rt_push_b", routine = "Push B",
                           position = 3, plannedKg = 100.0, liftedKg = 105.0,
                           scheme = listOf(SetTarget(3, 100.0)),
                           lifted = listOf(SetTarget(5, 105.0), SetTarget(5, 82.5))),
            deviation)

        assertNull("beating only the back-off is not a deviation from the program",
                   DeviationOffer.leaving("bench-press", session = topAndBackOff,
                                          sets = listOf(aSet("bench-press", 90.0)), asked = emptySet()))
    }

    // A ladder is saved as the sets lifted, and a line holds twenty of them at most: at twenty-one
    // working sets nothing could be saved, so no sheet rises; at twenty the offer stands.
    @Test
    fun testALadderIsOfferedOnlyWhileTheWorkingSetsFitALine() {
        val lowerA = Session(
            id = "ses_5", startedAtMs = 1_000, routineId = "rt_lower_a",
            plan = PlanSnapshot(routine = "Lower A", entries = listOf(
                PlanEntry(exerciseId = "back-squat", sets = listOf(
                    SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))),
            ))
        )
        fun lifted(count: Int) = (1..count).map { at ->
            TrainingSet(id = "s$at", exerciseId = "back-squat", weightKg = 105.0, reps = 1, completedAtMs = at * 1_000L)
        }

        assertNull(DeviationOffer.leaving("back-squat", session = lowerA, sets = lifted(21), asked = emptySet()))
        val twenty = DeviationOffer.leaving("back-squat", session = lowerA, sets = lifted(20), asked = emptySet())!!
        assertTrue(twenty.ladder)
        assertEquals(List(20) { SetTarget(1, 105.0) }, twenty.proposed)
        assertEquals("Save today’s sets", twenty.saveLabel)
    }

    @Test
    fun testOnAStraightSchemeSaveWritesEverySetAtTheLoadLifted() {
        val deviation = DeviationOffer.leaving("bench-press", session = pushA,
                                               sets = listOf(aSet("bench-press", 82.5),
                                                             aSet("bench-press", 87.5, at = 2_000)),
                                               asked = emptySet())!!

        assertFalse(deviation.ladder)
        assertEquals(List(5) { SetTarget(5, 87.5) }, deviation.proposed)
        assertEquals("Save 87.5 to Push A", deviation.saveLabel)
    }

    @Test
    fun testOnALadderSaveOffersTheSetsAsLiftedAndTheLineIsMeasuredAgainstItsTopSet() {
        val lowerA = Session(
            id = "ses_4", startedAtMs = 1_000, routineId = "rt_lower_a",
            plan = PlanSnapshot(routine = "Lower A", entries = listOf(
                PlanEntry(exerciseId = "back-squat", sets = listOf(
                    SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0)),
                    restSeconds = 180),
            ))
        )
        val lifted = listOf(
            TrainingSet(id = "s1", exerciseId = "back-squat", weightKg = 60.0, reps = 5, completedAtMs = 1_000),
            TrainingSet(id = "s2", exerciseId = "back-squat", weightKg = 80.0, reps = 5, completedAtMs = 2_000),
            TrainingSet(id = "s3", exerciseId = "back-squat", weightKg = 90.0, reps = 3, completedAtMs = 3_000),
            TrainingSet(id = "s4", exerciseId = "back-squat", weightKg = 102.5, reps = 1, completedAtMs = 4_000),
            TrainingSet(id = "s5", exerciseId = "back-squat", weightKg = 80.0, reps = 5, completedAtMs = 5_000),
        )

        val deviation = DeviationOffer.leaving("back-squat", session = lowerA, sets = lifted, asked = emptySet())

        assertEquals(
            DeviationOffer(exerciseId = "back-squat", routineId = "rt_lower_a", routine = "Lower A",
                           position = 1, plannedKg = 100.0, liftedKg = 102.5,
                           scheme = lowerA.plan!!.entries.single().sets,
                           lifted = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0),
                                           SetTarget(1, 102.5), SetTarget(5, 80.0))),
            deviation)
        assertTrue(deviation!!.ladder)
        assertEquals("the honest offer is the sets as lifted", deviation.lifted, deviation.proposed)
        assertEquals("Save today’s sets", deviation.saveLabel)

        assertNull("running the ramp as written beats nothing",
                   DeviationOffer.leaving("back-squat", session = lowerA,
                                          sets = lifted.take(3), asked = emptySet()))
    }
}
