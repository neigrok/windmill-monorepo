package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.filterToOne
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import java.io.File
import org.junit.rules.TemporaryFolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi

// Creating a movement stays inside the picker (15-the-routine): the create step is drawn by the
// picker over itself, so cancelling it hands back the search that opened it rather than a fresh
// picker. Nothing else on the screen reaches a name the query does not match, so losing the query
// costs the typing AND the six the picker froze.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class PickerMintTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    // Signed out on purpose: the mint lands on this device and never on the wire, which is the path
    // with no server refusal behind it.
    private val account = Account(
        api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
        user = null,
    )

    private fun store(scope: CoroutineScope): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { null },
        )
        // The six are the whole catalog here, so any other name matches nothing and opens the door.
        runBlocking { store.connect(account) }
        return store
    }

    private fun editorPicker(scope: CoroutineScope): () -> RoutineDraft {
        val held = store(scope)
        var draft by mutableStateOf(RoutineDraft(name = "Push"))
        compose.setContent {
            RoutineBuilder(
                draft = draft,
                store = held,
                saving = false,
                onDraft = { draft = it },
                onSave = {},
                onClose = {},
                say = {},
            )
        }
        compose.onNodeWithText("Add movement").performClick()
        compose.waitForIdle()
        return { draft }
    }

    // The editor draws a name field of its own, so the picker's search is named by its placeholder.
    private fun search() =
        compose.onAllNodes(hasSetTextAction()).filterToOne(hasText("Search 6 movements"))

    // The create step draws no Cancel of its own: its sheet's drag handle carries the platform's
    // Dismiss, told from the picker's own handle by the window the step is drawn in.
    private fun dismissTheCreateStep() {
        val step = compose.onNodeWithText("Your movement").fetchSemanticsNode().root
        val handle = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
            .fetchSemanticsNodes().single { it.root === step }
        compose.runOnIdle { handle.config[SemanticsActions.Dismiss].action!!.invoke() }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Your movement").fetchSemanticsNodes().isEmpty()
        }
    }

    @Test
    fun testCancellingTheCreateStepHandsBackTheSearchThatOpenedIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editorPicker(scope)

        search().performTextReplacement("Zercher")
        compose.waitForIdle()
        compose.onNodeWithText("Create “Zercher”").performClick()
        compose.waitForIdle()

        compose.onNodeWithText("Your movement").assertIsDisplayed()
        dismissTheCreateStep()

        // The door is drawn only where the query matches nothing, so its bytes ARE the query.
        compose.onNodeWithText("Create “Zercher”").assertIsDisplayed()
        compose.onNodeWithText("Your movement").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun testMintingFromTheCreateStepPutsTheMovementInTheDraft() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editorPicker(scope)

        search().performTextReplacement("Zercher Squat")
        compose.waitForIdle()
        compose.onNodeWithText("Create “Zercher Squat”").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Create and add").performClick()
        compose.waitForIdle()

        compose.runOnIdle {
            assertEquals("the picker's create door mints and adds, it opens no second screen",
                         1, draft().entries.size)
        }
        compose.onNodeWithText("Zercher Squat").assertIsDisplayed()
        scope.cancel()
    }

    // The typed search is saved as the pending create step already is: a process reclaimed with the
    // picker open comes back to the same shortlist rather than to an empty field.
    @Test
    fun testTheTypedSearchSurvivesTheProcessBeingReclaimed() {
        val restorer = StateRestorationTester(compose)
        val catalog = listOf(Exercise(id = "back-squat", name = "Back Squat"))
        restorer.setContent {
            MovementPicker(
                catalog = catalog,
                taken = emptyList(),
                lastSets = null,
                nowMs = 0,
                title = "Add movement",
                onPick = {},
                onCreate = { _, _ -> },
            )
        }

        compose.onNode(hasSetTextAction()).performTextReplacement("Zercher")
        compose.waitForIdle()
        compose.onNodeWithText("Create “Zercher”").assertIsDisplayed()

        restorer.emulateSavedInstanceStateRestore()

        compose.onNodeWithText("Create “Zercher”").assertIsDisplayed()
    }

    // And so do the two answers the create step collects. They are held by the PICKER and not by the
    // sheet drawing them: state written inside a `ModalBottomSheet` does not come back from a
    // reclaim, so a step that kept its own would return with the name retyped and barbell chosen.
    @Test
    fun testTheCreateStepsAnswersSurviveTheProcessBeingReclaimed() {
        val restorer = StateRestorationTester(compose)
        restorer.setContent {
            MovementPicker(
                catalog = listOf(Exercise(id = "back-squat", name = "Back Squat")),
                taken = emptyList(),
                lastSets = null,
                nowMs = 0,
                title = "Add movement",
                onPick = {},
                onCreate = { _, _ -> },
            )
        }

        compose.onNode(hasSetTextAction()).performTextReplacement("Zercher")
        compose.waitForIdle()
        compose.onNodeWithText("Create “Zercher”").performClick()
        compose.waitForIdle()
        compose.onAllNodes(hasSetTextAction())[1].performTextReplacement("Zercher Carry")
        compose.onNodeWithText("Dumbbell").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Dumbbell").assertIsSelected()

        restorer.emulateSavedInstanceStateRestore()

        compose.onNodeWithText("Your movement").assertIsDisplayed()
        compose.onNodeWithText("Zercher Carry").assertIsDisplayed()
        compose.onNodeWithText("Dumbbell").assertIsSelected()
    }
}
