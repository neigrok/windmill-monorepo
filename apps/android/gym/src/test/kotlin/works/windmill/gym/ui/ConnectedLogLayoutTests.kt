package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import java.io.File
import kotlinx.coroutines.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.LogLevel
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.*
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConnectedLogLayoutTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    @Test fun instrumentWrapsThePermissionAndDisclosureText() = screen(true)
    @Test fun daylightWrapsThePermissionAndDisclosureText() = screen(false)

    private fun screen(dark: Boolean) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")),
            LocalLog(File(tmp.root, "log")), LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")),
            scope, sync = { server })
        runBlocking { store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), User("A", "a@example.com", "A"))) }
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(2f, 2f), LocalWindmillDark provides dark) {
                GymMaterial { ConnectedLogScreen(store, true, "https://windmill.works", "Settings", {}, {}) }
            }
        }
        for (text in LogLevel.entries.map { it.meta } + ConnectedLog.caption) {
            compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(text))
            compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()
        }
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(ConnectedLog.disclosure))
        compose.onNodeWithText(ConnectedLog.disclosure).performScrollTo().performClick()
        for (text in ConnectedLog.how) {
            compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(text))
            val node = compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()
            val layouts = mutableListOf<TextLayoutResult>()
            node.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
            val layout = layouts.single()
            assertFalse(layout.didOverflowHeight)
            assertEquals(text.length, layout.getLineEnd(layout.lineCount - 1))
            for (line in 0 until layout.lineCount) {
                assertFalse(layout.isLineEllipsized(line))
                assertTrue(layout.getLineRight(line) - layout.getLineLeft(line) <= layout.size.width + 1)
            }
        }
        val action = compose.onNodeWithText(ConnectedLog.action).assertIsDisplayed()
        assertTrue(action.getBoundsInRoot().height >= 56.dp)
        scope.cancel()
    }
}
