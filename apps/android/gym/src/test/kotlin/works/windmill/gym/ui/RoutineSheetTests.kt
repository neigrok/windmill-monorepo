package works.windmill.gym.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.GymRoom
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.RoutineEntry
import works.windmill.gym.presentation.SessionStart
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.presentation.SetWrite
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutineSheetTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun routinePlanOpensOverTheListAndEditsWithoutAnyHistoryRead() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val entries = listOf(
                RoutineEntry(1, "bench-press", List(3) { SetTarget(8, 50.0) }),
                RoutineEntry(2, "barbell-row", List(3) { SetTarget(10, 40.0) }),
            )
            val server = EngineRoomFixture.server()
            // The routine and a workout on it are the account's, written on another phone under its own ids.
            EngineRoomFixture(tmp.newFolder(), scope).use { other -> runBlocking {
                other.select("u1"); other.pull(server)
                assertTrue(other.store.saveRoutine(RoutineDraft(name = "Push Day", entries = entries, creationId = "routine_push").capturingMovements(other.store.catalog)) is GymResult.Ok)
                other.training.startSession(SessionStart("remote01", other.now - 10_000, routineId = "routine_push"))
                other.training.appendSet("remote01", SetWrite("remoteset", "bench-press", 50.0, 8, other.now - 9_000))
                other.training.finishSession("remote01", other.now)
                other.sync(server)
            } }
            runBlocking { room.select("u1"); room.pull(server); room.store.refreshEngine() }
            assertNotNull("the routine has been trained", room.store.routine("routine_push")!!.lastTrainedAtMs)
            val store = room.store
            // The room comes down before the engine closes: its lifecycle watcher writes on pause.
            val visible = mutableStateOf(true)
            compose.setContent { if (visible.value) GymMaterial { GymRoom(room.account(), store) } }
            try {
                compose.onNodeWithText("Bench Press · Barbell Row").assertIsDisplayed()
                compose.onNodeWithText("Push Day").performClick()
                compose.onNodeWithTag("routine-sheet").assertIsDisplayed()
                compose.onAllNodesWithText("Push Day").assertCountEquals(2)
                compose.onNodeWithContentDescription("New routine").assertExists()
                compose.onNodeWithText("3 × 8 · 50 kg total").assertIsDisplayed()
                compose.onNodeWithText("3 × 10 · 40 kg total").assertIsDisplayed()
                compose.onNodeWithText("History").assertDoesNotExist()
                compose.onNodeWithText("Last trained", substring = true).assertDoesNotExist()
                compose.onNodeWithText("Rest 1:30").assertDoesNotExist()
                compose.onNodeWithText("Edit routine").performClick()
                compose.onNodeWithTag("routine-sheet").assertDoesNotExist()
                compose.onNodeWithContentDescription("Routine name").assertTextEquals("Push Day")
                compose.onNodeWithText("Recent changes").assertDoesNotExist()
                compose.onNodeWithText("3 × 8 · 50 kg total").assertIsDisplayed()
                compose.onNodeWithText("3 × 10 · 40 kg total").assertIsDisplayed()
                compose.onNodeWithContentDescription("Routine name").performTextReplacement("Push A")
                compose.onNodeWithText("Save").performClick()
                compose.onNodeWithTag("routine-sheet").assertIsDisplayed()
                compose.onAllNodesWithText("Push A").assertCountEquals(2)
                compose.runOnIdle {
                    val saved = room.training.program().single { it.id == "routine_push" }
                    assertEquals("Push A", saved.name)
                    assertEquals(entries, saved.entries)
                }

                compose.onNodeWithContentDescription("Close sheet").performClick()
                compose.onNodeWithTag("routine-sheet").assertDoesNotExist()
                compose.onNodeWithText("Push A").assertIsDisplayed().performClick()
                compose.onNodeWithText("Start workout").performClick()
                compose.onNodeWithTag("routine-sheet").assertDoesNotExist()
                compose.runOnIdle { assertEquals("routine_push", store.session?.routineId) }
            } finally { compose.runOnIdle { visible.value = false }; compose.waitForIdle() }
        } } finally { scope.cancel() }
    }
    @Test fun yoursBelongsOnlyToCustomMovementsInTheSummary() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking {
                room.select(null)
                assertTrue(room.store.create("Landmine Press", "other", "ex_landmine", loadCount = 1) is GymResult.Ok)
                val draft = RoutineDraft(name = "Push", creationId = "routine_yours")
                    .adding("bench-press").adding("ex_landmine").capturingMovements(room.store.catalog)
                assertTrue(room.store.saveRoutine(draft) is GymResult.Ok)
            }
            val before = room.engine.snapshot()
            val visible = mutableStateOf(true)
            compose.setContent { if (visible.value) GymMaterial { GymRoom(room.account(), room.store) } }
            try {
                compose.onNodeWithText("Push").performClick()
                compose.onNodeWithText("Landmine Press · yours").assertIsDisplayed()
                compose.onNodeWithText("Bench Press · yours").assertDoesNotExist()
                compose.onNodeWithText("Bench Press").assertIsDisplayed()
                compose.onNodeWithText("Edit routine").performClick()
                compose.onNodeWithText("Landmine Press").assertIsDisplayed()
                compose.onNodeWithText("Landmine Press · yours").assertDoesNotExist()
                assertEquals(before, room.engine.snapshot())
            } finally { compose.runOnIdle { visible.value = false }; compose.waitForIdle() }
        } } finally { scope.cancel() }
    }

    @Test
    fun routineSummaryAndEditorShowEquipmentBasisAndSignedAddedLoad() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val entries = listOf(
                RoutineEntry(1, "dumbbell-bench-press", List(3) { SetTarget(10, 24.0) }),
                RoutineEntry(2, "goblet-squat", List(3) { SetTarget(8, 16.0) }),
                RoutineEntry(3, "leg-press", List(3) { SetTarget(12, 50.0) }),
                RoutineEntry(4, "pull-up", List(3) { SetTarget(8, -10.0) }),
            )
            runBlocking {
                room.select(null)
                assertTrue(room.store.saveRoutine(RoutineDraft(name = "Mixed equipment", entries = entries, creationId = "routine_mixed").capturingMovements(room.store.catalog)) is GymResult.Ok)
            }
            val visible = mutableStateOf(true)
            compose.setContent { if (visible.value) GymMaterial { GymRoom(room.account(), room.store) } }
            try {
                compose.onNodeWithText("Mixed equipment").performClick()
                val targets = listOf("3 × 10 · 24 kg each", "3 × 8 · 16 kg", "3 × 12 · 50 kg", "3 × 8 · −10 kg added")
                targets.forEach { compose.onNodeWithText(it).assertIsDisplayed() }
                compose.onNodeWithText("Edit routine").performClick()
                targets.forEach { compose.onNodeWithText(it).assertIsDisplayed() }
                entries.forEachIndexed { index, entry ->
                    val name = room.store.catalog.first { it.id == entry.exerciseId }.name
                    compose.onNodeWithContentDescription("Move $name, ${index + 1} of 4").assertIsDisplayed()
                }
            } finally { compose.runOnIdle { visible.value = false }; compose.waitForIdle() }
        } } finally { scope.cancel() }
    }

}
