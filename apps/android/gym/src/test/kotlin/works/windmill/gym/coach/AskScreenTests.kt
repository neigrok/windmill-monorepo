package works.windmill.gym.coach

import works.windmill.gym.ui.*
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.height
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.hasSetTextAction
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
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
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
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalIntent
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.sync.ProposalRules
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.ProposalOutcome
import works.windmill.gym.store.ProposalRead
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.domain.kit.Id
import works.windmill.sync.core.Json
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.modelserver.ServerCall
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
        (room.store.saveRoutine(draft.capturingMovements(room.store.catalog)) as GymResult.Ok).value.also { room.sync(server) }
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
                onConnections = { doors += "connections" },
                onSignIn = { doors += "signIn" },
                onReview = {}, seat = "A",
            )
        }
    }

    @Test fun choicesFillTheActualComposerWithoutSendingAndPersistTheSelectedOptions() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val file = java.io.File(tmp.root, "choices.json")
        val disk = LocalCoach(file)
        val clarification = CoachClarification("choice-123", "What works for you?", listOf(
            CoachClarification.Group("days", "Days each week", false, listOf(CoachClarification.Option("two", "2 days"), CoachClarification.Option("three", "3 days"))),
            CoachClarification.Group("equipment", "Equipment", true, listOf(CoachClarification.Option("dumbbells", "Dumbbells"), CoachClarification.Option("bodyweight", "Bodyweight")))))
        val raw = works.windmill.platform.net.WindmillJson.encodeToJsonElement(CoachClarification.serializer(), clarification)
        val exchange = AskExchange("Build a routine", answer = AskAnswer("What works for you?", ReadTally(), clarification = raw), requestId = "request-123")
        disk.saveChat("u1", LocalChat("chat-123", exchanges = listOf(exchange)), true)
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest(), localCoach = disk).also { rooms += it }
        runBlocking { room.select("u1") }
        val sent = mutableListOf<String>()
        compose.setContent { GymMaterial { AskScreen(room.store, listOf(exchange), emptyList(), emptySet(), false, null,
            { sent += it }, {}, {}, "", "http://localhost", onThreads = {}, onNotes = {}, onReview = {}, conversationId = "chat-123") } }
        compose.onNodeWithText("2 days").performScrollTo().performClick()
        compose.onNodeWithText("3 days").performScrollTo().performClick()
        compose.onNodeWithText("Bodyweight").performScrollTo().performClick()
        compose.onNodeWithText("Dumbbells").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Question").assert(hasText("3 days. Dumbbells, Bodyweight."))
        compose.onNodeWithText("2 days").assert(androidx.compose.ui.test.isNotSelected())
        compose.onNodeWithText("3 days").assert(androidx.compose.ui.test.isSelected())
        compose.onNodeWithText("Dumbbells").assert(androidx.compose.ui.test.isSelected())
        compose.onNodeWithText("Bodyweight").assert(androidx.compose.ui.test.isSelected())
        compose.onNodeWithText("read nothing from your log").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(emptyList<String>(), sent)
            assertEquals(CoachDraft("3 days. Dumbbells, Bodyweight."), LocalCoach(file).draft("u1", "chat-123"))
            assertEquals(mapOf("days" to listOf("three"), "equipment" to listOf("dumbbells", "bodyweight")), LocalCoach(file).choices("u1", "chat-123", "request-123:choice-123"))
        }
        compose.onNodeWithContentDescription("Send").performClick()
        compose.runOnIdle { assertEquals(listOf("3 days. Dumbbells, Bodyweight."), sent) }
    }

    @Test fun choiceChipsGrowWithTheTextSize() {
        val clarification = CoachClarification("choice-123", "How many days?", listOf(CoachClarification.Group("days", "Days each week", false,
            listOf(CoachClarification.Option("d3", "3 days")))))
        var fontScale by mutableStateOf(1f)
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                GymMaterial { CoachChoices(clarification, emptyMap(), true) { _, _ -> } }
            }
        }
        val regular = compose.onNodeWithText("3 days").getBoundsInRoot()
        compose.runOnIdle { fontScale = 2f }
        val large = compose.onNodeWithText("3 days").getBoundsInRoot()
        val label = compose.onNodeWithText("3 days", useUnmergedTree = true).getBoundsInRoot()
        assertEquals(32f, regular.height.value, .5f)
        assertTrue("the chip grows: $regular -> $large", large.height > regular.height)
        assertTrue("the label keeps its padding: $label in $large", label.top - large.top >= 5.5.dp && large.bottom - label.bottom >= 5.5.dp)
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
        disk.saveChat(phone, LocalChat("phone-chat", setup = true), true)
        disk.savePhoto(phone, photo.id, bytes); disk.saveDraft(phone, "phone-chat", CoachDraft(photo = photo))
        disk.saveChat("u1", LocalChat("account-chat"), true); disk.saveDraft("u1", "account-chat", CoachDraft("Account draft"))
        disk.adoptPhoneDraft("u1") { true }
        val held = disk.keptDrafts("u1", "account-chat").single()
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest(), localCoach = disk).also { rooms += it }
        runBlocking { room.select("u1") }
        val sent = mutableListOf<String>()
        compose.setContent { GymMaterial { AskScreen(room.store, emptyList(), emptyList(), emptySet(), false, null,
            { sent += it }, {}, {}, "", "http://localhost", onThreads = {}, onNotes = {}, onReview = {}, conversationId = "account-chat") } }
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

    @Test fun anUnreadablePublishedSwapKeepsTheVisibleDraftAndChoicesSafeDuringRecomposition() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val file = java.io.File(tmp.root, "unreadable-ui.json")
        val published = java.io.File(tmp.root, "published-ui.json")
        var unreadable = false
        val disk = LocalCoach(file) { target, text ->
            works.windmill.platform.storage.AtomicDocument.write(target, text)
            if (unreadable) { check(target.renameTo(published)); check(target.mkdir()); throw java.io.IOException("unreadable publication") }
        }
        val phone = disk.anonymousOwner()
        disk.saveChat(phone, LocalChat("phone-chat"), true); disk.saveDraft(phone, "phone-chat", CoachDraft("Phone draft"))
        val clarification = CoachClarification("choice-123", "Days?", listOf(CoachClarification.Group("days", "Days", false,
            listOf(CoachClarification.Option("three", "3 days")))))
        val raw = works.windmill.platform.net.WindmillJson.encodeToJsonElement(CoachClarification.serializer(), clarification)
        val exchange = AskExchange("Question", answer = AskAnswer("Days?", ReadTally(), clarification = raw), requestId = "request-123")
        disk.saveChat("u1", LocalChat("account-chat", exchanges = listOf(exchange)), true)
        disk.saveDraft("u1", "account-chat", CoachDraft("Account draft")); disk.adoptPhoneDraft("u1") { true }
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest(), localCoach = disk).also { rooms += it }
        runBlocking { room.select("u1") }
        var shown by mutableStateOf(true)
        compose.setContent { if (shown) GymMaterial { AskScreen(room.store, listOf(exchange), emptyList(), emptySet(), false, null,
            {}, {}, {}, "", "http://localhost", onThreads = {}, onNotes = {}, onReview = {}, conversationId = "account-chat") } }
        compose.runOnIdle { unreadable = true }
        compose.onNodeWithText("Continue saved draft").performScrollTo().performClick()
        compose.onNodeWithText("Your draft couldn’t be saved. Try again.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Question").assert(hasText("Account draft"))
        compose.onNodeWithText("Phone draft").assertIsDisplayed()
        compose.onNodeWithText("3 days").performScrollTo().assert(androidx.compose.ui.test.isNotSelected())
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
        var generation by mutableStateOf<AskGeneration?>(null)
        compose.mainClock.autoAdvance = false
        compose.setContent {
            AskScreen(store, listOf(generation?.exchange() ?: AskExchange("Question", requestId = "request-a")),
                emptyList(), emptySet(), generation?.terminal != true, null, onAsk = {}, onRetry = {}, onAskNew = {},
                seed = "", origin = "https://windmill.works", onThreads = {}, onNotes = {}, onReview = {},
                conversationId = "thread-a", onStop = {})
        }
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithContentDescription("Coach is thinking").assertIsDisplayed()
        val first = "First " + "word ".repeat(40)
        val whole = first + "final ".repeat(40)
        compose.runOnIdle { generation = AskGeneration("generation-a", "request-a", "Question", "running", first, revision = 1) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(150)
        fun shown(): String = compose.onAllNodes(hasText("First", substring = true), useUnmergedTree = true)
            .fetchSemanticsNodes().joinToString("") { node -> node.config[SemanticsProperties.Text].joinToString("") { it.text } }
        val initial = shown()
        assertTrue(initial.isNotEmpty() && initial.length < first.length && first.startsWith(initial))
        compose.onNodeWithContentDescription("Coach is thinking").assertDoesNotExist()
        compose.runOnIdle { generation = generation!!.copy(status = "completed", answer = whole, revision = 2) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(150)
        val terminal = shown()
        assertTrue(terminal.length > initial.length && terminal.length < whole.length && whole.startsWith(terminal))
        compose.mainClock.advanceTimeBy(2000)
        assertEquals(whole, shown())
        scope.cancel()
    }

    @Test
    fun anInterruptedExchangeAboveANewerOneKeepsTryAgainAndRetriesItsOwnRequest() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val older = AskExchange("Older question", trouble = Ask.interrupted, again = true, requestId = "request-a")
        val newer = AskExchange("Newer question", answer = AskAnswer("Newer answer", ReadTally()), requestId = "request-b")
        val retried = mutableListOf<AskExchange>()
        compose.setContent {
            AskScreen(store, listOf(older, newer), emptyList(), emptySet(), false, null,
                onAsk = {}, onRetry = { retried += it }, onAskNew = {}, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, conversationId = "thread-a")
        }
        compose.onNodeWithText(Ask.interrupted).assertIsDisplayed()
        compose.onNodeWithText("Try again").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(older), retried) }
        scope.cancel()
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
        compose.onNodeWithContentDescription("Coach is thinking").assertDoesNotExist()
        compose.runOnIdle { generation = generation.copy(answer = "First words, then more.", revision = 2) }
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
        compose.setContent {
            AskScreen(store, emptyList(), emptyList(), emptySet(), false, null,
                onAsk = {}, onRetry = {}, onAskNew = {}, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, onPhotoAsk = { text, attachment -> sent += text to attachment })
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
    fun partialToCompletedKeepsTheOpenMenuAndCopiesAllReceivedTextBeforeRevealFinishes() {
        lateinit var clipboard: ClipboardManager
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        var generation by mutableStateOf(AskGeneration("generation-a", "request-a", "Question", "running", "Partial café", revision = 1))
        compose.setContent {
            clipboard = LocalClipboardManager.current
            AskScreen(store, listOf(generation.exchange()), emptyList(), emptySet(), !generation.terminal, null,
                onAsk = {}, onRetry = {}, onAskNew = {}, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, conversationId = "thread-a")
        }
        compose.onNodeWithText("Partial café").performTouchInput { longClick() }
        compose.onNodeWithText("Copy answer").assertIsDisplayed()
        val whole = "Partial café 東京 🏋🏽‍♀️ " + "received words ".repeat(100).trimEnd()
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { generation = generation.copy(status = "completed", answer = whole, revision = 3) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(150)
        val shown = compose.onAllNodes(hasText("Partial café", substring = true), useUnmergedTree = true)
            .fetchSemanticsNodes().flatMap { it.config[SemanticsProperties.Text] }.joinToString("") { it.text }
        assertTrue(shown.length > "Partial café".length && shown.length < whole.length && whole.startsWith(shown))
        val copy = compose.onNodeWithText("Copy answer").assertIsDisplayed()
            .fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnIdle {
            assertTrue(copy())
            assertEquals(whole, clipboard.getText()?.text)
        }
        compose.mainClock.autoAdvance = true
        scope.cancel()
    }

    @Test
    fun theEmptyRoomLeadsDirectlyToTheComposer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        room(signedIn(scope).store, thread = emptyList(), cap = null, doors = mutableListOf())

        compose.onNodeWithText(Ask.title).assertIsDisplayed()
        compose.onNodeWithText("reads your log · helps with your routines").assertDoesNotExist()
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

    @Test fun allowanceKeepsTheRefusedDraftAndOnlyTheAnonymousSignInDoor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest()).also { rooms += it }
        runBlocking { fixture.select(null) }
        val store = fixture.store
        val input = "Swap chin-ups for pulldowns"
        store.coach.saveDraft("new", CoachDraft(input))
        val doors = mutableListOf<String>()
        room(store, listOf(AskExchange(input, trouble = "Your AI allowance is fully used or reserved.")), AskCap.Allowance, doors)
        compose.onNodeWithText(AskCap.Allowance.wordless + "\nSign in to continue.").assertIsDisplayed()
        compose.onNodeWithText("Your AI allowance is fully used or reserved.").assertDoesNotExist()
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
        val store = signedIn(scope).store
        store.coach.saveDraft("new", CoachDraft("Swap chin-ups for pulldowns"))
        val asked = AskExchange("How heavy should I start squats?", answer = AskAnswer("Choose a weight you can lift 8 times.", ReadTally()),
            requestId = "request-a", atMs = System.currentTimeMillis() - 60_000)
        val refused = AskExchange("Swap chin-ups for pulldowns", trouble = AskCap.Allowance.wordless, requestId = "request-b",
            atMs = System.currentTimeMillis())
        room(store, listOf(asked, refused), AskCap.Allowance, mutableListOf())
        compose.onNodeWithText(AskCap.Allowance.wordless).assertIsDisplayed()
        assertEquals(1, compose.onAllNodesWithText("Today ", substring = true).fetchSemanticsNodes().size)
        scope.cancel()
    }

    @Test fun choicesThatReadNothingFromTheLogStandWithoutASourcesRow() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val clarification = CoachClarification("choice-123", "How many days and what equipment?", listOf(
            CoachClarification.Group("days", "Days each week", false, listOf(CoachClarification.Option("d3", "3 days")))))
        val raw = works.windmill.platform.net.WindmillJson.encodeToJsonElement(CoachClarification.serializer(), clarification)
        val exchange = AskExchange("Build me a program to get stronger.", answer = AskAnswer("How many days and what equipment?", ReadTally(),
            steps = listOf(AskStep("list_exercises"), AskStep("ask_setup_details")),
            receipt = AnswerReceipt(1, ReadTally(), steps = listOf(AskStep("list_exercises"))), clarification = raw), requestId = "request-123")
        room(store, listOf(exchange), null, mutableListOf())
        compose.onNodeWithText("3 days").assertIsDisplayed()
        compose.onNodeWithText("Read nothing from your log").assertDoesNotExist()
        scope.cancel()
    }

    @Test fun signedInAllowanceWithoutResetKeepsOnlyItsFirstSentenceAndAnEditableComposer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        store.coach.saveDraft("new", CoachDraft("Retained input"))
        val doors = mutableListOf<String>()
        room(store, listOf(AskExchange("Retained input", trouble = AskCap.Allowance.wordless)), AskCap.Allowance, doors)
        compose.onNodeWithText(AskCap.Allowance.wordless).assertIsDisplayed()
        for (label in listOf("Sign in", "Upgrade", "Use your own AI agent", "You can use Coach again on"))
            compose.onNodeWithText(label, substring = true).assertDoesNotExist()
        compose.onNodeWithContentDescription("Question").performTextReplacement("Edited input")
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals(listOf("ask:Edited input"), doors)
        scope.cancel()
    }

    @Test
    fun theDayCapKeepsEditableRefusedInputAndSendWithAnHonestNotice() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val refused = AskExchange("is my week too light?", trouble = "the next question frees up in a couple of hours")
        store.coach.saveDraft("new", CoachDraft(refused.question))
        val doors = mutableListOf<String>()
        room(store, thread = listOf(refused), cap = AskCap.Daily, doors = doors)
        compose.onNodeWithText(Ask.capReached).assertIsDisplayed()
        compose.onNodeWithText(refused.trouble!!).assertDoesNotExist()
        compose.onAllNodesWithText(refused.question).assertCountEquals(1)
        compose.onNode(hasText(refused.question) and hasSetTextAction()).assertIsDisplayed()
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
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest()).also { rooms += it }
        runBlocking { fixture.select(null) }
        val input = "Swap chin-ups for pulldowns"
        fixture.store.coach.saveDraft("new", CoachDraft(input))
        room(fixture.store, thread = listOf(AskExchange(input, trouble = AskCap.Allowance.wordless, refusalCode = "subject_exhausted")),
            cap = AskCap.Allowance, doors = mutableListOf())
        compose.onAllNodesWithText(input).assertCountEquals(1)
        compose.onNode(hasText(input) and hasSetTextAction()).assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun theAccountCeilingUsesItsOwnNoticeWithoutReplacingTheComposer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val ceiling = "this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on"
        val refused = AskExchange("what's stalled?", trouble = ceiling)
        val doors = mutableListOf<String>()
        room(signedIn(scope).store, listOf(refused), AskCap.Ceiling, doors)
        compose.onNodeWithText(ceiling).assertIsDisplayed()
        compose.onNodeWithText(Ask.capReached).assertDoesNotExist()
        compose.onNodeWithContentDescription("Question").assertIsDisplayed()
        compose.onNodeWithText("Use your own AI agent").performClick()
        compose.runOnIdle { assertEquals(listOf("connections"), doors) }
        compose.onNodeWithText(Threads.open).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun onlyTheTypedAccountRefusalShowsTheApprovedFixedBubbleAndExistingSignInDoor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val exchange = AskExchange("Make Push A harder", trouble = "Private model prose", refusalCode = "account_required")
        val doors = mutableListOf<String>()
        room(signedIn(scope).store, listOf(exchange), null, doors)
        compose.onNodeWithText(exchange.question).assertIsDisplayed()
        compose.onNodeWithText(Ask.accountRequired).assertIsDisplayed()
        compose.onNodeWithText("Private model prose").assertDoesNotExist()
        compose.onNodeWithText("Sign in").performClick()
        compose.runOnIdle { assertEquals(listOf("signIn"), doors) }
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
    fun theQuietRoomKeepsHistoryAndTheAccountSeatInTheBar() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        room(signedIn(scope).store, thread = emptyList(), cap = null, doors = doors)

        compose.onNodeWithText("Notes").assertDoesNotExist()
        compose.onNodeWithContentDescription("More").assertDoesNotExist()
        compose.onNodeWithContentDescription("Your account").assertIsDisplayed()
        compose.onNodeWithContentDescription("History").performClick()
        compose.runOnIdle { assertEquals(listOf("threads"), doors) }
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
        var thread by mutableStateOf(listOf(AskExchange("First question", AskAnswer("Long history. ".repeat(500), ReadTally(0, 0, 0)))))
        compose.setContent {
            AskScreen(store, thread, emptyList(), emptySet(), false, null, onAsk = {}, onRetry = {}, onAskNew = {},
                seed = "", origin = "https://windmill.works", onThreads = {}, onNotes = {}, onReview = {})
        }
        compose.runOnIdle {
            thread = thread + AskExchange("Second question", AskAnswer("A fast complete answer.", ReadTally(0, 0, 0)))
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
        val first = AskExchange("First question", AskAnswer("Your existing training history. ".repeat(150), ReadTally(0, 0, 0)))
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
        compose.onNodeWithContentDescription("Coach is thinking").assertIsDisplayed()
        var viewport = compose.onNodeWithTag("coach-thread").getUnclippedBoundsInRoot()
        var question = compose.onNodeWithText("Second question").getUnclippedBoundsInRoot()
        assertTrue("pending question is visible above the typing bubble", question.top >= viewport.top && question.bottom <= viewport.bottom)
        compose.onNodeWithText("First question").assertIsNotDisplayed()

        compose.runOnIdle {
            height = 900.dp
            thread = listOf(first, AskExchange("Second question", AskAnswer("The complete answer is visible here.", ReadTally(0, 0, 0))))
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
                    val answer = if (thread.isEmpty()) "A much longer training history. ".repeat(200) else "The new answer is here."
                    thread = thread + AskExchange(it, AskAnswer(answer, ReadTally(0, 0, 0)))
                }, onRetry = {}, onAskNew = { conversation = ""; thread = emptyList() }, seed = "", origin = "https://windmill.works",
                onThreads = {}, onNotes = {}, onReview = {}, conversationId = conversation,
                onNewDraft = { conversation = ""; thread = emptyList() })
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
        val answered = AskExchange("Remove this routine?",
            AskAnswer(answer = "You can remove it.", read = read, proposals = listOf("proposal1")))
        var receipts by mutableStateOf<List<String>>(emptyList())
        compose.setContent {
            AskScreen(room.store, listOf(answered), receipts, emptySet(), false, null, {}, {}, {}, "",
                "https://windmill.works", onThreads = {}, onNotes = {}, onReview = {})
        }
        compose.onNodeWithText("Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal.")
            .performScrollTo().assertIsDisplayed()
        assertEquals(20.dp, compose.onNodeWithText(Ask.promise).getUnclippedBoundsInRoot().left)
        val settled = applied(room, server, "proposal1")
        compose.runOnIdle { receipts = listOf(requireNotNull(settled.proposal.receipt)) }
        compose.onNodeWithText(requireNotNull(settled.proposal.receipt)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(Ask.promise).assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<String>(), room.store.routines.map { it.id }) }
        scope.cancel()
    }

    // Coach answers before its proposal reaches the phone: the answer stands, and the card is drawn in the same visit
    // once the proposal syncs.
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
        compose.setContent {
            AskScreen(room.store, listOf(AskExchange("What next?", AskAnswer("The answer stays readable.", read,
                proposals = listOf("proposal1")))), emptyList(), emptySet(), false, null, {}, {}, {}, "",
                "https://windmill.works", onThreads = {}, onNotes = {}, onReview = {})
        }
        compose.onNodeWithText("The answer stays readable.").assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        compose.onNodeWithText("Review").assertDoesNotExist()
        compose.runOnIdle { room.pull(server) }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Proposal · Push A").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Proposal · Push A").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ProposalRead.Gone.line).assertDoesNotExist()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        scope.cancel()
    }

    // A proposal still missing once the phone has caught up past where it stood at the first miss is reported once,
    // with no labels.
    @Test
    fun aProposalStillMissingAfterThePhoneCatchesUpIsReportedOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        room.pull(server)
        room.store.observeEngine()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        compose.setContent {
            CompositionLocalProvider(LocalTelemetry provides telemetry) {
                AskScreen(room.store, listOf(AskExchange("What next?", AskAnswer("The answer stays readable.", read,
                    proposals = listOf("proposal1")))), emptyList(), emptySet(), false, null, {}, {}, {}, "",
                    "https://windmill.works", onThreads = {}, onNotes = {}, onReview = {})
            }
        }
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        val before = compose.runOnIdle { room.store.caughtUpTo }
        repeat(2) { saved(room, server, RoutineDraft(name = "Pull $it").adding("bench-press", List(3) { SetTarget(5) })) }
        compose.waitUntil(5_000) { compose.runOnIdle { events.any { it.first == "gym_proposal_missing" } } }
        compose.runOnIdle {
            assertTrue(room.store.caughtUpTo!! > before!!)
            assertEquals(listOf("gym_proposal_missing" to emptyMap<String, String>()), events.filter { it.first == "gym_proposal_missing" })
        }
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        scope.cancel()
    }

}
