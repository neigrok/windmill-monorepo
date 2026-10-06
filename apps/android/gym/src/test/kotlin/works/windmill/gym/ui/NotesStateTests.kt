package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsActions
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
class NotesStateTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    // The notebook is the account's: another phone writes it, and the room signs in and pulls it.
    private fun signedIn(room: EngineRoomFixture, vararg notes: Pair<String, NoteWrite>) {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), room.scope).use { other -> runBlocking {
            other.select("a"); other.pull(server)
            for ((id, write) in notes) assertTrue(other.store.saveNote(id, write) is GymResult.Ok)
            other.sync(server)
        } }
        runBlocking { room.select("a"); room.pull(server) }
    }

    // The save is one local commit under the note's own identity, and the editor leaves with it.
    @Test fun savingAnOpenNoteWritesItsOwnIdentityAndLeaves() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            signedIn(room, "note_tone" to NoteWrite("Tone", ""))
            val store = room.store
            var backs = 0
            var done = 0
            compose.setContent {
                GymMaterial { NoteEditorScreen(Note("note_tone", title = "Tone"), "", store, "Notes", { backs++ }, { done++ }) }
            }
            compose.onNodeWithContentDescription("Note field").performScrollTo().performTextReplacement("  Be precise.  ")
            compose.onNodeWithText(Notes.save).performClick()
            compose.runOnIdle {
                assertEquals(0, backs)
                assertEquals(1, done)
                assertEquals(listOf("note_tone" to NoteWrite("Tone", "Be precise.")),
                    runBlocking { room.training.notes() }.map { it.id to NoteWrite(it.title, it.body) })
                assertEquals(emptyList<WithheldDelete>(), store.withheld)
            }
        } } finally { scope.cancel() }
    }

    @Test fun accessibleReorderKeepsFocusOnTheMovedIdentity() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            signedIn(room, *Array(3) { "note_00$it" to NoteWrite("Title $it", "") })
            compose.setContent { GymMaterial { NotesScreen(room.store, true, "Coach", {}, { _, _ -> }, {}, {}) } }
            val initial = compose.onNodeWithText("Title 2").fetchSemanticsNode().id
            val move = compose.onNodeWithText("Title 2").fetchSemanticsNode().config[SemanticsActions.CustomActions].single()
            compose.runOnIdle { move.action() }
            compose.onNodeWithText("Title 2").assertIsFocused()
            compose.runOnIdle {
                assertEquals(initial, compose.onNodeWithText("Title 2").fetchSemanticsNode().id)
                assertEquals(listOf("note_000", "note_002", "note_001"), runBlocking { room.training.notes() }.map { it.id })
            }
        } } finally { scope.cancel() }
    }
}
