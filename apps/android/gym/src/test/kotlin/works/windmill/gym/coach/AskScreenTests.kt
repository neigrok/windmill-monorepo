package works.windmill.gym.coach

import works.windmill.gym.coach.turn.CoachTurnFault
import works.windmill.gym.ui.*
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import kotlinx.coroutines.launch
import works.windmill.agent.TurnConnectionLost
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnTransport
import works.windmill.domain.kit.Repository
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.AbilityRefusal
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.presentation.ChangeKind
import works.windmill.gym.presentation.ProposalIntent
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
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.domain.kit.Id
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.Pulls
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.modelserver.ServerCall
import works.windmill.sync.schema.Gym
import works.windmill.gym.domain.sync.Exercise as SyncExercise
import works.windmill.gym.domain.sync.RoutineEntry as SyncEntry
import works.windmill.gym.domain.sync.SetTarget as SyncTarget

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AskScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val rooms = mutableListOf<EngineRoomFixture>()

    @After
    fun closeRooms() = rooms.forEach(EngineRoomFixture::close)

    private fun signedIn(scope: CoroutineScope): EngineRoomFixture =
        EngineRoomFixture(tmp.newFolder(), scope).also { room ->
            rooms += room
            runBlocking { room.select("u1") }
        }

    private fun signedOut(scope: CoroutineScope): EngineRoomFixture =
        EngineRoomFixture(tmp.newFolder(), scope).also { room ->
            rooms += room
            runBlocking { room.select(null) }
        }

    // A question on its way, and an answer as the room draws it with the proposals its calls minted.
    private fun asking(question: String, id: String = "request-a") = CoachExchange(id, question, 0, sending = true)

    private fun answered(question: String, text: String, id: String = "request-a", proposals: List<String> = emptyList(), atMs: Long = 0) =
        CoachExchange(id, question, atMs, answer = coachReply(text, id = "$id-answer", created = proposals.map { RecordRef(Gym.Types.proposal, RecordID(it)) }))

    private fun saved(room: EngineRoomFixture, server: ModelServer, draft: RoutineDraft): Routine = runBlocking {
        (room.store.routines.saveRoutine(draft.capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value.also { room.sync(server) }
    }

    // Coach writes a proposal on the server, and this phone pulls it.
    private fun propose(room: EngineRoomFixture, server: ModelServer, id: String, routine: Routine, changes: List<ProposalChange>,
                        summary: String, intent: ProposalIntent = ProposalIntent.Revise, pull: Boolean = true) {
        fun entry(exerciseId: String, sets: List<SetTarget>) =
            SyncEntry(Id(exerciseId, SyncExercise), sets.takeIf { it.isNotEmpty() }?.map { SyncTarget(it.reps, it.weightKg) })
        val proposed = if (intent == ProposalIntent.Remove) emptyList()
            else changes.filter { it.kind != ChangeKind.Removed }.map { entry(it.exerciseId, it.after!!.sets) }
        val diff = ProposalRules.changesBetween(routine.entries.map { entry(it.exerciseId, it.sets) }, proposed)
        fun slot(value: Json) = Json.array(value, Json.Null)
        val written = Json.objectOf("t" to Json.of("proposal"), "id" to Json.of(id), "born" to Json.Null,
            "life" to Json.array(Json.of("alive"), Json.Null), "f" to Json.objectOf(
                "routineId" to slot(Json.of(routine.id)), "intent" to slot(Json.of(intent.wire)),
                "proposedName" to slot(Json.of(if (intent == ProposalIntent.Remove) "" else routine.name)),
                "summary" to slot(Json.of(summary)), "changes" to slot(Json.Arr(diff.map { it.json })),
                "door" to slot(Json.of("ask")), "connection" to slot(Json.of("")), "agent" to slot(Json.of(""))))
        val reply = server.call(ServerCall(room.selected!!, null, "propose", Json.objectOf(),
            listOf(Json.objectOf("scope" to Json.of("self/gym"), "d" to Json.array(written)))), room.now)
        assertEquals(Json.of("ok"), reply?.get("s"))
        if (!pull) return
        room.pull(server)
        assertEquals(changes, runBlocking { room.training.proposal(id) }?.changes)
    }

    // A decision waits for the server's receipt, so the phone syncs while it is pending.
    private fun applied(room: EngineRoomFixture, server: ModelServer, id: String) = runBlocking {
        val decision = async { room.store.routines.applyProposal(id) }
        while (room.outbox().isEmpty() && !decision.isCompleted) yield()
        room.sync(server)
        decision.await() as ProposalOutcome.Decided
    }

    private fun room(
        store: TrainingStore,
        thread: List<CoachExchange>,
        refusal: CoachTurnRefusal?,
        doors: MutableList<String>,
    ) {
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(
                state = ask, events = ask,
                thread = thread,
                receipts = emptyList(),
                lookedAt = emptySet(),
                asking = false,
                refusal = refusal,
                onAsk = { text, _ -> doors += "ask:$text" },
                seed = "",
                origin = "https://windmill.works",
                onThreads = { doors += "threads" },
                onConnections = { doors += "connections" },
                onSignIn = { doors += "signIn" },
                onReview = {}, seat = "A",
            )
        }
    }

    // The room as it reports what it reads: `thread` is read each frame, so a test hands it an answer in the same visit.
    private fun roomTelling(store: TrainingStore, telling: TellingRecorder, thread: () -> List<CoachExchange>) {
        val ask = AskBinding(store)
        compose.setContent {
            CompositionLocalProvider(LocalTelemetry provides telling) {
                AskScreen(ask, ask, thread(), emptyList(), emptySet(), false, null, { _, _ -> }, "", "https://windmill.works",
                    onThreads = {}, onReview = {})
            }
        }
    }

    @Test fun continuingAKeptDraftPreservesTheCurrentComposerAndRestoresAPhotoOnlyDraft() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val file = java.io.File(tmp.root, "held.json")
        val disk = LocalCoach(file)
        val phone = disk.anonymousOwner()
        val bitmap = android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888)
        val bytes = java.io.ByteArrayOutputStream().also { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        bitmap.recycle()
        val photo = CoachAttachment("photo-123", "image/png", 1, 1, bytes.size.toLong())
        disk.saveChat(phone, LocalChat("phone-chat", 1, setup = true), true)
        disk.savePhoto(phone, photo.id, bytes); disk.saveDraft(phone, "phone-chat", CoachDraft(photo = photo))
        disk.saveChat("u1", LocalChat("account-chat", 1), true); disk.saveDraft("u1", "account-chat", CoachDraft("Account draft"))
        disk.adoptPhoneDraft("u1") { true }
        val held = disk.keptDrafts("u1", "account-chat").single()
        val room = EngineRoomFixture(tmp.newFolder(), scope, localCoach = disk).also { rooms += it }
        runBlocking { room.select("u1") }
        val sent = mutableListOf<String>()
        val ask = AskBinding(room.store)
        compose.setContent { GymMaterial { AskScreen(ask, ask, emptyList(), emptyList(), emptySet(), false, null,
            { text, _ -> sent += text }, "", "http://localhost", onThreads = {}, onReview = {}, conversationId = "account-chat") } }
        compose.onNodeWithText("Draft kept on this phone").assertIsDisplayed()
        compose.onNodeWithContentDescription("Question").performTextReplacement("Just typed")
        compose.onNodeWithText("Continue saved draft").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Question").assert(hasText(""))
        compose.onNodeWithContentDescription("Attached photo").assertIsDisplayed()
        compose.onNodeWithText("Just typed").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(emptyList<String>(), sent)
            assertEquals(held.draft, LocalCoach(file).draft("u1", "account-chat"))
            assertEquals(listOf(held.copy(draft = CoachDraft("Just typed"))), LocalCoach(file).keptDrafts("u1", "account-chat"))
        }
        compose.onNodeWithText("Continue saved draft").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Question").assert(hasText("Just typed"))
        compose.onNodeWithContentDescription("Attached photo").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf(held), LocalCoach(file).keptDrafts("u1", "account-chat")) }
    }

    @Test fun anUnreadablePublishedSwapKeepsTheVisibleDraftAndTheAnswerSafeDuringRecomposition() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val file = java.io.File(tmp.root, "unreadable-ui.json")
        val published = java.io.File(tmp.root, "published-ui.json")
        var unreadable = false
        val disk = LocalCoach(file) { target, text ->
            works.windmill.platform.storage.AtomicDocument.write(target, text)
            if (unreadable) { check(target.renameTo(published)); check(target.mkdir()); throw java.io.IOException("unreadable publication") }
        }
        val phone = disk.anonymousOwner()
        disk.saveChat(phone, LocalChat("phone-chat", 1), true); disk.saveDraft(phone, "phone-chat", CoachDraft("Phone draft"))
        disk.saveChat("u1", LocalChat("account-chat", 1), true)
        disk.saveDraft("u1", "account-chat", CoachDraft("Account draft")); disk.adoptPhoneDraft("u1") { true }
        val room = EngineRoomFixture(tmp.newFolder(), scope, localCoach = disk).also { rooms += it }
        runBlocking { room.select("u1") }
        var shown by mutableStateOf(true)
        val ask = AskBinding(room.store)
        compose.setContent { if (shown) GymMaterial { AskScreen(ask, ask, listOf(answered("Question", "How many days?")), emptyList(), emptySet(), false, null,
            { _, _ -> }, "", "http://localhost", onThreads = {}, onReview = {}, conversationId = "account-chat") } }
        compose.runOnIdle { unreadable = true }
        compose.onNodeWithText("Continue saved draft").performScrollTo().performClick()
        compose.onNodeWithText("Your draft couldn’t be saved. Try again.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Question").assert(hasText("Account draft"))
        compose.onNodeWithText("Phone draft").assertIsDisplayed()
        compose.onNodeWithText("How many days?").performScrollTo().assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(file.isDirectory)
            assertEquals(CoachDraft("Phone draft"), LocalCoach(published).draft("u1", "account-chat"))
            shown = false
        }
        compose.waitForIdle()
        assertTrue(file.isDirectory)
        assertEquals(CoachDraft("Phone draft"), LocalCoach(published).draft("u1", "account-chat"))
    }

    @Test fun anEmptyPendingMessagePacesBothTheFirstChunkAndItsTerminalTextInsideTheBubble() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var reply by mutableStateOf(coachReply("", MessageState.running))
        compose.mainClock.autoAdvance = false
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, listOf(CoachExchange("request-a", "Question", 0, answer = reply)),
                emptyList(), emptySet(), !reply.state.isTerminal, null, onAsk = { _, _ -> },
                seed = "", origin = "https://windmill.works", onThreads = {}, onReview = {},
                conversationId = "thread-a", onStop = {})
        }
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithContentDescription("Coach is thinking").assertIsDisplayed()
        val first = "First " + "word ".repeat(40)
        val whole = first + "final ".repeat(40)
        compose.runOnIdle { reply = reply.copy(text = first) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(150)
        fun shown(): String = compose.onAllNodes(hasText("First", substring = true), useUnmergedTree = true)
            .fetchSemanticsNodes().joinToString("") { node -> node.config[SemanticsProperties.Text].joinToString("") { it.text } }
        val initial = shown()
        assertTrue(initial.isNotEmpty() && initial.length < first.length && first.startsWith(initial))
        compose.onNodeWithContentDescription("Coach is thinking").assertDoesNotExist()
        compose.runOnIdle { reply = reply.copy(state = MessageState.completed, text = whole) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(150)
        val terminal = shown()
        assertTrue(terminal.length > initial.length && terminal.length < whole.length && whole.startsWith(terminal))
        compose.mainClock.advanceTimeBy(2000)
        assertEquals(whole, shown())
        scope.cancel()
    }

    @Test
    fun anInterruptedAnswerAboveANewerOneSaysHowItEndedAndOffersNoRetry() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val older = CoachExchange("request-a", "Older question", 0, answer = coachReply(state = MessageState.interrupted, id = "answer-a"))
        val newer = answered("Newer question", "Newer answer", "request-b")
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, listOf(older, newer), emptyList(), emptySet(), false, null,
                onAsk = { _, _ -> }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onReview = {}, conversationId = "thread-a")
        }
        compose.onNodeWithText("Interrupted. What arrived is kept.").assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun partialWordsReplaceInPlaceAndStopKeepsThemWithTruthfulStatus() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var reply by mutableStateOf(coachReply("First words", MessageState.running))
        var busy by mutableStateOf(true)
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, listOf(CoachExchange("request-a", "Question", 0, answer = reply)), emptyList(), emptySet(), busy, null,
                onAsk = { _, _ -> }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onReview = {}, conversationId = "thread-a",
                onStop = { reply = reply.copy(state = MessageState.stopped); busy = false })
        }
        compose.onNodeWithText("First words").assertIsDisplayed()
        compose.onNodeWithText("Jump to latest").assertDoesNotExist()
        compose.onNodeWithContentDescription("Coach is thinking").assertDoesNotExist()
        compose.runOnIdle { reply = reply.copy(text = "First words, then more.") }
        compose.onNodeWithText("First words").assertDoesNotExist()
        compose.onNodeWithText("First words, then more.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Stop response").performClick()
        compose.onNodeWithText("First words, then more.").assertIsDisplayed()
        compose.onNodeWithText(Ask.stopped).assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithContentDescription("Send").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun aPhotoOnlyDraftCanBeSentAndRemovedWithoutAnEmptyMessageCopyAction() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        store.coach.saveDraft("new", CoachDraft(photo = photo))
        val sent = mutableListOf<Pair<String, CoachAttachment?>>()
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, emptyList(), emptyList(), emptySet(), false, null,
                onAsk = { text, attachment -> sent += text to attachment }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onReview = {})
        }
        compose.onNodeWithContentDescription("Add photo").assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").performClick()
        compose.runOnIdle { assertEquals(listOf("" to photo), sent) }
        compose.onNodeWithContentDescription("Remove photo").performClick()
        compose.runOnIdle { assertEquals(CoachDraft(), store.coach.draft("new")) }
        scope.cancel()
    }

    @Test
    fun streamingPreservesTheReadersEarlierPositionUntilJumpToLatest() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val earlier = (1..12).map { answered("Question $it", "Answer $it.\n".repeat(8), "request-$it") }
        var reply by mutableStateOf(coachReply("Partial", MessageState.running))
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, earlier + CoachExchange("request-new", "Newest", 0, answer = reply), emptyList(), emptySet(), true, null,
                onAsk = { _, _ -> }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onReview = {}, conversationId = "thread-a", onStop = {})
        }
        compose.onNodeWithText("Question 1").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { reply = reply.copy(text = "New streamed words.\n".repeat(20)) }
        compose.onNodeWithText("Question 1").assertIsDisplayed()
        compose.onNodeWithText("Jump to latest").performClick()
        compose.onNodeWithText("Question 1").assertIsNotDisplayed()
        scope.cancel()
    }

    @Test
    fun messagesSyncingInAboveTheOnesOnScreenPreserveTheVisibleMessageAndItsOffset() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var thread by mutableStateOf((5..14).map { answered("Question $it", "Answer $it.\n".repeat(8), "request-$it") })
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, thread, emptyList(), emptySet(), false, null,
                onAsk = { _, _ -> }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onReview = {}, conversationId = "thread-a")
        }
        compose.onNodeWithText("Question 7").performScrollTo().assertIsDisplayed()
        val before = compose.onNodeWithText("Question 7").getUnclippedBoundsInRoot().top
        compose.runOnIdle {
            thread = (1..4).map { answered("Question $it", "Older answer.\n".repeat(8), "request-$it") } + thread
        }
        compose.onNodeWithText("Question 7").assertIsDisplayed()
        assertEquals(before, compose.onNodeWithText("Question 7").getUnclippedBoundsInRoot().top)
        scope.cancel()
    }

    @Test
    fun partialToCompletedKeepsTheOpenMenuAndCopiesAllReceivedTextBeforeRevealFinishes() {
        lateinit var clipboard: Clipboard
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var reply by mutableStateOf(coachReply("Partial café", MessageState.running))
        val ask = AskBinding(store)
        compose.setContent {
            clipboard = LocalClipboard.current
            AskScreen(ask, ask, listOf(CoachExchange("request-a", "Question", 0, answer = reply)), emptyList(), emptySet(), !reply.state.isTerminal, null,
                onAsk = { _, _ -> }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onReview = {}, conversationId = "thread-a")
        }
        compose.onNodeWithText("Partial café").performTouchInput { longClick() }
        compose.onNodeWithText("Copy answer").assertIsDisplayed()
        val whole = "Partial café 東京 🏋🏽‍♀️ " + "received words ".repeat(100).trimEnd()
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { reply = reply.copy(state = MessageState.completed, text = whole) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(150)
        val shown = compose.onAllNodes(hasText("Partial café", substring = true), useUnmergedTree = true)
            .fetchSemanticsNodes().flatMap { it.config[SemanticsProperties.Text] }.joinToString("") { it.text }
        assertTrue(shown.length > "Partial café".length && shown.length < whole.length && whole.startsWith(shown))
        val copy = compose.onNodeWithText("Copy answer").assertIsDisplayed()
            .fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnIdle {
            assertTrue(copy())
            assertEquals(whole, clipboard.nativeClipboard.primaryClip?.getItemAt(0)?.text?.toString())
        }
        compose.mainClock.autoAdvance = true
        scope.cancel()
    }

    @Test
    fun theEmptyRoomLeadsDirectlyToTheComposer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        room(signedIn(scope).store, thread = emptyList(), refusal = null, doors = mutableListOf())

        compose.onNodeWithText(Ask.title).assertIsDisplayed()
        compose.onNodeWithText("reads your log · helps with your routines").assertDoesNotExist()
        compose.onNodeWithText("Ten questions a day, three back to back.").assertDoesNotExist()
        compose.onNodeWithText(Ask.placeholder).assertIsDisplayed()
        compose.onNodeWithText("There is nothing to buy here.", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun theStepsStandBehindTheReceiptInTheLiftersWords() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val answer = CoachExchange("request-a", "what’s stalled?", 0, answer = coachReply("Bench has been flat for three weeks.", read = ReadTally(sets = 214, sessions = 34, weeks = 12), calls = listOf(
            coachCall("get_stats", "read your movement history"),
            coachCall("summon_lightning", phrase = null),
            coachCall("list_notes", "read your notes", detail = "2 notes"),
        )))
        room(signedIn(scope).store, thread = listOf(answer), refusal = null, doors = mutableListOf())

        compose.onNodeWithText("Read your movement history").assertDoesNotExist()
        compose.onNodeWithText("Read 34 workouts · 12 weeks").performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithText("Read your movement history").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Read your notes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("2 notes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("summon_lightning", substring = true).assertDoesNotExist()
        compose.onNodeWithText("get_stats", substring = true).assertDoesNotExist()
        compose.onNodeWithText("list_notes", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    // A server that scripts one turn, signed out, on a chat whose read is running.
    private fun turning(scope: CoroutineScope, server: TurnTransport): EngineRoomFixture =
        EngineRoomFixture(tmp.newFolder(), scope, coachServer = server, localCoach = LocalCoach(File(tmp.newFolder(), LocalCoach.fileName))).also { room ->
            rooms += room
            scope.launch { room.store.conversations.observe() }
        }

    private fun turnRoom(store: TrainingStore, chat: String) {
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, store.coach.exchanges(chat), emptyList(), emptySet(), store.coach.isAsking(chat), null,
                onAsk = { _, _ -> }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onReview = {}, conversationId = chat, onStop = { store.coach.stop() })
        }
    }

    private fun waitForText(text: String) = compose.waitUntil(10_000) { compose.onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun theRunningWordsReachTheScreenBetweenCommitsAndTheRecordsFinalTextWins() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"text","data":{"delta":" it all."}},{"event":"done","data":{"state":"completed"}}]""").arr())
        val room = turning(scope, server)
        val coach = room.store.coach
        val chat = compose.runOnIdle { coach.freshChat() }
        turnRoom(room.store, chat)
        compose.runOnIdle { assertTrue(coach.send(chat, "Question")) }
        waitForText("Reading")
        compose.onNodeWithText("Reading").assertIsDisplayed()
        compose.runOnIdle {
            val record = room.engine.read(ScopeRef(Gym.scope)) { read -> Repository.decode(CoachMessage, read.drawn(CoachMessage.type)) }.single { it.role == CoachMessage.Role.coach }
            assertEquals("the record holds none of it until its next commit", "", record.text)
            assertEquals(MessageState.running, record.state)
            coach.stop()
        }
        waitForText("Reading it all.")
        compose.onNodeWithText("Reading it all.").assertIsDisplayed()
        compose.onNodeWithText("Reading").assertDoesNotExist()
        compose.runOnIdle {
            val record = room.engine.read(ScopeRef(Gym.scope)) { read -> Repository.decode(CoachMessage, read.drawn(CoachMessage.type)) }.single { it.role == CoachMessage.Role.coach }
            assertEquals("Reading it all.", record.text)
            assertEquals(MessageState.completed, record.state)
            assertFalse(coach.isAsking(chat))
        }
        scope.cancel()
    }

    @Test
    fun aDroppedStreamSaysReconnectingInTheBandOverTheComposer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val telling = TellingRecorder()
        val server = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading"}},{"await":"resume"}]""").arr())
        val room = turning(scope, server)
        val coach = room.store.coach
        val chat = compose.runOnIdle { coach.freshChat() }
        val ask = AskBinding(room.store)
        compose.setContent {
            CompositionLocalProvider(LocalTelemetry provides telling) {
                AskScreen(ask, ask, coach.exchanges(chat), emptyList(), emptySet(), coach.isAsking(chat), null,
                    onAsk = { _, _ -> }, seed = "", origin = "https://windmill.works",
                    onThreads = {}, onReview = {}, conversationId = chat, onStop = {})
            }
        }
        compose.runOnIdle { assertTrue(coach.send(chat, "Question")) }
        waitForText(Ask.reconnecting)
        compose.onNodeWithText(Ask.reconnecting).assertIsDisplayed()
        compose.onNodeWithText("Reading").assertIsDisplayed()
        compose.onNodeWithContentDescription("Close").assertDoesNotExist()
        val band = compose.onNodeWithTag("coach-band", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertEquals(16.dp, band.left)
        assertEquals(48.dp, band.bottom - band.top)
        compose.runOnIdle { assertTrue(telling.events.contains("gym_action" to mapOf("screen" to "coach", "action" to "reconnecting", "outcome" to "ok"))) }
        scope.cancel()
    }

    @Test
    fun aStopTheServerCouldNotHearSaysSoInABandTheLifterCanClose() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val telling = TellingRecorder()
        val script = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Thursday is still a Push day."}},{"await":"stop"}]""").arr())
        val server = object : TurnTransport by script {
            override suspend fun stop(turnId: String, seat: TurnSeat): Unit = throw TurnConnectionLost(null)
        }
        val room = turning(scope, server)
        val coach = room.store.coach
        val chat = compose.runOnIdle { coach.freshChat() }
        val ask = AskBinding(room.store)
        compose.setContent {
            CompositionLocalProvider(LocalTelemetry provides telling) {
                AskScreen(ask, ask, coach.exchanges(chat), emptyList(), emptySet(), coach.isAsking(chat), null,
                    onAsk = { _, _ -> }, seed = "", origin = "https://windmill.works",
                    onThreads = {}, onReview = {}, conversationId = chat, onStop = { coach.stop() })
            }
        }
        compose.runOnIdle { assertTrue(coach.send(chat, "Question")) }
        waitForText("Thursday is still a Push day.")
        compose.runOnIdle { coach.stop() }
        val said = "Coach is stopped on this phone. Stopping it on the server needs a connection."
        waitForText(said)
        compose.onNodeWithText("Stopped.").assertIsDisplayed()
        compose.onNodeWithText("Thursday is still a Push day.").assertIsDisplayed()
        val band = compose.onNodeWithTag("coach-band", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertEquals(68.dp, band.bottom - band.top)
        compose.onNodeWithContentDescription("Close").performClick()
        compose.onNodeWithText(said).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(CoachTurnFault.stoppedOffline, coach.fault)
            assertTrue(telling.events.containsAll(listOf(
                "gym_action" to mapOf("screen" to "coach", "action" to "stop_notice", "outcome" to "ok"),
                "gym_action" to mapOf("screen" to "coach", "action" to "stop_notice_closed", "outcome" to "ok"))))
        }
        scope.cancel()
    }

    @Test
    fun aPictureAnotherPhoneHoldsStandsAsItsPlaceInTheLiftersGroup() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val picture = SentPicture(CoachAttachment("picture-a", "image/jpeg", 0, 0, 0), onThisPhone = false)
        val exchange = CoachExchange("request-a", "Is this program balanced?", 0, listOf(picture), answer = coachReply("It is balanced."))
        room(signedIn(scope).store, thread = listOf(exchange), refusal = null, doors = mutableListOf())
        val place = compose.onNodeWithText(Ask.pictureElsewhere).assertIsDisplayed().getUnclippedBoundsInRoot()
        val question = compose.onNodeWithText("Is this program balanced?").assertIsDisplayed().getUnclippedBoundsInRoot()
        assertTrue("the place stands over the words", place.bottom < question.top)
        compose.onNodeWithContentDescription("Attached photo").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun aRoutineASignedOutAnswerCreatedOffersKeepingItThroughSignIn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val telling = TellingRecorder()
        val doors = mutableListOf<String>()
        val exchange = CoachExchange("request-a", "My program", 0, answer = coachReply("I made a routine.", routines = listOf(CreatedRoutine("routine-a", "Full body A", 3)), calls = listOf(coachCall("create_routine", "created a routine"))))
        val ask = AskBinding(signedOut(scope).store)
        compose.setContent {
            CompositionLocalProvider(LocalTelemetry provides telling) {
                AskScreen(ask, ask, listOf(exchange), emptyList(), emptySet(), false, null, { _, _ -> }, "", "https://windmill.works",
                    onThreads = {}, onReview = {}, onSignIn = { doors += "signIn" }, onOpenRoutine = { doors += "routine:$it" })
            }
        }
        compose.onNodeWithText("Keep it").performScrollTo().performClick()
        compose.onNodeWithText("Full body A", useUnmergedTree = true).performClick()
        compose.runOnIdle {
            assertEquals(listOf("signIn", "routine:routine-a"), doors)
            assertEquals(listOf(
                "gym_setup_step" to mapOf("screen" to "coach", "action" to "keep_routines"),
                "gym_setup_step" to mapOf("screen" to "coach", "action" to "open_routine"),
            ), telling.events.filter { it.first == "gym_setup_step" })
        }
        scope.cancel()
    }

    @Test fun allowanceKeepsTheRefusedDraftAndOnlyTheAnonymousSignInDoor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedOut(scope).store
        store.coach.saveDraft("new", CoachDraft("Swap chin-ups for pulldowns"))
        val doors = mutableListOf<String>()
        room(store, emptyList(), CoachTurnRefusal.Allowance("subject_exhausted"), doors)
        compose.onNodeWithText("You have used all of your AI allowance.\nSign in to continue.").assertIsDisplayed()
        compose.onNodeWithText("Use your own AI agent").assertDoesNotExist()
        compose.onNodeWithText("Upgrade").assertDoesNotExist()
        compose.onNodeWithText("Sign in").performClick()
        assertEquals(listOf("signIn"), doors)
        compose.onNodeWithContentDescription("Question").performTextReplacement("Keep my edited input")
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals(listOf("signIn", "ask:Keep my edited input"), doors)
        scope.cancel()
    }

    @Test fun aRefusedQuestionHeldInTheComposerDrawsNoDateHeaderAboveTheNotice() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val fixture = signedIn(scope)
        fixture.store.coach.saveDraft("new", CoachDraft("Swap chin-ups for pulldowns"))
        val earlier = answered("How heavy should I start squats?", "Choose a weight you can lift 8 times.", atMs = fixture.now)
        room(fixture.store, listOf(earlier), CoachTurnRefusal.Allowance("subject_exhausted"), mutableListOf())
        compose.onNodeWithText("You have used all of your AI allowance.").assertIsDisplayed()
        assertEquals(1, compose.onAllNodesWithText("Today ", substring = true).fetchSemanticsNodes().size)
        scope.cancel()
    }

    @Test fun signedInAllowanceKeepsOnlyItsOneSentenceAndAnEditableComposer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        store.coach.saveDraft("new", CoachDraft("Retained input"))
        val doors = mutableListOf<String>()
        room(store, emptyList(), CoachTurnRefusal.Allowance("subject_exhausted"), doors)
        compose.onNodeWithText("You have used all of your AI allowance.").assertIsDisplayed()
        for (label in listOf("Sign in", "Upgrade", "Use your own AI agent", "You can use Coach again on"))
            compose.onNodeWithText(label, substring = true).assertDoesNotExist()
        compose.onNodeWithContentDescription("Question").performTextReplacement("Edited input")
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals(listOf("ask:Edited input"), doors)
        scope.cancel()
    }

    @Test
    fun theRateLimitKeepsEditableRefusedInputAndSendWithAnHonestNotice() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        store.coach.saveDraft("new", CoachDraft("is my week too light?"))
        val doors = mutableListOf<String>()
        room(store, thread = emptyList(), refusal = CoachTurnRefusal.RateLimited, doors = doors)
        compose.onNodeWithText(CoachTurnRefusal.RateLimited.sentence).assertIsDisplayed()
        compose.onAllNodesWithText("is my week too light?").assertCountEquals(1)
        compose.onNode(hasText("is my week too light?") and hasSetTextAction()).assertIsDisplayed()
        compose.onNodeWithContentDescription("Question").assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").assertIsDisplayed()
        compose.onNodeWithText(Threads.open).assertDoesNotExist()
        compose.onNodeWithText("Use your own AI agent").performClick()
        compose.runOnIdle { assertEquals(listOf("connections"), doors) }
        compose.onNodeWithContentDescription("Send").performClick()
        compose.runOnIdle { assertEquals(listOf("connections", "ask:is my week too light?"), doors) }
        scope.cancel()
    }

    @Test
    fun theSignedOutAllowanceRefusalShowsItsInputOnlyInTheComposerAsBoard0110Draws() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedOut(scope).store
        store.coach.saveDraft("new", CoachDraft("Swap chin-ups for pulldowns"))
        room(store, thread = emptyList(), refusal = CoachTurnRefusal.Allowance("subject_exhausted"), doors = mutableListOf())
        compose.onAllNodesWithText("Swap chin-ups for pulldowns").assertCountEquals(1)
        compose.onNode(hasText("Swap chin-ups for pulldowns") and hasSetTextAction()).assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun aMonthsPauseUsesItsOwnNoticeWithoutReplacingTheComposer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        room(signedIn(scope).store, emptyList(), CoachTurnRefusal.FreeMonthExhausted(null), doors)
        compose.onNodeWithText("Coach is paused for everyone this month.").assertIsDisplayed()
        compose.onNodeWithText(CoachTurnRefusal.RateLimited.sentence).assertDoesNotExist()
        compose.onNodeWithContentDescription("Question").assertIsDisplayed()
        compose.onNodeWithText("Use your own AI agent").performClick()
        compose.runOnIdle { assertEquals(listOf("connections"), doors) }
        compose.onNodeWithText(Threads.open).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun onlyTheTypedAccountRefusalShowsTheApprovedFixedBubbleAndExistingSignInDoor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val file = java.io.File(tmp.newFolder(), LocalCoach.fileName)
        file.writeText("""{"anonymousId":"anonymous:phone","selected":{"anonymous:phone":"retained-chat"},"chats":{},"onboarding":{"anonymous:phone":{"request-a":{"owner":"anonymous:phone","chat":"retained-chat","replica":"r","requestId":"request-a","body":"{\"text\":\"Make Push A harder\"}","createdAtMs":5,"refusalCode":"account_required","refusalMessage":"Private model prose"}}}}""")
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, localCoach = LocalCoach(file)).also { rooms += it }
        runBlocking { fixture.select(null) }
        val coach = fixture.store.coach
        assertEquals("retained-chat", coach.selectedChatId)
        runBlocking { fixture.store.conversations.read() }
        val doors = mutableListOf<String>()
        room(fixture.store, coach.exchanges("retained-chat"), null, doors)
        compose.onNodeWithText("Make Push A harder").assertIsDisplayed()
        compose.onNodeWithText(Ask.accountRequired).assertIsDisplayed()
        compose.onNodeWithText("Private model prose").assertDoesNotExist()
        compose.onNodeWithText("Sign in").performClick()
        compose.runOnIdle { assertEquals(listOf("signIn"), doors) }
        scope.cancel()
    }

    @Test
    fun aCallRefusedForItsSeatOffersSignInUnderTheLastAnswerOfASignedOutChatOnly() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val refused = CoachExchange("request-a", "Remember my injury", 0, answer = coachReply("I can’t save that signed out.", id = "answer-a",
            calls = listOf(coachCall("save_note", "saved a note", AbilityCall.Outcome.Refused(AbilityRefusal.seatRequired)))))
        val later = answered("And my week?", "Three days suit you.", "request-b")
        var thread by mutableStateOf(listOf(refused))
        val doors = mutableListOf<String>()
        val ask = AskBinding(signedOut(scope).store)
        compose.setContent {
            AskScreen(ask, ask, thread, emptyList(), emptySet(), false, null, { _, _ -> }, "", "https://windmill.works",
                onThreads = {}, onReview = {}, onSignIn = { doors += "signIn" })
        }
        compose.onNodeWithText("Sign in").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(listOf("signIn"), doors)
            thread = listOf(refused, later)
        }
        compose.onNodeWithText("Three days suit you.").assertIsDisplayed()
        compose.onNodeWithText("Sign in").assertDoesNotExist()
        scope.cancel()
    }

    // The card is a skim: its rows draw the compact readout only — one set moved, or both schemes in the readout formula — never the ladder the review sheet unfolds to.
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
        room(room.store, thread = listOf(answered("ramp it?", "A ramp.", proposals = listOf("proposal1"))), refusal = null, doors = mutableListOf())

        compose.onNodeWithText("Proposal · Lower A").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("2 changes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Back Squat").assertDoesNotExist()
        compose.onNodeWithText("Deadlift").assertDoesNotExist()
        compose.onNodeWithText(setFourMoved.compactLine).assertDoesNotExist()
        compose.onNodeWithText(reshaped.compactLine).assertDoesNotExist()
        scope.cancel()
    }

    // The card was minted off one read of the log; the decision is the log's reply, and the two must not stand on one screen saying different things about one act.
    @Test
    fun afterApplyTheCardReadsAppliedBesideTheReceiptAndNeverWaiting() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = saved(room, server, RoutineDraft(name = "Push Day").adding("bench-press", List(3) { SetTarget(5) }))
        propose(room, server, "proposal1", routine, listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted,
            exerciseId = "bench-press", before = ProposalTargets(List(3) { SetTarget(5) }),
            after = ProposalTargets(List(5) { SetTarget(3) }))), "Heavier triples.")
        var receipts by mutableStateOf<List<String>>(emptyList())
        val ask = AskBinding(room.store)
        compose.setContent {
            AskScreen(
                state = ask, events = ask, thread = listOf(answered("heavier?", "Triples.", proposals = listOf("proposal1"))), receipts = receipts, lookedAt = emptySet(),
                asking = false, refusal = null, onAsk = { _, _ -> }, seed = "",
                origin = "https://windmill.works",
                onThreads = {}, onReview = {},
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
        var receipts by mutableStateOf<List<String>>(emptyList())
        val ask = AskBinding(room.store)
        compose.setContent {
            AskScreen(
                state = ask, events = ask, thread = listOf(answered("heavier?", "Triples.", proposals = listOf("proposal1"))), receipts = receipts, lookedAt = emptySet(),
                asking = false, refusal = null, onAsk = { _, _ -> }, seed = "",
                origin = "https://windmill.works",
                onThreads = {}, onReview = {},
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
    fun theQuietRoomKeepsHistoryAndTheAccountSeatInTheBar() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        room(signedIn(scope).store, thread = emptyList(), refusal = null, doors = doors)

        compose.onNodeWithText("Notes").assertDoesNotExist()
        compose.onNodeWithContentDescription("More").assertDoesNotExist()
        compose.onNodeWithContentDescription("Your account").assertIsDisplayed()
        compose.onNodeWithContentDescription("History").performClick()
        compose.runOnIdle { assertEquals(listOf("threads"), doors) }
        scope.cancel()
    }

    @Test
    fun aFastSettledAnswerStillScrollsToItsNewQuestionAndProse() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var thread by mutableStateOf(listOf(answered("First question", "Long history. ".repeat(500), "request-a")))
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, thread, emptyList(), emptySet(), false, null, onAsk = { _, _ -> },
                seed = "", origin = "https://windmill.works", onThreads = {}, onReview = {})
        }
        compose.runOnIdle {
            thread = thread + answered("Second question", "A fast complete answer.", "request-b")
        }
        compose.onNodeWithText("Second question").assertIsDisplayed()
        compose.onNodeWithText("A fast complete answer.").assertIsDisplayed()
        val viewport = compose.onNodeWithTag("coach-thread").getUnclippedBoundsInRoot()
        val question = compose.onNodeWithText("Second question").getUnclippedBoundsInRoot()
        assertTrue("the new question is visible above its answer", question.top >= viewport.top && question.bottom <= viewport.bottom)
        compose.onNodeWithText("First question").assertIsNotDisplayed()
        scope.cancel()
    }

    @Test
    fun aSentQuestionAndReplyClearTheComposerThroughKeyboardViewportExpansion() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val first = answered("First question", "Your existing training history. ".repeat(150), "request-a")
        var thread by mutableStateOf(listOf(first))
        var height by mutableStateOf(540.dp)
        val sent = mutableListOf<String>()
        val ask = AskBinding(store)
        compose.setContent {
            Box(Modifier.height(height)) {
                AskScreen(ask, ask, thread, emptyList(), emptySet(), thread.last().waiting, null,
                    onAsk = { text, _ -> sent += text; store.coach.saveDraft("new", CoachDraft()); thread = thread + asking(text, "request-b") },
                    seed = "", origin = "https://windmill.works", onThreads = {}, onReview = {})
            }
        }
        compose.onNodeWithContentDescription("Question").performTextReplacement("Second question")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.onNodeWithContentDescription("Coach is thinking").assertIsDisplayed()
        var viewport = compose.onNodeWithTag("coach-thread").getUnclippedBoundsInRoot()
        var question = compose.onNodeWithText("Second question").getUnclippedBoundsInRoot()
        assertTrue("pending question is visible above the typing bubble", question.top >= viewport.top && question.bottom <= viewport.bottom)
        compose.onNodeWithText("First question").assertIsNotDisplayed()

        compose.runOnIdle {
            height = 900.dp
            thread = listOf(first, answered("Second question", "The complete answer is visible here.", "request-b"))
        }
        viewport = compose.onNodeWithTag("coach-thread").getUnclippedBoundsInRoot()
        question = compose.onNodeWithText("Second question").getUnclippedBoundsInRoot()
        val answer = compose.onNodeWithText("The complete answer is visible here.").getUnclippedBoundsInRoot()
        assertTrue("expanded viewport keeps the question visible: question=$question viewport=$viewport", question.top >= viewport.top && question.bottom <= viewport.bottom)
        assertTrue("the entire answer clears the composer", answer.top >= question.bottom && answer.bottom <= viewport.bottom)
        compose.onNodeWithText("First question").assertIsNotDisplayed()
        compose.runOnIdle { assertEquals(listOf("Second question"), sent) }
        scope.cancel()
    }

    @Test
    fun aNewChatCannotReuseThePreviousConversationsShortQuestionPositions() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var conversation by mutableStateOf("old-thread")
        var thread by mutableStateOf((1..4).map { answered("Old question $it", "Short answer.", "old-$it") })
        val sent = mutableListOf<String>()
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, thread, emptyList(), emptySet(), false, null,
                onAsk = { text, _ ->
                    sent += text
                    store.coach.saveDraft(conversation.ifEmpty { "new" }, CoachDraft())
                    conversation = "new-thread"
                    val answer = if (thread.isEmpty()) "A much longer training history. ".repeat(200) else "The new answer is here."
                    thread = thread + answered(text, answer, "new-${thread.size}")
                }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onReview = {}, conversationId = conversation)
        }
        compose.runOnIdle { conversation = ""; thread = emptyList() }
        compose.onNodeWithContentDescription("Question").performTextReplacement("New first question")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.onNodeWithContentDescription("Question").performTextReplacement("New second question")
        compose.onNodeWithContentDescription("Send").performClick()
        val viewport = compose.onNodeWithTag("coach-thread").getUnclippedBoundsInRoot()
        val question = compose.onNodeWithText("New second question").getUnclippedBoundsInRoot()
        assertTrue("new conversation uses its own measured anchor: $question in $viewport",
            question.top >= viewport.top && question.bottom <= viewport.bottom)
        compose.onNodeWithText("The new answer is here.").assertIsDisplayed()
        compose.onNodeWithText("New first question").assertIsNotDisplayed()
        compose.onNodeWithText("Old question 2").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("New first question", "New second question"), sent) }
        scope.cancel()
    }

    // A proposal the phone holds no row of, before the phone has caught up: the answer stands, nothing claims the proposal is gone, and no read retry is offered.
    @Test
    fun aProposalNotYetOnThePhoneLeavesNothingInTheCardsPlace() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val thread = listOf(answered("What next?", "The original answer.", proposals = listOf("prop_gone")))
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, thread, emptyList(), emptySet(), false, null, { _, _ -> }, "", "https://windmill.works",
                onThreads = {}, onReview = {})
        }
        compose.onNodeWithText("The original answer.").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs + 1_000)
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText("Review").assertDoesNotExist()
        compose.onNodeWithText("Reading proposal…").assertDoesNotExist()
        scope.cancel()
    }

    // A dead row of the proposal is gone at once. A miss with no row settles only once its wait has passed and either the phone, caught up at or after the miss, has read further, or a pull has landed since the wait ended.
    @Test
    fun aMissIsGoneAtOnceWithADeadRowAndOtherwiseOnceItSettles() {
        val dead = AnsweredProposals.Miss().read(recorded = true, caughtUpTo = null, caughtUpPull = 0)
        assertEquals(AnsweredProposals.Miss(recorded = true), dead)
        assertTrue(dead.gone)
        val behind = AnsweredProposals.Miss().read(recorded = false, caughtUpTo = null, caughtUpPull = 3)
        val level = behind.read(recorded = false, caughtUpTo = 7, caughtUpPull = 3).copy(waitedAt = 3)
        assertEquals(AnsweredProposals.Miss(caughtUpAt = 7, waitedAt = 3), level)
        assertFalse(level.gone)
        assertEquals(level, level.read(recorded = false, caughtUpTo = 7, caughtUpPull = 3))
        val past = level.read(recorded = false, caughtUpTo = 8, caughtUpPull = 3)
        assertEquals(AnsweredProposals.Miss(caughtUpAt = 7, readPast = true, waitedAt = 3), past)
        assertTrue(past.gone)
        assertEquals(past, past.read(recorded = false, caughtUpTo = null, caughtUpPull = 3))
        val pulled = level.read(recorded = false, caughtUpTo = 7, caughtUpPull = 4)
        assertEquals(AnsweredProposals.Miss(caughtUpAt = 7, waitedAt = 3, pulledPast = true), pulled)
        assertTrue(pulled.gone)
        assertEquals("a pull before the wait ended settles nothing", AnsweredProposals.Miss(caughtUpAt = 7),
            AnsweredProposals.Miss(caughtUpAt = 7).read(recorded = false, caughtUpTo = 7, caughtUpPull = 9))
    }

    // What each revision adds after the room mounted is paced by the frame clock, and a stop shows the whole text at the next frame.
    @Test
    fun aRunningAnswerIsPacedBetweenRevisionsAndAStopShowsItWholeAtTheNextFrame() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val opening = "Opening words."
        val first = opening + " " + "word ".repeat(60).trim()
        val whole = first + " " + "more ".repeat(60).trim()
        var reply by mutableStateOf(coachReply(opening, MessageState.running))
        compose.mainClock.autoAdvance = false
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, listOf(CoachExchange("request-a", "Question", 0, answer = reply)), emptyList(), emptySet(), !reply.state.isTerminal, null,
                onAsk = { _, _ -> }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onReview = {}, conversationId = "thread-a", onStop = {})
        }
        fun shown(): String = compose.onAllNodes(hasText("word", substring = true), useUnmergedTree = true)
            .fetchSemanticsNodes().joinToString("") { node -> node.config[SemanticsProperties.Text].joinToString("") { it.text } }
        assertEquals(opening, shown())
        compose.runOnIdle { reply = reply.copy(text = first) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(150)
        val early = shown()
        assertTrue("early shows ${early.length} of ${first.length}", early.length > opening.length && early.length < first.length && first.startsWith(early))
        compose.mainClock.advanceTimeBy(1500)
        assertEquals(first, shown())
        compose.runOnIdle { reply = reply.copy(text = whole) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(150)
        val mid = shown()
        assertTrue("mid shows ${mid.length}", mid.length > first.length && mid.length < whole.length && whole.startsWith(mid))
        compose.runOnIdle { reply = reply.copy(state = MessageState.stopped) }
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
        room(signedIn(scope).store, thread = listOf(answered("Question", answer)), refusal = null, doors = mutableListOf())
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithText(answer).assertIsDisplayed()
        scope.cancel()
    }

    // A room revisited mid-stream (tab switch, reopened thread, recreation) mounts on the text it already has: nothing re-types, and the waiting line never shows over text that is there.
    @Test
    fun aRunningAnswerAlreadyReceivedIsWholeOnItsFirstFrameAndNeverRetypes() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val partial = "word ".repeat(300).trim().take(1499)
        val thread = listOf(CoachExchange("request-a", "Question", 0, answer = coachReply(partial, MessageState.running)))
        compose.mainClock.autoAdvance = false
        val ask = AskBinding(store)
        compose.setContent {
            AskScreen(ask, ask, thread, emptyList(), emptySet(), true, null,
                onAsk = { _, _ -> }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onReview = {}, conversationId = "thread-a", onStop = {})
        }
        fun shown(): String = compose.onAllNodes(hasText("word", substring = true), useUnmergedTree = true)
            .fetchSemanticsNodes().joinToString("") { node -> node.config[SemanticsProperties.Text].joinToString("") { it.text } }
        assertEquals(partial, shown())
        compose.onNodeWithContentDescription("Coach is thinking").assertDoesNotExist()
        repeat(3) {
            compose.mainClock.advanceTimeByFrame()
            assertEquals(partial, shown())
            compose.onNodeWithContentDescription("Coach is thinking").assertDoesNotExist()
        }
        scope.cancel()
    }

    @Test
    fun aRemovalPromisesConfirmationUntilTheRoutineIsRemoved() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = saved(room, server, RoutineDraft(name = "Push Day").adding("bench-press", List(3) { SetTarget(5) }))
        propose(room, server, "proposal1", routine, listOf(ProposalChange(position = 1, kind = ChangeKind.Removed,
            exerciseId = "bench-press", before = ProposalTargets(List(3) { SetTarget(5) }), loggedSets = 0)),
            "Remove this routine.", intent = ProposalIntent.Remove)
        var receipts by mutableStateOf<List<String>>(emptyList())
        val ask = AskBinding(room.store)
        compose.setContent {
            AskScreen(ask, ask, listOf(answered("Remove this routine?", "You can remove it.", proposals = listOf("proposal1"))), receipts, emptySet(), false, null, { _, _ -> }, "",
                "https://windmill.works", onThreads = {}, onReview = {})
        }
        compose.onNodeWithText("Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal.")
            .performScrollTo().assertIsDisplayed()
        assertEquals(20.dp, compose.onNodeWithText(Ask.promise).getUnclippedBoundsInRoot().left)
        val settled = applied(room, server, "proposal1")
        compose.runOnIdle { receipts = listOf(requireNotNull(settled.proposal.receipt)) }
        compose.onNodeWithText(requireNotNull(settled.proposal.receipt)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(Ask.promise).assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<String>(), room.store.routines.all.map { it.id }) }
        scope.cancel()
    }

    // Coach answers before its proposal reaches the phone: the answer stands with nothing in the card's place, the card is drawn in the same visit once the proposal syncs, and nothing is reported missing.
    @Test
    fun aProposalThatSyncsAfterItsAnswerIsDrawnWithoutReopeningTheRoom() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val routine = saved(room, server, RoutineDraft(name = "Push A").adding("bench-press", List(3) { SetTarget(5) }))
        propose(room, server, "proposal1", routine, listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted,
            exerciseId = "bench-press", before = ProposalTargets(List(3) { SetTarget(5) }),
            after = ProposalTargets(List(2) { SetTarget(5) }))), "Use one lighter set.", pull = false)
        room.store.observeEngine()
        val telling = TellingRecorder()
        var thread by mutableStateOf(listOf(asking("What next?", "request1")))
        roomTelling(room.store, telling) { thread }
        compose.runOnIdle { thread = listOf(answered("What next?", "The answer stays readable.", "request1", listOf("proposal1"))) }
        compose.onNodeWithText("The answer stays readable.").assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.onNodeWithText("Review").assertDoesNotExist()
        compose.runOnIdle { room.pull(server) }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Proposal · Push A").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Proposal · Push A").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs + 1_000)
        compose.runOnIdle { assertEquals(emptyList<Map<String, String>>(), telling.named("gym_proposal_missing")) }
        scope.cancel()
    }

    // An answer this visit waited for names a proposal the phone never receives. Nothing stands in the card's place until the settling wait has passed and the phone has read the account past its first miss; then it is no longer available, and reported once, with no labels; later changes add nothing.
    @Test
    fun aProposalStillMissingAfterThePhoneCatchesUpIsReportedOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        room.pull(server)
        room.store.observeEngine()
        val telling = TellingRecorder()
        var thread by mutableStateOf(listOf(asking("What next?", "request1")))
        roomTelling(room.store, telling) { thread }
        compose.runOnIdle { thread = listOf(answered("What next?", "The answer stays readable.", "request1", listOf("proposal1"))) }
        compose.onNodeWithText("The answer stays readable.").assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        val before = compose.runOnIdle { room.store.routines.caughtUpTo }
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs + 1_000)
        compose.runOnIdle { assertEquals("not reported before the phone reads past the miss", emptyList<Map<String, String>>(), telling.named("gym_proposal_missing")) }
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        saved(room, server, RoutineDraft(name = "Pull").adding("bench-press", List(3) { SetTarget(5) }))
        compose.waitUntil(5_000) { compose.runOnIdle { telling.named("gym_proposal_missing").isNotEmpty() } }
        saved(room, server, RoutineDraft(name = "Legs").adding("back-squat", List(3) { SetTarget(5) }))
        compose.waitUntil(5_000) { compose.runOnIdle { room.store.routines.all.size == 2 } }
        compose.runOnIdle {
            assertTrue(room.store.routines.caughtUpTo!! > before!!)
            assertEquals(listOf(emptyMap<String, String>()), telling.named("gym_proposal_missing"))
        }
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        scope.cancel()
    }

    // A change to this workout goes by the same rule: Coach can answer on another phone before its proposal reaches this one, so the clock alone calls nothing gone.
    @Test
    fun aWorkoutProposalThatNeverArrivesIsReadingUntilThePhoneHasReadPastItsMissAndIsReportedOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        room.pull(server)
        room.store.observeEngine()
        val telling = TellingRecorder()
        fun answer(text: String) = CoachExchange("request1", "What next?", 0, answer = coachReply(text, id = "request1-answer", created = listOf(RecordRef(Gym.Types.workoutProposal, RecordID("wp000000000000001")))))
        var thread by mutableStateOf(listOf(asking("What next?", "request1")))
        roomTelling(room.store, telling) { thread }
        compose.runOnIdle { thread = listOf(answer("The answer stays readable.")) }
        compose.onNodeWithText("Reading proposal…").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs + 1_000)
        compose.onNodeWithText("Reading proposal…").assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<Map<String, String>>(), telling.named("gym_proposal_missing")) }

        saved(room, server, RoutineDraft(name = "Pull").adding("bench-press", List(3) { SetTarget(5) }))
        compose.waitUntil(60_000) { compose.runOnIdle { telling.named("gym_proposal_missing").isNotEmpty() } }
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        compose.onNodeWithText("Reading proposal…").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf(emptyMap<String, String>()), telling.named("gym_proposal_missing")) }
        scope.cancel()
    }

    // The first miss lands while the phone is behind the account. The pull that brings it level is where the miss is measured from, not past it: nothing is reported or drawn until the phone reads further into the account.
    @Test
    fun aMissFirstSeenWhileBehindIsMeasuredFromWhereThePhoneCatchesUp() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        saved(signedIn(scope), server, RoutineDraft(name = "Push A").adding("bench-press", List(3) { SetTarget(5) }))
        room.store.observeEngine()
        assertNull(room.store.routines.caughtUpTo)
        val telling = TellingRecorder()
        var thread by mutableStateOf(listOf(asking("What next?", "request1")))
        roomTelling(room.store, telling) { thread }
        compose.runOnIdle { thread = listOf(answered("What next?", "The answer stays readable.", "request1", listOf("proposal1"))) }
        compose.onNodeWithText("The answer stays readable.").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs + 1_000)
        compose.runOnIdle { room.pull(server) }
        compose.waitUntil(5_000) { compose.runOnIdle { room.store.routines.all.size == 1 } }
        compose.mainClock.advanceTimeBy(1_000)
        compose.runOnIdle { assertEquals("a pull that only brings the phone level reports nothing", emptyList<Map<String, String>>(), telling.named("gym_proposal_missing")) }
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        saved(room, server, RoutineDraft(name = "Pull").adding("bench-press", List(3) { SetTarget(5) }))
        compose.waitUntil(5_000) { compose.runOnIdle { telling.named("gym_proposal_missing").isNotEmpty() } }
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        scope.cancel()
    }

    // On an idle account nothing new would ever arrive. The wait's end asks for one pull, and once it lands with no row the proposal is no longer available and reported once; later pulls ask and report nothing more.
    @Test
    fun anIdleAccountSettlesADeletedProposalAfterTheWaitAndOnePull() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val pulls = MutableStateFlow(Pulls())
        var asked = 0
        lateinit var room: EngineRoomFixture
        room = EngineRoomFixture(tmp.newFolder(), scope, pulls = pulls, pullAgain = {
            asked++
            room.pull(server)
            pulls.value = pulls.value.sending(room.engine.activeReplica()).let { it.ending(room.engine.activeReplica(), it.sent, landed = true, caughtUp = true) }
            true
        }).also { rooms += it }
        runBlocking { room.select("u1") }
        room.pull(server)
        room.store.observeEngine()
        val telling = TellingRecorder()
        var thread by mutableStateOf(listOf(asking("What next?", "request1")))
        roomTelling(room.store, telling) { thread }
        compose.runOnIdle { thread = listOf(answered("What next?", "The answer stays readable.", "request1", listOf("proposal1"))) }
        compose.onNodeWithText("The answer stays readable.").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs - 1_000)
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, asked) }
        compose.mainClock.advanceTimeBy(2_000)
        compose.waitUntil(5_000) { compose.onAllNodesWithText(ProposalRead.Gone.line).fetchSemanticsNodes().size == 1 }
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        compose.runOnIdle { pulls.value = pulls.value.sending(room.engine.activeReplica()).let { it.ending(room.engine.activeReplica(), it.sent, landed = true, caughtUp = true) } }
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs + 1_000)
        compose.runOnIdle {
            assertEquals(1, asked)
            assertEquals(listOf(emptyMap<String, String>()), telling.named("gym_proposal_missing"))
        }
        scope.cancel()
    }

    // The proposal reaches the server after its answer but the account stays idle: the pull the wait's end asks for brings it, and the card is drawn with nothing reported missing.
    @Test
    fun aProposalBroughtByTheWaitsPullDrawsItsCard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val pulls = MutableStateFlow(Pulls())
        var asked = 0
        lateinit var room: EngineRoomFixture
        room = EngineRoomFixture(tmp.newFolder(), scope, pulls = pulls, pullAgain = {
            asked++
            room.pull(server)
            pulls.value = pulls.value.sending(room.engine.activeReplica()).let { it.ending(room.engine.activeReplica(), it.sent, landed = true, caughtUp = true) }
            true
        }).also { rooms += it }
        runBlocking { room.select("u1") }
        val routine = saved(room, server, RoutineDraft(name = "Push A").adding("bench-press", List(3) { SetTarget(5) }))
        room.store.observeEngine()
        val telling = TellingRecorder()
        var thread by mutableStateOf(listOf(asking("What next?", "request1")))
        roomTelling(room.store, telling) { thread }
        compose.runOnIdle { thread = listOf(answered("What next?", "The answer stays readable.", "request1", listOf("proposal1"))) }
        compose.onNodeWithText("The answer stays readable.").assertIsDisplayed()
        propose(room, server, "proposal1", routine, listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted,
            exerciseId = "bench-press", before = ProposalTargets(List(3) { SetTarget(5) }),
            after = ProposalTargets(List(2) { SetTarget(5) }))), "Use one lighter set.", pull = false)
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs + 1_000)
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Proposal · Push A").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Proposal · Push A").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(1, asked)
            assertEquals(emptyList<Map<String, String>>(), telling.named("gym_proposal_missing"))
        }
        scope.cancel()
    }

    // Only a pull sent after the wait ended confirms there is no row: one already in flight when the wait ended lands without settling the miss, and so does the first page of a backlog with more to read.
    @Test
    fun aMissSettlesOnlyOnAPullSentAfterItsWaitThatLandsCaughtUp() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val pulls = MutableStateFlow(Pulls())
        var asked = 0
        val room = EngineRoomFixture(tmp.newFolder(), scope, pulls = pulls, pullAgain = { asked++; true })
            .also { rooms += it }
        runBlocking { room.select("u1") }
        room.pull(server)
        room.store.observeEngine()
        val replica = room.engine.activeReplica()
        val telling = TellingRecorder()
        var thread by mutableStateOf(listOf(asking("What next?", "request1")))
        roomTelling(room.store, telling) { thread }
        compose.runOnIdle { thread = listOf(answered("What next?", "The answer stays readable.", "request1", listOf("proposal1"))) }
        compose.onNodeWithText("The answer stays readable.").assertIsDisplayed()
        compose.runOnIdle { pulls.value = pulls.value.sending(replica) }
        compose.waitUntil(5_000) { compose.runOnIdle { room.store.history.pulled.sent == 1L } }
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs + 1_000)
        compose.runOnIdle {
            assertEquals(1, asked)
            pulls.value = pulls.value.ending(replica, 1, landed = true, caughtUp = true)
        }
        compose.mainClock.advanceTimeBy(1_000)
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.runOnIdle { pulls.value = pulls.value.sending(replica).let { it.ending(replica, it.sent, landed = true, caughtUp = false) } }
        compose.mainClock.advanceTimeBy(1_000)
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(emptyList<Map<String, String>>(), telling.named("gym_proposal_missing"))
            pulls.value = pulls.value.sending(replica).let { it.ending(replica, it.sent, landed = true, caughtUp = true) }
        }
        compose.waitUntil(5_000) { compose.onAllNodesWithText(ProposalRead.Gone.line).fetchSemanticsNodes().size == 1 }
        compose.runOnIdle {
            assertEquals(1, asked)
            assertEquals(listOf(emptyMap<String, String>()), telling.named("gym_proposal_missing"))
        }
        scope.cancel()
    }

    // Each miss settles 10 s after its own first miss: a second answer missing its proposal later does not hold back the first one's.
    @Test
    fun aLaterMissDoesNotRestartAnEarlierMissesSettlingWait() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        room.pull(server)
        room.store.observeEngine()
        val telling = TellingRecorder()
        var thread by mutableStateOf(listOf(asking("What next?", "request1"), asking("And then?", "request2")))
        roomTelling(room.store, telling) { thread }
        compose.runOnIdle { thread = listOf(answered("What next?", "The first answer.", "request1", listOf("proposal1")), thread[1]) }
        compose.onNodeWithText("The first answer.").assertIsDisplayed()
        saved(room, server, RoutineDraft(name = "Pull").adding("bench-press", List(3) { SetTarget(5) }))
        compose.waitUntil(5_000) { compose.runOnIdle { room.store.routines.all.size == 1 } }
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs / 2)
        compose.runOnIdle { thread = listOf(thread[0], answered("And then?", "The second answer.", "request2", listOf("proposal2"))) }
        compose.onNodeWithText("The second answer.").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(AnsweredProposals.settleMs / 2 + 1_000)
        compose.runOnIdle { assertEquals(listOf(emptyMap<String, String>()), telling.named("gym_proposal_missing")) }
        scope.cancel()
    }
}
