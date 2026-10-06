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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.TrainingSet
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
            room.store.start(null)
            room.store.choose("bench-press")
        }
    }

    private fun DpRect.overlaps(other: DpRect) =
        left < other.right && other.left < right && top < other.bottom && other.top < bottom

    private fun bounds(matcher: SemanticsMatcher) = compose.onNode(matcher).getBoundsInRoot()

    @Test
    fun testLogSetOffersNoWayBackAndADeletedSetsWayBackCoversNoControlOfTheRack() {
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

            compose.runOnIdle { store.withhold(Deletion.Set(sessionId, logged)) }
            val said = "20 kg × 5 is out of the log."
            compose.waitUntil(10_000) { compose.onAllNodesWithText(said).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(Withheld.undo).assertIsDisplayed()

            // The snackbar's own box — the live region Material declares around it, margin included.
            val transient = compose
                .onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion), useUnmergedTree = true)
                .getBoundsInRoot()
            val rack = listOf(
                "Weight 20 kg", "one rep fewer", "Reps 5", "one rep more",
            ).map { it to bounds(hasContentDescription(it)) } +
                Ladder.labels(20.0).map { it to bounds(hasText(it) and hasClickAction()) } +
                ("Log set" to compose.onNodeWithText("Log set").getBoundsInRoot())
            rack.forEach { (name, control) ->
                assertFalse("the transient $transient covers $name at $control", transient.overlaps(control))
            }
            assertEquals("Log set moved for the transient", logBefore, compose.onNodeWithText("Log set").getBoundsInRoot())

            compose.onNodeWithText(Withheld.undo).performClick()
            compose.runOnIdle {
                assertEquals("Undo puts the set back", listOf(logged), store.sets)
                assertEquals(emptyList<WithheldDelete>(), store.withheld)
            }
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
}
