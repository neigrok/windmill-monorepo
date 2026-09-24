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
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
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
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi

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

    private fun store(scope: CoroutineScope): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope, sync = { null },
        )
        runBlocking { store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), null)) }
        return store
    }

    @Test
    fun largeTextUsesAFullWidthSignedLoadForTheOpenPlaceholder() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        var draft by mutableStateOf(RoutineDraft(name = "Pull").adding("chin-up"))
        compose.setContent {
            contentView = LocalView.current
            RoutineBuilder(draft, store, false, { draft = it }, {}, {}, {})
        }
        compose.onNodeWithText("Chin Up").performClick()
        val sets = compose.onNodeWithContentDescription("Sets target").fetchSemanticsNode().positionInRoot
        val reps = compose.onNodeWithContentDescription("Reps target").fetchSemanticsNode().positionInRoot
        val weight = compose.onNodeWithContentDescription("Weight target").fetchSemanticsNode().positionInRoot
        assertTrue(reps.y > sets.y)
        assertTrue(weight.y > reps.y)
        compose.onNodeWithContentDescription("Weight target").performScrollTo()
        val layout = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("—", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layout) }
        assertTrue("the placeholder gets a full load field, beyond the old narrow column", layout.single().layoutInput.constraints.maxWidth >= 100)
        assertEquals(1, layout.single().lineCount)
        compose.onNodeWithContentDescription("Weight target").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Set · open").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun largeTextStacksEquipmentChoicesWithFullWidthLabels() {
        compose.setContent {
            contentView = LocalView.current
            MovementPicker(catalog = TheSix.movements, taken = emptyList(), lastSets = null,
                nowMs = 0, title = "Add movement", onPick = {},
                onCreate = { _, _, _ -> error("no creation") })
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
        for (label in listOf("Barbell", "Dumbbell", "Machine", "Bodyweight")) {
            val layout = mutableListOf<TextLayoutResult>()
            compose.onNode(hasText(label) and hasAnyAncestor(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)), useUnmergedTree = true)
                .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layout) }
            assertEquals(label, 1, layout.single().lineCount)
            assertTrue(label, layout.single().layoutInput.constraints.maxWidth >= 500)
        }
        compose.onNode(hasText("Bodyweight") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)).performScrollTo().performClick()
        compose.onNode(hasText("Bodyweight") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)).assertIsSelected()
        compose.onNodeWithText("Create and add").assertIsDisplayed()
    }
}
