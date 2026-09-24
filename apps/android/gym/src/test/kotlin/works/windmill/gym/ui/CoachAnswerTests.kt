package works.windmill.gym.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.ui.test.hasText
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
    fun anOpenCopyMenuAndExpandedReceiptSurviveReplacementText() {
        lateinit var clipboard: ClipboardManager
        val initial = "Café\n東京"
        val final = "Café\n東京 — 🏋🏽‍♀️ é\nFinal words."
        val text = androidx.compose.runtime.mutableStateOf(initial)
        val receipt = AnswerReceipt(1, ReadTally(), steps = listOf(AskStep("list_notes")))
        compose.setContent { GymMaterial {
            clipboard = LocalClipboardManager.current
            CoachAnswer(text.value, receipt, emptyList(), 0)
        } }
        compose.onNodeWithText("Read nothing from your log").performClick()
        compose.onNodeWithText("Read your notes").assertIsDisplayed()
        compose.onNodeWithText(initial).performTouchInput { longClick() }
        compose.runOnIdle { text.value = final }
        compose.onNodeWithText("Copy").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(final, clipboard.getText()?.text) }
        compose.onNodeWithText("Read your notes").assertIsDisplayed()
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
        compose.onNodeWithText("Copy").performClick()
        compose.runOnIdle { assertEquals(question, clipboard.getText()?.text) }
        val message = compose.onNodeWithText("First paragraph.")
        message.assert(hasText("Second paragraph — exact text."))
        val actions = message.fetchSemanticsNode().config[SemanticsActions.CustomActions]
        compose.runOnIdle {
            assertEquals(listOf("Copy"), actions.map { it.label })
            actions.single().action()
        }
        compose.runOnIdle { assertEquals(answer, clipboard.getText()?.text) }
        compose.onNodeWithText("First paragraph.").performTouchInput { longClick() }
        compose.onNodeWithText("Copy").performClick()
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
        assertEquals(20.sp, laid.single().layoutInput.style.fontSize)
        assertEquals(FontWeight.Bold, laid.single().layoutInput.style.fontWeight)
        compose.onNodeWithText("Bold start").performTouchInput { longClick() }
        compose.onNodeWithText("Copy").performClick()
        compose.runOnIdle {
            assertEquals("Your week\n\nBold start\n\n- Squat\n- Bench\n- Row\n\n1. Warm up\n2. Work", clipboard.getText()?.text)
        }
    }

    @Test
    fun summariesStayInTheDisclosureWhileTheFullSessionCardIsExplicitlyScoped() {
        val summary = SessionObservation("old", 1000, "list_sessions", "summary", 0, routine = "Old workout", workout = WorkoutObservation(9, 2700.0, 2880000))
        val full = SessionObservation("asked", 2000, "get_session", "session", 3, routine = "My actual workout", workout = WorkoutObservation(2, 960.0, 90000))
        val movement = SessionObservation("movement", 3000, "last_time", "movement", 1, routine = "Movement only", exerciseId = "bench", workout = WorkoutObservation(99, 9999.0))
        compose.setContent { GymMaterial { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            CoachAnswer("Keep these exact words.\n\nNo invented summary.", AnswerReceipt(1, ReadTally(4, 3, 1), observations = listOf(summary, full, movement)), emptyList(), 4000)
        } } }
        compose.onNodeWithText("Keep these exact words.").assertIsDisplayed().assert(hasText("No invented summary."))
        compose.onNodeWithText("From your log").assertIsDisplayed()
        compose.onAllNodes(hasText("Working sets")).assertCountEquals(1)
        compose.onNodeWithText("960 kg").assertIsDisplayed()
        compose.onNodeWithText("2700 kg").assertDoesNotExist()
        compose.onNodeWithText("9999 kg").assertDoesNotExist()
        compose.onNodeWithText("Read 4 sets · 1 week · 3 sessions").performScrollTo().performClick()
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
        compose.onNodeWithText("Working sets").assertDoesNotExist()
        compose.onNodeWithText("Read 15 sets · 1 week · 5 sessions").assertIsDisplayed().performClick()
        compose.onNodeWithText("Workout 5", substring = true).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun aPastAnswerWithoutEvidenceNeverTreatsProseAsFacts() {
        compose.setContent { GymMaterial { CoachAnswer("Nine working sets, 2700kg, 48 minutes.", null, emptyList(), 5000) } }
        compose.onNodeWithText("Nine working sets, 2700kg, 48 minutes.").assertIsDisplayed()
        compose.onNodeWithText("Working sets").assertDoesNotExist()
        compose.onNodeWithText("From your log").assertDoesNotExist()
        compose.onNodeWithText("Read nothing from your log").assertDoesNotExist()
    }
}
