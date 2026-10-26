package works.windmill.platform.auth

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.platform.design.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SignInDoorLayoutTests {
    @get:Rule val compose = createComposeRule()
    private val server = MockWebServer()
    @Before fun start() { server.start() }
    @After fun stop() { server.shutdown() }
    @Test fun darkDoorKeepsItsActionAboveTheKeyboardAtDoubleText() = door(true)
    @Test fun lightDoorKeepsItsActionAboveTheKeyboardAtDoubleText() = door(false)

    private fun door(dark: Boolean) {
        val auth = AuthStore(server.url("/"), MemorySessions())
        runBlocking { auth.restore() }
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(410).setBody("""{"error":"That code didn't work","detail":"Check the digits, or send a fresh one."}"""))
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(2f, 2f), LocalWindmillDark provides dark) {
                WindmillMaterial { Box(Modifier.height(340.dp)) { SignInDoor(auth) } }
            }
        }
        compose.onNodeWithContentDescription("Email field").performScrollTo().performTextReplacement("a-very-long-address@example.com")
        val send = compose.onNodeWithText("Send code").assertIsDisplayed().assertIsEnabled()
        assertTrue(send.getBoundsInRoot().height >= 56.dp)
        val layouts = mutableListOf<TextLayoutResult>()
        send.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
        val layout = layouts.single()
        assertFalse(layout.didOverflowHeight)
        assertEquals("Send code".length, layout.getLineEnd(layout.lineCount - 1))
        send.performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Check your email").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Sign in").assertIsDisplayed().assertIsNotEnabled()
        compose.onNodeWithContentDescription("Code field").performScrollTo().performTextReplacement("246810")
        compose.onNodeWithText("Sign in").performClick()
        val refusal = "That code didn't work. Check the digits, or send a fresh one."
        compose.waitUntil(5_000) { compose.onAllNodesWithText(refusal).fetchSemanticsNodes().isNotEmpty() }
        val notice = compose.onNodeWithText(refusal).performScrollTo().assertIsDisplayed()
        val refusalLayouts = mutableListOf<TextLayoutResult>()
        notice.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(refusalLayouts)
        assertFalse(refusalLayouts.single().didOverflowHeight)
        assertEquals(refusal.length, refusalLayouts.single().getLineEnd(refusalLayouts.single().lineCount - 1))
        compose.onNodeWithText("Sign in").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("Change email").assertIsDisplayed().performClick()
        compose.onNodeWithContentDescription("Email field").performScrollTo().assertTextContains("a-very-long-address@example.com")
        compose.onNodeWithText("Send code").assertIsDisplayed()
    }
}
