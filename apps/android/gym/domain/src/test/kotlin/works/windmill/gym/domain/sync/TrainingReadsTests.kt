package works.windmill.gym.domain.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Instant

class PrefillTests {
    private fun aSet(weightKg: Double, reps: Int, at: Long): TrainingSet =
        trainingSet(Id("set_$at", TrainingSet), Instant(at)).copy(weightKg = weightKg, reps = reps)

    private fun lastTime(vararg sets: TrainingSet): LastTime = LastTime(squat, session(Instant(2)), sets.toList())

    private val unread = LastTime(squat, isComplete = false)

    private val lowerARamp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))

    private val pushA = RoutineEntry(squat, List(5) { SetTarget(5, 82.5) })

    private val lowerA = RoutineEntry(squat, lowerARamp)

    @Test fun aStraightSchemeIsOneWhoseSetsAgreeOnTheLaddersGrid() {
        assertTrue(SetTarget.straight(List(3) { SetTarget(8, 60.0) }))
        assertTrue(SetTarget.straight(listOf(SetTarget(8, 60.0), SetTarget(8, 60.004))))
        assertFalse(SetTarget.straight(listOf(SetTarget(8, 60.0), SetTarget(8, 60.01))))
        assertFalse(SetTarget.straight(listOf(SetTarget(8, 60.0), SetTarget(null, 60.0))))
        assertFalse(SetTarget.straight(lowerARamp))
        assertTrue("an open line asks nothing that could disagree", SetTarget.straight(emptyList()))
    }

    @Test fun withNoPlanAndNoHistoryThePadOpensOnTheEmptyBar() {
        assertEquals(Prefill(20.0, 5), Prefill.of(emptyList(), null, null))
    }

    @Test fun todaysLastSetWinsOverThePlanAndOverLastTime() {
        assertEquals(Prefill(85.0, 3), Prefill.of(listOf(aSet(82.5, 5, 100), aSet(85.0, 3, 200)), pushA, lastTime(aSet(80.0, 8, 1))))
    }

    @Test fun thePlansTargetBeatsLastTimeBeforeAnythingIsLifted() {
        assertEquals(Prefill(82.5, 5), Prefill.of(emptyList(), pushA, lastTime(aSet(80.0, 8, 1))))
    }

    @Test fun onASchemeWhoseSetsDisagreeThePadFollowsTheSlot() {
        assertEquals("two sets landed, so the third set's numbers", Prefill(90.0, 3),
            Prefill.of(listOf(aSet(60.0, 5, 100), aSet(80.0, 5, 200)), lowerA, null))
        assertEquals("before anything is lifted, set 1", Prefill(60.0, 5), Prefill.of(emptyList(), lowerA, null))
        assertEquals("each set advances the slot", Prefill(80.0, 5), Prefill.of(listOf(aSet(40.0, 10, 100)), lowerA, null))
    }

    @Test fun pastTheEndOfTheSchemeThePadFallsToLastTimesNthSetThenToday() {
        val fiveLanded = lowerARamp.mapIndexed { index, set -> aSet(set.weightKg!!, set.reps!!, 100L * (index + 1)) }
        val sixSets = lastTime(*Array(6) { aSet(70.0, 6, 1L + it) })
        assertEquals("last time's sixth set", Prefill(70.0, 6), Prefill.of(fiveLanded, lowerA, sixSets))
        assertEquals("and with no sixth set last time, today's last set", Prefill(80.0, 5), Prefill.of(fiveLanded, lowerA, null))
    }

    @Test fun aSlotThatNamesNoLoadTakesLastTimesNthSetsLoad() {
        val topSetToLastTime = RoutineEntry(squat, listOf(SetTarget(5, 60.0), SetTarget(3, null), SetTarget(null, null)))
        val history = lastTime(aSet(60.0, 5, 1), aSet(95.0, 3, 2), aSet(100.0, 2, 3))
        assertEquals(Prefill(95.0, 3), Prefill.of(listOf(aSet(60.0, 5, 100)), topSetToLastTime, history))
        assertEquals("a max set takes last time's reps too", Prefill(100.0, 2),
            Prefill.of(listOf(aSet(60.0, 5, 100), aSet(95.0, 3, 200)), topSetToLastTime, history))
    }

    @Test fun lastTimeGivesTheWeightItEndedOnAndTheRepsItStartedOn() {
        assertEquals(Prefill(90.0, 8), Prefill.of(emptyList(), null, lastTime(aSet(80.0, 8, 1), aSet(85.0, 6, 2), aSet(90.0, 4, 3))))
    }

    @Test fun everySetCanSupplyTheStickyWeight() {
        assertEquals("the last set supplies the rack", Prefill(40.0, 10), Prefill.of(listOf(aSet(40.0, 10, 100)), pushA, null))
        assertEquals("the last set is the one the thumb is following", Prefill(65.0, 3),
            Prefill.of(listOf(aSet(40.0, 10, 100), aSet(85.0, 5, 200), aSet(65.0, 3, 300)), pushA, null))
    }

    @Test fun aPlanWithNoRepTargetFallsThroughToLastTimeRatherThanToZero() {
        val threeToMax = RoutineEntry(squat, List(3) { SetTarget() })
        assertEquals(Prefill(0.0, 9), Prefill.of(emptyList(), threeToMax, lastTime(aSet(0.0, 9, 1), aSet(0.0, 6, 2))))
        assertEquals("and with no history at all, the empty bar", Prefill(20.0, 5), Prefill.of(emptyList(), threeToMax, null))
    }

    @Test fun aPlanWithNoTargetWeightStillGivesItsReps() {
        assertEquals(Prefill(0.0, 8), Prefill.of(emptyList(), RoutineEntry(squat, List(3) { SetTarget(reps = 8) }), lastTime(aSet(0.0, 12, 1))))
    }

    @Test fun aRepCountOfZeroFromAnOlderBuildClimbsBackToOne() {
        assertEquals("the load is signed and unbounded by design, and is never clamped", Prefill(82.5, 1),
            Prefill.of(listOf(aSet(82.5, 0, 100)), null, null))
    }

    @Test fun anUnreadLastTimeOffersOnlyThePlansOwnLoadsAndTodaysLastSet() {
        assertTrue(unread.isUnread)
        assertFalse("a workout found is read, whatever the rest of the history", lastTime(aSet(60.0, 5, 1)).copy(isComplete = false).isUnread)
        assertEquals(listOf(60.0, null, 90.0, null, null), Prefill.offeredLoads(emptyList(), lowerA.copy(sets = listOf(
            SetTarget(5, 60.0), SetTarget(5), SetTarget(3, 90.0), SetTarget(1), SetTarget(5))), unread))
        assertEquals(listOf(82.5, 82.5, 82.5), Prefill.offeredLoads(listOf(aSet(82.5, 5, 100), aSet(82.5, 5, 200)), pushA, unread))
    }
}
