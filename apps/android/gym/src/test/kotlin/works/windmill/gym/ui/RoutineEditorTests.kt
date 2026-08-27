package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.SemanticsActions
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

    // Law 1: on Android a swipe is half-built until its custom action exists, and this row's swipe
    // is the only way a movement leaves a routine.
    @Test
    fun testAMovementRowOffersRemoveAsACustomActionAndNotOnlyAsASwipe() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat"))

        val row = compose.onNodeWithText("bench-press").fetchSemanticsNode()
        val steps: List<CustomAccessibilityAction> =
            if (row.config.contains(SemanticsActions.CustomActions)) {
                row.config[SemanticsActions.CustomActions]
            } else {
                emptyList()
            }
        assertEquals(listOf("Remove"), steps.map { it.label })

        compose.runOnIdle { steps.single().action() }
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
}
