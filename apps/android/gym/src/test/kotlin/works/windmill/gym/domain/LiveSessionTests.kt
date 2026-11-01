package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Instant as DomainInstant
import works.windmill.gym.domain.sync.Exercise as DomainExercise
import works.windmill.gym.domain.sync.LastTime
import works.windmill.gym.domain.sync.Session as DomainSession

private fun aSet(exerciseId: String, weightKg: Double, reps: Int,
                 at: Long, id: String = ""): TrainingSet =
    TrainingSet(id = id.ifEmpty { "set_$at" }, exerciseId = exerciseId,
                weightKg = weightKg, reps = reps, completedAtMs = at)

private fun firstTimeOf(exerciseId: String) = LastTime(Id(exerciseId, DomainExercise))

private fun unreadOf(exerciseId: String) = LastTime(Id(exerciseId, DomainExercise), isComplete = false)

private fun lastTimeOf(exerciseId: String, sets: List<TrainingSet>) = LastTime(Id(exerciseId, DomainExercise),
    DomainSession(Id("before", DomainSession), DomainInstant(0), DomainInstant(1)), sets.map { it.domain("before") })

private val pushA = PlanSnapshot(routine = "Push A", entries = listOf(
    PlanEntry(exerciseId = "bench-press", sets = List(5) { SetTarget(5, 82.5) }),
    PlanEntry(exerciseId = "overhead-press", sets = List(3) { SetTarget(8, 45.0) }),
))

class LiveOrderTests {
    @Test
    fun workoutClocksUseEveryAcceptedSetAndRecomputeAfterDeleteUndoAndEdits() {
        val session = Session("workout", 10_000)
        val first = TrainingSet("first", "bench", weightKg = 60.0, reps = 5, completedAtMs = 25_000)
        val latest = TrainingSet("latest", "row", weightKg = 20.0, reps = 8, completedAtMs = 40_000)
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
    fun decorativeMarkersWindowTheExactSpokenPositionWithoutBecomingTargets() {
        val ordinary = LiveLines.Marker(false, false)
        val current = LiveLines.Marker(true, false)
        val continuation = LiveLines.Marker(false, true)
        assertEquals(emptyList<LiveLines.Marker>(), LiveLines.Place(1, 1).markers)
        assertEquals(listOf(current, ordinary), LiveLines.Place(1, 2).markers)
        assertEquals(listOf(ordinary, current), LiveLines.Place(2, 2).markers)
        assertEquals(listOf(ordinary, ordinary, ordinary, current, ordinary, ordinary, ordinary), LiveLines.Place(4, 7).markers)
        assertEquals(listOf(current, ordinary, ordinary, ordinary, ordinary, ordinary, continuation), LiveLines.Place(1, 12).markers)
        assertEquals(listOf(continuation, ordinary, ordinary, current, ordinary, ordinary, continuation), LiveLines.Place(6, 12).markers)
        assertEquals(listOf(continuation, ordinary, ordinary, ordinary, ordinary, ordinary, current), LiveLines.Place(12, 12).markers)
        assertEquals("Exercise 6 of 12", LiveLines.Place(6, 12).spoken)
    }

    @Test
    fun ledgerRowsNameTheEquipmentUnitAndOfferTheSetBeforeForAnOpenTarget() {
        for (unit in listOf("kg each", "kg added", "kg total", "kg")) {
            val rows = LiveLines.slots(listOf(aSet("lift", -12.5, 8, 1)), "workout",
                PlanEntry("lift", listOf(SetTarget(8, -12.5), SetTarget(10, 24.0), SetTarget())), firstTimeOf("lift"), emptySet(), unit)
            assertEquals(listOf("−12.5 $unit × 8", "24 $unit × 10", "24 $unit × max"), rows.map { it.line })
            assertEquals(listOf("Set 1, logged, −12.5 $unit, 8 reps", "Set 2, current, 24 $unit, 10 reps",
                "Set 3, planned, 24 $unit, max reps"), rows.map { it.spoken })
        }
    }

    @Test
    fun testTheCounterKeepsCountingPastThePlansSetCount() {
        val entry = PlanEntry(exerciseId = "bench-press", sets = List(3) { SetTarget(5, 82.5) })
        assertEquals("set 4 of 3", LiveLines.counter(setsToday = 3, planEntry = entry))
    }

    @Test
    fun testAMovementWithNoPlanCountsWithoutBorrowingATarget() {
        assertEquals("set 1", LiveLines.counter(setsToday = 0, planEntry = null))
    }

    @Test
    fun testAnOpenPlanLineCountsLikeNoLineAtAll() {
        val entry = PlanEntry(exerciseId = "chin-up")
        assertEquals("set 2", LiveLines.counter(setsToday = 1, planEntry = entry))
        assertEquals("set 3 of 3",
                     LiveLines.counter(setsToday = 2, planEntry = entry.copy(sets = List(3) { SetTarget(8, 10.0) })))
    }

    @Test
    fun testTheLedgerIsWhatLandedThenTheSetInHandThenEveryPlannedSetStillToCome() {
        val lowerA = PlanEntry(exerciseId = "back-squat", sets = listOf(
            SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0)))
        val landed = listOf(aSet("back-squat", 60.0, 5, at = 1_000, id = "s1"),
                            aSet("back-squat", 80.0, 5, at = 2_000, id = "s2"))

        val slots = LiveLines.slots(landed, "workout", lowerA, firstTimeOf("back-squat"), stalled = setOf("s2"))

        assertEquals(
            listOf(
                LiveLines.Slot.Landed(LiveLines.Row("s1", "1", "60", 5, isOnThisDevice = false)),
                LiveLines.Slot.Landed(LiveLines.Row("s2", "2", "80", 5, isOnThisDevice = true)),
                LiveLines.Slot.Current(index = 3, target = SetTarget(3, 90.0), offeredKg = 90.0),
                LiveLines.Slot.Planned(index = 4, target = SetTarget(1, 100.0), offeredKg = 100.0),
                LiveLines.Slot.Planned(index = 5, target = SetTarget(5, 80.0), offeredKg = 80.0),
            ),
            slots)
        assertEquals(
            listOf(
                "Set 1, logged, 60 kg, 5 reps",
                "Set 2, logged, 80 kg, 5 reps, on this device",
                "Set 3, current, 90 kg, 3 reps",
                "Set 4, planned, 100 kg, 1 rep",
                "Set 5, planned, 80 kg, 5 reps",
            ),
            slots.map { it.spoken })
        assertEquals(listOf("60 kg × 5", "80 kg × 5", "90 kg × 3", "100 kg × 1", "80 kg × 5"), slots.map { it.line })
    }

