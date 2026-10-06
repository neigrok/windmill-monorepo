package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.performScrollTo
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskGeneration
import works.windmill.gym.domain.CoachAttachment
import works.windmill.gym.domain.CoachDraft
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.AskStep
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.Threads
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.sync.ProposalRules
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.ProposalOutcome
import works.windmill.gym.store.ProposalRead
import works.windmill.gym.store.TrainingStore
import works.windmill.domain.kit.Id
import works.windmill.sync.core.Json
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.modelserver.ServerCall
import works.windmill.gym.domain.sync.Exercise as SyncExercise
import works.windmill.gym.domain.sync.RoutineEntry as SyncEntry
import works.windmill.gym.domain.sync.SetTarget as SyncTarget

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class AskScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val read = ReadTally(sets = 214, sessions = 34, weeks = 12)

    private val rooms = mutableListOf<EngineRoomFixture>()

    @After
    fun closeRooms() = rooms.forEach(EngineRoomFixture::close)

    private fun signedIn(scope: CoroutineScope): EngineRoomFixture =
        EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest()).also { room ->
            rooms += room
            runBlocking { room.select("u1") }
        }

    private fun saved(room: EngineRoomFixture, server: ModelServer, draft: RoutineDraft): Routine = runBlocking {
        (room.store.saveRoutine(draft) as GymResult.Ok).value.also { room.sync(server) }
    }

    // Coach writes a proposal on the server, and this phone pulls it.
    private fun propose(room: EngineRoomFixture, server: ModelServer, id: String, routine: Routine, changes: List<ProposalChange>, summary: String) {
        fun entry(exerciseId: String, sets: List<SetTarget>) =
            SyncEntry(Id(exerciseId, SyncExercise), sets.takeIf { it.isNotEmpty() }?.map { SyncTarget(it.reps, it.weightKg) })
        val diff = ProposalRules.changesBetween(routine.entries.map { entry(it.exerciseId, it.sets) },
            changes.map { entry(it.exerciseId, it.after!!.sets) })
        fun slot(value: Json) = Json.array(value, Json.Null)
        val written = Json.objectOf("t" to Json.of("proposal"), "id" to Json.of(id), "born" to Json.Null,
            "life" to Json.array(Json.of("alive"), Json.Null), "f" to Json.objectOf(
                "routineId" to slot(Json.of(routine.id)), "intent" to slot(Json.of("revise")), "proposedName" to slot(Json.of(routine.name)),
                "summary" to slot(Json.of(summary)), "changes" to slot(Json.Arr(diff.map { it.json })),
                "door" to slot(Json.of("ask")), "connection" to slot(Json.of("")), "agent" to slot(Json.of(""))))
        val reply = server.call(ServerCall(room.selected!!, null, "propose", Json.objectOf(),
            listOf(Json.objectOf("scope" to Json.of("self/gym"), "d" to Json.array(written)))), room.now)
        assertEquals(Json.of("ok"), reply?.get("s"))
        room.pull(server)
        assertEquals(changes, runBlocking { room.training.proposal(id) }?.changes)
    }

    // A decision waits for the server's receipt, so the phone syncs while it is pending.
    private fun applied(room: EngineRoomFixture, server: ModelServer, id: String) = runBlocking {
        val decision = async { room.store.applyProposal(id) }
        while (room.outbox().isEmpty() && !decision.isCompleted) yield()
        room.sync(server)
        decision.await() as ProposalOutcome.Decided
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
    fun partialWordsReplaceInPlaceAndStopKeepsThemWithTruthfulStatus() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var generation by mutableStateOf(AskGeneration("generation-a", "request-a", "Question", "running", "First words", revision = 1))
        var busy by mutableStateOf(true)
        compose.setContent {
            AskScreen(store, listOf(generation.exchange()), emptyList(), emptySet(), busy, null,
                onAsk = {}, onRetry = {}, onAskNew = {}, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, conversationId = "thread-a",
                onStop = { generation = generation.copy(status = "stopped", revision = 3); busy = false })
        }
        compose.onNodeWithText("First words").assertIsDisplayed()
        compose.onNodeWithText("Jump to latest").assertDoesNotExist()
        compose.onNodeWithText(Ask.waiting).assertDoesNotExist()
        compose.runOnIdle { generation = generation.copy(answer = "First words, then more.", revision = 2) }
        compose.onNodeWithText("First words").assertDoesNotExist()
        compose.onNodeWithText("First words, then more.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Stop response").performClick()
        compose.onNodeWithText("First words, then more.").assertIsDisplayed()
        compose.onNodeWithText(Ask.stopped).assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithContentDescription("Send").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun aPhotoOnlyDraftCanBeSentAndRemovedWithoutAnEmptyMessageCopyAction() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        store.saveCoachDraft("new", CoachDraft(photo = photo))
        val sent = mutableListOf<Pair<String, CoachAttachment?>>()
        compose.setContent {
            AskScreen(store, emptyList(), emptyList(), emptySet(), false, null,
                onAsk = {}, onRetry = {}, onAskNew = {}, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, onPhotoAsk = { text, attachment -> sent += text to attachment })
        }
        compose.onNodeWithContentDescription("Add photo").assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").performClick()
        compose.runOnIdle { assertEquals(listOf("" to photo), sent) }
        compose.onNodeWithText("Remove photo").performClick()
        compose.runOnIdle { assertEquals(CoachDraft(), store.coachDraft("new")) }
        scope.cancel()
    }

    @Test
    fun streamingPreservesTheReadersEarlierPositionUntilJumpToLatest() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val earlier = (1..12).map { AskExchange("Question $it", AskAnswer("Answer $it.\n".repeat(8), ReadTally()), requestId = "request-$it") }
        var generation by mutableStateOf(AskGeneration("generation-new", "request-new", "Newest", "running", "Partial", revision = 1))
        compose.setContent {
            AskScreen(store, earlier + generation.exchange(), emptyList(), emptySet(), true, null,
                onAsk = {}, onRetry = {}, onAskNew = {}, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, conversationId = "thread-a", onStop = {})
        }
        compose.onNodeWithText("Question 1").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { generation = generation.copy(answer = "New streamed words.\n".repeat(20), revision = 2) }
        compose.onNodeWithText("Question 1").assertIsDisplayed()
        compose.onNodeWithText("Jump to latest").performClick()
        compose.onNodeWithText("Question 1").assertIsNotDisplayed()
        scope.cancel()
    }

    @Test
    fun loadingOlderMessagesPreservesTheVisibleMessageAndItsOffset() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var thread by mutableStateOf((5..14).map { AskExchange("Question $it", AskAnswer("Answer $it.\n".repeat(8), ReadTally()), requestId = "request-$it") })
        compose.setContent {
            AskScreen(store, thread, emptyList(), emptySet(), false, null,
                onAsk = {}, onRetry = {}, onAskNew = {}, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, conversationId = "thread-a")
        }
        compose.onNodeWithText("Question 7").performScrollTo().assertIsDisplayed()
        val before = compose.onNodeWithText("Question 7").getUnclippedBoundsInRoot().top
        compose.runOnIdle {
            thread = (1..4).map { AskExchange("Question $it", AskAnswer("Older answer.\n".repeat(8), ReadTally()), requestId = "request-$it") } + thread
        }
        compose.onNodeWithText("Question 7").assertIsDisplayed()
        assertEquals(before, compose.onNodeWithText("Question 7").getUnclippedBoundsInRoot().top)
        scope.cancel()
    }

    @Test
    fun partialToCompletedKeepsTheSameOpenMessageMenu() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var generation by mutableStateOf(AskGeneration("generation-a", "request-a", "Question", "running", "Partial café", revision = 1))
        compose.setContent {
            AskScreen(store, listOf(generation.exchange()), emptyList(), emptySet(), !generation.terminal, null,
                onAsk = {}, onRetry = {}, onAskNew = {}, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, conversationId = "thread-a")
        }
        compose.onNodeWithText("Partial café").performClick()
        compose.onNodeWithText("Copy").assertIsDisplayed()
        compose.runOnIdle { generation = generation.copy(status = "completed", answer = "Final café 東京 🏋🏽‍♀️", revision = 3) }
        compose.onNodeWithText("Copy").assertIsDisplayed().performClick()
        compose.onNodeWithText("Final café 東京 🏋🏽‍♀️").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun theEmptyRoomLeadsDirectlyToTheComposer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        room(signedIn(scope).store, thread = emptyList(), cap = null, doors = mutableListOf())

        compose.onNodeWithText(Ask.title).assertIsDisplayed()
        compose.onNodeWithText(Ask.subtitle).assertDoesNotExist()
        compose.onNodeWithText("Ten questions a day, three back to back.").assertDoesNotExist()
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
        room(signedIn(scope).store, thread = listOf(answered), cap = null, doors = mutableListOf())

        compose.onNodeWithText(Ask.allowance).assertDoesNotExist()
        val receipt = compose.onNodeWithText(Ask.receipt(read).replaceFirstChar { it.uppercase() }).performScrollTo()
        receipt.assertIsDisplayed()
        receipt.assert(hasStateDescription("collapsed"))
        compose.onNodeWithText("Read your movement history").assertDoesNotExist()
        compose.onNodeWithText("summon_lightning", substring = true).assertDoesNotExist()

        receipt.performClick()

        compose.onNodeWithText(Ask.receipt(read).replaceFirstChar { it.uppercase() }).assert(hasStateDescription("expanded"))
        compose.onNodeWithText("Read your movement history").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Read your notes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(Ask.receipt(read).replaceFirstChar { it.uppercase() }).assertIsDisplayed()
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
        room(signedIn(scope).store, thread = listOf(refused), cap = AskCap.Daily, doors = doors)

        compose.onNodeWithText("the next question frees up in a couple of hours").assertIsDisplayed()
        compose.onNodeWithText("is my week too light?").assertIsDisplayed()
        compose.onNodeWithText(Threads.open).assertIsDisplayed()
        compose.onNodeWithText("Connect own agent").assertIsDisplayed()
        compose.onNodeWithText(Ask.placeholder).assertDoesNotExist()
        // A10: the promise is pinned with the doors, below the moment it ran out — which reads at
        // the end of the thread and scrolls with it.
        compose.onNodeWithText(Ask.allowance).assertDoesNotExist()
        compose.onNodeWithText("Try again").assertDoesNotExist()

        // T3's other direction: under the DAY's ten a new conversation is the way back to a
        // composer, so it leads and the connect door sits beneath it.
        val askNew = compose.onNodeWithText(Threads.open).fetchSemanticsNode()
        val connect = compose.onNodeWithText("Connect own agent").fetchSemanticsNode()
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
        room(signedIn(scope).store, thread = listOf(refused), cap = AskCap.Ceiling, doors = doors)

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

        val connect = compose.onNodeWithText("Connect own agent").fetchSemanticsNode()
        val askNew = compose.onNodeWithText(Threads.open).fetchSemanticsNode()
        assertTrue("the unrationed door leads; the new conversation is the way out beneath it",
            connect.positionInRoot.y < askNew.positionInRoot.y)

        compose.onNodeWithText(Threads.open).performClick()
        compose.runOnIdle { assertEquals(listOf("askNew"), doors) }
        scope.cancel()
    }

    // The card is a skim: its rows draw the compact readout only — one set moved, or both schemes in
    // the readout formula — never the ladder the review sheet unfolds to.
    @Test
    fun theCardDrawsTheCompactReadoutAndNeverTheLadder() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val ramp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))
        val routine = saved(room, server, RoutineDraft(name = "Lower A").adding("back-squat", ramp)
            .adding("deadlift", List(5) { SetTarget(5, 80.0) }))
        val setFourMoved = ProposalChange(position = 1, kind = ChangeKind.Retargeted, exerciseId = "back-squat",
            before = ProposalTargets(ramp),
            after = ProposalTargets(ramp.mapIndexed { at, set -> if (at == 3) SetTarget(1, 102.5) else set }))
        val reshaped = ProposalChange(position = 2, kind = ChangeKind.Retargeted, exerciseId = "deadlift",
            before = ProposalTargets(List(5) { SetTarget(5, 80.0) }), after = ProposalTargets(ramp))
        propose(room, server, "proposal1", routine, listOf(setFourMoved, reshaped), "A ramp.")
        val answered = AskExchange(
            question = "ramp it?",
            answer = AskAnswer(answer = "A ramp.", read = read, proposals = listOf("proposal1")),
        )
        room(room.store, thread = listOf(answered), cap = null, doors = mutableListOf())

        compose.onNodeWithText("Proposal · Lower A").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("2 changes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Back Squat").assertDoesNotExist()
        compose.onNodeWithText("Deadlift").assertDoesNotExist()
        compose.onNodeWithText(setFourMoved.compactLine).assertDoesNotExist()
        compose.onNodeWithText(reshaped.compactLine).assertDoesNotExist()
        scope.cancel()
    }

    // The card was minted off one read of the log; the decision is the log's reply, and the two must
    // not stand on one screen saying different things about one act.
    @Test
    fun afterApplyTheCardReadsAppliedBesideTheReceiptAndNeverWaiting() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = saved(room, server, RoutineDraft(name = "Push Day").adding("bench-press", List(3) { SetTarget(5) }))
        propose(room, server, "proposal1", routine, listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted,
            exerciseId = "bench-press", before = ProposalTargets(List(3) { SetTarget(5) }),
            after = ProposalTargets(List(5) { SetTarget(3) }))), "Heavier triples.")
        val answered = AskExchange(
            question = "heavier?",
            answer = AskAnswer(answer = "Triples.", read = read, proposals = listOf("proposal1")),
        )
        var receipts by mutableStateOf<List<String>>(emptyList())
        compose.setContent {
            AskScreen(
                store = room.store, thread = listOf(answered), receipts = receipts, lookedAt = emptySet(),
                asking = false, cap = null, onAsk = {}, onRetry = {}, onAskNew = {}, seed = "",
                origin = "https://windmill.works", backTo = null, onBack = null,
                onThreads = {}, onNotes = {}, onReview = {},
            )
        }
        compose.onNodeWithText("1 change").performScrollTo().assertIsDisplayed()

        val settled = applied(room, server, "proposal1")
        compose.runOnIdle { receipts = listOf(settled.proposal.receipt!!) }

        compose.onNodeWithText("Applied · Push Day · 1 change").performScrollTo().assertIsDisplayed()
        compose.onAllNodes(hasText("Applied · Push Day · 1 change")).assertCountEquals(1)
        compose.onNodeWithText("waiting", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun theCardsPromiseStandsWhileTheProposalIsPendingAndGoesWithTheDecision() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = saved(room, server, RoutineDraft(name = "Push Day").adding("bench-press", List(3) { SetTarget(5) }))
        propose(room, server, "proposal1", routine, listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted,
            exerciseId = "bench-press", before = ProposalTargets(List(3) { SetTarget(5) }),
            after = ProposalTargets(List(5) { SetTarget(3) }))), "Heavier triples.")
        val answered = AskExchange(
            question = "heavier?",
            answer = AskAnswer(answer = "Triples.", read = read, proposals = listOf("proposal1")),
        )
        var receipts by mutableStateOf<List<String>>(emptyList())
        compose.setContent {
            AskScreen(
                store = room.store, thread = listOf(answered), receipts = receipts, lookedAt = emptySet(),
                asking = false, cap = null, onAsk = {}, onRetry = {}, onAskNew = {}, seed = "",
                origin = "https://windmill.works", backTo = null, onBack = null,
                onThreads = {}, onNotes = {}, onReview = {},
            )
        }
        compose.onNodeWithText("Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal.")
            .performScrollTo().assertIsDisplayed()

        val settled = applied(room, server, "proposal1")
        compose.runOnIdle { receipts = listOf(settled.proposal.receipt!!) }

        compose.onNodeWithText("Applied · Push Day · 1 change").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(Ask.promise).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun theQuietRoomKeepsNotesInMoreAndHistoryInTheBar() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        room(signedIn(scope).store, thread = emptyList(), cap = null, doors = doors)

        compose.onNodeWithText("Notes").assertDoesNotExist()
        compose.onNode(hasContentDescription("More")).performClick()
        compose.onNodeWithText("Notes").performClick()
        compose.onNodeWithText("History").performClick()
        compose.runOnIdle { assertEquals(listOf("notes", "threads"), doors) }
        scope.cancel()
    }
    @Test
    fun aRefusedFifthQuestionOpensAsANewDraftWithoutSendingIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val fifth = "Can I add a fifth day?"
        var thread by mutableStateOf(List(4) { AskExchange("Question ${it + 1}", AskAnswer("Answer ${it + 1}", ReadTally(0, 0, 0))) } +
            AskExchange(fifth, trouble = Ask.threadFull, needsNew = true))
        var seed by mutableStateOf("")
        val sent = mutableListOf<String>()
        compose.setContent {
            AskScreen(store, thread, emptyList(), emptySet(), false, null,
                onAsk = { sent += it }, onRetry = { sent += "retry" }, onAskNew = {},
                seed = seed, origin = "https://windmill.works", onThreads = {}, onNotes = {}, onReview = {},
                onNewDraft = { seed = it; thread = emptyList() })
        }
        compose.onNodeWithContentDescription("Question").assertDoesNotExist()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText("Ask new").performClick()
        compose.onNodeWithContentDescription("Question").assert(hasText(fifth))
        compose.runOnIdle { assertEquals(emptyList<String>(), sent) }
        compose.onNodeWithContentDescription("Send").performClick()
        compose.runOnIdle { assertEquals(listOf(fifth), sent) }
        scope.cancel()
    }

    @Test
    fun aFastSettledAnswerStillScrollsToItsNewQuestionAndProse() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var thread by mutableStateOf(listOf(AskExchange("First question", AskAnswer("Long history. ".repeat(150), ReadTally(0, 0, 0)))))
        compose.setContent {
            AskScreen(store, thread, emptyList(), emptySet(), false, null, onAsk = {}, onRetry = {}, onAskNew = {},
                seed = "", origin = "https://windmill.works", onThreads = {}, onNotes = {}, onReview = {})
        }
        compose.runOnIdle {
            thread = thread + AskExchange("Second question", AskAnswer("A fast complete answer.", ReadTally(0, 0, 0)))
        }
        compose.onNodeWithText("Second question").assertIsDisplayed()
        compose.onNodeWithText("A fast complete answer.").assertIsDisplayed()
        val viewport = compose.onNode(hasScrollAction() and !hasContentDescription("Question")).getUnclippedBoundsInRoot()
        val question = compose.onNodeWithText("Second question").getUnclippedBoundsInRoot()
        assertTrue("the new question starts the visible response", question.top <= viewport.top + 32.dp)
        compose.onNodeWithText("First question").assertIsNotDisplayed()
        scope.cancel()
    }

    @Test
    fun aSentQuestionStaysAtTheTopThroughPendingReplyAndKeyboardViewportExpansion() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val first = AskExchange("First question", AskAnswer("Your existing training history. ".repeat(18), ReadTally(0, 0, 0)))
        var thread by mutableStateOf(listOf(first))
        var height by mutableStateOf(540.dp)
        val sent = mutableListOf<String>()
        compose.setContent {
            Box(Modifier.height(height)) {
                AskScreen(store, thread, emptyList(), emptySet(), thread.last().pending, null,
                    onAsk = { sent += it; thread = thread + AskExchange(it) }, onRetry = {}, onAskNew = {},
                    seed = "", origin = "https://windmill.works", onThreads = {}, onNotes = {}, onReview = {})
            }
        }
        compose.onNodeWithContentDescription("Question").performTextReplacement("Second question")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.onNodeWithText(Ask.waiting).assertIsDisplayed()
        var viewport = compose.onNode(hasScrollAction() and !hasContentDescription("Question")).getUnclippedBoundsInRoot()
        var question = compose.onNodeWithText("Second question").getUnclippedBoundsInRoot()
        assertTrue("pending response is anchored", question.top <= viewport.top + 32.dp)
        compose.onNodeWithText("First question").assertIsNotDisplayed()

        compose.runOnIdle {
            height = 900.dp
            thread = listOf(first, AskExchange("Second question", AskAnswer("The complete answer is visible here.", ReadTally(0, 0, 0))))
        }
        viewport = compose.onNode(hasScrollAction() and !hasContentDescription("Question")).getUnclippedBoundsInRoot()
        question = compose.onNodeWithText("Second question").getUnclippedBoundsInRoot()
        val answer = compose.onNodeWithText("The complete answer is visible here.").getUnclippedBoundsInRoot()
        assertTrue("expanded viewport retains the question anchor: question=$question viewport=$viewport", question.top >= viewport.top && question.top <= viewport.top + 32.dp)
        assertTrue("the entire answer clears the composer", answer.top >= question.bottom && answer.bottom <= viewport.bottom)
        compose.onNodeWithText("First question").assertIsNotDisplayed()
        compose.runOnIdle { assertEquals(listOf("Second question"), sent) }
        scope.cancel()
    }

    @Test
    fun askingNewCannotReuseThePreviousConversationsShortQuestionPositions() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var conversation by mutableStateOf("old-thread")
        var thread by mutableStateOf((1..4).map { AskExchange("Old question $it", AskAnswer("Short answer.", ReadTally(0, 0, 0))) })
        val sent = mutableListOf<String>()
        compose.setContent {
            AskScreen(store, thread, emptyList(), emptySet(), false, null,
                onAsk = {
                    sent += it
                    conversation = "new-thread"
                    val answer = if (thread.isEmpty()) "A much longer training history. ".repeat(60) else "The new answer is here."
                    thread = thread + AskExchange(it, AskAnswer(answer, ReadTally(0, 0, 0)))
                }, onRetry = {}, onAskNew = { conversation = ""; thread = emptyList() }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, conversationId = conversation,
                onNewDraft = { conversation = ""; thread = emptyList() })
        }
        compose.onNode(hasContentDescription("More")).performClick()
        compose.onNodeWithText("New chat").performClick()
        compose.onNodeWithContentDescription("Question").performTextReplacement("New first question")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.onNodeWithContentDescription("Question").performTextReplacement("New second question")
        compose.onNodeWithContentDescription("Send").performClick()
        val viewport = compose.onNode(hasScrollAction() and !hasContentDescription("Question")).getUnclippedBoundsInRoot()
        val question = compose.onNodeWithText("New second question").getUnclippedBoundsInRoot()
        assertTrue("new conversation uses its own measured anchor: $question in $viewport",
            question.top >= viewport.top && question.top <= viewport.top + 32.dp)
        compose.onNodeWithText("The new answer is here.").assertIsDisplayed()
        compose.onNodeWithText("New first question").assertIsNotDisplayed()
        compose.onNodeWithText("Old question 2").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("New first question", "New second question"), sent) }
        scope.cancel()
    }

    @Test
    fun aConfirmedMissingProposalKeepsTheAnswerWithoutOfferingReadRetry() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val thread = listOf(AskExchange("What next?", AskAnswer("The original answer.", ReadTally(0, 0, 0), proposals = listOf("prop_gone"))))
        compose.setContent {
            AskScreen(store, thread, emptyList(), emptySet(), false, null, {}, {}, {}, "", "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {})
        }
        compose.onNodeWithText("The original answer.").assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText("Review").assertDoesNotExist()
        compose.onNodeWithText("Reading proposal…").assertDoesNotExist()
        scope.cancel()
    }

    // Snapshots land about once a second; what each one adds after the room mounted is paced by
    // the frame clock, and a stop shows the whole text at the next frame.
    @Test
    fun aRunningAnswerIsPacedBetweenSnapshotsAndAStopShowsItWholeAtTheNextFrame() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val opening = "Opening words."
        val first = opening + " " + "word ".repeat(60).trim()
        val whole = first + " " + "more ".repeat(60).trim()
        var generation by mutableStateOf(AskGeneration("generation-a", "request-a", "Question", "running", opening, revision = 1))
        compose.mainClock.autoAdvance = false
        compose.setContent {
            AskScreen(store, listOf(generation.exchange()), emptyList(), emptySet(), !generation.terminal, null,
                onAsk = {}, onRetry = {}, onAskNew = {}, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, conversationId = "thread-a", onStop = {})
        }
        fun shown(): String = compose.onAllNodes(hasText("word", substring = true), useUnmergedTree = true)
            .fetchSemanticsNodes().joinToString("") { node -> node.config[SemanticsProperties.Text].joinToString("") { it.text } }
        assertEquals(opening, shown())
        compose.runOnIdle { generation = generation.copy(answer = first, revision = 2) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(150)
        val early = shown()
        assertTrue("early shows ${early.length} of ${first.length}", early.length > opening.length && early.length < first.length && first.startsWith(early))
        compose.mainClock.advanceTimeBy(1500)
        assertEquals(first, shown())
        compose.runOnIdle { generation = generation.copy(answer = whole, revision = 3) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(150)
        val mid = shown()
        assertTrue("mid shows ${mid.length}", mid.length > first.length && mid.length < whole.length && whole.startsWith(mid))
        compose.runOnIdle { generation = generation.copy(status = "stopped", revision = 4) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeByFrame()
        assertEquals(whole, shown())
        compose.onNodeWithText(Ask.stopped).assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun aCompleteAnswerIsWholeOnItsFirstFrame() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val answer = "word ".repeat(60).trim()
        compose.mainClock.autoAdvance = false
        room(signedIn(scope).store, thread = listOf(AskExchange("Question", AskAnswer(answer, ReadTally()))), cap = null, doors = mutableListOf())
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithText(answer).assertIsDisplayed()
        scope.cancel()
    }

    // A room revisited mid-stream (tab switch, reopened thread, recreation) mounts on the text it
    // already has: nothing re-types, and the waiting line never shows over text that is there.
    @Test
    fun aRunningAnswerAlreadyReceivedIsWholeOnItsFirstFrameAndNeverRetypes() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val partial = "word ".repeat(300).trim().take(1499)
        val generation = AskGeneration("generation-a", "request-a", "Question", "running", partial, revision = 7)
        compose.mainClock.autoAdvance = false
        compose.setContent {
            AskScreen(store, listOf(generation.exchange()), emptyList(), emptySet(), true, null,
                onAsk = {}, onRetry = {}, onAskNew = {}, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, conversationId = "thread-a", onStop = {})
        }
        fun shown(): String = compose.onAllNodes(hasText("word", substring = true), useUnmergedTree = true)
            .fetchSemanticsNodes().joinToString("") { node -> node.config[SemanticsProperties.Text].joinToString("") { it.text } }
        assertEquals(partial, shown())
        compose.onNodeWithText(Ask.waiting).assertDoesNotExist()
        repeat(3) {
            compose.mainClock.advanceTimeByFrame()
            assertEquals(partial, shown())
            compose.onNodeWithText(Ask.waiting).assertDoesNotExist()
        }
        scope.cancel()
    }

}
