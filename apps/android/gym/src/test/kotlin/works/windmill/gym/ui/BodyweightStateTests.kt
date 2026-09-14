package works.windmill.gym.ui

import androidx.activity.ComponentDialog
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import java.io.File
import java.io.IOException
import java.time.LocalDate
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.domain.WeighInWrite
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class BodyweightStateTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val temporary = TemporaryFolder()

    private fun store(scope: CoroutineScope, server: TrainingSyncing) = TrainingStore(
        SetQueue(File(temporary.root, "queue.json")), DeviceCopy(File(temporary.root, "catalog.json")),
        LocalLog(File(temporary.root, "log.json")), LocalPreferences(File(temporary.root, "preferences.json")),
        LocalBodyweight(File(temporary.root, "bodyweight.json")), scope = scope, sync = { server },
    )

    @Test
    fun firstReadAndFailureNeverClaimAnEmptySeriesAndRetryRevealsTheActualDates() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val fake = FakeTraining()
        val gate = CompletableDeferred<Unit>()
        val day = LocalDate.now().minusDays(120)
        var reads = 0
        val server = object : TrainingSyncing by fake {
            override suspend fun bodyweight(from: String?, to: String?): List<WeighIn> {
                reads++
                if (reads == 1) { gate.await(); throw IOException("offline") }
                return listOf(WeighIn(day.toString(), 82.4, 1_000))
            }
        }
        val held = store(scope, server)
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User("u1", "a@example.com"))
        compose.setContent {
            LaunchedEffect(Unit) { held.connect(account) }
            GymMaterial { BodyweightScreen(held, "Log", {}, {}) }
        }
        compose.onNodeWithText("Reading your weigh-ins…").assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.nothingYet).assertDoesNotExist()
        compose.onNodeWithText("90 days").assertDoesNotExist()
        compose.runOnIdle { gate.complete(Unit) }
        compose.onNodeWithText("the log didn’t answer — your weigh-ins didn’t load").assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.nothingYet).assertDoesNotExist()
        compose.onNodeWithText("All").assertDoesNotExist()
        compose.onNodeWithText("Try again").performClick()
        compose.onNodeWithText(Bodyweight.noneInWindow).assertIsDisplayed()
        compose.onNodeWithText("Every weigh-in").assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.listDay(day)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("All").performScrollTo().performClick()
        compose.onNodeWithText("All · 1 weigh-in").assertIsDisplayed()
        compose.runOnIdle { assertEquals(2, reads) }
        scope.cancel()
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

    @Test
    fun correctionRestoresWithAFreshStoreAndOfflineSaveBecomesACommittedPendingRow() {
        val day = LocalDate.now().minusDays(4)
        val fake = FakeTraining().apply { weighIns[day.toString()] = WeighIn(day.toString(), 82.4, 1_000) }
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User("u1", "a@example.com"))
        var instances = 0
        lateinit var current: TrainingStore
        val restored = StateRestorationTester(compose)
        restored.setContent {
            val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.Main) }
            val held = remember { store(scope, fake).also { current = it; instances++ } }
            DisposableEffect(scope) { onDispose { scope.cancel() } }
            LaunchedEffect(held) { held.connect(account) }
            GymMaterial { BodyweightScreen(held, "Log", {}, {}) }
        }
        compose.onNodeWithText(Bodyweight.listDay(day)).performScrollTo().performClick()
        compose.onNodeWithContentDescription(weightField).performTextReplacement("82,4.5")
        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.runOnIdle { fake.online = false }
        restored.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("82,4.5").assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.onePoint).assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.fullDay(day)).assertIsDisplayed()
        compose.onNodeWithContentDescription(weightField).performTextReplacement("82,45")
        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.onNodeWithText("82.45 kg").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.save).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(2, instances)
            assertEquals(listOf(day.toString() to 82.45), current.bodyweight.map { it.dateLocal to it.weightKg })
            assertEquals(82.4, fake.weighIns.getValue(day.toString()).weightKg, 0.0)
        }
    }

    @Test
    fun pendingCorrectionBlocksDialogDismissalAndRefusalKeepsItsDraftForRetry() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val day = LocalDate.now().minusDays(2)
        val original = WeighIn(day.toString(), 82.0, 1_000)
        val fake = FakeTraining().apply { weighIns[day.toString()] = original }
        val gate = CompletableDeferred<Unit>()
        val writes = mutableListOf<Pair<String, Double>>()
        val server = object : TrainingSyncing by fake {
            override suspend fun putBodyweight(dateLocal: String, write: WeighInWrite): WeighIn {
                writes += dateLocal to write.weightKg
                if (writes.size == 1) {
                    gate.await()
                    throw WindmillApiException.Refused(400, Refusal(code = "weight-refused", message = "That correction was refused."))
                }
                return fake.putBodyweight(dateLocal, write)
            }
        }
        val held = store(scope, server)
        runBlocking { held.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User("u1", "a@example.com"))) }
        compose.setContent { GymMaterial { BodyweightScreen(held, "Log", {}, {}) } }
        compose.onNodeWithText(Bodyweight.listDay(day)).performScrollTo().performClick()
        compose.onNodeWithContentDescription(weightField).performTextReplacement("83,25")
        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.onNodeWithText("Saving…").assertIsNotEnabled().performClick()
        compose.onNodeWithText(Bodyweight.deleteRow).assertIsNotEnabled()
        compose.onNodeWithContentDescription(weightField).assertIsNotEnabled()
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.onNode(hasContentDescription("Close sheet")).performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("83,25").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(day.toString() to 83.25), writes); gate.complete(Unit) }
        compose.onNodeWithText("That correction was refused.").assertIsDisplayed()
        compose.onNodeWithText("83,25").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(original), held.bodyweight) }
        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.onNodeWithText("83.25 kg").performScrollTo().assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(listOf(day.toString() to 83.25, day.toString() to 83.25), writes)
            assertEquals(listOf(day.toString() to 83.25), held.bodyweight.map { it.dateLocal to it.weightKg })
        }
        scope.cancel()
    }
}
