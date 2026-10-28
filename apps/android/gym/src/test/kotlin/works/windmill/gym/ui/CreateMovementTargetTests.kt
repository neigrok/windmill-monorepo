package works.windmill.gym.ui

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import androidx.compose.ui.platform.LocalView
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.robolectric.shadows.ShadowDialog
import androidx.compose.runtime.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
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
import works.windmill.gym.domain.*
import works.windmill.gym.store.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class CreateMovementTargetTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun raw(description: String) = compose.onNodeWithContentDescription(description).fetchSemanticsNode()
        .config[SemanticsProperties.EditableText].text

    @Test fun aBusyStagingFormKeepsAddOrDoneAndDoesNotSave() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking { room.select(null) }
            val before = room.engine.snapshot()
            val movement = room.store.catalog.first { it.id == "bench-press" }
            var label by mutableStateOf("Add")
            var commits = 0
            compose.setContent { GymMaterial {
                MovementForm(RoutineMovement(movement, movement), TargetEntry.Draft(), "Edit movement", label,
                    {}, {}, {}, { commits++ }, busy = true)
            } }
            for (next in listOf("Add", "Done")) {
                compose.runOnIdle { label = next }
                compose.onNodeWithText(next).assertIsNotEnabled().performClick()
                compose.onNodeWithText("Saving…").assertDoesNotExist()
            }
            assertEquals(0, commits)
            assertEquals(before, room.engine.snapshot())
        } } finally { scope.cancel() }
    }

    @Test fun perSetLoadsShareAtomicSeparatorEditingAndKeepNegativeCaretAndZero() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking { room.select(null) }
            var draft by mutableStateOf(RoutineDraft(name = "Push").adding("bench-press",
                List(3) { SetTarget(8, 75.0) }))
            val before = room.engine.snapshot()
            compose.setContent { GymMaterial { RoutineBuilder(draft, room.store, false, { draft = it }, {}, {}, {}) } }
            compose.onNodeWithText("Bench Press").performClick()
            compose.onNodeWithText("Vary by set").performScrollTo().performClick()
            val field = compose.onNodeWithContentDescription("Set 1 load")
            fun assertEditor(text: String, caret: Int) {
                assertEquals(text, raw("Set 1 load"))
                assertEquals(TextRange(caret), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
            }
            field.performClick().performTextClearance()
            field.performTextInput("-")
            assertEditor("-", 1)
            compose.onNodeWithText("Done").assertIsNotEnabled()
            field.performTextInput("12.5")
            assertEditor("-12.5", 5)
            for (separator in listOf(".", ",")) {
                field.performSemanticsAction(SemanticsActions.SetSelection) { it(2, 2, false) }
                field.performTextInput(separator)
                assertEditor("-12.5", 2)
            }
            for (separator in listOf(",", ".")) {
                field.performSemanticsAction(SemanticsActions.SetSelection) { it(3, 4, false) }
                field.performTextInput(separator)
                assertEditor("-12${separator}5", 4)
            }
            field.performSemanticsAction(SemanticsActions.SetSelection) { it(1, 4, false) }
            field.performTextInput("3.")
            assertEditor("-3.5", 3)
            field.performTextReplacement("1.2,3")
            assertEditor("-3.5", 3)
            field.performTextReplacement("0")
            assertEditor("0", 1)
            compose.onNodeWithText("Done").assertIsEnabled().performClick()
            assertEquals(listOf(SetTarget(8, 0.0), SetTarget(8, 75.0), SetTarget(8, 75.0)), draft.entries.single().sets)
            assertEquals(before, room.engine.snapshot())
        } } finally { scope.cancel() }
    }

    @Test fun createRestoresItsRawTargetAndOnlyStagesBeforeTheOuterSave() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking { room.select(null) }
            var draft by mutableStateOf(RoutineDraft(name = "Pull"))
            val changes = mutableListOf<RoutineDraft>()
            val before = room.engine.snapshot()
            val restorer = StateRestorationTester(compose)
            restorer.setContent { GymMaterial {
                RoutineBuilder(draft, room.store, false, { draft = it; changes += it }, {}, {}, {})
            } }
            compose.onNodeWithText("Add movement").performClick()
            compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
            compose.onNodeWithContentDescription("Movement name").performTextReplacement("Meadows 🏋 row")
            assertEquals("3", raw("Sets, sets"))
            assertEquals("10", raw("Reps, reps"))
            assertEquals("", raw("Load, kg total"))
            compose.onNodeWithContentDescription("Load, kg total").performTextReplacement("1e999")
            compose.onNodeWithText("Add").assertIsNotEnabled()
            restorer.emulateSavedInstanceStateRestore()
            assertEquals("Meadows 🏋 row", raw("Movement name"))
            assertEquals("1e999", raw("Load, kg total"))
            compose.onNodeWithContentDescription("Load, kg total").performTextReplacement("25")
            compose.onNodeWithContentDescription("Increase Reps").performClick()
            compose.onNodeWithText("Add").performClick()
            compose.waitForIdle()
            val movement = draft.movements.single()
            assertNull(movement.base)
            assertEquals("Meadows 🏋 row", movement.current.name)
            val uniform = RoutineDraft(name = "Pull").staging(movement,
                TargetEntry.Reading.Scheme(List(3) { SetTarget(11, 25.0) }))
            assertEquals(listOf(uniform), changes)
            assertEquals(before, room.engine.snapshot())
            assertEquals(emptyList<Exercise>(), room.store.catalog.filter { it.custom })
            compose.onNodeWithText("Meadows 🏋 row").performClick()
            compose.onNodeWithText("Vary by set").performScrollTo().performClick()
            compose.onNodeWithContentDescription("Set 1 load").performTextReplacement("20")
            compose.onNodeWithContentDescription("Set 3 load").performTextReplacement("30")
            compose.onNodeWithText("Ramp up").performScrollTo().performClick()
            compose.onNodeWithText("Done").performClick()
            val varied = uniform.staging(movement, TargetEntry.Reading.Scheme(
                listOf(SetTarget(11, 20.0), SetTarget(11, 25.0), SetTarget(11, 30.0))))
            assertEquals(listOf(uniform, varied), changes)
            assertEquals(varied, draft)
            assertEquals(before, room.engine.snapshot())
        } } finally { scope.cancel() }
    }

    @Test fun aQueuedSecondAddStagesOnlyOnceAndNeverCreatesCatalogueData() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking { room.select(null) }
            var draft by mutableStateOf(RoutineDraft(name = "Pull"))
            val changes = mutableListOf<RoutineDraft>()
            val before = room.engine.snapshot()
            compose.setContent { GymMaterial {
                RoutineBuilder(draft, room.store, false, { draft = it; changes += it }, {}, {}, {})
            } }
            compose.onNodeWithText("Add movement").performClick()
            compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
            compose.onNodeWithContentDescription("Movement name").performTextReplacement("Staged only")
            val submit = compose.onNodeWithText("Add").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
            compose.runOnIdle { submit(); submit() }
            compose.waitForIdle()
            assertEquals(listOf(draft), changes)
            assertEquals(listOf("Staged only"), draft.movements.map { it.current.name })
            assertEquals(emptyList<Exercise>(), room.store.catalog.filter { it.custom })
            assertEquals(before, room.engine.snapshot())
        } } finally { scope.cancel() }
    }

    @Test fun aPendingLiveCreateRejectsSecondTapAndRetainsItsIdentityAfterRefusal() {
        val pending = CompletableDeferred<GymResult<Exercise>>()
        val calls = mutableListOf<ExerciseWrite>()
        val picked = mutableListOf<String>()
        val exercise = Exercise("ex_pending", "Cable row", Exercise.unclassified, "barbell", custom = true)
        val state = MovementPickerState(createName = exercise.name, requestId = exercise.id)
        lateinit var view: View
        compose.setContent { GymMaterial {
            view = LocalView.current
            MovementPicker(TheSix.movements, emptyList(), null, 0, "Add movement", onPick = { picked += it },
                onCreate = { name, equipment, id ->
                    calls += ExerciseWrite(id, name, Exercise.unclassified, equipment)
                    if (calls.size == 1) pending.await() else GymResult.Ok(exercise)
                }, state = state)
        } }
        compose.onNode(hasText("Create movement") and hasClickAction()).performClick()
        val hidden = WindowInsets.Builder().setInsets(WindowInsets.Type.ime(), Insets.NONE)
            .setVisible(WindowInsets.Type.ime(), false).build()
        compose.runOnIdle {
            view.dispatchApplyWindowInsets(hidden)
            ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .forEach { it.window.decorView.dispatchApplyWindowInsets(hidden) }
            ShadowDialog.getShownDialogs().filter { it.isShowing }
                .forEach { it.window!!.decorView.dispatchApplyWindowInsets(hidden) }
        }
        compose.mainClock.advanceTimeBy(64)
        compose.waitForIdle()
        val submit = compose.onNodeWithText("Create and add").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnIdle { submit(); submit() }
        compose.onNodeWithText("Creating…").assertIsNotEnabled()
        assertEquals(listOf(ExerciseWrite(exercise.id, exercise.name, Exercise.unclassified, "barbell")), calls)
        assertEquals(emptyList<String>(), picked)
        compose.runOnIdle { pending.complete(GymResult.Failed(WriteFailure.Refused("Try again"))) }
        compose.onNodeWithText("Try again").assertIsDisplayed()
        compose.onNodeWithText("Create and add").assertIsEnabled().performClick()
        compose.waitForIdle()
        assertEquals(List(2) { ExerciseWrite(exercise.id, exercise.name, Exercise.unclassified, "barbell") }, calls)
        assertEquals(listOf(exercise.id), picked)
    }
}
