package works.windmill.platform.auth

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.io.IOException
import works.windmill.platform.User
import works.windmill.platform.design.WindmillMaterial

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SignInDoorTests {
    @get:Rule val compose = createComposeRule()
    private val server = MockWebServer()
    @Before fun start() { server.start() }
    @After fun stop() { server.shutdown() }

    @Test fun rawRefusalsSurviveRestorationBeforeCodeRetry() {
        val auth = AuthStore(server.url("/"), MemorySessions())
        runBlocking { auth.restore() }
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"Use a valid email."}"""))
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"expired"}"""))
        server.enqueue(MockResponse().setBody("""{"user":{"id":"A","email":"a@example.com","name":"Ana"}}""")
            .addHeader("Set-Cookie", "wm_session=fresh; Path=/; HttpOnly"))
        var done = 0
        val restoration = StateRestorationTester(compose)
        restoration.setContent { WindmillMaterial { Box(Modifier.height(700.dp)) {
            SignInDoor(auth, { done++ })
        } } }
        compose.onNodeWithContentDescription("Email field").performTextReplacement("  a@example.com  ")
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Use a valid email.").fetchSemanticsNodes().isNotEmpty() }
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription("Email field").assertTextContains("  a@example.com  ")
        compose.onNodeWithText("Use a valid email.").assertIsDisplayed()
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Check your email").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Code field").performTextReplacement(" 123456 ")
        compose.onNodeWithText("Sign in").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText(MagicLink.expiredCode).fetchSemanticsNodes().isNotEmpty() }
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription("Code field").assertTextContains(" 123456 ")
        compose.onNodeWithText(MagicLink.expiredCode).performScrollTo().assertIsDisplayed()
        val finalClick = compose.onNodeWithText("Sign in").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnIdle { finalClick() }
        compose.waitUntil(5_000) { done == 1 }
        compose.runOnIdle { finalClick(); assertEquals(4, server.requestCount) }
        assertEquals(AuthStatus.SignedIn(User("A", "a@example.com", "Ana")), auth.status)
        assertEquals(listOf("""{"email":"a@example.com","door":"app"}""", """{"email":"a@example.com","door":"app"}""",
            """{"email":"a@example.com","code":"123456"}""", """{"email":"a@example.com","code":"123456"}"""),
            List(4) { server.takeRequest().body.readUtf8() })
    }

    @Test fun resendUsesItsRestoredDeadlineAndPastedLinkUsesTheExistingParser() {
        val auth = AuthStore(server.url("/"), MemorySessions())
        runBlocking { auth.restore() }
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("{}").setBodyDelay(1, TimeUnit.SECONDS))
        server.enqueue(MockResponse().setBody("""{"user":{"id":"A","email":"a@example.com","name":"Ana"}}""")
            .addHeader("Set-Cookie", "wm_session=fresh; Path=/; HttpOnly"))
        var clock by mutableLongStateOf(1_000L)
        var done = 0
        val restoration = StateRestorationTester(compose)
        restoration.setContent { WindmillMaterial { SignInDoor(auth, { done++ }, now = { clock }) } }
        compose.onNodeWithContentDescription("Email field").performTextReplacement("a@example.com")
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Resend in 30s").fetchSemanticsNodes().isNotEmpty() }
        compose.runOnIdle { clock = 11_000L }
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("Resend in 20s").assertIsNotEnabled()
        compose.runOnIdle { clock = 31_000L }
        compose.onNodeWithText("Resend").assertIsEnabled().performClick()
        compose.waitUntil(5_000) { server.requestCount == 2 }
        compose.onNodeWithText("Sending…").assertIsDisplayed().assertIsNotEnabled()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Resend in 30s").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Code field").performTextReplacement(" https://windmill.works/#/auth?token=exact-token&next=log ")
        compose.onNodeWithText("Sign in").performClick()
        compose.waitUntil(5_000) { done == 1 }
        server.takeRequest(); server.takeRequest()
        val request = server.takeRequest()
        assertEquals("/v1/auth/verify", request.path)
        assertEquals("""{"token":"exact-token"}""", request.body.readUtf8())
    }

    @Test fun pendingRequestIsSingleFlightAndAReplacedAuthStoreCannotReceiveItsReply() {
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                release.await(5, TimeUnit.SECONDS)
                return MockResponse().setBody("{}")
            }
        }
        val old = AuthStore(server.url("/"), MemorySessions())
        runBlocking { old.restore() }
        var auth by mutableStateOf(old)
        var busy = false
        compose.setContent { WindmillMaterial { SignInDoor(auth, onBusy = { busy = it }) } }
        compose.onNodeWithContentDescription("Email field").performTextReplacement("old@example.com")
        val click = compose.onNodeWithText("Send code").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnIdle { click(); click() }
        compose.waitUntil(5_000) { server.requestCount == 1 }
        compose.onNodeWithText("Sending…").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Email field").assertIsNotEnabled()
        compose.runOnIdle { assertTrue(busy); auth = AuthStore(server.url("/"), MemorySessions()) }
        compose.runOnIdle { assertFalse(busy); release.countDown() }
        compose.waitUntil(5_000) { old.linkSentTo != null }
        compose.onNodeWithText("Check your email").assertDoesNotExist()
        compose.runOnIdle { assertFalse(busy); assertEquals(1, server.requestCount) }
    }

    @Test fun aFailedSessionWriteKeepsTheCodeAndDoesNotCommitCredentials() {
        val memory = MemorySessions()
        var stages = 0
        val sessions = object : SessionStore by memory {
            override fun stage(proposed: ProposedSignIn) {
                assertEquals(ProposedSignIn("fresh", User("A", "a@example.com", "Ana")), proposed)
                assertNull(memory.read())
                stages++
                if (stages == 1) throw IOException("disk full")
                memory.stage(proposed)
            }
        }
        val auth = AuthStore(server.url("/"), sessions)
        runBlocking { auth.restore() }
        server.enqueue(MockResponse().setBody("{}"))
        repeat(2) { server.enqueue(MockResponse().setBody("""{"user":{"id":"A","email":"a@example.com","name":"Ana"}}""")
            .addHeader("Set-Cookie", "wm_session=fresh; Path=/; HttpOnly")) }
        var done = 0
        compose.setContent { WindmillMaterial { SignInDoor(auth, { done++ }) } }
        compose.onNodeWithContentDescription("Email field").performTextReplacement("a@example.com")
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Check your email").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Code field").performTextReplacement(" 123456 ")
        compose.onNodeWithText("Sign in").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Sign-in could not be completed. Try again.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Code field").assertTextContains(" 123456 ")
        assertNull(sessions.read())
        assertEquals(AuthStatus.SignedOut, auth.status)
        assertEquals(0, done)
        compose.onNodeWithText("Sign in").performClick()
        compose.waitUntil(5_000) { done == 1 }
        assertEquals("fresh", sessions.read())
        assertEquals(2, stages)
    }
}
