package works.windmill.gym

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
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
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.LocalShellActions
import works.windmill.platform.ShellActions

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class WorkoutTileRoutingTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun signedOutRoutinesRequestReturnsFromTabsWithoutStartingOrDiscardingAnEditor() {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail("Unexpected $operation") }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val room = EngineRoomFixture(temporary.newFolder(), scope, telemetry = telemetry)
        runBlocking { room.select(null) }
        val account = room.account()
        val shell = ShellActions(openYou = {})
        var shown by mutableStateOf(true)
        val restored = StateRestorationTester(compose)
        restored.setContent {
            if (shown) CompositionLocalProvider(LocalTelemetry provides telemetry, LocalShellActions provides shell) {
                GymMaterial { GymRoom(account, room.store) }
            }
        }
        try {
            for (tab in listOf("The log", "Coach")) {
                compose.onNode(hasText(tab) and hasClickAction()).performClick()
                compose.runOnIdle { room.store.requestRoutines() }
                compose.onNodeWithContentDescription("New routine").assertIsDisplayed()
            }
            compose.runOnIdle { shell.destinations.single { it.id == "notes" }.onOpen() }
            compose.onNodeWithText("Notes").assertIsDisplayed()
            compose.runOnIdle { room.store.requestRoutines() }
            compose.onNodeWithContentDescription("New routine").assertIsDisplayed()
            compose.onNodeWithContentDescription("New routine").performClick()
            compose.onNode(hasSetTextAction()).performTextInput("Unfinished routine")
            compose.runOnIdle { room.store.requestRoutines() }
            compose.onNodeWithText("Unfinished routine").assertIsDisplayed()
            compose.onNodeWithContentDescription("Back to the routine you were on").assertIsDisplayed()
            restored.emulateSavedInstanceStateRestore()
            compose.onNodeWithText("Unfinished routine").assertIsDisplayed()
            compose.onNodeWithContentDescription("Back to the routine you were on").assertIsDisplayed()
            compose.runOnIdle {
                assertNull(room.store.session)
                assertTrue(room.store.routines.isEmpty())
                assertEquals(emptyList<Pair<String, Map<String, String>>>(), events.filter { it.first == "gym_session_started" })
                assertEquals(listOf("routines", "log", "routines", "coach", "routines", "notes", "routines", "routine_editor", "routine_editor"),
                    events.filter { it.first == "gym_screen_viewed" }.map { it.second["screen"] })
            }
        } finally {
            compose.runOnIdle { shown = false }
            compose.waitForIdle()
            room.close()
            scope.cancel()
        }
    }

    @Test
    fun aHistoricalSetDraftSurvivesTheTileRequestAndRecreationWithoutSaving() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val room = EngineRoomFixture(temporary.newFolder(), scope).apply { now = 1_700_000_000_000L }
        runBlocking {
            room.select(null)
            val routine = (room.store.saveRoutine(works.windmill.gym.domain.RoutineDraft(name = "Push A")
                .adding("bench-press")) as works.windmill.gym.store.GymResult.Ok).value
            room.store.start(routine.id)
            room.store.choose("bench-press")
            room.store.logSet(40.0, 8)
            room.now += 60_000
            room.store.finish()
        }
        val before = room.training.details()
        val account = room.account()
        var shown by mutableStateOf(true)
        val restored = StateRestorationTester(compose)
        restored.setContent { if (shown) GymMaterial { GymRoom(account, room.store) } }
        try {
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            compose.onNodeWithText("Push A").performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("40 × 8")).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("40 × 8").performClick()
            compose.onNodeWithText("Set note").performTextInput("Unfinished set note")
            compose.runOnIdle { room.store.requestRoutines() }
            compose.onNodeWithText("Bench Press · Set 1").assertIsDisplayed()
            compose.onNodeWithText("Unfinished set note").assertIsDisplayed()
            restored.emulateSavedInstanceStateRestore()
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("Unfinished set note")).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Bench Press · Set 1").assertIsDisplayed()
            compose.onNodeWithText("Unfinished set note").assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(0L, room.store.routinesOpenRequest)
                assertNull(room.store.session)
                assertEquals(before, room.training.details())
            }
        } finally {
            compose.runOnIdle { shown = false }
            compose.waitForIdle()
            room.close()
            scope.cancel()
        }
    }

    @Test
    fun coldRoutinesRequestIsConsumedWithoutCreatingAWorkout() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val room = EngineRoomFixture(temporary.newFolder(), scope)
        runBlocking { room.select(null) }
        room.store.requestRoutines()
        val account = room.account()
        var shown by mutableStateOf(true)
        val restored = StateRestorationTester(compose)
        restored.setContent { if (shown) GymMaterial { GymRoom(account, room.store) } }
        try {
            compose.onNodeWithContentDescription("New routine").assertIsDisplayed()
            compose.runOnIdle { assertEquals(0L, room.store.routinesOpenRequest) }
            compose.onNode(hasText("Coach") and hasClickAction()).performClick()
            restored.emulateSavedInstanceStateRestore()
            compose.onNode(hasText("Coach") and hasClickAction()).assertIsSelected()
            compose.runOnIdle { assertNull(room.store.session); assertTrue(room.store.routines.isEmpty()) }
        } finally {
            compose.runOnIdle { shown = false }
            compose.waitForIdle()
            room.close()
            scope.cancel()
        }
    }
}
