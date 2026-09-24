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
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import java.io.File
import kotlinx.coroutines.CompletableDeferred
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
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import works.windmill.gym.domain.*
import works.windmill.gym.store.*
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class PlanningRestorationTests {
    private lateinit var contentView: View

    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

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
    fun builderRestoresRawInvalidAndHiddenTargetRowsButCancelLeavesTheRoutineUntouched() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        val original = RoutineDraft(name = "Push").adding("bench-press")
            .targeting("bench-press", listOf(SetTarget(8, 60.0), SetTarget(6, 65.0), SetTarget(4, 70.0)))
        var draft by mutableStateOf(original)
        val restorer = StateRestorationTester(compose)
        restorer.setContent {
            contentView = LocalView.current
            RoutineBuilder(draft, store, false, { draft = it }, {}, {}, {})
        }
        compose.onNodeWithText("Bench Press").performClick()
        compose.onNodeWithContentDescription("Set 3 load").performTextReplacement("82..5")
        compose.onNodeWithContentDescription("Sets target").performTextReplacement("1")
        compose.onNodeWithContentDescription("Set 1 reps").performTextReplacement("no")
        restorer.emulateSavedInstanceStateRestore()
        hideSearchIme()
        compose.onNodeWithContentDescription("Sets target").assertTextEquals("1")
        compose.onNodeWithContentDescription("Set 1 reps").assertTextEquals("no")
        compose.onNodeWithContentDescription("Sets target").performTextReplacement("3")
        compose.onNodeWithContentDescription("Set 3 load").assertTextEquals("82..5")
        compose.onNode(hasText("Set") and hasClickAction()).assertIsNotEnabled()
        compose.onNodeWithText("Cancel").performClick()
        compose.waitForIdle()
        assertEquals(original, draft)
        compose.onNodeWithText("Bench Press").performClick()
        compose.onNodeWithContentDescription("Set 3 load").assertTextEquals("70")
        scope.cancel()
    }

    @Test
    fun routinePickerRestoresTheCreateRouteAndRetainsInputAfterCancelAndReopen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        var draft by mutableStateOf(RoutineDraft(name = "Push"))
        val restorer = StateRestorationTester(compose)
        restorer.setContent {
            contentView = LocalView.current
            RoutineBuilder(draft, store, false, { draft = it }, {}, {}, {})
        }
        compose.onNodeWithText("Add movement").performClick()
        compose.onNode(hasSetTextAction() and hasText("Search movements")).performTextReplacement("Zercher")
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        hideSearchIme()
        compose.onNodeWithContentDescription("Movement name").performTextReplacement("Zercher 🏋 carry")
        compose.onNodeWithText("Dumbbell").performClick()
        restorer.emulateSavedInstanceStateRestore()
        hideSearchIme()
        compose.onNodeWithContentDescription("Movement name").assertTextEquals("Zercher 🏋 carry")
        compose.onNodeWithText("Dumbbell").assertIsSelected()
        compose.onAllNodesWithText("Cancel").onLast().performClick()
        compose.waitForIdle()
        compose.onNode(hasSetTextAction() and hasText("Zercher")).assertIsDisplayed()
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        hideSearchIme()
        compose.onNodeWithContentDescription("Movement name").assertTextEquals("Zercher 🏋 carry")
        compose.onNodeWithText("Dumbbell").assertIsSelected()
        compose.onNodeWithText("Add to routine").performClick()
        compose.waitForIdle()
        assertEquals(listOf("Zercher 🏋 carry"), draft.entries.map { id -> store.catalog.single { it.id == id.exerciseId }.name })
        assertEquals(listOf("dumbbell"), store.catalog.filter { it.custom }.map { it.equipment })
        scope.cancel()
    }

    @Test
    fun quickSessionRestoresItsCreateRouteAndAddsToTheInvokingSession() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        runBlocking { store.start(null) }
        val session = store.session!!.id
        val restorer = StateRestorationTester(compose)
        restorer.setContent {
            contentView = LocalView.current
            LoggerScreen(store, false, {}, {}, {}, {})
        }
        compose.onNode(hasSetTextAction()).performTextReplacement("Carry")
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        hideSearchIme()
        compose.onNodeWithContentDescription("Movement name").performTextReplacement("Farmer carry")
        compose.onNodeWithText("Dumbbell").performClick()
        restorer.emulateSavedInstanceStateRestore()
        hideSearchIme()
        compose.onNodeWithContentDescription("Movement name").assertTextEquals("Farmer carry")
        compose.onNodeWithText("Dumbbell").assertIsSelected()
        compose.onNodeWithText("Create and add").performClick()
        compose.waitForIdle()
        assertEquals(session, store.session?.id)
        val exercise = store.catalog.single { it.custom }
        assertEquals("Farmer carry", exercise.name)
        assertEquals("dumbbell", exercise.equipment)
        assertEquals(listOf(exercise.id), store.order)
        assertEquals(exercise.id, store.exerciseId)
        scope.cancel()
    }

    @Test
    fun deferredCreateRejectsSecondTapAndRestorationReleasesBusyWithoutChangingTheRequestIdentity() {
        val restorer = StateRestorationTester(compose)
        val first = CompletableDeferred<GymResult<Exercise>>()
        val calls = mutableListOf<ExerciseWrite>()
        val picked = mutableListOf<String>()
        restorer.setContent {
            contentView = LocalView.current
            MovementPicker(catalog = TheSix.movements, taken = emptyList(), lastSets = null,
                nowMs = 0, title = "Add movement", onPick = { picked += it },
                onCreate = { name, equipment, id ->
                    calls += ExerciseWrite(id, name, Exercise.unclassified, equipment)
                    if (calls.size == 1) first.await()
                    else GymResult.Failed(WriteFailure.Refused("That name needs checking"))
                })
        }
        compose.onNode(hasSetTextAction()).performTextReplacement("Zercher")
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        hideSearchIme()
        compose.onNodeWithText("Dumbbell").performClick()
        compose.onNodeWithText("Create and add").performClick()
        compose.onNodeWithText("Creating…").assertIsNotEnabled().performClick()
        assertEquals(1, calls.size)
        restorer.emulateSavedInstanceStateRestore()
        hideSearchIme()
        compose.onNodeWithText("Create and add").assertIsEnabled().performClick()
        compose.waitForIdle()
        assertEquals(listOf(calls.first(), calls.first()), calls)
        assertEquals("Zercher", calls.first().name)
        compose.onNodeWithText("That name needs checking").assertIsDisplayed()
        compose.onNodeWithContentDescription("Movement name").assertTextEquals("Zercher")
        compose.onNodeWithText("Dumbbell").assertIsSelected()
        assertEquals(emptyList<String>(), picked)
    }
    @Test
    fun openBodyweightTargetsDisableSignAndRestoreTheHiddenAssistedLoads() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        val original = RoutineDraft(name = "Pull").adding("chin-up")
            .targeting("chin-up", listOf(SetTarget(8, -10.0), SetTarget(6, -5.0)))
        var draft by mutableStateOf(original)
        val restorer = StateRestorationTester(compose)
        restorer.setContent {
            contentView = LocalView.current
            RoutineBuilder(draft, store, false, { draft = it }, {}, {}, {})
        }
        compose.onNodeWithText("Chin Up").performClick()
        compose.onNodeWithContentDescription("Sets target").performTextReplacement("")
        compose.onNodeWithContentDescription(KeypadEntry.signName).assertIsNotEnabled().performClick()
        restorer.emulateSavedInstanceStateRestore()
        hideSearchIme()
        compose.onNodeWithContentDescription(KeypadEntry.signName).assertIsNotEnabled()
        compose.onNodeWithContentDescription("Sets target").performTextReplacement("2")
        compose.onNodeWithContentDescription("Set 1 load").assertTextEquals("−10")
        compose.onNodeWithContentDescription("Set 2 load").assertTextEquals("−5")
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(original, draft)
        scope.cancel()
    }

    @Test
    fun selectedMovementsStayVisibleButCannotBeAddedTwice() {
        val picked = mutableListOf<String>()
        compose.setContent {
            contentView = LocalView.current
            MovementPicker(catalog = TheSix.movements, taken = listOf("bench-press"), lastSets = null,
                nowMs = 0, title = "Add movement", onPick = { picked += it },
                onCreate = { _, _, _ -> error("no creation") })
        }
        compose.onNodeWithText("Bench Press").assertIsSelected().assertIsNotEnabled().performClick()
        compose.onNodeWithText("Back Squat").assertIsEnabled().performClick()
        assertEquals(listOf("back-squat"), picked)
    }

    @Test
    fun reopeningCreateHandsOffTheSearchKeyboardBeforeItMountsTheNewSheet() {
        val state = MovementPickerState()
        compose.setContent {
            contentView = LocalView.current
            MovementPicker(state = state, catalog = TheSix.movements, taken = emptyList(), lastSets = null,
                nowMs = 0, title = "Add movement", onPick = {},
                onCreate = { _, _, _ -> error("no creation") })
        }
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        hideSearchIme()
        compose.onNodeWithContentDescription("Movement name").performTextReplacement("Ring Row")
        compose.onNode(hasText("Bodyweight") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)).performClick()
        compose.onNodeWithText("Cancel").performClick()
        compose.waitForIdle()
        compose.onNode(hasSetTextAction()).performTextReplacement("Ring")
        val shown = WindowInsets.Builder().setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, 700))
            .setVisible(WindowInsets.Type.ime(), true).build()
        compose.runOnIdle { contentView.dispatchApplyWindowInsets(shown) }
        compose.onNode(hasText("Create movement") and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick) { it() }
        compose.waitForIdle()
        assertTrue(state.createOpen)
        compose.onNodeWithContentDescription("Movement name").assertDoesNotExist()
        val hidden = WindowInsets.Builder().setInsets(WindowInsets.Type.ime(), Insets.NONE)
            .setVisible(WindowInsets.Type.ime(), false).build()
        compose.runOnIdle { contentView.dispatchApplyWindowInsets(hidden) }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Movement name").assertTextEquals("Ring Row")
        compose.onNode(hasText("Bodyweight") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)).assertIsSelected()
        compose.onNodeWithText("Create and add").assertIsDisplayed().assertIsEnabled()
    }

    @Test
    fun legacyTargetStatePreservesRawAndHiddenRowsAndMalformedStateCloses() {
        val saved = """{"type":"works.windmill.gym.ui.BuilderSheet.Target","exerciseId":"chin-up","rows":[{"reps":"8","weight":"−10"},{"reps":"six","weight":"25..5"}],"sets":"1"}"""
        val expected = BuilderSheet.Target("chin-up", TargetEntry.Draft(
            rows = listOf(TargetEntry.TypedSet("8", "−10"), TargetEntry.TypedSet("six", "25..5")),
            sets = "1", varyBySet = true,
        ))
        assertEquals(expected, builderSheetSaver.restore(saved))
        assertEquals(TargetEntry.Reading.Scheme(listOf(SetTarget(8, -10.0))), expected.scheme.reading)
        assertEquals(TargetEntry.Reading.Refused(1, TargetEntry.Field.Reps, TargetEntry.notANumber),
            (builderSheetSaver.restore(saved) as BuilderSheet.Target).scheme.withCount("2").reading)
        assertNull(builderSheetSaver.restore("""{"type":"works.windmill.gym.ui.BuilderSheet.Target","exerciseId":"chin-up","rows":42,"sets":"1"}"""))
        assertNull(builderSheetSaver.restore("not json"))
        assertNull(builderSheetSaver.restore(""))
    }

}
