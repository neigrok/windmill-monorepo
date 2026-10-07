package works.windmill.gym

import androidx.compose.ui.test.assertIsDisplayed
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

// The one thing the room says about a settle, and it is a failure. A delete that failed must never
// look like one that worked, so the room owes three things at once when a window closes on a log
// that says no: the sentence, said once; the row, back where it was; and the way back, retired —
// because an `Undo` still standing over a delete that never happened is the transient lying about
// the store behind it.
//
// The room said none of them. `clearDeleteRefused()` ran BEFORE `showSnackbar`, which changed the
// key the effect was running under, and an effect that changes its own key cancels itself: eleven
// seconds after a refused delete the screen still read `Push Day deleted.` with `Undo`, while the
// log still held the routine.
//
// A conversation is the delete the log can still refuse after its window: it goes over the wire.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RefusedSettleTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    // The room flushes through the engine as it leaves, so the screen goes before the engine closes.
    private var showing by mutableStateOf(true)

    // The shipped nine seconds, whole. The window's clock runs on the main dispatcher, which counts
    // down the LOOPER's clock, so nine seconds cost nothing and `idleFor` is what spends them.
    private val window = Withheld.windowMs

    @Test
    fun testARefusedSettleIsSaidOnceAndTakesTheWayBackDownWithIt() {
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
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = log)
        try {
            runBlocking { room.select("u1") }
            val store = room.store
            compose.setContent { if (showing) GymMaterial { GymRoom(room.account(), store) } }
            compose.waitForIdle()
            compose.onNodeWithText("Coach").performClick()
            compose.onNodeWithText(Threads.door).performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("why is my bench stalled?").fetchSemanticsNodes().isNotEmpty()
            }

            // The swipe's dismiss finishes, then the row goes and the transient arrives — three
            // recompositions the gesture does not wait for, so the arrival is WAITED FOR rather than
            // read at a chosen moment.
            compose.onNodeWithText("why is my bench stalled?").performTouchInput { swipeLeft() }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Conversation deleted.", substring = true).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("Conversation deleted.", substring = true).assertIsDisplayed()
            compose.onNodeWithText(Withheld.undo).assertIsDisplayed()

            // The window closes, the log is asked, and it says no. The clock is the store's own and it
            // runs on the main looper, so the looper is what carries the nine seconds here.
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(window + 1))
            compose.waitForIdle()
            compose.runOnIdle { assertEquals("the window closed", 0, store.withheld.size) }

            val said = "the log didn’t answer — that conversation is still here"
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(said).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText(said).assertIsDisplayed()
            // The transient's state agrees with the store's: nothing is held, so nothing offers a way
            // back to it, and the row is on the screen where the lifter left it.
            compose.onNodeWithText("Conversation deleted.", substring = true).assertDoesNotExist()
            compose.onNodeWithText(Withheld.undo).assertDoesNotExist()
            compose.onNodeWithText("why is my bench stalled?").assertIsDisplayed()

            compose.runOnIdle {
                assertEquals("asked once, not once every window", 1, deletes)
                assertEquals("and the conversation is still the lifter's", listOf("thr_1"), store.coach.threads.map { it.id })
            }
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
}
