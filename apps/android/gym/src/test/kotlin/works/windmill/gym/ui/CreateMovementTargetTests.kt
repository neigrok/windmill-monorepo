package works.windmill.gym.ui

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import androidx.compose.ui.platform.LocalView
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.robolectric.shadows.ShadowDialog

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import java.io.File
import kotlinx.coroutines.CompletableDeferred
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
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.TargetEntry
import works.windmill.gym.domain.TheSix
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.WriteFailure
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
class CreateMovementTargetTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun createRestoresItsTargetAndAddsTheCompleteSchemeInOneDraftChange() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try {
            val store = TrainingStore(SetQueue(File(tmp.root, "queue.json")), DeviceCopy(File(tmp.root, "catalog.json")),
                LocalLog(File(tmp.root, "local.json")), LocalPreferences(File(tmp.root, "prefs.json")),
                LocalBodyweight(File(tmp.root, "bodyweight.json")), scope, sync = { null })
            runBlocking { store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), null)) }
            var draft by mutableStateOf(RoutineDraft(name = "Pull"))
            val changes = mutableListOf<RoutineDraft>()
            val restorer = StateRestorationTester(compose)
            restorer.setContent {
                GymMaterial {
                    RoutineBuilder(draft, store, false, { draft = it; changes += it }, {}, {}, {})
                }
            }
            compose.onNodeWithText("Add movement").performClick()
            compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
            compose.onNodeWithContentDescription("Movement name").performTextReplacement("Meadows 🏋 row")
            compose.onNodeWithContentDescription("Sets target").assertTextEquals("3")
            compose.onNodeWithContentDescription("Reps target").assertTextEquals("10")
            assertEquals("", compose.onNodeWithContentDescription("Weight target").fetchSemanticsNode()
                .config[SemanticsProperties.EditableText].text)
            compose.onNodeWithText("Ramp up").assertIsNotEnabled()
            compose.onNodeWithContentDescription("Weight target").performTextReplacement("25..5")
            compose.onNodeWithText("Add to routine").assertIsNotEnabled()
            restorer.emulateSavedInstanceStateRestore()
            compose.onNodeWithContentDescription("Movement name").assertTextEquals("Meadows 🏋 row")
            compose.onNodeWithContentDescription("Weight target").assertTextEquals("25..5")
            compose.onNodeWithContentDescription("Weight target").performTextReplacement("25")
            compose.onNodeWithContentDescription("Increase Reps").performClick()
            compose.onNodeWithText("Vary by set").performScrollTo().performClick()
            compose.onNodeWithContentDescription("Set 1 load").performTextReplacement("20")
            compose.onNodeWithContentDescription("Set 3 load").performTextReplacement("30")
            compose.onNodeWithText("Ramp up").performScrollTo().performClick()
            compose.onNodeWithText("Add to routine").performClick()
            compose.runOnIdle {
                val exercise = store.catalog.single { it.custom }
                assertEquals("Meadows 🏋 row", exercise.name)
                assertEquals(listOf(RoutineDraft(name = "Pull").adding(exercise.id,
                    listOf(SetTarget(11, 20.0), SetTarget(11, 25.0), SetTarget(11, 30.0)))), changes)
            }
            compose.onNodeWithText("Meadows 🏋 row").assertIsDisplayed().performClick()
            compose.onNodeWithContentDescription("Set 1 load").assertTextEquals("20")
            compose.onNodeWithContentDescription("Set 2 load").assertTextEquals("25")
            compose.onNodeWithContentDescription("Set 3 load").assertTextEquals("30")
            compose.onNodeWithText("Set · 3 sets").assertIsDisplayed()
        } finally {
            scope.cancel()
        }
    }
    @Test
    fun pendingCreateClosesFillAndRejectsQueuedEditsUntilItsRefusalReturns() {
        val targets = listOf(SetTarget(10, 20.0), SetTarget(8, 30.0), SetTarget(6, 40.0))
        val initial = TargetEntry.Draft(targets)
        val state = MovementPickerState(createName = "Cable row", requestId = "ex_pending", scheme = initial)
        lateinit var contentView: View
        val pending = CompletableDeferred<GymResult<Exercise>>()
        val calls = mutableListOf<ExerciseWrite>()
        val created = mutableListOf<Pair<Exercise, List<SetTarget>>>()
        val exercise = Exercise("ex_pending", "Cable row", Exercise.unclassified, "barbell", custom = true)
        compose.setContent {
            GymMaterial {
                contentView = LocalView.current
                MovementPicker(TheSix.movements, emptyList(), null, 0, "Add movement",
                    onPick = { error("routine creation must include its target") },
                    onCreate = { name, equipment, id ->
                        calls += ExerciseWrite(id, name, Exercise.unclassified, equipment)
                        if (calls.size == 1) pending.await() else GymResult.Ok(exercise)
                    },
                    onCreateTarget = { made, scheme -> created += made to scheme },
                    state = state)
            }
        }
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        val hidden = WindowInsets.Builder().setInsets(WindowInsets.Type.ime(), Insets.NONE)
            .setVisible(WindowInsets.Type.ime(), false).build()
        compose.runOnIdle {
            contentView.dispatchApplyWindowInsets(hidden)
            ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .forEach { it.window.decorView.dispatchApplyWindowInsets(hidden) }
            ShadowDialog.getShownDialogs().filter { it.isShowing }
                .forEach { it.window!!.decorView.dispatchApplyWindowInsets(hidden) }
        }
        compose.mainClock.advanceTimeBy(64)
        compose.waitForIdle()
        val submit = compose.onNodeWithText("Add to routine").fetchSemanticsNode()
            .config[SemanticsActions.OnClick].action!!
        val queuedEdit = compose.onNodeWithContentDescription("Set 1 load").fetchSemanticsNode()
            .config[SemanticsActions.SetText].action!!
        compose.onNodeWithText("1", useUnmergedTree = true).performScrollTo().performTouchInput { longClick() }
        compose.onNodeWithText(TargetEntry.matchSetOne).assertIsDisplayed()
        compose.runOnIdle { submit() }
        compose.onNodeWithText("Creating…").assertIsNotEnabled()
        compose.onNodeWithText(TargetEntry.matchSetOne).assertDoesNotExist()
        compose.onNodeWithContentDescription("Set 1 load").assertIsNotEnabled()
        compose.onNodeWithText("1", useUnmergedTree = true).performScrollTo().performTouchInput { longClick() }
        compose.onNodeWithText(TargetEntry.matchSetOne).assertDoesNotExist()
        compose.runOnIdle {
            queuedEdit(AnnotatedString("99"))
            assertEquals(initial, state.scheme)
            assertEquals(emptyList<Pair<Exercise, List<SetTarget>>>(), created)
            assertEquals(listOf(ExerciseWrite("ex_pending", "Cable row", Exercise.unclassified, "barbell")), calls)
            pending.complete(GymResult.Failed(WriteFailure.Refused("Try again")))
        }
        compose.onNodeWithText("Add to routine").assertIsEnabled()
        compose.onNodeWithText(TargetEntry.matchSetOne).assertDoesNotExist()
        compose.runOnIdle { assertEquals(initial, state.scheme) }
        compose.onNodeWithText("1", useUnmergedTree = true).performScrollTo().performTouchInput { longClick() }
        compose.onNodeWithText(TargetEntry.matchSetOne).assertIsEnabled().performClick()
        compose.onNodeWithText("Add to routine").performClick()
        compose.runOnIdle {
            assertEquals(listOf(exercise to List(3) { targets.first() }), created)
            assertEquals(List(2) { ExerciseWrite("ex_pending", "Cable row", Exercise.unclassified, "barbell") }, calls)
        }
    }

}
