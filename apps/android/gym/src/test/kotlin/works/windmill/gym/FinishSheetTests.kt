package works.windmill.gym

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Ask
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
import works.windmill.gym.ui.FinishCoach
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

    private val nobody = Account(api = account.api, user = null)

    private fun program(
        scope: CoroutineScope,
        server: FakeTraining,
        seat: Account = account,
    ): TrainingStore {
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
        runBlocking { store.connect(seat) }
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
        finish()
    }

    // Either title: one working set read off the device is slight, and the log's fake carries no
    // review at all.
    private fun finish(title: String = "Well done.") {
        compose.onNodeWithText("Finish").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(title).fetchSemanticsNodes().isNotEmpty()
        }
    }

    // Composed FIRST and worked afterwards, so a test can hold a conversation on the Coach tab
    // before the workout it then finishes.
    private fun startAWorkout(store: TrainingStore) {
        runBlocking {
            store.start(null)
            store.choose("back-squat")
            store.logSet(100.0, 5)
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Finish").fetchSemanticsNodes().isNotEmpty()
        }
    }

    // The receipt is its own window, so what stands on the session page beneath it — the link card
    // and the discard door, both of which keep their place there — is not on the receipt.
    private fun onTheReceipt(text: String): Int {
        val sheet = compose.onNodeWithText("Well done.").fetchSemanticsNode().root
        return compose.onAllNodesWithText(text).fetchSemanticsNodes().count { it.root == sheet }
    }

    private fun askAnOpener() {
        compose.onNodeWithText("Coach").performClick()
        compose.onNodeWithText(Ask.openers.first()).performClick()
    }

    @Test
    fun testTheReceiptStandsOverTheWorkoutItClosedAndSaysItsOwnTitle() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        finishAWorkout(scope, server)

        // The title is IN the receipt, not in a bar above it — `Ended early` is a slight session's
        // whole salience and a sheet has nowhere else to put it.
        compose.onNodeWithText("Well done.").assertIsDisplayed()
        // And the workout itself is what stands underneath, so dismissing lands on its detail page.
        compose.onNodeWithText(Readout.noRoutine).assertIsDisplayed()
        // A pushed screen covers the rail, before the sheet and after it.
        compose.onNodeWithText("The log").assertDoesNotExist()
        scope.cancel()
    }

    // The receipt's way out is the sheet coming down, and it decides nothing: no dismissal of its
    // own, no Keep it / Discard pair, and no link card — the link keeps its doors on the session
    // page and the log row.
    @Test
    fun testTheReceiptDrawsNoDismissalNoDecidedPairAndNoLinkCard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        finishAWorkout(scope, server)

        compose.onAllNodesWithText("Done").assertCountEquals(0)
        compose.onAllNodesWithText("Just keep the session").assertCountEquals(0)
        compose.onAllNodesWithText("Keep it").assertCountEquals(0)
        assertEquals(0, onTheReceipt(Finish.discard))
        assertEquals(0, onTheReceipt("Share this workout"))
        scope.cancel()
    }

    // The tap, in order: the receipt comes down, a FRESH conversation opens on the Coach tab, and
    // the one line goes through the same send a typed question takes — so the exchange is drawn
    // waiting the instant the tab shows, and the thread is titled by the line verbatim. Nothing
    // else rides with it: no session id, because Coach reads the log newest first.
    @Test
    fun testShareWithCoachOpensAFreshConversationAndSendsTheOneLine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = program(scope, server)
        compose.setContent { GymMaterial { GymRoom(account, store) } }
        compose.waitForIdle()

        // A conversation already standing, so the reset is proved and not assumed.
        askAnOpener()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("nothing has moved in three weeks.").fetchSemanticsNodes().isNotEmpty()
        }
        val answer = CompletableDeferred<Unit>()
        server.onAsk = { answer.await() }
        startAWorkout(store)
        finish()

        compose.onNodeWithText(FinishCoach.action).performScrollTo().performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Well done.").fetchSemanticsNodes().isEmpty()
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(Ask.waiting).fetchSemanticsNodes().isNotEmpty()
        }

        // Waiting is drawn before any answer lands, in the exchange the room already renders.
        compose.onNodeWithText(FinishCoach.question).assertIsDisplayed()
        compose.onNodeWithText(Ask.waiting).assertIsDisplayed()
        // Fresh: the earlier exchange is gone from the screen and the id on the wire is a new one.
        compose.onAllNodesWithText(Ask.openers.first()).assertCountEquals(0)
        compose.onAllNodesWithText("nothing has moved in three weeks.").assertCountEquals(0)
        compose.runOnIdle {
            assertEquals(listOf(Ask.openers.first(), "Check my last session."),
                         server.asked.map { it.question })
            assertTrue("a new conversation, not the one that stood",
                       server.asked[0].thread != server.asked[1].thread)
            assertTrue(server.asked[1].thread.isNotEmpty())
        }
        // The rail is back — the receipt and the workout beneath it are both down — on Coach.
        compose.onNodeWithText("The log").assertIsDisplayed()

        answer.complete(Unit)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("nothing has moved in three weeks.").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onAllNodesWithText(FinishCoach.question).assertCountEquals(1)
        scope.cancel()
    }

    // A double tap while the sheet is still descending is ONE tap: the second must not fire the
    // continuation again, or the fresh conversation minted by the first is wiped mid-request and a
    // follow-up lands in a thread of its own.
    @Test
    fun testTwoTapsOnShareWithCoachAreOneAskAndTheFollowUpStaysInThatThread() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val answer = CompletableDeferred<Unit>()
        server.onAsk = { answer.await() }
        finishAWorkout(scope, server)

        // Both taps inside ONE frame, with the clock held so the first descent is still in flight
        // when the second `hide()` arrives: a second `performClick` would wait for idle first, and
        // on a free-running test clock the sheet is down before it lands.
        val tap = compose.onNodeWithText(FinishCoach.action).performScrollTo()
            .fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.mainClock.autoAdvance = false
        compose.runOnIdle {
            tap()
            tap()
        }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(1_000)
        compose.mainClock.autoAdvance = true
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Well done.").fetchSemanticsNodes().isEmpty()
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(Ask.waiting).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onAllNodesWithText(FinishCoach.question).assertCountEquals(1)
        compose.runOnIdle { assertEquals("one tap, one ask", 1, server.calls.count { it == "ask" }) }

        answer.complete(Unit)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("nothing has moved in three weeks.").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(Ask.placeholder).performTextReplacement("And my squat?")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.waitUntil(10_000) { server.asked.size == 2 }
        compose.runOnIdle {
            assertEquals(listOf(FinishCoach.question, "And my squat?"), server.asked.map { it.question })
            assertEquals("the follow-up continues the conversation the tap opened",
                         server.asked[0].thread, server.asked[1].thread)
        }
        scope.cancel()
    }

    // A tap behind an ask still in flight resets nothing and sends nothing: the receipt comes down
    // on the Coach tab, where the stalled exchange is already drawn waiting.
    @Test
    fun testATapBehindAnAskStillInFlightLandsOnTheWaitingExchange() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val answer = CompletableDeferred<Unit>()
        server.onAsk = { answer.await() }
        val store = program(scope, server)
        compose.setContent { GymMaterial { GymRoom(account, store) } }
        compose.waitForIdle()

        askAnOpener()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(Ask.waiting).fetchSemanticsNodes().isNotEmpty()
        }
        startAWorkout(store)
        finish()

        compose.onNodeWithText(FinishCoach.action).performScrollTo().performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Well done.").fetchSemanticsNodes().isEmpty()
        }
        compose.onNodeWithText(Ask.waiting).assertIsDisplayed()
        // The question, not the empty room's chips: the thread was not wiped.
        compose.onAllNodesWithText(Ask.openers.first()).assertCountEquals(1)
        compose.onAllNodesWithText(FinishCoach.question).assertCountEquals(0)
        compose.runOnIdle { assertEquals("the opener, and nothing behind it", 1, server.asked.size) }

        answer.complete(Unit)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("nothing has moved in three weeks.").fetchSemanticsNodes().isNotEmpty()
        }
        scope.cancel()
    }

    // Signed out there is no Coach to reach, and nothing stands where the primary would — on the
    // slight branch here, which is the branch the old decided pair stood on.
    @Test
    fun testSignedOutTheReceiptOffersNoShareWithCoach() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = program(scope, server, nobody)
        compose.setContent { GymMaterial { GymRoom(nobody, store) } }
        compose.waitForIdle()
        startAWorkout(store)
        finish(title = "Ended early.")

        compose.onAllNodesWithText(FinishCoach.action).assertCountEquals(0)
        compose.onAllNodesWithText(FinishCoach.caption).assertCountEquals(0)
        assertEquals("nothing was asked", 0, server.calls.count { it == "ask" })
        scope.cancel()
    }

    // A deployment without Coach — the route answered 404 — takes the door down on the receipt as
    // it does on the tab.
    @Test
    fun testWithoutCoachOnThisDeploymentTheReceiptOffersNoShareWithCoach() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.refuseAsk = WindmillApiException.Refused(404, Refusal(message = "not found", code = "not-found"))
        val store = program(scope, server)
        compose.setContent { GymMaterial { GymRoom(account, store) } }
        compose.waitForIdle()

        askAnOpener()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(Ask.notHere).fetchSemanticsNodes().isNotEmpty()
        }
        startAWorkout(store)
        finish()

        compose.onAllNodesWithText(FinishCoach.action).assertCountEquals(0)
        compose.onAllNodesWithText(FinishCoach.caption).assertCountEquals(0)
        assertEquals("the one ask was the opener", 1, server.calls.count { it == "ask" })
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
            compose.onNodeWithText("Well done.").fetchSemanticsNode().root,
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
            compose.onAllNodesWithText("Well done.").fetchSemanticsNodes().isEmpty()
        }
    }
}
