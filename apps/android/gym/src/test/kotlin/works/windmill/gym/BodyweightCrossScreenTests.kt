package works.windmill.gym

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import java.time.LocalDate
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
import org.robolectric.annotation.Config
import works.windmill.gym.presentation.Bodyweight
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class BodyweightCrossScreenTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    private var showing by mutableStateOf(true)

    @Test fun aBodyweightSwipeKeepsTheSameUndoWhenReturningToTheLog() = swipe(fromBodyweight = true, fail = false)
    @Test fun aLogSwipeKeepsTheSameUndoWhenOpeningBodyweight() = swipe(fromBodyweight = false, fail = false)
    @Test fun aFailedHoldRetainsTheRowAndReportsAnHonestError() = swipe(fromBodyweight = false, fail = true)

    private fun swipe(fromBodyweight: Boolean, fail: Boolean) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val failures = mutableListOf<String>()
        val actions = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action" && properties["screen"] == "bodyweight") actions += properties
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val room = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry)
        val day = LocalDate.now()
        try {
            room.now = System.currentTimeMillis()
            runBlocking {
                room.select(null)
                room.store.bodyweight.weighIn(day.minusDays(1).toString(), 81.4)
                room.store.bodyweight.weighIn(day.toString(), 82.4)
            }
            room.store.observeEngine()
            val original = room.store.bodyweight.drawn
            compose.setContent { if (showing) CompositionLocalProvider(LocalTelemetry provides telemetry) {
                GymMaterial { GymRoom(room.account(), room.store) }
            } }
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            if (fromBodyweight) {
                compose.onNodeWithTag("weight:$day").performClick()
                compose.onNode(hasText("82.4 kg") and hasText(Bodyweight.listDay(day)) and hasClickAction())
                    .performTouchInput { swipeLeft() }
            } else {
                if (fail) compose.runOnIdle { room.engine.failNextCommit() }
                compose.onNodeWithTag("weight:$day").performTouchInput { swipeLeft() }
            }
            compose.waitForIdle()
            if (fail) {
                compose.onNodeWithTag("weight:$day").assertIsDisplayed()
                compose.onNodeWithText("the log didn’t answer — that weigh-in is still on the log").assertIsDisplayed()
                compose.onNodeWithText("Undo").assertDoesNotExist()
                compose.runOnIdle {
                    assertEquals(original, room.store.bodyweight.drawn)
                    assertEquals(emptyList<Any>(), room.engine.undoOffers())
                    assertEquals(listOf("gym.deleteWeighIn"), failures)
                    assertEquals(listOf(mapOf("screen" to "bodyweight", "action" to "delete", "outcome" to "failed")), actions)
                }
                return
            }
            val held = compose.runOnIdle { room.store.held.withheld.single() }
            if (fromBodyweight) compose.onNodeWithContentDescription("Back to The log").performClick()
            else compose.onNodeWithTag("weight:${day.minusDays(1)}").performClick()
            compose.runOnIdle { assertEquals(held, room.store.held.withheld.single()) }
            compose.onNodeWithText("Undo").assertIsDisplayed().performClick()
            if (fromBodyweight) compose.onNodeWithTag("weight:$day").assertIsDisplayed()
            else compose.onNode(hasText("82.4 kg") and hasText(Bodyweight.listDay(day)) and hasClickAction()).assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(original, room.store.bodyweight.drawn)
                assertEquals(emptyList<Any>(), room.engine.undoOffers())
                assertEquals(emptyList<String>(), failures)
                assertEquals(listOf(mapOf("screen" to "bodyweight", "action" to "delete", "outcome" to "held"),
                    mapOf("screen" to "bodyweight", "action" to "undo", "outcome" to "ok")), actions)
            }
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
}
