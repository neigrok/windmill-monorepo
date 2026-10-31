package works.windmill.gym.ui

import androidx.compose.runtime.*
import kotlinx.coroutines.launch
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.sharing.WorkoutShareActions
import works.windmill.gym.domain.Review
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FinishOutcome
import works.windmill.sync.core.Json

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SessionDiscardTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val doors = WorkoutShareActions(
        origin = "https://windmill.works",
        mint = { error("no link is minted here") },
        revoke = { error("no link is revoked here") },
    )

    private fun store(scope: CoroutineScope): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        room.now = System.currentTimeMillis() - 60_000
        val server = EngineRoomFixture.server()
        runBlocking {
            room.select("u1")
            room.pull(server)
            room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.store.logSet(weightKg = 90.0, reps = 3)
            room.store.logSet(weightKg = 90.0, reps = 3)
            room.store.logSet(weightKg = 90.0, reps = 2)
            room.now += 60_000
            assertTrue(room.store.finish() is FinishOutcome.Closed)
            room.sync(server)
            room.store.refreshEngine()
        }
        room.store.observeEngine()
        return room
    }

    private fun screen(room: EngineRoomFixture) {
        val summary = room.store.recent.single()
        compose.setContent {
            var pending by remember { mutableStateOf(false) }
            var busy by remember { mutableStateOf(false) }
            val scope = rememberCoroutineScope()
            GymMaterial {
            SessionScreen(
                summary = summary,
                store = room.store,
                sharing = doors,
                backTo = "The log",
                onBack = {},
                say = {},
                onOpenMovement = {},
                onDiscard = { pending = true },
            )
            if (pending) WorkoutDiscardDialog(summary.setCount, busy = busy,
                onCancel = { pending = false }, onDiscard = {
                    if (!busy && pending) {
                        busy = true
                        scope.launch {
                            assertEquals(null, room.store.discardWorkout(summary.id))
                            pending = false
                            busy = false
                        }
                    }
                })
            }
        }
    }

    @Test
    fun testTheReviewScreenDrawsDiscardSoTheLongPressIsNeverTheOnlyPath() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            screen(room)

            compose.onNodeWithText("Discard workout").performScrollTo().assertIsDisplayed()
            compose.runOnIdle {
                assertEquals("and this is NOT the slight session the finish screen draws it for",
                    works.windmill.gym.domain.sync.SessionReview.slightSets, room.store.recent.single().workingSetCount)
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun theSharedDialogCancelsWithoutAWriteAndConfirmsAnImmediateDiscard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            val workout = room.store.recent.single()
            screen(room)
            val before = room.engine.snapshot()
            compose.onNodeWithText("Discard workout").performScrollTo().performClick()
            compose.onNodeWithText("Discard this workout?").assertIsDisplayed()
            compose.onNodeWithText("This deletes the workout and its 4 sets. You can’t undo this.").assertIsDisplayed()
            compose.onNodeWithText("Cancel").performClick()
            compose.runOnIdle { assertEquals(before, room.engine.snapshot()) }
            compose.onNodeWithText("Discard workout").performScrollTo().performClick()
            compose.onNodeWithText("Discard").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Discard this workout?").fetchSemanticsNodes().isEmpty() }
            compose.runOnIdle {
                assertEquals(null, runBlocking { room.training.session(workout.id) })
                assertEquals(emptyList<String>(), room.store.recent.map { it.id })
                assertEquals(emptyList<works.windmill.gym.store.Withheld>(), room.store.withheld)
            }
            compose.onNodeWithText("Undo").assertDoesNotExist()
        } } finally { scope.cancel() }
    }
}
