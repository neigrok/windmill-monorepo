package works.windmill.gym.ui

import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.store.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LogStateTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun newWeighInUsesTheOpeningDayThenRetainsItsDateAndRawRefusalAcrossMidnightAndRestoration() {
        val day = LocalDate.of(2026, 9, 13)
        val zone = ZoneId.systemDefault()
        var clock = day.atTime(23, 59).atZone(zone).toInstant().toEpochMilli()
        lateinit var current: TrainingStore
        var instances = 0
        val restored = StateRestorationTester(compose)
        restored.setContent {
            val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.Main) }
            val store = remember {
                TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")),
                    LocalLog(File(tmp.root, "log")), LocalPreferences(File(tmp.root, "prefs")),
                    LocalBodyweight(File(tmp.root, "weight")), scope, now = { clock }, sync = { null })
                    .also { current = it; instances++ }
            }
            DisposableEffect(scope) { onDispose { scope.cancel() } }
            GymMaterial { LogScreen(store, "A", {}, {}, {}, {}, now = { clock }) }
        }
        compose.runOnIdle { clock = day.plusDays(1).atTime(0, 1).atZone(zone).toInstant().toEpochMilli() }
        compose.onNodeWithText(Bodyweight.chip).performClick()
        compose.onNodeWithText(Bodyweight.fullDay(day.plusDays(1))).assertIsDisplayed()
        compose.onNodeWithContentDescription(weightField).performTextReplacement("82,4.5")
        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.onNodeWithText(Bodyweight.onePoint).assertIsDisplayed()
        compose.runOnIdle { clock = day.plusDays(2).atTime(0, 1).atZone(zone).toInstant().toEpochMilli() }
        restored.emulateSavedInstanceStateRestore()
        compose.onNodeWithText(Bodyweight.fullDay(day.plusDays(1))).assertIsDisplayed()
        compose.onNodeWithText("82,4.5").assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.onePoint).assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.fullDay(day.plusDays(1))).performClick()
        compose.onNodeWithText("Tuesday, September 15, 2026").assertIsEnabled().performClick()
        compose.onNodeWithText("Use this day").performClick()
        compose.onNodeWithText(Bodyweight.fullDay(day.plusDays(2))).assertIsDisplayed()
        compose.onNodeWithContentDescription(weightField).performTextReplacement("82.45")
        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.onNodeWithText(Bodyweight.save).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(2, instances)
            assertEquals(listOf(WeighIn(day.plusDays(2).toString(), 82.45, clock)), current.bodyweight)
        }
    }
}
