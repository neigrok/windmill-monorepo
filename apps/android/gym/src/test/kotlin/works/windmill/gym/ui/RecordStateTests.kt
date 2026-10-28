package works.windmill.gym.ui

import androidx.compose.runtime.*
import androidx.compose.ui.semantics.SemanticsProperties
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
        runBlocking { room.select("a"); room.pull(EngineRoomFixture.server()); room.store.refreshEngine(); room.store.observeEngine() }
        return room.store
    }

    @Test
    fun initialReadIsHonestAndEditingKeepsTheWholeInvalidDraftWithoutInventingARecord() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            compose.setContent { GymMaterial { RecordScreen(movement.id, store, "The log", {}) } }
            compose.onNodeWithText("Nothing logged for this movement yet. The first set you log lands here.").assertIsDisplayed()
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Edit movement").performClick()
            compose.onNodeWithContentDescription("Movement name").performTextReplacement("N".repeat(61))
            compose.onNodeWithContentDescription("Movement name").assertTextContains("N".repeat(61))
            compose.onNodeWithText("Use 60 characters or fewer.").assertIsDisplayed()
            compose.onNodeWithText("Save").assertIsNotEnabled()
            compose.onNodeWithText("Old name: Bench Press\nSearchable as an alias.").assertDoesNotExist()
            assertEquals(listOf(movement), store.catalog.filter { it.id == movement.id })
            assertEquals(listOf(movement), room.training.catalogue().filter { it.id == movement.id })
        } } finally { scope.cancel() }
    }

    // The rename is one local commit, so the sheet comes down on the name the replica now holds.
    @Test
    fun anEditShowsTheAcceptedNameAndTheObserverRefreshesTheCatalogue() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            val renamed = movement.copy(name = "Paused Bench", aliases = listOf("Bench Press"))
            compose.setContent { GymMaterial { RecordScreen(movement.id, store, "The log", {}) } }
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Edit movement").performClick()
            compose.onNodeWithContentDescription("Movement name").performTextReplacement("Paused Bench")
            compose.onNodeWithText("Save").performClick()
            compose.onNodeWithText("Paused Bench").assertIsDisplayed()
            compose.onNodeWithText("Edit movement").assertDoesNotExist()
            compose.waitUntil(5_000) { store.catalog.single { it.id == movement.id } == renamed }
            compose.runOnIdle {
                assertEquals(listOf(renamed), store.catalog.filter { it.id == movement.id })
                assertEquals(listOf(renamed), room.training.catalogue().filter { it.id == movement.id })
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun aLaterWeakerWorkoutDoesNotReplaceTheDailyChartReadoutOrGainAnInspectionRing() {
        val now = java.time.Instant.parse("2026-10-22T15:00:00Z").toEpochMilli()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking {
                room.now = now
                room.select(null)
                for ((index, days) in listOf(28, 21, 14, 0, 0).withIndex()) {
                    val at = now - days * 86_400_000L - if (index == 4) 1_800_000 else 3_600_000
                    val id = "workout$index"
                    room.training.startSession(SessionStart(id, at))
                    room.training.appendSet(id, SetWrite("set$index", "bench-press", if (index == 4) 85.0 else 60.0 + index * 10, 1, at + 1_000))
                    room.training.finishSession(id, at + 60_000)
                }
                room.store.refreshEngine()
            }
            var focus by mutableStateOf<String?>(null)
            compose.setContent { GymMaterial { RecordScreen("bench-press", room.store, "The log", {},
                focusSessionId = focus, now = { now }) } }
            compose.onNodeWithText("90 kg est · today · 90 × 1").assertIsDisplayed()
            compose.onNodeWithText("85 kg est · today · 85 × 1").assertDoesNotExist()
            val winner = compose.onNodeWithContentDescription("90 kg est · today · 90 × 1, standing best", useUnmergedTree = true)
            winner.assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
            compose.runOnIdle { focus = "workout4" }
            winner.assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
            compose.onNodeWithText("90 kg est · today · 90 × 1").assertIsDisplayed()
            compose.runOnIdle { focus = "workout3" }
            winner.assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
            compose.runOnIdle { assertEquals((0..4).map { "workout$it" }, room.store.progress!!.sessions.map { it.sessionId }) }
        } } finally { scope.cancel() }
    }
}
