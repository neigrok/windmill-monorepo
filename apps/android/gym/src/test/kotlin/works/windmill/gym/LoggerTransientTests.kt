package works.windmill.gym

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.DpRect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.presentation.Ladder
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.WithheldDelete
import works.windmill.gym.store.Withheld
import works.windmill.gym.ui.GymMaterial

// The room's transient over the logger. Log set offers no way back — the set goes to the log at
// once. A deleted set's way back is said for nine seconds, and for those nine seconds it must cover
// no control of the rack: the logger hosts it over its own reading region, and the rack grows no
// inset for it — nothing moves.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h731dp-xhdpi")
class LoggerTransientTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    // The room flushes through the engine as it leaves, so the screen goes before the engine closes.
    private var showing by mutableStateOf(true)

    // The room connects the store again on mount and reads the open session back off the engine.
    private fun live(room: EngineRoomFixture) {
        runBlocking {
            room.select("u1")
            room.startExternalWorkout()
            room.store.choose("bench-press")
        }
    }

    private fun DpRect.overlaps(other: DpRect) =
        left < other.right && other.left < right && top < other.bottom && other.top < bottom

    private fun bounds(matcher: SemanticsMatcher) = compose.onNode(matcher).getBoundsInRoot()

    @Test
    fun logSetHasNoUndoAndWeightUndoCoversNoControlOfTheRack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        try {
            val store = room.store
            live(room)
            val sessionId = store.session!!.id
            compose.setContent { if (showing) GymMaterial { GymRoom(room.account(), store) } }
            compose.waitForIdle()
            val logBefore = compose.onNodeWithText("Log set").assertIsDisplayed().getBoundsInRoot()

            compose.onNodeWithText("Log set").performClick()
            compose.waitForIdle()
            compose.onNodeWithText(Withheld.undo).assertDoesNotExist()
            val logged = compose.runOnIdle { store.sets.single() }
            assertEquals("the set is on the log the moment it is logged",
                listOf(TrainingSet(id = logged.id, exerciseId = "bench-press", weightKg = 20.0, reps = 5,
                    completedAtMs = logged.completedAtMs)),
                runBlocking { room.training.session(sessionId) }!!.sets)

            compose.runOnIdle { runBlocking { assertNull(store.weighIn("2026-09-01", 81.25)) } }
            compose.runOnIdle { store.withhold(Deletion.Bodyweight("2026-09-01")) }
            val said = "Weigh-in deleted."
            compose.waitUntil(10_000) { compose.onAllNodesWithText(said).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(Withheld.undo).assertIsDisplayed()

            // The snackbar's own box — the live region Material declares around it, margin included.
            val transient = compose
                .onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion), useUnmergedTree = true)
                .getBoundsInRoot()
            val rack = listOf(
                "Load, kg total", "Decrease Reps", "Reps", "Increase Reps",
            ).map { it to bounds(hasContentDescription(it)) } +
                Ladder.labels(20.0).map { it to bounds(hasText(it) and hasClickAction()) } +
                ("Log set" to compose.onNodeWithText("Log set").getBoundsInRoot())
            rack.forEach { (name, control) ->
                assertFalse("the transient $transient covers $name at $control", transient.overlaps(control))
            }
            assertEquals("Log set moved for the transient", logBefore, compose.onNodeWithText("Log set").getBoundsInRoot())

            compose.onNodeWithText(Withheld.undo).performClick()
            compose.runOnIdle {
                assertEquals(listOf(logged), store.sets)
                assertEquals(listOf(81.25), store.bodyweight.map { it.weightKg })
                assertEquals(emptyList<WithheldDelete>(), store.withheld)
            }
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }

    @Test
    fun whileTheLoggerSlidesAwayTheUndoIsDrawnOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        try {
            val store = room.store
            live(room)
            compose.setContent { if (showing) GymMaterial { GymRoom(room.account(), store) } }
            compose.waitForIdle()
            compose.runOnIdle { runBlocking { assertNull(store.weighIn("2026-09-01", 81.25)) } }
            compose.runOnIdle { store.withhold(Deletion.Bodyweight("2026-09-01")) }
            compose.waitUntil(10_000) { compose.onAllNodesWithText(Withheld.undo).fetchSemanticsNodes().isNotEmpty() }

            compose.mainClock.autoAdvance = false
            compose.onNodeWithContentDescription("Hide workout").performClick()
            // Frame by frame until the log stands beneath the logger that is sliding off it.
            repeat(30) {
                if (compose.onAllNodesWithText("The log").fetchSemanticsNodes().isEmpty()) compose.mainClock.advanceTimeByFrame()
            }
            compose.onAllNodesWithText("The log").assertCountEquals(1)
            compose.onAllNodesWithText("Log set").assertCountEquals(1)
            compose.onAllNodesWithText(Withheld.undo).assertCountEquals(1)
            compose.mainClock.autoAdvance = true
            compose.waitForIdle()
            compose.onAllNodesWithText("Log set").assertCountEquals(0)
            compose.onAllNodesWithText(Withheld.undo).assertCountEquals(1)
        } finally {
            compose.mainClock.autoAdvance = true
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
}
