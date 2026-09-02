package works.windmill.gym.ui

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.LiveLines

// 12-native-idiom: a sheet is the platform's, and so is what leaving one means. The four sheets that
// used to draw their own Cancel or Close draw none now, so the way out has to be PROVEN rather than
// assumed: the drag handle exposes the platform's Dismiss action and invoking it reaches
// `onDismissRequest`; a tap on the scrim does the same; and neither commits anything — the keypad's
// buffer stands, which its own copy promises ("cancel to keep").
@OptIn(ExperimentalMaterial3Api::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SheetDismissTests {
    @get:Rule
    val compose = createComposeRule()

    private fun raised(dismissed: MutableList<String>, content: @Composable () -> Unit) {
        compose.setContent {
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
    fun testTheKeypadsHandleDismissesAndTheTypedNumberIsNeverCommitted() {
        val dismissed = mutableListOf<String>()
        val committed = mutableListOf<Double>()
        raised(dismissed) {
            KeypadSheet(KeypadEntry.Mode.Weight, current = 82.5, onCommit = { committed += it })
        }

        nothingDrawnSaysCancelOrClose()
        compose.onNodeWithText("1").performClick()
        compose.onNodeWithText("0").performClick()
        compose.onNodeWithText("10").assertIsDisplayed()
        dismissFromTheHandle(dismissed)
        assertEquals("nothing left the pad", emptyList<Double>(), committed)
    }

    @Test
    fun testTheKeypadsScrimDismissesAndTheTypedNumberIsNeverCommitted() {
        val dismissed = mutableListOf<String>()
        val committed = mutableListOf<Double>()
        raised(dismissed) {
            KeypadSheet(KeypadEntry.Mode.Reps, current = 5.0, onCommit = { committed += it })
        }

        compose.onNodeWithText("8").performClick()
        dismissFromTheScrim(dismissed)
        assertEquals(emptyList<Double>(), committed)
    }

    @Test
    fun testTheRenameSheetDismissesFromTheHandleAndRenamesNothing() {
        val dismissed = mutableListOf<String>()
        val renamed = mutableListOf<String>()
        raised(dismissed) {
            RenameSheet(
                title = "Rename this movement", from = "Bench Press", value = "Bench Pres",
                proof = emptyList(), refused = null, onValue = {}, onRename = { renamed += "renamed" },
            )
        }

        nothingDrawnSaysCancelOrClose()
        compose.onNodeWithText("Rename").assertIsDisplayed()
        dismissFromTheHandle(dismissed)
        assertEquals(emptyList<String>(), renamed)
    }

    @Test
    fun testTheRenameSheetDismissesFromTheScrim() {
        val dismissed = mutableListOf<String>()
        raised(dismissed) {
            RenameSheet(
                title = "Rename this movement", from = "Bench Press", value = "Bench Press",
                proof = emptyList(), refused = null, onValue = {}, onRename = {},
            )
        }
        dismissFromTheScrim(dismissed)
    }

    @Test
    fun testTheAssemblySheetDismissesFromTheHandleAndFromTheScrim() {
        val dismissed = mutableListOf<String>()
        raised(dismissed) {
            AssemblySheet(
                rows = listOf(row("bench-press"), row("squat")), elapsedMs = 0,
                onJump = {}, onReorder = { _, _ -> }, onDrop = { true }, onAdd = {},
            )
        }

        nothingDrawnSaysCancelOrClose()
        compose.onNodeWithText("This session").assertIsDisplayed()
        dismissFromTheHandle(dismissed)
    }

    @Test
    fun testTheAssemblySheetsScrimDismisses() {
        val dismissed = mutableListOf<String>()
        raised(dismissed) {
            AssemblySheet(
                rows = listOf(row("bench-press")), elapsedMs = 0,
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
        compose.setContent {
            MovementPicker(
                catalog = listOf(Exercise(id = "bench-press", name = "Bench Press")),
                taken = emptyList(), lastSets = null, nowMs = 0, title = "Add movement",
                onPick = {}, onCreate = { name, _ -> minted += name },
            )
        }
        compose.onNode(hasSetTextAction()).performTextReplacement("Zercher")
        compose.onNodeWithText("Create “Zercher”").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Your movement").assertIsDisplayed()
        compose.onAllNodesWithText("Cancel").assertCountEquals(0)

        val handle = handles()
        assertEquals("the create step's handle exposes SemanticsActions.Dismiss", 1, handle.size)
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
            .performSemanticsAction(SemanticsActions.Dismiss)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Your movement").fetchSemanticsNodes().isEmpty()
        }

        assertTrue("nothing was minted", minted.isEmpty())
        compose.onNodeWithText("Create “Zercher”").assertIsDisplayed()
    }
}
