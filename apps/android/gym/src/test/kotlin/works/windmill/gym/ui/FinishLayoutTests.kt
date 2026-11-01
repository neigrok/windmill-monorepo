package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.platform.testTag
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

    @Test fun finiteMaximumRetainsItsExponentWhileOverflowUsesTheUnavailableSlotAndZeroStaysReal() {
        val load = mutableStateOf(Double.MAX_VALUE)
        val reps = mutableStateOf(1)
        compose.setContent {
            val finished = FinishedSession(Session("extreme", startedAtMs = 1_000, finishedAtMs = 61_000),
                listOf(TrainingSet("set", "bench-press", weightKg = load.value, reps = reps.value, completedAtMs = 2_000)), null)
            GymMaterial { FinishScreen(finished, listOf(Exercise("bench-press", "Bench Press", "press", "barbell"))) }
        }
        val text = "1.7976931348623157e+308 kg"
        val node = compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()
        val layouts = mutableListOf<TextLayoutResult>()
        node.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
        assertFalse(layouts.single().hasVisualOverflow)
        assertEquals(text.length, layouts.single().getLineEnd(layouts.single().lineCount - 1, visibleEnd = true))
        compose.runOnIdle { reps.value = 2 }
        compose.onNodeWithText("—").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("0 kg").assertDoesNotExist()
        compose.runOnIdle { load.value = 0.0 }
        compose.onNodeWithText("0 kg").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("—").assertDoesNotExist()
    }

    @Test
    fun theThreeFactsShareOneContinuousRow() {
        val finished = FinishedSession(Session("done", startedAtMs = 1_000, finishedAtMs = 601_000),
            List(4) { TrainingSet("set_$it", "bench-press", weightKg = 10.0, reps = 5, completedAtMs = 2_000L + it) }, null)
        compose.setContent { GymMaterial { FinishScreen(finished, emptyList()) } }
        val duration = compose.onNodeWithText("Duration").fetchSemanticsNode().boundsInRoot
        val count = compose.onNodeWithText("Sets").fetchSemanticsNode().boundsInRoot
        val volume = compose.onNodeWithText("Volume").fetchSemanticsNode().boundsInRoot
        assertEquals(duration.right, count.left, 0.5f)
        assertEquals(count.right, volume.left, 0.5f)
        assertEquals(duration.width, count.width, 1f)
        assertEquals(count.width, volume.width, 1f)
        assertEquals(duration.top, count.top, 0.5f)
        assertEquals(count.top, volume.top, 0.5f)
    }

    @Test
    fun largeTextKeepsTotalsAndLongPerformedTargetsReadableOnAShortFrame() {
        val name = "Long movement name with several words"
        val sets = List(9) { index -> TrainingSet("set_$index", "move_${index / 3}",
            weightKg = listOf(60.0, 30.0, 18.0)[index / 3], reps = if (index < 6) 8 else 10, completedAtMs = 2_000L + index) }
        val catalog = List(3) { Exercise("move_$it", if (it == 0) name else "Movement $it") }
        val review = Review(against = Against("past", "Push A", 0,
            listOf(AgainstMovement("move_0", Effort(3, 8, 60.0), before = Effort(3, 8, 57.5),
                planned = PlannedLine(List(3) { SetTarget(8, 60.0) })))))
        val finished = FinishedSession(Session("done", startedAtMs = 1_000, finishedAtMs = 601_000), sets, review)
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(2f, 2f)) {
                GymMaterial {
                    Box(Modifier.height(340.dp)) {
                        FinishScreen(finished, catalog, onShareWithCoach = {})
                    }
                }
            }
        }
        for (text in listOf("2,700 kg", "Duration", "Sets", "Volume")) {
            val node = compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()
            val layouts = mutableListOf<TextLayoutResult>()
            node.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
            assertEquals(1, layouts.single().lineCount)
            assertFalse("$text: size=${layouts.single().size}, paragraph=${layouts.single().multiParagraph.width}x${layouts.single().multiParagraph.height}, font=${layouts.single().layoutInput.style.fontSize}", layouts.single().hasVisualOverflow)
        }
        compose.onNodeWithText("Against plan").assertDoesNotExist()
        compose.onNodeWithText("Done").assertIsDisplayed()
        compose.onNodeWithText(FinishCoach.action).assertIsDisplayed()
        val target = compose.onAllNodesWithText("3 × 8 · 60 kg total").onLast().performScrollTo().assertIsDisplayed()
        val movement = compose.onAllNodesWithText(name).onFirst().fetchSemanticsNode().boundsInRoot
        assertTrue(target.fetchSemanticsNode().boundsInRoot.top >= movement.bottom)
        compose.onNodeWithText("Save routine").assertDoesNotExist()
        compose.onNodeWithText(FinishCoach.action).assertIsDisplayed()
    }

    @Test
    fun atLargeTextTheReceiptOpensFullHeightWrapsTheFactsTwoToARowAndScrollsToPerformed() {
        val sets = List(5) { TrainingSet("set_$it", "bench-press", weightKg = 80.0, reps = 6, completedAtMs = 2_000L + it) }
        val finished = FinishedSession(Session("done", startedAtMs = 1_000, finishedAtMs = 3_121_000, plan = PlanSnapshot("Push A")),
            sets, null, suggestsKeep = true)
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                GymMaterial {
                    Box(Modifier.height(592.dp).testTag("Sheet")) {
                        FinishScreen(finished, listOf(Exercise("bench-press", "Bench Press", "press", "barbell")),
                            onShareWithCoach = {}, onKeep = {})
                    }
                }
            }
        }
        val sheet = compose.onNodeWithTag("Sheet").fetchSemanticsNode().boundsInRoot
        val receipt = compose.onNodeWithTag("Finish receipt").fetchSemanticsNode().boundsInRoot
        assertEquals(sheet.height, receipt.height, 0.5f)

        val duration = compose.onNodeWithText("Duration").fetchSemanticsNode().boundsInRoot
        val count = compose.onNodeWithText("Sets").fetchSemanticsNode().boundsInRoot
        val volume = compose.onNodeWithText("Volume").fetchSemanticsNode().boundsInRoot
        assertEquals(duration.top, count.top, 0.5f)
        assertTrue(count.left >= duration.right - 0.5f)
        assertTrue(volume.top > duration.bottom)
        assertEquals(duration.left, volume.left, 0.5f)
        val total = compose.onNodeWithText("2,400 kg").fetchSemanticsNode()
        val layouts = mutableListOf<TextLayoutResult>()
        total.config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
        assertEquals(1, layouts.single().lineCount)
        assertFalse(layouts.single().hasVisualOverflow)

        val band = compose.onNodeWithText(FinishCoach.action).fetchSemanticsNode().boundsInRoot.top
        for (text in listOf("Performed", "Bench Press", "5 × 6 · 80 kg total")) {
            val node = compose.onNodeWithText(text).performScrollTo().assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            assertTrue("$text ends at ${node.bottom}, under the band at $band", node.bottom <= band + 0.5f)
        }
    }

    @Test
    @Config(qualifiers = "w412dp-h915dp-xhdpi")
    fun signedOutAtNormalTextEveryFactAndPerformedStandAboveThePinnedActions() {
        val catalog = listOf(Exercise("bench-press", "Bench Press", "press", "barbell"),
            Exercise("overhead-press", "Overhead Press", "press", "barbell"),
            Exercise("incline-press", "Incline Dumbbell Press", "press", "dumbbell", loadCount = 2))
        val full = List(3) { TrainingSet("bench_$it", "bench-press", weightKg = 75.0 + it * 2.5, reps = 6 + it, completedAtMs = 2_000L + it) } +
            TrainingSet("ohp", "overhead-press", weightKg = 47.5, reps = 6, completedAtMs = 3_000) +
            TrainingSet("incline", "incline-press", weightKg = 24.0, reps = 10, completedAtMs = 4_000)
        val slight = full.drop(2)
        val workout = mutableStateOf(full)
        compose.setContent {
            GymMaterial {
                Box(Modifier.height(839.dp)) {
                    FinishScreen(FinishedSession(Session("first", startedAtMs = 1_000, finishedAtMs = 3_121_000, plan = PlanSnapshot("Push A")),
                        workout.value, null, suggestsKeep = true), catalog, onShareWithCoach = {}, onKeep = {})
                }
            }
        }
        for (sets in listOf(full, slight)) {
            compose.runOnIdle { workout.value = sets }
            compose.onNodeWithText(if (sets == full) "Well done." else "Ended early.").assertIsDisplayed()
            val band = compose.onNodeWithText(FinishCoach.action).fetchSemanticsNode().boundsInRoot.top
            for (text in listOf("Duration", "Sets", "Volume", "Only on this phone · Keep it", "Performed", "Bench Press", "Overhead Press",
                                "Incline Dumbbell Press", "1 × 10 · 24 kg each")) {
                val node = compose.onNodeWithText(text).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
                assertTrue("$text ends at ${node.bottom}, under the band at $band", node.bottom <= band + 0.5f)
            }
        }
    }
}
