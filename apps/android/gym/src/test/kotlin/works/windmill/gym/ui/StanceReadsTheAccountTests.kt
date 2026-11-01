package works.windmill.gym.ui

import works.windmill.gym.coach.ThreadsScreen
import android.os.Looper
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.gym.GymRoom
import works.windmill.gym.coach.AskThread
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.coach.Threads
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.Older
import works.windmill.gym.store.Withheld
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException

// `docs/design/guidelines/system-architecture.md` §3: a window decides which ROWS are drawn; it never decides what state a
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
    @get:Rule(order = 0)
    val tmp = TemporaryFolder()

    private val rooms = mutableListOf<EngineRoomFixture>()

    // The rooms close after the compose rule has torn the screen down: leaving the room flushes the
    // store, so its engine must still be open.
    @get:Rule(order = 1)
    val closing = object : ExternalResource() {
        override fun after() = rooms.forEach(EngineRoomFixture::close)
    }

    @get:Rule(order = 2)
    val compose = createComposeRule()

    // ONE seat for the whole test: the room re-connects on the way in, and a connect for a seat the
    // store does not already hold is an ARRIVAL, which abandons every open window.
    private val account = Account(
        origin = "https://windmill.works",
        user = User(id = "u1", email = "sam@example.com", name = "Sam"),
    )

    private fun room(
        scope: CoroutineScope,
        rest: FakeGymRest = FakeGymRest(),
        undoWindowMs: Long = Withheld.windowMs,
        startingAt: Long = 1_800_000_000_000L,
    ): EngineRoomFixture = EngineRoomFixture(tmp.newFolder(), scope, rest = rest, undoWindowMs = undoWindowMs).also { room ->
        rooms += room
        room.now = startingAt
        runBlocking {
            room.select("u1")
            room.pull(EngineRoomFixture.server())
            room.store.connect(account)
        }
    }

    // The finish re-reads the log in the room's scope.
    private fun oneWorkout(room: EngineRoomFixture): works.windmill.gym.presentation.Session {
        val workout = room.scope.async { room.workout().also { room.store.refreshEngine() } }
        compose.waitUntil(10_000) { shadowOf(Looper.getMainLooper()).idle(); workout.isCompleted }
        return runBlocking { workout.await() }
    }

    // The log's own two silences. `No workouts yet` is the never-trained stance and `opening the
    // log…` is the read still in flight; a window holding the only row is neither, and the account
    // still has the workout the head would otherwise be counting.
    @Test
    fun theLogDrawsNeitherSilenceOverASessionTheAccountStillHolds() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = room(scope)
        val store = room.store
        val session = oneWorkout(room)
        compose.setContent {
            LogScreen(store = store, seat = "", onOpenSession = {}, onOpenBodyweight = {},
                onShareSession = {}, onDiscardSession = {})
        }
        compose.onNodeWithText("No workouts yet").assertDoesNotExist()

        compose.runOnIdle { store.withhold(Deletion.Session(session.id)) }

        compose.onNodeWithText("No workouts yet").assertDoesNotExist()
        compose.onNodeWithText("Your training will land here.").assertDoesNotExist()
        compose.onNodeWithText("opening the log…").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("the row is off the screen", emptyList<String>(), store.recent.map { it.id })
            assertEquals("and still on the account, which is what Undo puts back",
                listOf(session.id), store.allSessions.map { it.id })
        }

        // And the second half: the settled delete leaves the READ, so the invitation becomes true
        // rather than never being drawn again.
        val deleted = compose.runOnIdle { scope.async { store.settleWithheld(session.id) } }
        compose.waitUntil(10_000) { compose.runOnIdle { deleted.isCompleted } }
        runBlocking { deleted.await() }
        compose.runOnIdle { assertEquals(emptyList<String>(), store.allSessions.map { it.id }) }
        compose.onNodeWithText("No workouts yet").assertIsDisplayed()
        scope.cancel()
    }

    // The sharpest of them: this stance carries a drawn primary. `Build a routine` is an ACT offered
    // over a program that still has one, and the position a new routine is written at is the
    // program's length — not the drawn list's, or the window would file it on top of the routine it
    // is holding.
    @Test
    fun theRoutinesHomeOffersItsEmptyStateAfterTheLastRoutineIsDeleted() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try {
            val store = room(scope).store
            runBlocking { store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) }
            val drafts = mutableListOf<RoutineDraft>()
            compose.setContent {
                RoutinesScreen(store = store, lookedAt = emptySet(), seat = "s",
                    onBuild = { drafts += it }, onOpenRoutine = {}, onDeleteRoutine = { true }, onReview = {})
            }
            val id = store.routines.single().id
            compose.runOnIdle { runBlocking { assertNull(store.delete(Deletion.Routine(id, "Push Day"))) } }
            compose.onNodeWithText("Push Day").assertDoesNotExist()
            compose.onNodeWithText("No routines yet.").assertIsDisplayed()
            compose.onNodeWithContentDescription("New routine").performClick()
            compose.runOnIdle {
                assertEquals(listOf(0), drafts.map { it.position })
                assertEquals(emptyList<String>(), store.allRoutines.map { it.name })
                assertNull(store.keepWithheld())
            }
            compose.onNodeWithText("Start logging").assertDoesNotExist()
        } finally { scope.cancel() }
    }

    @Test
    fun theThreadsRoomReadsTheAccountAndADeletedConversationNeverComesBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val server = FakeGymRest()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val store = room(scope, server).store
        compose.setContent { ThreadsScreen(store, "Coach", {}, {}, {}) }
        compose.onNodeWithText("why is my bench stalled?").assertIsDisplayed()
        val deleted = compose.runOnIdle { scope.async { store.coach.deleteThread("thr_1") } }
        compose.waitUntil(5_000) { deleted.isCompleted }
        assertEquals(GymResult.Ok(Unit), runBlocking { deleted.await() })
        compose.runOnIdle {
            assertEquals(emptyList<AskThread>(), store.coach.allThreads)
            assertEquals(emptySet<String>(), server.conversations.keys)
            assertEquals(emptyList<Any>(), store.withheld)
        }
        compose.onNodeWithText(Threads.none).assertIsDisplayed()
        compose.onNodeWithText("why is my bench stalled?").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun theLogFootNamesTheDayTheAccountStartedAndNotTheOldestRowDrawn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val day = 24L * 60 * 60 * 1000
        val room = room(scope, startingAt = 1_700_000_000_000L)
        val store = room.store
        val old = oneWorkout(room)
        room.now = old.startedAtMs + 30 * day
        val new = oneWorkout(room)
        val oldMs = old.startedAtMs
        val newMs = new.startedAtMs
        assertEquals("the log is read to its bottom, which is when the foot says this at all",
            Older.End, store.older)
        compose.setContent {
            LogScreen(store = store, seat = "", onOpenSession = {}, onOpenBodyweight = {},
                onShareSession = {}, onDiscardSession = {})
        }
        compose.onNodeWithText("First workout · ${Readout.date(oldMs)}").performScrollTo().assertIsDisplayed()

        compose.runOnIdle { store.withhold(Deletion.Session(old.id)) }

        compose.onNodeWithText("First workout · ${Readout.date(oldMs)}").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("First workout · ${Readout.date(newMs)}").assertDoesNotExist()

        // And the settled delete moves it, once, to the day the account actually started on. The
        // re-read is not enough on its own: a row deeper than the page it answers with is folded
        // straight back in, so the discard has to leave the READ itself.
        val deleted = compose.runOnIdle { scope.async { store.settleWithheld(old.id) } }
        compose.waitUntil(10_000) { compose.runOnIdle { deleted.isCompleted } }
        runBlocking { deleted.await() }
        compose.runOnIdle {
            assertEquals("the log let go of it and never drew it again",
                listOf(new.id), store.allSessions.map { it.id })
        }
        compose.onNodeWithText("First workout · ${Readout.date(newMs)}").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("First workout · ${Readout.date(oldMs)}").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun aFailedHistoryRefreshKeepsOwnerScopedRowsUnderTheFailureLine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeGymRest()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val store = room(scope, server).store
        runBlocking { store.coach.readThreads() }
        server.refuseThreads = IOException("offline")

        compose.setContent {
            ThreadsScreen(store = store, backTo = "Coach", onBack = {}, onOpen = {},
                onAskNew = {})
        }

        compose.onNodeWithText(Threads.outOfReach).assertIsDisplayed()
        compose.onNodeWithText("why is my bench stalled?").assertIsDisplayed()
        compose.onNodeWithText("Your conversations").assertDoesNotExist()
        compose.onNodeWithText(Threads.none).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("the owner-scoped archive retains the received conversation",
                listOf("thr_1"), store.coach.allThreads.map { it.id })
        }
        scope.cancel()
    }

    @Test
    fun anAlreadyDeletedConversationStillLeavesTheLocalArchive() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val server = FakeGymRest()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val store = room(scope, server).store
        runBlocking { store.coach.readThreads() }
        server.refuseThreads = WindmillApiException.Refused(404, Refusal(message = "no such conversation"))
        val deleted = scope.async { store.coach.deleteThread("thr_1") }
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        assertTrue(deleted.isCompleted)
        assertEquals(GymResult.Ok(Unit), runBlocking { deleted.await() })
        assertEquals(emptyList<AskThread>(), store.coach.allThreads)
        assertEquals(emptyList<Any>(), store.withheld)
        scope.cancel()
    }

    // `Your first session` is a stance about the ACCOUNT written into the finish receipt, and the
    // receipt is raised the instant a workout closes — with any window still open. A session deleted
    // a moment ago is still the account's, so the workout just finished is not the first.
    @Test
    fun theFinishReceiptIsNotAFirstSessionOverALogHoldingAnother() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        // Long enough that the receipt is read while the window is still open, not after it settles.
        val room = room(scope, undoWindowMs = 120_000, startingAt = 1_700_000_000_000L)
        val store = room.store
        val old = oneWorkout(room)
        room.now = 1_800_000_000_000L
        val started = scope.async {
            room.startExternalWorkout()
            store.choose("back-squat")
            store.logSet(100.0, 5)
        }
        compose.waitUntil(10_000) { shadowOf(Looper.getMainLooper()).idle(); started.isCompleted }
        runBlocking { started.await() }
        store.withhold(Deletion.Session(old.id))

        compose.setContent { GymMaterial { GymRoom(account, store) } }
        compose.waitForIdle()
        compose.onNodeWithText("Finish").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Ended early.").fetchSemanticsNodes().isNotEmpty()
        }

        compose.runOnIdle {
            assertEquals("one row drawn", 1, store.recent.size)
            assertEquals("and two on the account", 2, store.allSessions.size)
        }
        compose.onNodeWithText("Your first session").assertDoesNotExist()
        scope.cancel()
    }
}
