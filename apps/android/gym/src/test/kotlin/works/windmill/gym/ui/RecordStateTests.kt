package works.windmill.gym.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.coroutines.*
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
class RecordStateTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private val movement = Exercise("bench-press", "Bench Press", "press", "barbell", 2.5)

    // Signed in, with the account's log read once and nothing logged on it.
    private fun store(room: EngineRoomFixture): TrainingStore {
        runBlocking { room.select("a"); room.pull(EngineRoomFixture.server()); room.store.refreshEngine() }
        return room.store
    }

    @Test
    fun initialReadIsHonestAndRenameKeepsOverlongDraftWithoutInventingARecord() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            compose.setContent { GymMaterial { RecordScreen(movement.id, store, "Log", {}) } }
            compose.onNodeWithText("Nothing logged for this movement yet. The first set you log lands here.").assertIsDisplayed()
            compose.onNodeWithText("Rename").performClick()
            compose.onNode(hasSetTextAction()).performTextReplacement("N".repeat(61))
            compose.onNodeWithText("61/60").assertIsDisplayed()
            compose.onNode(hasText("Rename") and hasAnyAncestor(isDialog())).assertIsNotEnabled()
            compose.onNodeWithText("Old name: Bench Press\nSearchable as an alias.").assertExists()
            assertEquals(listOf(movement), store.catalog.filter { it.id == movement.id })
            assertEquals(listOf(movement), room.training.catalogue().filter { it.id == movement.id })
        } } finally { scope.cancel() }
    }

    // The rename is one local commit, so the sheet comes down on the name the replica now holds.
    @Test
    fun aRenameShowsOnlyTheNameTheReplicaHolds() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            val renamed = movement.copy(name = "Paused Bench", aliases = listOf("Bench Press"))
            compose.setContent { GymMaterial { RecordScreen(movement.id, store, "Log", {}) } }
            compose.onNodeWithText("Rename").performClick()
            compose.onNode(hasSetTextAction()).performTextReplacement("Paused Bench")
            compose.onNode(hasText("Rename") and hasAnyAncestor(isDialog())).performClick()
            compose.onNodeWithText("Paused Bench").assertIsDisplayed()
            compose.onNodeWithText("Rename movement").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(listOf(renamed), store.catalog.filter { it.id == movement.id })
                assertEquals(listOf(renamed), room.training.catalogue().filter { it.id == movement.id })
            }
        } } finally { scope.cancel() }
    }
}
