package works.windmill.gym.ui

import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.store.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LogStateTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    // The room's clock is the one clock here: the screen reads it, and the store ticks it once per read.
    @Test
    fun newWeighInUsesTheOpeningDayThenRetainsItsDateAndRawRefusalAcrossMidnightAndRestoration() {
        val day = LocalDate.of(2026, 9, 13)
        val zone = ZoneId.systemDefault()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            room.now = day.atTime(23, 59).atZone(zone).toInstant().toEpochMilli()
            lateinit var current: TrainingStore
            var instances = 0
            val restored = StateRestorationTester(compose)
            restored.setContent {
                val storeScope = remember { CoroutineScope(SupervisorJob() + Dispatchers.Main) }
                val store = remember {
                    room.freshStore(storeScope).also { fresh ->
                        runBlocking { fresh.connect(room.account()) }
                        current = fresh
                        instances++
                    }
                }
                DisposableEffect(storeScope) { onDispose { storeScope.cancel() } }
                GymMaterial { LogScreen(store, "A", {}, {}, {}, {}, now = { room.now }) }
            }
            compose.runOnIdle { room.now = day.plusDays(1).atTime(0, 1).atZone(zone).toInstant().toEpochMilli() }
            compose.onNodeWithText(Bodyweight.chip).performClick()
            compose.onNodeWithText(Bodyweight.fullDay(day.plusDays(1))).assertIsDisplayed()
            compose.onNodeWithContentDescription(weightField).performTextReplacement("82,4.5")
            compose.onNodeWithText(Bodyweight.save).performClick()
            compose.onNodeWithText(Bodyweight.onePoint).assertIsDisplayed()
            compose.runOnIdle { room.now = day.plusDays(2).atTime(0, 1).atZone(zone).toInstant().toEpochMilli() }
            restored.emulateSavedInstanceStateRestore()
            compose.onNodeWithText(Bodyweight.fullDay(day.plusDays(1))).assertIsDisplayed()
            compose.onNodeWithText("82,4.5").assertIsDisplayed()
            compose.onNodeWithText(Bodyweight.onePoint).assertIsDisplayed()
            compose.onNodeWithText(Bodyweight.fullDay(day.plusDays(1))).performClick()
            compose.onNodeWithText("Tuesday, September 15, 2026").assertIsEnabled().performClick()
            compose.onNodeWithText("Use this day").performClick()
            compose.onNodeWithText(Bodyweight.fullDay(day.plusDays(2))).assertIsDisplayed()
            compose.onNodeWithContentDescription(weightField).performTextReplacement("82.45")
            val saving = compose.runOnIdle { room.now }
            compose.onNodeWithText(Bodyweight.save).performClick()
            compose.onNodeWithText(Bodyweight.save).assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(2, instances)
                assertEquals(listOf(day.plusDays(2).toString() to 82.45), current.bodyweight.map { it.dateLocal to it.weightKg })
                assertTrue("recorded at the save", current.bodyweight.single().recordedAt in saving..room.now)
                assertEquals("as the replica holds it", room.training.weighins(), current.bodyweight)
            }
        } } finally { scope.cancel() }
    }
}
