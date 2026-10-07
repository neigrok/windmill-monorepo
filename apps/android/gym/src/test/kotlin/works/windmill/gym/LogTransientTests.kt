package works.windmill.gym

import androidx.activity.ComponentDialog
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.store.*
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.design.LocalWindmillDark

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LogTransientTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    // The room flushes through the engine as it leaves, so the screen goes before the engine closes.
    private var showing by mutableStateOf(true)

    // The log draws only what the wall clock has reached, so the workouts happen in its past.
    private val past = 1_700_000_000_000L

    @Test fun instrumentKeepsWeighInAboveIndependentUndoWindows() = actionAboveUndo(true, 1f)
    @Test fun daylightAtDoubleTextKeepsWeighInAboveIndependentUndoWindows() = actionAboveUndo(false, 2f)

    private fun actionAboveUndo(dark: Boolean, fontScale: Float) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), scope).apply { now = past }
        try {
            val (one, two) = runBlocking {
                room.select("a")
                listOf(room.workout(), room.workout(100.0, "back-squat")).map { it.id }
            }
            val original = room.training.details()
            val store = room.store
            compose.setContent {
                if (showing) CompositionLocalProvider(LocalWindmillDark provides dark, LocalDensity provides Density(2f, fontScale)) {
                    GymMaterial { GymRoom(room.account(), store) }
                }
            }
            compose.onNode(hasText("Log") and hasClickAction()).performClick()
            val before = compose.onNodeWithText(Bodyweight.chip).getBoundsInRoot()
            compose.runOnIdle { store.withhold(Deletion.Session(one)); store.withhold(Deletion.Session(two)) }
            compose.onNodeWithText(Withheld.undo).assertIsDisplayed()
            val snackbar = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion), useUnmergedTree = true)
                .getBoundsInRoot()
            val action = compose.onNodeWithText(Bodyweight.chip).assertIsDisplayed().getBoundsInRoot()
            assertTrue("Weigh in must sit above Undo: $action / $snackbar", action.bottom <= snackbar.top)
            assertTrue(action.height >= 56.dp)
            compose.onNodeWithText(Bodyweight.chip).performClick()
            compose.onNodeWithText(Bodyweight.save).assertIsDisplayed()
            compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
            compose.onNodeWithText(Withheld.undo).performClick()
            compose.runOnIdle {
                assertEquals(listOf(one), store.withheld.map { it.subjectId })
                assertEquals(listOf(two), store.recent.map { it.id })
                assertEquals(original, room.training.details())
            }
            compose.onNodeWithText(Bodyweight.chip).assertIsDisplayed()
            compose.onNodeWithText(Withheld.undo).performClick()
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(emptyList<WithheldDelete>(), store.withheld)
                assertEquals(listOf(two, one), store.recent.map { it.id })
                assertEquals(original, room.training.details())
            }
            assertEquals(before, compose.onNodeWithText(Bodyweight.chip).getBoundsInRoot())
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
}
