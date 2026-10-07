package works.windmill.gym.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.GymRoom
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutineSheetTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun routinePlanOpensOverTheListAndEditsWithoutAnyHistoryRead() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val entries = listOf(
                RoutineEntry(1, "bench-press", List(3) { SetTarget(8, 50.0) }),
                RoutineEntry(2, "barbell-row", List(3) { SetTarget(10, 40.0) }),
            )
            val server = EngineRoomFixture.server()
            // The routine and a workout on it are the account's, written on another phone under its own ids.
            EngineRoomFixture(tmp.newFolder(), scope).use { other -> runBlocking {
                other.select("u1"); other.pull(server)
                assertTrue(other.store.saveRoutine(RoutineDraft(name = "Push Day", entries = entries, creationId = "routine_push")) is GymResult.Ok)
                other.training.startSession(SessionStart("remote01", other.now - 10_000, routineId = "routine_push"))
                other.training.appendSet("remote01", SetWrite("remoteset", "bench-press", 50.0, 8, SetKind.Working, other.now - 9_000))
                other.training.finishSession("remote01", other.now)
                other.sync(server)
            } }
            runBlocking { room.select("u1"); room.pull(server); room.store.refreshEngine() }
            assertNotNull("the routine has been trained", room.store.routine("routine_push")!!.lastTrainedAtMs)
            val store = room.store
            // The room comes down before the engine closes: its lifecycle watcher writes on pause.
            val visible = mutableStateOf(true)
            compose.setContent { if (visible.value) GymMaterial { GymRoom(room.account(), store) } }
            try {
                compose.onNodeWithText("Bench Press · Barbell Row").assertIsDisplayed()
                compose.onNodeWithText("Push Day").performClick()
                compose.onNodeWithTag("routine-sheet").assertIsDisplayed()
                compose.onAllNodesWithText("Push Day").assertCountEquals(2)
                compose.onNodeWithText("New routine").assertExists()
                compose.onNodeWithText("3 × 8 · 50 kg").assertIsDisplayed()
                compose.onNodeWithText("3 × 10 · 40 kg").assertIsDisplayed()
                compose.onNodeWithText("History").assertDoesNotExist()
                compose.onNodeWithText("Last trained", substring = true).assertDoesNotExist()
                compose.onNodeWithText("Rest 1:30").assertDoesNotExist()
                compose.onNodeWithText("Edit routine").performClick()
                compose.onNodeWithTag("routine-sheet").assertDoesNotExist()
                compose.onNodeWithContentDescription("Routine name").assertTextEquals("Push Day")
                compose.onNodeWithText("Recent changes").assertDoesNotExist()
                compose.onNodeWithText("3 × 8 · 50kg").assertIsDisplayed()
                compose.onNodeWithText("3 × 10 · 40kg").assertIsDisplayed()
                compose.onNodeWithContentDescription("Routine name").performTextReplacement("Push A")
                compose.onNodeWithText("Save").performClick()
                compose.onNodeWithTag("routine-sheet").assertIsDisplayed()
                compose.onAllNodesWithText("Push A").assertCountEquals(2)
                compose.runOnIdle {
                    val saved = room.training.program().single { it.id == "routine_push" }
                    assertEquals("Push A", saved.name)
                    assertEquals(entries, saved.entries)
                }

                compose.onNodeWithContentDescription("Close sheet").performClick()
                compose.onNodeWithTag("routine-sheet").assertDoesNotExist()
                compose.onNodeWithText("Push A").assertIsDisplayed().performClick()
                compose.onNodeWithText("Start workout").performClick()
                compose.onNodeWithTag("routine-sheet").assertDoesNotExist()
                compose.runOnIdle { assertEquals("routine_push", store.session?.routineId) }
            } finally { compose.runOnIdle { visible.value = false }; compose.waitForIdle() }
        } } finally { scope.cancel() }
    }
}
