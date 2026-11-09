package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ApplicationProvider
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.SessionDetail
import works.windmill.gym.presentation.SessionStart
import works.windmill.gym.presentation.SetFix
import works.windmill.gym.presentation.SetWrite
import works.windmill.gym.presentation.StatsProgress
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FixOrigin
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.i18n.Words

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RecordStateTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private val movement = Exercise("bench-press", "Bench Press", "press", "barbell", 2.5)

    @Test
    fun aSameSeatRefreshKeepsTheLastGoodPageAndAnInitialReadKeepsWaiting() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking {
                room.select(null)
                room.workout()
                room.store.refreshEngine()
                room.store.seat.isLoading = true
            }
            val binding = RecordBinding(room.store)
            compose.setContent { GymMaterial {
                RecordScreen(binding, binding, movement.id, "The log", {}, now = { room.now })
            } }
            compose.onNodeWithText("Reading your log…").assertExists()
            compose.onNodeWithText("Record unavailable").assertDoesNotExist()
            compose.onNodeWithText(TrainingSeat.accountChange.spelled()!!).assertDoesNotExist()
            compose.runOnIdle {
                room.store.seat.isLoading = false
            }
            compose.onNodeWithText("82.5 × 5").assertExists()
            compose.onNodeWithText("96.3").assertExists()
            compose.onNodeWithText("82.5").assertExists()
            compose.runOnIdle {
                room.store.seat.isLoading = true
                room.store.seat.replicaReadRevision += 1
            }
            compose.onNodeWithText("82.5 × 5").assertExists()
            compose.onNodeWithText("96.3").assertExists()
            compose.onNodeWithText("82.5").assertExists()
            compose.onNodeWithText("Record unavailable").assertDoesNotExist()
            compose.onNodeWithText(TrainingSeat.accountChange.spelled()!!).assertDoesNotExist()
            compose.onNodeWithText("Reading your log…").assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    @Test fun unavailableEstimateDoesNotRenderAnIneligibilityClaim() {
        val now = 1_790_424_000_000L
        var complete by mutableStateOf(false)
        compose.setContent {
            val set = TrainingSet("set", "bench-press", weightKg = if (complete) 60.0 else Double.MAX_VALUE, reps = if (complete) 11 else 2,
                completedAtMs = now - 1_000)
            val progress = StatsProgress.of(listOf(SessionDetail(Session("session", now - 1_000, now - 999), listOf(set))), now)
                .movement("bench-press")
            GymMaterial { StrengthChart(progress, now, ZoneOffset.UTC, null) }
        }
        compose.onNodeWithText("Estimated strength").assertExists()
        compose.onNodeWithText("No eligible estimate in this window.").assertDoesNotExist()
        compose.runOnIdle { complete = true }
        compose.onNodeWithText("No eligible estimate in this window.").assertExists()
    }

    // Signed in, with the account's log read once and nothing logged on it.
    private fun store(room: EngineRoomFixture): TrainingStore {
        runBlocking { room.select("a"); room.pull(EngineRoomFixture.server()); room.store.refreshEngine(); room.store.observeEngine() }
        return room.store
    }

    @Test
    fun initialReadIsHonestAndEditingKeepsTheWholeInvalidDraftWithoutInventingARecord() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            compose.setContent { GymMaterial { RecordBinding(store).let { record -> RecordScreen(record, record, movement.id, "The log", {}) } } }
            compose.onNodeWithText("Nothing logged for this movement yet. The first set you log lands here.").assertIsDisplayed()
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Edit movement").performClick()
            compose.onNodeWithContentDescription("Movement name").performTextReplacement("N".repeat(61))
            compose.onNodeWithContentDescription("Movement name").assertTextContains("N".repeat(61))
            compose.onNodeWithText("Use 60 characters or fewer.").assertIsDisplayed()
            compose.onNodeWithText("Save").assertIsNotEnabled()
            compose.onNodeWithText("Old name: Bench Press\nSearchable as an alias.").assertDoesNotExist()
            assertEquals(listOf(movement), store.routines.catalog.filter { it.id == movement.id })
            assertEquals(listOf(movement), room.training.catalogue().filter { it.id == movement.id })
        } } finally { scope.cancel() }
    }

    // The rename is one local commit, so the sheet comes down on the name the replica now holds.
    @Test
    fun anEditShowsTheAcceptedNameAndTheObserverRefreshesTheCatalogue() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = store(room)
            val renamed = movement.copy(name = "Paused Bench", aliases = listOf("Bench Press"))
            compose.setContent { GymMaterial { RecordBinding(store).let { record -> RecordScreen(record, record, movement.id, "The log", {}) } } }
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Edit movement").performClick()
            compose.onNodeWithContentDescription("Movement name").performTextReplacement("Paused Bench")
            compose.onNodeWithText("Save").performClick()
            compose.onNodeWithText("Paused Bench").assertIsDisplayed()
            compose.onNodeWithText("Edit movement").assertDoesNotExist()
            compose.waitUntil(5_000) { compose.runOnIdle { store.routines.catalog.single { it.id == movement.id } == renamed } }
            compose.runOnIdle {
                assertEquals(listOf(renamed), store.routines.catalog.filter { it.id == movement.id })
                assertEquals(listOf(renamed), room.training.catalogue().filter { it.id == movement.id })
            }
        } } finally { scope.cancel() }
    }

    // A workout logged on this phone before its account is pulled is part of the account: the strength card, with its
    // latest estimate and workout count, waits for the pull.
    @Test
    fun anAccountNotYetPulledShowsNoEstimateOrCountUntilThePullLands() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = EngineRoomFixture.server()
            runBlocking { room.select("a"); room.workout(); room.store.observeEngine() }
            compose.runOnIdle { assertFalse(room.training.firstPullComplete) }
            compose.setContent { GymMaterial { RecordBinding(room.store).let { record -> RecordScreen(record, record, "bench-press", "The log", {}, now = { room.now }) } } }
            compose.onNodeWithText("Recent sets").assertIsDisplayed()
            compose.onNodeWithText("Estimated strength").assertDoesNotExist()
            compose.onNodeWithText("Last 12 weeks · 1 workout").assertDoesNotExist()
            compose.onNodeWithText("kg est", substring = true).assertDoesNotExist()
            compose.runOnIdle { room.sync(server) }
            compose.waitUntil(5_000) { compose.onAllNodesWithText("Last 12 weeks · 1 workout").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Estimated strength").assertExists()
            compose.onNodeWithText("96.3 kg est · today · 82.5 × 5").assertExists()
            compose.onNodeWithText("Best e1RM").assertExists()
        } } finally { scope.cancel() }
    }

    @Test
    fun aRemoteCorrectionRefreshesRecentSetsAndBothRecordTilesTogether() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            EngineRoomFixture(tmp.newFolder(), scope).use { other ->
                val server = EngineRoomFixture.server()
                val session = runBlocking {
                    room.select("alice"); room.pull(server)
                    room.workout().also {
                        room.sync(server); room.store.refreshEngine(); room.store.observeEngine()
                        other.select("alice"); other.pull(server); other.store.refreshEngine()
                    }
                }
                compose.setContent { GymMaterial { RecordBinding(room.store).let {
                    RecordScreen(it, it, movement.id, "The log", {}, now = { room.now })
                } } }
                compose.onNodeWithText("82.5 × 5").assertExists()
                compose.onNodeWithText("96.3").assertExists()
                compose.onNodeWithText("82.5").assertExists()
                val correctingElsewhere = compose.runOnIdle { scope.async {
                    val set = other.training.session(session.id)!!.sets.single()
                    assertEquals(FixOutcome.Corrected(set.copy(weightKg = 90.0)),
                        other.store.workout.fixSet(session.id, set.id, SetFix(weightKg = 90.0), FixOrigin.Session))
                    other.sync(server); room.pull(server)
                } }
                compose.waitUntil(10_000) { compose.runOnIdle { correctingElsewhere.isCompleted } }
                runBlocking { correctingElsewhere.await() }
                compose.waitUntil(5_000) {
                    listOf("90 × 5", "105", "90").all { text ->
                        compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
                    }
                }
                compose.onNodeWithText("82.5 × 5").assertDoesNotExist()
                compose.onNodeWithText("96.3").assertDoesNotExist()
                compose.onNodeWithText("82.5").assertDoesNotExist()
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun aLaterWeakerWorkoutDoesNotReplaceTheDailyChartReadoutOrGainAnInspectionRing() {
        val now = Instant.parse("2026-10-22T15:00:00Z").toEpochMilli()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking {
                room.now = now
                room.select(null)
                for ((index, days) in listOf(28, 21, 14, 0, 0).withIndex()) {
                    val at = now - days * 86_400_000L - if (index == 4) 1_800_000 else 3_600_000
                    val id = "workout$index"
                    room.training.startSession(SessionStart(id, at))
                    room.training.appendSet(id, SetWrite("set$index", "bench-press", if (index == 4) 85.0 else 60.0 + index * 10, 1, at + 1_000))
                    room.training.finishSession(id, at + 60_000)
                }
                room.store.refreshEngine()
            }
            var focus by mutableStateOf<String?>(null)
            compose.setContent { GymMaterial { RecordBinding(room.store).let { record -> RecordScreen(record, record, "bench-press", "The log", {},
                focusSessionId = focus, now = { now }) } } }
            compose.onNodeWithText("90 kg est · today · 90 × 1").assertIsDisplayed()
            compose.onNodeWithText("85 kg est · today · 85 × 1").assertDoesNotExist()
            val winner = compose.onNodeWithContentDescription("90 kg est · today · 90 × 1, standing best", useUnmergedTree = true)
            winner.assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
            compose.runOnIdle { focus = "workout4" }
            winner.assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
            compose.onNodeWithText("90 kg est · today · 90 × 1").assertIsDisplayed()
            compose.runOnIdle { focus = "workout3" }
            winner.assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
            compose.runOnIdle { assertEquals((0..4).map { "workout$it" }, room.training.progress().sessions.map { it.sessionId }) }
        } } finally { scope.cancel() }
    }
}

private fun Words?.spelled(): String? = this?.text(ApplicationProvider.getApplicationContext())
