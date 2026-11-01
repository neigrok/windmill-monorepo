package works.windmill.gym.ui

import androidx.activity.ComponentDialog
import android.window.OnBackInvokedCallback
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.robolectric.shadows.ShadowDialog
import org.robolectric.util.ReflectionHelpers
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LoggerManagementTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun reusedAssemblyWindowRoutesNativeBackThroughPickerCancelThenClosesAssembly() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(temporary.newFolder(), scope)
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        try {
            runBlocking {
                room.select("owner")
                room.pull(EngineRoomFixture.server())
                room.startExternalWorkout()
                room.store.workout.choose("bench-press")
                room.store.workout.editRack(82.5, 8)
            }
            val session = room.store.workout.session
            compose.setContent { CompositionLocalProvider(LocalTelemetry provides telemetry) { LoggerScreen(room.store, {}, {}) } }
            compose.onNode(hasText("Bench Press") and hasClickAction()).performClick()
            compose.onNodeWithText("This workout").assertIsDisplayed()
            val dialog = ShadowDialog.getLatestDialog() as ComponentDialog
            compose.onNodeWithText("Add movement").performClick()
            compose.onNodeWithText("Cancel").assertIsDisplayed()
            assertSame(dialog, ShadowDialog.getLatestDialog())
            fun nativeBack() = compose.runOnIdle {
                val layout = ReflectionHelpers.getField<Any>(dialog, "dialogLayout")
                val callback = ReflectionHelpers.getField<Any?>(layout, "backCallback") as? OnBackInvokedCallback
                if (callback != null) callback.onBackInvoked() else dialog.onBackPressedDispatcher.onBackPressed()
            }
            nativeBack()
            compose.onNodeWithText("This workout").assertIsDisplayed()
            nativeBack()
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("This workout")).fetchSemanticsNodes().isEmpty() }
            compose.runOnIdle {
                assertEquals(session, room.store.workout.session)
                assertEquals(82.5, room.store.workout.rack!!.weightKg, 0.0)
                assertEquals(8, room.store.workout.rack!!.reps)
            }
            assertEquals(listOf("open_workout", "picker_open", "picker_cancel").map {
                "gym_action" to mapOf("screen" to "workout", "action" to it, "outcome" to "ok")
            }, events)
        } finally { scope.cancel(); room.close() }
    }

    @Test
    fun pickerCancelRecreationAndSelectionPreserveTheWorkoutAndEachRackDraft() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(temporary.newFolder(), scope)
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        try {
            runBlocking {
                room.select("owner")
                room.pull(EngineRoomFixture.server())
                room.startExternalWorkout()
                room.store.workout.choose("bench-press")
                room.store.workout.logSet(60.0, 5)
                room.store.workout.editRack(82.5, 8)
                room.store.workout.choose("barbell-row")
                room.store.workout.editRack(67.5, 9)
                room.store.workout.choose("bench-press")
            }
            val session = room.store.workout.session
            val sets = room.store.workout.sets
            val restoration = StateRestorationTester(compose)
            restoration.setContent { CompositionLocalProvider(LocalTelemetry provides telemetry) { LoggerScreen(room.store, {}, {}) } }
            compose.onNode(hasText("Bench Press") and hasClickAction()).performClick()
            compose.onNodeWithText("This workout").assertIsDisplayed()
            compose.onNodeWithText("Add movement").performClick()
            compose.onNodeWithText("Cancel").assertIsDisplayed()
            restoration.emulateSavedInstanceStateRestore()
            compose.onNodeWithText("Cancel").performClick()
            compose.onNodeWithText("This workout").assertIsDisplayed()
            compose.onAllNodes(hasText("Bench Press") and hasClickAction()).onLast().performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("This workout")).fetchSemanticsNodes().isEmpty() }
            compose.runOnIdle {
                assertEquals(session, room.store.workout.session)
                assertEquals(sets, room.store.workout.sets)
                assertEquals("bench-press", room.store.workout.exerciseId)
                assertEquals(82.5, room.store.workout.rack!!.weightKg, 0.0)
                assertEquals(8, room.store.workout.rack!!.reps)
            }
            compose.onNode(hasText("Bench Press") and hasClickAction()).performClick()
            compose.onNodeWithText("Add movement").performClick()
            compose.onNodeWithText("Cable Fly").performScrollTo().performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { room.store.workout.exerciseId == "cable-fly" } }
            compose.onNodeWithText("Log set").assertIsDisplayed()
            compose.onNode(hasText("Cable Fly") and hasClickAction()).performClick()
            compose.onNodeWithText("Barbell Row").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { room.store.workout.exerciseId == "barbell-row" } }
            compose.runOnIdle {
                assertEquals(session, room.store.workout.session)
                assertEquals(sets, room.store.workout.sets)
                assertEquals(listOf("bench-press", "barbell-row", "cable-fly"), room.store.workout.order)
                assertEquals(67.5, room.store.workout.rack!!.weightKg, 0.0)
                assertEquals(9, room.store.workout.rack!!.reps)
            }
            assertEquals(listOf("open_workout", "picker_open", "picker_cancel", "open_workout", "picker_open",
                "movement_switch", "picker_add", "open_workout", "movement_switch").map {
                "gym_action" to mapOf("screen" to "workout", "action" to it, "outcome" to "ok")
            }, events)
        } finally { scope.cancel(); room.close() }
    }
}
