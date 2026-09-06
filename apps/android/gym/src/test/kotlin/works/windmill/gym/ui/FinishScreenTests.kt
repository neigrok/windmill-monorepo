package works.windmill.gym.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
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
import works.windmill.gym.domain.ReviewStats
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.Target
import works.windmill.gym.domain.TrainingSet

private val catalog = listOf(
    Exercise(id = "back-squat", name = "Back Squat"),
    Exercise(id = "leg-press", name = "Leg Press"),
)

class FinishTests {
    private val started = 1_754_308_320_000L     // Tue 4 Aug 2025, 18:12 local
    private val finished = started + 3_720_000L

    @Test
    fun aFinishedSessionIsCongratulatedAndAShortOneIsNot() {
        val ordinary = Finish.head(startedAtMs = started, finishedAtMs = finished,
                                   routine = "Legs", slight = false, first = false)
        assertEquals("Well done.", ordinary.title)
        assertEquals("Legs", ordinary.subtitle)
        assertEquals("${Readout.day(started)} · ${Readout.time(started)} – ${Readout.time(finished)}",
                     ordinary.at)

        val short = Finish.head(startedAtMs = started, finishedAtMs = finished,
                                routine = "Pull A", slight = true, first = false)
        assertEquals("a congratulation on two sets would be a small lie", "Ended early.", short.title)
        assertEquals("Pull A", short.subtitle)
    }

    @Test
    fun aSessionWithNoRoutineIsNamedByWhetherItIsTheFirstOne() {
        assertEquals("Your first session",
                     Finish.head(startedAtMs = started, finishedAtMs = finished,
                                 routine = null, slight = false, first = true).subtitle)
        assertEquals("No routine",
                     Finish.head(startedAtMs = started, finishedAtMs = finished,
                                 routine = null, slight = false, first = false).subtitle)
    }

    @Test
    fun theThreeFactsAreDurationWorkingSetsAndTopE1rm() {
        val tiles = Finish.tiles(ReviewStats(durationMs = 3_720_000, workingSets = 16, topE1rm = 122.5))
        assertEquals(listOf("Duration", "Working sets", "Top e1RM"), tiles.map { it.label })
        assertEquals(listOf("1h 02m", "16", "122.5"), tiles.map { it.value })
    }

