package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private fun aSet(exerciseId: String, weightKg: Double, reps: Int,
                 at: Long, kind: SetKind = SetKind.Working, id: String = ""): TrainingSet =
    TrainingSet(id = id.ifEmpty { "set_$at" }, exerciseId = exerciseId,
                weightKg = weightKg, reps = reps, kind = kind, completedAtMs = at)

private val pushA = PlanSnapshot(routine = "Push A", entries = listOf(
    PlanEntry(exerciseId = "bench-press", sets = List(5) { SetTarget(5, 82.5) }),
    PlanEntry(exerciseId = "overhead-press", sets = List(3) { SetTarget(8, 45.0) }),
))

class LiveOrderTests {
    @Test
    fun workoutClocksUseEveryAcceptedSetAndRecomputeAfterDeleteUndoAndEdits() {
        val session = Session("workout", 10_000)
        val first = TrainingSet("first", "bench", weightKg = 60.0, reps = 5, completedAtMs = 25_000)
        val latest = TrainingSet("latest", "row", weightKg = 20.0, reps = 8, kind = SetKind.Warmup, completedAtMs = 40_000)
        val before = WorkoutClocks(session, emptyList(), 70_000)
        assertEquals(listOf(60_000L, 60_000L), listOf(before.workoutMs, before.sinceSetMs))
        assertEquals("Since start", before.sinceSetName)
        val accepted = WorkoutClocks(session, listOf(latest, first), 70_000)
        assertEquals(listOf(60_000L, 30_000L), listOf(accepted.workoutMs, accepted.sinceSetMs))
        assertEquals("Since last set", accepted.sinceSetName)
        assertEquals(45_000L, WorkoutClocks(session, listOf(first), 70_000).sinceSetMs)
        assertEquals(30_000L, WorkoutClocks(session, listOf(first, latest.copy(weightKg = 22.5, reps = 9)), 70_000).sinceSetMs)
        assertEquals(60_000L, WorkoutClocks(session, listOf(first, latest), 100_000).sinceSetMs)
    }

    @Test
    fun finishedWorkoutClocksFreezeAndClockSkewCannotMakeNegativeReadings() {
        val session = Session("workout", 10_000, finishedAtMs = 70_000)
        val set = TrainingSet("set", "bench", weightKg = 60.0, reps = 5, completedAtMs = 40_000)
        val frozen = WorkoutClocks(session, listOf(set), 900_000)
        assertEquals(listOf(60_000L, 30_000L), listOf(frozen.workoutMs, frozen.sinceSetMs))
        val skew = WorkoutClocks(session.copy(finishedAtMs = null), listOf(set), 5_000)
        assertEquals(listOf(0L, 0L), listOf(skew.workoutMs, skew.sinceSetMs))
        assertEquals(40_000L, skew.latestSetAtMs)
    }

    @Test
    fun testThePlanLeadsAndWhateverElseWasLiftedFollowsIt() {
        val order = LiveOrder.merged(
            held = emptyList(),
            plan = pushA,
            sets = listOf(aSet("cable-fly", 22.5, 12, at = 3_000), aSet("bench-press", 82.5, 5, at = 1_000))
        )
        assertEquals(listOf("bench-press", "overhead-press", "cable-fly"), order)
    }

    @Test
    fun testAMovementAlreadyHeldKeepsItsPlaceAtTheHead() {
        val order = LiveOrder.merged(held = listOf("cable-fly", "bench-press"), plan = pushA, sets = emptyList())
        assertEquals(listOf("cable-fly", "bench-press", "overhead-press"), order)
    }

    @Test
    fun testAMovementWithNoSetsStaysInTheOrder() {
        val order = LiveOrder.merged(held = listOf("romanian-deadlift"), plan = null, sets = emptyList())
        assertEquals(listOf("romanian-deadlift"), order)
    }

    @Test
    fun testResumingStandsAtTheMovementTheLastSetWentInto() {
        val order = listOf("bench-press", "overhead-press", "cable-fly")
        val sets = listOf(aSet("bench-press", 82.5, 5, at = 1_000), aSet("overhead-press", 45.0, 8, at = 9_000))
        assertEquals("overhead-press", LiveOrder.resume(order, sets))
    }

