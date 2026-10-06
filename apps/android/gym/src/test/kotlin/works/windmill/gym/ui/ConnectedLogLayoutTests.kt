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
import kotlinx.coroutines.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.LogLevel
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.platform.design.LocalWindmillDark

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
        EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest()).use { room ->
            runBlocking { room.select("A") }
            compose.setContent {
                CompositionLocalProvider(LocalDensity provides Density(2f, 2f), LocalWindmillDark provides dark) {
                    GymMaterial { ConnectedLogScreen(room.store, true, "https://windmill.works", "Settings", {}, {}) }
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
        }
        scope.cancel()
    }
}
