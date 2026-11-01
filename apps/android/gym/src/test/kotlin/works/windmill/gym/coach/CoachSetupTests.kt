package works.windmill.gym.coach

import androidx.compose.runtime.CompositionLocalProvider
import works.windmill.platform.telemetry.LocalTelemetry
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.StateRestorationTester
import java.io.File
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import javax.crypto.KeyGenerator
import works.windmill.gym.coach.onboarding.CoachOnboardingApi
import works.windmill.gym.coach.onboarding.CoachOnboardingSeat
import works.windmill.gym.coach.onboarding.CoachOnboardingStore
import works.windmill.platform.ai.AiAllowance
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationApi
import works.windmill.platform.ai.AiInstallationResponse
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.GymRoom
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class CoachSetupTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val temporary = TemporaryFolder()

    @Test fun capabilitiesFollowTheSeatAndBothDoorsRemainNativeActions() {
        var signedIn by mutableStateOf(false)
        val actions = mutableListOf<String>()
        compose.setContent { GymMaterial { CoachGreeting(signedIn, true, { actions += "photo" }, { actions += "routine" }) } }
        compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertIsDisplayed()
        compose.onNodeWithText("Account — sign in, and I can also save notes and suggest changes to your routines.", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Add screenshot").performClick()
        compose.onNodeWithText("Build my own").performClick()
        compose.runOnIdle { assertEquals(listOf("photo", "routine"), actions); signedIn = true }
        compose.onNodeWithText("Account —", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Notes — I save important facts, like an old injury.", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Changes — ask me, and I suggest changes to your routines.", substring = true).assertIsDisplayed()
    }

    @Test fun setupIdentitySurvivesRestartWithoutAddingLocalModelTurns() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val file = File(temporary.root, "coach.json")
        try {
            val store = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, LocalCoach(file), Telemetry.None, System::nanoTime, scope)
            val setup = store.freshChat(setup = true)
            val restored = CoachStore({ "alice" }, { emptySet() }, {}, { FakeGymRest() }, LocalCoach(file), Telemetry.None, System::nanoTime, scope)
            assertTrue(restored.chat(setup)!!.setup)
            assertEquals(emptyList<AskExchange>(), restored.chat(setup)!!.exchanges)
            val ordinary = restored.freshChat()
            assertFalse(restored.chat(ordinary)!!.setup)
            assertEquals(emptyList<AskExchange>(), restored.chat(ordinary)!!.exchanges)
            assertTrue(restored.chat(setup)!!.setup)
        } finally { scope.cancel() }
    }

    @Test fun theSetupGreetingLeavesWhenTheFirstMessageIsAccepted() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        EngineRoomFixture(temporary.newFolder(), scope, rest = FakeGymRest()).use { room ->
            runBlocking { room.select("alice") }
            val id = room.store.coach.freshChat(setup = true)
            var thread by mutableStateOf(emptyList<AskExchange>())
            compose.setContent { GymMaterial { AskScreen(room.store, thread, emptyList(), emptySet(), false, null,
                {}, {}, {}, "", "http://localhost", onThreads = {}, onReview = {}, conversationId = id,
                onBuildRoutine = {}) } }
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertIsDisplayed()
            compose.runOnIdle { thread = listOf(AskExchange("A real question", requestId = "accepted")) }
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertDoesNotExist()
            compose.onNodeWithText("A real question").assertIsDisplayed()
            compose.onNodeWithText("Build my own").assertDoesNotExist()
            compose.runOnIdle { scope.cancel() }
        }
    }

    @Test fun theGreetingCountsOneShownStepAcrossRecreation() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        EngineRoomFixture(temporary.newFolder(), scope, rest = FakeGymRest()).use { room ->
            runBlocking { room.select("alice") }
            val id = room.store.coach.freshChat(setup = true)
            val restore = StateRestorationTester(compose)
            restore.setContent { CompositionLocalProvider(LocalTelemetry provides telemetry) { GymMaterial {
                AskScreen(room.store, emptyList(), emptyList(), emptySet(), false, null, {}, {}, {}, "", "http://localhost",
                    onThreads = {}, onReview = {}, conversationId = id, onBuildRoutine = {})
            } } }
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertIsDisplayed()
            restore.emulateSavedInstanceStateRestore()
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(listOf("gym_setup_step" to mapOf("screen" to "coach", "action" to "shown")),
                    events.filter { it.first == "gym_setup_step" })
                scope.cancel()
            }
        }
    }

    @Test fun emptyHydratedGymOpensCoachAndTheChosenTabWinsRecreation() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        EngineRoomFixture(temporary.newFolder(), scope, rest = FakeGymRest()).use { room ->
            runBlocking {
                room.select("alice")
                assertNull(room.store.initialGymEmpty)
                room.pull(EngineRoomFixture.server())
                room.store.refreshEngine()
                assertEquals(true, room.store.initialGymEmpty)
            }
            val restore = StateRestorationTester(compose)
            restore.setContent { GymMaterial { GymRoom(room.account(), room.store) } }
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertIsDisplayed()
            compose.onNodeWithText("Routines").performClick()
            compose.onNodeWithContentDescription("New routine").assertIsDisplayed()
            restore.emulateSavedInstanceStateRestore()
            compose.onNodeWithContentDescription("New routine").assertIsDisplayed()
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertDoesNotExist()
            compose.runOnIdle { scope.cancel() }
        }
    }

    @Test fun aPhoneDraftMovesIntoTheAccountWhenTheFirstPullCompletesWithoutRecreation() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val file = File(temporary.root, "coach.json")
        val disk = LocalCoach(file)
        val phone = disk.anonymousOwner()
        disk.saveChat(phone, LocalChat("phone-chat", setup = true), true)
        disk.saveDraft(phone, "phone-chat", CoachDraft("Phone draft"))
        var settled by mutableStateOf(false)
        EngineRoomFixture(temporary.newFolder(), scope, rest = FakeGymRest(), localCoach = disk, workoutAuthority = { settled }).use { room ->
            runBlocking { room.select("alice") }
            assertFalse(room.store.seat.accountReady)
            compose.setContent { GymMaterial { GymRoom(room.account(), room.store) } }
            compose.runOnIdle { assertEquals(CoachDraft("Phone draft"), LocalCoach(file).draft(phone, "phone-chat")) }
            compose.runOnIdle {
                settled = true
                runBlocking { room.store.connect(room.account()) }
                room.pull(EngineRoomFixture.server())
                runBlocking { room.store.refreshEngine() }
            }
            compose.waitForIdle()
            compose.waitUntil(5_000) { LocalCoach(file).draft(phone, "phone-chat") == CoachDraft() }
            compose.runOnIdle {
                val adopted = LocalCoach(file)
                assertEquals(CoachDraft("Phone draft", setup = true), adopted.draft("alice", requireNotNull(adopted.selected("alice"))))
            }
            compose.waitForIdle()
            compose.onNodeWithText("Phone draft").assertIsDisplayed()
            compose.runOnIdle { scope.cancel() }
        }
    }

    @Test fun aRoutineCreatedBeforeTheRoomOpensKeepsTheRoutinesTab() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        EngineRoomFixture(temporary.newFolder(), scope, rest = FakeGymRest()).use { room ->
            runBlocking {
                room.select("alice")
                room.pull(EngineRoomFixture.server())
                room.store.refreshEngine()
                val draft = RoutineDraft(name = "Owned routine").adding("bench-press").capturingMovements(room.store.routines.catalog)
                assertTrue(room.store.routines.saveRoutine(draft) is GymResult.Ok)
                assertEquals(false, room.store.initialGymEmpty)
            }
            compose.setContent { GymMaterial { GymRoom(room.account(), room.store) } }
            compose.onNodeWithText("Owned routine").assertIsDisplayed()
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertDoesNotExist()
            compose.runOnIdle { scope.cancel() }
        }
    }

    private fun signedOutRoom(scope: CoroutineScope, available: Boolean): EngineRoomFixture {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val kept = mutableMapOf<String, String>()
        val allowance = AiAllowance("ok", "USD", "lifetime", "anonymous", true, null, "0", "0", "0")
        val installation = AiInstallation(object : KeptValues {
            override fun read(key: String) = kept[key]
            override fun write(values: Map<String, String?>) = values.forEach { (key, value) -> if (value == null) kept.remove(key) else kept[key] = value }
        }, SecretVault { key }, object : AiInstallationApi {
            override suspend fun issue(): AiInstallationResponse =
                if (available) AiInstallationResponse(false, allowance, "A".repeat(43))
                else throw WindmillApiException.Refused(503, Refusal(code = "anonymous_ai_unavailable"))
            override suspend fun current(credential: String) = AiInstallationResponse(false, allowance)
            override suspend fun bind(credential: String, token: String) = AiInstallationResponse(true, allowance)
        })
        val local = LocalCoach(File(temporary.root, "archive"))
        val onboarding = CoachOnboardingStore(local, installation, object : CoachOnboardingApi {
            override suspend fun start(body: String, credential: String) = error("No question is sent")
            override suspend fun get(requestId: String, credential: String) = error("No question is sent")
        }, { CoachOnboardingSeat(local.anonymousOwner(), "replica") }, scope)
        return EngineRoomFixture(temporary.newFolder(), scope, rest = FakeGymRest(), localCoach = local, coachOnboarding = onboarding)
            .also { runBlocking { it.select(null) } }
    }

    @Test fun aSignedOutEmptyGymOpensCoachWhileThisPhoneCanAskIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        signedOutRoom(scope, available = true).use { room ->
            compose.setContent { GymMaterial { GymRoom(room.account(), room.store) } }
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertIsDisplayed()
            compose.onNode(hasText("Coach") and hasClickAction()).assertIsSelected()
            compose.runOnIdle { scope.cancel() }
        }
    }

    @Test fun aSignedOutEmptyGymOpensRoutinesWhileSignedOutCoachIsUnavailable() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        signedOutRoom(scope, available = false).use { room ->
            compose.setContent { GymMaterial { GymRoom(room.account(), room.store) } }
            compose.onNodeWithContentDescription("New routine").assertIsDisplayed()
            compose.onNode(hasText("Routines") and hasClickAction()).assertIsSelected()
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertDoesNotExist()
            compose.runOnIdle { scope.cancel() }
        }
    }
}
