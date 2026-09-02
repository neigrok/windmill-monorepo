package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore

// The editor screen itself, as opposed to the target sheet it opens: the movement row's swipe and
// its custom action (13-gestures Law 1), the name field's autofocus, the counter's threshold, and
// the two Save refusals 15-the-routine pins for every surface.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutineEditorTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope) = TrainingStore(
        queue = SetQueue(File(tmp.root, "queue.json")),
        deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
        localLog = LocalLog(File(tmp.root, "local.json")),
        localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
        localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
        scope = scope,
        sync = { null },
    )

    private fun editor(scope: CoroutineScope, opening: RoutineDraft): () -> RoutineDraft {
        val store = store(scope)
        var draft by mutableStateOf(opening)
        compose.setContent {
            RoutineBuilder(
                draft = draft,
                store = store,
                saving = false,
                onDraft = { draft = it },
                onSave = {},
                onClose = {},
                say = {},
            )
        }
        return { draft }
    }

    private fun actionsOn(movement: String): List<CustomAccessibilityAction> {
        val row = compose.onNodeWithText(movement).fetchSemanticsNode()
        if (!row.config.contains(SemanticsActions.CustomActions)) return emptyList()
        return row.config[SemanticsActions.CustomActions]
    }

    private fun handle(name: String) = compose.onNodeWithContentDescription(name)

    // Law 1: on Android a swipe is half-built until its custom action exists, and this row's swipe
    // is the only way a movement leaves a routine.
    @Test
    fun testAMovementRowOffersRemoveAsACustomActionAndNotOnlyAsASwipe() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat"))

        val steps = actionsOn("bench-press")
        assertEquals(listOf("Remove", "Move down"), steps.map { it.label })

        compose.runOnIdle { steps.first { it.label == "Remove" }.action() }
        compose.runOnIdle {
            assertEquals("and it removes the same line the swipe would",
                listOf("squat"), draft().entries.map { it.exerciseId })
        }
        scope.cancel()
    }

    // A fresh editor opens ON the name field: there is no screen before this one that asked for a
    // name. The effect runs against a field the Scaffold subcomposes during measure, so it has to
    // wait for that frame rather than fire at composition.
    @Test
    fun testAFreshEditorOpensWithTheNameFieldFocused() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft())
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Routine name").assertIsFocused()
        scope.cancel()
    }

    // 15-the-routine: the counter appears in the last fifth and is silent before it, the same rule
    // the note editor's byte counter keeps.
    @Test
    fun testTheNameCounterIsSilentUntilTheLastFifth() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day"))

        compose.onNodeWithText("7/60").assertDoesNotExist()
        assertEquals(48, Program.counterFrom)

        compose.onNodeWithContentDescription("Routine name").performTextReplacement("a".repeat(47))
        compose.onNodeWithText("47/60").assertDoesNotExist()

        compose.onNodeWithContentDescription("Routine name").performTextReplacement("a".repeat(53))
        compose.onNodeWithText("53/60").assertIsDisplayed()
        scope.cancel()
    }

    // Save is disabled while the draft cannot be saved, and the reason is drawn — one at a time, name
    // first, never concatenated.
    @Test
    fun testTheTwoSaveRefusalsAreDrawnOneAtATimeInThePinnedOrder() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft())

        compose.onNodeWithText("Name it to save it.").assertIsDisplayed()
        compose.onNodeWithText("A routine is at least one movement.").assertDoesNotExist()

        compose.onNodeWithContentDescription("Routine name").performTextReplacement("Push Day")
        compose.onNodeWithText("Name it to save it.").assertDoesNotExist()
        compose.onNodeWithText("A routine is at least one movement.").assertIsDisplayed()
        scope.cancel()
    }

    // C1: the open line's sentence has one placement rule — once beneath the list when at least one
    // row is open, never per row. The row's own target column says WHICH row it is about.
    @Test
    fun testTheEditorSaysTheOpenLineOnceBeneathItsMovementList() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat")
            .targeting("squat", sets = 3, reps = 5, weightKg = 60.0))

        compose.onAllNodesWithText("You decide the numbers at the rack.").assertCountEquals(1)
        compose.onNodeWithText("You decide the numbers at the rack.").assertIsDisplayed()
        compose.onNodeWithText("open").assertIsDisplayed()
        scope.cancel()
    }

    // C19: and the list keeps that sentence only while nothing stands over it. The target sheet says
    // the same words in front of the scrim, so the list's copy stands down for as long as the sheet is
    // up — one state, one sentence.
    @Test
    fun testTheEditorsOpenLineStandsDownWhileATargetSheetStandsOverIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press"))

        // With nothing over it, the list says it, beneath the movement it is about.
        compose.onAllNodesWithText("You decide the numbers at the rack.").assertCountEquals(1)
        val said = compose.onNodeWithText("You decide the numbers at the rack.")
            .fetchSemanticsNode().positionInRoot.y
        val movement = compose.onNodeWithText("bench-press").fetchSemanticsNode().positionInRoot.y
        assertTrue("beneath the movement list", said > movement)

        // The sheet stands up and takes the sentence with it: still exactly one on screen, and it is
        // the sheet's — drawn beside the never-logged line the list has no equivalent of.
        compose.onNodeWithText("bench-press").performClick()
        compose.onAllNodesWithText("You decide the numbers at the rack.").assertCountEquals(1)
        compose.onNodeWithText("Never logged — these are your numbers.").assertIsDisplayed()
        compose.onNodeWithText("You decide the numbers at the rack.").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testARoutineWhoseEveryLineNamesItsNumbersSaysNothingAboutTheRack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press")
            .targeting("bench-press", sets = 3, reps = 5, weightKg = 60.0))

        compose.onNodeWithText("You decide the numbers at the rack.").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun testASavableDraftSaysNothingAtAll() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press"))

        compose.onNodeWithText("Name it to save it.").assertDoesNotExist()
        compose.onNodeWithText("A routine is at least one movement.").assertDoesNotExist()
        scope.cancel()
    }

    // The reorder rail's single-pointer path, in the web's words: a tap on a handle picks the row
    // up and says so; the next tap on another row's handle places it there and says the move once;
    // the handle's own name says what it does next throughout.
    @Test
    fun testATapPicksARowUpAndATapOnAnotherHandlePlacesItThere() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat").adding("row"))

        handle("Move bench-press, 1 of 3").assertIsDisplayed()
        handle("Move squat, 2 of 3").assertIsDisplayed()

        handle("Move bench-press, 1 of 3").performClick()
        compose.onNodeWithText("bench-press, 1 of 3 — picked up").assertIsDisplayed()
        handle("Move bench-press, 1 of 3 — picked up").assertIsDisplayed()
        handle("Place bench-press at 3 of 3").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("picking up moves nothing", listOf("bench-press", "squat", "row"),
                draft().entries.map { it.exerciseId })
        }

        handle("Place bench-press at 3 of 3").performClick()
        compose.runOnIdle {
            assertEquals(listOf("squat", "row", "bench-press"), draft().entries.map { it.exerciseId })
            assertEquals("and every position is renumbered", listOf(1, 2, 3), draft().entries.map { it.position })
        }
        compose.onNodeWithText("bench-press, 3 of 3").assertIsDisplayed()
        handle("Move bench-press, 3 of 3").assertIsDisplayed()
        handle("Move squat, 1 of 3").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testTheSameHandleAgainPutsTheRowBackWhereItStands() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat"))

        handle("Move squat, 2 of 2").performClick()
        handle("Move squat, 2 of 2 — picked up").performClick()
        compose.onNodeWithText("squat, 2 of 2 — put back").assertIsDisplayed()
        handle("Move squat, 2 of 2").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(listOf("bench-press", "squat"), draft().entries.map { it.exerciseId })
        }
        scope.cancel()
    }

    // Law 1's other half: Move up / Move down are the row's own custom actions, offered only where
    // there is somewhere to go, and each move is said once on the same line.
    @Test
    fun testMoveUpAndMoveDownAreCustomActionsAndTheEndsAreNotWrapped() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat").adding("row"))

        assertEquals(listOf("Remove", "Move down"), actionsOn("bench-press").map { it.label })
        assertEquals(listOf("Remove", "Move up", "Move down"), actionsOn("squat").map { it.label })
        assertEquals(listOf("Remove", "Move up"), actionsOn("row").map { it.label })

        compose.runOnIdle { actionsOn("row").first { it.label == "Move up" }.action() }
        compose.runOnIdle {
            assertEquals(listOf("bench-press", "row", "squat"), draft().entries.map { it.exerciseId })
        }
        compose.onNodeWithText("row, 2 of 3").assertIsDisplayed()

        compose.runOnIdle { actionsOn("bench-press").first { it.label == "Move down" }.action() }
        compose.runOnIdle {
            assertEquals(listOf("row", "bench-press", "squat"), draft().entries.map { it.exerciseId })
        }
        compose.onNodeWithText("bench-press, 2 of 3").assertIsDisplayed()
        scope.cancel()
    }

    // The web's `step`: a held row is what the two moves move, whichever row's action was invoked.
    // With the held row already at the top, Move up on the row beneath it has nowhere to go, so
    // nothing moves and nothing new is said.
    @Test
    fun testMoveUpOnAnotherRowMovesTheHeldRowAndTheEndsStillHold() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat"))

        handle("Move bench-press, 1 of 2").performClick()
        compose.onNodeWithText("bench-press, 1 of 2 — picked up").assertIsDisplayed()

        compose.runOnIdle { actionsOn("squat").first { it.label == "Move up" }.action() }
        compose.runOnIdle {
            assertEquals(listOf("bench-press", "squat"), draft().entries.map { it.exerciseId })
        }
        compose.onNodeWithText("bench-press, 1 of 2 — picked up").assertIsDisplayed()

        compose.runOnIdle { actionsOn("bench-press").first { it.label == "Move down" }.action() }
        compose.runOnIdle {
            assertEquals(listOf("squat", "bench-press"), draft().entries.map { it.exerciseId })
        }
        compose.onNodeWithText("bench-press, 2 of 2").assertIsDisplayed()
        handle("Move bench-press, 2 of 2 — picked up").assertIsDisplayed()
        scope.cancel()
    }

    // A row that leaves the list is no longer held: the handles stop offering to place it, the line
    // that said it was picked up goes quiet, and adding the same movement back does not bring the
    // hold back with it.
    @Test
    fun testRemovingTheHeldRowDropsTheHoldAndQuietsTheLine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat").adding("row"))

        handle("Move bench-press, 1 of 3").performClick()
        compose.onNodeWithText("bench-press, 1 of 3 — picked up").assertIsDisplayed()
        handle("Place bench-press at 2 of 3").assertIsDisplayed()

        compose.runOnIdle { actionsOn("bench-press").first { it.label == "Remove" }.action() }
        compose.runOnIdle {
            assertEquals(listOf("squat", "row"), draft().entries.map { it.exerciseId })
        }
        compose.onAllNodesWithText("bench-press, 1 of 3 — picked up").assertCountEquals(0)
        handle("Move squat, 1 of 2").assertIsDisplayed()
        handle("Move row, 2 of 2").assertIsDisplayed()
        val line = compose.onNode(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
            .fetchSemanticsNode()
        assertEquals("", line.config[SemanticsProperties.Text].joinToString { it.text })
        scope.cancel()
    }

    // The line under the list is a polite live region: it stands before there is anything to say,
    // so the sentence that lands on it is announced as a change.
    @Test
    fun testTheMoveIsSaidOnOnePoliteLiveRegionUnderTheList() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat"))

        val lines = compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
        lines.assertCountEquals(1)
        val standing = lines.fetchSemanticsNodes().single()
        assertEquals("", standing.config[SemanticsProperties.Text].joinToString { it.text })

        handle("Move squat, 2 of 2").performClick()
        handle("Place squat at 1 of 2").performClick()
        val said = compose.onNode(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
            .fetchSemanticsNode()
        assertEquals("squat, 1 of 2", said.config[SemanticsProperties.Text].joinToString { it.text })
        assertEquals("the same node, not a new one", standing.id, said.id)
        scope.cancel()
    }
}
