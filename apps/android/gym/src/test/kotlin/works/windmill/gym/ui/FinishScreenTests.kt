package works.windmill.gym.ui

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
import works.windmill.gym.domain.CoachDoors
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
    fun aFinishedSessionIsTitledByItsRoutineAndAShortOneByItsEndingEarly() {
        val ordinary = Finish.head(startedAtMs = started, finishedAtMs = finished,
                                   routine = "Legs", slight = false, first = false)
        assertEquals("Session finished", ordinary.title)
        assertEquals("Legs", ordinary.subtitle)
        assertEquals("${Readout.day(started)} · ${Readout.time(started)} – ${Readout.time(finished)}",
                     ordinary.at)

        val short = Finish.head(startedAtMs = started, finishedAtMs = finished,
                                routine = "Pull A", slight = true, first = false)
        assertEquals("a short session is asked about, never congratulated", "Ended early", short.title)
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
        assertEquals("Ended early",
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
class DiscardConfirmationTests {
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

    private val doors = CoachDoors(
        origin = "https://windmill.works",
        mint = { error("never minted on a short session") },
        revoke = { error("never revoked on a short session") },
    )

    // A destructive act gets an UNDO, not a confirmation (13-gestures Law 2). The tap discards on the
    // spot — nothing is on the wire for nine seconds — and the dialog that used to stand between,
    // along with the sentence that said the discard could not be undone, is gone with it.
    @Test
    fun aDiscardTakesEffectOnTheTapAndNoDialogStandsBetween() {
        var discarded = 0
        var done = 0
        compose.setContent {
            FinishScreen(
                finished = short,
                catalog = catalog,
                kept = false,
                coach = doors,
                onKeepRoutine = {},
                onDiscard = { discarded += 1 },
                onDone = { done += 1 },
            )
        }

        compose.onNodeWithText("Discard session").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals("one tap, and the window it opens is the room's", 1, discarded)
            assertEquals(0, done)
        }
        compose.onNodeWithText("Discard this session?").assertDoesNotExist()
        compose.onNodeWithText("Discarding deletes the session and its sets. There is no undoing it.")
            .assertDoesNotExist()
    }

    // One act, one spelling. `Keep it` is read from `Finish` beside the `Discard session` it is the
    // other half of, and it is the only affirmative anywhere on the receipt — the ordinary way out is
    // the sheet coming down.
    @Test
    fun theSlightSessionsAffirmativeIsSaidOnceAndFromTheSameShelfAsItsRefusal() {
        compose.setContent {
            FinishScreen(
                finished = short,
                catalog = catalog,
                kept = false,
                coach = doors,
                onKeepRoutine = {},
                onDiscard = {},
                onDone = {},
            )
        }

        assertEquals("Keep it", Finish.keepIt)
        compose.onAllNodesWithText(Finish.keepIt).assertCountEquals(1)
        compose.onAllNodesWithText(Finish.discard).assertCountEquals(1)
        compose.onNodeWithText("Done").assertDoesNotExist()
        compose.onNodeWithText("Just keep the session").assertDoesNotExist()
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

    private val doors = CoachDoors(
        origin = "https://windmill.works",
        mint = { error("no link is minted here") },
        revoke = { error("no link is revoked here") },
    )

    private fun card(failure: String? = null, kept: Boolean = false) {
        compose.setContent {
            FinishScreen(
                finished = ordinary,
                catalog = catalog,
                kept = kept,
                coach = doors,
                onKeepRoutine = {},
                onDiscard = {},
                onDone = {},
                failure = failure,
            )
        }
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
