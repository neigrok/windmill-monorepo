package works.windmill.gym.coach

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.util.concurrent.CopyOnWriteArrayList
import java.io.File
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.GymRoom
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WorkoutControls
import works.windmill.gym.coach.onboarding.*
import works.windmill.platform.ai.*
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

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

    @Test fun anonymousHistoryDoesNotOfferStopForTheApplicationOwnedOnboardingRequest() {
        val local = LocalCoach(File(tmp.root, "anonymous-history.json"))
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, localCoach = local, telemetry = telemetry)
        room = fixture
        runBlocking { fixture.select(null) }
        val origin = CoachOnboardingSeat(local.anonymousOwner(), fixture.engine.activeReplica())
        val allowance = AiAllowance("ok", "USD", "lifetime", "anonymous", true, null, "0", "0", "0")
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val values = object : KeptValues {
            val saved = mutableMapOf<String, String>()
            override fun read(key: String) = saved[key]
            override fun write(values: Map<String, String?>) {
                values.forEach { (key, value) -> if (value == null) saved.remove(key) else saved[key] = value }
            }
        }
        val identity = AiInstallation(values, SecretVault { key }, object : AiInstallationApi {
            override suspend fun issue() = AiInstallationResponse(false, allowance, "A".repeat(43))
            override suspend fun current(credential: String) = AiInstallationResponse(false, allowance)
            override suspend fun bind(credential: String, token: String) = AiInstallationResponse(true, allowance)
        })
        val response = CompletableDeferred<CoachOnboardingResponse>()
        val posted = CompletableDeferred<Unit>()
        var posts = 0
        val id = "11111111-1111-4111-8111-111111111111"
        val coordinator = CoachOnboardingStore(local, identity, object : CoachOnboardingApi {
            override suspend fun start(body: String, credential: String): CoachOnboardingResponse { posts++; posted.complete(Unit); return response.await() }
            override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse = error("unexpected GET")
        }, { origin }, scope, telemetry, requestId = { id })
        val store = TrainingStore(WorkoutControls(File(tmp.root, "history-controls.json")), fixture.training, scope,
            localCoach = local, coachOnboarding = coordinator, telemetry = telemetry)
        runBlocking { store.connect(fixture.account()) }
        val chat = store.coach.freshChat()
        var showing by mutableStateOf(false)
        compose.setContent { GymMaterial {
            if (showing) ThreadScreen(chat, store, emptyList(), emptySet(), "History", {}, {}, {}, composerEnabled = true)
        } }
        compose.runOnIdle { store.coach.refreshAnonymousAccess() }
        compose.waitUntil(5_000) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); store.coach.anonymousAccess == AnonymousCoachAccess.Available }
        compose.runOnIdle { assertTrue(store.coach.submit(chat, "A retained question")) }
        compose.waitUntil(5_000) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); posted.isCompleted }
        compose.runOnIdle { showing = true }
        compose.onNodeWithContentDescription("Stop response").assertIsNotEnabled().performClick()
        compose.runOnIdle {
            assertTrue(store.coach.isAsking(chat))
            assertFalse(response.isCancelled)
        }
        response.complete(CoachOnboardingResponse(id, "result", "completed", 1_900_000_000_000, emptyList(), allowance, message = "A retained answer"))
        compose.waitUntil(5_000) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); !store.coach.isAsking(chat) }
        compose.onNodeWithText("A retained question").assertIsDisplayed()
        assertEquals("A retained answer", store.coach.chat(chat)!!.exchanges.single().answer!!.answer)
        assertEquals(1, posts)
        assertEquals(emptyList<String>(), failures.toList())
    }

    private fun history(api: FakeGymRest): EngineRoomFixture {
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, rest = api, telemetry = telemetry)
        room = fixture
        runBlocking { fixture.select("alice") }
        compose.setContent { GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry) {
            ThreadsScreen(fixture.store, "Coach", {}, {}, {})
        } } }
        compose.onNodeWithText("Private first question").assertIsDisplayed()
        compose.onNodeWithContentDescription(Threads.open).assertIsDisplayed()
        events.clear()
        failures.clear()
        return fixture
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
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest(), telemetry = telemetry)
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

    @Test fun cancellationRestoresTheRowAndNeverSendsADelete() {
        val api = FakeGymRest().apply { conversations["thread-a"] = AskThread("thread-a", "Private first question", askedAtMs = 1) }
        history(api)
        requestDelete()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Private first question").assertIsDisplayed()
        assertEquals(emptyList<String>(), api.calls.filter { it == "deleteThread" })
        assertEquals(listOf(
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "state" to "shown"),
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "outcome" to "cancelled"),
        ), events.toList())
        assertEquals(emptyList<String>(), failures.toList())
    }

    @Test fun confirmationDeletesImmediatelyWithOneResultAndNoUndo() {
        val api = FakeGymRest().apply { conversations["thread-a"] = AskThread("thread-a", "Private first question", askedAtMs = 1) }
        val fixture = history(api)
        requestDelete()
        compose.onNodeWithText("Delete").performClick()
        compose.waitUntil(5_000) {
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            api.calls.count { it == "deleteThread" } == 1 && fixture.store.coach.allThreads.isEmpty()
        }
        compose.onNodeWithText("No conversations").assertIsDisplayed()
        compose.onNodeWithText("Undo").assertDoesNotExist()
        assertEquals(emptyList<Any>(), fixture.store.withheld)
        assertEquals(listOf(
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "state" to "shown"),
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "outcome" to "ok"),
        ), events.toList())
        assertEquals(emptyList<String>(), failures.toList())
    }

    @Test fun technicalDeleteFailureReturnsTheRowAndReportsOnceWithoutMessageContent() {
        val api = FakeGymRest().apply { conversations["thread-a"] = AskThread("thread-a", "Private first question", askedAtMs = 1) }
        history(api)
        api.online = false
        requestDelete()
        compose.onNodeWithText("Delete").performClick()
        compose.waitUntil(5_000) {
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            events.any { it.second["outcome"] == "failed" }
        }
        compose.onNodeWithText("Private first question").assertIsDisplayed()
        compose.onNodeWithText("the log didn’t answer — that conversation is still here").assertIsDisplayed()
        assertEquals(listOf(
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "state" to "shown"),
            "gym_action" to mapOf("screen" to "threads", "action" to "delete", "outcome" to "failed"),
        ), events.toList())
        assertEquals(listOf("gym.deleteThread"), failures.toList())
    }
}
