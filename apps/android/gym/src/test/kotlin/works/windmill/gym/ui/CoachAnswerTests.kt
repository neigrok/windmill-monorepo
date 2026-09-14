package works.windmill.gym.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
    fun summariesStayInTheDisclosureWhileTheFullSessionCardIsExplicitlyScoped() {
        val summary = SessionObservation("old", 1000, "list_sessions", "summary", 0, routine = "Old workout", workout = WorkoutObservation(9, 2700.0, 2880000))
        val full = SessionObservation("asked", 2000, "get_session", "session", 3, routine = "My actual workout", workout = WorkoutObservation(2, 960.0, 90000))
        val movement = SessionObservation("movement", 3000, "last_time", "movement", 1, routine = "Movement only", exerciseId = "bench", workout = WorkoutObservation(99, 9999.0))
        compose.setContent { GymMaterial { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            CoachAnswer("Keep these exact words.\n\nNo invented summary.", AnswerReceipt(1, ReadTally(4, 3, 1), observations = listOf(summary, full, movement)), emptyList(), 4000)
        } } }
        compose.onNodeWithText("Keep these exact words.\n\nNo invented summary.").assertIsDisplayed()
        compose.onNodeWithText("From your log").assertIsDisplayed()
        compose.onAllNodes(androidx.compose.ui.test.hasText("Working sets")).assertCountEquals(1)
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
