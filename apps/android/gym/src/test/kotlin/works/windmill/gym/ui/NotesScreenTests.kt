package works.windmill.gym.ui

import android.os.Looper
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getBoundsInRoot
import works.windmill.platform.telemetry.Telemetry
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNull
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
import works.windmill.gym.presentation.Note
import works.windmill.gym.presentation.NoteWrite
import works.windmill.gym.presentation.Notes
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.platform.design.WindmillSpace
import works.windmill.sync.core.Json
import works.windmill.sync.modelserver.ModelServer

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class NotesScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private class Recorder : Telemetry {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
    }

    // The notebook is the account's: another phone writes it, and the room signs in and pulls it.
    private fun signedIn(room: EngineRoomFixture, vararg notes: Pair<String, NoteWrite>): ModelServer {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), room.scope).use { other -> runBlocking {
            other.select("u1"); other.pull(server)
            for ((id, write) in notes) assertTrue(other.store.saveNote(id, write) is GymResult.Ok)
            other.sync(server)
        } }
        runBlocking { room.select("u1"); room.pull(server) }
        return server
    }

    // What the log holds, read by a phone that pulls it fresh.
    private fun onTheLog(room: EngineRoomFixture, server: ModelServer): List<String> =
        EngineRoomFixture(tmp.newFolder(), room.scope).use { reader -> runBlocking {
            reader.select("u1"); reader.pull(server)
            reader.training.notes().map { it.id }
        } }

    private fun numbered(count: Int) = Array(count) { "note_00$it" to NoteWrite("note $it", "line $it") }

    @Test
    fun testAnEmptyNotebookOffersTwoPlaceholdersAndTappingOneOpensTheEditorWithThatTitle() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            signedIn(room)
            val opened = mutableListOf<Pair<Note?, String>>()

            compose.setContent {
                NotesScreen(
                    store = room.store,
                    isSignedIn = true,
                    backTo = "Coach",
                    onBack = {},
                    onEdit = { note, seed -> opened += note to seed },
                    onSignIn = {},
                    say = {},
                )
            }

            compose.onNodeWithText(Notes.honesty).assertIsDisplayed()
            compose.onNodeWithText("what you write for Coach").assertDoesNotExist()
            compose.onNodeWithText("What I am training for").performClick()
            compose.onNodeWithText(Notes.add).assertIsDisplayed()

            compose.runOnIdle {
                assertEquals("the editor receives a title hint, and nothing was written",
                    listOf<Pair<Note?, String>>(null to "What I am training for"), opened)
                assertEquals(emptyList<Note>(), runBlocking { room.training.notes() })
                assertEquals(emptyList<Json>(), room.outbox())
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun testAtTenTheAddRowStopsOfferingAndSaysSoInTheBriefsWords() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            signedIn(room, *numbered(10))

            compose.setContent {
                NotesScreen(
                    store = room.store,
                    isSignedIn = true,
                    backTo = "Coach",
                    onBack = {},
                    onEdit = { _, _ -> },
                    onSignIn = {},
                    say = {},
                )
            }

            compose.onNodeWithText("note 0").assertIsDisplayed()
            compose.onNodeWithText("line 0").assertIsDisplayed()
            assertTrue("a handle before the title: x=${titleX("note 0")}", titleX("note 0") >= pastTheRail)
            compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(Notes.full))
            compose.onNodeWithText("Top note wins.").assertDoesNotExist()
            compose.onNodeWithText("10 of 10 notes. Delete one to add another.").assertIsDisplayed()
            compose.onNodeWithText(Notes.add).assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    @Test
    fun deletingTheTenthNoteImmediatelyMakesRoomForAnother() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            signedIn(room, *numbered(10))
            val store = room.store
            compose.setContent {
                NotesScreen(
                    store = store, isSignedIn = true, backTo = "Coach", onBack = {},
                    onEdit = { _, _ -> }, onSignIn = {}, say = {},
                )
            }
            compose.onNodeWithText("note 3").assertIsDisplayed()

            compose.runOnIdle { runBlocking { assertNull(store.delete(Deletion.Note("note_003"))) } }

            compose.onNodeWithText("note 3").assertDoesNotExist()
            compose.onNodeWithText(Notes.full).assertDoesNotExist()
            compose.onNodeWithText(Notes.add).assertIsDisplayed()
            compose.runOnIdle {
                assertEquals((0..9).filter { it != 3 }.map { "note_00$it" }, room.training.notes().map { it.id })
                assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() })
                assertNull(store.keepWithheld())
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun testASettledDeleteLeavesTheRowGoneAndGivesTheAddRowBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = signedIn(room, *numbered(10))
            val store = room.store
            compose.setContent {
                NotesScreen(
                    store = store, isSignedIn = true, backTo = "Coach", onBack = {},
                    onEdit = { _, _ -> }, onSignIn = {}, say = {},
                )
            }
            compose.onNodeWithText("note 3").assertIsDisplayed()

            compose.runOnIdle { runBlocking { assertNull(store.delete(Deletion.Note("note_003"))) } }

            compose.onNodeWithText("note 3").assertDoesNotExist()
            compose.onNodeWithText(Notes.add).assertIsDisplayed()
            compose.onNodeWithText(Notes.full).assertDoesNotExist()
            compose.runOnIdle { room.sync(server) }
            assertEquals("the log holds nine", (0..9).filter { it != 3 }.map { "note_00$it" }, onTheLog(room, server))
        } } finally { scope.cancel() }
    }

    @Test
    fun deletingANoteLeavesTheEditorAfterItQueuesWithoutUndo() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            signedIn(room, "note_001" to NoteWrite("Tone", "keep it short"))
            val store = room.store
            val note = Note(id = "note_001", title = "Tone", body = "keep it short")
            var done = 0
            compose.setContent {
                NoteEditorScreen(
                    note = note, seedTitle = "", store = store, backTo = Notes.title,
                    onBack = {}, onDone = { done += 1 },
                )
            }

            compose.onNodeWithText(Notes.delete).performScrollTo().performClick()
            compose.runOnIdle {
                assertEquals("the editor leaves on the tap", 1, done)
                assertEquals(emptyList<String>(), store.withheld.map { it.subjectId })
                assertEquals(emptyList<String>(), room.training.notes().map { it.id })
                assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() })
                assertNull(works.windmill.gym.store.Withheld.line(store.withheld))
            }
        } } finally { scope.cancel() }
    }

    // Where a title starts when a drag handle sits before it: the screen's edge, the rail, the gap.
    private val pastTheRail: Float
        get() = with(compose.density) { (WindmillSpace.x5 + 32.dp + WindmillSpace.x2).toPx() }

    // The unmerged tree: the merged node for a title is the whole clickable row.
    private fun titleX(title: String): Float =
        compose.onNodeWithText(title, useUnmergedTree = true).fetchSemanticsNode().positionInRoot.x

    // One note has no order to explain: no caption and no handle, the same rule as web.
    @Test
    fun testOneNoteDrawsNeitherTheCaptionNorTheHandle() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            signedIn(room, "note_000" to NoteWrite("note 0", "line 0"))

            compose.setContent {
                NotesScreen(
                    store = room.store,
                    isSignedIn = true,
                    backTo = "Coach",
                    onBack = {},
                    onEdit = { _, _ -> },
                    onSignIn = {},
                    say = {},
                )
            }

            compose.onNodeWithText("note 0").assertIsDisplayed()
            compose.onNodeWithText("Top note wins.").assertDoesNotExist()
            assertTrue("no handle before the title: x=${titleX("note 0")}", titleX("note 0") < pastTheRail)
        } } finally { scope.cancel() }
    }

    @Test
    fun testSignedOutTheScreenIsASignInDoor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking { room.select(null) }
            val doors = mutableListOf<String>()

            compose.setContent {
                NotesScreen(
                    store = room.store,
                    isSignedIn = false,
                    backTo = "Settings",
                    onBack = {},
                    onEdit = { _, _ -> doors += "edit" },
                    onSignIn = { doors += "signIn" },
                    say = {},
                )
            }

            compose.onNodeWithText(Notes.honesty).assertIsDisplayed()
            compose.onAllNodesWithText(Notes.honesty).assertCountEquals(1)
            compose.onNodeWithText("what you write for Coach").assertDoesNotExist()
            compose.onNodeWithText(Notes.signedOut).assertIsDisplayed()
            compose.onNodeWithText("Sign in").performClick()
            compose.runOnIdle {
                assertEquals(listOf("signIn"), doors)
                assertFalse("nothing was read from the notebook", room.store.notesRead)
            }
        } } finally { scope.cancel() }
    }

    private fun threeNotes(room: EngineRoomFixture) = signedIn(room, *numbered(3))

    // Top of the screen first: the order the rows are drawn in, read off their positions.
    private fun drawnOrder(vararg titles: String): List<String> = titles
        .sortedBy { compose.onNodeWithText(it).fetchSemanticsNode().positionInRoot.y }

    private fun dragBelowTheNextRow(title: String) {
        val row = compose.onNodeWithText(title).fetchSemanticsNode()
        val step = row.size.height * 1.4f / 7
        compose.onNodeWithContentDescription("Reorder $title").performTouchInput {
            down(center)
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 200)
            repeat(7) { moveBy(Offset(0f, step)) }
            up()
        }
    }

    @Test
    fun testAnOrderTheLogRefusesIsNotLeftOnScreen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = threeNotes(room)
            room.store.observeEngine()

            compose.setContent {
                NotesScreen(
                    store = room.store,
                    isSignedIn = true,
                    backTo = "Coach",
                    onBack = {},
                    onEdit = { _, _ -> },
                    onSignIn = {},
                    say = {},
                )
            }
            compose.onNodeWithText("note 0").assertIsDisplayed()

            dragBelowTheNextRow("note 0")
            compose.runOnIdle {
                server.refuse(code = "stale")
                room.sync(server)
            }
            compose.waitUntil(2_000) {
                shadowOf(Looper.getMainLooper()).idle()
                room.store.noteRefusals.isNotEmpty() && room.store.notes.map { it.id } == listOf("note_000", "note_001", "note_002")
            }

            compose.runOnIdle {
                assertEquals(listOf("note_000", "note_001", "note_002"), onTheLog(room, server))
                assertEquals(listOf("note_000", "note_001", "note_002"), runBlocking { room.training.notes() }.map { it.id })
                assertEquals("the refusal reaches the room", listOf("That changed. Open it again."),
                    room.store.noteRefusals.map { it.reason })
            }
            compose.onNodeWithText("That changed. Open it again.", substring = true).assertIsDisplayed()
            assertEquals("the list says what the log holds, not the order it refused",
                listOf("note 0", "note 1", "note 2"), drawnOrder("note 0", "note 1", "note 2"))
        } } finally { scope.cancel() }
    }

    // The drag is half-built until a screen reader can do the same: every row offers Move up / Move
    // down as custom actions, one step at a time, and the top and bottom rows offer only the one.
    @Test
    fun testARowCanBeMovedUpOrDownWithoutADrag() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = threeNotes(room)

            compose.setContent {
                NotesScreen(
                    store = room.store,
                    isSignedIn = true,
                    backTo = "Coach",
                    onBack = {},
                    onEdit = { _, _ -> },
                    onSignIn = {},
                    say = {},
                )
            }
            compose.onNodeWithText("note 0").assertIsDisplayed()

            fun actionsOn(title: String) = compose.onNodeWithText(title).fetchSemanticsNode()
                .config[SemanticsActions.CustomActions].map { it.label }
            assertEquals(listOf("Move down"), actionsOn("note 0"))
            assertEquals(listOf("Move up", "Move down"), actionsOn("note 1"))
            assertEquals(listOf("Move up"), actionsOn("note 2"))

            val moveUp = compose.onNodeWithText("note 2").fetchSemanticsNode()
                .config[SemanticsActions.CustomActions].first { it.label == "Move up" }
            compose.runOnUiThread { moveUp.action() }

            compose.runOnIdle { room.sync(server) }
            assertEquals(listOf("note_000", "note_002", "note_001"), onTheLog(room, server))
            assertEquals(listOf("note 0", "note 2", "note 1"), drawnOrder("note 0", "note 1", "note 2"))
        } } finally { scope.cancel() }
    }

    @Test
    fun testADragTheLogAcceptsIsTheNewOrder() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = threeNotes(room)

            compose.setContent {
                NotesScreen(
                    store = room.store,
                    isSignedIn = true,
                    backTo = "Coach",
                    onBack = {},
                    onEdit = { _, _ -> },
                    onSignIn = {},
                    say = {},
                )
            }
            compose.onNodeWithText("note 0").assertIsDisplayed()

            dragBelowTheNextRow("note 0")

            compose.runOnIdle { room.sync(server) }
            assertEquals(listOf("note_001", "note_000", "note_002"), onTheLog(room, server))
            assertEquals(listOf("note 1", "note 0", "note 2"), drawnOrder("note 0", "note 1", "note 2"))
        } } finally { scope.cancel() }
    }

    // The held note keeps its key; only the dragged note moves below its drawn neighbor.
    @Test
    fun aDragAfterDeletionMovesOnlyTheSurvivingNote() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = threeNotes(room)
            val store = room.store
            val said = mutableListOf<String?>()

            compose.setContent {
                NotesScreen(
                    store = store,
                    isSignedIn = true,
                    backTo = "Coach",
                    onBack = {},
                    onEdit = { _, _ -> },
                    onSignIn = {},
                    say = { said += it },
                )
            }
            compose.onNodeWithText("note 0").assertIsDisplayed()

            compose.runOnIdle { runBlocking { assertNull(store.delete(Deletion.Note("note_001"))) } }
            compose.onNodeWithText("note 1").assertDoesNotExist()

            dragBelowTheNextRow("note 0")

            compose.runOnIdle {
                assertEquals("nothing was refused", emptyList<String>(), said.filterNotNull())
                assertEquals(emptyList<String>(), store.withheld.map { it.subjectId })
                room.sync(server)
            }
            assertEquals(listOf("note_002", "note_000"), onTheLog(room, server))
            assertEquals(listOf("note 2", "note 0"), drawnOrder("note 0", "note 2"))
            compose.onNodeWithText("note 1").assertDoesNotExist()
            compose.runOnIdle { assertNull(store.keepWithheld()) }
            assertEquals(listOf("note 2", "note 0"), drawnOrder("note 0", "note 2"))
        } } finally { scope.cancel() }
    }
    @Test
    fun aHandleSwipeAndCancelledReorderDoNotDeleteOrSaveAnOrder() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val telemetry = Recorder()
        try { EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry).use { room ->
            threeNotes(room)
            compose.setContent { GymMaterial { NotesScreen(room.store, true, "Coach", {}, { _, _ -> }, {}, {}) } }
            compose.onNodeWithText("note 0").assertIsDisplayed()
            compose.runOnIdle { telemetry.events.clear() }
            val handle = compose.onNodeWithContentDescription("Reorder note 0")
            handle.performTouchInput { swipe(center, Offset(-250f, centerY)) }
            compose.runOnIdle {
                assertEquals(listOf("note_000", "note_001", "note_002"), room.store.notes.map { it.id })
                assertTrue(telemetry.events.isEmpty())
            }
            val rowHeight = compose.onNodeWithText("note 0").fetchSemanticsNode().size.height
            handle.performTouchInput {
                down(center)
                advanceEventTime(viewConfiguration.longPressTimeoutMillis + 100)
                repeat(7) { moveBy(Offset(0f, rowHeight * 1.4f / 7)) }
            }
            assertEquals(listOf("note 1", "note 0", "note 2"), drawnOrder("note 0", "note 1", "note 2"))
            handle.performTouchInput { cancel() }
            assertEquals(listOf("note 0", "note 1", "note 2"), drawnOrder("note 0", "note 1", "note 2"))
            compose.runOnIdle {
                assertEquals(listOf("note_000", "note_001", "note_002"), room.training.notes().map { it.id })
                assertEquals(emptyList<Json>(), room.outbox())
                assertEquals(emptyList<Pair<String, Map<String, String>>>(), telemetry.events)
                assertEquals(emptyList<String>(), telemetry.failures)
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun aFailedBodySwipeRestoresTheRowAndItsRetryEmitsOneResultEach() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val telemetry = Recorder()
        try { EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry).use { room ->
            threeNotes(room)
            compose.setContent { GymMaterial { NotesScreen(room.store, true, "Coach", {}, { _, _ -> }, {}, {}) } }
            val row = compose.onNodeWithText("note 0").assertIsDisplayed()
            val left = row.getBoundsInRoot().left
            compose.runOnIdle { telemetry.events.clear(); room.engine.failNextCommit() }
            row.performTouchInput { swipeLeft() }
            compose.onNodeWithText("the log didn’t answer — that note is still here").assertIsDisplayed()
            assertEquals(left, row.getBoundsInRoot().left)
            compose.runOnIdle {
                assertEquals(listOf("note_000", "note_001", "note_002"), room.training.notes().map { it.id })
                assertEquals(emptyList<Json>(), room.outbox())
                assertEquals(listOf("gym_action" to mapOf("screen" to "notes", "action" to "delete", "outcome" to "failed")), telemetry.events)
                assertEquals(listOf("gym.deleteNote"), telemetry.failures)
            }
            row.performTouchInput { swipeLeft() }
            compose.onNodeWithText("note 0").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(listOf("note_001", "note_002"), room.training.notes().map { it.id })
                assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() })
                assertEquals(emptyList<Any>(), room.store.withheld)
                assertEquals(listOf(
                    "gym_action" to mapOf("screen" to "notes", "action" to "delete", "outcome" to "failed"),
                    "gym_action" to mapOf("screen" to "notes", "action" to "delete", "outcome" to "ok"),
                ), telemetry.events)
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun theEditorKeepsAFailedDeleteOpenAndReportsItsOwnOriginOncePerAttempt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val telemetry = Recorder()
        try { EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry).use { room ->
            signedIn(room, "note_001" to NoteWrite("Private title", "Private body"))
            var done = 0
            compose.setContent { GymMaterial { NoteEditorScreen(
                Note("note_001", title = "Private title", body = "Private body"), "", room.store, "Notes", {}, { done++ }) } }
            compose.onNodeWithText(Notes.save).assertIsNotEnabled()
            compose.runOnIdle { telemetry.events.clear(); room.engine.failNextCommit() }
            compose.onNodeWithText(Notes.delete).performScrollTo().performClick()
            compose.onNodeWithText("the log didn’t answer — that note is still here").assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(0, done)
                assertEquals(listOf("note_001"), room.training.notes().map { it.id })
                assertEquals(listOf("gym_action" to mapOf("screen" to "note_editor", "action" to "delete", "outcome" to "failed")), telemetry.events)
                assertEquals(listOf("gym.deleteNote"), telemetry.failures)
            }
            compose.onNodeWithText(Notes.delete).performClick()
            compose.runOnIdle {
                assertEquals(1, done)
                assertEquals(emptyList<Note>(), room.training.notes())
                assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() })
                assertEquals(listOf(
                    "gym_action" to mapOf("screen" to "note_editor", "action" to "delete", "outcome" to "failed"),
                    "gym_action" to mapOf("screen" to "note_editor", "action" to "delete", "outcome" to "ok"),
                ), telemetry.events)
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun noteSaveResultsEmitOnlyTheirBoundedLabels() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val telemetry = Recorder()
        try { EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry).use { room ->
            signedIn(room)
            runBlocking {
                assertTrue(room.store.saveNote("note_001", NoteWrite("Private title", "Private body")) is GymResult.Ok)
                val refused = room.store.saveNote("note_001", NoteWrite("x".repeat(61), "Private refused body"))
                assertTrue(refused is GymResult.Failed && refused.why is works.windmill.gym.store.WriteFailure.Refused)
                room.engine.failNextCommit()
                val failed = room.store.saveNote("note_001", NoteWrite("Private replacement", "Private failed body"))
                assertTrue(failed is GymResult.Failed && failed.why !is works.windmill.gym.store.WriteFailure.Refused)
                assertEquals(listOf("gym.saveNote"), telemetry.failures)
                assertEquals(listOf(
                    "gym_action" to mapOf("screen" to "note_editor", "action" to "save", "outcome" to "ok"),
                    "gym_action" to mapOf("screen" to "note_editor", "action" to "save", "outcome" to "refused"),
                    "gym_action" to mapOf("screen" to "note_editor", "action" to "save", "outcome" to "failed"),
                ), telemetry.events)
                assertEquals(listOf(Note("note_001", title = "Private title", body = "Private body")), room.training.notes())
            }
        } } finally { scope.cancel() }
    }

}