    @Test
    fun testResumingASessionWithNothingLoggedStandsAtTheHeadOfThePlan() {
        assertEquals("bench-press", LiveOrder.resume(listOf("bench-press", "overhead-press"), emptyList()))
        assertNull("an ad-hoc session with no movements opens the picker",
                   LiveOrder.resume(emptyList(), emptyList()))
    }
}

class LiveLinesTests {
    @Test
    fun testTheCounterKeepsCountingPastThePlansSetCount() {
        val entry = PlanEntry(exerciseId = "bench-press", sets = List(3) { SetTarget(5, 82.5) })
        assertEquals("set 4 of 3", LiveLines.counter(workingSetsToday = 3, planEntry = entry))
    }

    @Test
    fun testAMovementWithNoPlanCountsWithoutBorrowingATarget() {
        assertEquals("set 1", LiveLines.counter(workingSetsToday = 0, planEntry = null))
    }

    @Test
    fun testAnOpenPlanLineCountsLikeNoLineAtAll() {
        val entry = PlanEntry(exerciseId = "chin-up")
        assertEquals("set 2", LiveLines.counter(workingSetsToday = 1, planEntry = entry))
        assertEquals("set 3 of 3",
                     LiveLines.counter(workingSetsToday = 2, planEntry = entry.copy(sets = List(3) { SetTarget(8, 10.0) })))
    }

    @Test
    fun testTheLedgerIsWhatLandedThenTheSetInHandThenEveryPlannedSetStillToCome() {
        val lowerA = PlanEntry(exerciseId = "back-squat", sets = listOf(
            SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0)))
        val landed = listOf(aSet("back-squat", 60.0, 5, at = 1_000, id = "s1"),
                            aSet("back-squat", 80.0, 5, at = 2_000, id = "s2"))

        val slots = LiveLines.slots(landed, lowerA, stalled = setOf("s2"))

