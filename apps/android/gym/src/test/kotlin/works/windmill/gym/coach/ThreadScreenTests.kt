package works.windmill.gym.coach

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import java.io.File
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
import works.windmill.agent.TurnLine
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnTransport
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Instant
import works.windmill.domain.kit.Repository
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.domain.coach.RecordedRead
import works.windmill.gym.domain.coach.inOrder
import works.windmill.gym.presentation.ChangeKind
import works.windmill.gym.presentation.ProposalChange
import works.windmill.gym.presentation.ProposalTargets
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.domain.sync.ProposalRules
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.ProposalOutcome
import works.windmill.gym.store.ProposalRead
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.sync.api.Change
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.modelserver.ServerCall
import works.windmill.sync.schema.Gym
import works.windmill.gym.domain.sync.Exercise as SyncExercise
import works.windmill.gym.domain.sync.RoutineEntry as SyncEntry
import works.windmill.gym.domain.sync.SetTarget as SyncTarget

// A conversation the replica holds, opened from History: the screen reads its records as the application does, and its proposal cards from the log.
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

    private fun signedIn(scope: CoroutineScope, turns: TurnTransport? = null, disk: LocalCoach? = null): EngineRoomFixture =
        EngineRoomFixture(tmp.newFolder(), scope, coachServer = turns, localCoach = disk).also { room ->
            rooms += room
            runBlocking { room.select("u1") }
        }

    // What a thread says once its turns ended: each question and answer as a record, and what the last answer's calls did.
    private fun said(room: EngineRoomFixture, thread: String, vararg turns: Pair<String, String>, calls: List<AbilityCall> = emptyList()) {
        val threadId = Id<CoachThread>(thread, CoachThread)
        val messages = turns.flatMapIndexed { at, (question, answer) ->
            val moment = Instant(room.now++)
            listOf(
                CoachMessage(Id("$thread-question-$at", CoachMessage), threadId, CoachMessage.Role.lifter, text = question, at = moment),
                CoachMessage(Id("$thread-answer-$at", CoachMessage), threadId, CoachMessage.Role.coach, room.engine.activeReplica(), answer, MessageState.completed,
                    calls = if (at == turns.lastIndex) calls else emptyList(), at = moment),
            )
        }
        val written = listOf(Change.create(Gym.Types.thread, NewID.Given(RecordID(thread)), CoachThread(threadId, turns.first().first).fields())) +
            messages.map { Change.create(Gym.Types.message, NewID.Given(it.id.record), it.fields()) }
        assertTrue(room.engine.commit(ScopeRef(Gym.scope), Gesture(written)) is CommitOutcome.Committed)
    }

    private fun proposed(id: String) = AbilityCall("call-$id", "propose_routine_change", null, AbilityCall.Outcome.Ok, created = listOf(RecordRef(Gym.Types.proposal, RecordID(id))))

    private fun messages(room: EngineRoomFixture): List<CoachMessage> = room.engine.read(ScopeRef(Gym.scope)) { read ->
        Repository.decode(CoachMessage, read.drawn(CoachMessage.type))
    }.inOrder

    // The node once the screen's read of the replica has landed.
    private fun read(text: String): SemanticsNodeInteraction {
        compose.waitUntil(10_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
        return compose.onNodeWithText(text)
    }

    @Test
    fun historyDatesEachConversationAndKeepsItsRowToTheQuestionAndTheAnswer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = signedIn(scope)
        said(room, "thread-created", "Make a push routine" to "Push A is ready.")
        said(room, "thread-ordinary", "How was my workout?" to "It went well.")
        room.store.observeEngine()
        val threads = ThreadsBinding(room.store.coach)
        val opened = mutableListOf<String>()
        compose.setContent { ThreadsScreen(threads, threads, "Coach", {}, { opened += it }, {}) }

        read("Make a push routine").assertIsDisplayed()
        compose.onNodeWithText("Push A is ready.").assertIsDisplayed()
        compose.onNodeWithText("How was my workout?").assertIsDisplayed()
        compose.onNodeWithText("It went well.").assertIsDisplayed()
        compose.onAllNodes(hasText("Today")).assertCountEquals(2)
        compose.onNodeWithText("Read only").assertDoesNotExist()
        compose.onNodeWithText("Your conversations").assertDoesNotExist()
        compose.onNodeWithText("How was my workout?").performClick()
        compose.runOnIdle { assertEquals(listOf("thread-ordinary"), opened) }
        scope.cancel()
    }

    @Test
    fun aConversationFromHistoryAsksItsFifthQuestionUnderItsOwnThread() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val turns = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"nothing has moved in three weeks."}},{"event":"done","data":{"state":"completed"}}]""").arr())
        val room = signedIn(scope, turns)
        room.sync(EngineRoomFixture.server())
        said(room, "thread-old", *(1..4).map { "Question $it" to "Answer $it" }.toTypedArray())
        room.store.observeEngine()
        val ask = AskBinding(room.store)
        compose.setContent { ThreadScreen(ask, ask, "thread-old", emptyList(), emptySet(), "History", {}, {}, {}) }
        read("Answer 4")
        compose.onNodeWithContentDescription("Question").performTextReplacement("Question 5")
        compose.onNodeWithContentDescription("Send").performClick()
        read("nothing has moved in three weeks.").performScrollTo().assertIsDisplayed()
        compose.runOnIdle {
            val opened = turns.opened.single()
            assertEquals("Question 5", opened.question)
            assertEquals((1..4).flatMap { listOf(TurnLine("lifter", "Question $it"), TurnLine("coach", "Answer $it")) }, opened.history)
            assertEquals(listOf(CoachThread(Id("thread-old", CoachThread), "Question 1")), room.engine.read(ScopeRef(Gym.scope)) { read ->
                Repository.decode(CoachThread, read.drawn(CoachThread.type))
            })
            val fifth = messages(room).takeLast(2)
            assertEquals(listOf("thread-old", "thread-old"), fifth.map { it.threadId.record.string })
            assertEquals(listOf("Question 5", "nothing has moved in three weeks."), fifth.map { it.text })
        }
        scope.cancel()
    }

    @Test
    fun aRefusedSendReturnsItsQuestionToTheComposerEditableAndTheTranscriptHoldsOnlyWhatWasSaid() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val turns = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Pulldowns it is."}},{"event":"done","data":{"state":"completed"}}]""").arr())
            .apply { refuseOpen = TurnRefusal(429, "subject_exhausted", null) }
        val file = File(tmp.newFolder(), LocalCoach.fileName)
        val room = signedIn(scope, turns, LocalCoach(file))
        room.sync(EngineRoomFixture.server())
        said(room, "thread-held", "How heavy?" to "Eight reps.")
        room.store.observeEngine()
        val ask = AskBinding(room.store)
        compose.setContent { ThreadScreen(ask, ask, "thread-held", emptyList(), emptySet(), "History", {}, {}, {}) }
        read("Eight reps.")
        compose.onNodeWithContentDescription("Question").performTextReplacement("Swap chin-ups for pulldowns")
        compose.onNodeWithContentDescription("Send").performClick()
        read("You have used all of your AI allowance.").performScrollTo().assertIsDisplayed()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Swap chin-ups for pulldowns").fetchSemanticsNodes().size == 1 }
        compose.onNode(hasText("Swap chin-ups for pulldowns") and hasSetTextAction()).assertIsDisplayed()
        assertEquals("the refused question draws no header of its own", 1, compose.onAllNodesWithText("Today ", substring = true).fetchSemanticsNodes().size)
        compose.runOnIdle {
            assertEquals(CoachDraft("Swap chin-ups for pulldowns"), LocalCoach(file).draft("u1", "thread-held"))
            assertEquals(listOf("How heavy?", "Eight reps."), messages(room).map { it.text })
            turns.refuseOpen = null
        }
        compose.onNodeWithContentDescription("Question").performTextReplacement("Swap them, please")
        compose.onNodeWithContentDescription("Send").performClick()
        read("Pulldowns it is.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("You have used all of your AI allowance.").assertDoesNotExist()
        compose.onNodeWithContentDescription("Question").assert(hasText(""))
        compose.runOnIdle {
            assertEquals(listOf("Swap chin-ups for pulldowns", "Swap them, please"), turns.opened.map { it.question })
            assertEquals(CoachDraft(), LocalCoach(file).draft("u1", "thread-held"))
            assertEquals(listOf("How heavy?", "Eight reps.", "Swap them, please", "Pulldowns it is."), messages(room).map { it.text })
        }
        scope.cancel()
    }

    @Test
    fun aRunningAnswerReadsFromItsRecordsAndStopKeepsWhatArrived() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val turns = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading your week"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""").arr())
        val room = signedIn(scope, turns)
        room.sync(EngineRoomFixture.server())
        said(room, "thread-held", "How heavy?" to "Eight reps.")
        room.store.observeEngine()
        val ask = AskBinding(room.store)
        compose.setContent { ThreadScreen(ask, ask, "thread-held", emptyList(), emptySet(), "History", {}, {}, {}) }
        read("Eight reps.")
        compose.onNodeWithContentDescription("Question").performTextReplacement("Is my week too light?")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithContentDescription("Stop response").fetchSemanticsNodes().isNotEmpty() }
        read("Reading your week").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Coach is thinking").assertDoesNotExist()
        compose.mainClock.advanceTimeBy(1_000)
        compose.onNodeWithContentDescription("Stop response").performClick()
        read(Ask.stopped).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Reading your week").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Stop response").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(1, turns.stops)
            val answer = messages(room).last()
            assertEquals(MessageState.stopped, answer.state)
            assertEquals("Reading your week", answer.text)
        }
        scope.cancel()
    }

    @Test
    fun aTurnRunningInAnotherChatOffersThatChatFromAnEmptyOne() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val turns = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""").arr())
        val room = signedIn(scope, turns)
        room.sync(EngineRoomFixture.server())
        room.store.observeEngine()
        val coach = room.store.coach
        val running = coach.freshChat()
        assertTrue(coach.send(running, "Plan my week"))
        val empty = coach.freshChat()
        val opened = mutableListOf<String>()
        val ask = AskBinding(room.store)
        compose.setContent { ThreadScreen(ask, ask, empty, emptyList(), emptySet(), "History", {}, {}, {}, onOpenChat = { opened += it }) }
        read("Answer in progress").assertIsDisplayed()
        compose.onNodeWithText("Plan my week").assertIsDisplayed()
        compose.onNodeWithText("View chat").performClick()
        compose.runOnIdle {
            assertEquals(listOf(running), opened)
            coach.stop()
        }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Answer in progress").fetchSemanticsNodes().isEmpty() }
        scope.cancel()
    }

    @Test
    fun aFreshChatWaitsOnTheAnswerRunningInAnotherAndSendComesBackWhenItEnds() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val turns = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""").arr())
        val room = signedIn(scope, turns)
        room.sync(EngineRoomFixture.server())
        room.store.observeEngine()
        val coach = room.store.coach
        assertTrue(coach.send(coach.freshChat(), "Is Push A still doing anything?"))
        val fresh = coach.freshChat()
        coach.saveDraft(fresh, CoachDraft("How was my week?"))
        val telling = TellingRecorder()
        val ask = AskBinding(room.store)
        compose.setContent { CompositionLocalProvider(LocalTelemetry provides telling) { ThreadScreen(ask, ask, fresh, emptyList(), emptySet(), "History", {}, {}, {}, onOpenChat = {}) } }
        read("Answer in progress").assertIsDisplayed()
        compose.onNodeWithText("Is Push A still doing anything?").assertIsDisplayed()
        compose.onNodeWithText("View chat").assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        assertEquals(CoachDraft("How was my week?"), coach.draft(fresh))
        assertEquals(listOf(mapOf("screen" to "coach", "action" to "answer_in_progress", "outcome" to "shown")),
            telling.named("gym_action").filter { it["action"] == "answer_in_progress" })
        compose.runOnIdle { coach.stop() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Answer in progress").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithContentDescription("Send").assertIsEnabled()
        scope.cancel()
    }

    @Test
    fun aQuestionPastItsBoundSaysHowFarInTheRoomHoldsItsTextAndSendAndComesBackWithinIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = signedIn(scope, ScriptedTurns(emptyList()))
        val coach = room.store.coach
        val chat = coach.freshChat()
        coach.saveDraft(chat, CoachDraft("x".repeat(9_400)))
        val ask = AskBinding(room.store)
        compose.setContent { ThreadScreen(ask, ask, chat, emptyList(), emptySet(), "History", {}, {}, {}) }
        val words = "Too long by 1,400 bytes. The limit is 8,000 bytes.\nEnglish letters take 1 byte each. Other letters and emoji take more."
        read(words).assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Question").performTextReplacement("Back within it")
        compose.waitUntil(5_000) { compose.onAllNodesWithText(words).fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithContentDescription("Send").assertIsEnabled()
        assertEquals(CoachDraft("Back within it"), coach.draft(chat))
        scope.cancel()
    }

    @Test
    fun aPastedLoneSurrogateSendsFromTheComposerWithItsReplacementAndNothingThrows() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val turns = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Noted"}},{"event":"done","data":{"state":"completed"}}]""").arr())
        val telling = TellingRecorder()
        val room = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telling, coachServer = turns, localCoach = LocalCoach(File(tmp.newFolder(), LocalCoach.fileName))).also { rooms += it }
        runBlocking { room.select("u1") }
        room.sync(EngineRoomFixture.server())
        room.store.observeEngine()
        val coach = room.store.coach
        val chat = coach.freshChat()
        val ask = AskBinding(room.store)
        compose.setContent { ThreadScreen(ask, ask, chat, emptyList(), emptySet(), "History", {}, {}, {}) }
        compose.onNodeWithContentDescription("Question").performTextReplacement("Bench \uD83D press")
        compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
        compose.waitUntil(5_000) { compose.runOnIdle { turns.opened.isNotEmpty() } }
        assertEquals(listOf("Bench \uFFFD press"), turns.opened.map { it.question })
        compose.waitUntil(5_000) { compose.runOnIdle { !coach.isAsking(chat) } }
        assertEquals(null, coach.fault)
        assertEquals(emptyList<Map<String, String>>(), telling.failures)
        scope.cancel()
    }

    @Test
    fun aSendTheAccountsChangeStoppedSaysSoAloneSendWaitsForTheSeatAndTheSentenceGoesWithTheChange() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val telling = TellingRecorder()
        var writable = true
        val room = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telling, writeAuthority = { writable }, coachServer = ScriptedTurns(emptyList())).also { rooms += it }
        runBlocking { room.select("account-1") }
        room.sync(EngineRoomFixture.server())
        val coach = room.store.coach
        val chat = coach.freshChat()
        coach.saveDraft(chat, CoachDraft("What should Thursday look like?"))
        writable = false
        assertTrue(coach.send(chat, "What should Thursday look like?"))
        val ask = AskBinding(room.store)
        compose.setContent { CompositionLocalProvider(LocalTelemetry provides telling) { ThreadScreen(ask, ask, chat, emptyList(), emptySet(), "History", {}, {}, {}) } }
        read("Your account is changing. Your question is kept here.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        assertEquals(CoachDraft("What should Thursday look like?"), coach.draft(chat))
        assertEquals(listOf(mapOf("screen" to "coach", "action" to "account_changing", "outcome" to "shown")),
            telling.named("gym_action").filter { it["action"] == "account_changing" })
        compose.runOnIdle { writable = true; room.coachTurns?.sweep() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Your account is changing. Your question is kept here.").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithContentDescription("Send").assertIsEnabled()
        scope.cancel()
    }

    @Test
    fun aSeatAlreadySettledNeverStrandsTheQuestionASendsChangeKept() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        var writable = true
        val room = EngineRoomFixture(tmp.newFolder(), scope, writeAuthority = { writable }, coachServer = ScriptedTurns(emptyList())).also { rooms += it }
        runBlocking { room.select("account-1") }
        room.sync(EngineRoomFixture.server())
        val coach = room.store.coach
        val chat = coach.freshChat()
        coach.saveDraft(chat, CoachDraft("What should Thursday look like?"))
        writable = false
        assertTrue(coach.send(chat, "What should Thursday look like?"))
        compose.waitUntil(5_000) { compose.runOnIdle { coach.accountChanging } }
        writable = true
        val ask = AskBinding(room.store)
        compose.setContent { ThreadScreen(ask, ask, chat, emptyList(), emptySet(), "History", {}, {}, {}) }
        read("Your account is changing. Your question is kept here.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").assertIsEnabled()
        scope.cancel()
    }

    private fun saved(room: EngineRoomFixture, server: ModelServer, draft: RoutineDraft): Routine = runBlocking {
        (room.store.routines.saveRoutine(draft.capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value.also { room.sync(server) }
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
        val decision = async { room.store.routines.applyProposal("proposal1") }
        while (room.outbox().isEmpty() && !decision.isCompleted) yield()
        room.sync(server)
        decision.await() as ProposalOutcome.Decided
    }

    private fun pushDay(room: EngineRoomFixture, server: ModelServer) =
        saved(room, server, RoutineDraft(name = "Push Day").adding("bench-press", List(3) { SetTarget(5) }))

    // The stored conversation's proposal row is the Coach room's card: the model's prose, the counted line, and one affordance, Review.
    @Test
    fun theStoredThreadsProposalRowCarriesReviewAndTheSummaryLikeTheCoachCard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = pushDay(room, server)
        propose(room, server, routine)
        said(room, "thread0001", "Is my week too light?" to "Heavier triples would help.", calls = listOf(proposed("proposal1")))
        room.store.observeEngine()
        val doors = mutableListOf<String>()
        val ask = AskBinding(room.store)
        compose.setContent {
            ThreadScreen(
                threadId = "thread0001", state = ask, events = ask, receipts = emptyList(), lookedAt = setOf("proposal1"),
                backTo = "Coach", onBack = {}, onReview = { doors += it.id }, say = {},
            )
        }

        read("Proposal · Push Day").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Heavier triples.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("1 change · still waiting").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("proposal1"), doors) }
        scope.cancel()
    }

    @Test fun aProposalKeepsItsAnswersReceiptBesideTheUnchangedReviewCard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = pushDay(room, server)
        propose(room, server, routine)
        said(room, "thread0001", "Is my week too light?" to "Keep the proposal review here.", calls = listOf(
            AbilityCall("call-read", "list_sessions", null, AbilityCall.Outcome.Ok, read = RecordedRead.Counts(ReadTally(sessions = 1, weeks = 1))),
            proposed("proposal1")))
        room.store.observeEngine()
        val ask = AskBinding(room.store)
        compose.setContent { ThreadScreen(ask, ask, "thread0001", emptyList(), emptySet(), "Coach", {}, {}, {}) }
        read("Proposal · Push Day").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Read 1 workout · 1 week").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Heavier triples.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review").performScrollTo().assertIsDisplayed()
        scope.cancel()
    }

    // No prose on the log: the card still says what it counts.
    @Test
    fun aProposalRowWithoutProseFallsBackToTheCountedSummary() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = pushDay(room, server)
        propose(room, server, routine, summary = "")
        said(room, "thread0001", "Is my week too light?" to "Heavier triples would help.", calls = listOf(proposed("proposal1")))
        room.store.observeEngine()
        val ask = AskBinding(room.store)
        compose.setContent {
            ThreadScreen(
                threadId = "thread0001", state = ask, events = ask, receipts = emptyList(), lookedAt = emptySet(),
                backTo = "Coach", onBack = {}, onReview = {}, say = {},
            )
        }
        read("1 change to Push Day.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review").performScrollTo().assertIsDisplayed()
        scope.cancel()
    }

    // A decision in this room overrides the card's copy: once a receipt lands, the row is read back rather than left saying `waiting` beside `Applied`.
    @Test
    fun afterApplyTheStoredThreadReadsAppliedBesideTheReceiptAndNeverWaiting() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = pushDay(room, server)
        propose(room, server, routine)
        said(room, "thread0001", "Is my week too light?" to "Heavier triples would help.", calls = listOf(proposed("proposal1")))
        room.sync(server)
        room.store.observeEngine()
        var receipts by mutableStateOf<List<String>>(emptyList())
        val ask = AskBinding(room.store)
        compose.setContent {
            ThreadScreen(
                threadId = "thread0001", state = ask, events = ask, receipts = receipts, lookedAt = emptySet(),
                backTo = "Coach", onBack = {}, onReview = {}, say = {},
            )
        }
        read("1 change").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal.")
            .performScrollTo().assertIsDisplayed()

        val settled = applied(room, server)
        compose.runOnIdle { receipts = listOf(settled.proposal.receipt!!) }

        compose.onNodeWithText("Applied · Push Day · 1 change").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("1 change").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Proposal · Push Day").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("waiting", substring = true).assertDoesNotExist()
        compose.onNodeWithText(Ask.promise).assertDoesNotExist()
        scope.cancel()
    }

    // The phone holds no row of the proposal and has not read the account past the miss: nothing claims it is gone.
    @Test
    fun aPastReceiptWhoseProposalIsNotOnThePhoneKeepsProseWithoutInventingItsOutcomeOrRetry() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = signedIn(scope)
        said(room, "thr_removed", "What about this routine?" to "The original proposal explanation.", calls = listOf(proposed("prop_removed")))
        val outbox = room.outbox()
        val records = messages(room)
        room.store.observeEngine()
        val ask = AskBinding(room.store)
        compose.setContent {
            ThreadScreen(ask, ask, "thr_removed", emptyList(), emptySet(), "Coach", {}, {}, {})
        }
        read("The original proposal explanation.").assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.onNodeWithText("Review").assertDoesNotExist()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText("Read-only").assertDoesNotExist()
        compose.onNodeWithText("Applied").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(records, messages(room))
            assertEquals("nothing was decided", outbox, room.outbox())
        }
        scope.cancel()
    }

    @Test
    fun aConfirmedRemovalReceiptStaysVisibleWhenTheConversationReopens() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = pushDay(room, server)
        fun entry(exerciseId: String, sets: List<SetTarget>) =
            SyncEntry(Id(exerciseId, SyncExercise), sets.takeIf { it.isNotEmpty() }?.map { SyncTarget(it.reps, it.weightKg) })
        fun slot(value: Json) = Json.array(value, Json.Null)
        val diff = ProposalRules.changesBetween(routine.entries.map { entry(it.exerciseId, it.sets) }, emptyList())
        val written = Json.objectOf("t" to Json.of("proposal"), "id" to Json.of("proposal1"), "born" to Json.Null,
            "life" to Json.array(Json.of("alive"), Json.Null), "f" to Json.objectOf(
                "routineId" to slot(Json.of(routine.id)), "intent" to slot(Json.of("remove")), "proposedName" to slot(Json.of("")),
                "summary" to slot(Json.of("Remove this routine.")), "changes" to slot(Json.Arr(diff.map { it.json })),
                "door" to slot(Json.of("ask")), "connection" to slot(Json.of("")), "agent" to slot(Json.of("")),
                "threadId" to slot(Json.of("thread0001"))))
        assertEquals(Json.of("ok"), server.call(ServerCall("u1", null, "propose", Json.objectOf(),
            listOf(Json.objectOf("scope" to Json.of("self/gym"), "d" to Json.array(written)))), room.now)?.get("s"))
        room.pull(server)
        said(room, "thread0001", "Should this routine go?" to "The original removal explanation.", calls = listOf(proposed("proposal1")))
        room.sync(server)
        val records = messages(room)
        room.store.observeEngine()
        var receipts by mutableStateOf<List<String>>(emptyList())
        var visit by mutableStateOf(0)
        val reviewed = mutableListOf<String>()
        val ask = AskBinding(room.store)
        compose.setContent {
            key(visit) { ThreadScreen(ask, ask, "thread0001", receipts, emptySet(), "Coach", {}, { reviewed += it.id }, {}) }
        }
        read("Remove this routine.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal.")
            .performScrollTo().assertIsDisplayed()
        val settled = applied(room, server)
        compose.runOnIdle {
            receipts = listOf(requireNotNull(settled.proposal.receipt))
            visit++
        }
        read(requireNotNull(settled.proposal.receipt)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Remove this routine.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review").performScrollTo().performClick()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.onNodeWithText(Ask.promise).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf("proposal1"), reviewed)
            assertEquals(ProposalRead.Found(settled.proposal), runBlocking { room.store.routines.proposal("proposal1") })
            assertEquals(records, messages(room))
        }
        scope.cancel()
    }

    @Test
    fun aReceiptOnlyProposalAppearsWhenTheThreadReopensAfterPull() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = pushDay(room, server)
        EngineRoomFixture(tmp.newFolder(), scope).use { coach ->
            runBlocking { coach.select("u1") }
            coach.pull(server)
            propose(coach, server, routine)
        }
        said(room, "thread0001", "My question" to "The original answer.", calls = listOf(proposed("proposal1")))
        val records = messages(room)
        room.store.observeEngine()
        var visit by mutableStateOf(0)
        val ask = AskBinding(room.store)
        compose.setContent {
            key(visit) { ThreadScreen(ask, ask, "thread0001", emptyList(), emptySet(), "Coach", {}, {}, {}) }
        }
        read("The original answer.").assertIsDisplayed()
        compose.onNodeWithText("Review").assertDoesNotExist()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.runOnIdle { room.pull(server); visit++ }
        read("Heavier triples.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.runOnIdle { assertEquals(records, messages(room)) }
        scope.cancel()
    }
}
