package works.windmill.gym.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.Notes
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.design.WindmillSpace

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class NotesScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope, server: FakeTraining, signedIn: Boolean): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = if (signedIn) User(id = "u1", email = "sam@example.com", name = "Sam") else null,
            ))
        }
        return store
    }

    @Test
    fun testAnEmptyNotebookOffersTwoPlaceholdersAndTappingOneOpensTheEditorWithThatTitle() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server, signedIn = true)
        val opened = mutableListOf<Pair<Note?, String>>()

        compose.setContent {
            NotesScreen(
                store = store,
                isSignedIn = true,
                backTo = "Coach",
                onBack = {},
                onEdit = { note, seed -> opened += note to seed },
                onSignIn = {},
                say = {},
            )
        }

        compose.onNodeWithText(Notes.honesty).assertIsDisplayed()
        compose.onNodeWithText(Notes.sub).assertIsDisplayed()
        compose.onNodeWithText("What I am training for").performClick()
        compose.onNodeWithText(Notes.add).assertIsDisplayed()

        compose.runOnIdle {
            assertEquals("the editor opens with the title filled in, and nothing was written",
                listOf<Pair<Note?, String>>(null to "What I am training for"), opened)
            assertEquals(emptyList<Note>(), server.notebook)
        }
        scope.cancel()
    }

    @Test
    fun testAtTenTheAddRowStopsOfferingAndSaysSoInTheBriefsWords() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        runBlocking {
            repeat(10) { server.writeNote("note_$it", NoteWrite("note $it", "line $it")) }
        }
        val store = store(scope, server, signedIn = true)

        compose.setContent {
            NotesScreen(
                store = store,
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
        compose.onNodeWithText(Notes.topWins).assertIsDisplayed()
        compose.onNodeWithText("10 of 10 notes. Delete one to add another.").assertIsDisplayed()
        compose.onNodeWithText(Notes.add).assertDoesNotExist()
        scope.cancel()
    }

    // The cap counts the STORE's notes, never the drawn list: a note inside its undo window is off
    // the list and still on the log, so ten must not read as nine and offer a mint the store refuses.
    @Test
    fun testTheCapCountsTheStoresNotesAndNotTheOnesStillDrawn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        runBlocking {
            repeat(10) { server.writeNote("note_$it", NoteWrite("note $it", "line $it")) }
        }
        val store = store(scope, server, signedIn = true)
        compose.setContent {
            NotesScreen(
                store = store, isSignedIn = true, backTo = "Coach", onBack = {},
                onEdit = { _, _ -> }, onSignIn = {}, say = {},
            )
        }
        compose.onNodeWithText("note 3").assertIsDisplayed()

        compose.runOnIdle { store.withhold(Deletion.Note("note_3")) }

        compose.onNodeWithText("note 3").assertDoesNotExist()
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(Notes.full))
        compose.onNodeWithText(Notes.full).assertIsDisplayed()
        compose.onNodeWithText(Notes.add).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("and nothing is on the wire while the window is open",
                emptyList<String>(), server.calls.filter { it == "deleteNote" })
        }
        scope.cancel()
    }

    // And when the window closes the row STAYS gone, with the cap counting what the log now holds.
    // The list is the store's; a screen holding a snapshot of its own drew the note back the instant
    // the delete landed, and kept withholding `Add a note` over a notebook of nine.
    @Test
    fun testASettledDeleteLeavesTheRowGoneAndGivesTheAddRowBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        runBlocking {
            repeat(10) { server.writeNote("note_$it", NoteWrite("note $it", "line $it")) }
        }
        val store = store(scope, server, signedIn = true)
        compose.setContent {
            NotesScreen(
                store = store, isSignedIn = true, backTo = "Coach", onBack = {},
                onEdit = { _, _ -> }, onSignIn = {}, say = {},
            )
        }
        compose.onNodeWithText("note 3").assertIsDisplayed()

        compose.runOnIdle { store.withhold(Deletion.Note("note_3")) }
        compose.runOnIdle { runBlocking { store.settleWithheld("note_3") } }

        compose.onNodeWithText("note 3").assertDoesNotExist()
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(Notes.add))
        compose.onNodeWithText(Notes.add).assertIsDisplayed()
        compose.onNodeWithText(Notes.full).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("the log holds nine", 9, server.notebook.size)
            assertEquals(listOf("deleteNote"), server.calls.filter { it == "deleteNote" })
        }
        scope.cancel()
    }

    // The editor's delete asks nothing: it leaves at once, nothing is sent, and the way back is the
    // room's transient — which this editor is no longer standing in front of.
    @Test
    fun testDeletingANoteLeavesTheEditorAtOnceAndSendsNothingWhileTheWindowRuns() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        runBlocking { server.writeNote("note_1", NoteWrite("Tone", "keep it short")) }
        val store = store(scope, server, signedIn = true)
        val note = Note(id = "note_1", title = "Tone", body = "keep it short")
        var done = 0
        compose.setContent {
            NoteEditorScreen(
                note = note, seedTitle = "", store = store, backTo = Notes.title,
                onBack = {}, onDone = { done += 1 },
            )
        }

        compose.onNodeWithText(Notes.delete).performClick()
        compose.runOnIdle {
            assertEquals("the editor leaves on the tap", 1, done)
            assertEquals(listOf("note_1"), store.withheld.map { it.subjectId })
            assertEquals(emptyList<String>(), server.calls.filter { it == "deleteNote" })
            assertEquals("Note deleted.", works.windmill.gym.store.Withheld.line(store.withheld))
        }
        scope.cancel()
    }

    // Where a title starts when a drag handle sits before it: the screen's edge, the rail, the gap.
    private val pastTheRail: Float
        get() = with(compose.density) { (WindmillSpace.x4 + 32.dp + WindmillSpace.x2).toPx() }

    // The unmerged tree: the merged node for a title is the whole clickable row.
    private fun titleX(title: String): Float =
        compose.onNodeWithText(title, useUnmergedTree = true).fetchSemanticsNode().positionInRoot.x

    // One note has no order to explain: no caption and no handle, the same rule as web and iOS.
    @Test
    fun testOneNoteDrawsNeitherTheCaptionNorTheHandle() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        runBlocking { server.writeNote("note_0", NoteWrite("note 0", "line 0")) }
        val store = store(scope, server, signedIn = true)

        compose.setContent {
            NotesScreen(
                store = store,
                isSignedIn = true,
                backTo = "Coach",
                onBack = {},
                onEdit = { _, _ -> },
                onSignIn = {},
                say = {},
            )
        }

        compose.onNodeWithText("note 0").assertIsDisplayed()
        compose.onNodeWithText(Notes.topWins).assertDoesNotExist()
        assertTrue("no handle before the title: x=${titleX("note 0")}", titleX("note 0") < pastTheRail)
        scope.cancel()
    }

    @Test
    fun testSignedOutTheScreenIsASignInDoor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server, signedIn = false)
        val doors = mutableListOf<String>()

        compose.setContent {
            NotesScreen(
                store = store,
                isSignedIn = false,
                backTo = "Gym",
                onBack = {},
                onEdit = { _, _ -> doors += "edit" },
                onSignIn = { doors += "signIn" },
                say = {},
            )
        }

        compose.onNodeWithText(Notes.signedOut).assertIsDisplayed()
        compose.onNodeWithText("Sign in").performClick()
        compose.runOnIdle {
            assertEquals(listOf("signIn"), doors)
            assertEquals("nothing was read from the log", emptyList<String>(), server.calls.filter { it == "notes" })
        }
        scope.cancel()
    }

    private fun threeNotes(server: FakeTraining) = runBlocking {
        repeat(3) { server.writeNote("note_$it", NoteWrite("note $it", "line $it")) }
    }

    // Top of the screen first: the order the rows are drawn in, read off their positions.
    private fun drawnOrder(vararg titles: String): List<String> = titles
        .sortedBy { compose.onNodeWithText(it).fetchSemanticsNode().positionInRoot.y }

    private fun dragBelowTheNextRow(title: String) {
        val row = compose.onNodeWithText(title).fetchSemanticsNode()
        val step = row.size.height * 1.4f / 7
        val handleX = with(compose.density) { 16.dp.toPx() }
        compose.onNodeWithText(title).performTouchInput {
            down(Offset(handleX, centerY))
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 200)
            repeat(7) { moveBy(Offset(0f, step)) }
            up()
        }
    }

    @Test
    fun testAnOrderTheLogRefusesIsNotLeftOnScreen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        threeNotes(server)
        val store = store(scope, server, signedIn = true)
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
        server.refuseNotes = WindmillApiException.Refused(500, Refusal(message = "internal error", code = null))

        dragBelowTheNextRow("note 0")

        compose.runOnIdle {
            assertEquals(listOf("reorderNotes"), server.calls.filter { it == "reorderNotes" })
            assertEquals(listOf("note_0", "note_1", "note_2"), server.notebook.map { it.id })
            assertTrue("the refusal reaches the room", said.filterNotNull().any { it.contains("internal error") })
        }
        assertEquals("the list says what the log holds, not the order it refused",
            listOf("note 0", "note 1", "note 2"), drawnOrder("note 0", "note 1", "note 2"))
        scope.cancel()
    }

    @Test
    fun testADragTheLogAcceptsIsTheNewOrder() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        threeNotes(server)
        val store = store(scope, server, signedIn = true)

        compose.setContent {
            NotesScreen(
                store = store,
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
            assertEquals("calls: ${server.calls}", listOf("note_1", "note_0", "note_2"), server.notebook.map { it.id })
        }
        assertEquals(listOf("note 1", "note 0", "note 2"), drawnOrder("note 0", "note 1", "note 2"))
        scope.cancel()
    }

    // A drag inside an open delete window. The rows on screen are not all the notes there are, and
    // the log refuses an order that does not name every one of them — so the withheld note keeps the
    // place it stands in and the drawn rows fill the rest around it.
    @Test
    fun testADragInsideAnOpenDeleteWindowStillNamesTheWithheldNote() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        threeNotes(server)
        val store = store(scope, server, signedIn = true)
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

        compose.runOnIdle { store.withhold(Deletion.Note("note_1")) }
        compose.onNodeWithText("note 1").assertDoesNotExist()

        dragBelowTheNextRow("note 0")

        compose.runOnIdle {
            assertEquals("the order names all three, with note 1 where it stands",
                listOf("note_2", "note_1", "note_0"), server.notebook.map { it.id })
            assertEquals("nothing was refused", emptyList<String>(), said.filterNotNull())
            assertEquals("and the window is still holding its note",
                emptyList<String>(), server.calls.filter { it == "deleteNote" })
        }
        assertEquals(listOf("note 2", "note 0"), drawnOrder("note 0", "note 2"))
        compose.onNodeWithText("note 1").assertDoesNotExist()
        scope.cancel()
    }

    // The drag is half-built until a screen reader can do the same: every row offers Move up / Move
    // down as custom actions, one step at a time, and the top and bottom rows offer only the one.
    @Test
    fun testARowCanBeMovedUpOrDownWithoutADrag() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        threeNotes(server)
        val store = store(scope, server, signedIn = true)

        compose.setContent {
            NotesScreen(
                store = store,
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

        compose.runOnIdle {
            assertEquals(listOf("note_0", "note_2", "note_1"), server.notebook.map { it.id })
        }
        assertEquals(listOf("note 0", "note 2", "note 1"), drawnOrder("note 0", "note 1", "note 2"))
        scope.cancel()
    }
}
