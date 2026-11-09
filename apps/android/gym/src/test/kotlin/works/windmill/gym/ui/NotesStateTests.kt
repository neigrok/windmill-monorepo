package works.windmill.gym.ui

import android.content.Context
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.platform.R as PlatformR
import works.windmill.gym.string
import works.windmill.gym.GymRoom
import works.windmill.gym.R
import works.windmill.platform.LocalShellActions
import works.windmill.platform.ShellActions
import works.windmill.gym.presentation.Note
import works.windmill.gym.presentation.NoteWrite
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.WithheldDelete

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
            for ((id, write) in notes) assertTrue(other.store.notes.saveNote(id, write) is GymResult.Ok)
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
                GymMaterial { NoteEditorScreen(NotesBinding(store), Note("note_tone", title = "Tone"), "", { backs++ }, { done++ }) }
            }
            compose.onNodeWithContentDescription("Note field").performScrollTo().performTextReplacement("  Be precise.  ")
            compose.onNodeWithText(string(PlatformR.string.platform_save)).performClick()
            compose.runOnIdle {
                assertEquals(0, backs)
                assertEquals(1, done)
                assertEquals(listOf("note_tone" to NoteWrite("Tone", "Be precise.")),
                    runBlocking { room.training.notes() }.map { it.id to NoteWrite(it.title, it.body) })
                assertEquals(emptyList<WithheldDelete>(), store.held.withheld)
            }
        } } finally { scope.cancel() }
    }

    @Test fun twoNewNotesKeepTheirOwnWordsThroughRecreationAndAnimatedPops() {
        Settings.Global.putFloat(ApplicationProvider.getApplicationContext<Context>().contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            signedIn(room)
            val shell = ShellActions(openYou = {})
            var showing by mutableStateOf(true)
            val restored = StateRestorationTester(compose)
            restored.setContent {
                if (showing) CompositionLocalProvider(LocalShellActions provides shell) {
                    GymMaterial { GymRoom(room.account(), room.store) }
                }
            }
            compose.runOnIdle { shell.destinations.single { it.id == "notes" }.onOpen() }
            compose.onNodeWithContentDescription(string(R.string.gym_notes_add)).performClick()
            compose.onNodeWithContentDescription("Title field").performTextReplacement("A")
            compose.onNodeWithContentDescription("Note field").performTextReplacement("First body")
            restored.emulateSavedInstanceStateRestore()
            compose.onNodeWithContentDescription("Title field").assertTextEquals("Title", "A")
            compose.onNodeWithContentDescription("Note field").assertTextEquals("Note", "First body")
            compose.onNodeWithText(string(PlatformR.string.platform_save)).performClick()
            val first = compose.runOnIdle { runBlocking { room.training.notes() }.single() }
            compose.onNodeWithContentDescription(string(R.string.gym_notes_add)).performClick()
            compose.onNodeWithContentDescription("Title field").assertTextEquals("Title", "")
            compose.onNodeWithContentDescription("Note field").assertTextEquals("Note", "")
            compose.onNodeWithContentDescription("Title field").performTextReplacement("B")
            compose.onNodeWithContentDescription("Note field").performTextReplacement("Second body")
            compose.onNodeWithText(string(PlatformR.string.platform_save)).performClick()
            compose.runOnIdle {
                val saved = runBlocking { room.training.notes() }
                assertEquals(2, saved.size)
                assertEquals(2, saved.map { it.id }.distinct().size)
                assertEquals(first, saved.single { it.id == first.id })
                assertEquals(listOf(NoteWrite("A", "First body"), NoteWrite("B", "Second body")),
                    saved.map { NoteWrite(it.title, it.body) })
                showing = false
            }
            compose.waitForIdle()
        } } finally { scope.cancel() }
    }

    @Test fun accessibleReorderKeepsFocusOnTheMovedIdentity() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            signedIn(room, *Array(3) { "note_00$it" to NoteWrite("Title $it", "") })
            compose.setContent { GymMaterial { remember(room.store) { NotesBinding(room.store) }.let { notes -> NotesScreen(notes, notes, true, "Coach", {}, { _, _ -> }, {}, {}) } } }
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

    @Test fun titleHintNeverEnablesSaveAndUnicodeRefusalsRetainRawBuffersAndIdentity() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            signedIn(room)
            val restored = StateRestorationTester(compose)
            var done = 0
            restored.setContent { GymMaterial { NoteEditorScreen(NotesBinding(room.store), null, "What I am training for", {}, { done++ }) } }
            compose.onNodeWithContentDescription("Title field").performClick()
            compose.onNodeWithText("What I am training for").assertIsDisplayed()
            compose.onNodeWithText(string(PlatformR.string.platform_save)).assertIsNotEnabled()
            val title = "  " + "🏋".repeat(61) + "  "
            val body = "\n" + "é".repeat(251) + "\n"
            compose.onNodeWithContentDescription("Title field").performTextReplacement(title)
            compose.onNodeWithContentDescription("Note field").performScrollTo().performTextReplacement(body)
            compose.onNodeWithText(string(PlatformR.string.platform_save)).assertIsEnabled().performClick()
            compose.onNodeWithText("a title runs to 60 characters").performScrollTo().assertIsDisplayed()
            restored.emulateSavedInstanceStateRestore()
            compose.onNodeWithContentDescription("Title field").assertTextEquals("Title", title)
            compose.onNodeWithContentDescription("Note field").assertTextEquals("Note", body)
            compose.onNodeWithText("a title runs to 60 characters").performScrollTo().assertIsDisplayed()
            compose.onNodeWithContentDescription("Title field").performScrollTo().performTextReplacement("🏋".repeat(60))
            compose.onNodeWithText(string(PlatformR.string.platform_save)).performClick()
            compose.onNodeWithText("a note runs to 500 bytes").performScrollTo().assertIsDisplayed()
            compose.onNodeWithContentDescription("Note field").performScrollTo().performTextReplacement("é".repeat(250))
            compose.onNodeWithText(string(PlatformR.string.platform_save)).performClick()
            compose.runOnIdle {
                assertEquals(1, done)
                val saved = runBlocking { room.training.notes() }.single()
                assertEquals(Note(saved.id, 0, "🏋".repeat(60), "é".repeat(250), saved.updatedAtMs), saved)
                assertEquals(listOf(saved), room.store.notes.all)
            }
        } } finally { scope.cancel() }
    }
}
