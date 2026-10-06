package works.windmill.gym.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
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
import works.windmill.gym.GymRoom
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.store.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutineSaveTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun save(refused: Boolean) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val entries = listOf(RoutineEntry(1, "bench-press"), RoutineEntry(2, "back-squat"))
            val server = EngineRoomFixture.server()
            EngineRoomFixture(tmp.newFolder(), scope).use { other -> runBlocking {
                other.select("a"); other.pull(server)
                assertTrue(other.store.saveRoutine(RoutineDraft(name = "Push", entries = entries, creationId = "routine_push")) is GymResult.Ok)
                other.sync(server)
            } }
            runBlocking { room.select("a"); room.pull(server); room.store.refreshEngine() }
            val original = room.training.program().single()
            // The room comes down before the engine closes: its lifecycle watcher writes on pause.
            val visible = mutableStateOf(true)
            compose.setContent { if (visible.value) GymMaterial { GymRoom(room.account(), room.store) } }
            try {
                compose.onNodeWithText("Push").performClick()
                compose.onNodeWithText("Edit routine").performClick()
                compose.onNodeWithContentDescription("Routine name").performTextReplacement("Saved push")
                // Another phone moves the routine on while this draft stays open over the revision it read.
                val moved = if (!refused) null else EngineRoomFixture(tmp.newFolder(), scope).use { other -> runBlocking {
                    other.select("a"); other.pull(server)
                    val draft = RoutineDraft.of(other.training.program().single()).targeting("bench-press", List(3) { SetTarget(5, 100.0) })
                    assertTrue(other.store.saveRoutine(draft) is GymResult.Ok)
                    other.sync(server)
                    room.pull(server); room.store.refreshEngine()
                    room.training.program().single()
                } }
                compose.onNodeWithText("Save").performClick()
                compose.waitForIdle()
                if (refused) {
                    compose.onNodeWithContentDescription("Routine name").assertIsEnabled().assertTextEquals("Saved push")
                    compose.onNodeWithText("Save").assertIsEnabled()
                    compose.onNodeWithText("That routine changed. Open it again.").assertIsDisplayed()
                    compose.onNodeWithContentDescription("Routine name").performTextReplacement("Retry push")
                    compose.onNodeWithContentDescription("Routine name").assertTextEquals("Retry push")
                    assertEquals(Routine("routine_push", "Push", entries = listOf(RoutineEntry(1, "bench-press", List(3) { SetTarget(5, 100.0) }),
                        RoutineEntry(2, "back-squat")), revision = 2), moved)
                    assertEquals("the refused draft never reached the replica", moved, room.training.program().single())
                } else {
                    compose.onNodeWithContentDescription("Routine name").assertDoesNotExist()
                    compose.onAllNodesWithText("Saved push").assertCountEquals(2)
                    compose.onNode(hasText("Saved push") and hasAnyAncestor(hasTestTag("routine-sheet"))).assertIsDisplayed()
                    compose.runOnIdle { room.sync(server) }
                    assertEquals(original.copy(name = "Saved push", revision = 2), room.training.program().single())
                }
            } finally { compose.runOnIdle { visible.value = false }; compose.waitForIdle() }
        } } finally { scope.cancel() }
    }

    @Test fun aSavedDraftLandsOnTheLogAndTheSheetReadsIt() = save(refused = false)
    @Test fun aRefusedSaveKeepsTheSameRecoverableDraft() = save(refused = true)
}
