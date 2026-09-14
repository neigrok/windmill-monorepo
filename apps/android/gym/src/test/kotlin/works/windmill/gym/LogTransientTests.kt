package works.windmill.gym

import android.os.SystemClock
import androidx.activity.ComponentDialog
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Session
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.*
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LogTransientTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test fun instrumentKeepsWeighInAboveIndependentUndoWindows() = actionAboveUndo(true, 1f)
    @Test fun daylightAtDoubleTextKeepsWeighInAboveIndependentUndoWindows() = actionAboveUndo(false, 2f)

    private fun actionAboveUndo(dark: Boolean, fontScale: Float) {
        val account = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), User("a", "a@example.com", "A"))
        val server = FakeTraining().apply {
            stored["one"] = Session("one", 1_000, finishedAtMs = 2_000, plan = PlanSnapshot("One", emptyList()))
            stored["two"] = Session("two", 3_000, finishedAtMs = 4_000, plan = PlanSnapshot("Two", emptyList()))
        }
        val original = server.stored.toMap()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = TrainingStore(SetQueue(File(tmp.root, "queue"), clock = SystemClock::uptimeMillis),
            DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), scope,
            now = SystemClock::uptimeMillis, sync = { server })
        compose.setContent {
            CompositionLocalProvider(LocalWindmillDark provides dark, LocalDensity provides Density(2f, fontScale)) {
                GymMaterial { GymRoom(account, store) }
            }
        }
        compose.onNode(hasText("Log") and hasClickAction()).performClick()
        val before = compose.onNodeWithText(Bodyweight.chip).getBoundsInRoot()
        compose.runOnIdle { store.withhold(Deletion.Session("one")); store.withhold(Deletion.Session("two")) }
        compose.onNodeWithText(Withheld.undo).assertIsDisplayed()
        val snackbar = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion), useUnmergedTree = true)
            .getBoundsInRoot()
        val action = compose.onNodeWithText(Bodyweight.chip).assertIsDisplayed().getBoundsInRoot()
        assertTrue("Weigh in must sit above Undo: $action / $snackbar", action.bottom <= snackbar.top)
        assertTrue(action.height >= 56.dp)
        compose.onNodeWithText(Bodyweight.chip).performClick()
        compose.onNodeWithText(Bodyweight.save).assertIsDisplayed()
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText(Withheld.undo).performClick()
        compose.runOnIdle {
            assertEquals(listOf("one"), store.withheld.map { it.subjectId })
            assertEquals(listOf("two"), store.recent.map { it.id })
            assertEquals(original, server.stored)
        }
        compose.onNodeWithText(Bodyweight.chip).assertIsDisplayed()
        compose.onNodeWithText(Withheld.undo).performClick()
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(emptyList<WithheldDelete>(), store.withheld)
            assertEquals(listOf("two", "one"), store.recent.map { it.id })
            assertEquals(original, server.stored)
        }
        assertEquals(before, compose.onNodeWithText(Bodyweight.chip).getBoundsInRoot())
        scope.cancel()
    }
}
