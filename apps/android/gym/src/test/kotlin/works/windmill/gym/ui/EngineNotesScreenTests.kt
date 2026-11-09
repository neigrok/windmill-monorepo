package works.windmill.gym.ui

import android.content.Context
import android.os.Looper
import androidx.annotation.StringRes
import androidx.compose.runtime.remember
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.gym.R
import works.windmill.gym.presentation.NoteWrite
import works.windmill.gym.presentation.Notes
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.platform.design.WindmillMaterial
import works.windmill.sync.core.Json
import androidx.compose.ui.test.onNodeWithContentDescription

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class EngineNotesScreenTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun show(room: EngineRoomFixture) {
        compose.setContent { WindmillMaterial { GymMaterial {
            remember(room.store) { NotesBinding(room.store) }.let { notes -> NotesScreen(notes, notes, true, "Settings", {}, { _, _ -> }, {}, {}) }
        } } }
    }

    private fun waitForNotebook(room: EngineRoomFixture, condition: () -> Boolean) {
        try {
            compose.waitUntil(2_000) {
                shadowOf(Looper.getMainLooper()).idle()
                condition()
            }
        } catch (timeout: ComposeTimeoutException) {
            throw AssertionError("notesRead=${room.store.notes.notesRead}; notes=${room.store.notes.all.map { it.id }}; " +
                "noteRefusals=${room.store.notes.noteRefusals.size}; " +
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
            compose.onNodeWithContentDescription(string(R.string.gym_notes_add)).assertDoesNotExist()
            val server = EngineRoomFixture.server()
            compose.runOnIdle { room.pull(server) }
            waitForNotebook(room) { room.store.notes.notesRead }
            compose.onNodeWithText(string(Notes.titleSuggestions.first())).assertIsDisplayed()
            compose.onNodeWithContentDescription(string(R.string.gym_notes_add)).assertIsDisplayed()
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
                assertTrue(other.store.notes.saveNote("note0001", NoteWrite("Coach tone", "Be direct.")) is GymResult.Ok)
                other.sync(server)
            } }
            compose.runOnIdle { room.pull(server) }
            waitForNotebook(room) { room.store.notes.all.any { it.id == "note0001" } }
            compose.onNodeWithText("Coach tone").assertIsDisplayed()
            compose.runOnIdle { assertEquals(listOf("note0001"), room.store.notes.all.map { it.id }) }
        } } finally { scope.cancel() }
    }

    @Test fun aServerRefusedNoteSaveShowsTheRefusalAndDoesNotPretendTheNoteWasSaved() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = EngineRoomFixture.server()
            runBlocking { room.select("A"); room.pull(server) }
            room.store.observeEngine()
            show(room)
            val savingNote = compose.runOnIdle { scope.async {
                assertTrue(room.store.notes.saveNote("note0001", NoteWrite("Coach tone", "Be direct.")) is GymResult.Ok)
                server.refuse(code = "cap", detail = Json.objectOf("type" to Json.of("note"), "cap" to Json.of(10)))
                room.sync(server)
            } }
            compose.waitUntil(10_000) { compose.runOnIdle { savingNote.isCompleted } }
            runBlocking { savingNote.await() }
            waitForNotebook(room) { room.store.notes.noteRefusals.isNotEmpty() && room.store.notes.all.isEmpty() }
            compose.onNodeWithText("The log has reached its limit. Remove an entry first.").assertIsDisplayed()
            compose.runOnIdle {
                assertTrue(room.store.notes.all.isEmpty())
                assertFalse("the submitted body remains inspectable in the engine refusal", room.engine.notices("gym").notices.value.isEmpty())
            }
        } } finally { scope.cancel() }
    }
}

private fun string(@StringRes id: Int, vararg args: Any): String = ApplicationProvider.getApplicationContext<Context>().getString(id, *args)
