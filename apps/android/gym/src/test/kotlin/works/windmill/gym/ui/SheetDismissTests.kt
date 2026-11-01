package works.windmill.gym.ui

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.LiveLines

// Native sheet dismissal preserves each form’s uncommitted state.
@OptIn(ExperimentalMaterial3Api::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SheetDismissTests {
    private lateinit var contentView: View

    @get:Rule
    val compose = createComposeRule()

    private fun raised(dismissed: MutableList<String>, content: @Composable () -> Unit) {
        compose.setContent {
            contentView = LocalView.current
            // The hosts all raise their sheets past the partial stop; the harness raises them the same way.
            ModalBottomSheet(
                onDismissRequest = { dismissed += "dismissed" },
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            ) { content() }
        }
        compose.waitForIdle()
    }

    // The handle is the one node in the raised sheet that carries the platform's Dismiss action.
    private fun handles(): List<SemanticsNode> =
        compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).fetchSemanticsNodes()

    private fun dismissFromTheHandle(dismissed: List<String>) {
        val handle = handles()
        assertEquals("exactly one node in the raised sheet exposes SemanticsActions.Dismiss", 1, handle.size)
        compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
            .assertCountEquals(1)
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
            .performSemanticsAction(SemanticsActions.Dismiss)
        compose.waitUntil(10_000) { dismissed.isNotEmpty() }
        assertEquals(listOf("dismissed"), dismissed)
    }

    private fun dismissFromTheScrim(dismissed: List<String>) {
        compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(10_000) { dismissed.isNotEmpty() }
        assertEquals(listOf("dismissed"), dismissed)
    }

    private fun nothingDrawnSaysCancelOrClose() {
        compose.onAllNodesWithText("Cancel").assertCountEquals(0)
        compose.onAllNodesWithText("Close").assertCountEquals(0)
    }

    private fun row(id: String) = LiveLines.MovementRow(
        id = id, name = id, tag = null, line = null, sets = emptyList(),
        isCurrent = false, justAdded = false, canDrop = false,
    )

    @Test
    fun theFixSheetsHandleDismissesWithoutCommittingItsNumericDraft() {
        val dismissed = mutableListOf<String>()
        val committed = mutableListOf<works.windmill.gym.presentation.SetFix>()
        val set = works.windmill.gym.presentation.TrainingSet("set", "bench-press", weightKg = 82.5, reps = 5, completedAtMs = 0)
        raised(dismissed) {
            FixSheet(set, "Bench Press", 1, null, onSave = {
                committed += it; works.windmill.gym.store.FixOutcome.Corrected(it.corrected(set))
            }, onDelete = {})
        }
        nothingDrawnSaysCancelOrClose()
        compose.onNodeWithContentDescription("Load, kg").performClick().performTextReplacement("10")
        compose.onNodeWithText("10").assertIsDisplayed()
        dismissFromTheHandle(dismissed)
        assertEquals(emptyList<works.windmill.gym.presentation.SetFix>(), committed)
    }

    @Test
    fun theFixSheetsScrimDismissesWithoutCommittingItsNumericDraft() {
        val dismissed = mutableListOf<String>()
        val committed = mutableListOf<works.windmill.gym.presentation.SetFix>()
        val set = works.windmill.gym.presentation.TrainingSet("set", "bench-press", weightKg = 82.5, reps = 5, completedAtMs = 0)
        raised(dismissed) {
            FixSheet(set, "Bench Press", 1, null, onSave = {
                committed += it; works.windmill.gym.store.FixOutcome.Corrected(it.corrected(set))
            }, onDelete = {})
        }
        compose.onNodeWithContentDescription("Reps").performClick().performTextReplacement("8")
        dismissFromTheScrim(dismissed)
        assertEquals(emptyList<works.windmill.gym.presentation.SetFix>(), committed)
    }

    @Test
    fun testTheEditMovementSheetDismissesFromTheHandleAndSavesNothing() {
        val dismissed = mutableListOf<String>()
        val renamed = mutableListOf<String>()
        raised(dismissed) {
            EditMovementSheet(Exercise("bench-press", "Bench Press"), "Bench Pres", "barbell", 1,
                refused = null, onName = {}, onEquipment = {}, onSave = { renamed += "saved" })
        }

        nothingDrawnSaysCancelOrClose()
        compose.onNodeWithText("Save").assertIsDisplayed()
        dismissFromTheHandle(dismissed)
        assertEquals(emptyList<String>(), renamed)
    }

    @Test
    fun testTheEditMovementSheetDismissesFromTheScrim() {
        val dismissed = mutableListOf<String>()
        raised(dismissed) {
            EditMovementSheet(Exercise("bench-press", "Bench Press"), "Bench Press", "barbell", 1,
                refused = null, onName = {}, onEquipment = {}, onSave = {})
        }
        dismissFromTheScrim(dismissed)
    }

    @Test
    fun testTheAssemblySheetDismissesFromTheHandleAndFromTheScrim() {
        val dismissed = mutableListOf<String>()
        raised(dismissed) {
            AssemblySheet(
                rows = listOf(row("bench-press"), row("squat")), routine = null,
                onJump = {}, onReorder = { _, _ -> }, onDrop = { true }, onAdd = {},
            )
        }

        nothingDrawnSaysCancelOrClose()
        compose.onNodeWithText("This workout").assertIsDisplayed()
        dismissFromTheHandle(dismissed)
    }

    @Test
    fun testTheAssemblySheetsScrimDismisses() {
        val dismissed = mutableListOf<String>()
        raised(dismissed) {
            AssemblySheet(
                rows = listOf(row("bench-press")), routine = null,
                onJump = {}, onReorder = { _, _ -> }, onDrop = { true }, onAdd = {},
            )
        }
        dismissFromTheScrim(dismissed)
    }

    // The create step is a sheet the picker raises over itself, so it is proven through the picker:
    // its handle carries Dismiss, invoking it brings the step down, nothing is minted, and the query
    // that opened it is handed back.
    @Test
    fun testTheCreateStepDismissesFromItsHandleMintsNothingAndHandsTheQueryBack() {
        val minted = mutableListOf<String>()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        compose.setContent {
            contentView = LocalView.current
            CompositionLocalProvider(LocalTelemetry provides telemetry) { MovementPicker(
                catalog = listOf(Exercise(id = "bench-press", name = "Bench Press")),
                taken = emptyList(), lastSets = null, nowMs = 0, title = "Add movement",
                onPick = {}, onCreate = { write -> minted += write.name; works.windmill.gym.store.MovementCreateOutcome.Added(Exercise(write.id, write.name, equipment = write.equipment, custom = true, loadCount = write.loadCount!!)) },
            ) }
        }
        compose.onNode(hasSetTextAction()).performTextReplacement("Zercher")
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
        compose.waitForIdle()
        compose.onNode(hasText("Create movement") and !hasClickAction()).assertIsDisplayed()
        compose.onAllNodesWithText("Cancel").assertCountEquals(1)

        val handle = handles()
        assertEquals("the create step's handle exposes SemanticsActions.Dismiss", 1, handle.size)
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
            .performSemanticsAction(SemanticsActions.Dismiss)
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasText("Create movement") and !hasClickAction()).fetchSemanticsNodes().isEmpty()
        }

        compose.runOnIdle { handle.single().config[SemanticsActions.Dismiss].action!!.invoke() }
        compose.waitForIdle()
        assertEquals(listOf("open", "cancel").map {
            "gym_action" to mapOf("screen" to "movement_form", "action" to it, "outcome" to "ok")
        }, events)
        assertTrue("nothing was minted", minted.isEmpty())
        compose.onNode(hasText("Create movement") and hasClickAction()).assertIsDisplayed()
        compose.onNodeWithText("Zercher").assertIsDisplayed()
    }
}
