package works.windmill.gym.ui

import android.os.Looper
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.Notes
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.platform.design.WindmillMaterial
import works.windmill.sync.core.Json

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class EngineNotesScreenTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun show(room: EngineRoomFixture) {
        compose.setContent { WindmillMaterial { GymMaterial {
            NotesScreen(room.store, true, "Settings", {}, { _, _ -> }, {}, {})
        } } }
    }

    private fun waitForNotebook(room: EngineRoomFixture, condition: () -> Boolean) {
        try {
            compose.waitUntil(2_000) {
                shadowOf(Looper.getMainLooper()).idle()
                condition()
            }
        } catch (timeout: androidx.compose.ui.test.ComposeTimeoutException) {
            throw AssertionError("notesRead=${room.store.notesRead}; notes=${room.store.notes.map { it.id }}; " +
                "noteRefusals=${room.store.noteRefusals.size}; " +
                "noticeIds=${room.engine.notices("gym").notices.value.map { it.id }}", timeout)
        }
    }

    @Test fun anUnreadEngineNotebookDoesNotOfferAnEmptyNotebook() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking { room.select("A") }
            room.store.observeEngine()
            show(room)
            compose.onNodeWithText("Reading your notes…").assertIsDisplayed()
            compose.onNodeWithText(Notes.add).assertDoesNotExist()
            val server = EngineRoomFixture.server()
            compose.runOnIdle { room.pull(server) }
            waitForNotebook(room) { room.store.notesRead }
            compose.onNodeWithText(Notes.placeholders.first()).assertIsDisplayed()
            compose.onNodeWithText(Notes.add).assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test fun notesArrivingInTheFirstPullReplaceTheOpenScreensUnreadState() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking { room.select("A") }
            room.store.observeEngine()
            show(room)
            val server = EngineRoomFixture.server()
            EngineRoomFixture(tmp.newFolder(), scope).use { other -> runBlocking {
                other.select("A"); other.pull(server)
                assertTrue(other.store.saveNote("note0001", NoteWrite("Coach tone", "Be direct.")) is GymResult.Ok)
                other.sync(server)
            } }
            compose.runOnIdle { room.pull(server) }
            waitForNotebook(room) { room.store.notes.any { it.id == "note0001" } }
            compose.onNodeWithText("Coach tone").assertIsDisplayed()
            compose.runOnIdle { assertEquals(listOf("note0001"), room.store.notes.map { it.id }) }
        } } finally { scope.cancel() }
    }

    @Test fun aServerRefusedNoteSaveShowsTheRefusalAndDoesNotPretendTheNoteWasSaved() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = EngineRoomFixture.server()
            runBlocking { room.select("A"); room.pull(server) }
            room.store.observeEngine()
            show(room)
            compose.runOnIdle { runBlocking {
                assertTrue(room.store.saveNote("note0001", NoteWrite("Coach tone", "Be direct.")) is GymResult.Ok)
                server.refuse(code = "cap", detail = Json.objectOf("type" to Json.of("note"), "cap" to Json.of(10)))
                room.sync(server)
            } }
            waitForNotebook(room) { room.store.noteRefusals.isNotEmpty() && room.store.notes.isEmpty() }
            compose.onNodeWithText("The log has reached its limit. Remove an entry first.").assertIsDisplayed()
            compose.runOnIdle {
                assertTrue(room.store.notes.isEmpty())
                assertFalse("the submitted body remains inspectable in the engine refusal", room.engine.notices("gym").notices.value.isEmpty())
            }
        } } finally { scope.cancel() }
    }
}
