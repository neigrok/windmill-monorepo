package works.windmill.gym.ui

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
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
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import works.windmill.gym.domain.*
import works.windmill.gym.store.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class PlanningLargeTextTests {
    private lateinit var contentView: View

    @get:Rule(order = 0) val fontScale = org.junit.rules.TestRule { base, _ ->
        object : org.junit.runners.model.Statement() {
            override fun evaluate() {
                RuntimeEnvironment.setFontScale(2f)
                base.evaluate()
            }
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    @get:Rule(order = 2) val tmp = TemporaryFolder()

    // Signed out: the anonymous replica's store.
    private fun store(room: EngineRoomFixture): TrainingStore {
        runBlocking { room.select(null) }
        return room.store
    }

    @Test
    fun largeTextKeepsTheOpenRawTargetAndPinnedDoneReachable() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            var draft by mutableStateOf(RoutineDraft(name = "Pull").adding("chin-up"))
            compose.setContent {
                contentView = LocalView.current
                RoutineBuilder(draft, store, false, { draft = it }, {}, {}, {})
            }
            compose.onNodeWithText("Chin Up").performClick()
            val sets = compose.onNodeWithContentDescription("Sets, sets").fetchSemanticsNode().positionInRoot
            val reps = compose.onNodeWithContentDescription("Reps, reps").fetchSemanticsNode().positionInRoot
            val weight = compose.onNodeWithContentDescription("Load, kg added").fetchSemanticsNode().positionInRoot
            assertTrue(reps.y > sets.y)
            assertTrue(weight.y > reps.y)
            compose.onNodeWithContentDescription("Load, kg added").performScrollTo()
            val field = compose.onNodeWithContentDescription("Load, kg added").fetchSemanticsNode()
            assertEquals("", field.config[SemanticsProperties.EditableText].text)
            assertTrue("the complete native field remains reachable", field.boundsInRoot.width >= 100)
            compose.onNodeWithContentDescription("Load, kg added").performScrollTo().assertIsNotEnabled()
            compose.onNodeWithText("Done").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun largeTextKeepsTheThreeEquipmentChoicesAndCreateActionReachable() {
        compose.setContent {
            contentView = LocalView.current
            MovementPicker(catalog = TheSix.movements, taken = emptyList(), lastSets = null,
                nowMs = 0, title = "Add movement", onPick = {},
                onCreate = { _ -> error("no creation") })
        }
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        val hidden = WindowInsets.Builder()
            .setInsets(WindowInsets.Type.ime(), Insets.NONE)
            .setVisible(WindowInsets.Type.ime(), false).build()
        compose.runOnIdle {
            contentView.dispatchApplyWindowInsets(hidden)
            ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(Stage.RESUMED)
                .forEach { it.window.decorView.dispatchApplyWindowInsets(hidden) }
            ShadowDialog.getShownDialogs().filter { it.isShowing }
                .forEach { it.window!!.decorView.dispatchApplyWindowInsets(hidden) }
        }
        compose.mainClock.advanceTimeBy(64)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Equipment").performScrollTo().performClick()
        for (label in listOf("Barbell", "Dumbbells", "Other")) {
            compose.onNode(hasText(label) and hasAnyAncestor(isPopup())).assertIsDisplayed()
        }
        compose.onNode(hasText("Other") and hasAnyAncestor(isPopup())).performClick()
        compose.onNodeWithText("Other").assertIsDisplayed()
        compose.onNodeWithText("Create and add").assertIsDisplayed()
    }
}