    @Test
    fun aSessionWithNoLoadedSetShowsADashRatherThanAZero() {
        val tiles = Finish.tiles(ReviewStats(durationMs = 660_000, workingSets = 3, topE1rm = null))
        assertEquals(listOf("11m", "3", "—"), tiles.map { it.value })
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
    fun aRecordThatNamesNothingItBeatDrawsNothing() {
        val firstEntry = PersonalRecord(kind = "e1rm", exerciseId = "back-squat", value = 122.5,
                                        weightKg = 105.0, reps = 5)
        assertNull(Finish.recordSentence(firstEntry, catalog))
    }

    @Test
    fun theComparisonPointsFromThePlanAndFallsBackToLastTime() {
        val against = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1_750_723_200_000,
            movements = listOf(
                AgainstMovement(exerciseId = "back-squat",
                                now = Effort(sets = 5, reps = 5, weightKg = 105.0),
                                before = Effort(sets = 5, reps = 5, weightKg = 102.5),
                                planned = Target(sets = 5, reps = 5, weightKg = 102.5)),
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 3, reps = 12, weightKg = 140.0),
                                before = Effort(sets = 3, reps = 12, weightKg = 135.0)),
            ))
        val comparison = Finish.comparison(against, catalog)
        assertEquals("Against last Legs", comparison?.title)
        assertEquals(listOf("Back Squat", "Leg Press"), comparison?.rows?.map { it.movement })
        assertEquals(listOf("5×5 @ 102.5 → 5×5 @ 105", "3×12 @ 135 → 3×12 @ 140"),
                     comparison?.rows?.map { it.detail })
    }

    @Test
    fun aMovementThatFellShortOfThePlanSaysItPlainly() {
        val against = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 3, reps = 10, weightKg = 140.0),
                                planned = Target(sets = 3, reps = 12, weightKg = 140.0)),
            ))
        assertEquals(listOf("planned 3×12 · did 3×10"),
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
        assertEquals(listOf("3×7 → 3×8"), Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun aMovementWithNoRepTargetReadsAsMaxAndNeverAsAShortfall() {
        val against = Against(sessionId = "ses_0", routine = "Pull A", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 3, reps = 6, weightKg = 0.0),
                                planned = Target(sets = 3)),
            ))
        assertEquals(listOf("3 × max → 3×6"),
                     Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun aPlanThatNamesNoRepTargetCannotBeFallenShortOf() {
        val against = Against(sessionId = "ses_0", routine = "Pull A", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 2, reps = 4, weightKg = 0.0),
                                planned = Target(sets = 3)),
            ))
        assertEquals(listOf("3 × max → 2×4"),
                     Finish.comparison(against, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun aSessionThatRampedThroughItsWholePlanIsNeverToldItFellShort() {
        val ramped = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "back-squat",
                                now = Effort(sets = 3, reps = 5, weightKg = 110.0),
                                before = Effort(sets = 3, reps = 5, weightKg = 105.0),
                                planned = Target(sets = 5, reps = 5, weightKg = 100.0)),
            ))
        assertEquals(listOf("5×5 @ 100 → 3×5 @ 110"),
                     Finish.comparison(ramped, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun goingHeavierForFewerRepsIsADifferentSessionAndNotASmallerOne() {
        val heavier = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 5, reps = 8, weightKg = 160.0),
                                planned = Target(sets = 3, reps = 12, weightKg = 140.0)),
            ))
        assertEquals(listOf("3×12 @ 140 → 5×8 @ 160"),
                     Finish.comparison(heavier, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun whatIsCalledShortIsTheRepsAtALoadThatDidNotGoUp() {
        val heldLoad = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "leg-press",
                                now = Effort(sets = 3, reps = 10, weightKg = 140.0),
                                planned = Target(sets = 3, reps = 12, weightKg = 140.0)),
            ))
        assertEquals(listOf("planned 3×12 · did 3×10"),
                     Finish.comparison(heldLoad, catalog)?.rows?.map { it.detail })

        val noLoadNamed = Against(sessionId = "ses_0", routine = "Legs", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "chin-up",
                                now = Effort(sets = 3, reps = 6, weightKg = 0.0),
                                planned = Target(sets = 3, reps = 8)),
            ))
        assertEquals(listOf("planned 3×8 · did 3×6"),
                     Finish.comparison(noLoadNamed, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun anOpenRowPointsFromLastTimeAndNeverFromATargetItNeverHad() {
        val open = Against(sessionId = "ses_0", routine = "Heavy Thursday", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "barbell-row",
                                now = Effort(sets = 3, reps = 10, weightKg = 60.0),
                                before = Effort(sets = 3, reps = 10, weightKg = 57.5),
                                planned = Target()),
            ))
        assertEquals(listOf("3×10 @ 57.5 → 3×10 @ 60"),
                     Finish.comparison(open, catalog)?.rows?.map { it.detail })

        val firstRun = Against(sessionId = "ses_0", routine = "Heavy Thursday", startedAtMs = 1,
            movements = listOf(
                AgainstMovement(exerciseId = "barbell-row",
                                now = Effort(sets = 3, reps = 10, weightKg = 60.0),
                                planned = Target()),
            ))
        assertEquals(listOf("3×10 @ 60"),
                     Finish.comparison(firstRun, catalog)?.rows?.map { it.detail })
    }

    @Test
    fun anAdHocSessionHasNothingToCompareAgainst() {
        assertNull(Finish.comparison(null, catalog))
    }
}

