package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.isDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performTextReplacement
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.AskTurn
import works.windmill.gym.domain.AnswerReceipt
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.ThreadOutcome
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.ThreadProposal
import works.windmill.gym.domain.SetTarget
import works.windmill.domain.kit.Id
import works.windmill.gym.domain.sync.ProposalRules
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.ProposalOutcome
import works.windmill.gym.store.ProposalRead
import works.windmill.sync.core.Json
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.modelserver.ServerCall
import works.windmill.gym.domain.sync.Exercise as SyncExercise
import works.windmill.gym.domain.sync.RoutineEntry as SyncEntry
import works.windmill.gym.domain.sync.SetTarget as SyncTarget

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class ThreadScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val rooms = mutableListOf<EngineRoomFixture>()

    @After
    fun closeRooms() = rooms.forEach(EngineRoomFixture::close)

    private fun signedIn(scope: CoroutineScope, rest: FakeGymRest): EngineRoomFixture =
        EngineRoomFixture(tmp.newFolder(), scope, rest = rest).also { room ->
            rooms += room
            runBlocking { room.select("u1") }
        }

    @Test
    fun historyShowsCreatedOutcomesOnceAndKeepsOrdinaryConversationsQuiet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val rest = FakeGymRest()
        val today = System.currentTimeMillis()
        rest.conversations["thread-created"] = AskThread("thread-created", "Make a push routine", askedAtMs = today,
            outcome = ThreadOutcome("created", 1, "routine-one", "Push A"))
        rest.conversations["thread-ordinary"] = AskThread("thread-ordinary", "How was my workout?", askedAtMs = today,
            outcome = ThreadOutcome("read-only"))
        val store = signedIn(scope, rest).store
        compose.setContent { ThreadsScreen(store, "Coach", {}, {}, {}, {}) }

        compose.onNodeWithText("today · Created Push A").assertIsDisplayed()
        compose.onNodeWithText("today").assertIsDisplayed()
        compose.onNodeWithText("Read only").assertDoesNotExist()
        compose.onNodeWithText("Your conversations").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun aRetainedConversationCanSendItsFifthQuestionUnderTheSameIdentity() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val rest = FakeGymRest()
        val turns = (1..4).flatMap { listOf(AskTurn("lifter", "Question $it"), AskTurn("coach", "Answer $it")) }
        rest.conversations["thread-old"] = AskThread("thread-old", "Question 1", turns = turns)
        val store = signedIn(scope, rest).store
        compose.setContent { ThreadScreen("thread-old", store, emptyList(), emptySet(), "History", {}, {}, {}) }
        compose.onNodeWithContentDescription("Question").performTextReplacement("Question 5")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.waitUntil(10_000) { compose.onNodeWithText("nothing has moved in three weeks.").isDisplayed() }
        compose.onNodeWithText("nothing has moved in three weeks.").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("thread-old", rest.asked.single().thread)
            assertEquals("Question 5", rest.asked.single().question)
            org.junit.Assert.assertFalse(rest.asked.single().requestId.isNullOrEmpty())
        }
        scope.cancel()
    }

    private fun saved(room: EngineRoomFixture, server: ModelServer, draft: RoutineDraft): Routine = runBlocking {
        (room.store.saveRoutine(draft) as GymResult.Ok).value.also { room.sync(server) }
    }

    // Coach writes the proposal on the server inside the conversation, and this phone pulls it.
    private fun propose(room: EngineRoomFixture, server: ModelServer, routine: Routine, summary: String = "Heavier triples.") {
        fun entry(exerciseId: String, sets: List<SetTarget>) =
            SyncEntry(Id(exerciseId, SyncExercise), sets.takeIf { it.isNotEmpty() }?.map { SyncTarget(it.reps, it.weightKg) })
        val diff = ProposalRules.changesBetween(routine.entries.map { entry(it.exerciseId, it.sets) },
            listOf(entry("bench-press", List(5) { SetTarget(3) })))
        fun slot(value: Json) = Json.array(value, Json.Null)
        val written = Json.objectOf("t" to Json.of("proposal"), "id" to Json.of("proposal1"), "born" to Json.Null,
            "life" to Json.array(Json.of("alive"), Json.Null), "f" to Json.objectOf(
                "routineId" to slot(Json.of(routine.id)), "intent" to slot(Json.of("revise")), "proposedName" to slot(Json.of(routine.name)),
                "summary" to slot(Json.of(summary)), "changes" to slot(Json.Arr(diff.map { it.json })), "door" to slot(Json.of("ask")),
                "connection" to slot(Json.of("")), "agent" to slot(Json.of("")), "threadId" to slot(Json.of("thread0001"))))
        val reply = server.call(ServerCall(room.selected!!, null, "propose", Json.objectOf(),
            listOf(Json.objectOf("scope" to Json.of("self/gym"), "d" to Json.array(written)))), room.now)
        assertEquals(Json.of("ok"), reply?.get("s"))
        room.pull(server)
        assertEquals(listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
            before = ProposalTargets(List(3) { SetTarget(5) }), after = ProposalTargets(List(5) { SetTarget(3) }))),
            runBlocking { room.training.proposal("proposal1") }?.changes)
    }

    // A decision waits for the server's receipt, so the phone syncs while it is pending.
    private fun applied(room: EngineRoomFixture, server: ModelServer) = runBlocking {
        val decision = async { room.store.applyProposal("proposal1") }
        while (room.outbox().isEmpty() && !decision.isCompleted) yield()
        room.sync(server)
        decision.await() as ProposalOutcome.Decided
    }

    private fun pushDay(room: EngineRoomFixture, server: ModelServer) =
        saved(room, server, RoutineDraft(name = "Push Day").adding("bench-press", List(3) { SetTarget(5) }))

    private fun aThread(routineId: String) = AskThread(
        id = "thread0001", title = "Is my week too light?", askedAtMs = 1_000,
        proposals = listOf(ThreadProposal(id = "proposal1", changeCount = 1, routineId = routineId, routine = "Push Day")),
    )

    // The stored thread's proposal row is the Coach room's card: the model's prose, the counted line,
    // and one affordance, Review.
    @Test
    fun theStoredThreadsProposalRowCarriesReviewAndTheSummaryLikeTheCoachCard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val rest = FakeGymRest()
        val room = signedIn(scope, rest)
        val routine = pushDay(room, server)
        propose(room, server, routine)
        rest.conversations["thread0001"] = aThread(routine.id)
        val doors = mutableListOf<String>()
        compose.setContent {
            ThreadScreen(
                threadId = "thread0001", store = room.store, receipts = emptyList(), lookedAt = setOf("proposal1"),
                backTo = "Coach", onBack = {}, onReview = { doors += it.id }, say = {},
            )
        }

        compose.onNodeWithText("Proposal · Push Day").assertIsDisplayed()
        compose.onNodeWithText("Heavier triples.").assertIsDisplayed()
        compose.onNodeWithText("1 change · still waiting").assertIsDisplayed()
        compose.onNodeWithText("Review").performClick()
        compose.runOnIdle { assertEquals(listOf("proposal1"), doors) }
        scope.cancel()
    }

    // No prose on the log: the card still says what it counts.
    @Test
    fun aProposalRowWithoutProseFallsBackToTheCountedSummary() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val rest = FakeGymRest()
        val room = signedIn(scope, rest)
        val routine = pushDay(room, server)
        propose(room, server, routine, summary = "")
        rest.conversations["thread0001"] = aThread(routine.id)
        compose.setContent {
            ThreadScreen(
                threadId = "thread0001", store = room.store, receipts = emptyList(), lookedAt = emptySet(),
                backTo = "Coach", onBack = {}, onReview = {}, say = {},
            )
        }
        compose.onNodeWithText("1 change to Push Day.").assertIsDisplayed()
        compose.onNodeWithText("Review").assertIsDisplayed()
        scope.cancel()
    }

    // A stored thread is the server's: once a receipt lands, the row and the outcome are read back
    // rather than left saying `waiting` beside `Applied`.
    @Test
    fun afterApplyTheStoredThreadReadsAppliedBesideTheReceiptAndNeverWaiting() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val rest = FakeGymRest()
        val room = signedIn(scope, rest)
        val routine = pushDay(room, server)
        propose(room, server, routine)
        rest.conversations["thread0001"] = aThread(routine.id)
        var receipts by mutableStateOf<List<String>>(emptyList())
        compose.setContent {
            ThreadScreen(
                threadId = "thread0001", store = room.store, receipts = receipts, lookedAt = emptySet(),
                backTo = "Coach", onBack = {}, onReview = {}, say = {},
            )
        }
        compose.onNodeWithText("1 change").assertIsDisplayed()
        compose.onNodeWithText("Review").assertIsDisplayed()
        compose.onNodeWithText("Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal.")
            .performScrollTo().assertIsDisplayed()

        val settled = applied(room, server)
        compose.runOnIdle { receipts = listOf(settled.proposal.receipt!!) }

        compose.onNodeWithText("Applied · Push Day · 1 change").assertIsDisplayed()
        compose.onNodeWithText("1 change").assertIsDisplayed()
        compose.onNodeWithText("Proposal · Push Day").assertIsDisplayed()
        compose.onNodeWithText("waiting", substring = true).assertDoesNotExist()
        compose.onNodeWithText(Ask.promise).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun aFailedConversationReadRetriesWithoutCreatingAConversation() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val rest = FakeGymRest()
        val store = signedIn(scope, rest).store
        val thread = AskThread("thr_retry", "My question", turns = listOf(AskTurn("coach", "The original answer.")))
        rest.conversations[thread.id] = thread
        rest.online = false
        compose.setContent {
            ThreadScreen(thread.id, store, emptyList(), emptySet(), "Coach", {}, {}, {})
        }
        compose.onNodeWithText("the log didn’t answer — that conversation didn’t open").assertIsDisplayed()
        compose.onNodeWithText("The original answer.").assertDoesNotExist()
        rest.online = true
        compose.onNodeWithText("Try again").performClick()
        compose.onNodeWithText("The original answer.").assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf(thread), rest.conversations.values.toList())
            assertEquals(0, rest.calls.count { it == "ask" })
        }
        scope.cancel()
    }

    @Test
    fun aPastReceiptWhoseProposalIsGoneKeepsProseWithoutInventingItsOutcomeOrRetry() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val rest = FakeGymRest()
        val thread = AskThread("thr_removed", "What about this routine?",
            outcome = ThreadOutcome("unknown"),
            turns = listOf(AskTurn("coach", "The original proposal explanation.",
                receipt = AnswerReceipt(1, ReadTally(0, 0, 0), proposals = listOf("prop_removed")))))
        rest.conversations[thread.id] = thread
        val room = signedIn(scope, rest)
        compose.setContent {
            ThreadScreen(thread.id, room.store, emptyList(), emptySet(), "Coach", {}, {}, {})
        }
        compose.onNodeWithText("The original proposal explanation.").assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        compose.onNodeWithText("Review").assertDoesNotExist()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText("Read-only").assertDoesNotExist()
        compose.onNodeWithText("Applied").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(mapOf(thread.id to thread), rest.conversations)
            assertEquals("nothing was decided", emptyList<Json>(), room.outbox())
        }
        scope.cancel()
    }
}
