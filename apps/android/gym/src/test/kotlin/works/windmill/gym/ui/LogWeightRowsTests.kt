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
import works.windmill.gym.presentation.WeighIn
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width

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
                assertNull(room.store.bodyweight.weighIn(day.toString(), 82.4))
                assertNull(room.store.bodyweight.weighIn(day.minusDays(1).toString(), 82.2))
            }
            var opens = 0
            compose.setContent { CompositionLocalProvider(LocalTelemetry provides telemetry) {
                GymMaterial { LogBinding(room.store).let { log -> LogScreen(log, log, "A", {}, { opens++ }, {}, {}, now = { room.now }) } }
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
    fun weighInCollapsesToItsIconWhileTheLogIsScrolledAndKeepsItsName() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val day = LocalDate.of(2026, 10, 22)
            room.now = day.atTime(12, 45).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            runBlocking {
                room.select(null)
                repeat(16) { assertNull(room.store.bodyweight.weighIn(day.minusDays(it.toLong()).toString(), 82.0 + it / 10.0)) }
            }
            compose.setContent { GymMaterial { LogBinding(room.store).let { log -> LogScreen(log, log, "A", {}, {}, {}, {}, now = { room.now }) } } }
            val fab = compose.onNodeWithContentDescription("Weigh in")
            val label = compose.onNode(hasText("Weigh in"), useUnmergedTree = true)
            val expanded = fab.getBoundsInRoot()
            label.assertIsDisplayed()
            compose.onNode(hasScrollAction()).performScrollToIndex(12)
            compose.waitForIdle()
            label.assertDoesNotExist()
            val collapsed = fab.assertIsDisplayed().assertHasClickAction().getBoundsInRoot()
            assertEquals(listOf(56.dp, 56.dp, expanded.right, expanded.bottom),
                listOf(collapsed.width, collapsed.height, collapsed.right, collapsed.bottom))
            compose.onNode(hasScrollAction()).performScrollToIndex(0)
            compose.waitForIdle()
            label.assertIsDisplayed()
            assertEquals(expanded, fab.getBoundsInRoot())
        } } finally { scope.cancel() }
    }

    @Test
    fun aWeightSwipeUsesTheDurableHoldAndUndoRestoresTheExactFact() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val day = LocalDate.of(2026, 10, 22)
            val now = day.atTime(12, 45).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            room.now = now
            runBlocking { room.select(null); assertNull(room.store.bodyweight.weighIn(day.toString(), 82.4)) }
            val original = room.store.bodyweight.drawn
            compose.setContent { GymMaterial { LogBinding(room.store).let { log -> LogScreen(log, log, "A", {}, {}, {}, {}, now = { room.now }) } } }
            compose.onNodeWithTag("weight:$day").performTouchInput { swipeLeft() }
            compose.waitForIdle()
            compose.onNodeWithTag("weight:$day").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(emptyList<WeighIn>(), room.store.bodyweight.drawn)
                assertEquals(original, room.store.bodyweight.allWeighIns)
                assertEquals(1, room.engine.undoOffers().size)
                room.store.deletions.keepWithheld()
            }
            compose.onNodeWithTag("weight:$day").assertIsDisplayed()
            compose.runOnIdle { assertEquals(original, room.store.bodyweight.drawn) }
        } } finally { scope.cancel() }
    }

    // The lazy list keeps its first drawn row in place, so a day Undo restores above it would come
    // back out of sight. Read from the top, the log stays at the top and the row is seen returning.
    @Test
    fun undoBringsBackTheNewestDayIntoViewOnALogReadFromItsTop() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val day = LocalDate.of(2026, 10, 22)
            room.now = day.atTime(12, 45).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            runBlocking {
                room.select(null)
                repeat(16) { assertNull(room.store.bodyweight.weighIn(day.minusDays(it.toLong()).toString(), 82.0 + it / 10.0)) }
            }
            compose.setContent { GymMaterial { LogBinding(room.store).let { log -> LogScreen(log, log, "A", {}, {}, {}, {}, now = { room.now }) } } }
            val top = compose.onNodeWithTag("weight:$day").getBoundsInRoot()
            compose.onNodeWithTag("weight:$day").performTouchInput { swipeLeft() }
            compose.waitForIdle()
            compose.onNodeWithTag("weight:$day").assertDoesNotExist()
            compose.runOnIdle { room.store.deletions.keepWithheld() }
            compose.waitForIdle()
            assertEquals(top, compose.onNodeWithTag("weight:$day").assertIsDisplayed().getBoundsInRoot())
            compose.onNode(hasText("Weigh in"), useUnmergedTree = true).assertIsDisplayed()
        } } finally { scope.cancel() }
    }
}
