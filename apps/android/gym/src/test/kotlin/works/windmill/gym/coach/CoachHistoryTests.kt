package works.windmill.gym.coach

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.GymRoom
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class CoachHistoryTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var room: EngineRoomFixture? = null
    private val events = CopyOnWriteArrayList<Pair<String, Map<String, String>>>()
    private val failures = CopyOnWriteArrayList<String>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
    }
    @After fun close() { room?.close(); scope.cancel() }

    private fun waitUntil(ready: () -> Boolean) = compose.waitUntil(5_000) {
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        ready()
    }

    private fun EngineRoomFixture.threads(): List<CoachThread> = engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachThread, read.drawn(CoachThread.type))
    }

    private fun EngineRoomFixture.messages(): List<CoachMessage> = engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachMessage, read.drawn(CoachMessage.type))
    }

    // Stop is one door for both seats: a signed-out turn runs the same path as a signed-in one.
    @Test fun aSignedOutChatOpenedFromHistoryOffersStopAndItStopsTheRunningTurn() {
        val server = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""").arr())
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, localCoach = LocalCoach(File(tmp.root, "anonymous-history.json")),
            coachServer = server, coachAccess = { AnonymousCoachAccess.Available })
        room = fixture
        runBlocking { fixture.select(null) }
        fixture.store.observeEngine()
        val coach = fixture.store.coach
        val chat = coach.freshChat()
        var showing by mutableStateOf(false)
        val ask = AskBinding(fixture.store)
        compose.setContent { GymMaterial {
            if (showing) ThreadScreen(ask, ask, chat, emptyList(), emptySet(), "History", {}, {}, {}, composerEnabled = true)
        } }
        compose.runOnIdle { coach.refreshAnonymousAccess() }
        waitUntil { coach.anonymousAccess == AnonymousCoachAccess.Available }
        compose.runOnIdle { assertTrue(coach.send(chat, "A retained question")) }
        waitUntil { server.pending == "stop" }
        compose.runOnIdle { showing = true }
        compose.onNodeWithContentDescription("Stop response").assertIsEnabled().performClick()
        waitUntil { !coach.isAsking(chat) && fixture.messages().any { it.state == MessageState.stopped } }
        compose.onNodeWithText("A retained question").assertIsDisplayed()
        compose.onNodeWithText(Ask.stopped).assertIsDisplayed()
        assertEquals(1, server.stops)
        assertEquals(1, server.opened.size)
        assertEquals(emptyList<String>(), failures.toList())
    }

    private fun answering(writable: () -> Boolean = { true }): EngineRoomFixture {
        val server = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"An answer"}},{"event":"done","data":{"state":"completed"}}]""").arr())
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, coachServer = server, writeAuthority = writable)
        room = fixture
        runBlocking {
            fixture.select("alice")
            fixture.sync(EngineRoomFixture.server())
        }
        fixture.store.observeEngine()
        val chat = fixture.store.coach.freshChat()
        assertTrue(fixture.store.coach.send(chat, "Private first question"))
        waitUntil { !fixture.store.coach.isAsking(chat) && fixture.messages().any { it.state == MessageState.completed } }
        return fixture
    }

    private fun show(fixture: EngineRoomFixture) {
        val threads = ThreadsBinding(fixture.store.coach)
        compose.setContent { GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry) {
            ThreadsScreen(threads, threads, "Coach", {}, {}, {})
        } } }
        compose.onNodeWithText("Private first question").assertIsDisplayed()
        compose.onNodeWithContentDescription(Threads.open).assertIsDisplayed()
        events.clear()
        failures.clear()
    }

    private fun requestDelete() {
        val row = compose.onNodeWithText("Private first question").fetchSemanticsNode()
        val actions = generateSequence(row) { it.parent }.flatMap { it.config.getOrNull(SemanticsActions.CustomActions).orEmpty() }.toList()
        assertEquals(listOf("Delete conversation"), actions.map { it.label })
        compose.runOnIdle { assertTrue(actions.single().action()) }
        compose.onNodeWithText("Delete this conversation?").assertIsDisplayed()
        compose.onNodeWithText("You can’t undo this.").assertIsDisplayed()
    }

    @Test fun theFullRailLeavesASelectedHistoryChatAndRetainsItsDraft() {
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry)
        room = fixture
        runBlocking { fixture.select("alice") }
        val id = fixture.store.coach.freshChat("Retained local draft")
        var showing by mutableStateOf(true)
        compose.setContent { if (showing) GymMaterial { GymRoom(fixture.account(), fixture.store) } }
        try {
            compose.onNode(hasText("Coach") and hasClickAction()).performClick()
            compose.onNodeWithContentDescription("History").performClick()
            compose.onNodeWithText("Retained local draft").performClick()
            compose.onNodeWithContentDescription("Question").assertTextEquals("Retained local draft")
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            compose.onNodeWithContentDescription("Question").assertDoesNotExist()
            compose.onNodeWithContentDescription("Weigh in").assertIsDisplayed()
            compose.onNode(hasText("Coach") and hasClickAction()).performClick()
            assertEquals("", compose.onNodeWithContentDescription("Question").fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
            compose.onNodeWithContentDescription("History").performClick()
            compose.onNodeWithText("Retained local draft").performClick()
            compose.onNode(hasText("Routines") and hasClickAction()).performClick()
            compose.onNodeWithContentDescription("Question").assertDoesNotExist()
            compose.onNodeWithContentDescription("New routine").assertIsDisplayed()
            assertEquals("Retained local draft", fixture.store.coach.draft(id).text)
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
        }
    }

    @Test fun cancellationRestoresTheRowAndDeletesNothing() {
        val fixture = answering()
        show(fixture)
        requestDelete()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Private first question").assertIsDisplayed()
        assertEquals(listOf("Private first question"), fixture.threads().map { it.title })
        assertEquals(2, fixture.messages().size)
        assertEquals(listOf(
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "state" to "shown"),
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "outcome" to "cancelled"),
        ), events.toList())
        assertEquals(emptyList<String>(), failures.toList())
    }

    // A recreated room hands the seat a new account object, so the seat forgets what it read: as a theme switch does with History open.
    @Test fun aSeatConnectedAgainReadsHistoryAndTheTranscriptBackWithNoNewRevision() {
        val fixture = answering()
        val coach = fixture.store.coach
        val chat = checkNotNull(coach.selectedChatId)
        show(fixture)
        compose.onNodeWithText("Private first question").assertIsDisplayed()
        runBlocking { fixture.store.connect(fixture.account()) }
        waitUntil { coach.history.isNotEmpty() && coach.exchanges(chat).isNotEmpty() }
        compose.onNodeWithText("Private first question").assertIsDisplayed()
        assertEquals(listOf("Private first question"), coach.exchanges(chat).map { it.question })
    }

    @Test fun anEmptyHistorySeatConnectedAgainStillSaysItIsEmpty() {
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, coachServer = ScriptedTurns(emptyList()))
        room = fixture
        runBlocking { fixture.select(null) }
        fixture.store.observeEngine()
        val threads = ThreadsBinding(fixture.store.coach)
        compose.setContent { GymMaterial { ThreadsScreen(threads, threads, "Coach", {}, {}, {}) } }
        waitUntil { fixture.store.coach.conversations?.rows != null }
        compose.onNodeWithText(Threads.none).assertIsDisplayed()
        runBlocking { fixture.store.connect(fixture.account()) }
        waitUntil { fixture.store.coach.conversations?.rows != null }
        compose.onNodeWithText(Threads.none).assertIsDisplayed()
    }

    @Test fun confirmationDeletesImmediatelyWithOneResultAndNoUndo() {
        val fixture = answering()
        show(fixture)
        requestDelete()
        compose.onNodeWithText("Delete").performClick()
        waitUntil { fixture.threads().isEmpty() && fixture.store.coach.history.isEmpty() && events.any { it.second["outcome"] == "ok" } }
        compose.onNodeWithText(Threads.none).assertIsDisplayed()
        compose.onNodeWithText("Undo").assertDoesNotExist()
        assertEquals(emptyList<CoachMessage>(), fixture.messages())
        assertEquals(emptyList<Any>(), fixture.store.held.withheld)
        assertEquals(listOf(
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "state" to "shown"),
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "outcome" to "ok"),
            "gym_action" to mapOf("screen" to "threads", "action" to "empty", "outcome" to "shown"),
        ), events.toList())
        assertEquals(emptyList<String>(), failures.toList())
    }

    @Test fun technicalDeleteFailureReturnsTheRowAndReportsOnceWithoutMessageContent() {
        var diskFails = false
        val disk = LocalCoach(File(tmp.root, "delete-failure.json")) { file, text ->
            if (diskFails) throw IOException("private local content")
            AtomicDocument.write(file, text)
        }
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, localCoach = disk)
        room = fixture
        runBlocking { fixture.select("alice") }
        fixture.store.observeEngine()
        val chat = fixture.store.coach.freshChat("Private first question")
        show(fixture)
        diskFails = true
        requestDelete()
        compose.onNodeWithText("Delete").performClick()
        waitUntil { events.any { it.second["outcome"] == "failed" } }
        compose.onNodeWithText("Private first question").assertIsDisplayed()
        compose.onNodeWithText("the log didn’t answer — that conversation is still here").assertIsDisplayed()
        assertEquals(CoachDraft("Private first question"), fixture.store.coach.draft(chat))
        assertEquals(listOf(
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "state" to "shown"),
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "outcome" to "failed"),
        ), events.toList())
        assertEquals(listOf("gym.deleteThread"), failures.toList())
    }

    // An account mid-transition closes the engine to this write: expected, so it is said on the row and never reported.
    @Test fun aDeleteTheEngineWillNotTakeReturnsTheThreadsRowWithNoReport() {
        var writable = true
        val fixture = answering { writable }
        show(fixture)
        writable = false
        requestDelete()
        compose.onNodeWithText("Delete").performClick()
        waitUntil { events.any { it.second["outcome"] == "failed" } }
        compose.onNodeWithText("Private first question").assertIsDisplayed()
        compose.onNodeWithText("the log didn’t answer — that conversation is still here").assertIsDisplayed()
        assertEquals(listOf("Private first question"), fixture.threads().map { it.title })
        assertEquals(2, fixture.messages().size)
        assertEquals(listOf(
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "state" to "shown"),
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "outcome" to "failed"),
        ), events.toList())
        assertEquals(emptyList<String>(), failures.toList())
    }
}
