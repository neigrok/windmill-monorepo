package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.presentation.Bodyweight
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.SessionStart
import works.windmill.gym.presentation.SetWrite
import works.windmill.gym.store.*
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.Pulls

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
            compose.onNodeWithContentDescription(Bodyweight.chip).performClick()
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
            compose.onNodeWithText("Use date").performClick()
            compose.onNodeWithText(Bodyweight.fullDay(day.plusDays(2))).assertIsDisplayed()
            compose.onNodeWithContentDescription(weightField).performTextReplacement("82.45")
            val saving = compose.runOnIdle { room.now }
            compose.onNodeWithText(Bodyweight.save).performClick()
            compose.onNodeWithText(Bodyweight.save).assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(2, instances)
                assertEquals(listOf(day.plusDays(2).toString() to 82.45), current.bodyweight.drawn.map { it.dateLocal to it.weightKg })
                assertTrue("recorded at the save", current.bodyweight.drawn.single().recordedAt!! in saving..room.now)
                assertEquals("as the replica holds it", room.training.weighins(), current.bodyweight.drawn)
            }
        } } finally { scope.cancel() }
    }

    // Before the first pull the foot says nothing for 400 ms, then reads over an indeterminate bar with no button, announced
    // once as a polite live region that carries the bar, and stays inside the gutters at 200 % text.
    @Test
    fun theUnreadFootSaysItIsReadingOnlyOnceTheWaitPasses400Ms() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking { room.select("a"); room.store.observeEngine() }
            compose.waitUntil(5_000) { room.store.history.older == Older.Reading }
            compose.mainClock.autoAdvance = false
            compose.setContent {
                CompositionLocalProvider(LocalDensity provides Density(2f, 2f)) {
                    GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { room.now }) }
                }
            }
            compose.mainClock.advanceTimeByFrame()
            compose.mainClock.advanceTimeBy(380)
            compose.onNodeWithText("Reading your log…").assertDoesNotExist()
            compose.onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate)).assertDoesNotExist()
            compose.mainClock.advanceTimeBy(40)
            val foot = compose.onNodeWithText("Reading your log…").assertIsDisplayed()
                .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
                .assert(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate))
            val bounds = foot.getBoundsInRoot()
            assertTrue("inside the gutters: $bounds", bounds.left >= 36.dp && bounds.right <= 376.dp)
            compose.onAllNodes(hasClickAction()).filter(hasText("Retry") or hasText("Load older") or hasText("Loading"))
                .assertCountEquals(0)
            compose.onNodeWithText("That read failed.").assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    // A first pull that fails turns the reading foot into Retry. Retry asks for the pull and the foot reads again until a
    // pull ends; the one that lands brings the usual foot. Each wait the person saw is told once, with how it ended.
    @Test
    fun aFailedFirstPullOffersRetryAndRetryReadsAgainUntilThePullLands() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val pulls = MutableStateFlow(Pulls())
        var asked = 0
        val actions = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action" && properties["screen"] == "log") actions += properties
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        try { EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, pullAgain = { asked++; true }, pulls = pulls).use { room ->
            runBlocking { room.select("a"); room.store.observeEngine() }
            val replica = room.engine.activeReplica()
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { room.now }) } }
            compose.mainClock.advanceTimeBy(500)
            compose.onNodeWithText("Reading your log…").assertIsDisplayed()
            compose.onNodeWithText("Retry").assertDoesNotExist()
            compose.runOnIdle { pulls.value = Pulls(replica, sent = 1, ended = 1, failed = true) }
            compose.onNodeWithText("That read failed.").assertIsDisplayed()
                .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
            compose.onNodeWithText("Reading your log…").assertDoesNotExist()
            compose.onNodeWithText("Retry").performClick()
            compose.waitUntil(5_000) { compose.runOnIdle { asked == 1 } }
            compose.onNodeWithText("Retry").assertDoesNotExist()
            compose.mainClock.advanceTimeBy(500)
            compose.onNodeWithText("Reading your log…").assertIsDisplayed()
            compose.onNodeWithText("Retry").assertDoesNotExist()
            compose.runOnIdle {
                room.pull(EngineRoomFixture.server())
                pulls.value = Pulls(replica, sent = 2, ended = 2, caughtUp = 2)
            }
            compose.waitUntil(5_000) { compose.onAllNodesWithText("No workouts yet").fetchSemanticsNodes().size == 1 }
            compose.onNodeWithText("Reading your log…").assertDoesNotExist()
            compose.onNodeWithText("Retry").assertDoesNotExist()
            compose.onNodeWithText("That read failed.").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(1, asked)
                assertEquals(listOf(
                    mapOf("screen" to "log", "action" to "first_pull", "state" to "shown"),
                    mapOf("screen" to "log", "action" to "first_pull", "outcome" to "failed"),
                    mapOf("screen" to "log", "action" to "retry", "outcome" to "requested"),
                    mapOf("screen" to "log", "action" to "first_pull", "state" to "shown"),
                    mapOf("screen" to "log", "action" to "first_pull", "outcome" to "read"),
                ), actions)
            }
        } } finally { scope.cancel() }
    }

    // Opened where no pull can be attempted, the foot never reads: it offers Retry, which is refused while nothing can
    // pull, and reads again once pulls can run and one is in flight.
    @Test
    fun openedWhereNoPullCanRunTheFootOffersRetryRatherThanReading() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val pulls = MutableStateFlow(Pulls())
        var asked = 0
        val actions = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action" && properties["screen"] == "log") actions += properties
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        try { EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, pullAgain = { asked++; true }, pulls = pulls).use { room ->
            runBlocking { room.select("a") }
            val replica = room.engine.activeReplica()
            pulls.value = Pulls(replica, blocked = true)
            runBlocking { room.store.observeEngine() }
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { room.now }) } }
            compose.mainClock.advanceTimeBy(500)
            compose.onNodeWithText("That read failed.").assertIsDisplayed()
            compose.onNodeWithText("Reading your log…").assertDoesNotExist()
            compose.onNodeWithText("Retry").performClick()
            compose.waitUntil(5_000) { compose.runOnIdle { actions.any { it["action"] == "retry" } } }
            compose.onNodeWithText("Retry").assertIsDisplayed()
            compose.runOnIdle { pulls.value = Pulls(replica, sent = 1, ended = 0) }
            compose.waitUntil(5_000) { compose.runOnIdle { room.store.history.older == Older.Reading } }
            compose.mainClock.advanceTimeBy(500)
            compose.onNodeWithText("Reading your log…").assertIsDisplayed()
            compose.onNodeWithText("Retry").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(0, asked)
                assertEquals(listOf(
                    mapOf("screen" to "log", "action" to "retry", "outcome" to "refused"),
                    mapOf("screen" to "log", "action" to "first_pull", "state" to "shown"),
                ), actions)
            }
        } } finally { scope.cancel() }
    }

    // Reading the first page, the phone goes offline: no pull can run now, so the foot stops reading and offers Retry.
    @Test
    fun goingOfflineWhileReadingTurnsTheFootToRetry() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val pulls = MutableStateFlow(Pulls())
        val actions = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action" && properties["screen"] == "log") actions += properties
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        try { EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, pulls = pulls).use { room ->
            runBlocking { room.select("a"); room.workout(); room.store.observeEngine() }
            val replica = room.engine.activeReplica()
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { room.now }) } }
            compose.runOnIdle { pulls.value = Pulls(replica, sent = 1, ended = 0) }
            compose.mainClock.advanceTimeBy(500)
            compose.onNodeWithText("Reading your log…").assertIsDisplayed()
            compose.runOnIdle { pulls.value = Pulls(replica, sent = 1, ended = 1, failed = true, blocked = true) }
            compose.onNodeWithText("That read failed.").assertIsDisplayed()
            compose.onNodeWithText("Reading your log…").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(listOf(
                    mapOf("screen" to "log", "action" to "first_pull", "state" to "shown"),
                    mapOf("screen" to "log", "action" to "first_pull", "outcome" to "failed"),
                ), actions)
            }
        } } finally { scope.cancel() }
    }

    // Retry asks for the pull and the foot reads; the phone then goes offline before any pull ends, and the foot offers
    // Retry again rather than reading on.
    @Test
    fun retryThenOfflineTurnsTheFootBackToRetry() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val pulls = MutableStateFlow(Pulls())
        var asked = 0
        try { EngineRoomFixture(tmp.newFolder(), scope, pullAgain = { asked++; true }, pulls = pulls).use { room ->
            runBlocking { room.select("a"); room.store.observeEngine() }
            val replica = room.engine.activeReplica()
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { room.now }) } }
            compose.runOnIdle { pulls.value = Pulls(replica, sent = 1, ended = 1, failed = true) }
            compose.onNodeWithText("Retry").performClick()
            compose.waitUntil(5_000) { compose.runOnIdle { asked == 1 } }
            compose.mainClock.advanceTimeBy(500)
            compose.onNodeWithText("Reading your log…").assertIsDisplayed()
            compose.runOnIdle { pulls.value = pulls.value.copy(blocked = true) }
            compose.onNodeWithText("That read failed.").assertIsDisplayed()
            compose.onNodeWithText("Reading your log…").assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    // A walk past the head page before the first pull ends reading; once the pull lands, the log's end is knowable and
    // the foot offers older workouts rather than reading on.
    @Test
    fun aWalkedLogStopsReadingOnceThePullLands() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking {
                room.select("a")
                repeat(HistoryReads.logPage + 2) { index ->
                    val start = room.now + index * 3_600_000L
                    room.training.startSession(SessionStart(id = "walked${index.toString().padStart(3, '0')}", startedAt = start))
                    room.training.finishSession("walked${index.toString().padStart(3, '0')}", start + 60_000)
                }
                room.now += (HistoryReads.logPage + 3) * 3_600_000L
                room.store.observeEngine()
                room.store.refreshEngine()
            }
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { room.now }) } }
            compose.waitUntil(5_000) { compose.runOnIdle { room.store.history.older == Older.More } }
            compose.runOnIdle { runBlocking { room.store.history.loadOlder() } }
            compose.runOnIdle {
                assertEquals(HistoryReads.logPage + 2, room.store.history.logged.size)
                assertEquals(Older.Reading, room.store.history.older)
                room.pull(EngineRoomFixture.server())
            }
            compose.waitUntil(5_000) { compose.runOnIdle { room.store.history.older == Older.More } }
            compose.runOnIdle { assertEquals(HistoryReads.logPage + 2, room.store.history.logged.size) }
        } } finally { scope.cancel() }
    }

    // A row reached by walking past the head page reflects the replica after new changes land: a set leaving a walked
    // workout leaves its row too.
    @Test
    fun aWalkedRowFollowsChangesThatLandForItsWorkout() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val oldest = "walked000"
            runBlocking {
                room.select("a")
                room.pull(EngineRoomFixture.server())
                repeat(HistoryReads.logPage + 1) { index ->
                    val id = "walked${index.toString().padStart(3, '0')}"
                    val start = room.now + index * 3_600_000L
                    room.training.startSession(SessionStart(id = id, startedAt = start))
                    if (id == oldest) repeat(2) { set ->
                        room.training.appendSet(id, SetWrite("set-$set", "bench-press", 80.0, 5, start + 60_000L * (set + 1)))
                    }
                    room.training.finishSession(id, start + 600_000)
                }
                room.now += (HistoryReads.logPage + 2) * 3_600_000L
                room.store.observeEngine()
                room.store.refreshEngine()
            }
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { room.now }) } }
            compose.waitUntil(5_000) { compose.runOnIdle { room.store.history.older == Older.More } }
            compose.runOnIdle { runBlocking { room.store.history.loadOlder() } }
            compose.runOnIdle { assertEquals(2, room.store.history.logged.single { it.id == oldest }.setCount) }
            runBlocking { room.training.deleteSet(oldest, "set-0") }
            compose.waitUntil(5_000) { compose.runOnIdle { room.store.history.logged.single { it.id == oldest }.setCount == 1 } }
            compose.runOnIdle {
                assertEquals(HistoryReads.logPage + 1, room.store.history.logged.size)
                assertEquals(Older.End, room.store.history.older)
            }
        } } finally { scope.cancel() }
    }

    // A short head page reads; newer workouts then push the log past one page and the pull lands, so the head page is
    // full and the foot offers older workouts.
    @Test
    fun newerWorkoutsPastOnePageAndAPullThatLandsOfferOlderWorkouts() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            fun logged(index: Int) = runBlocking {
                val start = room.now
                room.training.startSession(SessionStart(id = "logged${index.toString().padStart(3, '0')}", startedAt = start))
                room.training.finishSession("logged${index.toString().padStart(3, '0')}", start + 60_000)
                room.now += 3_600_000L
            }
            runBlocking { room.select("a") }
            repeat(2) { logged(it) }
            runBlocking { room.store.observeEngine(); room.store.refreshEngine() }
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { room.now }) } }
            compose.waitUntil(5_000) { compose.runOnIdle { room.store.history.older == Older.Reading } }
            compose.runOnIdle {
                (2 until HistoryReads.logPage + 1).forEach(::logged)
                room.pull(EngineRoomFixture.server())
            }
            compose.waitUntil(5_000) { compose.runOnIdle { room.store.history.older == Older.More } }
            compose.runOnIdle { assertEquals("the head page and the row below it", HistoryReads.logPage + 1, room.store.history.recent.size) }
        } } finally { scope.cancel() }
    }

    // Workouts and weigh-ins this phone holds before the first pull are part of the account at most: the log lists them
    // and claims no new best, no full month, no change since and no first workout while it reads. Once the pull lands,
    // the same rows say all four.
    @Test
    @Config(qualifiers = "w412dp-h2400dp-xhdpi")
    fun beforeTheFirstPullTheLogClaimsNoBestNoFullMonthNoChangeSinceAndNoFirstWorkout() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val zone = ZoneId.systemDefault()
        fun at(day: String) = LocalDate.parse(day).atTime(18, 0).atZone(zone).toInstant().toEpochMilli()
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val today = room.now
            runBlocking {
                room.select("a")
                listOf("2026-12-01" to 80.0, "2026-12-07" to 82.5, "2026-12-14" to 85.0, "2026-12-16" to 87.5,
                    "2026-12-21" to 80.0, "2026-12-28" to 80.0).forEach { (day, load) -> room.now = at(day); room.workout(load) }
                room.now = today
                assertNull(room.store.bodyweight.weighIn("2026-11-20", 83.0))
                assertNull(room.store.bodyweight.weighIn("2027-01-10", 82.0))
                room.store.observeEngine()
            }
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { room.now }) } }
            compose.mainClock.advanceTimeBy(500)
            compose.onNodeWithText("Reading your log…").assertIsDisplayed()
            compose.onAllNodes(SemanticsMatcher("a workout row") { it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("session:") == true })
                .assertCountEquals(6)
            compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "New best")).assertCountEquals(0)
            compose.onAllNodesWithText("new best", substring = true).assertCountEquals(0)
            compose.onAllNodesWithText("Trained", substring = true).assertCountEquals(0)
            compose.onAllNodesWithText("since", substring = true).assertCountEquals(0)
            compose.onAllNodesWithText("First workout", substring = true).assertCountEquals(0)
            compose.runOnIdle { room.pull(EngineRoomFixture.server()) }
            compose.waitUntil(5_000) { compose.onAllNodesWithText("Trained 5 of 5 weeks").fetchSemanticsNodes().size == 1 }
            compose.onNodeWithText("Reading your log…").assertDoesNotExist()
            compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "New best")).assertCountEquals(1)
            compose.onAllNodesWithText("Bench Press · new best").assertCountEquals(2)
            compose.onNodeWithText("1 kg down since November").assertIsDisplayed()
            compose.onNodeWithText("First workout · ${Readout.date(at("2026-12-01") + 1)}").assertIsDisplayed()
        } } finally { scope.cancel() }
    }
}
