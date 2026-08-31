package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import java.io.File
import java.time.LocalDate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ChartWindow
import works.windmill.gym.domain.Units
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.store.WriteFailure
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class BodyweightScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val today: LocalDate = LocalDate.now()

    private fun store(scope: CoroutineScope, server: FakeTraining?): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { server },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = if (server == null) null else User(id = "u1", email = "sam@example.com", name = "Sam"),
            ))
        }
        return store
    }

    private fun log(store: TrainingStore, doors: MutableList<String>) {
        compose.setContent {
            LogScreen(
                store = store,
                seat = "",
                onOpenSession = { doors += "session" },
                onOpenBodyweight = { doors += "bodyweight" },
                onShareSession = { doors += "share" },
                onDiscardSession = { doors += "discard" },
            )
        }
    }

    @Test
    fun theLogHeadDrawsNoReadingUntilThereIsAWeighInAndThenItsAge() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val doors = mutableListOf<String>()
        val store = store(scope, server)
        log(store, doors)

        compose.onNodeWithText("kg ·", substring = true).assertDoesNotExist()
        compose.onNodeWithText(Bodyweight.chip).assertIsDisplayed()

        runBlocking { store.weighIn(today.minusDays(3).toString(), 82.4) }
        compose.onNodeWithText("82.4 kg · 3 days ago").assertIsDisplayed()
        compose.onNodeWithText("82.4 kg · 3 days ago").performClick()
        compose.runOnIdle { assertEquals(listOf("bodyweight"), doors) }
        scope.cancel()
    }

    @Test
    fun theChipOpensTheSheetAndASavedWeighInLandsOnTheDeviceAndTheLog() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        log(store, mutableListOf())

        compose.onNodeWithText(Bodyweight.chip).performClick()
        compose.onNodeWithText(Bodyweight.fieldHint).assertIsDisplayed()
        compose.onNodeWithText("Today · ", substring = true).assertIsDisplayed()
        compose.onNodeWithContentDescription(weightField).performTextInput("82,4")
        compose.onNodeWithText(Bodyweight.save).performClick()

        compose.runOnIdle {
            assertEquals(listOf(today.toString() to 82.4), store.bodyweight.map { it.dateLocal to it.weightKg })
            assertEquals(listOf("putBodyweight"), server.calls.filter { it == "putBodyweight" })
            assertEquals(82.4, server.weighIns.getValue(today.toString()).weightKg, 0.0)
        }
        compose.onNodeWithText("82.4 kg · today").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun theSheetRefusesInPlaceOneThingAtATimeAndWritesNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        log(store, mutableListOf())

        compose.onNodeWithText(Bodyweight.chip).performClick()
        val field = compose.onNodeWithContentDescription(weightField)

        field.performTextInput("abc")
        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.onNodeWithText("That is not a number yet.").assertIsDisplayed()

        field.performTextClearance()
        field.performTextInput("1.2.3")
        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.onNodeWithText("One decimal point only.").assertIsDisplayed()
        compose.onNodeWithText("That is not a number yet.").assertDoesNotExist()

        field.performTextClearance()
        field.performTextInput("500")
        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.onNodeWithText("Between 20 and 400 kg — check the number.").assertIsDisplayed()

        compose.runOnIdle {
            assertTrue(store.bodyweight.isEmpty())
            assertTrue(server.weighIns.isEmpty())
        }
        scope.cancel()
    }

    @Test
    fun signedOutAWeighInLivesOnTheDeviceAndTheReadingDrawsIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope, server = null)
        log(store, mutableListOf())

        compose.onNodeWithText(Bodyweight.chip).performClick()
        compose.onNodeWithContentDescription(weightField).performTextInput("81")
        compose.onNodeWithText(Bodyweight.save).performClick()

        compose.runOnIdle { assertEquals(81.0, store.latestWeighIn!!.weightKg, 0.0) }
        compose.onNodeWithText("81 kg · today").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun theChartNamesItsWindowLeavesALongGapEmptyAndSaysWhy() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        runBlocking {
            store.weighIn(today.minusDays(20).toString(), 84.0)
            store.weighIn(today.minusDays(16).toString(), 83.6)
            store.weighIn(today.minusDays(4).toString(), 82.9)
            store.weighIn(today.toString(), 82.4)
        }
        compose.setContent {
            BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
        }

        compose.onNodeWithText(Bodyweight.title).assertIsDisplayed()
        compose.onNodeWithText("90 days").assertIsDisplayed().assertIsSelected()
        compose.onNodeWithText("All").assertIsDisplayed().assertIsNotSelected()
        compose.onNodeWithText("last 90 days · 4 weigh-ins").assertIsDisplayed()
        compose.onNodeWithText("85 kg").assertIsDisplayed()
        compose.onNodeWithText("81 kg").assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.gapRule).performScrollTo().assertIsDisplayed()
        val gap = "no weigh-in · ${Bodyweight.shortDay(today.minusDays(16))} – ${Bodyweight.shortDay(today.minusDays(4))}"
        compose.onNodeWithText(gap).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("goal", substring = true).assertDoesNotExist()
        compose.onNodeWithText("BMI", substring = true).assertDoesNotExist()

        compose.onNodeWithText("All").performScrollTo().performClick()
        compose.onNodeWithText("All").assertIsSelected()
        compose.onNodeWithText("90 days").assertIsNotSelected()
        compose.onNodeWithText("the whole series · 4 weigh-ins").performScrollTo().assertIsDisplayed()
        scope.cancel()
    }

    // The gap rule is the chart's disclosure about its own segments, so it is on screen exactly when
    // a chart is — never under `no weigh-in in the last 90 days`, which draws no line to read.
    @Test
    fun theGapRuleIsDrawnWithTheChartAndNotOverAnEmptyWindow() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        runBlocking {
            store.weighIn(today.minusDays(200).toString(), 84.0)
            store.weighIn(today.minusDays(150).toString(), 83.0)
        }
        compose.setContent {
            BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
        }

        compose.onNodeWithText("last 90 days · 0 weigh-ins").assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.noneInWindow).assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.gapRule).assertDoesNotExist()

        compose.onNodeWithText("All").performScrollTo().performClick()
        compose.onNodeWithText("the whole series · 2 weigh-ins").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.noneInWindow).assertDoesNotExist()
        compose.onNodeWithText(Bodyweight.gapRule).performScrollTo().assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun tappingADotOpensTheSameSheetWithTheDateFixedAndADeleteThatTakesTheWindow() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        val day = today.minusDays(2)
        runBlocking {
            store.weighIn(day.toString(), 82.9)
            store.weighIn(today.toString(), 82.4)
        }
        compose.setContent {
            BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
        }

        compose.onNodeWithContentDescription("82.9 kg · ${Bodyweight.shortDay(day)}").performClick()
        compose.onNodeWithText("Weigh-in · ${Bodyweight.shortDay(day)}").assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.deleteRow).assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.dayLine(day, today)).assertIsDisplayed()

        // The ORDER, frame by frame: the sheet is awaited all the way down BEFORE the window opens.
        // A ModalBottomSheet renders above the room's SnackbarHost, so a withhold in the same frame
        // as the hide puts the only Undo there is behind a sheet still animating out. Nothing at
        // rest can tell the two apart, so the clock is driven by hand.
        compose.mainClock.autoAdvance = false
        compose.onNodeWithText(Bodyweight.deleteRow).performClick()
        var opened = false
        repeat(120) {
            compose.mainClock.advanceTimeByFrame()
            val onScreen = compose.onAllNodesWithText(Bodyweight.deleteRow)
                .fetchSemanticsNodes().any { node -> node.boundsInWindow.height > 0f }
            if (store.withheld.isNotEmpty()) {
                assertTrue("the Undo may not open under a sheet still on screen", !onScreen)
                opened = true
            }
        }
        compose.mainClock.autoAdvance = true
        assertTrue("and it does open, once the sheet is off the tree", opened)

        compose.runOnIdle {
            assertEquals("nothing is asked and NOTHING is sent while the window is open",
                emptyList<String>(), server.calls.filter { it == "deleteBodyweight" })
            assertEquals("still on the log", listOf(day.toString(), today.toString()),
                server.weighIns.keys.sorted())
            assertEquals("and off the series for every reader at once — the chart and the head reading",
                listOf(today.toString()), store.bodyweight.map { it.dateLocal })
            assertEquals(listOf(day.toString()), store.withheld.map { it.subjectId })
        }
        compose.onNodeWithText(Bodyweight.deleteRow).assertDoesNotExist()

        compose.runOnIdle { assertNotNull(store.keepWithheld()) }
        compose.runOnIdle {
            assertEquals("Undo puts the day back", listOf(day.toString(), today.toString()),
                store.bodyweight.map { it.dateLocal })
            assertEquals(emptyList<String>(), server.calls.filter { it == "deleteBodyweight" })
        }

        // One filter, in the store: the log's head reading reads the same series the chart does, so
        // one screen can never keep drawing a day the other has already dropped.
        compose.runOnIdle {
            store.withhold(Deletion.Bodyweight(today.toString()))
            assertEquals(day.toString(), store.latestWeighIn?.dateLocal)
        }
        scope.cancel()
    }

    @Test
    fun aRepairedWeighInIsWrittenUnderTheDotsOwnDate() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        val day = today.minusDays(1)
        runBlocking { store.weighIn(day.toString(), 182.0) }
        compose.setContent {
            BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
        }

        compose.onNodeWithContentDescription("182 kg · ${Bodyweight.shortDay(day)}").performClick()
        val field = compose.onNodeWithContentDescription(weightField)
        field.performTextClearance()
        field.performTextInput("82")
        compose.onNodeWithText(Bodyweight.save).performClick()

        compose.runOnIdle {
            assertEquals(listOf(day.toString() to 82.0), store.bodyweight.map { it.dateLocal to it.weightKg })
            assertEquals(82.0, server.weighIns.getValue(day.toString()).weightKg, 0.0)
        }
        scope.cancel()
    }

    @Test
    fun aWeighInDatedTomorrowIsRefusedAtTheFieldAndByTheLogInTheSameWords() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        val tomorrow = today.plusDays(1)
        val saved = mutableListOf<String>()
        compose.setContent {
            WeighInSheet(
                initial = WeighIn(tomorrow.toString(), 82.4, 1_000), fixedDate = null,
                nowMs = System.currentTimeMillis(), units = Units.Kilograms, saving = false, refused = null,
                onSave = { dateLocal, _ -> saved += dateLocal }, onDelete = null,
            )
        }

        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.onNodeWithText("A weigh-in is not a forecast — today or earlier.").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<String>(), saved) }

        // The log's own refusal, in the same words, for a date this phone's clock could not catch.
        val refused = runBlocking { store.weighIn(today.plusDays(3).toString(), 82.4) }
        assertEquals(WriteFailure.Refused(Bodyweight.notAForecast), refused)
        assertTrue("a refused row is let go, not kept owed", store.bodyweight.isEmpty())
        assertTrue(server.weighIns.isEmpty())
        scope.cancel()
    }

    // Dots a day apart are 3 dp apart at the 90-day scale: the tap goes to the nearest dot, never to
    // whichever neighbour was drawn last.
    @Test
    fun tappingADotADayBeforeItsNeighbourOpensThatDotAndNotTheNeighbour() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        val earlier = today.minusDays(2)
        val later = today.minusDays(1)
        runBlocking {
            store.weighIn(today.minusDays(60).toString(), 80.0)
            store.weighIn(today.minusDays(30).toString(), 90.0)
            store.weighIn(earlier.toString(), 82.9)
            store.weighIn(later.toString(), 83.0)
        }
        compose.setContent {
            BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
        }

        compose.onNodeWithContentDescription("82.9 kg · ${Bodyweight.shortDay(earlier)}")
            .performTouchInput { click(center) }
        compose.onNodeWithText(Bodyweight.dayLine(later, today)).assertDoesNotExist()
        compose.onNodeWithText(Bodyweight.dayLine(earlier, today)).assertIsDisplayed()
        compose.onNodeWithText("82.9").assertIsDisplayed()
        scope.cancel()
    }

    // B2's client half on the screens: a row the log served dated past this phone's today is neither
    // the reading at the head of the log nor a dot on the chart.
    @Test
    fun aServedFutureRowIsNeitherTheReadingNorADot() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val tomorrow = today.plusDays(1)
        server.weighIns[tomorrow.toString()] = WeighIn(tomorrow.toString(), 90.0, 5_000)
        server.weighIns[today.minusDays(3).toString()] = WeighIn(today.minusDays(3).toString(), 82.4, 4_000)
        val store = store(scope, server)
        compose.setContent {
            BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
        }

        compose.runOnIdle {
            assertEquals("the served row is held, only never drawn", 2, store.bodyweight.size)
            assertEquals(today.minusDays(3).toString(), store.latestWeighIn?.dateLocal)
        }
        compose.onNodeWithText("last 90 days · 1 weigh-in").assertIsDisplayed()
        compose.onNodeWithContentDescription("82.4 kg · ${Bodyweight.shortDay(today.minusDays(3))}").assertIsDisplayed()
        compose.onNodeWithContentDescription("90 kg · ${Bodyweight.shortDay(tomorrow)}").assertDoesNotExist()
        compose.onNodeWithText("All").performScrollTo().performClick()
        compose.onNodeWithText("the whole series · 1 weigh-in").performScrollTo().assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun theLogHeadReadsThePastWeighInOverAServedFutureOne() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val tomorrow = today.plusDays(1)
        server.weighIns[tomorrow.toString()] = WeighIn(tomorrow.toString(), 90.0, 5_000)
        server.weighIns[today.minusDays(3).toString()] = WeighIn(today.minusDays(3).toString(), 82.4, 4_000)
        val store = store(scope, server)
        log(store, mutableListOf())

        compose.onNodeWithText("82.4 kg · 3 days ago").assertIsDisplayed()
        compose.onNodeWithText("90 kg", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    // `4n`: a window decides which ROWS are drawn; it never decides what state a screen is in. The
    // nine seconds of an open delete had this screen standing on `No weigh-ins yet` — the stance for
    // a lifter who has never weighed in — over a series that still held the number, with Undo up.
    @Test
    fun aHeldDeleteOfTheOnlyWeighInNeverDrawsTheNeverWeighedInStance() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        runBlocking { store.weighIn(today.toString(), 82.4) }
        compose.setContent {
            BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
        }

        compose.runOnIdle { store.withhold(Deletion.Bodyweight(today.toString())) }
        compose.onNodeWithText(Bodyweight.nothingYet).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("the store still holds it, which is what Undo puts back",
                listOf(today.toString()), store.allWeighIns.map { it.dateLocal })
            assertEquals(emptyList<String>(), store.bodyweight.map { it.dateLocal })
        }
        // The rows keep reading the window: the dot is off the chart and the count says so.
        compose.onNodeWithText(Bodyweight.windowLine(ChartWindow.Ninety, 0)).assertIsDisplayed()
        compose.onNodeWithText(Bodyweight.noneInWindow).assertIsDisplayed()

        compose.runOnIdle { assertNotNull(store.keepWithheld()) }
        compose.onNodeWithText(Bodyweight.windowLine(ChartWindow.Ninety, 1)).assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun nothingLoggedYetDrawsOneLineAndNoChart() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope, FakeTraining())
        compose.setContent {
            BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
        }
        compose.onNodeWithText(Bodyweight.nothingYet).assertIsDisplayed()
        compose.onNodeWithText("90 days").assertDoesNotExist()
        scope.cancel()
    }
}
