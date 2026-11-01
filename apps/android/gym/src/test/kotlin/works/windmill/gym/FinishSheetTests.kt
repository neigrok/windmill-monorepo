package works.windmill.gym

import android.os.Bundle
import android.os.Parcel
import android.os.Parcelable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import works.windmill.platform.net.WindmillJson

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.saveable.LocalSaveableStateRegistry
import androidx.compose.runtime.saveable.SaveableStateRegistry
import androidx.compose.ui.test.junit4.StateRestorationTester
import works.windmill.platform.Account
import works.windmill.platform.ShellActions
import works.windmill.platform.SignInAttempts
import works.windmill.platform.LocalShellActions
import works.windmill.platform.telemetry.LocalTelemetry
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.coach.Ask
import works.windmill.gym.coach.CoachDraft
import works.windmill.gym.coach.LocalCoach
import works.windmill.platform.storage.AtomicDocument
import java.io.File
import java.io.IOException
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.SessionDetail
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.ui.FinishCoach
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.signOut
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class FinishSheetTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private var showing by mutableStateOf(true)
    private var suppliedShell: ShellActions? = null
    private var presentedAccount by mutableStateOf<Account?>(null)
    private var roomTelemetry: Telemetry = Telemetry.None
    private var suppliedRegistry by mutableStateOf<SaveableStateRegistry?>(null)
    private var presentedStore by mutableStateOf<TrainingStore?>(null)

    private fun inRoom(server: FakeGymRest = FakeGymRest(), seat: String? = "u1", telemetry: Telemetry = Telemetry.None, localCoach: LocalCoach? = null, test: (EngineRoomFixture) -> Unit) {
        roomTelemetry = telemetry
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = server, telemetry = telemetry, localCoach = localCoach)
        try {
            room.store.observeEngine()
            runBlocking { room.select(seat) }
            test(room)
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }

    private fun show(room: EngineRoomFixture, restoration: StateRestorationTester? = null) {
        val shell = suppliedShell ?: ShellActions(openYou = {})
        val content: @Composable () -> Unit = {
            if (showing) CompositionLocalProvider(LocalShellActions provides shell, LocalTelemetry provides roomTelemetry,
                LocalSaveableStateRegistry provides (suppliedRegistry ?: LocalSaveableStateRegistry.current)) {
                GymMaterial { GymRoom(presentedAccount ?: room.account(), presentedStore ?: room.store) }
            }
        }
        if (restoration == null) compose.setContent(content) else restoration.setContent(content)
    }

    @Suppress("UNCHECKED_CAST", "DEPRECATION")
    private fun saveRoom(): Map<String, List<Any?>> {
        val bundle = Bundle()
        for ((key, values) in suppliedRegistry!!.performSave())
            bundle.putParcelableArrayList(key, ArrayList(values) as ArrayList<Parcelable>)
        val parcel = Parcel.obtain()
        try {
            parcel.writeBundle(bundle)
            parcel.setDataPosition(0)
            val restored = requireNotNull(parcel.readBundle(javaClass.classLoader))
            return restored.keySet().associateWith { restored.get(it) as List<Any?> }
        } finally { parcel.recycle() }
    }

    private fun restoreRoom(saved: Map<String, List<Any?>>) {
        compose.runOnIdle { showing = false }
        compose.mainClock.advanceTimeByFrame()
        compose.waitForIdle()
        compose.runOnIdle { suppliedRegistry = SaveableStateRegistry(saved) { true }; showing = true }
        if (compose.mainClock.autoAdvance) compose.waitForIdle()
    }

    private fun finishAWorkout(room: EngineRoomFixture, sets: Int = 1) {
        runBlocking {
            room.startExternalWorkout()
            room.store.choose("back-squat")
            repeat(sets) { room.store.logSet(100.0, 5) }
        }
        show(room)
        compose.waitForIdle()
        finish(if (sets == 0) "No sets logged" else if (sets < 4) "Ended early." else "Well done.")
    }

    private fun finish(title: String = "Ended early.") {
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasText("Finish") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Finish").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(title).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun shareReceipt() {
        compose.onNodeWithText(FinishCoach.action).performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText(FinishCoach.action).fetchSemanticsNodes().isEmpty() }
    }

    private fun startAWorkout(room: EngineRoomFixture) {
        val started = room.scope.async {
            room.startExternalWorkout()
            room.store.choose("back-squat")
            room.store.logSet(100.0, 5)
        }
        compose.waitUntil(10_000) { compose.runOnIdle { started.isCompleted } }
        runBlocking { started.await() }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Finish").fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun onTheReceipt(text: String): Int {
        val sheet = compose.onNodeWithText("Ended early.").fetchSemanticsNode().root
        return compose.onAllNodesWithText(text).fetchSemanticsNodes().count { it.root == sheet }
    }

    private fun askAQuestion() {
        compose.onNodeWithText("Coach").performClick()
        compose.onNodeWithContentDescription("Question").performTextInput("What’s stalled?")
        compose.onNodeWithContentDescription("Send").performClick()
    }

    @Test
    fun testTheReceiptStandsOverTheWorkoutItClosedAndSaysItsOwnTitle() {
        inRoom { room ->
            finishAWorkout(room)

            compose.onNodeWithText("Ended early.").assertIsDisplayed()
            compose.onNodeWithText(Readout.noRoutine).assertIsDisplayed()
            compose.onNodeWithText("The log").assertDoesNotExist()
        }
    }

    @Test
    fun finishWaitsForTheUnchangedAccountReadAndClosesExactlyOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val waiting = ConcurrentLinkedQueue<Runnable>()
        var holdReads = false
        val reads = object : CoroutineDispatcher() {
            override fun isDispatchNeeded(context: CoroutineContext) = holdReads
            override fun dispatch(context: CoroutineContext, block: Runnable) { waiting.add(block) }
        }
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val room = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, readDispatcher = reads)
        room.store.observeEngine()
        try {
            runBlocking {
                room.select(null)
                room.startExternalWorkout()
                room.store.choose("back-squat")
                room.store.logSet(100.0, 5)
            }
            val live = room.store.session!!
            val sets = room.store.sets.toList()
            val account = room.account()
            compose.setContent { if (showing) GymMaterial { GymRoom(account, room.store) } }
            compose.waitUntil(10_000) { compose.runOnIdle { room.store.canFinish } }
            compose.onNodeWithText("Finish").assertIsEnabled()
            val reconnect = compose.runOnIdle {
                holdReads = true
                room.scope.async { room.store.connect(account) }
            }
            compose.waitUntil(10_000) { compose.runOnIdle { waiting.isNotEmpty() } }
            compose.runOnIdle {
                assertEquals(live, room.store.session)
                assertEquals(false, room.store.canFinish)
            }
            val before = room.engine.snapshot()
            compose.onNodeWithText("Finish").assertIsNotEnabled().performClick()
            compose.runOnIdle {
                assertEquals(before, room.engine.snapshot())
                assertEquals(live, room.store.session)
                assertEquals(emptyList<Pair<String, Map<String, String>>>(), events.filter { it.first == "gym_session_finished" })
                assertEquals(emptyList<String>(), failures)
                holdReads = false
                while (true) (waiting.poll() ?: break).run()
            }
            compose.waitUntil(10_000) { compose.runOnIdle { reconnect.isCompleted } }
            runBlocking { reconnect.await() }
            compose.onNodeWithText("Finish").assertIsEnabled()
            finish()
            compose.runOnIdle {
                val closed = room.training.session(live.id)!!
                assertEquals(sets, closed.sets)
                assertTrue(closed.session.finishedAtMs != null)
                assertEquals(null, room.store.session)
                assertEquals(false, room.store.canFinish)
                assertEquals(listOf("gym_session_finished" to emptyMap<String, String>()), events.filter { it.first == "gym_session_finished" })
                assertEquals(emptyList<String>(), failures)
            }
            compose.onNodeWithText("Ended early.").assertIsDisplayed()
            compose.onAllNodesWithText("500 kg").onLast().assertIsDisplayed()
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            holdReads = false
            while (true) (waiting.poll() ?: break).run()
            room.close()
        }
    }

    @Test
    fun committedReceiptAndRowsAreVisibleOnceTheWorkoutCloses() {
        inRoom { room ->
            val store = room.store
            val live = runBlocking {
                val opened = room.startExternalWorkout()
                store.choose("back-squat")
                store.logSet(100.0, 5)
                store.logSet(110.0, 3)
                opened
            }
            val performed = store.sets.toList()
            show(room)
            compose.waitForIdle()
            finish()

            val closed = runBlocking { room.training.session(live.id) }!!
            compose.runOnIdle {
                assertEquals(null, store.session)
                assertEquals(false, store.isFinishing)
                assertEquals(performed, closed.sets)
                assertEquals(SessionDetail(closed.session, performed), store.retainedSession(SessionDetail(closed.session, emptyList())))
            }
            compose.onNodeWithText("Ended early.").assertIsDisplayed()
            compose.onAllNodesWithText("830 kg").onLast().assertIsDisplayed()
            compose.onNodeWithText("Routines").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(runBlocking { room.training.sessions(TrainingStore.logPage, null, null) }, store.allSessions)
                assertEquals(listOf(live.id), store.allSessions.map { it.id })
            }
            compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
            compose.onNodeWithContentDescription("Set 1, 100 kg total, 5 reps").assertIsDisplayed()
            compose.onNodeWithContentDescription("Set 2, 110 kg total, 3 reps").assertIsDisplayed()
            assertEquals(SessionDetail(closed.session, performed), store.retainedSession(SessionDetail(closed.session, emptyList())))
        }
    }

    @Test
    fun theReceiptHasDoneAndKeepsDiscardInOverflow() {
        inRoom { room ->
            finishAWorkout(room)

            compose.onAllNodesWithText("Done").assertCountEquals(1)
            compose.onAllNodesWithText("Just keep the session").assertCountEquals(0)
            compose.onAllNodesWithText("Keep it").assertCountEquals(0)
            assertEquals(0, onTheReceipt("Discard"))
            assertEquals(0, onTheReceipt("Share this workout"))
        }
    }

    @Test
    fun testShareWithCoachOpensAFreshConversationAndSendsTheOneLine() {
        val server = FakeGymRest()
        inRoom(server) { room ->
            show(room)
            compose.waitForIdle()

            askAQuestion()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("nothing has moved in three weeks.").fetchSemanticsNodes().isNotEmpty()
            }
            val answer = CompletableDeferred<Unit>()
            val entered = CompletableDeferred<Unit>()
            server.onAsk = { entered.complete(Unit); answer.await() }
            startAWorkout(room)
            finish()

            shareReceipt()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Ended early.").fetchSemanticsNodes().isEmpty()
            }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithContentDescription("Coach is thinking").fetchSemanticsNodes().isNotEmpty()
            }

            compose.onNodeWithText(FinishCoach.question).assertIsDisplayed()
            compose.onNodeWithContentDescription("Coach is thinking").assertIsDisplayed()
            compose.onAllNodesWithText("What’s stalled?").assertCountEquals(0)
            compose.onAllNodesWithText("nothing has moved in three weeks.").assertCountEquals(0)
            compose.waitUntil(10_000) { compose.runOnIdle { entered.isCompleted } }
            compose.runOnIdle {
                assertEquals(listOf("What’s stalled?", "Check my last workout."),
                             server.asked.map { it.question })
                assertTrue("a new conversation, not the one that stood",
                           server.asked[0].thread != server.asked[1].thread)
                assertTrue(server.asked[1].thread.isNotEmpty())
            }
            compose.onNodeWithText("The log").assertIsDisplayed()

            answer.complete(Unit)
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("nothing has moved in three weeks.").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onAllNodesWithText(FinishCoach.question).assertCountEquals(1)
        }
    }

    @Test
    fun testTwoTapsOnShareWithCoachAreOneAskAndTheFollowUpStaysInThatThread() {
        val server = FakeGymRest()
        val answer = CompletableDeferred<Unit>()
        server.onAsk = { answer.await() }
        inRoom(server) { room ->
            finishAWorkout(room)

            val tap = compose.onNodeWithText(FinishCoach.action)
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
                compose.onAllNodesWithText("Ended early.").fetchSemanticsNodes().isEmpty()
            }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithContentDescription("Coach is thinking").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onAllNodesWithText(FinishCoach.question).assertCountEquals(1)
            compose.waitUntil(10_000) { compose.runOnIdle { server.calls.count { it == "ask" } == 1 } }
            compose.runOnIdle { assertEquals("one tap, one ask", 1, server.calls.count { it == "ask" }) }

            answer.complete(Unit)
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("nothing has moved in three weeks.").fetchSemanticsNodes().isNotEmpty()
            }
            compose.waitUntil(10_000) { compose.runOnIdle {
                val id = room.store.coach.selectedChatId.orEmpty()
                !room.store.coach.isAsking(id) && room.store.coach.draft(id).text.isEmpty()
            } }
            compose.waitUntil(10_000) {
                compose.onAllNodes(hasContentDescription("Question") and isEnabled()).fetchSemanticsNodes().size == 1
            }
            compose.onNodeWithContentDescription("Question").performTextReplacement("And my squat?")
            compose.runOnIdle {
                val key = room.store.coach.selectedChatId!!
                assertEquals("the enabled field persisted the follow-up draft", "And my squat?", room.store.coach.draft(key).text)
                assertEquals(false, room.store.coach.isAsking(key))
            }
            compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
            compose.runOnIdle {
                val key = room.store.coach.selectedChatId!!
                assertEquals("Send admits the follow-up on the original chat", listOf(FinishCoach.question, "And my squat?"), room.store.coach.chat(key)!!.exchanges.map { it.question })
            }
            compose.waitUntil(10_000) { server.asked.size == 2 }
            compose.runOnIdle {
                assertEquals(listOf(FinishCoach.question, "And my squat?"), server.asked.map { it.question })
                assertEquals("the follow-up continues the conversation the tap opened",
                             server.asked[0].thread, server.asked[1].thread)
            }
        }
    }

    @Test
    fun shareStartsItsOwnChatWhileThePreviousChatKeepsWorking() {
        val server = FakeGymRest()
        val answer = CompletableDeferred<Unit>()
        server.onAsk = { answer.await() }
        inRoom(server) { room ->
            show(room)
            compose.waitForIdle()

            askAQuestion()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithContentDescription("Coach is thinking").fetchSemanticsNodes().isNotEmpty()
            }
            startAWorkout(room)
            finish()

            shareReceipt()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Ended early.").fetchSemanticsNodes().isEmpty()
            }
            compose.onNodeWithContentDescription("Coach is thinking").assertIsDisplayed()
            compose.onAllNodesWithText("What’s stalled?").assertCountEquals(0)
            compose.onAllNodesWithText(FinishCoach.question).assertCountEquals(1)
            compose.runOnIdle {
                assertEquals(listOf("What’s stalled?", FinishCoach.question), server.asked.map { it.question })
                assertTrue(server.asked[0].thread != server.asked[1].thread)
            }

            answer.complete(Unit)
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("nothing has moved in three weeks.").fetchSemanticsNodes().isNotEmpty()
            }
        }
    }

    @Test
    fun signedOutTheReceiptOffersShareThroughSignIn() {
        val server = FakeGymRest()
        inRoom(server, seat = null) { room ->
            show(room)
            compose.waitForIdle()
            startAWorkout(room)
            finish(title = "Ended early.")

            compose.onAllNodesWithText(FinishCoach.action).assertCountEquals(1)
            compose.onNodeWithText("Only on this phone · Keep it").assertIsDisplayed()
            assertEquals("nothing was asked", 0, server.calls.count { it == "ask" })
        }
    }

    @Test
    fun testWithoutCoachOnThisDeploymentTheReceiptOffersNoShareWithCoach() {
        val server = FakeGymRest()
        server.refuseAsk = WindmillApiException.Refused(404, Refusal(message = "not found", code = "not-found"))
        inRoom(server) { room ->
            show(room)
            compose.waitForIdle()

            askAQuestion()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(Ask.notHere).fetchSemanticsNodes().isNotEmpty()
            }
            startAWorkout(room)
            finish()

            compose.onAllNodesWithText(FinishCoach.action).assertCountEquals(0)
            assertEquals("the one ask was the opener", 1, server.calls.count { it == "ask" })
        }
    }

    @Test
    fun aFinishedExternalWorkoutHasNoRoutineSaveAction() {
        inRoom { room ->
            finishAWorkout(room, sets = 4)

            compose.onNodeWithText("Well done.").assertIsDisplayed()
            compose.onNodeWithText("Save a routine").assertDoesNotExist()
            compose.onNodeWithText("Save routine").assertDoesNotExist()
            compose.onNodeWithContentDescription("Routine name").assertDoesNotExist()
            compose.runOnIdle { assertEquals(emptyList<Routine>(), room.training.program()) }
        }
    }
    @Test
    fun overflowCancelPreservesTheReceiptAndConfirmationDiscardsImmediatelyOnce() {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { error("Unexpected $operation") }
        }
        inRoom(telemetry = telemetry) { room ->
            finishAWorkout(room)
            val id = room.store.recent.single().id
            val before = room.engine.snapshot()
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Discard").performClick()
            compose.onNodeWithText("Discard this workout?").assertIsDisplayed()
            compose.onNodeWithText("This deletes the workout and its 1 set. You can’t undo this.").assertIsDisplayed()
            compose.onNodeWithText("Cancel").performClick()
            compose.runOnIdle { assertEquals(before, room.engine.snapshot()) }
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Discard").performClick()
            val tap = compose.onNodeWithText("Discard").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
            compose.runOnIdle { tap(); tap() }
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Discard this workout?").fetchSemanticsNodes().isEmpty() }
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Ended early.").fetchSemanticsNodes().isEmpty() }
            compose.runOnIdle {
                assertEquals(null, runBlocking { room.training.session(id) })
                assertEquals(emptyList<works.windmill.gym.store.Withheld>(), room.store.withheld)
                assertEquals(listOf(
                    mapOf("screen" to "finish", "action" to "discard", "state" to "shown"),
                    mapOf("screen" to "finish", "action" to "discard", "outcome" to "cancelled"),
                    mapOf("screen" to "finish", "action" to "discard", "state" to "shown"),
                    mapOf("screen" to "finish", "action" to "discard", "outcome" to "ok"),
                ), events.filter { it.first == "gym_action" && it.second["action"] == "discard" }.map { it.second })
            }
            compose.onAllNodesWithText("The log").onLast().assertIsDisplayed()
            compose.onNodeWithText("Undo").assertDoesNotExist()
        }
    }

    @Test
    fun emptyFinishHasNoSavedClaimAndDoneReturnsToRoutines() {
        inRoom { room ->
            finishAWorkout(room, sets = 0)
            compose.onNodeWithText("No sets logged").assertIsDisplayed()
            compose.onNodeWithText(FinishCoach.action).assertDoesNotExist()
            compose.onNodeWithText("Sets").assertDoesNotExist()
            compose.onNodeWithText("Volume").assertDoesNotExist()
            compose.onNodeWithText("0 kg").assertDoesNotExist()
            compose.onNodeWithText("Share this workout").assertDoesNotExist()
            compose.onNodeWithText("Discard").assertDoesNotExist()
            compose.onNodeWithText("Done").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("No sets logged").fetchSemanticsNodes().isEmpty() }
            compose.onAllNodesWithText("Routines").onLast().assertIsDisplayed()
        }
    }

    @Test
    fun signedOutShareRetainsItsRequestAcrossRecreationAndWaitsForTheAccountDecision() {
        val server = FakeGymRest()
        val attempts = SignInAttempts()
        val opened = mutableListOf<String>()
        suppliedShell = ShellActions(openYou = {}, openSignInForResult = { id -> opened += id; attempts.begin(id) }, signInAttempts = attempts)
        inRoom(server, seat = null) { room ->
            runBlocking { room.startExternalWorkout(); room.store.choose("back-squat"); room.store.logSet(100.0, 5) }
            val restoration = StateRestorationTester(compose)
            show(room, restoration)
            finish()
            shareReceipt()
            compose.waitUntil(10_000) { opened.size == 1 }
            val request = opened.single()
            restoration.emulateSavedInstanceStateRestore()
            compose.runOnIdle {
                attempts.complete("u1")
                presentedAccount = Account("https://windmill.works", works.windmill.platform.User("u1", "u1@example.com"), resolved = false)
            }
            compose.runOnIdle { assertEquals(emptyList<works.windmill.gym.coach.AskQuestion>(), server.asked) }
            runBlocking { room.select("u1") }
            compose.runOnIdle { presentedAccount = room.account() }
            compose.waitUntil(10_000) { compose.runOnIdle { server.asked.isNotEmpty() } }
            compose.runOnIdle {
                assertEquals(listOf(FinishCoach.question), server.asked.map { it.question })
                assertEquals(request, server.asked.single().requestId)
                assertEquals(null, attempts.result)
            }
            restoration.emulateSavedInstanceStateRestore()
            compose.waitForIdle()
            compose.runOnIdle { assertEquals(1, server.asked.size) }
        }
    }

    @Test
    fun cancellingShareSignInDoesNotSendOnAnUnrelatedLaterSignIn() {
        val server = FakeGymRest()
        val attempts = SignInAttempts()
        val opened = mutableListOf<String>()
        suppliedShell = ShellActions(openYou = {}, openSignInForResult = { id -> opened += id; attempts.begin(id) }, signInAttempts = attempts)
        inRoom(server, seat = null) { room ->
            finishAWorkout(room)
            shareReceipt()
            compose.waitUntil(10_000) { opened.size == 1 }
            compose.runOnIdle { attempts.cancel() }
            compose.waitForIdle()
            runBlocking { room.select("u1") }
            compose.runOnIdle { presentedAccount = room.account() }
            compose.waitForIdle()
            compose.runOnIdle { assertEquals(emptyList<works.windmill.gym.coach.AskQuestion>(), server.asked); assertEquals(null, attempts.result) }
        }
    }

    @Test
    fun keepOpensOrdinarySignInWithoutQueuingAQuestionAndTheNextReceiptHasNoOffer() {
        val server = FakeGymRest()
        var ordinary = 0
        val tracked = mutableListOf<String>()
        suppliedShell = ShellActions(openYou = {}, openSignIn = { ordinary++ }, openSignInForResult = { tracked += it })
        inRoom(server, seat = null) { room ->
            finishAWorkout(room)
            compose.onNodeWithText("Only on this phone · Keep it").performScrollTo().performClick()
            compose.waitUntil(10_000) { ordinary == 1 }
            compose.runOnIdle { assertEquals(emptyList<String>(), tracked); assertEquals(emptyList<works.windmill.gym.coach.AskQuestion>(), server.asked) }
            compose.onNodeWithContentDescription("Back to Routines").performClick()
            startAWorkout(room)
            finish()
            compose.onNodeWithText("Only on this phone · Keep it").assertDoesNotExist()
            compose.onNodeWithText("Done").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Ended early.").fetchSemanticsNodes().isEmpty() }
            runBlocking { room.select("u1") }
            compose.runOnIdle { presentedAccount = room.account() }
            compose.waitForIdle()
            compose.runOnIdle { assertEquals(emptyList<works.windmill.gym.coach.AskQuestion>(), server.asked) }
        }
    }

    @Test
    fun aFastFailedConfirmationIgnoresItsOldCallbackAndAllowsANewExplicitRetry() {
        val outcomes = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action" && properties["action"] == "discard") properties["outcome"]?.let(outcomes::add)
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { assertEquals("gym.discard", operation) }
        }
        inRoom(telemetry = telemetry) { room ->
            finishAWorkout(room)
            val id = room.store.recent.single().id
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Discard").performClick()
            val old = compose.onNodeWithText("Discard").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
            compose.runOnIdle { room.engine.failNextCommit(); old(); old() }
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Ended early.").fetchSemanticsNodes().isEmpty() }
            compose.runOnIdle {
                assertEquals(listOf("failed"), outcomes)
                assertTrue(runBlocking { room.training.session(id) } != null)
                old()
                assertEquals(listOf("failed"), outcomes)
            }
            compose.onNodeWithText("Discard this workout?").assertDoesNotExist()
            compose.onNodeWithText("This workout couldn’t be deleted on this phone. It is still saved.").assertIsDisplayed()
            compose.onNodeWithText("Discard workout").performScrollTo().performClick()
            compose.onNodeWithText("Discard").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { outcomes.size == 2 } }
            compose.runOnIdle {
                assertEquals(listOf("failed", "ok"), outcomes)
                assertEquals(null, runBlocking { room.training.session(id) })
            }
        }
    }

    @Test
    fun aCompletedSignInForAWaitingAccountCannotShareIntoAnotherAccount() {
        val server = FakeGymRest()
        val attempts = SignInAttempts()
        val opened = mutableListOf<String>()
        suppliedShell = ShellActions(openYou = {}, openSignInForResult = { id -> opened += id; attempts.begin(id) }, signInAttempts = attempts)
        inRoom(server, seat = null) { room ->
            finishAWorkout(room)
            shareReceipt()
            compose.waitUntil(10_000) { opened.isNotEmpty() }
            compose.runOnIdle {
                attempts.complete("alice")
                presentedAccount = Account("https://windmill.works", works.windmill.platform.User("alice", "a@example.com"), resolved = false)
            }
            runBlocking { room.select("bob") }
            compose.runOnIdle { presentedAccount = room.account() }
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(emptyList<works.windmill.gym.coach.AskQuestion>(), server.asked)
                assertEquals(null, attempts.result)
                assertEquals(null, room.store.coach.selectedChatId)
            }
        }
    }

    @Test
    fun ordinarySignInReplacesAnAlreadyCompletedShareAttemptBeforeAccountReadiness() {
        val server = FakeGymRest()
        val attempts = SignInAttempts()
        val opened = mutableListOf<String>()
        suppliedShell = ShellActions(openYou = {}, openSignIn = { attempts.cancel() },
            openSignInForResult = { id -> opened += id; attempts.begin(id) }, signInAttempts = attempts)
        inRoom(server, seat = null) { room ->
            finishAWorkout(room)
            shareReceipt()
            compose.waitUntil(10_000) { opened.isNotEmpty() }
            compose.runOnIdle {
                attempts.complete("alice")
                presentedAccount = Account("https://windmill.works", works.windmill.platform.User("alice", "a@example.com"), resolved = false)
                suppliedShell!!.openSignIn()
            }
            runBlocking { room.select("alice") }
            compose.runOnIdle { presentedAccount = room.account() }
            compose.waitForIdle()
            compose.runOnIdle { assertEquals(emptyList<works.windmill.gym.coach.AskQuestion>(), server.asked); assertEquals(null, attempts.result) }
        }
    }

    @Test
    fun aConfirmationFromBeforeSameAccountReplicaRestorationCannotDeleteTheNewReplica() {
        val events = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action" && properties["action"] == "discard" && properties["outcome"] != null) events += properties
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { error("Unexpected $operation") }
        }
        inRoom(telemetry = telemetry) { room ->
            finishAWorkout(room)
            val id = room.store.recent.single().id
            val server = EngineRoomFixture.server()
            runBlocking { room.sync(server) }
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Discard").performClick()
            val opening = room.store.workoutReplica
            compose.runOnIdle {
                runBlocking {
                    room.store.prepareEngineTransition()
                    assertTrue(room.engine.signOut("discard").member("complete").bool())
                    room.selected = null
                    room.select("u1"); room.pull(server); room.store.refreshEngine()
                }
                assertTrue(opening != room.store.workoutReplica)
            }
            compose.onNodeWithText("Discard").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { events.isNotEmpty() } }
            compose.runOnIdle {
                assertEquals(listOf(mapOf("screen" to "finish", "action" to "discard", "outcome" to "refused")), events)
                assertTrue(runBlocking { room.training.session(id) } != null)
            }
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Ended early.").fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithText("The account changed. Open this again.").assertIsDisplayed()
            compose.onNodeWithText("Discard workout").performScrollTo().performClick()
            compose.onNodeWithText("Discard").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { events.size == 2 } }
            compose.runOnIdle {
                assertEquals("ok", events.last()["outcome"])
                assertEquals(null, runBlocking { room.training.session(id) })
            }
        }
    }

    @Test
    fun recreationAfterAcceptedDiscardDoesNotRestoreTheDeletedReceipt() {
        inRoom { room ->
            runBlocking { room.startExternalWorkout(); room.store.choose("back-squat"); room.store.logSet(100.0, 5) }
            val restoration = StateRestorationTester(compose)
            show(room, restoration)
            finish()
            val id = room.store.recent.single().id
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Discard").performClick()
            compose.onNodeWithText("Discard this workout?").assertIsDisplayed()
            val confirm = compose.onNodeWithText("Discard").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
            compose.mainClock.autoAdvance = false
            compose.runOnIdle { confirm() }
            compose.waitUntil(10_000) { compose.mainClock.advanceTimeByFrame(); compose.runOnIdle { runBlocking { room.training.session(id) } == null } }
            restoration.emulateSavedInstanceStateRestore()
            compose.mainClock.autoAdvance = true
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Ended early.").fetchSemanticsNodes().isEmpty() }
            compose.onAllNodesWithText("The log").onLast().assertIsDisplayed()
            compose.onNodeWithText("Discard this workout?").assertDoesNotExist()
        }
    }

    @Test
    fun anOlderSavedReceiptCannotRestoreADeletedWorkoutOrItsDetail() {
        inRoom(seat = null) { room ->
            suppliedRegistry = SaveableStateRegistry(null) { true }
            finishAWorkout(room)
            val id = room.store.recent.single().id
            val beforeDiscard = compose.runOnIdle { saveRoom() }
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Discard").performClick()
            compose.onNodeWithText("Discard").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { runBlocking { room.training.session(id) } == null } }
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            EngineRoomFixture(tmp.newFolder(), room.scope, snapshot = room.engine.snapshot()).use { cold ->
                cold.store.observeEngine()
                runBlocking { cold.select(null) }
                compose.runOnIdle { presentedStore = cold.store }
                restoreRoom(beforeDiscard)
                compose.waitUntil(10_000) { compose.onAllNodesWithText("No workouts yet").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("No workouts yet").assertIsDisplayed()
                compose.onNodeWithText("Ended early.").assertDoesNotExist()
                compose.onNodeWithContentDescription("Back to Routines").assertDoesNotExist()
                compose.onNodeWithContentDescription("Question").assertDoesNotExist()
                compose.onNodeWithText("Routines").assertIsDisplayed()
                compose.onNodeWithText("Coach").assertIsDisplayed()
                compose.runOnIdle { showing = false }
                compose.waitForIdle()
            }
        }
    }

    @Test
    fun aRestoredReceiptWaitsForAnUnreadReplicaThenReconcilesItsFirstPull() {
        inRoom { room ->
            suppliedRegistry = SaveableStateRegistry(null) { true }
            finishAWorkout(room)
            val beforeRestart = compose.runOnIdle { saveRoom() }
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            EngineRoomFixture(tmp.newFolder(), room.scope).use { cold ->
                cold.store.observeEngine()
                runBlocking { cold.select("u1") }
                compose.runOnIdle { presentedStore = cold.store }
                restoreRoom(beforeRestart)
                compose.onNodeWithText("Ended early.").assertIsDisplayed()
                compose.runOnIdle { assertFalse(cold.training.firstPullComplete) }
                runBlocking { cold.pull(EngineRoomFixture.server()); cold.store.refreshEngine() }
                compose.waitUntil(10_000) { compose.onAllNodesWithText("No workouts yet").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("No workouts yet").assertIsDisplayed()
                compose.onNodeWithText("Ended early.").assertDoesNotExist()
                compose.onNodeWithContentDescription("Back to Routines").assertDoesNotExist()
                compose.onNodeWithText("Routines").assertIsDisplayed()
                compose.onNodeWithText("Coach").assertIsDisplayed()
                compose.runOnIdle { showing = false }
                compose.waitForIdle()
            }
        }
    }

    @Test
    fun recreatingDuringTheShareExitContinuesItsOneExplicitSignInAndQuestion() {
        val server = FakeGymRest()
        val attempts = SignInAttempts()
        val opened = mutableListOf<String>()
        suppliedShell = ShellActions(openYou = {}, openSignInForResult = { id -> opened += id; attempts.begin(id) }, signInAttempts = attempts)
        inRoom(server, seat = null) { room ->
            runBlocking { room.startExternalWorkout(); room.store.choose("back-squat"); room.store.logSet(100.0, 5) }
            suppliedRegistry = SaveableStateRegistry(null) { true }
            show(room)
            finish()
            val share = compose.onNodeWithText(FinishCoach.action).fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
            compose.mainClock.autoAdvance = false
            compose.runOnIdle { share(); assertEquals(emptyList<String>(), opened) }
            val duringExit = compose.runOnIdle { saveRoom() }
            compose.runOnIdle { showing = false }
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(emptyList<String>(), opened)
                suppliedRegistry = SaveableStateRegistry(duringExit) { true }
                showing = true
            }
            compose.mainClock.autoAdvance = true
            compose.waitUntil(10_000) { opened.isNotEmpty() }
            val request = opened.single()
            runBlocking { room.select("u1") }
            compose.runOnIdle { attempts.complete("u1"); presentedAccount = room.account() }
            compose.waitUntil(10_000) { compose.runOnIdle { server.asked.isNotEmpty() } }
            compose.runOnIdle {
                assertEquals(listOf(request), opened)
                assertEquals(listOf(FinishCoach.question), server.asked.map { it.question })
                assertEquals(request, server.asked.single().requestId)
            }
            val afterShare = compose.runOnIdle { saveRoom() }
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            compose.runOnIdle { suppliedRegistry = SaveableStateRegistry(afterShare) { true }; showing = true }
            compose.waitForIdle()
            compose.runOnIdle { assertEquals(1, server.asked.size); assertEquals(listOf(request), opened) }
        }
    }

    @Test
    fun anOldQueuedShareReopensItsCompletedChatWithoutAnotherQuestionOrFreshEntry() {
        val server = FakeGymRest()
        val steps = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action") properties["action"]?.let(steps::add)
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { error("Unexpected $operation") }
        }
        val disk = LocalCoach(File(tmp.root, "completed-share"))
        inRoom(server, telemetry = telemetry, localCoach = disk) { room ->
            suppliedRegistry = SaveableStateRegistry(null) { true }
            finishAWorkout(room)
            val share = compose.onNodeWithText(FinishCoach.action).fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
            compose.mainClock.autoAdvance = false
            compose.runOnIdle { share() }
            val queued = compose.runOnIdle { saveRoom() }
            compose.mainClock.autoAdvance = true
            compose.waitUntil(10_000) { compose.runOnIdle { server.asked.size == 1 && !room.store.coach.isAsking(server.asked.single().thread) } }
            val request = server.asked.single().requestId!!
            val original = disk.chats("u1").single { it.id == request }
            val other = compose.runOnIdle { room.store.coach.freshChat("Another draft") }
            val before = steps.toList()
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            val restored = room.freshStore().also { it.observeEngine() }
            runBlocking { restored.connect(room.account()) }
            compose.runOnIdle { presentedStore = restored }
            restoreRoom(queued)
            compose.waitUntil(10_000) { compose.runOnIdle { restored.coach.selectedChatId == request } }
            compose.runOnIdle {
                assertEquals(listOf(request), server.asked.map { it.requestId })
                assertEquals(request, server.asked.single().thread)
                assertEquals(original, restored.coach.chat(request))
                assertEquals(CoachDraft("Another draft"), restored.coach.draft(other))
                assertEquals(before, steps)
                assertEquals(2, restored.coach.allThreads.size)
                assertEquals(emptyList<works.windmill.gym.coach.AskQuestion>(), disk.pending("u1"))
            }
        }
    }

    @Test
    fun anOldQueuedShareDoesNotResubmitOrCancelItsPendingQuestion() {
        val server = FakeGymRest()
        val answer = CompletableDeferred<Unit>()
        server.onAsk = { answer.await() }
        val disk = LocalCoach(File(tmp.root, "pending-share"))
        inRoom(server, localCoach = disk) { room ->
            suppliedRegistry = SaveableStateRegistry(null) { true }
            finishAWorkout(room)
            val share = compose.onNodeWithText(FinishCoach.action).fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
            compose.mainClock.autoAdvance = false
            compose.runOnIdle { share() }
            val queued = compose.runOnIdle { saveRoom() }
            compose.mainClock.autoAdvance = true
            compose.waitUntil(10_000) { compose.runOnIdle { server.asked.size == 1 } }
            val request = server.asked.single().requestId!!
            val other = compose.runOnIdle { room.store.coach.freshChat("Keep typing") }
            restoreRoom(queued)
            compose.waitUntil(10_000) { compose.runOnIdle { room.store.coach.selectedChatId == request } }
            compose.runOnIdle {
                assertEquals(listOf(request), server.asked.map { it.requestId })
                assertTrue(room.store.coach.isAsking(request))
                assertEquals(listOf(request), disk.pending("u1").map { it.requestId })
                assertEquals(CoachDraft("Keep typing"), room.store.coach.draft(other))
                assertEquals(listOf(request), room.store.coach.chat(request)!!.exchanges.map { it.requestId })
            }
            answer.complete(Unit)
            compose.waitUntil(10_000) { compose.runOnIdle { !room.store.coach.isAsking(request) } }
            compose.runOnIdle {
                assertEquals(1, server.asked.size)
                assertEquals("nothing has moved in three weeks.", room.store.coach.chat(request)!!.exchanges.single().answer?.answer)
                assertEquals(request, room.store.coach.selectedChatId)
            }
        }
    }

    @Test
    fun aShareWhoseDraftWriteFailedBeforeAdmissionRecoversTheSameIdentityFromSavedState() {
        var failedDraftId: String? = null
        val disk = LocalCoach(File(tmp.root, "share-failure")) { file, text ->
            val document = WindmillJson.parseToJsonElement(text) as JsonObject
            val drafts = (document["drafts"] as? JsonObject)?.get("u1") as? JsonObject
            val shareDraft = drafts?.entries?.singleOrNull {
                ((it.value as? JsonObject)?.get("text") as? JsonPrimitive)?.content == FinishCoach.question
            }
            if (failedDraftId == null && shareDraft != null) {
                failedDraftId = shareDraft.key
                throw IOException("fixture-local-write-failed")
            }
            AtomicDocument.write(file, text)
        }
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val server = FakeGymRest()
        inRoom(server, telemetry = telemetry, localCoach = disk) { room ->
            suppliedRegistry = SaveableStateRegistry(null) { true }
            finishAWorkout(room)
            val share = compose.onNodeWithText(FinishCoach.action).fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
            compose.mainClock.autoAdvance = false
            compose.runOnIdle { share() }
            val queued = compose.runOnIdle { saveRoom() }
            compose.mainClock.autoAdvance = true
            compose.waitUntil(10_000) { compose.runOnIdle { failures.isNotEmpty() } }
            val request = room.store.coach.selectedChatId!!
            compose.runOnIdle {
                assertEquals(request, failedDraftId)
                assertEquals(listOf("gym.saveDraft"), failures)
                assertEquals(emptyList<works.windmill.gym.coach.AskQuestion>(), server.asked)
                assertEquals(listOf(request), disk.chats("u1").map { it.id })
            }
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            val restored = room.freshStore().also { it.observeEngine() }
            runBlocking { restored.connect(room.account()) }
            compose.runOnIdle { presentedStore = restored }
            restoreRoom(queued)
            compose.waitUntil(10_000) { compose.runOnIdle { server.asked.size == 1 } }
            compose.runOnIdle {
                assertEquals(request, server.asked.single().thread)
                assertEquals(request, server.asked.single().requestId)
                assertEquals(listOf(request), disk.chats("u1").map { it.id })
                assertEquals(listOf(request), restored.coach.chat(request)!!.exchanges.map { it.requestId })
            }
        }
    }

    @Test
    fun anOldQueuedShareNeverOpensOrSubmitsInTheReplacementOwner() {
        val server = FakeGymRest()
        inRoom(server) { room ->
            suppliedRegistry = SaveableStateRegistry(null) { true }
            finishAWorkout(room)
            val share = compose.onNodeWithText(FinishCoach.action).fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
            compose.mainClock.autoAdvance = false
            compose.runOnIdle { share() }
            val queued = compose.runOnIdle { saveRoom() }
            compose.runOnIdle { showing = false }
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            runBlocking { room.select("bob") }
            compose.runOnIdle {
                presentedAccount = room.account()
                suppliedRegistry = SaveableStateRegistry(queued) { true }
                showing = true
            }
            compose.mainClock.autoAdvance = true
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(emptyList<works.windmill.gym.coach.AskQuestion>(), server.asked)
                assertEquals(null, room.store.coach.selectedChatId)
                assertEquals(emptyList<works.windmill.gym.coach.AskThread>(), room.store.coach.allThreads)
            }
            compose.onNodeWithText("Ended early.").assertDoesNotExist()
        }
    }

}
