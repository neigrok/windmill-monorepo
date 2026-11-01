package works.windmill.gym.coach

import works.windmill.gym.ui.*
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class CoachAnswerTests {
    @get:Rule val compose = createComposeRule()

    @Test
    fun ordinaryMarkdownUsesSixteenDpGuttersAndTheReadTallyKeepsItsThirtyTwoDpStart() {
        compose.setContent { GymMaterial { Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            CoachAnswer("## Thursday\n\nA complete paragraph.", AnswerReceipt(1, ReadTally(1, 1, 1)),
                emptyList(), 0, receiptInset = 4.dp)
        } } }
        val bubble = compose.onNodeWithText("Thursday").getUnclippedBoundsInRoot()
        assertEquals(16.dp, bubble.left)
        assertEquals(396.dp, bubble.right)
        assertEquals(32.dp, compose.onNodeWithText("Read 1 workout · 1 week", useUnmergedTree = true)
            .getUnclippedBoundsInRoot().left)
        val target = compose.onNodeWithTag("coach-read-sources").assertHasClickAction().getUnclippedBoundsInRoot()
        assertEquals("What Coach read is a 48 dp target", 48.dp, target.bottom - target.top)
    }

    @Test
    fun aMixedWriteReceiptRetainsItsTwentyDpLaneAndExistingTypography() {
        val read = ReadTally(2, 1, 1)
        val receipt = AnswerReceipt(1, read, steps = listOf(AskStep("get_session"), AskStep("save_note")),
            observations = listOf(SessionObservation("asked", 2000, "get_session", "session", 2,
                routine = "My actual workout", workout = WorkoutObservation(2, 960.0, 90000))))
        compose.setContent { GymMaterial { Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            CoachAnswer("Ordinary prose.", receipt, emptyList(), 4000, receiptInset = 4.dp)
        } } }
        assertEquals(20.dp, compose.onNodeWithText("From your log").getUnclippedBoundsInRoot().left)
        assertEquals(36.dp, compose.onNodeWithText("Sets").getUnclippedBoundsInRoot().left)
        assertEquals(376.dp, compose.onNodeWithText("960 kg").getUnclippedBoundsInRoot().right)
        val layout = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Sets").fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layout)
        assertEquals(16.sp, layout.single().layoutInput.style.fontSize)
        compose.onNodeWithText(Ask.receipt(read).replaceFirstChar { it.uppercase() }).performClick()
        compose.onNodeWithText("Saved a note").assertIsDisplayed()
        compose.onNodeWithText("What Coach read").assertDoesNotExist()
    }

    @Test
    fun aSecondParagraphCopyMenuAndExpandedReceiptSurviveReplacementByOneParagraph() {
        lateinit var clipboard: ClipboardManager
        val initial = "First paragraph.\n\nCafé\n東京"
        val final = "Café\n東京 — 🏋🏽‍♀️ é\nFinal words."
        val text = androidx.compose.runtime.mutableStateOf(initial)
        val receipt = AnswerReceipt(1, ReadTally(), steps = listOf(AskStep("list_notes"), AskStep("save_note")))
        compose.setContent { GymMaterial {
            clipboard = LocalClipboardManager.current
            CoachAnswer(text.value, receipt, emptyList(), 0)
        } }
        compose.onNodeWithText("Read nothing from your log").performClick()
        compose.onNodeWithText("Read your notes").assertIsDisplayed()
        compose.onNodeWithText("Café\n東京").performTouchInput { longClick() }
        compose.runOnIdle { text.value = final }
        compose.onNodeWithText("Copy answer").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(final, clipboard.getText()?.text) }
        compose.onNodeWithText("Read your notes").assertIsDisplayed()
        compose.onNodeWithText("Saved a note").assertIsDisplayed()
        compose.onNodeWithText("What Coach read").assertDoesNotExist()
    }

    @Test
    fun bothSpeakersCopyExactMultilineTextThroughLongPressAndAccessibleActions() {
        lateinit var clipboard: ClipboardManager
        val question = "My question.\nSecond line with 2 × 5."
        val answer = "First paragraph.\n\nSecond paragraph — exact text."
        compose.setContent { GymMaterial {
            clipboard = LocalClipboardManager.current
            Column { CoachQuestion(question); CoachAnswer(answer, null, emptyList(), 0) }
        } }
        compose.onNodeWithText(question).performTouchInput { longClick() }
        compose.onNodeWithText("Copy question").performClick()
        compose.runOnIdle { assertEquals(question, clipboard.getText()?.text) }
        val message = compose.onNodeWithText("First paragraph.")
        compose.onNodeWithText("Second paragraph — exact text.").assertIsDisplayed()
        val actions = message.fetchSemanticsNode().config[SemanticsActions.CustomActions]
        compose.runOnIdle {
            assertEquals(listOf("Copy answer"), actions.map { it.label })
            actions.single().action()
        }
        compose.runOnIdle { assertEquals(answer, clipboard.getText()?.text) }
        compose.onNodeWithText("First paragraph.").performTouchInput { longClick() }
        compose.onNodeWithText("Copy answer").performClick()
        compose.runOnIdle { assertEquals(answer, clipboard.getText()?.text) }
    }

    @Test
    fun markdownRendersAsStyledBlocksAndCopiesAsPlainText() {
        lateinit var clipboard: ClipboardManager
        val answer = "## Your week\n\n**Bold** start\n\n- Squat\n- Bench\n- Row\n\n1. Warm up\n2. Work"
        compose.setContent { GymMaterial {
            clipboard = LocalClipboardManager.current
            CoachAnswer(answer, null, emptyList(), 0)
        } }
        val bold = compose.onNodeWithText("Bold start").fetchSemanticsNode().config[SemanticsProperties.Text].single { it.text == "Bold start" }
        assertEquals(listOf(AnnotatedString.Range(SpanStyle(fontWeight = FontWeight.Bold), 0, 4)), bold.spanStyles)
        compose.onAllNodes(hasText("•"), useUnmergedTree = true).assertCountEquals(3)
        compose.onNodeWithText("1.", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("2.", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Warm up", useUnmergedTree = true).assertIsDisplayed()
        val laid = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Your week", useUnmergedTree = true).fetchSemanticsNode()
            .config[SemanticsActions.GetTextLayoutResult].action?.invoke(laid)
        assertEquals(17.sp, laid.single().layoutInput.style.fontSize)
        assertEquals(FontWeight.Bold, laid.single().layoutInput.style.fontWeight)
        compose.onNodeWithText("Bold start").performTouchInput { longClick() }
        compose.onNodeWithText("Copy answer").performClick()
        compose.runOnIdle {
            assertEquals("Your week\n\nBold start\n\n- Squat\n- Bench\n- Row\n\n1. Warm up\n2. Work", clipboard.getText()?.text)
        }
    }

    @Test
    fun readOnlyFactsMoveIntoTheSourcesSheetWithoutInventingWorkoutTotals() {
        val summary = SessionObservation("old", 1000, "list_sessions", "summary", 0, routine = "Old workout", workout = WorkoutObservation(9, 2700.0, 2880000))
        val full = SessionObservation("asked", 2000, "get_session", "session", 3, routine = "My actual workout", workout = WorkoutObservation(2, 960.0, 90000))
        val movement = SessionObservation("movement", 3000, "last_time", "movement", 1, routine = "Movement only", exerciseId = "bench", workout = WorkoutObservation(99, 9999.0))
        compose.setContent { GymMaterial { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            CoachAnswer("Keep these exact words.\n\nNo invented summary.", AnswerReceipt(1, ReadTally(4, 3, 1), observations = listOf(summary, full, movement)), emptyList(), 4000)
        } } }
        compose.onNodeWithText("Keep these exact words.").assertIsDisplayed()
        compose.onNodeWithText("No invented summary.").assertIsDisplayed()
        compose.onNodeWithText("From your log").assertDoesNotExist()
        compose.onNodeWithText("Sets").assertDoesNotExist()
        compose.onNodeWithText("Read 3 workouts · 1 week").performScrollTo().performClick()
        compose.onNodeWithText("What Coach read").assertIsDisplayed()
        compose.onNodeWithText("2 sets · 960 kg", substring = true).assertIsDisplayed()
        compose.onNodeWithText("9999 kg", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Old workout", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Movement only", substring = true).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun multipleFullReadsHaveOneCompactReceiptAndNoStackOfMetricCards() {
        val reads = (1..5).map { SessionObservation("s$it", it * 1000L, "get_session", "session", it,
            routine = "Workout $it", workout = WorkoutObservation(it, it * 120.0)) }
        compose.setContent { GymMaterial { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            CoachAnswer("The model's focal answer stays first.", AnswerReceipt(1, ReadTally(15, 5, 1), observations = reads), emptyList(), 6000)
        } } }
        compose.onNodeWithText("The model's focal answer stays first.").assertIsDisplayed()
        compose.onNodeWithText("Sets").assertDoesNotExist()
        compose.onNodeWithText("Read 5 workouts · 1 week").assertIsDisplayed().performClick()
        compose.onNodeWithText("Workout 5", substring = true).performScrollTo().assertIsDisplayed()
    }

    @Test fun unavailableVolumeKeepsTheExistingSourcesSlotWithoutClaimingZero() {
        val fact = SessionObservation("unavailable", 2000, "get_session", "session", 3,
            routine = "Unavailable fixture", workout = WorkoutObservation(3, null, 90000))
        compose.setContent { GymMaterial {
            CoachAnswer("A factual answer.", AnswerReceipt(1, ReadTally(3, 1, 1), observations = listOf(fact)), emptyList(), 4000)
        } }
        compose.onNodeWithText("Read 1 workout · 1 week").performClick()
        compose.onNodeWithText("3 sets · —", substring = true).assertIsDisplayed()
        compose.onNodeWithText("0 kg", substring = true).assertDoesNotExist()
    }

    @Test
    fun aPastAnswerWithoutEvidenceNeverTreatsProseAsFacts() {
        compose.setContent { GymMaterial { CoachAnswer("Nine sets, 2700kg, 48 minutes.", null, emptyList(), 5000) } }
        compose.onNodeWithText("Nine sets, 2700kg, 48 minutes.").assertIsDisplayed()
        compose.onNodeWithText("Sets").assertDoesNotExist()
        compose.onNodeWithText("From your log").assertDoesNotExist()
        compose.onNodeWithText("Read nothing from your log").assertDoesNotExist()
    }
    @Test fun routineDraftShowsEquipmentAndTargetsBeforeAnExplicitSave() {
        val draft = CoachRoutineDraft("operation-a", "routine-a", "Push", 1,
            listOf(RoutineEntry(1, "dumbbell-bench-press", listOf(SetTarget(8, 16.0)))), "pending")
        val requests = mutableListOf<CoachRoutineDraft>()
        compose.setContent { GymMaterial {
            CoachAnswer("Review this plan", null, listOf(Exercise("dumbbell-bench-press", "Flat press", equipment = "dumbbell")), 0,
                routineDrafts = listOf(draft), onConfirmRoutine = {
                    requests += it
                    if (requests.size == 1) DraftOutcome.Failed(Ask.draftRetry) else DraftOutcome.Closed(Ask.draftGone)
                })
        } }
        compose.onNodeWithText("Review routine").assertIsDisplayed()
        compose.onNodeWithText("Push").assertIsDisplayed()
        compose.onNodeWithText("Flat press").assertIsDisplayed()
        compose.onNodeWithText("1 × 8 · 16 kg each · Two dumbbells").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<CoachRoutineDraft>(), requests) }
        compose.onNodeWithText("Save routine").performClick()
        compose.onNodeWithText("Couldn’t save the routine. Try again.").assertIsDisplayed()
        compose.onNodeWithText("Save routine").performClick()
        compose.onNodeWithText("This draft is no longer available.").assertIsDisplayed()
        compose.onNodeWithText("Save routine").assertDoesNotExist()
        compose.onNodeWithText("Couldn’t save the routine. Try again.").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf(draft, draft), requests) }
    }
    @Test fun routineDraftNamesEachLoadBasisByEquipmentAndCount() {
        val draft = CoachRoutineDraft("operation-b", "routine-b", "Mixed", 1, listOf(
            RoutineEntry(0, "goblet-squat", listOf(SetTarget(8, 24.0))),
            RoutineEntry(1, "back-squat", listOf(SetTarget(5, 100.0))),
            RoutineEntry(2, "pull-up", listOf(SetTarget(6, -10.0))),
            RoutineEntry(3, "cable-row", listOf(SetTarget(10, 40.0)))), "pending")
        compose.setContent { GymMaterial {
            CoachAnswer("Review this plan", null, listOf(
                Exercise("goblet-squat", "Goblet Squat", equipment = "dumbbell", loadCount = 1),
                Exercise("back-squat", "Back Squat", equipment = "barbell"),
                Exercise("pull-up", "Pull Up", equipment = "bodyweight"),
                Exercise("cable-row", "Cable Row", equipment = "cable")), 0,
                routineDrafts = listOf(draft), onConfirmRoutine = { DraftOutcome.Closed(Ask.draftGone) })
        } }
        compose.onNodeWithText("1 × 8 · 24 kg · One dumbbell").assertIsDisplayed()
        compose.onNodeWithText("1 × 5 · 100 kg total · Barbell").assertIsDisplayed()
        compose.onNodeWithText(Readout.target(listOf(SetTarget(6, -10.0))) + " kg assisted · Bodyweight").assertIsDisplayed()
        compose.onNodeWithText("1 × 10 · 40 kg · Cable").assertIsDisplayed()
    }

    @Test fun aTurnThatCreatedItsRoutineAtOnceKeepsThePastTenseStep() {
        compose.setContent { GymMaterial {
            Column {
                CoachAnswer("Made it", null, emptyList(), 0, legacyRead = ReadTally(sets = 1), legacySteps = listOf(AskStep("create_routine")),
                    results = listOf(CoachResult("routine-created", "operation-a", "routine-a", "Push")))
                CoachAnswer("Drafted it", null, emptyList(), 0, legacyRead = ReadTally(sets = 2), legacySteps = listOf(AskStep("update_exercise"), AskStep("create_routine")),
                    routineDrafts = listOf(CoachRoutineDraft("operation-b", "routine-b", "Pull", 1, emptyList(), "saved")),
                    results = listOf(CoachResult("routine-created", "operation-b", "routine-b", "Pull")))
            }
        } }
        compose.onNodeWithText("Read 1 set").performClick()
        compose.onNodeWithText("Created a routine").assertIsDisplayed()
        compose.onNodeWithText("Read 2 sets").performClick()
        compose.onNodeWithText("Updated a movement").assertIsDisplayed()
        compose.onNodeWithText("Drafted a routine for your review").assertIsDisplayed()
    }

}
