package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The decisions the logger makes before it draws anything: which movements a session holds and in
// what order, where a lifter is standing when they come back to a workout that never stopped, and
// the four different things the card above the weight is allowed to say.

private fun aSet(exerciseId: String, weightKg: Double, reps: Int,
                 at: Long, kind: SetKind = SetKind.Working, id: String = ""): TrainingSet =
    TrainingSet(id = id.ifEmpty { "set_$at" }, exerciseId = exerciseId,
                weightKg = weightKg, reps = reps, kind = kind, completedAtMs = at)

private val pushA = PlanSnapshot(routine = "Push A", entries = listOf(
    PlanEntry(exerciseId = "bench-press", sets = 5, reps = 5, weightKg = 82.5),
    PlanEntry(exerciseId = "overhead-press", sets = 3, reps = 8, weightKg = 45.0),
))

class LiveOrderTests {
    // The plan is the session's spine, and a movement the plan never named still belongs to the
    // workout that performed it — it lands after the written ones, in the order it happened.
    @Test
    fun testThePlanLeadsAndWhateverElseWasLiftedFollowsIt() {
        val order = LiveOrder.merged(
            held = emptyList(),
            plan = pushA,
            sets = listOf(aSet("cable-fly", 22.5, 12, at = 3_000), aSet("bench-press", 82.5, 5, at = 1_000))
        )
        assertEquals(listOf("bench-press", "overhead-press", "cable-fly"), order)
    }

    // A movement appended on the bench mid-rest belongs where the lifter put it. A second pass that
    // re-sorted it behind the plan would move the list under a thumb already reaching for it.
    @Test
    fun testAMovementAlreadyHeldKeepsItsPlaceAtTheHead() {
        val order = LiveOrder.merged(held = listOf("cable-fly", "bench-press"), plan = pushA, sets = emptyList())
        assertEquals(listOf("cable-fly", "bench-press", "overhead-press"), order)
    }

    // A movement chosen and not yet logged is an intention, and it survives — that is the whole of
    // "no sets yet — logging one starts it".
    @Test
    fun testAMovementWithNoSetsStaysInTheOrder() {
        val order = LiveOrder.merged(held = listOf("romanian-deadlift"), plan = null, sets = emptyList())
        assertEquals(listOf("romanian-deadlift"), order)
    }

    // Coming back to a workout that never stopped stands where the last set went, not at the head of
    // a plan the lifter finished with two movements ago.
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
    // "set 4 of 3" is legal, normal, and says both true things at once: the plan is what was written
    // down, the log is what happened. Nothing here warns and nothing hides the target.
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

    // A routine line that names sets and reps and leaves the load to last time prints no load —
    // never a zero, which would be a target nobody wrote.
    @Test
    fun testAPlanWithNoTargetWeightPrintsNoLoad() {
        val entry = PlanEntry(exerciseId = "chin-up", sets = 3, reps = 8)
        assertEquals("plan 3 × 8", LiveLines.counter(workingSetsToday = 1, planEntry = entry).plan)
    }

    // A rep target the routine declined to set is `max` — a chin-up taken to whatever it gives that
    // day. It is not a zero and it is not a blank, and the plan line has to be able to say it or a
    // program with chin-ups in it cannot be drawn.
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

    // Four states, not two. A read still in flight and a read that failed are different facts, and
    // ONLY an answer may say "first time" — a card claiming no history over a movement squatted for
    // a year, because the phone was in a basement, is the product lying in the pixel it exists for.
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

    // The card names the day of the program that block came from when it was not this one. Hiding
    // that difference is what makes a lifter read Tuesday's numbers as Thursday's.
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

    // Warmups carry a w and never advance the counter — they count toward no volume, no record and
    // no history, and a row that numbered them would be the first place that stopped being true.
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

    // ONE WORD FOR WHAT COUNTS. A drop and a failure are things that happened to a set the plan never
    // asked for, so neither advances "set 3 of 5" and neither counts toward a movement's tally — the
    // same word log.js `workingSetsOf` counts on, over the same stored session. The phone counted
    // everything that was not a warmup and said "set 5 of 5" where the desk said "set 4 of 5".
    //
    // THE TODAY LIST IS DELIBERATELY NOT THIS RULE: its ordinal numbers every set that is not a
    // warmup, drops included, because that column is the record of what was performed and not a
    // count toward the plan — Logger.jsx's TodayList numbers them the same way.
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

    // A movement with nothing in it says what would start it, rather than reading as a mistake.
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

    // WHAT A SWIPE MAY TAKE, and it is the narrowest thing in this wave. A movement holding a set is
    // a lifter's own logged work and never leaves on a sideways flick; a movement the PLAN names
    // would walk straight back on at the next draw (`merged`), so the gesture is not offered on it
    // either. Everything appended on the bench is free to go.
    @Test
    fun testASwipeDropsOnlyAMovementThatIsNeitherLoggedNorPlanned() {
        val sets = listOf(aSet("bench-press", 82.5, 5, at = 1_000))

        assertEquals(false, LiveOrder.droppable("bench-press", sets, pushA))
        assertEquals(false, LiveOrder.droppable("overhead-press", sets, pushA))
        assertEquals(true, LiveOrder.droppable("cable-fly", sets, pushA))
        assertEquals("with no plan, a movement holding a set is still the lifter's own work",
                     false, LiveOrder.droppable("bench-press", sets, plan = null))
    }

    // THE GRAB RAIL MOVES THE WALK AND NOTHING ELSE. A reorder is a permutation: the list that comes
    // back holds exactly what went in, whichever way the finger went, because a movement lost by a
    // drag would be a logged movement off the screen it is being logged on.
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

    // An index nobody can point at leaves the list alone: the gesture that hands these in is a thumb
    // on a list that is moving under it.
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
        assertNull(LiveLines.onThisDeviceLine(0))
        assertEquals("1 set is saved on this device only. No signal down here — they flush when you’re back up.",
                     LiveLines.onThisDeviceLine(1))
        assertEquals("3 sets are saved on this device only. No signal down here — they flush when you’re back up.",
                     LiveLines.onThisDeviceLine(3))
    }
}
