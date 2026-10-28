package works.windmill.gym.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import androidx.compose.runtime.CompositionLocalProvider

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LogWeightRowsTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun weightsWithoutWorkoutsHaveIndependentRowsAndOpenBodyweightWithBoundedLabels() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {}
        }
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val day = LocalDate.of(2026, 10, 22)
            val now = day.atTime(12, 45).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            room.now = now
            runBlocking {
                room.select(null)
                assertNull(room.store.weighIn(day.toString(), 82.4))
                assertNull(room.store.weighIn(day.minusDays(1).toString(), 82.2))
            }
            var opens = 0
            compose.setContent { CompositionLocalProvider(LocalTelemetry provides telemetry) {
                GymMaterial { LogScreen(room.store, "A", {}, { opens++ }, {}, {}, now = { room.now }) }
            } }
            compose.onNodeWithText("No workouts yet").assertDoesNotExist()
            compose.onNodeWithText("Bodyweight").assertDoesNotExist()
            compose.onNodeWithTag("weight:$day").assertIsDisplayed()
            compose.onNodeWithTag("weight:${day.minusDays(1)}").assertIsDisplayed()
            compose.onNodeWithText("12:45").assertIsDisplayed()
            compose.onNodeWithText("00:00").assertDoesNotExist()
            compose.onNodeWithTag("weight:$day").performClick()
            assertEquals(1, opens)
            assertEquals(listOf("gym_action" to mapOf("screen" to "log", "action" to "open_bodyweight", "outcome" to "ok")), events)
        } } finally { scope.cancel() }
    }

    @Test
    fun aWeightSwipeUsesTheDurableHoldAndUndoRestoresTheExactFact() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val day = LocalDate.of(2026, 10, 22)
            val now = day.atTime(12, 45).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            room.now = now
            runBlocking { room.select(null); assertNull(room.store.weighIn(day.toString(), 82.4)) }
            val original = room.store.bodyweight
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { room.now }) } }
            compose.onNodeWithTag("weight:$day").performTouchInput { swipeLeft() }
            compose.waitForIdle()
            compose.onNodeWithTag("weight:$day").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(emptyList<WeighIn>(), room.store.bodyweight)
                assertEquals(original, room.store.allWeighIns)
                assertEquals(1, room.engine.undoOffers().size)
                room.store.keepWithheld()
            }
            compose.onNodeWithTag("weight:$day").assertIsDisplayed()
            compose.runOnIdle { assertEquals(original, room.store.bodyweight) }
        } } finally { scope.cancel() }
    }
}
