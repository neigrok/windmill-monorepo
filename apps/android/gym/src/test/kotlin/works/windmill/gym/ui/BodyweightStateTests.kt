package works.windmill.gym.ui

import android.os.Looper
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import java.time.LocalDate
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.sync.modelserver.ModelServer

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class BodyweightStateTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val temporary = TemporaryFolder()

    // The series is the account's: another phone weighs in and syncs, on the phone's own clock.
    private fun weighedElsewhere(scope: CoroutineScope, server: ModelServer, day: LocalDate, kg: Double) =
        EngineRoomFixture(temporary.newFolder(), scope).use { other -> runBlocking {
            other.now = System.currentTimeMillis()
            other.select("u1"); other.pull(server)
            assertNull(other.store.weighIn(day.toString(), kg))
            other.sync(server)
        } }

    @Test
    fun anUnreadSeriesNeverClaimsEmptyAndTheFirstPullRevealsTheActualDates() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(temporary.newFolder(), scope).use { room ->
            val server = EngineRoomFixture.server()
            val day = LocalDate.now().minusDays(120)
            weighedElsewhere(scope, server, day, 82.4)
            room.now = System.currentTimeMillis()
            runBlocking { room.select("u1") }
            room.store.observeEngine()
            compose.setContent { GymMaterial { BodyweightScreen(room.store, "Log", {}, {}) } }
            compose.onNodeWithText("Reading your weigh-ins…").assertIsDisplayed()
            compose.onNodeWithText(Bodyweight.nothingYet).assertDoesNotExist()
            compose.onNodeWithText("90 days").assertDoesNotExist()
            compose.onNodeWithText("All").assertDoesNotExist()
            compose.runOnIdle { room.pull(server) }
            compose.waitUntil(2_000) {
                shadowOf(Looper.getMainLooper()).idle()
                room.store.bodyweightRead
            }
            compose.onNodeWithText(Bodyweight.nothingYet).assertDoesNotExist()
            compose.onNodeWithText(Bodyweight.noneInWindow).assertIsDisplayed()
            compose.onNodeWithText("Every weigh-in").assertIsDisplayed()
            compose.onNodeWithText(Bodyweight.listDay(day)).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("All").performScrollTo().performClick()
            compose.onNodeWithText("All · 1 weigh-in").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun rawRefusalAndSelectedDateSurviveRestorationAndCancelCommitsNothing() {
        val day = LocalDate.now().minusDays(3)
        val saved = mutableListOf<Pair<String, Double>>()
        val restored = StateRestorationTester(compose)
        restored.setContent {
            GymMaterial {
                WeighInSheet(WeighIn(day.toString(), 82.4, 1_000), null, System.currentTimeMillis(), false, null,
                    { date, weight -> saved += date to weight }, null, draftKey = "u1:new")
            }
        }
        compose.onNodeWithContentDescription(weightField).performTextReplacement("82,4.5")
        compose.onNodeWithText(Bodyweight.save).performClick()
        restored.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("82,4.5").assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.onePoint).assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.fullDay(day)).assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.fullDay(day)).performClick()
        compose.onNodeWithText("Keep it").performClick()
        compose.onNodeWithText("82,4.5").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<Pair<String, Double>>(), saved) }
    }
}
