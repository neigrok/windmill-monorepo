package works.windmill.gym

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import java.io.File
import android.os.Looper
import android.os.SystemClock
import java.io.IOException
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.Withheld
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

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
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RefusedSettleTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    // The shipped nine seconds, whole. Every clock this test reads is the LOOPER's — the store
    // stamps its windows off `SystemClock.uptimeMillis` and `delay` on the main dispatcher counts
    // down the same one — so nine seconds cost nothing and `idleFor` is what spends them. A window
    // measured against the wall clock instead would be the machine's to close: the swipe's dismiss
    // animation and the recomposition behind it take however long this runner takes, and a shortened
    // span turns that into whether the transient is still on screen when the next line reads it.
    private val window = SetQueue.undoWindowMs

    private val account = Account(
        api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
        user = User(id = "u1", email = "sam@example.com", name = "Sam"),
    )

    private fun program(scope: CoroutineScope, server: FakeTraining): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json"), clock = SystemClock::uptimeMillis),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            now = SystemClock::uptimeMillis,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            undoWindowMs = window,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking {
            store.connect(account)
            store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press"))
        }
        return store
    }

    @Test
    fun testARefusedSettleIsSaidOnceAndTakesTheWayBackDownWithIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.refuseRoutineDelete = IOException("the log is down")
        val store = program(scope, server)
        compose.setContent { GymMaterial { GymRoom(account, store) } }
        compose.waitForIdle()

        // The swipe's dismiss finishes, then the row goes and the transient arrives — three
        // recompositions the gesture does not wait for, so the arrival is WAITED FOR rather than
        // read at a chosen moment.
        compose.onNodeWithText("Push Day").performTouchInput { swipeLeft() }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Push Day deleted.").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Push Day deleted.").assertIsDisplayed()
        compose.onNodeWithText(Withheld.undo).assertIsDisplayed()

        // The window closes, the log is asked, and it says no. The clock is the store's own and it
        // runs on the main looper, so the looper is what carries the nine seconds here.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(window + 1))
        compose.waitForIdle()
        compose.runOnIdle { assertEquals("the window closed", 0, store.withheld.size) }

        val said = "the log didn’t answer — Push Day is still in your program"
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(said).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(said).assertIsDisplayed()
        // The transient's state agrees with the store's: nothing is held, so nothing offers a way
        // back to it, and the row is on the screen where the lifter left it.
        compose.onNodeWithText("Push Day deleted.").assertDoesNotExist()
        compose.onNodeWithText(Withheld.undo).assertDoesNotExist()
        compose.onNodeWithText("Push Day").assertIsDisplayed()

        compose.runOnIdle {
            assertEquals("asked once, not once every window",
                1, server.calls.count { it == "deleteRoutine" })
            assertEquals("and the routine is still the lifter's", 1, store.routines.size)
        }
        scope.cancel()
    }
}