class FinishedSessionTests {
    private fun session(routineId: String?) =
        Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 900_000, routineId = routineId)

    private val lifted = listOf(
        TrainingSet(id = "set_1", exerciseId = "back-squat", weightKg = 100.0, reps = 5,
                    completedAtMs = 2_000),
    )

    @Test
    fun keepingASessionAsARoutineIsOfferedOnlyWhenThereWasNoRoutine() {
        assertTrue(FinishedSession(session = session(routineId = null), sets = lifted,
                                   review = null, isFirst = true).offersRoutine)
        assertFalse(FinishedSession(session = session(routineId = "rt_1"), sets = lifted,
                                    review = null, isFirst = false).offersRoutine)
    }

    @Test
    fun aSessionOfNothingButWarmupsIsNotOfferedAsARoutine() {
        val warmups = listOf(
            TrainingSet(id = "set_1", exerciseId = "back-squat", weightKg = 60.0, reps = 5,
                        kind = SetKind.Warmup, completedAtMs = 2_000),
        )
        assertFalse(FinishedSession(session = session(routineId = null), sets = warmups,
                                    review = null, isFirst = true).offersRoutine)
    }

    @Test
    fun aShortSessionIsNeverAlsoOfferedAsARoutine() {
        val short = Review(stats = ReviewStats(durationMs = 660_000, workingSets = 3), slight = true)
        val ended = FinishedSession(session = session(routineId = null), sets = lifted,
                                    review = short, isFirst = true)

        assertTrue(ended.slight)
        assertFalse("too slight to say anything about is too slight to keep as a routine",
                    ended.offersRoutine)
        assertEquals("Ended early.",
                     Finish.head(startedAtMs = 1_000, finishedAtMs = 900_000, routine = null,
                                 slight = ended.slight, first = ended.isFirst).title)
    }

    @Test
    fun withoutAReviewASessionIsNeverCalledShort() {
        assertFalse(FinishedSession(session = session(routineId = null), sets = lifted,
                                    review = null, isFirst = false).slight)

        val short = Review(stats = ReviewStats(durationMs = 660_000, workingSets = 3), slight = true)
        assertTrue(FinishedSession(session = session(routineId = null), sets = lifted,
                                   review = short, isFirst = false).slight)
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
        review = Review(stats = ReviewStats(durationMs = 660_000, workingSets = 3), slight = true),
        isFirst = false,
    )

    private val ordinary = FinishedSession(
        session = Session(id = "ses_2", startedAtMs = 1_000, finishedAtMs = 3_600_000),
        sets = short.sets,
        review = Review(stats = ReviewStats(durationMs = 3_600_000, workingSets = 5)),
        isFirst = false,
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
                kept = false,
                onKeepRoutine = {},
                onShareWithCoach = if (reachable.value) { { shared.value += 1 } } else null,
            )
        }
    }

    private fun show(finished: FinishedSession) {
        compose.runOnIdle { shown.value = finished }
        compose.waitForIdle()
    }

    // The bytes are pinned: the caption names the exact line the tap sends, so the two cannot drift.
    @Test
    fun theFourStringsAreTheContractsBytes() {
        assertEquals("Share with Coach", FinishCoach.action)
        assertEquals("Sends Coach one line — “Check my last session.” — and opens the answer.",
                     FinishCoach.caption)
        assertEquals("Check my last session.", FinishCoach.question)
        assertEquals("Well done.",
                     Finish.head(startedAtMs = 1_000, finishedAtMs = 3_600_000, routine = null,
                                 slight = false, first = false).title)
        assertEquals("Ended early.",
                     Finish.head(startedAtMs = 1_000, finishedAtMs = 660_000, routine = null,
                                 slight = true, first = false).title)
    }

    // One primary, one caption, on BOTH branches — the short session is exactly the one worth a
    // second opinion — and the tap reaches the room once.
    @Test
    fun theOnePrimaryStandsOnBothBranchesAndReachesTheRoomOnce() {
        receipt()
        listOf(ordinary, short).forEachIndexed { taps, finished ->
            show(finished)
            compose.onAllNodesWithText(FinishCoach.action).assertCountEquals(1)
            compose.onNodeWithText(FinishCoach.caption).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(FinishCoach.action).performScrollTo().performClick()
            compose.runOnIdle { assertEquals(finished.session.id, taps + 1, shared.value) }
        }
    }

    // Where Coach cannot be reached nothing stands in the primary's place: the receipt is the head,
    // the readout, the optional routine card, and the dismissal the platform draws.
    @Test
    fun withoutCoachNothingStandsWhereThePrimaryWould() {
        reachable.value = false
        receipt()
        listOf(ordinary, short).forEach { finished ->
            show(finished)
            compose.onNodeWithText(FinishCoach.action).assertDoesNotExist()
            compose.onNodeWithText(FinishCoach.caption).assertDoesNotExist()
            compose.onNodeWithText("Sign in").assertDoesNotExist()
        }
    }

    // The receipt decides nothing and shares nothing but the one line: no Keep it / Discard pair
    // on the slight branch, no dismissal of its own, and no link card — that one keeps its doors on
    // the session page and the log row, because two share verbs on one receipt are two meanings.
    @Test
    fun theReceiptDrawsNeitherTheDecidedPairNorTheLinkCard() {
        receipt()
        listOf(ordinary, short).forEach { finished ->
            show(finished)
            compose.onNodeWithText("Keep it").assertDoesNotExist()
            compose.onNodeWithText(Finish.discard).assertDoesNotExist()
            compose.onNodeWithText("Done").assertDoesNotExist()
            compose.onNodeWithText("Just keep the session").assertDoesNotExist()
            compose.onNodeWithText("Share this workout").assertDoesNotExist()
        }
    }

    @Test
    fun theTitleCongratulatesAnOrdinarySessionAndNotAShortOne() {
        receipt()
        compose.onNodeWithText("Well done.").assertIsDisplayed()

        show(short)
        compose.onNodeWithText("Ended early.").assertIsDisplayed()
        compose.onNodeWithText("Well done.").assertDoesNotExist()
    }
}

