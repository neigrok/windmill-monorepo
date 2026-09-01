package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.GymRoom
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.Threads
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.Older
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

// `13-gestures.md:214-215`: a window decides which ROWS are drawn; it never decides what state a
// screen is in. The three rooms below each read a list the withheld window thins, and each of them
// used to read its STANCE off that list — so deleting the only session, the only routine or the only
// conversation put the room into the stance for a lifter who has never had one, with Undo still on
// screen and the account still holding it.
//
// Every case here proves BOTH directions, because the stance alone is only half a fix: a settled
// delete has to leave the READ as well as the drawn rows, or the room says nothing at all forever —
// the row is gone, the account's list still holds it, and neither the rows nor the stance are drawn.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class StanceReadsTheAccountTests {
    @get:Rule
    val compose = createComposeRule()

    // ONE seat for the whole test: the room re-connects on the way in, and a connect for a seat the
    // store does not already hold is an ARRIVAL, which abandons every open window.
    private val account = Account(
        api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
        user = User(id = "u1", email = "sam@example.com", name = "Sam"),
    )

    private fun store(
        scope: CoroutineScope,
        server: FakeTraining,
        undoWindowMs: Long = SetQueue.undoWindowMs,
    ): TrainingStore {
        val root = File(System.getProperty("java.io.tmpdir"), "stance-${System.nanoTime()}")
        root.mkdirs()
        val store = TrainingStore(
            queue = SetQueue(File(root, "queue.json")),
            deviceCopy = DeviceCopy(File(root, "catalog.json")),
            localLog = LocalLog(File(root, "local.json")),
            localPreferences = LocalPreferences(File(root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            undoWindowMs = undoWindowMs,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking { store.connect(account) }
        return store
    }

    private fun oneWorkout(store: TrainingStore) = runBlocking {
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        store.flushPendingSets(force = true)
        store.finish()
    }

    // The log's own two silences. `No sessions yet.` is the never-trained stance and `opening the
    // log…` is the read still in flight; a window holding the only row is neither, and the account
    // still has the workout the head would otherwise be counting.
    @Test
    fun theLogDrawsNeitherSilenceOverASessionTheAccountStillHolds() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        oneWorkout(store)
        compose.setContent {
            LogScreen(store = store, seat = "", onOpenSession = {}, onOpenBodyweight = {},
                onShareSession = {}, onDiscardSession = {})
        }
        compose.onNodeWithText("No sessions yet.").assertDoesNotExist()

        compose.runOnIdle { store.withhold(Deletion.Session("ses_1")) }

        compose.onNodeWithText("No sessions yet.").assertDoesNotExist()
        compose.onNodeWithText("The first one you log lands here, newest first.").assertDoesNotExist()
        compose.onNodeWithText("opening the log…").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("the row is off the screen", emptyList<String>(), store.recent.map { it.id })
            assertEquals("and still on the account, which is what Undo puts back",
                listOf("ses_1"), store.allSessions.map { it.id })
        }

        // And the second half: the settled delete leaves the READ, so the invitation becomes true
        // rather than never being drawn again.
        compose.runOnIdle { runBlocking { store.settleWithheld("ses_1") } }
        compose.runOnIdle { assertEquals(emptyList<String>(), store.allSessions.map { it.id }) }
        compose.onNodeWithText("No sessions yet.").assertIsDisplayed()
        scope.cancel()
    }

    // The sharpest of them: this stance carries a drawn primary. `Build a routine` is an ACT offered
    // over a program that still has one, and the position a new routine is written at is the
    // program's length — not the drawn list's, or the window would file it on top of the routine it
    // is holding.
    @Test
    fun theRoutinesHomeNeverOffersToBuildTheFirstOverAProgramThatStillHasOne() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope, FakeTraining())
        runBlocking { store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) }
        val drafts = mutableListOf<RoutineDraft>()
        compose.setContent {
            RoutinesScreen(
                store = store, isSignedIn = true, lookedAt = emptySet(), seat = "s",
                onJustStart = {}, onBuild = { drafts += it }, onOpenRoutine = {},
                onDeleteRoutine = {}, onReview = {}, onOpenSettings = {}, onSignIn = {},
            )
        }
        val id = store.routines.single().id

        compose.runOnIdle { store.withhold(Deletion.Routine(id, "Push Day")) }

        compose.onNodeWithText("No routines yet").assertDoesNotExist()
        compose.onNodeWithText("Build a routine").assertDoesNotExist()
        compose.onNodeWithText("Push Day").assertDoesNotExist()
        compose.onNodeWithContentDescription("New routine").performClick()
        compose.runOnIdle {
            assertEquals("the program still holds it, so the next routine goes after it",
                listOf(1), drafts.map { it.position })
            assertEquals(listOf("Push Day"), store.allRoutines.map { it.name })
        }

        compose.runOnIdle { runBlocking { store.settleWithheld(id) } }
        compose.runOnIdle { assertEquals(emptyList<String>(), store.allRoutines.map { it.name }) }
        compose.onNodeWithText("No routines yet").assertIsDisplayed()
        compose.onNodeWithText("Build a routine").assertIsDisplayed()
        scope.cancel()
    }

    // The threads room read a list it held ITSELF, refreshed once on the way in — so the stance was
    // the window's twice over, and a conversation whose window closed came BACK on the next
    // recomposition, off a snapshot nothing had corrected. The list is the room's now, and the
    // stance reads the account.
    @Test
    fun theThreadsRoomReadsTheAccountAndADeletedConversationNeverComesBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val store = store(scope, server)
        compose.setContent {
            ThreadsScreen(store = store, backTo = "Coach", onBack = {}, onOpen = {},
                onDelete = {}, onAskNew = {})
        }
        compose.onNodeWithText("why is my bench stalled?").assertIsDisplayed()
        compose.onNodeWithText(Threads.counted(1)).assertIsDisplayed()

        compose.runOnIdle { store.withhold(Deletion.Thread("thr_1")) }

        compose.onNodeWithText(Threads.none).assertDoesNotExist()
        compose.onNodeWithText("why is my bench stalled?").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("the count captions rows, and there are none to caption",
                emptyList<AskThread>(), store.threads)
            assertEquals("while the account still holds the conversation",
                listOf("thr_1"), store.allThreads.map { it.id })
        }

        compose.runOnIdle { runBlocking { store.settleWithheld("thr_1") } }
        compose.runOnIdle {
            assertTrue("the log took it", "thr_1" !in server.conversations)
            assertEquals("and the READ lost it with the row", emptyList<AskThread>(), store.allThreads)
        }
        compose.onNodeWithText(Threads.none).assertIsDisplayed()
        compose.onNodeWithText("why is my bench stalled?").assertDoesNotExist()
        // The count captions rows, so an emptied account draws its silence and no `0 conversations`
        // over it.
        compose.onNodeWithText(Threads.counted(0)).assertDoesNotExist()
        scope.cancel()
    }

    // `firstSession` opens the movement picker with a first-session title and a drawn
    // `Build my routine`, so it is a stance and not a row. Deleting the only workout used to put a
    // returning lifter back in the room where nothing has ever happened.
    @Test
    fun theFirstSessionStanceReadsTheAccountAndTheSettledDiscardBringsItBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        oneWorkout(store)
        assertFalse("the log holds a workout", store.firstSession)

        store.withhold(Deletion.Session("ses_1"))
        assertFalse("and still does while a window is holding its row", store.firstSession)

        runBlocking { store.settleWithheld("ses_1") }
        assertTrue("the account is empty now, and the log said so", store.firstSession)
        scope.cancel()
    }

    // The log's foot names the day training STARTED, which is a claim about the account and not a
    // caption on the rows: a window holding the oldest row used to move it a month, and say so with
    // Undo still on screen.
    @Test
    fun theLogFootNamesTheDayTheAccountStartedAndNotTheOldestRowDrawn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val day = 24L * 60 * 60 * 1000
        val oldMs = 1_700_000_000_000L
        val newMs = oldMs + 30 * day
        server.stored["ses_old"] =
            Session(id = "ses_old", startedAtMs = oldMs, finishedAtMs = oldMs + 3_600_000)
        server.stored["ses_new"] =
            Session(id = "ses_new", startedAtMs = newMs, finishedAtMs = newMs + 3_600_000)
        val store = store(scope, server)
        assertEquals("the log is read to its bottom, which is when the foot says this at all",
            Older.End, store.older)
        compose.setContent {
            LogScreen(store = store, seat = "", onOpenSession = {}, onOpenBodyweight = {},
                onShareSession = {}, onDiscardSession = {})
        }
        compose.onNodeWithText("first session · ${Readout.date(oldMs)}").assertIsDisplayed()

        compose.runOnIdle { store.withhold(Deletion.Session("ses_old")) }

        compose.onNodeWithText("first session · ${Readout.date(oldMs)}").assertIsDisplayed()
        compose.onNodeWithText("first session · ${Readout.date(newMs)}").assertDoesNotExist()

        // And the settled delete moves it, once, to the day the account actually started on. The
        // re-read is not enough on its own: a row deeper than the page it answers with is folded
        // straight back in, so the discard has to leave the READ itself.
        compose.runOnIdle { runBlocking { store.settleWithheld("ses_old") } }
        compose.runOnIdle {
            assertEquals("the log let go of it and never drew it again",
                listOf("ses_new"), store.allSessions.map { it.id })
        }
        compose.onNodeWithText("first session · ${Readout.date(newMs)}").assertIsDisplayed()
        compose.onNodeWithText("first session · ${Readout.date(oldMs)}").assertDoesNotExist()
        scope.cancel()
    }

    // The room holds the conversations, and that is a store for the WINDOW to survive — not a cache
    // to draw from. An outcome is derived by the server from the proposals, so a list this entry
    // could not re-read would call an applied proposal `waiting`, under a line saying the
    // conversations are out of reach. A read this entry never landed draws nothing at all.
    @Test
    fun aThreadsReadThisEntryCouldNotMakeDrawsNoRowsAndNoCount() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val store = store(scope, server)
        runBlocking { store.readThreads() }
        server.refuseThreads = IOException("offline")

        compose.setContent {
            ThreadsScreen(store = store, backTo = "Coach", onBack = {}, onOpen = {},
                onDelete = {}, onAskNew = {})
        }

        compose.onNodeWithText(Threads.outOfReach).assertIsDisplayed()
        compose.onNodeWithText("why is my bench stalled?").assertDoesNotExist()
        compose.onNodeWithText(Threads.counted(1)).assertDoesNotExist()
        // A list that could not be read is not an empty one either, so the never-asked stance stays
        // off as well.
        compose.onNodeWithText(Threads.none).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("the room keeps what it last read, and the screen declines to draw it",
                listOf("thr_1"), store.allThreads.map { it.id })
        }
        scope.cancel()
    }

    // The 404 is the log saying the conversation is already gone, and this room answers it as
    // success — so it owes the same fold as the 200: a read still holding the row would put it back
    // on screen the moment the window closed.
    @Test
    fun aSettledThreadDeleteTheLogHasAlreadyForgottenStillLeavesTheRead() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val store = store(scope, server)
        runBlocking { store.readThreads() }
        server.refuseThreads = WindmillApiException.Refused(
            404, Refusal(message = "no such conversation"))

        store.withhold(Deletion.Thread("thr_1"))
        assertEquals("the row is off the screen", emptyList<AskThread>(), store.threads)
        assertEquals("and still on the account", listOf("thr_1"), store.allThreads.map { it.id })

        val failure = runBlocking { store.settleWithheld("thr_1") }

        assertEquals("a conversation the log has already forgotten is not a refusal", null, failure)
        assertEquals("and the READ lost it just as it does on the 200",
            emptyList<AskThread>(), store.allThreads)
        scope.cancel()
    }

    // A duplicate is FILED, and a position minted off the drawn list collides with the routine the
    // window is holding. The write reads the program, like the stance above it.
    @Test
    fun aDuplicateIsFiledAfterEveryRoutineTheProgramHolds() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope, FakeTraining())
        runBlocking {
            store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press"))
            store.saveRoutine(RoutineDraft(name = "Pull Day", position = 1).adding("barbell-row"))
        }
        val drafts = mutableListOf<RoutineDraft>()
        compose.setContent {
            RoutinesScreen(
                store = store, isSignedIn = true, lookedAt = emptySet(), seat = "s",
                onJustStart = {}, onBuild = { drafts += it }, onOpenRoutine = {},
                onDeleteRoutine = {}, onReview = {}, onOpenSettings = {}, onSignIn = {},
            )
        }
        val pull = store.allRoutines.single { it.name == "Pull Day" }

        compose.runOnIdle { store.withhold(Deletion.Routine(pull.id, "Pull Day")) }
        compose.onNodeWithContentDescription("More for Push Day").performClick()
        compose.onNodeWithText("Duplicate").performClick()

        compose.runOnIdle {
            assertEquals("the program still holds two, so the copy is filed third",
                listOf(2), drafts.map { it.position })
            assertEquals(listOf("Push Day"), store.routines.map { it.name })
        }
        scope.cancel()
    }

    // `Your first session` is a stance about the ACCOUNT written into the finish receipt, and the
    // receipt is raised the instant a workout closes — with any window still open. A session deleted
    // a moment ago is still the account's, so the workout just finished is not the first.
    @Test
    fun theFinishReceiptIsNotAFirstSessionOverALogHoldingAnother() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val oldMs = 1_700_000_000_000L
        server.stored["ses_old"] =
            Session(id = "ses_old", startedAtMs = oldMs, finishedAtMs = oldMs + 3_600_000)
        // Long enough that the receipt is read while the window is still open, not after it settles.
        val store = store(scope, server, undoWindowMs = 120_000)
        runBlocking {
            store.start(null)
            store.choose("back-squat")
            store.logSet(100.0, 5)
        }
        store.withhold(Deletion.Session("ses_old"))

        compose.setContent { GymMaterial { GymRoom(account, store) } }
        compose.waitForIdle()
        compose.onNodeWithText("Finish").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Session finished").fetchSemanticsNodes().isNotEmpty()
        }

        compose.runOnIdle {
            assertEquals("one row drawn", 1, store.recent.size)
            assertEquals("and two on the account", 2, store.allSessions.size)
        }
        compose.onNodeWithText("Your first session").assertDoesNotExist()
        scope.cancel()
    }
}
