package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.DeviationOffer
import works.windmill.gym.domain.SetTarget

// The deviation sheet keeps its title and sentence on every scheme; what changes with the scheme is
// the offer — one load on a straight scheme, the sets as lifted on a ladder, drawn set by set.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class DeviationSheetTests {
    @get:Rule
    val compose = createComposeRule()

    private val ramp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))

    private fun rows(): List<List<String>> = compose
        .onAllNodes(hasText("→"))
        .fetchSemanticsNodes()
        .sortedBy { it.boundsInRoot.top }
        .map { row -> row.config[SemanticsProperties.Text].map { it.text } }

    @Test
    fun aLadderIsOfferedAsTheSetsLiftedSetBySet() {
        val lifted = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 102.5),
                            SetTarget(5, 80.0), SetTarget(5, 80.0))
        val deviation = DeviationOffer(exerciseId = "back-squat", routineId = "rt_lower_a", routine = "Lower A",
                                       position = 1, plannedKg = 100.0, liftedKg = 102.5,
                                       scheme = ramp, lifted = lifted)
        val taps = mutableListOf<String>()
        compose.setContent {
            DeviationSheet(deviation, movement = "Back Squat", onSave = { taps += "save" }, onToday = { taps += "today" })
        }

        compose.onNodeWithText("Heavier than the plan").assertIsDisplayed()
        compose.onNodeWithText("Today’s Back Squat ran at 102.5 against a planned 100. " +
                               "Today’s session already has it. Lower A does not.").assertIsDisplayed()
        assertEquals(
            listOf(
                listOf("set 1", "60 × 5", "→", "60 × 5"),
                listOf("set 2", "80 × 5", "→", "80 × 5"),
                listOf("set 3", "90 × 3", "→", "90 × 3"),
                listOf("set 4", "100 × 1", "→", "102.5 × 1"),
                listOf("set 5", "80 × 5", "→", "80 × 5"),
                listOf("set 6", "—", "→", "80 × 5"),
            ),
            rows(),
        )
        compose.onNodeWithText("Save today’s sets").assertIsDisplayed().assertHasClickAction().performClick()
        compose.onNodeWithText("Today only").performClick()
        compose.runOnIdle { assertEquals(listOf("save", "today"), taps) }
    }

    @Test
    fun aStraightSchemeIsOfferedAsOneLoadAndDrawsNoLadder() {
        val deviation = DeviationOffer(exerciseId = "bench-press", routineId = "rt_push_a", routine = "Push A",
                                       position = 1, plannedKg = 80.0, liftedKg = 82.5,
                                       scheme = List(5) { SetTarget(5, 80.0) },
                                       lifted = List(5) { SetTarget(5, 82.5) })
        compose.setContent {
            DeviationSheet(deviation, movement = "Bench Press", onSave = {}, onToday = {})
        }

        compose.onNodeWithText("Heavier than the plan").assertIsDisplayed()
        compose.onNodeWithText("Save 82.5 to Push A").assertIsDisplayed().assertHasClickAction()
        compose.onAllNodes(hasText("→")).assertCountEquals(0)
        compose.onAllNodes(hasText("Save today’s sets")).assertCountEquals(0)
    }
}