// The keep-as-routine card is the receipt's one form, so it says why Save is grey, what the log said
// when it refused, and that the routine was taken — one line at a time, and only ever one. The room
// cannot say any of it for the card: a sheet covers the bottom bar the room says everything else in.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class KeepAsRoutineTests {
    @get:Rule
    val compose = createComposeRule()

    private val ordinary = FinishedSession(
        session = Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 3_600_000),
        sets = listOf(
            TrainingSet(id = "set_1", exerciseId = "back-squat", weightKg = 100.0, reps = 5,
                        completedAtMs = 2_000),
        ),
        review = Review(stats = ReviewStats(durationMs = 3_600_000, workingSets = 5)),
        isFirst = false,
    )

    private fun card(failure: String? = null, kept: Boolean = false) {
        compose.setContent {
            FinishScreen(
                finished = ordinary,
                catalog = catalog,
                kept = kept,
                onKeepRoutine = {},
                onShareWithCoach = {},
                failure = failure,
            )
        }
    }

    // The primary is the receipt's one full-strength button and it stands directly under the
    // readout; the routine card, the one thing that writes, sits below it.
    @Test
    fun theRoutineCardSitsBelowShareWithCoach() {
        card()
        assertTrue(
            compose.onNodeWithText("Keep this as a routine").fetchSemanticsNode().positionInRoot.y >
                compose.onNodeWithText(FinishCoach.action).fetchSemanticsNode().positionInRoot.y,
        )
    }

    // The form goes when the log takes the routine, and a sentence stands where it was: the receipt
    // draws no control after a keep, and the room's own line is behind this sheet.
    @Test
    fun aKeptRoutineIsSaidWhereTheFormStood() {
        card(kept = true)
        compose.onNodeWithText("Save routine").assertDoesNotExist()
        compose.onNodeWithText("Routine name").assertDoesNotExist()
        compose.onNodeWithText(Finish.keptAs(Readout.weekday(ordinary.session.startedAtMs)))
            .performScrollTo()
            .assertIsDisplayed()
    }

    @Test
    fun anEmptyNameSaysWhySaveIsGreyAndAFilledOneSaysNothing() {
        card()
        compose.onNodeWithText(Program.nameItToSaveIt).assertDoesNotExist()

        compose.onNodeWithText("Routine name").performScrollTo().performTextReplacement("   ")
        compose.onNodeWithText(Program.nameItToSaveIt).assertIsDisplayed()

        compose.onNodeWithText("Routine name").performTextReplacement("Push A")
        compose.onNodeWithText(Program.nameItToSaveIt).assertDoesNotExist()
    }

    // `4c`: a routine minted on the receipt is bounded by the ROOM's cap, counted the way the editor
    // counts it — code points, not UTF-16 units — so which surface a lifter is holding stops deciding
    // how long a name may be. The counter does NOT come with it: this field mints a name in passing.
    @Test
    fun theNameFieldTakesTheRoomsCapCountedInCodePoints() {
        card()
        val field = compose.onNodeWithText("Routine name").performScrollTo()

        field.performTextReplacement("\uD83D\uDE00".repeat(61))
        assertEquals("sixty code points, not eighty UTF-16 units",
                     "\uD83D\uDE00".repeat(Program.maxNameLength), typedName())
        assertEquals(Program.maxNameLength, Program.length(typedName()))
        // Asserted while the field still HOLDS the capped name: that is the only state a counter
        // would be drawn in, so a shorter name here would pass whether or not one is drawn.
        compose.onNodeWithText(Program.counter(typedName())!!).assertDoesNotExist()

        field.performTextReplacement("Push A")
        assertEquals("and a short name is left alone", "Push A", typedName())
    }

    private fun typedName(): String =
        compose.onNodeWithText("Routine name").fetchSemanticsNode()
            .config[SemanticsProperties.EditableText].text

    // One grey button, one sentence. A blank name is what holds Save NOW, so it outranks what the
    // log said about an earlier attempt — nothing clears `failure` while Save cannot be pressed.
    @Test
    fun anEmptyNameOutranksALogRefusalSoOnlyOneSentenceStands() {
        card(failure = "that document is unclaimable")
        compose.onNodeWithText("that document is unclaimable").assertIsDisplayed()

        compose.onNodeWithText("Routine name").performScrollTo().performTextReplacement("   ")
        compose.onNodeWithText(Program.nameItToSaveIt).assertIsDisplayed()
        compose.onNodeWithText("that document is unclaimable").assertDoesNotExist()
    }

    @Test
    fun theLogsRefusalIsDrawnUnderTheSaveThatRaisedIt() {
        card(failure = "that document is unclaimable")
        val refusal = compose.onNodeWithText("that document is unclaimable")
        refusal.assertIsDisplayed()
        assertTrue(
            "it sits under Save routine, which is the control that asked",
            refusal.fetchSemanticsNode().positionInRoot.y >
                compose.onNodeWithText("Save routine").fetchSemanticsNode().positionInRoot.y,
        )
    }
}
