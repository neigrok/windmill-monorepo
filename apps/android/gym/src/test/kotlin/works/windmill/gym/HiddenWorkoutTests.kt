package works.windmill.gym

import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
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
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.coach.AskAnswer
import works.windmill.gym.coach.ReadTally
import works.windmill.gym.coach.CoachResult
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.WorkoutChange
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.LocalShellActions
import works.windmill.platform.ShellActions
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class HiddenWorkoutTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var activity: ComponentActivity

    private fun room(withWorkout: Boolean = true, rest: FakeGymRest? = null, test: (EngineRoomFixture, StateRestorationTester, MutableList<Pair<String, Map<String, String>>>) -> Unit) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        val phone = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, rest = rest)
        var showing by mutableStateOf(true)
        try {
            runBlocking {
                phone.select("u1"); phone.pull(EngineRoomFixture.server())
                if (withWorkout) {
                    phone.workout(finish = false)
                    assertEquals(WorkoutChange.Saved, phone.store.editRack(92.5, 7))
                } else phone.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press"))
            }
            val account = phone.account()
            val shell = ShellActions(openYou = {})
            val restoration = StateRestorationTester(compose)
            restoration.setContent {
                activity = LocalActivity.current as ComponentActivity
                if (showing) CompositionLocalProvider(LocalShellActions provides shell, LocalTelemetry provides telemetry) {
                    GymMaterial { GymRoom(account, phone.store) }
                }
            }
            test(phone, restoration, events)
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel(); phone.close()
        }
    }

    @Test fun hideAndBackReturnToTheOriginatingTabAndTheSameRack() = room { phone, restoration, events ->
        val bar = "${Readout.noRoutine}, in progress"
        val session = phone.store.session
        compose.onNodeWithContentDescription("Hide workout").performClick()
        compose.onNodeWithContentDescription(bar).assertIsDisplayed()
        compose.onNodeWithText("Finish").assertDoesNotExist()
        for (tab in listOf("The log", "Coach", "Routines")) {
            compose.onNode(hasText(tab) and hasClickAction()).performClick()
            compose.onNodeWithContentDescription(bar).assertIsDisplayed().performClick()
            compose.onNodeWithText("Finish").assertIsDisplayed()
            compose.onNodeWithContentDescription(bar).assertDoesNotExist()
            compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
            compose.onNodeWithContentDescription(bar).assertIsDisplayed()
            compose.onNode(hasText(tab) and hasClickAction()).assertIsDisplayed().assertIsSelected()
            compose.runOnIdle {
                assertTrue(phone.store.loggerHidden)
                assertEquals(session, phone.store.session)
                assertEquals(92.5, phone.store.rack!!.weightKg, 0.0)
                assertEquals(7, phone.store.rack!!.reps)
            }
        }
        compose.onNode(hasText("Coach") and hasClickAction()).performClick()
        compose.onNodeWithContentDescription("History").performClick()
        compose.onNodeWithContentDescription(bar).assertDoesNotExist()
        compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithContentDescription(bar).assertIsDisplayed()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription(bar).assertIsDisplayed()
        compose.onNodeWithText("Finish").assertDoesNotExist()
        compose.onNode(hasText("Coach") and hasClickAction()).assertIsSelected()
        val actions = events.filter { it.first == "gym_action" && it.second["action"] in listOf("hide", "open") }
        assertEquals(listOf("workout" to "hide") + List(3) { listOf("workout_bar" to "open", "workout" to "hide") }.flatten(),
            actions.map { it.second["screen"] to it.second["action"] })
        assertTrue(actions.all { it.second["outcome"] == "ok" && it.second.keys == setOf("screen", "action", "outcome") })
    }

    @Test fun managementHideAndNotificationShowHaveSeparateEffectsAndAConsumedOpenDoesNotReplay() = room { phone, restoration, events ->
        val bar = "${Readout.noRoutine}, in progress"
        compose.runOnIdle { assertEquals(WorkoutChange.Saved, phone.store.showWorkout(phone.store.notification.value!!.key, true)) }
        compose.onNodeWithText("Bench Press").performClick()
        compose.onNodeWithText("Notification off").assertIsDisplayed()
        compose.onNodeWithText("Show").performClick()
        compose.onNodeWithText("Notification off").assertDoesNotExist()
        compose.onNodeWithText("Hide workout").performClick()
        compose.onNodeWithContentDescription(bar).assertIsDisplayed()
        compose.runOnIdle { phone.store.requestWorkout() }
        compose.onNodeWithText("Finish").assertIsDisplayed()
        compose.runOnIdle {
            assertFalse(phone.store.loggerHidden)
            assertFalse(phone.store.notification.value!!.hidden)
            assertEquals(0L, phone.store.workoutOpenRequest)
        }
        compose.onNodeWithContentDescription("Hide workout").performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription(bar).assertIsDisplayed()
        compose.onNodeWithText("Finish").assertDoesNotExist()
        assertEquals(listOf(mapOf("screen" to "workout", "action" to "show_notification", "outcome" to "ok")),
            events.filter { it.first == "gym_action" && it.second["action"] == "show_notification" }.map { it.second })
    }
    @Test fun hidingTheLoggerRetainsItsIncompleteSignedBuffer() = room { phone, _, _ ->
        compose.onNodeWithContentDescription("Load, kg total").performClick().performTextReplacement("-")
        compose.onNodeWithContentDescription("Hide workout").performClick()
        compose.onNodeWithContentDescription("${Readout.noRoutine}, in progress").performClick()
        compose.onNodeWithContentDescription("Load, kg total").assertTextEquals("−")
        compose.runOnIdle {
            assertEquals(92.5, phone.store.rack!!.weightKg, 0.0)
            assertEquals(7, phone.store.rack!!.reps)
        }
    }

    @Test fun anUnavailableHideEmitsRefusedAndKeepsTheExistingFailureNote() = room { phone, _, events ->
        compose.runOnIdle { phone.store.authorizeWorkout(false) }
        compose.onNodeWithContentDescription("Hide workout").performClick()
        compose.onNodeWithText("The workout is not ready.").assertIsDisplayed()
        compose.onNodeWithText("Finish").assertIsDisplayed()
        assertEquals(listOf(mapOf("screen" to "workout", "action" to "hide", "outcome" to "refused")),
            events.filter { it.first == "gym_action" && it.second["action"] == "hide" }.map { it.second })
    }

    @Test fun startingFromACoachRoutineDoorReturnsToCoachWhenHidden() {
        val rest = FakeGymRest()
        room(withWorkout = false, rest = rest) { phone, _, _ ->
            val routine = phone.store.routines.first()
            rest.answers += AskAnswer("Your routine is ready.", ReadTally(),
                results = listOf(CoachResult("routine-created", "operation", routine.id, routine.name)))
            compose.onNode(hasText("Coach") and hasClickAction()).performClick()
            compose.onNodeWithContentDescription("Question").performClick().performTextReplacement("Show my routine")
            compose.onNodeWithContentDescription("Send").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Open routine").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Open routine").performClick()
            compose.onNodeWithText("Start workout").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Finish").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("Hide workout").performClick()
            compose.onNode(hasText("Coach") and hasClickAction()).assertIsSelected()
            compose.onNodeWithContentDescription("Push A, in progress").assertIsDisplayed()
        }
    }

}
