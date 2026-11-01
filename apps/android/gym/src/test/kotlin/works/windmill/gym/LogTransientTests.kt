package works.windmill.gym

import android.content.Context
import android.view.accessibility.AccessibilityManager
import androidx.activity.ComponentDialog
import androidx.test.core.app.ApplicationProvider
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowDialog
import java.time.LocalDate
import works.windmill.gym.presentation.Bodyweight
import works.windmill.gym.store.*
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.design.LocalWindmillDark

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LogTransientTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    // The room flushes through the engine as it leaves, so the screen goes before the engine closes.
    private var showing by mutableStateOf(true)

    // The log draws only what the wall clock has reached, so the workouts happen in its past.
    private val past = 1_700_000_000_000L

    @Test fun instrumentRaisesUndoAboveAStillWeighIn() = undoAboveAStillAction(true, 1f)
    @Test fun daylightAtDoubleTextRaisesUndoAboveAStillWeighIn() = undoAboveAStillAction(false, 2f)

    private fun undoAboveAStillAction(dark: Boolean, fontScale: Float) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), scope).apply { now = past }
        try {
            val (one, two) = runBlocking {
                room.select("a")
                listOf(room.workout(), room.workout(100.0, "back-squat")).map { it.id }
            }
            val original = room.training.details()
            val store = room.store
            compose.setContent {
                if (showing) CompositionLocalProvider(LocalWindmillDark provides dark, LocalDensity provides Density(2f, fontScale)) {
                    GymMaterial { GymRoom(room.account(), store) }
                }
            }
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            val before = compose.onNodeWithContentDescription(Bodyweight.chip).getBoundsInRoot()
            compose.runOnIdle { store.deletions.withhold(Deletion.Session(one)); store.deletions.withhold(Deletion.Session(two)) }
            compose.onNodeWithText(Withheld.undo).assertIsDisplayed()
            val snackbar = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion) and
                SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss), useUnmergedTree = true)
                .getBoundsInRoot()
            val action = compose.onNodeWithContentDescription(Bodyweight.chip).assertIsDisplayed().getBoundsInRoot()
            assertEquals("Weigh in never moves for the transient", before, action)
            assertTrue("Undo must rise above Weigh in: $snackbar / $action", snackbar.bottom <= action.top)
            assertTrue(action.height >= 56.dp)
            compose.onNodeWithContentDescription(Bodyweight.chip).performClick()
            compose.onNodeWithText(Bodyweight.save).assertIsDisplayed()
            compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
            compose.onNodeWithText(Withheld.undo).performClick()
            compose.runOnIdle {
                assertEquals(listOf(one), store.held.withheld.map { it.subjectId })
                assertEquals(listOf(two), store.history.recent.map { it.id })
                assertEquals(original, room.training.details())
            }
            assertEquals(before, compose.onNodeWithContentDescription(Bodyweight.chip).assertIsDisplayed().getBoundsInRoot())
            compose.onNodeWithText(Withheld.undo).performClick()
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(emptyList<WithheldDelete>(), store.held.withheld)
                assertEquals(listOf(two, one), store.history.recent.map { it.id })
                assertEquals(original, room.training.details())
            }
            assertEquals(before, compose.onNodeWithContentDescription(Bodyweight.chip).getBoundsInRoot())
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }

    // A lifter who asked the system for more time to act keeps the weigh-in's Undo past nine seconds.
    @Test fun weighInUndoLastsTheAccessibilityTimeout() {
        val accessibility = ApplicationProvider.getApplicationContext<Context>().getSystemService(AccessibilityManager::class.java)
        shadowOf(accessibility).setInteractiveUiTimeout(20_000)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        val day = LocalDate.now().toString()
        try {
            room.now = System.currentTimeMillis()
            runBlocking {
                room.select(null)
                assertNull(room.store.bodyweight.weighIn(day, 82.4))
            }
            room.store.observeEngine()
            val store = room.store
            val weighed = store.bodyweight.drawn
            compose.setContent { if (showing) GymMaterial { GymRoom(room.account(), store) } }
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            val at = compose.runOnIdle {
                assertEquals(20_000L, store.deletions.undoWindowMs)
                room.now.also { store.deletions.withhold(Deletion.Bodyweight(day)) }
            }
            compose.onNodeWithText(Withheld.undo).assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(listOf(day to at + 20_000), store.held.withheld.map { it.subjectId to it.untilMs })
                room.now = at + 15_000
            }
            compose.onNodeWithText(Withheld.undo).performClick()
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(emptyList<WithheldDelete>(), store.held.withheld)
                assertEquals(weighed, store.bodyweight.drawn)
                assertEquals(emptyList<Any>(), room.engine.undoOffers())
            }
            compose.onNodeWithText(Withheld.alreadyGone).assertDoesNotExist()
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
}
