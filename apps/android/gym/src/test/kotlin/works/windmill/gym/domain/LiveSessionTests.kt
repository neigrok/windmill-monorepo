package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private fun aSet(exerciseId: String, weightKg: Double, reps: Int,
                 at: Long, kind: SetKind = SetKind.Working, id: String = ""): TrainingSet =
    TrainingSet(id = id.ifEmpty { "set_$at" }, exerciseId = exerciseId,
                weightKg = weightKg, reps = reps, kind = kind, completedAtMs = at)

private val pushA = PlanSnapshot(routine = "Push A", entries = listOf(
    PlanEntry(exerciseId = "bench-press", sets = 5, reps = 5, weightKg = 82.5),
    PlanEntry(exerciseId = "overhead-press", sets = 3, reps = 8, weightKg = 45.0),
))

class LiveOrderTests {
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
        val entry = PlanEntry(exerciseId = "bench-press", sets = 3, reps = 5, weightKg = 82.5)
        val counter = LiveLines.counter(workingSetsToday = 3, planEntry = entry)
        assertEquals("set 4 of 3", counter.count)
        assertEquals("plan 3 × 5 @ 82.5", counter.plan)
    }

    @Test
    fun testAMovementWithNoPlanSaysSoRatherThanBorrowingATarget() {
        val counter = LiveLines.counter(workingSetsToday = 0, planEntry = null)
        assertEquals("set 1", counter.count)
        assertEquals("no target", counter.plan)
    }

    @Test
    fun testAPlanWithNoTargetWeightPrintsNoLoad() {
        val entry = PlanEntry(exerciseId = "chin-up", sets = 3, reps = 8)
        assertEquals("plan 3 × 8", LiveLines.counter(workingSetsToday = 1, planEntry = entry).plan)
    }

    @Test
    fun testAPlanWithNoRepTargetReadsAsMax() {
        val entry = PlanEntry(exerciseId = "chin-up", sets = 3)
        val counter = LiveLines.counter(workingSetsToday = 2, planEntry = entry)
        assertEquals("set 3 of 3", counter.count)
        assertEquals("plan 3 × max", counter.plan)

        val loaded = PlanEntry(exerciseId = "chin-up", sets = 3, weightKg = 10.0)
        assertEquals("plan 3 × max @ 10",
                     LiveLines.counter(workingSetsToday = 0, planEntry = loaded).plan)
    }

    @Test
    fun testTheMovementPlaceIsCountedOffTheWalkAndDegradesToSilence() {
        val order = listOf("bench-press", "overhead-press", "cable-fly")

        assertEquals("movement 1 of 3", LiveLines.place(order, "bench-press"))
        assertEquals("movement 3 of 3", LiveLines.place(order, "cable-fly"))
        assertEquals("an appended movement counts the moment it joins the walk",
                     "movement 3 of 3", LiveLines.place(order, order.last()))
        assertNull("a movement the walk does not hold has no place",
                   LiveLines.place(order, "chin-up"))
        assertNull(LiveLines.place(order, null))
        assertNull("a walk of one is not a position worth a line",
                   LiveLines.place(listOf("bench-press"), "bench-press"))
        assertNull(LiveLines.place(emptyList(), "bench-press"))
    }

    @Test
    fun testTheCardTellsAPendingReadFromAFailedOne() {
        val reading = LiveLines.prefillCard(lastTime = null, planEntry = null, routine = null,
                                            readFailed = false, now = 0)
        assertEquals(LiveLines.Card(title = "Last time", body = "reading your log…"), reading)

        val failed = LiveLines.prefillCard(lastTime = null, planEntry = null, routine = null,
                                           readFailed = true, now = 0)
        assertEquals(LiveLines.Card(title = "Last time", body = "the log didn’t answer"), failed)
    }

    @Test
    fun testAMovementNeverTrainedSaysSoAndNamesThePlansNumber() {
        val answered = LastTime(exerciseId = "zercher-squat")
        val entry = PlanEntry(exerciseId = "zercher-squat", sets = 3, reps = 5, weightKg = 60.0)

        assertEquals(LiveLines.Card(title = "First time logging this",
                                    body = "no history — dialled to the plan’s 60 kg"),
                     LiveLines.prefillCard(lastTime = answered, planEntry = entry, routine = null,
                                           readFailed = false, now = 0))

        assertEquals(LiveLines.Card(title = "First time logging this",
                                    body = "no history — start where you like"),
                     LiveLines.prefillCard(lastTime = answered, planEntry = null, routine = null,
                                           readFailed = false, now = 0))
    }

    @Test
    fun testTheCardNamesTheOtherRoutineTheBlockCameFrom() {
        val day = 1_754_000_000_000L
        val answer = LastTime(
            exerciseId = "bench-press",
            session = Session(id = "ses_1", startedAtMs = day, finishedAtMs = day + 1),
            routine = "Push B",
            sets = listOf(aSet("bench-press", 80.0, 5, at = day), aSet("bench-press", 80.0, 5, at = day + 1))
        )
        val card = LiveLines.prefillCard(lastTime = answer, planEntry = null, routine = "Push A",
                                         readFailed = false, now = day + 3 * 86_400_000)
        assertEquals("Last time · ${Readout.day(day)} · 3 days ago  ·  Push B", card.title)
        assertEquals("80 × 5,   80 × 5", card.body)

        val sameDay = LiveLines.prefillCard(lastTime = answer, planEntry = null, routine = "Push B",
                                            readFailed = false, now = day + 3 * 86_400_000)
        assertEquals("Last time · ${Readout.day(day)} · 3 days ago", sameDay.title)
    }

    @Test
    fun testTheCardShowsFourSetsAndCountsTheRest() {
        val day = 1_754_000_000_000L
        val answer = LastTime(
            exerciseId = "bench-press",
            session = Session(id = "ses_1", startedAtMs = day, finishedAtMs = day + 1),
            sets = (0 until 6).map { aSet("bench-press", 80.0, 5, at = day + it) }
        )
        val card = LiveLines.prefillCard(lastTime = answer, planEntry = null, routine = null,
                                         readFailed = false, now = day)
        assertEquals("80 × 5,   80 × 5,   80 × 5,   80 × 5,   +2 more", card.body)
    }

    @Test
    fun testWarmupsCarryAWAndNeverAdvanceTheOrdinal() {
        val rows = LiveLines.rows(listOf(
            aSet("bench-press", 40.0, 8, at = 1_000, kind = SetKind.Warmup, id = "w1"),
            aSet("bench-press", 82.5, 5, at = 2_000, id = "s1"),
            aSet("bench-press", 82.5, 5, at = 3_000, id = "s2"),
        ), stalled = setOf("s2"))

        assertEquals(listOf("w", "1", "2"), rows.map { it.index })
        assertEquals(listOf("warmup", "", "on this device"), rows.map { it.note })
        assertEquals(listOf("40 × 8", "82.5 × 5", "82.5 × 5"), rows.map { it.value })
        assertEquals(listOf(true, false, false), rows.map { it.isWarmup })
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
                                       planEntry = pushA.entry("bench-press")).count)

        val rows = LiveLines.assemblyRows(order = listOf("bench-press"), sets = sets, plan = pushA,
                                          catalog = listOf(Exercise(id = "bench-press", name = "Bench Press")),
                                          current = "bench-press")
        assertEquals(listOf("2 of 5 sets"), rows.map { it.tag })
        assertEquals("the card draws every set that was performed, drops and warmups included",
                     listOf(5), rows.map { it.sets.size })

        assertEquals("the today list numbers what was performed, which is not what counts",
                     listOf("w", "1", "2", "3", "4"),
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
        assertEquals("1 set is saved on this device only. No signal down here — they flush when you’re back up.",
                     LiveLines.onThisDeviceLine(1, Blocker.Offline))
        assertEquals("3 sets are saved on this device only. No signal down here — they flush when you’re back up.",
                     LiveLines.onThisDeviceLine(3, Blocker.Offline))
    }

    @Test
    fun testTheStripNamesWhatBlockedTheSetsRatherThanAssertingNoSignal() {
        assertEquals("2 sets are saved on this device only. The log didn’t answer — they flush when it does.",
                     LiveLines.onThisDeviceLine(2, Blocker.LogFailed))
        assertEquals("1 set is saved on this device only. Your sign-in lapsed — they flush once you sign in again.",
                     LiveLines.onThisDeviceLine(1, Blocker.SignInLapsed))
        assertEquals("1 set is saved on this device only. They flush when the log takes them.",
                     LiveLines.onThisDeviceLine(1, null))
    }
}
