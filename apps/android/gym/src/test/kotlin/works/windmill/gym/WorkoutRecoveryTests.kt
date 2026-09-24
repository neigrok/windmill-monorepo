package works.windmill.gym

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
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.ui.GymMaterial
import works.windmill.gym.ui.KeypadEntry
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class WorkoutRecoveryTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope, server: TrainingSyncing) = TrainingStore(
        queue = SetQueue(File(tmp.root, "queue.json"), "u1"),
        deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
        localLog = LocalLog(File(tmp.root, "local.json"), "u1"),
        localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
        localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json"), "u1"),
        scope = scope, sync = { if (it.isSignedIn) server else null },
    )

    @Test
    fun historicalDetailAndInvalidFixDraftReturnAutomaticallyWithAFreshStoreOffline() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }),
            User("u1", "sam@example.com", "Sam"))
        val server = FakeTraining()
        server.catalog = listOf(Exercise("bench", "Bench Press"))
        server.open(Session("past", startedAtMs = 1_000, finishedAtMs = 2_000,
            plan = PlanSnapshot("Push A", emptyList())))
        server.sets["past"] = mutableListOf(TrainingSet("warm", "bench", setNumber = 7,
            weightKg = 40.0, reps = 8, kind = SetKind.Warmup, completedAtMs = 1_500))
        val restored = StateRestorationTester(compose)
        var instances = 0
        restored.setContent {
            val held = remember { instances++; store(scope, server) }
            GymMaterial { GymRoom(account, held) }
        }
        compose.onNode(hasText("Log") and hasClickAction()).performClick()
        compose.onNodeWithText("Push A").performClick()
        compose.onNodeWithText("40 × 8").performClick()
        compose.onNodeWithText("Bench Press · Set 7").assertIsDisplayed()
        compose.onNodeWithText("Set note").performTextInput("controlled tempo")
        compose.onNodeWithText("40").performClick()
        compose.onNodeWithText("5").performClick()
        compose.onNodeWithText("2").performClick()
        compose.onNodeWithText("0").performClick()
        compose.runOnIdle { server.online = false }
        restored.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("520").assertIsDisplayed()
        compose.onNodeWithText(KeypadEntry.overWeight).assertIsDisplayed()
        compose.onNodeWithText("Set weight").assertIsNotEnabled()
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.onNodeWithText("Bench Press · Set 7").assertIsDisplayed()
        for (dismissal in listOf("scrim", "drag")) {
            compose.onNodeWithText("40").performClick()
            compose.onNodeWithText("5").performClick(); compose.onNodeWithText("2").performClick(); compose.onNodeWithText("0").performClick()
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
        compose.onNodeWithText("40 × 8").assertIsDisplayed()
        assertEquals(2, instances)
        assertEquals(emptyList<Any>(), server.fixes)
        scope.cancel()
    }

    @Test
    fun finishReceiptAndDismissedReadbackKeepTheSettledRowsWhenSubsequentReadsFail() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }),
            User("u1", "sam@example.com", "Sam"))
        val fake = FakeTraining()
        fake.catalog = listOf(Exercise("bench", "Bench Press"))
        var closed = false
        val server = object : TrainingSyncing by fake {
            override suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session {
                val result = fake.finishSession(sessionId, finishedAtMs)
                closed = true
                return result
            }
            override suspend fun session(id: String): SessionDetail? {
                if (closed) throw IOException("read offline")
                return fake.session(id)
            }
        }
        val held = store(scope, server)
        runBlocking { held.connect(account); held.start(null); held.choose("bench"); held.logSet(60.0, 8) }
        val restored = StateRestorationTester(compose)
        restored.setContent { GymMaterial { GymRoom(account, held) } }
        compose.onNodeWithText("Finish").performClick()
        compose.onNodeWithText("Ended early.").assertIsDisplayed()
        compose.onNodeWithText("480").assertIsDisplayed()
        compose.onNodeWithText("1 × 8 · 60kg").assertIsDisplayed()
        restored.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("480").assertIsDisplayed()
        compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("480 kg").assertIsDisplayed()
        compose.onNodeWithText("60 × 8").assertIsDisplayed()
        compose.onNodeWithText("60 × 8").performClick()
        compose.onNodeWithText("Bench Press · Set 1").assertIsDisplayed()
        assertEquals(1, fake.appended.size)
        assertEquals(1, fake.finished.size)
        scope.cancel()
    }
    @Test
    fun aLateClaimRemintIsSavedWithTheReceiptAndTheFixDraftAcrossFreshStores() {
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User("u1", "sam@example.com", "Sam"))
        val fake = FakeTraining().apply { online = false; catalog = listOf(Exercise("bench", "Bench Press")) }
        val gate = CompletableDeferred<Unit>()
        var localId = ""
        var canonicalId = ""
        val reads = mutableListOf<String>()
        val server = object : TrainingSyncing by fake {
            override suspend fun startSession(start: SessionStart): Session {
                if (fake.online && start.id == localId) {
                    gate.await()
                    throw works.windmill.platform.net.WindmillApiException.Refused(409,
                        works.windmill.platform.net.Refusal(code = "session-id-taken", message = "taken"))
                }
                return fake.startSession(start).also { canonicalId = it.id }
            }
            override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet {
                return fake.appendSet(sessionId, write).copy(id = "canonical_set", setNumber = 7).also {
                    fake.sets[sessionId] = mutableListOf(it)
                }
            }
            override suspend fun session(id: String): SessionDetail? { reads += id; return fake.session(id) }
        }
        val firstScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val first = store(firstScope, server)
        runBlocking { first.connect(account); first.start(null); first.choose("bench"); first.logSet(60.0, 8) }
        localId = first.session!!.id
        fake.online = true
        var instances = 0
        val restored = StateRestorationTester(compose)
        restored.setContent {
            val scope = remember { if (instances == 0) firstScope else CoroutineScope(SupervisorJob() + Dispatchers.Main) }
            val held = remember { if (instances++ == 0) first else store(scope, server) }
            DisposableEffect(scope) { onDispose { scope.cancel() } }
            GymMaterial { GymRoom(account, held) }
        }
        compose.onNodeWithText("Finish").performClick()
        compose.onNodeWithText("Ended early.").assertIsDisplayed()
        compose.onNodeWithText("480").assertIsDisplayed()
        compose.runOnIdle { gate.complete(Unit) }
        compose.waitUntil(10_000) { fake.stored.values.any { !it.isOpen } }
        compose.waitForIdle()
        assertTrue(canonicalId.isNotEmpty() && canonicalId != localId)
        reads.clear()
        restored.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("480").assertIsDisplayed()
        compose.runOnIdle { assertTrue(reads.isNotEmpty()); assertTrue(reads.all { it == canonicalId }) }
        compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("60 × 8").performClick()
        compose.onNodeWithText("Bench Press · Set 7").assertIsDisplayed()
        compose.onNodeWithText("Set note").performTextInput("controlled tempo")
        compose.onNodeWithText("Not rated").performClick()
        compose.onNodeWithText(works.windmill.gym.domain.SetEffort.rpeReading(9.5)).performScrollTo().performClick()
        compose.onNodeWithText("60").performClick()
        compose.onNodeWithText("5").performClick(); compose.onNodeWithText("2").performClick(); compose.onNodeWithText("0").performClick()
        compose.runOnIdle { fake.online = false }
        restored.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("520").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("controlled tempo").assertIsDisplayed()
        compose.onNodeWithText(works.windmill.gym.domain.SetEffort.rpeReading(9.5)).assertIsDisplayed()
        compose.onNodeWithText("Bench Press · Set 7").assertIsDisplayed()
        compose.runOnIdle { fake.online = true }
        compose.onNodeWithText("Save fix").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(listOf(Triple(canonicalId, "canonical_set", SetFix(rpe = 9.5, rpeNamed = true, note = "controlled tempo"))), fake.fixes)
            assertEquals(3, instances)
        }
    }

    @Test
    fun unresolvedCredentialsHideSavedHistoryThenSameOwnerRestoresAndSignedOutClearsIt() {
        val api = WindmillApi("https://windmill.works".toHttpUrl(), credential = { null })
        val signedIn = Account(api, User("u1", "sam@example.com", "Sam"))
        var account by mutableStateOf(signedIn)
        val fake = FakeTraining().apply { catalog = listOf(Exercise("bench", "Bench Press")) }
        fake.open(Session("past", startedAtMs = 1_000, finishedAtMs = 2_000, plan = PlanSnapshot("Push A", emptyList())))
        fake.sets["past"] = mutableListOf(TrainingSet("warm", "bench", setNumber = 7, weightKg = 40.0, reps = 8, kind = SetKind.Warmup, completedAtMs = 1_500))
        val restored = StateRestorationTester(compose)
        restored.setContent {
            val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.Main) }
            val held = remember { store(scope, fake) }
            DisposableEffect(scope) { onDispose { scope.cancel() } }
            GymMaterial { GymRoom(account, held) }
        }
        compose.onNode(hasText("Log") and hasClickAction()).performClick(); compose.onNodeWithText("Push A").performClick()
        compose.onNodeWithText("40 × 8").performClick()
        compose.onNodeWithText("Set note").performTextInput("private note")
        restored.emulateSavedInstanceStateRestore()
        compose.runOnIdle { account = Account(api, null, resolved = false) }
        compose.onNodeWithText("private note").assertDoesNotExist()
        compose.onNodeWithText("Push A").assertDoesNotExist()
        compose.runOnIdle { account = signedIn }
        compose.onNodeWithText("private note").assertIsDisplayed()
        compose.runOnIdle { account = Account(api, null, resolved = false) }
        compose.runOnIdle { account = Account(api, null, resolved = true) }
        compose.onNodeWithText("private note").assertDoesNotExist()
        compose.onNodeWithText("Push A").assertDoesNotExist()
        compose.onNodeWithText("Routines").assertIsDisplayed()
    }

    @Test
    fun aColdUnknownThenSignedOutCannotHandAnUnconsumedSavedFixToAnotherAccount() {
        val api = WindmillApi("https://windmill.works".toHttpUrl(), credential = { null })
        var account by mutableStateOf(Account(api, User("u1", "a@example.com")))
        val fake = FakeTraining().apply { catalog = listOf(Exercise("bench", "Bench Press")) }
        fake.open(Session("past_a", startedAtMs = 1_000, finishedAtMs = 2_000, plan = PlanSnapshot("A workout", emptyList())))
        fake.sets["past_a"] = mutableListOf(TrainingSet("set_a", "bench", setNumber = 7, weightKg = 40.0, reps = 8, completedAtMs = 1_500))
        var gate: CompletableDeferred<Unit>? = null
        val reads = mutableListOf<String>()
        val server = object : TrainingSyncing by fake {
            override suspend fun session(id: String): SessionDetail? {
                reads += id
                gate?.await()
                return fake.session(id)
            }
        }
        val restored = StateRestorationTester(compose)
        restored.setContent {
            val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.Main) }
            val held = remember { store(scope, server) }
            DisposableEffect(scope) { onDispose { scope.cancel() } }
            GymMaterial { GymRoom(account, held) }
        }
        compose.onNode(hasText("Log") and hasClickAction()).performClick(); compose.onNodeWithText("A workout").performClick()
        compose.onNodeWithText("40 × 8").performClick()
        compose.onNodeWithText("Set note").performTextInput("A private note")
        compose.runOnIdle { account = Account(api, null, resolved = false) }
        restored.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("A private note").assertDoesNotExist()
        compose.runOnIdle { account = Account(api, null) }
        compose.onNodeWithText("Routines").assertIsDisplayed()
        compose.runOnIdle {
            fake.stored.clear(); fake.sets.clear(); reads.clear()
            fake.open(Session("past_b", startedAtMs = 3_000, finishedAtMs = 4_000, plan = PlanSnapshot("B workout", emptyList())))
            fake.sets["past_b"] = mutableListOf(TrainingSet("set_b", "bench", setNumber = 1, weightKg = 70.0, reps = 5, completedAtMs = 3_500))
            account = Account(api, User("u2", "b@example.com"))
        }
        compose.onNode(hasText("Log") and hasClickAction()).performClick()
        compose.runOnIdle { gate = CompletableDeferred() }
        compose.onNodeWithText("B workout").performClick()
        compose.onNodeWithText("A workout").assertDoesNotExist()
        compose.onNodeWithText("A private note").assertDoesNotExist()
        compose.onNodeWithText("40 × 8").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("past_b"), reads); gate!!.complete(Unit) }
        compose.onNodeWithText("70 × 5").assertIsDisplayed()
        compose.onNodeWithText("70 × 5").performClick()
        compose.onNodeWithText("Bench Press · Set 1").assertIsDisplayed()
        compose.onNodeWithText("A private note").assertDoesNotExist()
    }

    @Test
    fun aRestoredFreeRackKeepsItsChosenValuesWhenHistoryArrivesLate() {
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }),
            User("u1", "sam@example.com"))
        val fake = FakeTraining().apply { catalog = listOf(Exercise("bench", "Bench Press")) }
        val history = LastTime("bench", Session("past", startedAtMs = 1_000, finishedAtMs = 2_000),
            sets = listOf(TrainingSet("old", "bench", weightKg = 80.0, reps = 5, completedAtMs = 1_500)))
        var gate: CompletableDeferred<Unit>? = null
        val server = object : TrainingSyncing by fake {
            override suspend fun lastTime(exerciseId: String): LastTime {
                gate?.await()
                return history
            }
        }
        val initialScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val initial = store(initialScope, server)
        runBlocking { initial.connect(account); initial.start(); initial.choose("bench") }
        var instances = 0
        lateinit var current: TrainingStore
        val restored = StateRestorationTester(compose)
        restored.setContent {
            val scope = remember { if (instances == 0) initialScope else CoroutineScope(SupervisorJob() + Dispatchers.Main) }
            val held = remember { (if (instances++ == 0) initial else store(scope, server)).also { current = it } }
            DisposableEffect(scope) { onDispose { scope.cancel() } }
            GymMaterial { GymRoom(account, held) }
        }
        compose.onNode(hasContentDescription("Weight 80 kg")).performClick()
        compose.onNodeWithText("9").performClick(); compose.onNodeWithText("2").performClick()
        compose.onNodeWithText("Set weight").performClick()
        compose.onNode(hasContentDescription("one rep more")).performClick()
        compose.onNode(hasContentDescription("Weight 92 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()
        compose.runOnIdle { gate = CompletableDeferred() }
        restored.emulateSavedInstanceStateRestore()
        compose.onNode(hasContentDescription("Weight 92 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()
        compose.runOnIdle { gate!!.complete(Unit) }
        compose.waitForIdle()
        compose.onNode(hasContentDescription("Weight 92 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()
        compose.onNodeWithText("Log set").performClick()
        compose.runOnIdle {
            assertEquals(listOf(92.0 to 6), current.sets.map { it.weightKg to it.reps })
            runBlocking { current.flushPendingSets() }
            assertEquals(listOf(92.0 to 6), fake.sets.values.flatten().map { it.weightKg to it.reps })
            assertEquals(2, instances)
        }
    }

    @Test
    @Config(sdk = [28])
    fun everyNativeKeypadCancellationKeepsTheLiveFixNoteAndEffort() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User("u1", "sam@example.com"))
        val server = FakeTraining().apply { catalog = listOf(Exercise("bench", "Bench Press")) }
        val held = store(scope, server)
        runBlocking { held.connect(account); held.start(); held.choose("bench"); held.logSet(60.0, 8); held.flushPendingSets() }
        val sessionId = held.session!!.id
        val setId = held.sets.single().id
        compose.setContent { GymMaterial { GymRoom(account, held) } }
        compose.onNode(hasContentDescription("Set 1, logged, 60 kg, 8 reps")).performScrollTo().performClick()
        compose.onNodeWithText("Set note").performTextInput("Live retained note")
        compose.onNodeWithText("Not rated").performClick()
        compose.onNodeWithText(works.windmill.gym.domain.SetEffort.rpeReading(9.5)).performScrollTo().performClick()
        for (dismissal in listOf("back", "cancel", "scrim", "drag")) {
            val modal = compose.onNodeWithText("Fix set").fetchSemanticsNode().root
            compose.onNode(hasText("60") and SemanticsMatcher("in the Fix dialog") { it.root == modal }).performClick()
            compose.onNodeWithText("5").performClick(); compose.onNodeWithText("2").performClick(); compose.onNodeWithText("0").performClick()
            compose.onNodeWithText("520").assertIsDisplayed()
            when (dismissal) {
                "back" -> compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
                "cancel" -> compose.onNodeWithText("Cancel").performClick()
                "scrim" -> compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
                else -> compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performTouchInput {
                    swipe(center, center + Offset(0f, 1_200f), durationMillis = 500)
                }
            }
            compose.onNodeWithText("Live retained note").assertIsDisplayed()
            compose.onNodeWithText(works.windmill.gym.domain.SetEffort.rpeReading(9.5)).assertIsDisplayed()
            compose.onNodeWithText("520").assertDoesNotExist()
        }
        compose.onNodeWithText("Save fix").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(listOf(Triple(sessionId, setId, SetFix(rpe = 9.5, rpeNamed = true, note = "Live retained note"))), server.fixes)
            assertEquals(60.0, held.sets.single().weightKg, 0.0)
            assertEquals(8, held.sets.single().reps)
            assertEquals(SetKind.Working, held.sets.single().kind)
        }
        scope.cancel()
    }

}
