package works.windmill.gym.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Against
import works.windmill.gym.domain.AgainstMovement
import works.windmill.gym.domain.Effort
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.PersonalRecord
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.PlannedLine
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.TrainingSet

private val catalog = listOf(
    Exercise(id = "back-squat", name = "Back Squat"),
    Exercise(id = "leg-press", name = "Leg Press"),
)

private fun straight(sets: Int, reps: Int? = null, weightKg: Double? = null): List<SetTarget> =
    List(sets) { SetTarget(reps, weightKg) }

class FinishTests {
    @Test
    fun comparisonDrawsEverySetAndFiniteRangeWithoutSubtractingEndpoints() {
        val vectors = listOf(
            Effort(3, 8, 80.0, minReps = 6, maxReps = 8, minWeightKg = 75.0) to "3 × 6–8 · 75–80",
            Effort(3, 1, 100.0, minReps = 1, maxReps = 12, minWeightKg = 60.0) to "3 × 1–12 · 60–100",
            Effort(3, 8, 0.0, minReps = 6, maxReps = 8) to "3 × 6–8",
            Effort(3, 8, 0.0, minReps = 6, maxReps = 8, minWeightKg = -20.0) to "3 × 6–8 · −20–0",
            Effort(2, 8, Double.MAX_VALUE, minWeightKg = -Double.MAX_VALUE) to
                "2 × 8 · ${Readout.weight(-Double.MAX_VALUE)}–${Readout.weight(Double.MAX_VALUE)}",
        )
        for ((effort, expected) in vectors) {
            val review = Review(against = Against("before", startedAtMs = 1,
                movements = listOf(AgainstMovement("back-squat", effort))))
            val ended = FinishedSession(Session("now", startedAtMs = 2, finishedAtMs = 3), sets = emptyList(), review = review)
            val saved = works.windmill.platform.net.WindmillJson.encodeToString(FinishedSession.serializer(), ended)
            val restored = works.windmill.platform.net.WindmillJson.decodeFromString(FinishedSession.serializer(), saved)
            assertEquals(ended, restored)
            assertEquals(listOf(expected), Finish.comparison(restored.review?.against, catalog)?.rows?.map { it.detail })
        }
    }

    @Test fun volumeKeepsOrdinaryGroupingAndUsesCompleteFiniteScientificReadouts() {
        assertEquals(listOf("0", "2,505", "1,234.56", "—", "—"),
            listOf(0.0, 2505.0, 1234.56, null, Double.POSITIVE_INFINITY).map(Finish::volume))
        assertEquals("1.7976931348623157e+308", Finish.volume(Double.MAX_VALUE))
        assertEquals("1e+21", Finish.volume(1e21))
    }

    @Test
    fun noRecordDrawsNoLineAtAll() {
        assertNull(Finish.recordSentence(null, catalog))
    }

    @Test
    fun eachKindOfRecordNamesWhatItBeatAndWhen() {
        val past = 1_750_723_200_000L
        val e1rm = PersonalRecord(kind = "e1rm", exerciseId = "back-squat", value = 122.5,
                                  weightKg = 105.0, reps = 5, previous = 116.7, previousAtMs = past)
        assertEquals("Back Squat e1RM 122.5 kg — past 116.7 from ${Readout.day(past)}.",
                     Finish.recordSentence(e1rm, catalog))

        val heaviest = PersonalRecord(kind = "heaviest", exerciseId = "back-squat", value = 140.0,
                                      weightKg = 140.0, reps = 1, previous = 135.0, previousAtMs = past)
        assertEquals("Back Squat 140 kg × 1 — past 135 from ${Readout.day(past)}.",
                     Finish.recordSentence(heaviest, catalog))

        val reps = PersonalRecord(kind = "reps-at-weight", exerciseId = "back-squat", value = 8.0,
                                  weightKg = 100.0, reps = 8, previous = 6.0, previousAtMs = past)
        assertEquals("Back Squat 8 reps at 100 kg — past 6 from ${Readout.day(past)}.",
                     Finish.recordSentence(reps, catalog))
    }

