package works.windmill.gym

import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast

import androidx.activity.ComponentDialog
import org.robolectric.shadows.ShadowDialog
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineDispatcher
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.SessionStart
import works.windmill.gym.presentation.SetWrite
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.ui.GymMaterial
import works.windmill.gym.presentation.NumberEntry
import works.windmill.platform.Account
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class WorkoutRecoveryTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    // The log draws only what the wall clock has reached, so these workouts happen in its past.
    private val past = 1_700_000_000_000L

    private fun awaitText(text: String) {
        compose.waitUntil(10_000) { compose.onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty() }
    }

    // A workout's set row says itself once, so it is found by what TalkBack hears.
    private fun awaitRow(spoken: String) {
        compose.waitUntil(10_000) { compose.onAllNodes(hasContentDescription(spoken, substring = true)).fetchSemanticsNodes().isNotEmpty() }
    }

    // A finished workout off the routine `name`, one set of it, on this phone's own log.
    private fun pastWorkout(room: EngineRoomFixture, name: String, weightKg: Double, reps: Int) {
        runBlocking {
            val routine = (room.store.routines.saveRoutine(RoutineDraft(name = name).adding("bench-press")) as GymResult.Ok).value
            room.store.workout.start(routine.id)
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg, reps)
            room.now += 60_000
            room.store.workout.finish()
        }
    }

    // As the application does it: the store on screen drains before the engine changes accounts.
    private fun switchAccount(room: EngineRoomFixture, store: TrainingStore, id: String?) {
        runBlocking { store.prepareEngineTransition() }
        if (room.selected != null) assertTrue(room.engine.signOut("keep").member("complete").bool())
        if (id != null) assertTrue(room.engine.signIn(id, mapOf("gym" to true)).member("complete").bool())
        room.selected = id
    }

    @Test
    fun historicalDetailAndInvalidFixDraftReturnAutomaticallyWithAFreshStoreOffline() {
        val firstScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), firstScope).apply { now = past }
        val account = room.account("u1")
        runBlocking { room.select("u1") }
        pastWorkout(room, "Push A", 40.0, 8)
        val historical = runBlocking { room.training.details() }.single().sets.single()
        var showing by mutableStateOf(true)
        val restored = StateRestorationTester(compose)
        var instances = 0
        restored.setContent {
            if (showing) {
                val scope = remember { if (instances == 0) firstScope else CoroutineScope(SupervisorJob() + Dispatchers.Main) }
                val held = remember { if (instances++ == 0) room.store else room.freshStore(scope) }
                DisposableEffect(scope) { onDispose { scope.cancel() } }
                GymMaterial { GymRoom(account, held) }
            }
        }
        try {
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            awaitText("Push A")
            compose.onNodeWithText("Push A").performClick()
            awaitRow("Set 1, 40 kg total, 8 reps")
            compose.onNode(hasContentDescription("Set 1, 40 kg total, 8 reps", substring = true)).performClick()
            compose.onNodeWithText("Bench Press · Set 1").assertIsDisplayed()
            compose.onNodeWithText("Set note").performTextInput("controlled tempo")
            compose.onNodeWithContentDescription("Load, kg total").performClick().performTextReplacement("1e999")
            compose.onNodeWithContentDescription("Load, kg total").performImeAction()
            restored.emulateSavedInstanceStateRestore()
            awaitText("1e999")
            compose.onNodeWithText("1e999").assertIsDisplayed()
            compose.onNodeWithText(NumberEntry.notANumber).assertIsDisplayed()
            compose.runOnIdle { assertEquals(40.0, historical.weightKg, 0.0) }
            compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
            compose.onNodeWithText("controlled tempo").assertIsDisplayed()
            compose.onNodeWithText("Bench Press · Set 1").assertIsDisplayed()
            for (dismissal in listOf("scrim", "drag")) {
                compose.onNodeWithContentDescription("Load, kg total").performClick().performTextReplacement("1e999")
                if (dismissal == "scrim") {
                    compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
                } else {
                    compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performTouchInput {
                        swipe(center, center + Offset(0f, 1_200f), durationMillis = 500)
                    }
                }
                compose.onNodeWithText("controlled tempo").assertIsDisplayed()
                compose.onNodeWithText("40").assertIsDisplayed()
            }
            compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
            compose.onNodeWithText("Fix set").assertDoesNotExist()
            compose.onNode(hasContentDescription("Set 1, 40 kg total, 8 reps", substring = true)).assertIsDisplayed()
            assertEquals(2, instances)
            assertEquals("nothing was corrected", listOf(historical), runBlocking { room.training.details() }.single().sets)
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            room.close()
        }
    }

    @Test
    fun liveFixDraftSurvivesTheTemporaryEmptyWorkoutDuringActivityReconnect() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val waiting = ConcurrentLinkedQueue<Runnable>()
        var holdReads = false
        val reads = object : CoroutineDispatcher() {
            override fun isDispatchNeeded(context: CoroutineContext): Boolean = holdReads
            override fun dispatch(context: CoroutineContext, block: Runnable) { waiting.add(block) }
        }
        val room = EngineRoomFixture(tmp.newFolder(), scope, readDispatcher = reads).apply { now = past }
        var showing by mutableStateOf(true)
        val restored = StateRestorationTester(compose)
        try {
            runBlocking {
                room.select(null)
                room.startExternalWorkout()
                room.store.workout.choose("bench-press")
                room.store.workout.logSet(60.0, 5)
            }
            val live = room.store.workout.session!!
            val original = room.store.workout.sets.single()
            val load = hasContentDescription("Load, kg total") and hasAnyAncestor(isDialog())
            holdReads = true
            restored.setContent {
                if (showing) {
                    val account = remember { room.account() }
                    GymMaterial { GymRoom(account, room.store) }
                }
            }
            compose.waitUntil(10_000) { waiting.isNotEmpty() }
            compose.runOnIdle {
                assertFalse(room.store.workout.canFinish)
                assertEquals(null, room.store.workout.session)
                holdReads = false
                while (true) (waiting.poll() ?: break).run()
            }
            compose.waitUntil(10_000) { compose.runOnIdle { room.store.workout.canFinish } }
            compose.waitUntil(10_000) { compose.onAllNodes(hasContentDescription("Set 1, logged, 60 kg total, 5 reps, on this device")).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("Set 1, logged, 60 kg total, 5 reps, on this device").performClick()
            compose.onNodeWithText("Set note").performTextInput("controlled tempo")
            compose.onNode(load).performClick().performTextReplacement("1e999")
            compose.onNode(load).performImeAction()
            compose.onNodeWithText(NumberEntry.notANumber).assertExists()
            compose.runOnIdle { holdReads = true }
            restored.emulateSavedInstanceStateRestore()
            compose.waitUntil(10_000) { waiting.isNotEmpty() }
            compose.runOnIdle { assertEquals(null, room.store.workout.session) }
            compose.onNodeWithText("Fix set").assertDoesNotExist()
            compose.runOnIdle {
                holdReads = false
                while (true) (waiting.poll() ?: break).run()
            }
            awaitText("Fix set")
            compose.onNodeWithText("1e999").assertIsDisplayed()
            compose.onNodeWithText(NumberEntry.notANumber).assertIsDisplayed()
            compose.onNodeWithText("controlled tempo").assertExists()
            compose.runOnIdle { assertEquals(listOf(original), room.training.session(live.id)!!.sets) }
            compose.onNode(load).performClick().performTextReplacement("61")
            compose.onNodeWithText("Save fix").performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("Fix set")).fetchSemanticsNodes().isEmpty() }
            compose.runOnIdle {
                assertEquals(listOf(original.copy(weightKg = 61.0, note = "controlled tempo")), room.training.session(live.id)!!.sets)
            }
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
    fun finishReceiptAndDismissedReadbackKeepTheSettledRows() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        val account = room.account("u1")
        val live = runBlocking {
            room.select("u1")
            val opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press"); room.store.workout.logSet(60.0, 8)
            opened
        }
        var showing by mutableStateOf(true)
        val restored = StateRestorationTester(compose)
        restored.setContent { if (showing) GymMaterial { GymRoom(account, room.store) } }
        try {
            compose.waitUntil(10_000) {
                compose.onAllNodes(hasText("Finish") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("Finish").performClick()
            awaitText("Ended early.")
            compose.onNodeWithText("Ended early.").assertIsDisplayed()
            compose.onAllNodesWithText("480 kg").onLast().assertIsDisplayed()
            compose.onNodeWithText("1 × 8 · 60 kg total").assertIsDisplayed()
            restored.emulateSavedInstanceStateRestore()
            awaitText("480 kg")
            compose.onAllNodesWithText("480 kg").onLast().assertIsDisplayed()
            compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
            awaitRow("Set 1, 60 kg total, 8 reps")
            compose.onNodeWithText("480 kg").assertIsDisplayed()
            compose.onNode(hasContentDescription("Set 1, 60 kg total, 8 reps", substring = true)).assertIsDisplayed()
            compose.onNode(hasContentDescription("Set 1, 60 kg total, 8 reps", substring = true)).performClick()
            compose.onNodeWithText("Bench Press · Set 1").assertIsDisplayed()
            val closed = runBlocking { room.training.session(live.id) }!!
            assertEquals(listOf(60.0 to 8), closed.sets.map { it.weightKg to it.reps })
            assertFalse(closed.session.isOpen)
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }

    @Test
    fun anEngineReceiptAndItsFixDraftKeepTheirIdsAcrossFreshStoresOffline() {
        val firstScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        var room = EngineRoomFixture(tmp.root, firstScope)
        val account = room.account("u1")
        runBlocking {
            room.select("u1"); room.startExternalWorkout(); room.store.workout.choose("bench-press"); room.store.workout.logSet(60.0, 8)
        }
        val localId = room.store.workout.session!!.id
        val setId = room.store.workout.sets.single().id
        var instances = 0
        var showing by mutableStateOf(true)
        val restored = StateRestorationTester(compose)
        restored.setContent {
            if (showing) {
                val scope = remember { if (instances == 0) firstScope else CoroutineScope(SupervisorJob() + Dispatchers.Main) }
                val held = remember { if (instances++ == 0) room.store else room.freshStore(scope) }
                DisposableEffect(scope) { onDispose { scope.cancel() } }
                GymMaterial { GymRoom(account, held) }
            }
        }
        compose.onNodeWithText("Finish").performClick()
        awaitText("Ended early.")
        compose.onNodeWithText("Ended early.").assertIsDisplayed()
        compose.onAllNodesWithText("480 kg").onLast().assertIsDisplayed()
        val beforeRestore = room
        compose.runOnIdle {
            val snapshot = room.engine.snapshot()
            val at = room.now
            room = EngineRoomFixture(tmp.root, firstScope, snapshot).apply { now = at; selected = "u1" }
        }
        restored.emulateSavedInstanceStateRestore()
        awaitText("480 kg")
        compose.onAllNodesWithText("480 kg").onLast().assertIsDisplayed()
        compose.runOnIdle { runBlocking {
            assertEquals(localId, room.training.session(localId)!!.session.id)
            assertEquals(listOf(setId), room.training.session(localId)!!.sets.map { it.id })
        } }
        compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
        awaitRow("Set 1, 60 kg total, 8 reps")
        compose.onNode(hasContentDescription("Set 1, 60 kg total, 8 reps", substring = true)).performClick()
        compose.onNodeWithText("Bench Press · Set 1").assertIsDisplayed()
        compose.onNodeWithText("Set note").performTextInput("controlled tempo")
        compose.onNodeWithText("Not rated").performClick()
        compose.onNodeWithText(works.windmill.gym.presentation.SetEffort.rpeReading(9.5)).performScrollTo().performClick()
        compose.onNodeWithContentDescription("Load, kg total").performClick().performTextReplacement("1e999")
        compose.onNodeWithContentDescription("Load, kg total").performImeAction()
        restored.emulateSavedInstanceStateRestore()
        awaitText("1e999")
        compose.onNodeWithText("1e999").assertIsDisplayed()
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.onNodeWithText(works.windmill.gym.presentation.SetEffort.rpeReading(9.5)).assertIsDisplayed()
        compose.onNodeWithText("Bench Press · Set 1").assertIsDisplayed()
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle { runBlocking {
            val set = room.training.session(localId)!!.sets.single()
            assertEquals(setId, set.id)
            assertEquals("controlled tempo", set.note)
            assertEquals(9.5, set.rpe!!, 0.0)
            assertEquals(60.0, set.weightKg, 0.0)
            assertEquals(3, instances)
        } }
        compose.runOnIdle { showing = false }
        compose.waitForIdle()
        beforeRestore.close()
        room.close()
    }

    @Test
    fun unresolvedCredentialsHideSavedHistoryThenSameOwnerRestoresAndSignedOutClearsIt() {
        val firstScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), firstScope).apply { now = past }
        val signedIn = room.account("u1")
        var account by mutableStateOf(signedIn)
        runBlocking { room.select("u1") }
        pastWorkout(room, "Push A", 40.0, 8)
        var showing by mutableStateOf(true)
        var instances = 0
        lateinit var current: TrainingStore
        val restored = StateRestorationTester(compose)
        restored.setContent {
            if (showing) {
                val scope = remember { if (instances == 0) firstScope else CoroutineScope(SupervisorJob() + Dispatchers.Main) }
                val held = remember { (if (instances++ == 0) room.store else room.freshStore(scope)).also { current = it } }
                DisposableEffect(scope) { onDispose { scope.cancel() } }
                GymMaterial { GymRoom(account, held) }
            }
        }
        try {
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            awaitText("Push A")
            compose.onNodeWithText("Push A").performClick()
            awaitRow("Set 1, 40 kg total, 8 reps")
            compose.onNode(hasContentDescription("Set 1, 40 kg total, 8 reps", substring = true)).performClick()
            compose.onNodeWithText("Set note").performTextInput("private note")
            restored.emulateSavedInstanceStateRestore()
            compose.runOnIdle { account = Account(signedIn.origin, null, resolved = false) }
            compose.onNodeWithText("private note").assertDoesNotExist()
            compose.onNodeWithText("Push A").assertDoesNotExist()
            compose.runOnIdle { account = signedIn }
            awaitText("private note")
            compose.onNodeWithText("private note").assertIsDisplayed()
            compose.runOnIdle { account = Account(signedIn.origin, null, resolved = false) }
            compose.runOnIdle {
                switchAccount(room, current, null)
                account = room.account(null)
            }
            compose.onNodeWithText("private note").assertDoesNotExist()
            compose.onNodeWithText("Push A").assertDoesNotExist()
            compose.onNodeWithText("Routines").assertIsDisplayed()
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            room.close()
        }
    }

    @Test
    fun aColdUnknownThenSignedOutCannotHandAnUnconsumedSavedFixToAnotherAccount() {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), CoroutineScope(SupervisorJob() + Dispatchers.Main)).apply { now = past }.use { other ->
            runBlocking { other.select("u2"); other.pull(server) }
            pastWorkout(other, "B workout", 70.0, 5)
            other.sync(server)
            other.scope.cancel()
        }
        val firstScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), firstScope).apply { now = past + 600_000 }
        var account by mutableStateOf(room.account("u1"))
        runBlocking { room.select("u1") }
        pastWorkout(room, "A workout", 40.0, 8)
        var showing by mutableStateOf(true)
        var instances = 0
        lateinit var current: TrainingStore
        val restored = StateRestorationTester(compose)
        restored.setContent {
            if (showing) {
                val scope = remember { if (instances == 0) firstScope else CoroutineScope(SupervisorJob() + Dispatchers.Main) }
                val held = remember { (if (instances++ == 0) room.store else room.freshStore(scope)).also { current = it } }
                DisposableEffect(scope) { onDispose { scope.cancel() } }
                GymMaterial { GymRoom(account, held) }
            }
        }
        try {
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            awaitText("A workout")
            compose.onNodeWithText("A workout").performClick()
            awaitRow("Set 1, 40 kg total, 8 reps")
            compose.onNode(hasContentDescription("Set 1, 40 kg total, 8 reps", substring = true)).performClick()
            compose.onNodeWithText("Set note").performTextInput("A private note")
            compose.runOnIdle { account = Account(account.origin, null, resolved = false) }
            restored.emulateSavedInstanceStateRestore()
            compose.onNodeWithText("A private note").assertDoesNotExist()
            compose.runOnIdle {
                switchAccount(room, current, null)
                account = room.account(null)
            }
            compose.onNodeWithText("Routines").assertIsDisplayed()
            compose.runOnIdle {
                switchAccount(room, current, "u2")
                room.pull(server)
                account = room.account("u2")
            }
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            awaitText("B workout")
            compose.onNodeWithText("B workout").performClick()
            compose.onNodeWithText("A workout").assertDoesNotExist()
            compose.onNodeWithText("A private note").assertDoesNotExist()
            compose.onNode(hasContentDescription("Set 1, 40 kg total, 8 reps", substring = true)).assertDoesNotExist()
            awaitRow("Set 1, 70 kg total, 5 reps")
            compose.onNode(hasContentDescription("Set 1, 70 kg total, 5 reps", substring = true)).assertIsDisplayed()
            compose.onNode(hasContentDescription("Set 1, 70 kg total, 5 reps", substring = true)).performClick()
            compose.onNodeWithText("Bench Press · Set 1").assertIsDisplayed()
            compose.onNodeWithText("A private note").assertDoesNotExist()
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            room.close()
        }
    }

    // The account's history reaches this phone only after the rack was set and the room restored.
    @Test
    fun aRestoredFreeRackKeepsItsChosenValuesWhenHistoryArrivesLate() {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), CoroutineScope(SupervisorJob() + Dispatchers.Main)).use { other ->
            runBlocking { other.select("u1"); other.pull(server) }
            runBlocking {
                other.training.startSession(SessionStart("remote01", other.now - 10_000))
                other.training.appendSet("remote01", SetWrite("remoteset", "bench-press", 80.0, 5, other.now - 9_000))
                other.training.finishSession("remote01", other.now - 5_000)
            }
            other.sync(server)
            other.scope.cancel()
        }
        val initialScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), initialScope).apply { now += 600_000 }
        val account = room.account("u1")
        val live = runBlocking {
            room.select("u1")
            val opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            opened
        }
        var showing by mutableStateOf(true)
        var instances = 0
        lateinit var current: TrainingStore
        lateinit var currentScope: CoroutineScope
        val restored = StateRestorationTester(compose)
        restored.setContent {
            if (showing) {
                val scope = remember { if (instances == 0) initialScope else CoroutineScope(SupervisorJob() + Dispatchers.Main) }
                val held = remember { (if (instances++ == 0) room.store else room.freshStore(scope)).also { current = it; currentScope = scope } }
                DisposableEffect(scope) { onDispose { scope.cancel() } }
                GymMaterial { GymRoom(account, held) }
            }
        }
        try {
            compose.waitUntil(10_000) {
                compose.onAllNodes((hasContentDescription("Load, kg total") and hasText("20"))).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNode((hasContentDescription("Load, kg total") and hasText("20"))).performClick()
            compose.onNodeWithContentDescription("Load, kg total").performTextReplacement("92")
            compose.onNodeWithContentDescription("Load, kg total").performImeAction()
            compose.onNode(hasContentDescription("Increase Reps")).performClick()
            compose.onNode((hasContentDescription("Load, kg total") and hasText("92"))).assertIsDisplayed()
            compose.onNode((hasContentDescription("Reps") and hasText("6"))).assertIsDisplayed()
            restored.emulateSavedInstanceStateRestore()
            compose.waitUntil(10_000) {
                compose.onAllNodes((hasContentDescription("Load, kg total") and hasText("92"))).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNode((hasContentDescription("Load, kg total") and hasText("92"))).assertIsDisplayed()
            compose.onNode((hasContentDescription("Reps") and hasText("6"))).assertIsDisplayed()
            val connection = compose.runOnIdle { currentScope.async { room.pull(server); current.connect(account) } }
            compose.waitUntil(10_000) { compose.runOnIdle { connection.isCompleted } }
            runBlocking { connection.await() }
            compose.runOnIdle { assertEquals(listOf(80.0), current.workout.lastTime!!.sets.map { it.weightKg }) }
            compose.onNode((hasContentDescription("Load, kg total") and hasText("92"))).assertIsDisplayed()
            compose.onNode((hasContentDescription("Reps") and hasText("6"))).assertIsDisplayed()
            compose.onNodeWithText("Log set").performClick()
            compose.runOnIdle {
                assertEquals(listOf(92.0 to 6), current.workout.sets.map { it.weightKg to it.reps })
                assertEquals(listOf(92.0 to 6), runBlocking { room.training.session(live.id) }!!.sets.map { it.weightKg to it.reps })
                assertEquals(2, instances)
            }
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            room.close()
        }
    }

    @Test
    @Config(sdk = [28])
    fun everyNativeNumberCancellationKeepsTheLiveFixNoteAndEffort() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        val account = room.account("u1")
        val held = room.store
        runBlocking {
            room.select("u1"); room.startExternalWorkout(held); held.workout.choose("bench-press"); held.workout.logSet(60.0, 8)
            room.sync(EngineRoomFixture.server()); held.refreshEngine()
        }
        val sessionId = held.workout.session!!.id
        val logged = held.workout.sets.single()
        var showing by mutableStateOf(true)
        compose.setContent { if (showing) GymMaterial { GymRoom(account, held) } }
        try {
            compose.onNode(hasContentDescription("Set 1, logged, 60 kg total, 8 reps")).performScrollTo().performClick()
            compose.onNodeWithText("Set note").performTextInput("Live retained note")
            compose.onNodeWithText("Not rated").performClick()
            compose.onNodeWithText(works.windmill.gym.presentation.SetEffort.rpeReading(9.5)).performScrollTo().performClick()
            for (dismissal in listOf("back", "blur then back", "scrim", "drag")) {
                val modal = compose.onNodeWithText("Fix set").fetchSemanticsNode().root
                compose.onNode(hasText("60") and SemanticsMatcher("in the Fix dialog") { it.root == modal }).performClick()
                compose.onNode(hasContentDescription("Load, kg total") and SemanticsMatcher("in the Fix dialog") { it.root == modal })
                    .performTextReplacement("1e999")
                compose.onNodeWithText("1e999").assertIsDisplayed()
                when (dismissal) {
                    "back" -> compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
                    "blur then back" -> {
                        compose.onNodeWithText("Live retained note").performClick()
                        compose.onNodeWithText("1e999").assertIsDisplayed()
                        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
                    }
                    "scrim" -> compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
                    else -> compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performTouchInput {
                        swipe(center, center + Offset(0f, 1_200f), durationMillis = 500)
                    }
                }
                compose.onNodeWithText("Live retained note").assertIsDisplayed()
                compose.onNodeWithText(works.windmill.gym.presentation.SetEffort.rpeReading(9.5)).assertIsDisplayed()
                compose.onNodeWithText("1e999").assertDoesNotExist()
            }
            compose.onNodeWithText("Save fix").performClick()
            compose.runOnIdle {
                val fixed = logged.copy(note = "Live retained note", rpe = 9.5)
                assertEquals(listOf(fixed), runBlocking { room.training.session(sessionId) }!!.sets)
                assertEquals(60.0, held.workout.sets.single().weightKg, 0.0)
                assertEquals(8, held.workout.sets.single().reps)
            }
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
}
