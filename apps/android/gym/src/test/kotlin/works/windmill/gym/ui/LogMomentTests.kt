package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
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
import works.windmill.gym.GymRoom
import works.windmill.gym.net.FakeTraining
import works.windmill.platform.User
import works.windmill.gym.domain.*
import works.windmill.gym.store.*
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LogMomentTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun onlyOneMomentExpandsAndItsChartAndRecordDoorReadTheEventWindow() {
        val zone = ZoneId.systemDefault()
        fun at(day: String) = LocalDate.parse(day).atTime(18, 0).atZone(zone).toInstant().toEpochMilli()
        val now = at("2026-09-24")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val local = LocalLog(File(tmp.root, "log"))
        listOf("2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-24").forEachIndexed { index, day ->
            val sets = mutableListOf(TrainingSet("bench-$index", "bench-press", weightKg = if (index == 4) 90.0 else 80.0,
                reps = 1, completedAtMs = at(day)))
            if (index == 3) sets += TrainingSet("row", "barbell-row", weightKg = 60.0, reps = 1, completedAtMs = at(day))
            local.hold(LocalLog.FinishedSession(Session("s$index", at(day), at(day) + 3_600_000,
                plan = PlanSnapshot("Workout $index")), sets))
        }
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")), local,
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), scope, now = { now }, sync = { null })
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), null)
        runBlocking { store.connect(account) }
        val opened = mutableListOf<String>()
        val latestBest = hasText("Bench Press · new best") and hasAnyAncestor(hasTestTag("best:bench-press:s4"))
        compose.setContent { GymMaterial { LogScreen(store, "A", {}, {}, {}, {}, onOpenMovement = { opened += it }, now = { now }) } }
        try {
            compose.onNodeWithText("September").assertIsDisplayed()
            compose.onNodeWithText("5 sessions · 5 weeks loaded").assertDoesNotExist()
            compose.onNodeWithText("Trained 4 of the last 4 weeks").assertDoesNotExist()
            compose.onNode(latestBest).performClick()
            compose.onNodeWithTag("moment-plot:best:bench-press:s4").assertIsDisplayed()
            compose.onNodeWithContentDescription("Session estimates").assertDoesNotExist()
            compose.onNodeWithText("Last 12 weeks · 5 sessions").assertIsDisplayed()
            compose.onNodeWithText("Best e1RM 90 kg · today").assertIsDisplayed()
            compose.onNodeWithText("Heaviest 90 × 1 · today").assertIsDisplayed()
            compose.onNodeWithText("Open record ›").performClick()
            assertEquals(listOf("bench-press"), opened)
            compose.onNodeWithText("Barbell Row · new best").performScrollTo().performClick()
            compose.onNodeWithText("Barbell Row · new best").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
            compose.onNodeWithText("Workout 4").performScrollTo()
            compose.onNode(latestBest).assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
            compose.onNodeWithText("Weigh in").assertIsDisplayed()
        } finally { scope.cancel() }
    }

    @Test
    fun aPlateauSessionStillOpensTheActualMovementRecordThroughTheRoom() {
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val local = LocalLog(File(tmp.root, "log"))
        listOf(today.minusMonths(6), today.minusDays(1)).forEachIndexed { index, day ->
            val at = day.atTime(12, 0).atZone(zone).toInstant().toEpochMilli()
            local.hold(LocalLog.FinishedSession(Session("s$index", at, at + 3_600_000,
                plan = PlanSnapshot(if (index == 0) "First workout" else "Plateau workout")), listOf(
                TrainingSet("set$index", "bench-press", weightKg = 80.0, reps = 1, completedAtMs = at))))
        }
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")), local,
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), scope, sync = { null })
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), null)
        runBlocking { store.connect(account) }
        compose.setContent { GymMaterial { GymRoom(account, store) } }
        try {
            compose.onNodeWithText("Log").performClick()
            compose.onNodeWithText("Plateau workout").performClick()
            compose.onNodeWithText("Bench Press").performClick()
            compose.onNodeWithText("Rename").assertIsDisplayed()
            compose.onNodeWithText("Bench Press").assertIsDisplayed()
            compose.onNodeWithContentDescription("Back to Plateau workout").assertIsDisplayed()
        } finally { scope.cancel() }
    }

    @Test
    fun holdingEveryLoadedWorkoutKeepsOlderReachableWithoutLeakingOlderMoments() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val now = LocalDate.of(2026, 9, 24).atTime(18, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        val server = FakeTraining()
        repeat(50) { index ->
            val at = now - index * 60_000
            server.stored["recent$index"] = Session("recent$index", at, at + 1_000, plan = PlanSnapshot("Recent $index"))
        }
        val old = now - 90L * 86_400_000
        server.stored["old"] = Session("old", old, old + 3_600_000, plan = PlanSnapshot("Older workout"))
        server.sets["old"] = mutableListOf(TrainingSet("old-set", "bench-press", weightKg = 80.0, reps = 1, completedAtMs = old))
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), scope,
            now = { now }, undoWindowMs = 60_000, sync = { server })
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), User("a", "a@example.com", "A"))
        runBlocking {
            store.connect(account)
            store.recent.toList().forEach { store.withhold(Deletion.Session(it.id)) }
            assertEquals(Older.More, store.older)
            assertEquals((0 until 50).map { "recent$it" }.toSet(), store.withheldIds)
            assertEquals(emptyList<SessionSummary>(), store.recent)
        }
        compose.setContent { GymMaterial { LogScreen(store, "A", {}, {}, {}, {}, now = { now }) } }
        try {
            compose.onNodeWithText("Bench Press · new best").assertDoesNotExist()
            compose.onNodeWithText("No sessions yet").assertDoesNotExist()
            compose.onNodeWithText("Load older").assertIsDisplayed().performClick()
            compose.onNodeWithText("Older workout").assertIsDisplayed()
            compose.onNodeWithText("Bench Press · new best").assertIsDisplayed()
            compose.onNodeWithText("Load older").assertDoesNotExist()
            compose.onNodeWithText("Weigh in").assertIsDisplayed()
        } finally { scope.cancel() }
    }

    @Test
    fun aCompletedMonthCanScrollAndExpandBesideItsOwnCalendarHeader() {
        val zone = ZoneId.systemDefault()
        fun at(day: String) = LocalDate.parse(day).atTime(18, 0).atZone(zone).toInstant().toEpochMilli()
        val now = at("2026-09-24")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val local = LocalLog(File(tmp.root, "log"))
        val days = listOf("2026-07-01", "2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27") +
            (15..23).map { "2026-09-$it" }
        days.forEach { day ->
            local.hold(LocalLog.FinishedSession(Session(day, at(day), at(day) + 3_600_000,
                plan = PlanSnapshot("Workout $day")), listOf(
                TrainingSet("set:$day", "bench-press", weightKg = 60.0, reps = 12, completedAtMs = at(day)))))
        }
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")), local,
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), scope, now = { now }, sync = { null })
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), null)
        runBlocking { store.connect(account) }
        compose.setContent { GymMaterial { LogScreen(store, "A", {}, {}, {}, {}, now = { now }) } }
        try {
            compose.onNodeWithText("September").assertIsDisplayed()
            compose.onNode(hasScrollAction()).performScrollToNode(hasText("July"))
            compose.onNodeWithText("July").assertIsDisplayed()
            compose.onNodeWithText("Trained 5 of 5 weeks").performScrollTo().performClick()
            compose.onNodeWithText("Trained 5 of 5 weeks")
                .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
            compose.onNodeWithText("July · full month").assertIsDisplayed()
            compose.onNodeWithText("A finished workout with working sets in every calendar week.").assertIsDisplayed()
            compose.onNodeWithText("Trained 5 of 5 weeks").performClick()
            compose.onNodeWithText("Trained 5 of 5 weeks")
                .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
            compose.onNodeWithText("Weigh in").assertIsDisplayed()
        } finally { scope.cancel() }
    }

}
