package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.semantics.SemanticsProperties
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.GymRoom
import works.windmill.gym.presentation.*
import works.windmill.gym.store.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LogMomentTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    // A finished hour of training begun a minute before `at` under a plan named `plan`, one set of each
    // lift. Its routine is deleted after, so the log's sessions keep only their frozen plan.
    private suspend fun EngineRoomFixture.trained(plan: String, at: Long, lifts: List<Pair<String, Double>>, reps: Int = 1): Session {
        now = at - 60_000
        val routine = (store.saveRoutine(lifts.fold(RoutineDraft(name = plan)) { draft, (movement, _) -> draft.adding(movement) })
            as GymResult.Ok).value
        val session = (store.start(routine.id) as GymResult.Ok).value
        for ((movement, load) in lifts) {
            store.choose(movement)
            store.logSet(load, reps)
        }
        now = at + 3_540_000
        assertTrue(store.finish() is FinishOutcome.Closed)
        assertNull(store.dropRoutine(routine.id))
        return session
    }

    @Test
    fun recordMarkersOpenTheExactRecordDirectlyAndHaveNoDeleteOrExpandAction() {
        val zone = ZoneId.systemDefault()
        fun at(day: String) = LocalDate.parse(day).atTime(18, 0).atZone(zone).toInstant().toEpochMilli()
        val now = at("2026-09-24")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val latest = runBlocking {
                room.select(null)
                listOf("2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-24").mapIndexed { index, day ->
                    // Each movement's first estimate is its baseline; the row's best lands on the fourth workout, bench's on the last.
                    val lifts = listOf("bench-press" to if (index == 4) 90.0 else 80.0) +
                        when (index) { 2 -> listOf("barbell-row" to 55.0); 3 -> listOf("barbell-row" to 60.0); else -> emptyList() }
                    room.trained("Workout $index", at(day), lifts)
                }.last()
            }
            room.store.observeEngine()
            val opened = mutableListOf<Pair<String, String>>()
            val latestBest = hasTestTag("best:bench-press:${latest.id}")
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, onOpenMovement = { exercise, session -> opened += exercise to session }, now = { now }) } }
            compose.onNodeWithText("Today · 24 Sep").assertIsDisplayed()
            compose.onNode(latestBest).performClick()
            assertEquals(listOf("bench-press" to latest.id), opened)
            compose.onNodeWithTag("moment-plot:best:bench-press:${latest.id}").assertDoesNotExist()
            compose.onNodeWithText("Open record ›").assertDoesNotExist()
            val marker = compose.onNodeWithTag("best:bench-press:${latest.id}").fetchSemanticsNode()
            assertEquals(null, marker.config.getOrNull(androidx.compose.ui.semantics.SemanticsActions.CustomActions))
            assertEquals(null, marker.config.getOrNull(SemanticsProperties.StateDescription))
            compose.onNodeWithContentDescription("Weigh in").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun aPlateauSessionStillOpensTheActualMovementRecordThroughTheRoom() {
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking {
                room.select(null)
                listOf(today.minusMonths(6), today.minusDays(1)).forEachIndexed { index, day ->
                    room.trained(if (index == 0) "First workout" else "Plateau workout",
                        day.atTime(12, 0).atZone(zone).toInstant().toEpochMilli(), listOf("bench-press" to 80.0))
                }
            }
            room.now = System.currentTimeMillis()
            room.store.observeEngine()
            var shown by mutableStateOf(true)
            compose.setContent { GymMaterial { if (shown) GymRoom(room.account(), room.store) } }
            compose.onNodeWithText("The log").performClick()
            compose.onNodeWithText("Plateau workout").performClick()
            compose.onNodeWithText("Bench Press").performClick()
            compose.onNodeWithContentDescription("More").assertIsDisplayed()
            compose.onNodeWithText("Bench Press").assertIsDisplayed()
            compose.onNodeWithContentDescription("Back to Plateau workout").assertIsDisplayed()
            // The room leaves the screen before the engine under it closes; the application's never does.
            shown = false
            compose.waitForIdle()
        } } finally { scope.cancel() }
    }

    @Test
    fun holdingEveryLoadedWorkoutKeepsOlderReachableWithoutLeakingOlderMoments() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val now = LocalDate.of(2026, 9, 24).atTime(18, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        val server = EngineRoomFixture.server()
        try { EngineRoomFixture(tmp.newFolder(), scope, undoWindowMs = 60_000).use { room ->
            // Fifty empty workouts a minute apart this evening, and under them a bench best from ninety
            // days ago over its baseline the week before, all logged on another phone.
            val phoneScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
            val recent = try { EngineRoomFixture(tmp.newFolder(), phoneScope).use { phone -> runBlocking {
                phone.select("a")
                phone.pull(server)
                phone.trained("Oldest workout", now - 97L * 86_400_000, listOf("bench-press" to 75.0))
                phone.trained("Older workout", now - 90L * 86_400_000, listOf("bench-press" to 80.0))
                val recent = (49 downTo 0).map { index ->
                    phone.now = now - index * 60_000 - 1_000
                    val session = phone.startExternalWorkout()
                    phone.now += 1_000
                    assertTrue(phone.store.finish() is FinishOutcome.Closed)
                    session.id
                }
                phone.sync(server)
                recent
            } } } finally { phoneScope.cancel() }
            room.now = now
            runBlocking {
                room.select("a")
                room.pull(server)
                room.store.refreshEngine()
                room.store.recent.toList().forEach { room.store.withhold(Deletion.Session(it.id)) }
                assertEquals(Older.More, room.store.older)
                assertEquals(recent.toSet(), room.store.withheldIds)
                assertEquals(emptyList<SessionSummary>(), room.store.recent)
            }
            room.store.observeEngine()
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { now }) } }
            compose.onNodeWithText("Bench Press · new best").assertDoesNotExist()
            compose.onNodeWithText("No workouts yet").assertDoesNotExist()
            compose.onNodeWithText("Load older").assertIsDisplayed().performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { room.store.older == Older.End } }
            compose.onNodeWithText("Older workout").assertIsDisplayed()
            compose.onNodeWithText("Bench Press · new best").assertIsDisplayed()
            compose.onNodeWithText("Load older").assertDoesNotExist()
            compose.onNodeWithContentDescription("Weigh in").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun aCompletedMonthIsANoninteractiveSummaryInItsDatedSection() {
        val zone = ZoneId.systemDefault()
        fun at(day: String) = LocalDate.parse(day).atTime(18, 0).atZone(zone).toInstant().toEpochMilli()
        val now = at("2026-09-24")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking {
                room.select(null)
                val days = listOf("2026-07-01", "2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27") +
                    (15..23).map { "2026-09-$it" }
                days.forEach { day -> room.trained("Workout $day", at(day), listOf("bench-press" to 60.0), reps = 12) }
            }
            room.store.observeEngine()
            compose.setContent { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {}, now = { now }) } }
            compose.onNode(hasScrollAction()).performScrollToNode(hasText("Trained 5 of 5 weeks"))
            compose.onNodeWithText("Trained 5 of 5 weeks").assertIsDisplayed()
            compose.onNodeWithText("Trained 5 of 5 weeks").assertHasNoClickAction()
            compose.onNodeWithText("July · full month").assertIsDisplayed()
            compose.onNodeWithText("A finished workout with sets in every calendar week.").assertDoesNotExist()
            compose.onNodeWithContentDescription("Weigh in").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

}
