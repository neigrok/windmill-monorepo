package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.domain.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FinishLayoutTests {
    @get:Rule val compose = createComposeRule()

    @Test
    fun largeTextKeepsTotalsAndLongPerformedTargetsReadableAboveTheKeyboard() {
        val name = "Long movement name with several words"
        val sets = List(9) { index -> TrainingSet("set_$index", "move_${index / 3}",
            weightKg = listOf(60.0, 30.0, 18.0)[index / 3], reps = if (index < 6) 8 else 10, completedAtMs = 2_000L + index) }
        val catalog = List(3) { Exercise("move_$it", if (it == 0) name else "Movement $it") }
        val review = Review(ReviewStats(600_000, 9), against = Against("past", "Push A", 0,
            listOf(AgainstMovement("move_0", Effort(3, 8, 60.0), before = Effort(3, 8, 57.5),
                planned = PlannedLine(List(3) { SetTarget(8, 60.0) })))))
        val finished = FinishedSession(Session("done", startedAtMs = 1_000, finishedAtMs = 601_000), sets, review, false)
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(2f, 2f)) {
                GymMaterial {
                    Box(Modifier.height(340.dp)) {
                        FinishScreen(finished, catalog, keptName = null, onKeepRoutine = {}, onShareWithCoach = {})
                    }
                }
            }
        }
        for (text in listOf("2700", "Sets", "kg lifted", "Movements")) {
            val node = compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()
            val layouts = mutableListOf<TextLayoutResult>()
            node.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
            assertEquals(1, layouts.single().lineCount)
            assertFalse("$text: size=${layouts.single().size}, paragraph=${layouts.single().multiParagraph.width}x${layouts.single().multiParagraph.height}, font=${layouts.single().layoutInput.style.fontSize}", layouts.single().hasVisualOverflow)
        }
        compose.onNodeWithText("Against plan").performScrollTo().assertIsDisplayed()
        val plan = compose.onNodeWithText("3 × 8 · 60 → 3 × 8 · 60").performScrollTo().assertIsDisplayed()
        val layouts = mutableListOf<TextLayoutResult>()
        plan.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
        assertFalse(layouts.single().hasVisualOverflow)
        val target = compose.onAllNodesWithText("3 × 8 · 60kg").onLast().performScrollTo().assertIsDisplayed()
        val movement = compose.onAllNodesWithText(name).onLast().fetchSemanticsNode().boundsInRoot
        assertTrue(target.fetchSemanticsNode().boundsInRoot.top >= movement.bottom)
        compose.onNodeWithText("Save routine").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(FinishCoach.action).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun aConfirmationNamesTheStoredRoutineRatherThanTheDefaultDraftName() {
        val sets = List(4) { TrainingSet("set_$it", "bench", weightKg = 60.0, reps = 8, completedAtMs = it.toLong()) }
        compose.setContent {
            GymMaterial {
                FinishScreen(FinishedSession(Session("done", startedAtMs = 0, finishedAtMs = 600_000), sets, null, false),
                    listOf(Exercise("bench", "Bench Press")), keptName = "Push A", onKeepRoutine = {})
            }
        }
        compose.onNodeWithText("Kept as Push A.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Save routine").assertDoesNotExist()
    }
}
