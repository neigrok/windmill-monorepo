package works.windmill.gym.ui

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.filterToOne
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class PickerMintTests {
    private lateinit var contentView: View

    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

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
        runBlocking { store.connect(account) }
        return store
    }

    private fun editorPicker(scope: CoroutineScope): () -> RoutineDraft {
        val held = store(scope)
        var draft by mutableStateOf(RoutineDraft(name = "Push"))
        compose.setContent {
            contentView = LocalView.current
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

    private fun search() =
        compose.onAllNodes(hasSetTextAction()).filterToOne(hasText("Search movements"))

    private fun dismissTheCreateStep() {
        val step = compose.onNode(hasText("Create movement") and !hasClickAction()).fetchSemanticsNode().root
        val handle = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
            .fetchSemanticsNodes().single { it.root === step }
        compose.runOnIdle { handle.config[SemanticsActions.Dismiss].action!!.invoke() }
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasText("Create movement") and !hasClickAction()).fetchSemanticsNodes().isEmpty()
        }
    }

    private fun hideSearchIme() {
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
    }

    @Test
    fun testCancellingTheCreateStepHandsBackTheSearchThatOpenedIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editorPicker(scope)

        search().performTextReplacement("Zercher")
        compose.waitForIdle()
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        hideSearchIme()
        compose.waitForIdle()

        compose.onNode(hasText("Create movement") and !hasClickAction()).assertIsDisplayed()
        dismissTheCreateStep()

        compose.onNodeWithText("Create movement").assertIsDisplayed()
        compose.onNode(hasText("Create movement") and !hasClickAction()).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun testMintingFromTheCreateStepPutsTheMovementInTheDraft() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editorPicker(scope)

        search().performTextReplacement("Zercher Squat")
        compose.waitForIdle()
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        hideSearchIme()
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

    @Test
    fun testTheTypedSearchSurvivesTheProcessBeingReclaimed() {
        val restorer = StateRestorationTester(compose)
        val catalog = listOf(Exercise(id = "back-squat", name = "Back Squat"))
        restorer.setContent {
            contentView = LocalView.current
            MovementPicker(
                catalog = catalog,
                taken = emptyList(),
                lastSets = null,
                nowMs = 0,
                title = "Add movement",
                onPick = {},
                onCreate = { name, equipment, id -> works.windmill.gym.store.GymResult.Ok(works.windmill.gym.domain.Exercise(id, name, equipment = equipment, custom = true)) },
            )
        }

        compose.onNode(hasSetTextAction()).performTextReplacement("Zercher")
        compose.waitForIdle()
        compose.onNodeWithText("Zercher").assertIsDisplayed()

        restorer.emulateSavedInstanceStateRestore()
        hideSearchIme()

        compose.onNodeWithText("Zercher").assertIsDisplayed()
    }

    @Test
    fun testTheCreateStepsAnswersSurviveTheProcessBeingReclaimed() {
        val restorer = StateRestorationTester(compose)
        restorer.setContent {
            contentView = LocalView.current
            MovementPicker(
                catalog = listOf(Exercise(id = "back-squat", name = "Back Squat")),
                taken = emptyList(),
                lastSets = null,
                nowMs = 0,
                title = "Add movement",
                onPick = {},
                onCreate = { name, equipment, id -> works.windmill.gym.store.GymResult.Ok(works.windmill.gym.domain.Exercise(id, name, equipment = equipment, custom = true)) },
            )
        }

        compose.onNode(hasSetTextAction()).performTextReplacement("Zercher")
        compose.waitForIdle()
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        hideSearchIme()
        compose.waitForIdle()
        compose.onAllNodes(hasSetTextAction())[1].performTextReplacement("Zercher Carry")
        compose.onNodeWithText("Dumbbell").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Dumbbell").assertIsSelected()

        restorer.emulateSavedInstanceStateRestore()
        hideSearchIme()

        compose.onNode(hasText("Create movement") and !hasClickAction()).assertIsDisplayed()
        compose.onNodeWithText("Zercher Carry").assertIsDisplayed()
        compose.onNodeWithText("Dumbbell").assertIsSelected()
    }
}