        assertEquals(
            listOf(
                LiveLines.Slot.Landed(LiveLines.Row("s1", "1", "60", 5, isWarmup = false, isOnThisDevice = false)),
                LiveLines.Slot.Landed(LiveLines.Row("s2", "2", "80", 5, isWarmup = false, isOnThisDevice = true)),
                LiveLines.Slot.Current(index = 3, target = SetTarget(3, 90.0)),
                LiveLines.Slot.Planned(index = 4, target = SetTarget(1, 100.0)),
                LiveLines.Slot.Planned(index = 5, target = SetTarget(5, 80.0)),
            ),
            slots)
        assertEquals(
            listOf(
                "Set 1, logged, 60 kg, 5 reps",
                "Set 2, logged, 80 kg, 5 reps, on this device",
                "Set 3, current, target 90 kg, 3 reps",
                "Set 4, planned, 100 kg, 1 rep",
                "Set 5, planned, 80 kg, 5 reps",
            ),
            slots.map { it.spoken })
        assertEquals("target 90 × 3", (slots[2] as LiveLines.Slot.Current).targetLine)
        assertEquals(listOf("100" to "1", "80" to "5"),
            slots.filterIsInstance<LiveLines.Slot.Planned>().map { it.weight to it.reps })
    }

    @Test
    fun testAWarmupIsUncountedAndPastThePlanTheSetInHandHasNoTarget() {
        val entry = PlanEntry(exerciseId = "chin-up", sets = List(2) { SetTarget() })
        val sets = listOf(aSet("chin-up", 0.0, 5, at = 900, kind = SetKind.Warmup, id = "w1"),
                          aSet("chin-up", 0.0, 9, at = 1_000, id = "s1"),
                          aSet("chin-up", 0.0, 8, at = 2_000, id = "s2"),
                          aSet("chin-up", 0.0, 6, at = 3_000, id = "s3"))

        assertEquals(
            listOf(
                LiveLines.Slot.Landed(LiveLines.Row("w1", "W", "0", 5, isWarmup = true, isOnThisDevice = false)),
                LiveLines.Slot.Landed(LiveLines.Row("s1", "1", "0", 9, isWarmup = false, isOnThisDevice = false)),
                LiveLines.Slot.Landed(LiveLines.Row("s2", "2", "0", 8, isWarmup = false, isOnThisDevice = false)),
                LiveLines.Slot.Landed(LiveLines.Row("s3", "3", "0", 6, isWarmup = false, isOnThisDevice = false)),
                LiveLines.Slot.Current(index = 4, target = null),
            ),
            LiveLines.slots(sets, entry, stalled = emptySet()))

        val opening = LiveLines.slots(sets.take(1), entry, stalled = emptySet())
        assertEquals(
            listOf(
                LiveLines.Slot.Landed(LiveLines.Row("w1", "W", "0", 5, isWarmup = true, isOnThisDevice = false)),
                LiveLines.Slot.Current(index = 1, target = SetTarget()),
                LiveLines.Slot.Planned(index = 2, target = SetTarget()),
            ),
            opening)
        assertEquals(
            listOf(
                "Warmup, logged, 0 kg, 5 reps",
                "Set 1, current, target last time’s weight, max reps",
                "Set 2, planned, last time’s weight, max reps",
            ),
            opening.map { it.spoken })
        assertEquals("target last × max", (opening[1] as LiveLines.Slot.Current).targetLine)
        assertEquals("last" to "max", (opening[2] as LiveLines.Slot.Planned).let { it.weight to it.reps })

        val free = LiveLines.slots(emptyList(), null, stalled = emptySet())
        assertEquals("no plan: only the set in hand", listOf(LiveLines.Slot.Current(index = 1, target = null)), free)
        assertEquals(listOf("Set 1, current"), free.map { it.spoken })
        assertNull((free.single() as LiveLines.Slot.Current).targetLine)
    }

    @Test
    fun testTheMovementPlaceIsCountedOffTheWalkAndDegradesToSilence() {
        val order = listOf("bench-press", "overhead-press", "cable-fly")

        assertEquals(LiveLines.Place(1, 3), LiveLines.place(order, "bench-press"))
        assertEquals(listOf("Exercise 3 / 3", "Exercise 3 of 3"),
                     LiveLines.place(order, "cable-fly")?.let { listOf(it.shown, it.spoken) })
        assertEquals("an appended movement counts the moment it joins the walk",
                     LiveLines.Place(3, 3), LiveLines.place(order, order.last()))
        assertNull("a movement the walk does not hold has no place",
                   LiveLines.place(order, "chin-up"))
        assertNull(LiveLines.place(order, null))
        assertNull("a walk of one is not a position worth a line",
                   LiveLines.place(listOf("bench-press"), "bench-press"))
        assertNull(LiveLines.place(emptyList(), "bench-press"))
    }

    @Test
    fun testOnlyWorkingSetsCountTowardThePlanCounterAndTheAssemblyList() {
        val sets = listOf(
            aSet("bench-press", 40.0, 8, at = 900, kind = SetKind.Warmup, id = "w1"),
            aSet("bench-press", 82.5, 5, at = 1_000, id = "s1"),
            aSet("bench-press", 82.5, 5, at = 2_000, id = "s2"),
            aSet("bench-press", 60.0, 8, at = 2_500, kind = SetKind.Drop, id = "d1"),
            aSet("bench-press", 82.5, 3, at = 3_000, kind = SetKind.Failure, id = "f1"),
        )

        assertEquals(2, LiveLines.workingCount(sets))
        assertEquals(0, LiveLines.workingCount(sets, of = "cable-fly"))
        assertEquals("set 3 of 5",
                     LiveLines.counter(workingSetsToday = LiveLines.workingCount(sets),
                                       planEntry = pushA.entry("bench-press")))

        val rows = LiveLines.assemblyRows(order = listOf("bench-press"), sets = sets, plan = pushA,
                                          catalog = listOf(Exercise(id = "bench-press", name = "Bench Press")),
                                          current = "bench-press")
        assertEquals(listOf("2 of 5 sets"), rows.map { it.tag })
        assertEquals("the card draws every set that was performed, drops and warmups included",
                     listOf(5), rows.map { it.sets.size })

        assertEquals("the today list numbers what was performed, which is not what counts",
                     listOf("W", "1", "2", "3", "4"),
                     LiveLines.rows(sets, stalled = emptySet()).map { it.index })
    }

    @Test
    fun testTheAssemblyListSaysWhereEachMovementStands() {
        val rows = LiveLines.assemblyRows(
            order = listOf("bench-press", "overhead-press", "cable-fly"),
            sets = listOf(aSet("bench-press", 82.5, 5, at = 1_000),
                          aSet("bench-press", 40.0, 8, at = 900, kind = SetKind.Warmup, id = "w1")),
            plan = pushA,
            catalog = listOf(Exercise(id = "bench-press", name = "Bench Press")),
            current = "bench-press"
        )
        assertEquals(listOf("Bench Press", "overhead-press", "cable-fly"), rows.map { it.name })
        assertEquals("a plan line nobody has reached yet was not just added — it is not started",
                     listOf("1 of 5 sets", null, "just added"), rows.map { it.tag })
        assertEquals("only a movement with no sets says what would start it",
                     listOf(null, "no sets yet — logging one starts it",
                            "no sets yet — logging one starts it"),
                     rows.map { it.line })
        assertEquals(listOf(true, false, false), rows.map { it.isCurrent })
        assertEquals(listOf(false, false, true), rows.map { it.justAdded })
        assertEquals("the plan's own line does not leave on a swipe, and the appended one does",
                     listOf(false, false, true), rows.map { it.canDrop })
    }

    @Test
    fun testASwipeDropsOnlyAMovementThatIsNeitherLoggedNorPlanned() {
        val sets = listOf(aSet("bench-press", 82.5, 5, at = 1_000))

        assertEquals(false, LiveOrder.droppable("bench-press", sets, pushA))
        assertEquals(false, LiveOrder.droppable("overhead-press", sets, pushA))
        assertEquals(true, LiveOrder.droppable("cable-fly", sets, pushA))
        assertEquals("with no plan, a movement holding a set is still the lifter's own work",
                     false, LiveOrder.droppable("bench-press", sets, plan = null))
    }

    @Test
    fun testAReorderIsAPermutationAndNeverLosesAMovement() {
        val order = listOf("bench-press", "overhead-press", "cable-fly", "chin-up")

        assertEquals(listOf("overhead-press", "cable-fly", "bench-press", "chin-up"),
                     LiveOrder.moved(order, from = 0, to = 2))
        assertEquals(listOf("chin-up", "bench-press", "overhead-press", "cable-fly"),
                     LiveOrder.moved(order, from = 3, to = 0))
        for (from in order.indices) {
            for (to in order.indices) {
                assertEquals("moving $from to $to kept every movement",
                             order.sorted(), LiveOrder.moved(order, from, to).sorted())
            }
        }
    }

    @Test
    fun testAReorderOffTheEndsOfTheListChangesNothing() {
        val order = listOf("bench-press", "overhead-press")
        assertEquals(order, LiveOrder.moved(order, from = 0, to = 0))
        assertEquals(order, LiveOrder.moved(order, from = -1, to = 1))
        assertEquals(order, LiveOrder.moved(order, from = 1, to = 7))
        assertEquals(emptyList<String>(), LiveOrder.moved(emptyList(), from = 0, to = 0))
    }

    @Test
    fun testTheOfflineStripCountsSetsAndSaysNothingWhenThereAreNone() {
        assertNull(LiveLines.onThisDeviceLine(0, Blocker.Offline))
        assertEquals("1 set is saved on this device only. They’ll sync when you’re online.",
                     LiveLines.onThisDeviceLine(1, Blocker.Offline))
        assertEquals("3 sets are saved on this device only. They’ll sync when you’re online.",
                     LiveLines.onThisDeviceLine(3, Blocker.Offline))
    }

    @Test
    fun testTheStripNamesWhatBlockedTheSetsRatherThanAssertingNoSignal() {
        assertEquals("2 sets are saved on this device only. The log didn’t answer. They’ll sync when it’s available.",
                     LiveLines.onThisDeviceLine(2, Blocker.LogFailed))
        assertEquals("1 set is saved on this device only. Sign in again to sync these sets.",
                     LiveLines.onThisDeviceLine(1, Blocker.SignInLapsed))
        assertEquals("1 set is saved on this device only. They’re waiting to sync.",
                     LiveLines.onThisDeviceLine(1, null))
    }
}