    @Test
    fun aRecordKindThisBuildHasNeverHeardOfDrawsNothing() {
        val unheard = PersonalRecord(kind = "volume-at-bodyweight", exerciseId = "back-squat",
                                     value = 9.0, weightKg = 100.0, reps = 9,
                                     previous = 8.0, previousAtMs = 1_750_723_200_000L)
        assertNull(Finish.recordSentence(unheard, catalog))
    }

    @Test
    fun theComparisonPointsFromThePlanAndFallsBackToLastTime() {
        val against = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1_750_723_200_000,
            movements = listOf(
                AgainstMovement(exerciseId = "back-squat",
                                now = Effort(sets = 5, reps = 5, weightKg = 105.0),
                                before = Effort(sets = 5, reps = 5, weightKg = 102.5),
                                planned = PlannedLine(straight(5, 5, 102.5))),
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 3, reps = 12, weightKg = 140.0),
                                before = Effort(sets = 3, reps = 12, weightKg = 135.0)),
            ))
        val comparison = Finish.comparison(against, catalog)
        assertEquals("Comparison", comparison?.title)
        assertEquals(listOf("Back Squat", "Leg Press"), comparison?.rows?.map { it.movement })
        assertEquals(listOf("Plan: 5 × 5 · 102.5 → 5 × 5 · 105", "Last time: 3 × 12 · 135 → 3 × 12 · 140"),
                     comparison?.rows?.map { it.detail })
    }

    @Test
    fun aMovementThatFellShortOfThePlanSaysItPlainly() {
        val against = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 3, reps = 10, weightKg = 140.0),
                                planned = PlannedLine(straight(3, 12, 140.0))),
            ))
        assertEquals(listOf("planned 3 × 12 · 140 — did 3 × 10 · 140"),
                     Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun aBodyweightMovementPrintsNoLoad() {
        val against = Against(sessionId = "ses_0", routine = "Pull A", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 3, reps = 8, weightKg = 0.0),
                                before = Effort(sets = 3, reps = 7, weightKg = 0.0)),
            ))
        assertEquals(listOf("3 × 7 → 3 × 8"), Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun aMovementWithNoRepTargetReadsAsMaxAndNeverAsAShortfall() {
        val against = Against(sessionId = "ses_0", routine = "Pull A", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 3, reps = 6, weightKg = 0.0),
                                planned = PlannedLine(straight(3))),
            ))
        assertEquals(listOf("3 × max → 3 × 6"),
                     Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun aPlanThatNamesNoRepTargetCannotBeFallenShortOf() {
        val against = Against(sessionId = "ses_0", routine = "Pull A", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 2, reps = 4, weightKg = 0.0),
                                planned = PlannedLine(straight(3))),
            ))
        assertEquals(listOf("3 × max → 2 × 4"),
                     Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun aSessionThatRampedThroughItsWholePlanIsNeverToldItFellShort() {
        val ramped = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "back-squat",
                                now = Effort(sets = 3, reps = 5, weightKg = 110.0),
                                before = Effort(sets = 3, reps = 5, weightKg = 105.0),
                                planned = PlannedLine(straight(5, 5, 100.0))),
            ))
        assertEquals(listOf("5 × 5 · 100 → 3 × 5 · 110"),
                     Finish.comparison(ramped, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun goingHeavierForFewerRepsIsADifferentSessionAndNotASmallerOne() {
        val heavier = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 5, reps = 8, weightKg = 160.0),
                                planned = PlannedLine(straight(3, 12, 140.0))),
            ))
        assertEquals(listOf("3 × 12 · 140 → 5 × 8 · 160"),
                     Finish.comparison(heavier, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun whatIsCalledShortIsTheRepsAtALoadThatDidNotGoUp() {
        val heldLoad = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 3, reps = 10, weightKg = 140.0),
                                planned = PlannedLine(straight(3, 12, 140.0))),
            ))
        assertEquals(listOf("planned 3 × 12 · 140 — did 3 × 10 · 140"),
                     Finish.comparison(heldLoad, catalog)?.rows?.map { it.detail })

        val noLoadNamed = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 3, reps = 6, weightKg = 0.0),
                                planned = PlannedLine(straight(3, 8))),
            ))
        assertEquals(listOf("planned 3 × 8 — did 3 × 6"),
                     Finish.comparison(noLoadNamed, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun anOpenRowPointsFromLastTimeAndNeverFromATargetItNeverHad() {
        val open = Against(sessionId = "ses_0", routine = "Heavy Thursday", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "barbell-row",
                                now = Effort(sets = 3, reps = 10, weightKg = 60.0),
                                before = Effort(sets = 3, reps = 10, weightKg = 57.5),
                                planned = PlannedLine()),
            ))
        assertEquals(listOf("3 × 10 · 57.5 → 3 × 10 · 60"),
                     Finish.comparison(open, catalog)?.rows?.map { it.detail })

        val firstRun = Against(sessionId = "ses_0", routine = "Heavy Thursday", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "barbell-row",
                                now = Effort(sets = 3, reps = 10, weightKg = 60.0),
                                planned = PlannedLine()),
            ))
        assertEquals(listOf("3 × 10 · 60"),
                     Finish.comparison(firstRun, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun aRampReadsAsItsRangeAndTheTopSetStandsAgainstThePlansTopSet() {
        val ramp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))
        fun detail(now: Effort, planned: List<SetTarget>) =
            Finish.comparison(Against(sessionId = "ses_0", routine = "Lower A", startedAtMs = 1,
                movements = listOf(AgainstMovement(exerciseId = "back-squat", now = now, planned = PlannedLine(planned)))),
                catalog)?.rows?.single()?.detail

        assertEquals("5 × 1–5 · 60–100 → 1 × 1 · 100", detail(Effort(sets = 1, reps = 1, weightKg = 100.0), ramp))
        assertEquals("5 × 1–5 · 60–100 → 1 × 3 · 90", detail(Effort(sets = 1, reps = 3, weightKg = 90.0), ramp))
        assertEquals("planned 3 × 3–5 · 60–100 — did 1 × 2 · 100",
                     detail(Effort(sets = 1, reps = 2, weightKg = 100.0),
                            listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 100.0))))
        // A top set to max: the first set at the heaviest load names the 5 a 100 × 3 fell short of.
        assertEquals("planned 3 × 5–max · 100 — did 1 × 3 · 100",
                     detail(Effort(sets = 1, reps = 3, weightKg = 100.0),
                            listOf(SetTarget(5, 100.0), SetTarget(5, 100.0), SetTarget(null, 100.0))))
        assertEquals("3 × 8 · −20", detail(Effort(sets = 3, reps = 8, weightKg = -20.0), emptyList()))
    }

    @Test
    fun anAdHocSessionHasNothingToCompareAgainst() {
        assertNull(Finish.comparison(null, catalog))
    }
}


