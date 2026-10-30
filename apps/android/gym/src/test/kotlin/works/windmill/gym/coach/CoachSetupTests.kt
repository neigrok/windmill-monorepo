package works.windmill.gym.coach

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
import works.windmill.gym.domain.RoutineDraft
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
                {}, {}, {}, "", "http://localhost", onThreads = {}, onNotes = {}, onReview = {}, conversationId = id,
                onBuildRoutine = {}) } }
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertIsDisplayed()
            compose.runOnIdle { thread = listOf(AskExchange("A real question", requestId = "accepted")) }
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertDoesNotExist()
            compose.onNodeWithText("A real question").assertIsDisplayed()
            compose.onNodeWithText("Build my own").assertDoesNotExist()
            compose.runOnIdle { scope.cancel() }
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

    @Test fun aRoutineCreatedBeforeTheRoomOpensKeepsTheRoutinesTab() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        EngineRoomFixture(temporary.newFolder(), scope, rest = FakeGymRest()).use { room ->
            runBlocking {
                room.select("alice")
                room.pull(EngineRoomFixture.server())
                room.store.refreshEngine()
                val draft = RoutineDraft(name = "Owned routine").adding("bench-press").capturingMovements(room.store.catalog)
                assertTrue(room.store.saveRoutine(draft) is GymResult.Ok)
                assertEquals(false, room.store.initialGymEmpty)
            }
            compose.setContent { GymMaterial { GymRoom(room.account(), room.store) } }
            compose.onNodeWithText("Owned routine").assertIsDisplayed()
            compose.onNodeWithText("Hi, I’m Coach. I can help you with:").assertDoesNotExist()
            compose.runOnIdle { scope.cancel() }
        }
    }
}
