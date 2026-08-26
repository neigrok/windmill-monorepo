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
@Config(sdk = [35])
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
                backLabel = "Coach",
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
                backLabel = "Coach",
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
                backLabel = "Coach",
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
                backLabel = "Gym",
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
                backLabel = "Coach",
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
                backLabel = "Coach",
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
                backLabel = "Coach",
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
