package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performTextReplacement
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
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
import works.windmill.gym.domain.ProposalSource
import works.windmill.gym.domain.ProposalIntent
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.ThreadProposal
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.ProposalOutcome
import works.windmill.gym.store.ProposalRead
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class ThreadScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun historyShowsCreatedOutcomesOnceAndKeepsOrdinaryConversationsQuiet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val today = System.currentTimeMillis()
        server.conversations["thread-created"] = AskThread("thread-created", "Make a push routine", askedAtMs = today,
            outcome = ThreadOutcome("created", 1, "routine-one", "Push A"))
        server.conversations["thread-ordinary"] = AskThread("thread-ordinary", "How was my workout?", askedAtMs = today,
            outcome = ThreadOutcome("read-only"))
        val store = store(scope, server)
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
        val server = FakeTraining()
        val turns = (1..4).flatMap { listOf(AskTurn("lifter", "Question $it"), AskTurn("coach", "Answer $it")) }
        server.conversations["thread-old"] = AskThread("thread-old", "Question 1", turns = turns)
        val store = store(scope, server)
        compose.setContent { ThreadScreen("thread-old", store, emptyList(), emptySet(), "History", {}, {}, {}) }
        compose.onNodeWithContentDescription("Question").performTextReplacement("Question 5")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.onNodeWithText("nothing has moved in three weeks.").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("thread-old", server.asked.single().thread)
            assertEquals("Question 5", server.asked.single().question)
            org.junit.Assert.assertFalse(server.asked.single().requestId.isNullOrEmpty())
        }
        scope.cancel()
    }

    private fun store(scope: CoroutineScope, server: TrainingSyncing): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { server },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam"),
            ))
        }
        return store
    }

    private fun aProposal(routineId: String, baseRevision: Int, summary: String = "Heavier triples.") = Proposal(
        id = "prop_1", routineId = routineId, state = ProposalState.Pending, summary = summary,
        changeCount = 1, createdAtMs = 1_000, source = ProposalSource(door = "ask", thread = "thr_1"),
        baseRevision = baseRevision, baseName = "Push Day", name = "Push Day",
        changes = listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
            before = ProposalTargets(List(3) { SetTarget(5) }), after = ProposalTargets(List(5) { SetTarget(3) }))),
    )

    private fun aThread(routineId: String) = AskThread(
        id = "thr_1", title = "Is my week too light?", askedAtMs = 1_000,
        proposals = listOf(ThreadProposal(id = "prop_1", changeCount = 1, routineId = routineId, routine = "Push Day")),
    )

    // The stored thread's proposal row is the Coach room's card: the model's prose, the counted line,
    // and one affordance, Review.
    @Test
    fun theStoredThreadsProposalRowCarriesReviewAndTheSummaryLikeTheCoachCard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        val routine = runBlocking {
            (store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) as GymResult.Ok).value
        }
        server.propose(aProposal(routine.id, routine.revision))
        server.conversations["thr_1"] = aThread(routine.id)
        val doors = mutableListOf<String>()
        compose.setContent {
            ThreadScreen(
                threadId = "thr_1", store = store, receipts = emptyList(), lookedAt = setOf("prop_1"),
                backTo = "Coach", onBack = {}, onReview = { doors += it.id }, say = {},
            )
        }

        compose.onNodeWithText("Proposal · Push Day").assertIsDisplayed()
        compose.onNodeWithText("Heavier triples.").assertIsDisplayed()
        compose.onNodeWithText("1 change · still waiting").assertIsDisplayed()
        compose.onNodeWithText("Review").performClick()
        compose.runOnIdle { assertEquals(listOf("prop_1"), doors) }
        scope.cancel()
    }

    // No prose on the log, or a proposal read that missed: the card still says what it counts.
    @Test
    fun aProposalRowWithoutProseFallsBackToTheCountedSummary() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        val routine = runBlocking {
            (store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) as GymResult.Ok).value
        }
        server.propose(aProposal(routine.id, routine.revision, summary = ""))
        server.conversations["thr_1"] = aThread(routine.id)
        compose.setContent {
            ThreadScreen(
                threadId = "thr_1", store = store, receipts = emptyList(), lookedAt = emptySet(),
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
        val server = FakeTraining()
        val store = store(scope, server)
        val routine = runBlocking {
            (store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) as GymResult.Ok).value
        }
        server.propose(Proposal(
            id = "prop_1", routineId = routine.id, state = ProposalState.Pending, summary = "Heavier triples.",
            changeCount = 1, createdAtMs = 1_000, source = ProposalSource(door = "ask", thread = "thr_1"),
            baseRevision = routine.revision, baseName = "Push Day", name = "Push Day",
            changes = listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
                before = ProposalTargets(List(3) { SetTarget(5) }), after = ProposalTargets(List(5) { SetTarget(3) }))),
        ))
        server.conversations["thr_1"] = AskThread(
            id = "thr_1", title = "Is my week too light?", askedAtMs = 1_000,
            proposals = listOf(ThreadProposal(id = "prop_1", changeCount = 1, routineId = routine.id, routine = "Push Day")),
        )
        var receipts by mutableStateOf<List<String>>(emptyList())
        compose.setContent {
            ThreadScreen(
                threadId = "thr_1", store = store, receipts = receipts, lookedAt = emptySet(),
                backTo = "Coach", onBack = {}, onReview = {}, say = {},
            )
        }
        compose.onNodeWithText("1 change").assertIsDisplayed()
        compose.onNodeWithText("Review").assertIsDisplayed()
        compose.onNodeWithText("Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal.")
            .performScrollTo().assertIsDisplayed()

        val settled = runBlocking { store.applyProposal("prop_1") as ProposalOutcome.Decided }
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
        val server = FakeTraining()
        val store = store(scope, server)
        val thread = AskThread("thr_retry", "My question", turns = listOf(AskTurn("coach", "The original answer.")))
        server.conversations[thread.id] = thread
        server.online = false
        compose.setContent {
            ThreadScreen(thread.id, store, emptyList(), emptySet(), "Coach", {}, {}, {})
        }
        compose.onNodeWithText("the log didn’t answer — that conversation didn’t open").assertIsDisplayed()
        compose.onNodeWithText("The original answer.").assertDoesNotExist()
        server.online = true
        compose.onNodeWithText("Try again").performClick()
        compose.onNodeWithText("The original answer.").assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf(thread), server.conversations.values.toList())
            assertEquals(0, server.calls.count { it == "ask" })
        }
        scope.cancel()
    }

    @Test
    fun aPastReceiptWhoseProposalIsGoneKeepsProseWithoutInventingItsOutcomeOrRetry() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val thread = AskThread("thr_removed", "What about this routine?",
            outcome = ThreadOutcome("unknown"),
            turns = listOf(AskTurn("coach", "The original proposal explanation.",
                receipt = AnswerReceipt(1, ReadTally(0, 0, 0), proposals = listOf("prop_removed")))))
        server.conversations[thread.id] = thread
        val store = store(scope, server)
        compose.setContent {
            ThreadScreen(thread.id, store, emptyList(), emptySet(), "Coach", {}, {}, {})
        }
        compose.onNodeWithText("The original proposal explanation.").assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        compose.onNodeWithText("Review").assertDoesNotExist()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText("Read-only").assertDoesNotExist()
        compose.onNodeWithText("Applied").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(mapOf(thread.id to thread), server.conversations)
            assertEquals(listOf("proposal"), server.calls.filter { it == "proposal" })
            assertEquals(emptyList<String>(), server.calls.filter { it == "applyProposal" || it == "dismissProposal" })
        }
        scope.cancel()
    }

    @Test
    fun aConfirmedRemovalReceiptStaysVisibleAfterTheThreadLosesItsProposalHeader() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        val routine = runBlocking { (store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) as GymResult.Ok).value }
        val proposal = aProposal(routine.id, routine.revision, "Remove this routine.")
            .copy(intent = ProposalIntent.Remove, changes = emptyList())
        server.propose(proposal)
        val thread = aThread(routine.id).copy(turns = listOf(AskTurn("coach", "The original removal explanation.",
            receipt = AnswerReceipt(1, ReadTally(0, 0, 0), proposals = listOf(proposal.id)))))
        server.conversations[thread.id] = thread
        var receipts by mutableStateOf<List<String>>(emptyList())
        val reviewed = mutableListOf<String>()
        compose.setContent {
            ThreadScreen(thread.id, store, receipts, emptySet(), "Coach", {}, { reviewed += it.id }, {})
        }
        compose.onNodeWithText("Remove this routine.").assertIsDisplayed()
        compose.onNodeWithText("Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal.")
            .performScrollTo().assertIsDisplayed()
        val settled = runBlocking { store.applyProposal(proposal.id) as ProposalOutcome.Decided }
        compose.runOnIdle {
            assertEquals(emptyMap<String, Proposal>(), server.ledger)
            server.conversations[thread.id] = thread.copy(proposals = emptyList(), outcome = ThreadOutcome("unknown"))
            receipts = listOf(requireNotNull(settled.proposal.receipt))
        }
        compose.onNodeWithText(requireNotNull(settled.proposal.receipt)).assertIsDisplayed()
        compose.onNodeWithText("Remove this routine.").assertIsDisplayed()
        compose.onNodeWithText("Review").performClick()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.onNodeWithText(Ask.promise).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf(proposal.id), reviewed)
            assertEquals(ProposalRead.Found(settled.proposal), runBlocking { store.proposal(proposal.id) })
            assertEquals(thread.turns, server.conversations.getValue(thread.id).turns)
        }
        scope.cancel()
    }

    @Test
    fun aReceiptOnlyProposalReadFailureOffersRetryAndThenTheActualProposal() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        var failed = true
        var reads = 0
        val wire = object : TrainingSyncing by server {
            override suspend fun proposal(id: String): Proposal? {
                reads += 1
                if (failed) throw IOException("no connection")
                return server.proposal(id)
            }
        }
        val store = store(scope, wire)
        val routine = runBlocking { (store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) as GymResult.Ok).value }
        val proposal = aProposal(routine.id, routine.revision)
        server.propose(proposal)
        val thread = AskThread("thr_1", "My question", outcome = ThreadOutcome("unknown"),
            turns = listOf(AskTurn("coach", "The original answer.",
                receipt = AnswerReceipt(1, ReadTally(0, 0, 0), proposals = listOf(proposal.id)))))
        server.conversations[thread.id] = thread
        compose.setContent {
            ThreadScreen(thread.id, store, emptyList(), emptySet(), "Coach", {}, {}, {})
        }
        compose.onNodeWithText("The original answer.").assertIsDisplayed()
        compose.onNodeWithText("the log didn’t answer — the proposal wasn’t read").assertIsDisplayed()
        compose.onNodeWithText("Review").assertDoesNotExist()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        failed = false
        compose.onNodeWithText("Try again").performClick()
        compose.onNodeWithText("Heavier triples.").assertIsDisplayed()
        compose.onNodeWithText("Review").assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(2, reads)
            assertEquals(mapOf(proposal.id to proposal), server.ledger)
            assertEquals(mapOf(thread.id to thread), server.conversations)
        }
        scope.cancel()
    }

}
