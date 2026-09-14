package works.windmill.platform.you

import androidx.activity.ComponentDialog
import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.MemorySessions
import works.windmill.platform.auth.MagicLink
import works.windmill.platform.design.WindmillMaterial

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class YouSheetTests {
    @get:Rule val compose = createComposeRule()
    private val server = MockWebServer()
    @Before fun start() { server.start() }
    @After fun stop() { server.shutdown() }

    @Test fun signedOutOverviewKeepsDestinationsAndDismissesBeforeOpeningOneOnce() {
        val auth = AuthStore(server.url("/"), MemorySessions())
        runBlocking { auth.restore() }
        var visible by mutableStateOf(true)
        val events = mutableListOf<String>()
        compose.setContent { WindmillMaterial { if (visible) YouSheet(auth,
            onDismiss = { events += "dismiss"; visible = false },
            destinations = listOf(YouDestination("settings", "Product settings") { events += "settings" }),
            onAuthDismiss = { events += "auth canceled" }) } }
        compose.onNodeWithText("You").assertIsDisplayed()
        compose.onNodeWithText("Sign in").assertIsDisplayed()
        compose.onNodeWithContentDescription("Email field").assertDoesNotExist()
        val click = compose.onNodeWithText("Product settings").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnIdle { click(); click() }
        compose.waitUntil(5_000) { !visible }
        assertEquals(listOf("dismiss", "settings"), events)
        compose.onNodeWithText("You").assertDoesNotExist()
    }

    @Test fun authOnlyNativeBackCancelsItsExactFlowAfterFullDismissal() {
        val auth = AuthStore(server.url("/"), MemorySessions())
        runBlocking { auth.restore() }
        var visible by mutableStateOf(true)
        val events = mutableListOf<String>()
        compose.setContent { WindmillMaterial { if (visible) YouSheet(auth,
            onDismiss = { events += "dismiss"; visible = false }, startSignIn = true, flowId = "claim-flow",
            onAuthDismiss = { events += "cancel:$it" }) } }
        compose.onNodeWithContentDescription("Email field").assertIsDisplayed()
        compose.onNodeWithText("You").assertDoesNotExist()
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(5_000) { !visible }
        assertEquals(listOf("cancel:claim-flow", "dismiss"), events)
    }

    @Test fun anUpwardDragInterruptsDismissalAndTheDestinationCanBeRetriedOnce() {
        val auth = AuthStore(server.url("/"), MemorySessions())
        runBlocking { auth.restore() }
        var visible by mutableStateOf(true)
        val events = mutableListOf<String>()
        compose.setContent { WindmillMaterial { if (visible) YouSheet(auth,
            onDismiss = { events += "dismiss"; visible = false },
            destinations = listOf(YouDestination("settings", "Product settings") { events += "settings" })) } }
        val destination = compose.onNodeWithText("Product settings")
        val click = destination.fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { click() }
        compose.mainClock.advanceTimeBy(48)
        destination.assertIsNotEnabled()
        compose.onNodeWithContentDescription("Drag handle", useUnmergedTree = true).performTouchInput {
            down(center)
            moveBy(Offset(0f, -160f), delayMillis = 32)
            up()
        }
        compose.mainClock.advanceTimeBy(1_000)
        compose.mainClock.autoAdvance = true
        compose.runOnIdle { assertTrue(visible); assertEquals(emptyList<String>(), events) }
        destination.assertIsDisplayed().assertIsEnabled().performClick()
        compose.waitUntil(5_000) { !visible }
        assertEquals(listOf("dismiss", "settings"), events)
    }

    @Test fun pendingSendBlocksTheModalDispatcherAndItsDismissSemantics() {
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                release.await(5, TimeUnit.SECONDS)
                return MockResponse().setResponseCode(400).setBody("""{"error":"Try another email."}""")
            }
        }
        val auth = AuthStore(server.url("/"), MemorySessions())
        runBlocking { auth.restore() }
        var visible by mutableStateOf(true)
        val canceled = mutableListOf<String?>()
        compose.setContent { WindmillMaterial { if (visible) YouSheet(auth, { visible = false },
            startSignIn = true, flowId = "flow", onAuthDismiss = { canceled += it }) } }
        compose.onNodeWithContentDescription("Email field").performTextReplacement("a@example.com")
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { server.requestCount == 1 }
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("Sending…").assertIsDisplayed().assertIsNotEnabled()
        compose.runOnIdle { assertTrue(visible); assertTrue(canceled.isEmpty()); release.countDown() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Try another email.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Email field").assertTextContains("a@example.com")
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(5_000) { !visible }
        assertEquals(listOf("flow"), canceled)
    }

    @Test fun modalBodyRestoresRawCodeAndRefusalWithAFreshAuthStore() {
        var auth by mutableStateOf(AuthStore(server.url("/"), MemorySessions()))
        runBlocking { auth.restore() }
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"expired"}"""))
        val restoration = StateRestorationTester(compose)
        restoration.setContent { WindmillMaterial { YouSheet(auth, {}, startSignIn = true, flowId = "flow") } }
        compose.onNodeWithContentDescription("Email field").performTextReplacement("a@example.com")
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Check your email").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Code field").performTextReplacement(" 123456 ")
        compose.onNodeWithText("Sign in").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText(MagicLink.expiredCode).fetchSemanticsNodes().isNotEmpty() }
        compose.runOnIdle { auth = AuthStore(server.url("/"), MemorySessions()) }
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription("Code field").assertTextContains(" 123456 ")
        compose.onNodeWithText("Code sent to a@example.com.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(MagicLink.expiredCode).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Sign in").assertIsEnabled()
        assertEquals(2, server.requestCount)
    }
}
