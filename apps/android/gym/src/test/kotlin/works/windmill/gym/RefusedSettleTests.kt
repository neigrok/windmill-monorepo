package works.windmill.gym

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import android.os.Looper
import java.io.IOException
import java.time.Duration
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.gym.coach.AskThread
import works.windmill.gym.coach.Threads
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.GymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.Withheld
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RefusedSettleTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    private var showing by mutableStateOf(true)

    @Test
    fun aConfirmedConversationDeleteFailureIsSaidOnceAndRetainsTheRowWithoutUndo() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeGymRest()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        var deletes = 0
        val log = object : GymRest by server {
            override suspend fun deleteThread(id: String) {
                deletes += 1
                throw IOException("the log is down")
            }
        }
        val failures = mutableListOf<String>()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = log, telemetry = telemetry)
        try {
            runBlocking { room.select("u1") }
            val store = room.store
            compose.setContent { if (showing) GymMaterial { GymRoom(room.account(), store) } }
            compose.waitForIdle()
            compose.onNodeWithText("Coach").performClick()
            compose.onNode(hasText(Threads.door) or hasContentDescription(Threads.door)).performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("why is my bench stalled?").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("why is my bench stalled?").performTouchInput { swipeLeft() }
            compose.onNodeWithText("Delete this conversation?").assertIsDisplayed()
            compose.runOnIdle { assertEquals(0, deletes) }
            compose.onNodeWithText("Delete").performClick()
            val said = "the log didn’t answer — that conversation is still here"
            compose.waitUntil(10_000) { compose.onAllNodesWithText(said).fetchSemanticsNodes().isNotEmpty() }
            compose.onAllNodesWithText(said).assertCountEquals(1)
            compose.onNodeWithText(said).assertIsDisplayed()
            compose.onNodeWithText("Delete this conversation?").assertDoesNotExist()
            compose.onNodeWithText("Conversation deleted.", substring = true).assertDoesNotExist()
            compose.onNodeWithText(Withheld.undo).assertDoesNotExist()
            compose.onNodeWithText("why is my bench stalled?").assertIsDisplayed()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(Withheld.windowMs + 1))
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(1, deletes)
                assertEquals(listOf("thr_1"), store.coach.threads.map { it.id })
                assertEquals(emptyList<Withheld>(), store.held.withheld)
                assertEquals(listOf("gym.deleteThread"), failures)
                assertEquals(listOf("gym_action" to mapOf("screen" to "threads", "action" to "delete", "outcome" to "failed")),
                    events.filter { it.first == "gym_action" && it.second["action"] == "delete" })
            }
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
}
