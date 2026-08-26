package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.io.File
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
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalSource
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.ThreadProposal
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.ProposalOutcome
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ThreadScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope, server: FakeTraining): TrainingStore {
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
            before = ProposalTargets(sets = 3, reps = 5), after = ProposalTargets(sets = 5, reps = 3))),
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
                backLabel = "Coach", onBack = {}, onDeleted = {}, onReview = { doors += it.id }, say = {},
            )
        }

        compose.onNodeWithText("Proposal · Push Day").assertIsDisplayed()
        compose.onNodeWithText("Heavier triples.").assertIsDisplayed()
        compose.onNodeWithText("1 change to Push Day · still waiting").assertIsDisplayed()
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
                backLabel = "Coach", onBack = {}, onDeleted = {}, onReview = {}, say = {},
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
                before = ProposalTargets(sets = 3, reps = 5), after = ProposalTargets(sets = 5, reps = 3))),
        ))
        server.conversations["thr_1"] = AskThread(
            id = "thr_1", title = "Is my week too light?", askedAtMs = 1_000,
            proposals = listOf(ThreadProposal(id = "prop_1", changeCount = 1, routineId = routine.id, routine = "Push Day")),
        )
        var receipts by mutableStateOf<List<String>>(emptyList())
        compose.setContent {
            ThreadScreen(
                threadId = "thr_1", store = store, receipts = receipts, lookedAt = emptySet(),
                backLabel = "Coach", onBack = {}, onDeleted = {}, onReview = {}, say = {},
            )
        }
        compose.onNodeWithText("1 change to Push Day · waiting").assertIsDisplayed()
        compose.onNodeWithText("1 change waiting").assertIsDisplayed()

        val settled = runBlocking { store.applyProposal("prop_1") as ProposalOutcome.Decided }
        compose.runOnIdle { receipts = listOf(settled.proposal.receipt!!) }

        compose.onNodeWithText("Applied · Push Day · 1 change").assertIsDisplayed()
        compose.onNodeWithText("1 change to Push Day · applied").assertIsDisplayed()
        compose.onNodeWithText("1 change → Push Day").assertIsDisplayed()
        compose.onNodeWithText("waiting", substring = true).assertDoesNotExist()
        compose.runOnIdle { assertEquals(2, server.calls.count { it == "thread" }) }
        scope.cancel()
    }
}