    @Test
    fun testARowStillToLiftNamesTheLoadItsRackWillOfferAndNeverLast() {
        val bench = PlanEntry(exerciseId = "bench-press", sets = List(3) { SetTarget() })
        val first = aSet("bench-press", 22.5, 5, at = 1_000, id = "s1")
        val lastTime = lastTimeOf("bench-press", listOf(aSet("bench-press", 60.0, 8, at = 500)))

        val afterOne = LiveLines.slots(listOf(first), "workout", bench, lastTime, stalled = emptySet(), unit = "kg total")
        assertEquals(listOf("22.5 kg total × 5", "22.5 kg total × max", "22.5 kg total × max"), afterOne.map { it.line })

        val opening = LiveLines.slots(emptyList(), "workout", bench, lastTime, stalled = emptySet(), unit = "kg total")
        assertEquals("before any set, last time's load", listOf("60 kg total × max", "60 kg total × max", "60 kg total × max"),
            opening.map { it.line })

        val firstTime = LiveLines.slots(emptyList(), "workout", bench, firstTimeOf("bench-press"), stalled = emptySet(), unit = "kg total")
        assertEquals("the empty bar", listOf("20 kg total × max", "20 kg total × max", "20 kg total × max"), firstTime.map { it.line })

        val unread = LiveLines.slots(emptyList(), "workout", bench, unreadOf("bench-press"), stalled = emptySet(), unit = "kg total")
        assertEquals("nothing to offer before last time is read", listOf("— × max", "— × max", "— × max"), unread.map { it.line })
        assertEquals(listOf("Set 1, current, no load yet, max reps", "Set 2, planned, no load yet, max reps",
            "Set 3, planned, no load yet, max reps"), unread.map { it.spoken })

        val unreadAfterOne = LiveLines.slots(listOf(first), "workout", bench, unreadOf("bench-press"), stalled = emptySet(), unit = "kg total")
        assertEquals("today's last set needs no history", listOf("22.5 kg total × 5", "22.5 kg total × max", "22.5 kg total × max"),
            unreadAfterOne.map { it.line })

        val ladder = PlanEntry(exerciseId = "bench-press", sets = listOf(SetTarget(8, 60.0), SetTarget(), SetTarget(3, 110.0)))
        val unreadLadder = LiveLines.slots(emptyList(), "workout", ladder, unreadOf("bench-press"), stalled = emptySet(), unit = "kg total")
        assertEquals("the plan's own loads need no history", listOf("60 kg total × 8", "— × max", "110 kg total × 3"),
            unreadLadder.map { it.line })

        val lines = listOf(afterOne, opening, firstTime, unread, unreadAfterOne, unreadLadder).flatten().mapNotNull { it.line }
        assertEquals(emptyList<String>(), lines.filter { "last" in it })
    }

