package works.windmill.gym.coach

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.util.concurrent.CopyOnWriteArrayList
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
import works.windmill.gym.store.EngineRoomFixture
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

    private fun history(api: FakeGymRest): EngineRoomFixture {
        val fixture = EngineRoomFixture(tmp.newFolder(), scope, rest = api, telemetry = telemetry)
        room = fixture
        runBlocking { fixture.select("alice") }
        compose.setContent { GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry) {
            ThreadsScreen(fixture.store, "Coach", {}, {}, {})
        } } }
        compose.onNodeWithText("Private first question").assertIsDisplayed()
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
