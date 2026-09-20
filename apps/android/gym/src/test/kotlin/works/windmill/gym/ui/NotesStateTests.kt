package works.windmill.gym.ui

import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import java.io.File
import java.io.IOException
import kotlinx.coroutines.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.*
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.gym.store.*
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class NotesStateTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope, server: TrainingSyncing): TrainingStore {
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")),
            LocalLog(File(tmp.root, "log")), LocalPreferences(File(tmp.root, "prefs")),
            LocalBodyweight(File(tmp.root, "weight")), scope, sync = { server })
        runBlocking { store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }),
            User("a", "a@example.com", "A"))) }
        return store
    }

    @Test fun firstReadFailureOffersRetryWithoutFalseEmptySuggestionsOrCount() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val response = CompletableDeferred<Unit>()
        var reads = 0
        val boundary = object : TrainingSyncing by server {
            override suspend fun notes(): List<Note> {
                if (++reads == 1) { response.await(); throw IOException("offline") }
                return server.notes()
            }
        }
        val store = store(scope, boundary)
        compose.setContent { GymMaterial { NotesScreen(store, true, "Coach", {}, { _, _ -> }, {}, {}) } }
        compose.onNodeWithText("Reading your notes…").assertIsDisplayed()
        compose.onNodeWithText(Notes.add).assertDoesNotExist()
        compose.onNodeWithText(Notes.placeholders.first()).assertDoesNotExist()
        compose.runOnIdle { response.complete(Unit) }
        compose.onNodeWithText("Notes unavailable").assertIsDisplayed()
        compose.onNodeWithText(Notes.full).assertDoesNotExist()
        compose.onNodeWithText("Try again").performClick()
        compose.onNodeWithText(Notes.add).assertIsDisplayed()
        compose.onNodeWithText(Notes.placeholders.first()).assertIsDisplayed()
        compose.runOnIdle { assertEquals(2, reads); assertEquals(emptyList<Note>(), server.notebook) }
        scope.cancel()
    }

    @Test fun titleHintNeverEnablesSaveAndUnicodeRefusalsRetainRawBuffersAndIdentity() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val attempts = mutableListOf<Pair<String, NoteWrite>>()
        val boundary = object : TrainingSyncing by server {
            override suspend fun writeNote(id: String, write: NoteWrite): Note {
                attempts += id to write
                return server.writeNote(id, write)
            }
        }
        val store = store(scope, boundary)
        val restored = StateRestorationTester(compose)
        var done = 0
        restored.setContent { GymMaterial { NoteEditorScreen(null, "What I am training for", store, "Notes", {}, { done++ }) } }
        compose.onNodeWithText("What I am training for").assertIsDisplayed()
        compose.onNodeWithText(Notes.save).assertIsNotEnabled()
        val title = "  " + "🏋".repeat(61) + "  "
        val body = "\n" + "é".repeat(251) + "\n"
        compose.onNodeWithContentDescription("Title field").performTextReplacement(title)
        compose.onNodeWithContentDescription("Body field").performScrollTo().performTextReplacement(body)
        compose.onNodeWithText(Notes.save).assertIsEnabled().performClick()
        compose.onNodeWithText("a title runs to 60 characters").performScrollTo().assertIsDisplayed()
        restored.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription("Title field").assertTextEquals(title)
        compose.onNodeWithContentDescription("Body field").assertTextEquals(body)
        compose.onNodeWithText("a title runs to 60 characters").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Title field").performScrollTo().performTextReplacement("🏋".repeat(60))
        compose.onNodeWithText(Notes.save).performClick()
        compose.onNodeWithText("a note runs to 500 bytes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Body field").performScrollTo().performTextReplacement("é".repeat(250))
        compose.onNodeWithText(Notes.save).performClick()
        compose.runOnIdle {
            assertEquals(1, done)
            assertEquals(3, attempts.size)
            assertEquals(1, attempts.map { it.first }.distinct().size)
            assertEquals(listOf(NoteWrite(title.trim(), body.trim()), NoteWrite("🏋".repeat(60), body.trim()),
                NoteWrite("🏋".repeat(60), "é".repeat(250))), attempts.map { it.second })
            assertEquals(listOf(attempts.last().first), server.notebook.map { it.id })
        }
        scope.cancel()
    }

    @Test fun pendingSaveBlocksNativeBackEditsDeleteAndRepeatThenRetriesTheSameNote() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val response = CompletableDeferred<Unit>()
        val writes = mutableListOf<Pair<String, NoteWrite>>()
        val boundary = object : TrainingSyncing by server {
            override suspend fun writeNote(id: String, write: NoteWrite): Note {
                writes += id to write
                if (writes.size == 1) { response.await(); throw IOException("offline") }
                return server.writeNote(id, write)
            }
        }
        val store = store(scope, boundary)
        lateinit var back: OnBackPressedDispatcher
        var backs = 0
        var done = 0
        compose.setContent {
            back = LocalOnBackPressedDispatcherOwner.current!!.onBackPressedDispatcher
            GymMaterial { NoteEditorScreen(Note("note_a", title = "Tone"), "", store, "Notes", { backs++ }, { done++ }) }
        }
        compose.onNodeWithContentDescription("Note field").performScrollTo().performTextReplacement("  Be precise.  ")
        compose.onNodeWithText(Notes.save).performClick()
        compose.onNodeWithText("Saving…").assertIsNotEnabled().performClick()
        compose.onNodeWithContentDescription("Title field").assertIsNotEnabled()
        compose.onNodeWithText(Notes.delete).performScrollTo().assertIsNotEnabled().performClick()
        compose.runOnIdle { back.onBackPressed(); assertEquals(0, backs); assertEquals(0, done); response.complete(Unit) }
        compose.onNodeWithText(Notes.save).assertIsEnabled()
        compose.onNodeWithContentDescription("Note field").assertTextEquals("  Be precise.  ")
        compose.onNodeWithText(Notes.save).performClick()
        compose.runOnIdle {
            assertEquals(listOf("note_a" to NoteWrite("Tone", "Be precise."), "note_a" to NoteWrite("Tone", "Be precise.")), writes)
            assertEquals(1, done)
            assertEquals(emptyList<WithheldDelete>(), store.withheld)
        }
        scope.cancel()
    }

    @Test fun accessibleReorderKeepsFocusOnTheMovedIdentityAndBlocksASecondRequest() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        runBlocking { repeat(3) { server.writeNote("n$it", NoteWrite("Title $it", "")) } }
        val response = CompletableDeferred<Unit>()
        var writes = 0
        val boundary = object : TrainingSyncing by server {
            override suspend fun reorderNotes(order: List<String>): List<Note> {
                writes++; response.await(); return server.reorderNotes(order)
            }
        }
        val store = store(scope, boundary)
        compose.setContent { GymMaterial { NotesScreen(store, true, "Coach", {}, { _, _ -> }, {}, {}) } }
        val initial = compose.onNodeWithText("Title 2").fetchSemanticsNode().id
        val move = compose.onNodeWithText("Title 2").fetchSemanticsNode().config[SemanticsActions.CustomActions].single()
        compose.runOnIdle { move.action() }
        compose.onNodeWithText("Title 2").assertIsNotEnabled()
        compose.runOnIdle { move.action(); assertEquals(1, writes); response.complete(Unit) }
        compose.onNodeWithText("Title 2").assertIsFocused()
        compose.runOnIdle {
            assertEquals(initial, compose.onNodeWithText("Title 2").fetchSemanticsNode().id)
            assertEquals(listOf("n0", "n2", "n1"), server.notebook.map { it.id })
        }
        scope.cancel()
    }
}