class RecordEstimateFormattingTests {
    private val bench = listOf(Exercise("bench-press", "Bench Press"))

    @Test
    fun aRecordKeepsItsApprovedTenthForCurrentAndPriorEstimates() {
        val record = PersonalRecord("e1rm", "bench-press", 80.0 * (1 + 8 / 30.0), 80.0, 8, 70.0 * (1 + 8 / 30.0), 1_000)
        assertEquals("Bench Press e1RM 101.3 kg — past 88.7 from ${Readout.day(1_000)}.", Finish.recordSentence(record, bench))
    }

    @Test
    fun aHugeFiniteEstimateRetainsItsCompleteFiniteSpelling() {
        val record = PersonalRecord("e1rm", "bench-press", Double.MAX_VALUE, Double.MAX_VALUE, 1, Double.MAX_VALUE / 2, 1_000)
        val text = Finish.recordSentence(record, bench)!!
        assertEquals("Bench Press e1RM ${Readout.estimatedWeight(Double.MAX_VALUE)} kg — past ${Readout.estimatedWeight(Double.MAX_VALUE / 2)} from ${Readout.day(1_000)}.", text)
        assertFalse(text.contains("Infinity"))
        assertFalse(text.contains("NaN"))
    }
}

class FinishedSessionTests {
    private fun session(routineId: String?) =
        Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 900_000, routineId = routineId)

    private val lifted = List(4) { index ->
        TrainingSet(id = "set_$index", exerciseId = "back-squat", weightKg = 100.0, reps = 5,
                    completedAtMs = 2_000L + index)
    }

    @Test
    fun actualSetCountDecidesTheHeadingWithoutDependingOnReview() {
        val misleading = Review(PersonalRecord("heaviest", "back-squat", 100.0, 100.0, 5, 90.0, 0))
        for (review in listOf(null, misleading)) {
            for (count in 0..4) {
                val ended = FinishedSession(session = session(null), sets = lifted.take(count), review = review)
                assertEquals(count < 4, ended.slight)
            }
        }
    }

    @Test
    fun actualReceiptTotalsIncludeEverySetWithEquipmentLoadCounts() {
        val bench = List(3) { index -> TrainingSet("bench_$index", "bench-press", weightKg = 60.0, reps = 8, completedAtMs = 100L + index) }
        val press = List(3) { index -> TrainingSet("press_$index", "overhead-press", weightKg = 30.0, reps = 8, completedAtMs = 200L + index) }
        val raise = List(3) { index -> TrainingSet("raise_$index", "lateral-raise", weightKg = 18.0, reps = 10, completedAtMs = 300L + index) }
        val movements = listOf(Exercise("bench-press", "Bench Press"), Exercise("overhead-press", "Overhead Press"),
            Exercise("lateral-raise", "Lateral Raise", equipment = "dumbbell"))
        fun summary(finished: FinishedSession) = SessionSummary(finished.session, finished.sets, movements)
        for (count in 1..3) {
            val partial = FinishedSession(session(null), bench.take(count), null)
            assertEquals(listOf(count, count * 480.0, listOf("bench-press"), true),
                listOf(summary(partial).setCount, summary(partial).tonnageKg, summary(partial).exercises, partial.slight))
        }
        val full = FinishedSession(session(null), bench + press + raise, null)
        assertEquals(listOf(9, 3240.0, listOf("bench-press", "overhead-press", "lateral-raise"), false),
            listOf(summary(full).setCount, summary(full).tonnageKg, summary(full).exercises, full.slight))
        val free = FinishedSession(session(null), listOf(bench.first().copy(weightKg = 57.5)), null)
        assertEquals(listOf(1, 460.0, true), listOf(summary(free).setCount, summary(free).tonnageKg, free.slight))
        val extra = full.copy(sets = full.sets + bench.first().copy(id = "warm"))
        assertEquals(listOf(10, 10, 3720.0), listOf(summary(extra).setCount, summary(extra).workingSetCount, summary(extra).tonnageKg))
    }

}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class ShareWithCoachTests {
    @get:Rule
    val compose = createComposeRule()

    private val short = FinishedSession(
        session = Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 660_000),
        sets = listOf(
            TrainingSet(id = "set_1", exerciseId = "back-squat", weightKg = 100.0, reps = 5,
                        completedAtMs = 2_000),
        ),
        review = Review(),
    )

    private val ordinary = FinishedSession(
        session = Session(id = "ses_2", startedAtMs = 1_000, finishedAtMs = 3_600_000),
        sets = List(4) { index -> short.sets.single().copy(id = "set_$index", completedAtMs = 2_000L + index) },
        review = Review(),
    )

    // One composition per test, redrawn off state: a test walks both branches through it.
    private val shown = mutableStateOf(ordinary)
    private val shared = mutableStateOf(0)
    private val reachable = mutableStateOf(true)

    private fun receipt() {
        compose.setContent {
            FinishScreen(
                finished = shown.value,
                catalog = catalog,
                onShareWithCoach = if (reachable.value) { { shared.value += 1 } } else null,
            )
        }
    }

    private fun show(finished: FinishedSession) {
        compose.runOnIdle { shown.value = finished }
        compose.waitForIdle()
    }

    @Test
    fun shareUsesTheApprovedWorkoutQuestion() {
        assertEquals("Share with Coach", FinishCoach.action)
        assertEquals("Check my last workout.", FinishCoach.question)
    }

    @Test
    fun bothReceiptBranchesKeepShareAndDoneOutsideTheScrollBody() {
        receipt()
        listOf(ordinary, short).forEachIndexed { taps, finished ->
            show(finished)
            compose.onAllNodesWithText(FinishCoach.action).assertCountEquals(1)
            compose.onNodeWithText(FinishCoach.action).assertIsDisplayed().performClick()
            compose.onNodeWithText("Done").assertIsDisplayed()
            compose.runOnIdle { assertEquals(taps + 1, shared.value) }
            compose.onNodeWithText("Against plan").assertDoesNotExist()
            compose.onNodeWithText("Workout saved", substring = true).assertDoesNotExist()
        }
    }

    @Test
    fun aDeploymentWithoutCoachStillOffersDone() {
        reachable.value = false
        receipt()
        listOf(ordinary, short).forEach { finished ->
            show(finished)
            compose.onNodeWithText(FinishCoach.action).assertDoesNotExist()
            compose.onNodeWithText("Done").assertIsDisplayed()
        }
    }

    @Test
    fun theOverflowOwnsDiscardAndTheReceiptHasNoLinkOrRoutineSave() {
        var discards = 0
        compose.setContent { FinishScreen(ordinary, catalog, onDiscard = { discards++ }) }
        compose.onNodeWithText("Discard").assertDoesNotExist()
        compose.onNodeWithContentDescription("More").assertIsDisplayed().performClick()
        compose.onNodeWithText("Discard").assertIsDisplayed().performClick()
        assertEquals(1, discards)
        compose.onNodeWithText("Save a routine").assertDoesNotExist()
        compose.onNodeWithText("Share this workout").assertDoesNotExist()
        compose.onNodeWithText(Finish.discard).assertDoesNotExist()
    }

    @Test
    fun titleAndCommittedDateDoNotDependOnReview() {
        receipt()
        compose.onNodeWithText("Well done.").assertIsDisplayed()
        compose.onNodeWithText("Free workout · ${Finish.day(ordinary.session.startedAtMs)}").assertIsDisplayed()
        show(short)
        compose.onNodeWithText("Ended early.").assertIsDisplayed()
        compose.onNodeWithText("Free workout · ${Finish.day(short.session.startedAtMs)}").assertIsDisplayed()
    }

    @Test
    fun zeroSetsUsesOnlyTheTerminalCopyAndDone() {
        var done = 0
        compose.setContent { FinishScreen(short.copy(sets = emptyList()), catalog,
            onDone = { done++ }, onShareWithCoach = {}, onDiscard = {}, onKeep = {}) }
        compose.onNodeWithText("No sets logged").assertIsDisplayed()
        compose.onNodeWithText("This workout has ended.").assertIsDisplayed()
        compose.onNodeWithText("Done").performClick()
        assertEquals(1, done)
        for (text in listOf("Duration", "Sets", "Volume", "Ended early.", "Keep it", FinishCoach.action)) {
            compose.onNodeWithText(text).assertDoesNotExist()
        }
        compose.onNodeWithContentDescription("More").assertDoesNotExist()
    }
}
