package works.windmill.gym

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Readout
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.ui.Finish
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException

// 16-the-workout: the finish is a sheet presented over the session it just closed, and dismissing it
// leaves you in the workout you finished. That ruling costs the room three things at once — the
// workout has to be PUSHED before the receipt rises, or a dismissal lands on the routines home; the
// receipt has to carry its own title, because a sheet has no top bar to put one in; and it has to
// carry its own refusals, because a sheet covers the bottom bar the room says everything else in.
//
// Back used to be claimed on this screen and answer with nothing at all.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class FinishSheetTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val account = Account(
        api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
        user = User(id = "u1", email = "sam@example.com", name = "Sam"),
    )

    private fun program(scope: CoroutineScope, server: FakeTraining): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking { store.connect(account) }
        return store
    }

    // A workout with no routine behind it: one working set, then Finish off the logger's top bar.
    private fun finishAWorkout(scope: CoroutineScope, server: FakeTraining) {
        val store = program(scope, server)
        runBlocking {
            store.start(null)
            store.choose("back-squat")
            store.logSet(100.0, 5)
        }
        compose.setContent { GymMaterial { GymRoom(account, store) } }
        compose.waitForIdle()
        compose.onNodeWithText("Finish").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Session finished").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun testTheReceiptStandsOverTheWorkoutItClosedAndSaysItsOwnTitle() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        finishAWorkout(scope, server)

        // The title is IN the receipt, not in a bar above it — `Ended early` is a slight session's
        // whole salience and a sheet has nowhere else to put it.
        compose.onNodeWithText("Session finished").assertIsDisplayed()
        // And the workout itself is what stands underneath, so dismissing lands on its detail page.
        compose.onNodeWithText(Readout.noRoutine).assertIsDisplayed()
        // A pushed screen covers the rail, before the sheet and after it.
        compose.onNodeWithText("The log").assertDoesNotExist()
        scope.cancel()
    }

    // One act, one spelling. The receipt's way out is the sheet coming down; the only affirmative
    // left on it is the slight session's, and this session is not slight.
    @Test
    fun testTheReceiptDrawsNoDismissalOfItsOwn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        finishAWorkout(scope, server)

        compose.onAllNodesWithText("Done").assertCountEquals(0)
        compose.onAllNodesWithText("Just keep the session").assertCountEquals(0)
        compose.onAllNodesWithText(Finish.keepIt).assertCountEquals(0)
        scope.cancel()
    }

    // The refusal is drawn under the Save that raised it. The room's own `note` line lives in the
    // Scaffold's bottom bar, which this sheet covers, so a refusal said there is not said at all.
    @Test
    fun testAKeepTheLogRefusesIsSaidOnTheSheetItself() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.refuseRoutine = {
            WindmillApiException.Refused(
                400, Refusal(message = "that document is unclaimable", code = "bad-routine"))
        }
        finishAWorkout(scope, server)

        // Scrolling to it is the point as well as the means: the sheet body carries its own scroll.
        compose.onNodeWithText("Save routine").performScrollTo().performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("that document is unclaimable").fetchSemanticsNodes().isNotEmpty()
        }
        // Drawn ON the sheet and not merely on the screen: a sheet is its own window, so a refusal
        // said in the Scaffold beneath it is behind the scrim where nobody reads it.
        assertSame(
            "the refusal belongs to the receipt's own window",
            compose.onNodeWithText("Session finished").fetchSemanticsNode().root,
            compose.onNodeWithText("that document is unclaimable").fetchSemanticsNode().root,
        )
        scope.cancel()
    }

    // And once the receipt is gone the sheet is no home at all: the keep outlives it, so its refusal
    // falls back to the room's own line — the one every other refusal in this room lands in.
    @Test
    fun testAKeepRefusedAfterTheReceiptIsGoneIsSaidOnTheRoomsOwnLine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val answer = CompletableDeferred<Unit>()
        server.refuseRoutine = {
            answer.await()
            WindmillApiException.Refused(
                400, Refusal(message = "that document is unclaimable", code = "bad-routine"))
        }
        finishAWorkout(scope, server)

        compose.onNodeWithText("Save routine").performScrollTo().performClick()
        compose.waitForIdle()
        dismissTheReceipt()

        answer.complete(Unit)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("that document is unclaimable").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("that document is unclaimable").assertIsDisplayed()
        scope.cancel()
    }

    // The door closes while one is in flight, as it does on every other write this room owns: the
    // log mints no id for a routine, so a second tap is a second routine and not a replay.
    @Test
    fun testTwoTapsOnSaveRoutineKeepOneRoutine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val answer = CompletableDeferred<Unit>()
        server.refuseRoutine = { answer.await(); null }
        finishAWorkout(scope, server)

        compose.onNodeWithText("Save routine").performScrollTo().performClick()
        compose.onNodeWithText("Save routine").performClick()
        compose.waitForIdle()
        answer.complete(Unit)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Save routine").fetchSemanticsNodes().isEmpty()
        }

        assertEquals("one tap, one routine", 1, server.calls.count { it == "createRoutine" })
        scope.cancel()
    }

    // Back, the scrim or the handle — the receipt has no dismissal of its own, so a test takes the
    // one the platform draws.
    private fun dismissTheReceipt() {
        compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Session finished").fetchSemanticsNodes().isEmpty()
        }
    }
}
