package works.windmill.gym.ui

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import kotlinx.coroutines.CompletableDeferred
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
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import works.windmill.gym.presentation.*
import works.windmill.gym.store.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class PlanningRestorationTests {
    private lateinit var contentView: View

    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test fun aLineTheEditorLeavesAloneKeepsItsLoadAndATouchedOneMeetsTheFloor() {
        val bench = Exercise("bench-press", "Bench Press", "press", "barbell", 2.5)
        val legacy = TargetEntry.Draft(listOf(SetTarget(8, -10.0)))
        val opened = BuilderSheet.Target("bench-press", legacy, RoutineMovement(bench, bench))
        assertEquals(listOf<Double?>(null, 0.0, 0.0, 0.0), listOf(
            opened.floor(RoutineMovement(bench, bench)),
            opened.copy(scheme = legacy.copy(rows = listOf(TargetEntry.TypedSet("6", "−10")))).floor(RoutineMovement(bench, bench)),
            opened.floor(RoutineMovement(bench, bench.copy(equipment = "dumbbell", loadCount = 2))),
            opened.copy(adding = true).floor(RoutineMovement(bench, bench)),
        ))
        assertEquals(TargetEntry.Reading.Scheme(listOf(SetTarget(8, -10.0))), legacy.reading(opened.floor(RoutineMovement(bench, bench))))
    }

    // Signed out: the anonymous replica's store.
    private fun store(room: EngineRoomFixture): TrainingStore {
        runBlocking { room.select(null) }
        return room.store
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

    private fun uniformTargets() {
        if (compose.onAllNodesWithContentDescription("Sets").fetchSemanticsNodes().isEmpty())
            compose.onNodeWithText("Vary by set").performScrollTo().performClick()
    }

    private fun perSetTargets() {
        if (compose.onAllNodesWithContentDescription("Set 1 reps").fetchSemanticsNodes().isEmpty())
            compose.onNodeWithText("Vary by set").performScrollTo().performClick()
    }

    private fun raw(description: String) = compose.onNodeWithContentDescription(description).fetchSemanticsNode()
        .config[SemanticsProperties.EditableText].text

    @Test
    fun builderRestoresRawInvalidAndHiddenTargetRowsButDiscardLeavesTheRoutineUntouched() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            val original = RoutineDraft(name = "Push").adding("bench-press")
                .targeting("bench-press", listOf(SetTarget(8, 60.0), SetTarget(6, 65.0), SetTarget(4, 70.0)))
            var draft by mutableStateOf(original)
            val restorer = StateRestorationTester(compose)
            restorer.setContent {
                contentView = LocalView.current
                RoutineBuilder(draft, store, false, { draft = it }, {}, {}, {}, "Routines")
            }
            compose.onNodeWithText("Bench Press").performClick()
            compose.onNodeWithContentDescription("Set 3 load").performTextReplacement("1e999")
            uniformTargets()
            compose.onNodeWithContentDescription("Sets").performTextReplacement("1")
            perSetTargets()
            compose.onNodeWithContentDescription("Set 1 reps").performTextReplacement("0")
            restorer.emulateSavedInstanceStateRestore()
            hideSearchIme()
            assertEquals("0", raw("Set 1 reps"))
            uniformTargets()
            assertEquals("1", raw("Sets"))
            compose.onNodeWithContentDescription("Sets").performTextReplacement("3")
            perSetTargets()
            assertEquals("1e999", raw("Set 3 load"))
            compose.onNodeWithText("Done").assertIsNotEnabled()
            compose.onNodeWithText("Cancel").performScrollTo().performClick()
            compose.onNodeWithText("Discard changes?").assertIsDisplayed()
            compose.onNodeWithText("Discard").performClick()
            compose.waitForIdle()
            assertEquals(original, draft)
            compose.onNodeWithText("Bench Press").performClick()
            assertEquals("70", raw("Set 3 load"))
        } } finally { scope.cancel() }
    }

    @Test
    fun routineCreationRestoresTheCombinedFormAndOnlyStagesAfterAdd() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            var draft by mutableStateOf(RoutineDraft(name = "Push"))
            val before = room.engine.snapshot()
            val restorer = StateRestorationTester(compose)
            restorer.setContent {
                contentView = LocalView.current
                RoutineBuilder(draft, store, false, { draft = it }, {}, {}, {}, "Routines")
            }
            compose.onNodeWithText("Add movement").performClick()
            compose.onNode(hasSetTextAction() and hasText("Search movements")).performTextReplacement("Zercher")
            compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
            hideSearchIme()
            compose.onNodeWithContentDescription("Movement name").performTextReplacement("Zercher 🏋 carry")
            compose.onNodeWithContentDescription("Equipment").performClick()
            compose.onNodeWithText("Dumbbells").performClick()
            restorer.emulateSavedInstanceStateRestore()
            hideSearchIme()
            assertEquals("Zercher 🏋 carry", raw("Movement name"))
            compose.onNodeWithText("Dumbbells").assertIsDisplayed()
            compose.onNodeWithText("Cancel").performScrollTo().performClick()
            compose.onNodeWithText("Discard").performClick()
            compose.onNode(hasSetTextAction() and hasText("Zercher")).assertIsDisplayed()
            assertEquals(RoutineDraft(name = "Push"), draft)
            assertEquals(before, room.engine.snapshot())
            compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
            hideSearchIme()
            assertEquals("Zercher", raw("Movement name"))
            compose.onNodeWithContentDescription("Movement name").performTextReplacement("Zercher 🏋 carry")
            compose.onNodeWithContentDescription("Equipment").performClick()
            compose.onNodeWithText("Dumbbells").performClick()
            compose.onNodeWithText("Add").performClick()
            compose.waitForIdle()
            val movement = draft.movements.single()
            assertNull(movement.base)
            assertEquals("Zercher 🏋 carry", movement.current.name)
            assertEquals("dumbbell", movement.current.equipment)
            assertEquals(2, movement.current.loadCount)
            assertEquals(listOf(RoutineEntry(1, movement.current.id, List(3) { SetTarget(10) })), draft.entries)
            assertEquals(emptyList<Exercise>(), store.catalog.filter { it.custom })
            assertEquals(before, room.engine.snapshot())
        } } finally { scope.cancel() }
    }

    @Test
    fun externalWorkoutRestoresItsCreateRouteAndAddsToTheInvokingWorkout() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            runBlocking { room.startExternalWorkout() }
            val session = store.session!!.id
            val restorer = StateRestorationTester(compose)
            restorer.setContent {
                contentView = LocalView.current
                LoggerScreen(store, {}, {})
            }
            compose.onNode(hasSetTextAction()).performTextReplacement("Carry")
            compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
            hideSearchIme()
            compose.onNodeWithContentDescription("Movement name").performTextReplacement("Farmer carry")
            compose.onNodeWithContentDescription("Equipment").performClick()
            compose.onNodeWithText("Dumbbells").performClick()
            restorer.emulateSavedInstanceStateRestore()
            hideSearchIme()
            assertEquals("Farmer carry", raw("Movement name"))
            compose.onNodeWithText("Dumbbells").assertIsDisplayed()
            compose.onNodeWithText("Create and add").performClick()
            compose.waitForIdle()
            assertEquals(session, store.session?.id)
            val exercise = store.catalog.single { it.custom }
            assertEquals("Farmer carry", exercise.name)
            assertEquals("dumbbell", exercise.equipment)
            assertEquals(listOf(exercise.id), store.order)
            assertEquals(exercise.id, store.exerciseId)
        } } finally { scope.cancel() }
    }

    @Test
    fun deferredCreateRejectsSecondTapAndRestorationReleasesBusyWithoutChangingTheRequestIdentity() {
        val restorer = StateRestorationTester(compose)
        val first = CompletableDeferred<MovementCreateOutcome>()
        val calls = mutableListOf<ExerciseWrite>()
        val picked = mutableListOf<String>()
        restorer.setContent {
            contentView = LocalView.current
            MovementPicker(catalog = TheSix.movements, taken = emptyList(), lastSets = null,
                nowMs = 0, title = "Add movement", onPick = { picked += it },
                onCreate = { write ->
                    calls += write
                    if (calls.size == 1) first.await()
                    else MovementCreateOutcome.Failed(WriteFailure.Refused("That name needs checking"))
                })
        }
        compose.onNode(hasSetTextAction()).performTextReplacement("Zercher")
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        hideSearchIme()
        compose.onNodeWithContentDescription("Equipment").performClick()
        compose.onNodeWithText("Dumbbells").performClick()
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
        assertEquals("Zercher", raw("Movement name"))
        compose.onNodeWithText("Dumbbells").assertIsDisplayed()
        assertEquals(emptyList<String>(), picked)
    }
    @Test
    fun openBodyweightTargetsRestoreTheHiddenAssistedLoadsWithoutAnAppSignControl() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            val original = RoutineDraft(name = "Pull").adding("chin-up")
                .targeting("chin-up", listOf(SetTarget(8, -10.0), SetTarget(6, -5.0)))
            var draft by mutableStateOf(original)
            val restorer = StateRestorationTester(compose)
            restorer.setContent {
                contentView = LocalView.current
                RoutineBuilder(draft, store, false, { draft = it }, {}, {}, {}, "Routines")
            }
            compose.onNodeWithText("Chin Up").performClick()
            uniformTargets()
            compose.onNodeWithContentDescription("Sets").performTextReplacement("")
            compose.onAllNodesWithContentDescription("Flip the sign — band-assisted").assertCountEquals(0)
            compose.onNodeWithContentDescription("Load, kg added").assertIsNotEnabled()
            restorer.emulateSavedInstanceStateRestore()
            hideSearchIme()
            assertEquals("", raw("Sets"))
            compose.onNodeWithContentDescription("Load, kg added").assertIsNotEnabled()
            compose.onNodeWithContentDescription("Sets").performTextReplacement("2")
            perSetTargets()
            assertEquals("−10", raw("Set 1 load"))
            assertEquals("−5", raw("Set 2 load"))
            compose.onNodeWithText("Cancel").performScrollTo().performClick()
            assertEquals(original, draft)
        } } finally { scope.cancel() }
    }

    @Test
    fun selectedMovementsStayVisibleButCannotBeAddedTwice() {
        val picked = mutableListOf<String>()
        compose.setContent {
            contentView = LocalView.current
            MovementPicker(catalog = TheSix.movements, taken = listOf("bench-press"), lastSets = null,
                nowMs = 0, title = "Add movement", onPick = { picked += it },
                onCreate = { _ -> error("no creation") })
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
                onCreate = { _ -> error("no creation") })
        }
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        hideSearchIme()
        compose.onNodeWithContentDescription("Movement name").performTextReplacement("Ring Row")
        compose.onNodeWithContentDescription("Equipment").performClick()
        compose.onNodeWithText("Other").performClick()
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
        assertEquals("Ring Row", raw("Movement name"))
        compose.onNodeWithText("Other").assertIsDisplayed()
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
        assertEquals(TargetEntry.Reading.Scheme(listOf(SetTarget(8, -10.0))), expected.scheme.reading(null))
        assertEquals(TargetEntry.Reading.Refused(1, TargetEntry.Field.Reps, TargetEntry.notANumber),
            (builderSheetSaver.restore(saved) as BuilderSheet.Target).scheme.withCount("2").reading(null))
        assertNull(builderSheetSaver.restore("""{"type":"works.windmill.gym.ui.BuilderSheet.Target","exerciseId":"chin-up","rows":42,"sets":"1"}"""))
        assertNull(builderSheetSaver.restore("not json"))
        assertNull(builderSheetSaver.restore(""))
    }

}
