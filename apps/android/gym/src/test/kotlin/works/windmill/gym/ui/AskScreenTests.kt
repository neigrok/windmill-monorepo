package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.AskStep
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalSource
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.Threads
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
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class AskScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val read = ReadTally(sets = 214, sessions = 34, weeks = 12)

    private fun store(scope: CoroutineScope, server: FakeTraining = FakeTraining()): TrainingStore {
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

    private fun room(
        store: TrainingStore,
        thread: List<AskExchange>,
        cap: AskCap?,
        doors: MutableList<String>,
    ) {
        compose.setContent {
            AskScreen(
                store = store,
                thread = thread,
                receipts = emptyList(),
                lookedAt = emptySet(),
                asking = false,
                cap = cap,
                onAsk = { doors += "ask:$it" },
                onRetry = {},
                onAskNew = { doors += "askNew" },
                seed = "",
                origin = "https://windmill.works",
                backTo = null,
                onBack = null,
                onThreads = { doors += "threads" },
                onNotes = { doors += "notes" },
                onReview = {},
            )
        }
    }

    @Test
    fun theAllowanceIsOneLineAboveTheComposerAndTheParagraphIsGone() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        room(store(scope), thread = emptyList(), cap = null, doors = mutableListOf())

        compose.onNodeWithText(Ask.title).assertIsDisplayed()
        compose.onNodeWithText(Ask.subtitle).assertIsDisplayed()
        compose.onNodeWithText("Ten questions a day, three back to back.").assertIsDisplayed()
        compose.onNodeWithText(Ask.placeholder).assertIsDisplayed()
        compose.onNodeWithText("There is nothing to buy here.", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun theAllowanceStaysOnceAQuestionIsSpentAndTheStepsSitBehindTheReceiptInTheLiftersWords() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val answered = AskExchange(
            question = "what’s stalled?",
            answer = AskAnswer(
                answer = "Bench has been flat for three weeks.",
                read = read,
                steps = listOf(
                    AskStep("get_stats"),
                    AskStep("summon_lightning"),
                    AskStep("list_notes"),
                    AskStep("get_stats"),
                ),
            ),
        )
        room(store(scope), thread = listOf(answered), cap = null, doors = mutableListOf())

        compose.onNodeWithText(Ask.allowance).assertIsDisplayed()
        val receipt = compose.onNodeWithText(Ask.receipt(read)).performScrollTo()
        receipt.assertIsDisplayed()
        receipt.assert(hasStateDescription("collapsed"))
        compose.onNodeWithText("read your movement history").assertDoesNotExist()
        compose.onNodeWithText("summon_lightning", substring = true).assertDoesNotExist()

        receipt.performClick()

        compose.onNodeWithText(Ask.receipt(read)).assert(hasStateDescription("expanded"))
        compose.onNodeWithText("read your movement history").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("read your notes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(Ask.receipt(read)).assertIsDisplayed()
        compose.onNodeWithText("summon_lightning", substring = true).assertDoesNotExist()
        compose.onNodeWithText("get_stats", substring = true).assertDoesNotExist()
        compose.onNodeWithText("list_notes", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    // The state says the sentence the LOG sent, not a constant of its own — and it says it once: the
    // exchange's own refusal card is not drawn beneath it.
    @Test
    fun theCapReachedMomentSaysTheLogsOwnSentenceAndReplacesTheComposerWithWhatToDoNext() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val refused = AskExchange(
            question = "is my week too light?",
            trouble = "the next question frees up in a couple of hours",
        )
        val doors = mutableListOf<String>()
        room(store(scope), thread = listOf(refused), cap = AskCap.Daily, doors = doors)

        compose.onNodeWithText("the next question frees up in a couple of hours").assertIsDisplayed()
        compose.onNodeWithText("is my week too light?").assertIsDisplayed()
        compose.onNodeWithText(Threads.open).assertIsDisplayed()
        compose.onNodeWithText(Ask.connect).assertIsDisplayed()
        compose.onNodeWithText(Ask.placeholder).assertDoesNotExist()
        // A10: the promise is pinned with the doors, below the moment it ran out — which reads at
        // the end of the thread and scrolls with it.
        compose.onNodeWithText(Ask.allowance).assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()

        // T3's other direction: under the DAY's ten a new conversation is the way back to a
        // composer, so it leads and the connect door sits beneath it.
        val askNew = compose.onNodeWithText(Threads.open).fetchSemanticsNode()
        val connect = compose.onNodeWithText(Ask.connect).fetchSemanticsNode()
        assertTrue("the way back to an answer leads under the daily cap",
            askNew.positionInRoot.y < connect.positionInRoot.y)

        compose.onNodeWithText(Threads.open).performClick()
        compose.runOnIdle { assertEquals(listOf("askNew"), doors) }
        scope.cancel()
    }

    // The account's 30-day ceiling reaches the SAME state, because the connect door is the one way on
    // that neither ceiling rations — and it must never borrow the daily bucket's sentence, which
    // would promise a question back in a couple of hours over a thirty-day window.
    //
    // T3: under this ceiling a fresh conversation cannot take a question either, so the connect door
    // leads and `Ask something new` sits BELOW it, as a way out of this conversation.
    @Test
    fun theAccountCeilingReachesTheSameStateSaysItsOwnSentenceAndLeadsWithTheConnectDoor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val ceiling = "this account has reached its AI ceiling for the last 30 days. Coach will " +
            "answer again as that window rolls on"
        val refused = AskExchange(question = "what's stalled?", trouble = ceiling)
        val doors = mutableListOf<String>()
        room(store(scope), thread = listOf(refused), cap = AskCap.Ceiling, doors = doors)

        compose.onNodeWithText(ceiling).assertIsDisplayed()
        // Inside the scroller: the doors stay pinned, the words scroll. What the thread keeps that
        // way — 283.5dp at fontScale 2.0 — is measured in `LargestTypeTests`.
        compose.onNodeWithText(ceiling).assert(hasAnyAncestor(hasScrollAction()))
        compose.onNodeWithText(Ask.capReached).assertDoesNotExist()
        compose.onNodeWithText(Ask.placeholder).assertDoesNotExist()
        // Ten a day is a promise about the DAY's bucket. Under the account's thirty days it is not
        // the rule that stopped this question, and drawn on top of the sentence that says so it
        // would read as that rule — so it is not drawn under this ceiling at all.
        compose.onNodeWithText(Ask.allowance).assertDoesNotExist()

        val connect = compose.onNodeWithText(Ask.connect).fetchSemanticsNode()
        val askNew = compose.onNodeWithText(Threads.open).fetchSemanticsNode()
        assertTrue("the unrationed door leads; the new conversation is the way out beneath it",
            connect.positionInRoot.y < askNew.positionInRoot.y)

        compose.onNodeWithText(Threads.open).performClick()
        compose.runOnIdle { assertEquals(listOf("askNew"), doors) }
        scope.cancel()
    }

    // The card was minted off one read of the log; the decision is the log's reply, and the two must
    // not stand on one screen saying different things about one act.
    @Test
    fun afterApplyTheCardReadsAppliedBesideTheReceiptAndNeverWaiting() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        val routine = runBlocking {
            (store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) as GymResult.Ok).value
        }
        server.propose(Proposal(
            id = "prop_1", routineId = routine.id, state = ProposalState.Pending, summary = "Heavier triples.",
            changeCount = 1, createdAtMs = 1_000, source = ProposalSource(door = "ask"),
            baseRevision = routine.revision, baseName = "Push Day", name = "Push Day",
            changes = listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
                before = ProposalTargets(sets = 3, reps = 5), after = ProposalTargets(sets = 5, reps = 3))),
        ))
        val answered = AskExchange(
            question = "heavier?",
            answer = AskAnswer(answer = "Triples.", read = read, proposals = listOf("prop_1")),
        )
        var receipts by mutableStateOf<List<String>>(emptyList())
        compose.setContent {
            AskScreen(
                store = store, thread = listOf(answered), receipts = receipts, lookedAt = emptySet(),
                asking = false, cap = null, onAsk = {}, onRetry = {}, onAskNew = {}, seed = "",
                origin = "https://windmill.works", backTo = null, onBack = null,
                onThreads = {}, onNotes = {}, onReview = {},
            )
        }
        compose.onNodeWithText("Push Day · 1 change · waiting").assertIsDisplayed()

        val settled = runBlocking { store.applyProposal("prop_1") as ProposalOutcome.Decided }
        compose.runOnIdle { receipts = listOf(settled.proposal.receipt!!) }

        compose.onNodeWithText("Applied · Push Day · 1 change").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("applied 1 change from Coach", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("waiting", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    // `3t`: a promise about what Apply will do is spent the moment Apply is taken. The card stays —
    // it is the door to the rows it counted — and the promise goes with the decision, which is the
    // shape the web already ships.
    @Test
    fun theCardsPromiseStandsWhileTheProposalIsPendingAndGoesWithTheDecision() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        val routine = runBlocking {
            (store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) as GymResult.Ok).value
        }
        server.propose(Proposal(
            id = "prop_1", routineId = routine.id, state = ProposalState.Pending, summary = "Heavier triples.",
            changeCount = 1, createdAtMs = 1_000, source = ProposalSource(door = "ask"),
            baseRevision = routine.revision, baseName = "Push Day", name = "Push Day",
            changes = listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
                before = ProposalTargets(sets = 3, reps = 5), after = ProposalTargets(sets = 5, reps = 3))),
        ))
        val answered = AskExchange(
            question = "heavier?",
            answer = AskAnswer(answer = "Triples.", read = read, proposals = listOf("prop_1")),
        )
        var receipts by mutableStateOf<List<String>>(emptyList())
        compose.setContent {
            AskScreen(
                store = store, thread = listOf(answered), receipts = receipts, lookedAt = emptySet(),
                asking = false, cap = null, onAsk = {}, onRetry = {}, onAskNew = {}, seed = "",
                origin = "https://windmill.works", backTo = null, onBack = null,
                onThreads = {}, onNotes = {}, onReview = {},
            )
        }
        compose.onNodeWithText(Ask.promise).performScrollTo().assertIsDisplayed()

        val settled = runBlocking { store.applyProposal("prop_1") as ProposalOutcome.Decided }
        compose.runOnIdle { receipts = listOf(settled.proposal.receipt!!) }

        compose.onNodeWithText("Applied · Push Day · 1 change").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(Ask.promise).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun theNotesDoorIsARowInTheRoomAndOpensTheNotes() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        room(store(scope), thread = emptyList(), cap = null, doors = doors)

        compose.onNodeWithText("Notes").performClick()
        compose.onNodeWithText("Threads").performClick()
        compose.runOnIdle { assertEquals(listOf("notes", "threads"), doors) }
        scope.cancel()
    }
}