    @Test
    fun testEverySetCountsAndPastThePlanTheSetInHandHasNoTarget() {
        val entry = PlanEntry(exerciseId = "chin-up", sets = List(2) { SetTarget() })
        val sets = listOf(aSet("chin-up", 0.0, 5, at = 900, id = "w1"),
                          aSet("chin-up", 0.0, 9, at = 1_000, id = "s1"),
                          aSet("chin-up", 0.0, 8, at = 2_000, id = "s2"),
                          aSet("chin-up", 0.0, 6, at = 3_000, id = "s3"))

        assertEquals(
            listOf(
                LiveLines.Slot.Landed(LiveLines.Row("w1", "1", "0", 5, isOnThisDevice = false)),
                LiveLines.Slot.Landed(LiveLines.Row("s1", "2", "0", 9, isOnThisDevice = false)),
                LiveLines.Slot.Landed(LiveLines.Row("s2", "3", "0", 8, isOnThisDevice = false)),
                LiveLines.Slot.Landed(LiveLines.Row("s3", "4", "0", 6, isOnThisDevice = false)),
                LiveLines.Slot.Current(index = 5, target = null, offeredKg = null),
            ),
            LiveLines.slots(sets, "workout", entry, firstTimeOf("chin-up"), stalled = emptySet()))

        val opening = LiveLines.slots(sets.take(1), "workout", entry, firstTimeOf("chin-up"), stalled = emptySet())
        assertEquals(
            listOf(
                LiveLines.Slot.Landed(LiveLines.Row("w1", "1", "0", 5, isOnThisDevice = false)),
                LiveLines.Slot.Current(index = 2, target = SetTarget(), offeredKg = 0.0),
            ),
            opening)
        assertEquals(
            listOf(
                "Set 1, logged, 0 kg, 5 reps",
                "Set 2, current, 0 kg, max reps",
            ),
            opening.map { it.spoken })
        assertEquals("0 kg × max", (opening[1] as LiveLines.Slot.Current).line)

        val free = LiveLines.slots(emptyList(), "workout", null, firstTimeOf("chin-up"), stalled = emptySet())
        assertEquals("no plan: only the set in hand", listOf(LiveLines.Slot.Current(index = 1, target = null, offeredKg = null)), free)
        assertEquals(listOf("Set 1, current"), free.map { it.spoken })
        assertNull((free.single() as LiveLines.Slot.Current).line)
    }

    @Test
    fun testTheMovementPlaceIsCountedOffTheWalkAndDegradesToSilence() {
        val order = listOf("bench-press", "overhead-press", "cable-fly")

        assertEquals(LiveLines.Place(1, 3), LiveLines.place(order, "bench-press"))
        assertEquals("Exercise 3 of 3", LiveLines.place(order, "cable-fly")?.spoken)
        assertEquals("an appended movement counts the moment it joins the walk",
                     LiveLines.Place(3, 3), LiveLines.place(order, order.last()))
        assertNull("a movement the walk does not hold has no place",
                   LiveLines.place(order, "chin-up"))
        assertNull(LiveLines.place(order, null))
        assertEquals(LiveLines.Place(1, 1), LiveLines.place(listOf("bench-press"), "bench-press"))
        assertNull(LiveLines.place(emptyList(), "bench-press"))
    }

