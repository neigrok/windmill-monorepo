package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.SemanticsProperties
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
import java.time.LocalDate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.LogReadout
import works.windmill.gym.domain.ChartWindow
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.sync.core.Json
import works.windmill.sync.modelserver.ModelServer

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class BodyweightScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val today: LocalDate = LocalDate.now()

    // On the phone's own clock, because the screens compare a weigh-in's day with the phone's today.
    private fun store(room: EngineRoomFixture, server: ModelServer?): TrainingStore {
        room.now = System.currentTimeMillis()
        runBlocking {
            if (server == null) room.select(null)
            else { room.select("u1"); room.pull(server); room.store.refreshEngine() }
        }
        return room.store
    }

    // A phone a day ahead of this one writes the account's weigh-ins, its tomorrow among them.
    private fun aheadWrites(room: EngineRoomFixture, server: ModelServer, vararg weighIns: Pair<LocalDate, Double>): List<WeighIn> =
        EngineRoomFixture(tmp.newFolder(), room.scope).use { other -> runBlocking {
            other.now = System.currentTimeMillis() + 86_400_000
            other.select("u1"); other.pull(server)
            for ((day, kg) in weighIns) assertNull(other.store.weighIn(day.toString(), kg))
            other.sync(server)
            other.training.weighins()
        } }

    // What the log holds, read by a phone that pulls it fresh.
    private fun onTheLog(room: EngineRoomFixture, server: ModelServer): List<Pair<String, Double>> =
        EngineRoomFixture(tmp.newFolder(), room.scope).use { reader -> runBlocking {
            reader.select("u1"); reader.pull(server)
            reader.training.weighins().map { it.dateLocal to it.weightKg }
        } }

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
    fun aWeighInAppearsAsADatedMomentEvenWithoutAWorkout() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val doors = mutableListOf<String>()
            val store = store(room, EngineRoomFixture.server())
            log(store, doors)

            compose.onNodeWithText("kg").assertDoesNotExist()
            compose.onNodeWithText(Bodyweight.chip).assertIsDisplayed()

            runBlocking { store.weighIn(today.minusDays(3).toString(), 82.4) }
            compose.onNodeWithText("Weighed in · 82.4 kg").assertIsDisplayed()
            compose.onNodeWithText(works.windmill.gym.domain.LogReadout.day(today.minusDays(3), System.currentTimeMillis(), java.time.ZoneId.systemDefault())).assertIsDisplayed()
            compose.onNodeWithText("Weighed in · 82.4 kg").performClick()
            compose.runOnIdle { assertEquals(listOf("bodyweight"), doors) }
        } } finally { scope.cancel() }
    }

    @Test
    fun theChipOpensTheSheetAndASavedWeighInLandsOnTheDeviceAndTheLog() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = EngineRoomFixture.server()
            val store = store(room, server)
            log(store, mutableListOf())

            compose.onNodeWithText(Bodyweight.chip).performClick()
            compose.onNodeWithText(Bodyweight.unit).assertIsDisplayed()
            compose.onNodeWithText("comma or point", substring = true).assertDoesNotExist()
            compose.onNodeWithText(Bodyweight.fullDay(today)).assertIsDisplayed()
            compose.onNodeWithContentDescription(weightField).performTextInput("82,4")
            compose.onNodeWithText(Bodyweight.save).performClick()

            compose.runOnIdle {
                assertEquals(listOf(today.toString() to 82.4), store.bodyweight.map { it.dateLocal to it.weightKg })
                assertEquals(listOf(today.toString() to 82.4), room.training.weighins().map { it.dateLocal to it.weightKg })
                room.sync(server)
            }
            assertEquals(listOf(today.toString() to 82.4), onTheLog(room, server))
            compose.onNodeWithText("Weighed in · 82.4 kg").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun theSheetRefusesInPlaceOneThingAtATimeAndWritesNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room, EngineRoomFixture.server())
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
                assertTrue(room.training.weighins().isEmpty())
                assertEquals(emptyList<Json>(), room.outbox())
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun signedOutAWeighInLivesOnTheDeviceAndDrawsADatedMoment() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room, server = null)
            val doors = mutableListOf<String>()
            log(store, doors)

            compose.onNodeWithText(Bodyweight.chip).performClick()
            compose.onNodeWithContentDescription(weightField).performTextInput("81")
            compose.onNodeWithText(Bodyweight.save).performClick()

            compose.runOnIdle {
                assertEquals(today.toString(), store.latestWeighIn!!.dateLocal)
                assertEquals(81.0, store.latestWeighIn!!.weightKg, 0.0)
                assertEquals("the anonymous replica holds it", listOf(store.latestWeighIn!!), room.training.weighins())
            }
            compose.onNodeWithText("Weighed in · 81 kg").assertIsDisplayed()
            compose.onNodeWithText(LogReadout.day(today, System.currentTimeMillis(), java.time.ZoneId.systemDefault())).assertIsDisplayed()
            compose.onNodeWithText("Weighed in · 81 kg").performClick()
            compose.runOnIdle { assertEquals(listOf("bodyweight"), doors) }
        } } finally { scope.cancel() }
    }

    @Test
    fun theChartNamesItsWindowLeavesALongGapEmptyAndSaysWhy() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room, EngineRoomFixture.server())
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
            compose.onNodeWithText("90 days · 4 weigh-ins").assertIsDisplayed()
            compose.onNodeWithText("no line is drawn", substring = true).assertDoesNotExist()
            val gap = "no weigh-in · ${Bodyweight.shortDay(today.minusDays(16))} – ${Bodyweight.shortDay(today.minusDays(4))}"
            compose.onNodeWithText(gap).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("goal", substring = true).assertDoesNotExist()
            compose.onNodeWithText("BMI", substring = true).assertDoesNotExist()

            compose.onNodeWithText("All").performScrollTo().performClick()
            compose.onNodeWithText("All").assertIsSelected()
            compose.onNodeWithText("90 days").assertIsNotSelected()
            compose.onNodeWithText("All · 4 weigh-ins").performScrollTo().assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // A gap in the line reads as a gap: no legend explains it under either window, and the empty
    // ninety-day window says only that it is empty.
    @Test
    fun theChartCarriesNoLegendForItsGapsUnderEitherWindow() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room, EngineRoomFixture.server())
            runBlocking {
                store.weighIn(today.minusDays(200).toString(), 84.0)
                store.weighIn(today.minusDays(150).toString(), 83.0)
            }
            compose.setContent {
                BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
            }

            compose.onNodeWithText("90 days · 0 weigh-ins").assertIsDisplayed()
            compose.onNodeWithText(Bodyweight.noneInWindow).assertIsDisplayed()
            compose.onNodeWithText("no line is drawn", substring = true).assertDoesNotExist()

            compose.onNodeWithText("All").performScrollTo().performClick()
            compose.onNodeWithText("All · 2 weigh-ins").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(Bodyweight.noneInWindow).assertDoesNotExist()
            compose.onNodeWithText("no line is drawn", substring = true).assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    @Test
    fun tappingADatedRowOpensTheSheetWithItsDateFixedAndDeleteAwaitsDismissal() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = EngineRoomFixture.server()
            val store = store(room, server)
            val day = today.minusDays(2)
            runBlocking {
                store.weighIn(day.toString(), 82.9)
                store.weighIn(today.toString(), 82.4)
            }
            room.sync(server)
            compose.setContent {
                BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
            }

            compose.onNodeWithText(Bodyweight.listDay(day)).performScrollTo().performClick()
            compose.onNodeWithText("Weigh in").assertIsDisplayed()
            compose.onNodeWithText(Bodyweight.deleteRow).assertIsDisplayed()
            compose.onNodeWithText(Bodyweight.fullDay(day)).assertIsDisplayed()

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
                assertEquals("nothing is asked and NOTHING is written while the window is open",
                    emptyList<Json>(), room.outbox())
                assertEquals("still on the log", listOf(day.toString(), today.toString()),
                    room.training.weighins().map { it.dateLocal }.sorted())
                assertEquals("and off the series for every reader at once — the chart and the head reading",
                    listOf(today.toString()), store.bodyweight.map { it.dateLocal })
                assertEquals(listOf(day.toString()), store.withheld.map { it.subjectId })
            }
            compose.onNodeWithText(Bodyweight.deleteRow).assertDoesNotExist()

            compose.runOnIdle { assertNotNull(store.keepWithheld()) }
            compose.runOnIdle {
                assertEquals("Undo puts the day back", listOf(day.toString(), today.toString()),
                    store.bodyweight.map { it.dateLocal })
                assertEquals(emptyList<Json>(), room.outbox())
            }

            // One filter, in the store: the log's head reading reads the same series the chart does, so
            // one screen can never keep drawing a day the other has already dropped.
            compose.runOnIdle {
                store.withhold(Deletion.Bodyweight(today.toString()))
                assertEquals(day.toString(), store.latestWeighIn?.dateLocal)
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun aWeighInDatedTomorrowIsRefusedAtTheFieldAndByTheLogInTheSameWords() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room, EngineRoomFixture.server())
            val tomorrow = today.plusDays(1)
            val saved = mutableListOf<String>()
            compose.setContent {
                WeighInSheet(
                    initial = WeighIn(tomorrow.toString(), 82.4, 1_000), fixedDate = null,
                    nowMs = System.currentTimeMillis(), saving = false, refused = null,
                    onSave = { dateLocal, _ -> saved += dateLocal }, onDelete = null,
                )
            }

            compose.onNodeWithText(Bodyweight.save).performClick()
            compose.onNodeWithText("A weigh-in is not a forecast — today or earlier.").assertIsDisplayed()
            compose.onNodeWithContentDescription("Date, ${Bodyweight.fullDay(tomorrow)}")
                .assert(SemanticsMatcher.expectValue(SemanticsProperties.Error, Bodyweight.notAForecast))
            compose.runOnIdle { assertEquals(emptyList<String>(), saved) }

            // Past the field, the store refuses a forecast in the same words.
            val refused = runBlocking { store.weighIn(today.plusDays(3).toString(), 82.4) }
            assertEquals(WriteFailure.Refused(Bodyweight.notAForecast), refused)
            assertTrue("a refused row is let go, not kept owed", store.bodyweight.isEmpty())
            assertTrue(room.training.weighins().isEmpty())
            assertEquals(emptyList<Json>(), room.outbox())
        } } finally { scope.cancel() }
    }

    @Test
    fun nearbyDatesHaveSeparateAccessibleCorrectionRows() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room, EngineRoomFixture.server())
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

            compose.onNodeWithText(Bodyweight.listDay(earlier)).performScrollTo().performClick()
            compose.onNodeWithText(Bodyweight.fullDay(later)).assertDoesNotExist()
            compose.onNodeWithText(Bodyweight.fullDay(earlier)).assertIsDisplayed()
            compose.onNodeWithText("82.9").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // A served future row is not a chart point or a Log moment.
    @Test
    fun aServedFutureRowIsNeitherTheReadingNorADot() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = EngineRoomFixture.server()
            val tomorrow = today.plusDays(1)
            aheadWrites(room, server, tomorrow to 90.0, today.minusDays(3) to 82.4)
            val store = store(room, server)
            compose.setContent {
                BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
            }

            compose.runOnIdle {
                assertEquals("the served row is held, only never drawn", 2, store.bodyweight.size)
                assertEquals(today.minusDays(3).toString(), store.latestWeighIn?.dateLocal)
            }
            compose.onNodeWithText("90 days · 1 weigh-in").assertIsDisplayed()
            compose.onNodeWithText(Bodyweight.listDay(today.minusDays(3))).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(Bodyweight.listDay(tomorrow)).assertDoesNotExist()
            compose.onNodeWithText("All").performScrollTo().performClick()
            compose.onNodeWithText("All · 1 weigh-in").performScrollTo().assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun theLogDrawsThePastWeighInMomentAndExcludesAServedFutureOne() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = EngineRoomFixture.server()
            val tomorrow = today.plusDays(1)
            val past = today.minusDays(3)
            val served = aheadWrites(room, server, tomorrow to 90.0, past to 82.4)
            val pastEntry = served.single { it.dateLocal == past.toString() }
            val futureEntry = served.single { it.dateLocal == tomorrow.toString() }
            val store = store(room, server)
            val doors = mutableListOf<String>()
            log(store, doors)

            compose.onNodeWithText("Weighed in · 82.4 kg").assertIsDisplayed()
            compose.onNodeWithText(LogReadout.day(past, System.currentTimeMillis(), java.time.ZoneId.systemDefault())).assertIsDisplayed()
            compose.onNodeWithText("Weighed in · 90 kg").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(listOf(pastEntry, futureEntry), store.bodyweight.sortedBy { it.dateLocal })
                assertEquals(pastEntry, store.latestWeighIn)
            }
            compose.onNodeWithText("Weighed in · 82.4 kg").performClick()
            compose.runOnIdle { assertEquals(listOf("bodyweight"), doors) }
        } } finally { scope.cancel() }
    }

    // `4n`: a window decides which ROWS are drawn; it never decides what state a screen is in. The
    // nine seconds of an open delete had this screen standing on `No weigh-ins yet` — the stance for
    // a lifter who has never weighed in — over a series that still held the number, with Undo up.
    @Test
    fun aHeldDeleteOfTheOnlyWeighInNeverDrawsTheNeverWeighedInStance() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room, EngineRoomFixture.server())
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
            compose.onNodeWithText(Bodyweight.noneInWindow).assertDoesNotExist()

            compose.runOnIdle { assertNotNull(store.keepWithheld()) }
            compose.onNodeWithText(Bodyweight.windowLine(ChartWindow.Ninety, 1)).assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun nothingLoggedYetDrawsOneLineAndNoChart() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room, EngineRoomFixture.server())
            compose.setContent {
                BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
            }
            compose.onNodeWithText(Bodyweight.nothingYet).assertIsDisplayed()
            compose.onNodeWithText("90 days").assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    @Test
    fun aRepairedWeighInIsWrittenUnderTheRowsOwnDate() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room, EngineRoomFixture.server())
            val day = today.minusDays(1)
            runBlocking { store.weighIn(day.toString(), 182.0) }
            compose.setContent {
                BodyweightScreen(store = store, backTo = "The log", onBack = {}, say = {})
            }

            compose.onNodeWithText(Bodyweight.listDay(day)).performScrollTo().performClick()
            val field = compose.onNodeWithContentDescription(weightField)
            field.performTextClearance()
            field.performTextInput("82")
            compose.onNodeWithText(Bodyweight.save).performClick()

            compose.runOnIdle {
                assertEquals(listOf(day.toString() to 82.0), store.bodyweight.map { it.dateLocal to it.weightKg })
                assertEquals(listOf(day.toString() to 82.0), room.training.weighins().map { it.dateLocal to it.weightKg })
            }
        } } finally { scope.cancel() }
    }
}
