package works.windmill.gym.ui

import android.os.Looper
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
import works.windmill.gym.coach.ConversationRow
import works.windmill.gym.coach.LocalCoach
import works.windmill.gym.coach.Threads
import works.windmill.gym.coach.ThreadsBinding
import works.windmill.gym.coach.ThreadsScreen
import works.windmill.gym.coach.heldConversation
import works.windmill.gym.coach.heldThreads
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.DeleteConversation
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.Session
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.Older
import works.windmill.gym.store.Withheld
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.api.Change
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

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
        undoWindowMs: Long = Withheld.windowMs,
        startingAt: Long = 1_800_000_000_000L,
        localCoach: LocalCoach? = null,
        telemetry: Telemetry = Telemetry.None,
    ): EngineRoomFixture = EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest(), undoWindowMs = undoWindowMs,
        telemetry = telemetry, localCoach = localCoach, coachServer = ScriptedTurns(emptyList())).also { room ->
        rooms += room
        room.now = startingAt
        runBlocking {
            room.select("u1")
            room.pull(EngineRoomFixture.server())
            room.store.connect(account)
        }
    }

    // The finish re-reads the log in the room's scope.
    private fun oneWorkout(room: EngineRoomFixture): Session {
        val workout = room.scope.async { room.workout().also { room.store.refreshEngine() } }
        compose.waitUntil(10_000) { shadowOf(Looper.getMainLooper()).idle(); workout.isCompleted }
        return runBlocking { workout.await() }
    }

    // `No workouts yet` is the never-trained stance: it is not drawn over a workout the account holds, and a
    // discard leaves the READ, so the invitation becomes true rather than never being drawn again.
    @Test
    fun theLogInvitesTheFirstWorkoutOnlyOnceTheAccountHoldsNone() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = room(scope)
        val store = room.store
        val session = oneWorkout(room)
        compose.setContent {
            LogBinding(store).let { log -> LogScreen(state = log, events = log, seat = "", onOpenSession = {}, onOpenBodyweight = {},
                onShareSession = {}, onDiscardSession = {}) }
        }
        compose.onNodeWithText("No workouts yet").assertDoesNotExist()
        compose.onNodeWithText("Your training will land here.").assertDoesNotExist()
        compose.onNodeWithText("opening the log…").assertDoesNotExist()

        val deleted = compose.runOnIdle { scope.async { store.workout.discard(session.id) } }
        compose.waitUntil(10_000) { compose.runOnIdle { deleted.isCompleted } }
        runBlocking { deleted.await() }
        compose.runOnIdle { assertEquals(emptyList<String>(), store.history.allSessions.map { it.id }) }
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
            runBlocking { store.routines.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) }
            val drafts = mutableListOf<RoutineDraft>()
            val routinesHome = RoutinesBinding(store)
            compose.setContent {
                RoutinesScreen(state = routinesHome, events = routinesHome, lookedAt = emptySet(), seat = "s",
                    onBuild = { drafts += it }, onOpenRoutine = {}, onDeleteRoutine = { true }, onReview = {})
            }
            val id = store.routines.all.single().id
            val deletingRoutine = compose.runOnIdle { scope.async { assertNull(store.deletions.delete(Deletion.Routine(id, "Push Day"))) } }
            compose.waitUntil(10_000) { compose.runOnIdle { deletingRoutine.isCompleted } }
            runBlocking { deletingRoutine.await() }
            compose.onNodeWithText("Push Day").assertDoesNotExist()
            compose.onNodeWithText("No routines yet.").assertIsDisplayed()
            compose.onNodeWithContentDescription("New routine").performClick()
            compose.runOnIdle {
                assertEquals(listOf(0), drafts.map { it.position })
                assertEquals(emptyList<String>(), store.routines.all.map { it.name })
                assertNull(store.deletions.keepWithheld())
            }
            compose.onNodeWithText("Start logging").assertDoesNotExist()
        } finally { scope.cancel() }
    }

    @Test
    fun theThreadsRoomReadsTheAccountAndADeletedConversationNeverComesBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val room = room(scope)
        val store = room.store
        val thread = room.heldConversation("why is my bench stalled?")
        store.observeEngine()
        val threads = ThreadsBinding(store.coach)
        compose.setContent { ThreadsScreen(threads, threads, "Coach", {}, {}, {}) }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("why is my bench stalled?").fetchSemanticsNodes().isNotEmpty() }
        val deleted = compose.runOnIdle { scope.async { store.coach.deleteThread(thread) } }
        compose.waitUntil(5_000) { compose.runOnIdle { deleted.isCompleted } }
        assertEquals(GymResult.Ok(Unit), runBlocking { deleted.await() })
        compose.runOnIdle {
            assertEquals(emptyList<ConversationRow>(), store.coach.history)
            assertEquals(emptyList<CoachThread>(), room.heldThreads())
            assertEquals(emptyList<Any>(), store.held.withheld)
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
            Older.End, store.history.older)
        compose.setContent {
            LogBinding(store).let { log -> LogScreen(state = log, events = log, seat = "", onOpenSession = {}, onOpenBodyweight = {},
                onShareSession = {}, onDiscardSession = {}) }
        }
        compose.onNodeWithText("First workout · ${Readout.date(oldMs)}").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("First workout · ${Readout.date(newMs)}").assertDoesNotExist()

        // A discard moves it, once, to the day the account actually started on. The re-read is not enough on
        // its own: a row deeper than the page it answers with is folded straight back in, so the discard has
        // to leave the READ itself.
        val deleted = compose.runOnIdle { scope.async { store.workout.discard(old.id) } }
        compose.waitUntil(10_000) { compose.runOnIdle { deleted.isCompleted } }
        runBlocking { deleted.await() }
        compose.runOnIdle {
            assertEquals("the log let go of it and never drew it again",
                listOf(new.id), store.history.allSessions.map { it.id })
        }
        compose.onNodeWithText("First workout · ${Readout.date(newMs)}").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("First workout · ${Readout.date(oldMs)}").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun anUnreadableRecordCostsThatRecordAndKeepsTheRowsAndIsReportedOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) = Unit
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation + ":" + error.message }
        }
        val room = room(scope, telemetry = telemetry)
        val store = room.store
        val thread = room.heldConversation("why is my bench stalled?", "Hold the load.")
        assertTrue(room.engine.commit(ScopeRef(Gym.scope), Gesture(listOf(Change.create(Gym.Types.message, NewID.Given(RecordID("msgLaterBuild0001")), mapOf(
            "threadId" to Json.of(thread), "role" to Json.of("a_later_role"), "at" to Json.of(room.now), "text" to Json.of("private answer"),
            "state" to Json.of("completed"), "calls" to Json.array()))))) is CommitOutcome.Committed)
        store.observeEngine()
        val threads = ThreadsBinding(store.coach)
        compose.setContent { ThreadsScreen(state = threads, events = threads, backTo = "Coach", onBack = {}, onOpen = {}, onAskNew = {}) }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("why is my bench stalled?").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Hold the load.").assertIsDisplayed()
        compose.onNodeWithText(Threads.none).assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf(ConversationRow(thread, "why is my bench stalled?", store.coach.history.single().askedAtMs, answerPreview = "Hold the load.")), store.coach.history) }
        assertEquals(listOf("gym.readConversation:coach-record-unreadable"), failures)
        scope.cancel()
    }

    @Test
    fun anAlreadyDeletedConversationStillLeavesTheLocalArchive() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val disk = LocalCoach(File(tmp.newFolder(), LocalCoach.fileName))
        val room = room(scope, localCoach = disk)
        val store = room.store
        val thread = room.heldConversation("why is my bench stalled?")
        store.coach.selectChat(thread)
        assertEquals(listOf(thread), disk.chats("u1").map { it.id })
        // Another phone deleted it, and that delete has reached this one.
        val elsewhere = ActionRunner(room.engine, room.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
        assertTrue(elsewhere.run(DeleteConversation(Id(thread, CoachThread))) is Outcome.Committed)
        val deleted = scope.async { store.coach.deleteThread(thread) }
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        assertTrue(deleted.isCompleted)
        assertEquals(GymResult.Ok(Unit), runBlocking { deleted.await() })
        assertEquals(emptyList<ConversationRow>(), store.coach.history)
        assertEquals(emptyList<String>(), disk.chats("u1").map { it.id })
        assertNull(store.coach.selectedChatId)
        assertEquals(emptyList<Any>(), store.held.withheld)
        scope.cancel()
    }

}