    @Test
    fun testEverySetCountsTowardThePlanCounterAndTheAssemblyList() {
        val sets = listOf(
            aSet("bench-press", 40.0, 8, at = 900, id = "w1"),
            aSet("bench-press", 82.5, 5, at = 1_000, id = "s1"),
            aSet("bench-press", 82.5, 5, at = 2_000, id = "s2"),
            aSet("bench-press", 60.0, 8, at = 2_500, id = "d1"),
            aSet("bench-press", 82.5, 3, at = 3_000, id = "f1"),
        )

        assertEquals(5, LiveLines.setCount(sets))
        assertEquals(0, LiveLines.setCount(sets, of = "cable-fly"))
        assertEquals("set 6 of 5",
                     LiveLines.counter(setsToday = LiveLines.setCount(sets),
                                       planEntry = pushA.entry("bench-press")))

        val rows = LiveLines.assemblyRows(order = listOf("bench-press"), sets = sets, plan = pushA,
                                          catalog = listOf(Exercise(id = "bench-press", name = "Bench Press")),
                                          current = "bench-press")
        assertEquals(listOf("5 of 5 sets"), rows.map { it.tag })
        assertEquals("the card draws every set that was performed",
                     listOf(5), rows.map { it.sets.size })

        assertEquals("the today list numbers every performed set",
                     listOf("1", "2", "3", "4", "5"),
                     LiveLines.rows(sets, stalled = emptySet()).map { it.index })
    }

    @Test
    fun testTheAssemblyListSaysWhereEachMovementStands() {
        val rows = LiveLines.assemblyRows(
            order = listOf("bench-press", "overhead-press", "cable-fly"),
            sets = listOf(aSet("bench-press", 82.5, 5, at = 1_000),
                          aSet("bench-press", 40.0, 8, at = 900, id = "w1")),
            plan = pushA,
            catalog = listOf(Exercise(id = "bench-press", name = "Bench Press")),
            current = "bench-press"
        )
        assertEquals(listOf("Bench Press", "overhead-press", "cable-fly"), rows.map { it.name })
        assertEquals("a plan line nobody has reached yet was not just added — it is not started",
                     listOf("2 of 5 sets", null, "just added"), rows.map { it.tag })
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
    fun assemblyMetadataKeepsEquipmentUnitsForPerformedAndPlannedSets() {
        val catalog = listOf(Exercise("bar", "Bar", equipment = "barbell"),
            Exercise("pair", "Pair", equipment = "dumbbell", loadCount = 2),
            Exercise("one", "One", equipment = "dumbbell", loadCount = 1),
            Exercise("body", "Body", equipment = "bodyweight"),
            Exercise("other", "Other", equipment = "other"))
        val plan = PlanSnapshot("Walk", catalog.map { PlanEntry(it.id, List(3) { SetTarget(10, 24.0) }) })
        val performed = catalog.map { aSet(it.id, -12.5, 8, 1_000, it.id) }
        val units = listOf("kg total", "kg each", "kg", "kg added", "kg")
        val logged = LiveLines.assemblyRows(catalog.map { it.id }, performed, plan, catalog, "pair")
        assertEquals(units.map { "1 of 3 sets · −12.5 $it × 8" }, logged.map { it.metadata })
        assertEquals(units, logged.map { it.sets.single().unit })
        val planned = LiveLines.assemblyRows(catalog.map { it.id }, emptyList(), plan, catalog, "bar")
        assertEquals(listOf("Up next · 3 × 10 · 24 kg total", "3 × 10 · 24 kg each", "3 × 10 · 24 kg",
            "3 × 10 · 24 kg added", "3 × 10 · 24 kg"), planned.map { it.metadata })
        val varied = LiveLines.assemblyRows(listOf("pair"), listOf(aSet("pair", 22.0, 8, 1_000),
            aSet("pair", 24.0, 10, 2_000)), plan, catalog, "pair")
        assertEquals("2 of 3 sets · 2 × 8–10 · 22–24 kg each", varied.single().metadata)
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
