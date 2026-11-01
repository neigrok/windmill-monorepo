package works.windmill.platform.auth

import android.text.InputType
import android.view.View
import android.view.inputmethod.EditorInfo
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import works.windmill.platform.design.LocalWindmillDark
import kotlinx.coroutines.*
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
import works.windmill.platform.telemetry.Telemetry

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
        server.enqueue(MockResponse().setResponseCode(410).setBody("""{"error":"That code didn't work","detail":"Check the digits, or send a fresh one."}"""))
        val refusedCode = "That code didn't work. Check the digits, or send a fresh one."
        server.enqueue(MockResponse().setBody("""{"user":{"id":"A","email":"a@example.com","name":"Ana"}}""")
            .addHeader("Set-Cookie", "wm_session=fresh; Path=/; HttpOnly"))
        var done = 0
        val restoration = StateRestorationTester(compose)
        restoration.setContent { WindmillMaterial { Box(Modifier.height(700.dp)) {
            SignInDoor(auth, { done++ })
        } } }
        compose.onNodeWithText("Training on this phone can join your account. If both have training, you choose Add or Discard.").assertDoesNotExist()
        compose.onNodeWithText("Email", useUnmergedTree = true).assertIsDisplayed()
        val field = compose.onNodeWithContentDescription("Email").getBoundsInRoot()
        val label = compose.onNodeWithText("Email", useUnmergedTree = true).getBoundsInRoot()
        assertTrue(label.top >= field.top && label.bottom <= field.bottom)
        compose.onNodeWithContentDescription("Email").performTextReplacement("  a@example.com  ")
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Use a valid email.").fetchSemanticsNodes().isNotEmpty() }
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription("Email").assertTextContains("  a@example.com  ")
        compose.onNodeWithText("Use a valid email.").assertIsDisplayed()
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Check your email").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Code").performTextReplacement(" 123456 ")
        compose.onNodeWithText("Sign in").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText(refusedCode).fetchSemanticsNodes().isNotEmpty() }
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription("Code").assertTextContains(" 123456 ")
        compose.onNodeWithText(refusedCode).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Works once. Expires in 15 minutes.").assertDoesNotExist()
        compose.onNodeWithContentDescription("Code").assert(SemanticsMatcher.expectValue(SemanticsProperties.Error, refusedCode))
        val finalClick = compose.onNodeWithText("Sign in").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnIdle { finalClick() }
        compose.waitUntil(5_000) { done == 1 }
        compose.runOnIdle { finalClick(); assertEquals(4, server.requestCount) }
        assertEquals(AuthStatus.SignedIn(User("A", "a@example.com", "Ana")), auth.status)
        assertEquals(listOf("""{"email":"a@example.com","door":"app"}""", """{"email":"a@example.com","door":"app"}""",
            """{"email":"a@example.com","code":"123456"}""", """{"email":"a@example.com","code":"123456"}"""),
            List(4) { server.takeRequest().body.readUtf8() })
    }

    @Test fun emailAndCodeOfferAutofillAndTheCodeOpensTheDigitKeyboard() {
        val auth = AuthStore(server.url("/"), MemorySessions())
        runBlocking { auth.restore() }
        server.enqueue(MockResponse().setBody("{}"))
        lateinit var view: View
        compose.setContent { view = LocalView.current; WindmillMaterial { SignInDoor(auth) } }
        fun keyboardOf(field: SemanticsNodeInteraction): Int {
            field.performClick()
            return compose.runOnIdle { EditorInfo().also { view.onCreateInputConnection(it) }.inputType }
        }
        fun hintsOf(field: SemanticsNodeInteraction): Set<*> {
            val contentType = field.fetchSemanticsNode().config[SemanticsProperties.ContentType]
            return contentType.javaClass.getDeclaredMethod("getAndroidAutofillHints").apply { isAccessible = true }.invoke(contentType) as Set<*>
        }
        val email = compose.onNodeWithContentDescription("Email")
        assertEquals(setOf("emailAddress"), hintsOf(email))
        assertEquals(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, keyboardOf(email))
        email.performTextReplacement("a@example.com")
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Check your email").fetchSemanticsNodes().isNotEmpty() }
        val code = compose.onNodeWithContentDescription("Code")
        assertEquals(setOf("smsOTPCode", "emailOTPCode"), hintsOf(code))
        assertEquals(InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD, keyboardOf(code))
        code.assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Password))
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
        compose.onNodeWithContentDescription("Email").performTextReplacement("a@example.com")
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
        compose.onNodeWithContentDescription("Code").performTextReplacement(" https://windmill.works/#/auth?token=exact-token&next=log ")
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
        compose.onNodeWithContentDescription("Email").performTextReplacement("old@example.com")
        val click = compose.onNodeWithText("Send code").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnIdle { click(); click() }
        compose.waitUntil(5_000) { server.requestCount == 1 }
        compose.onNodeWithText("Sending…").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Email").assertIsNotEnabled()
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
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation to properties }
        }
        val auth = AuthStore(server.url("/"), sessions, telemetry = telemetry)
        runBlocking { auth.restore() }
        server.enqueue(MockResponse().setBody("{}"))
        repeat(2) { server.enqueue(MockResponse().setBody("""{"user":{"id":"A","email":"a@example.com","name":"Ana"}}""")
            .addHeader("Set-Cookie", "wm_session=fresh; Path=/; HttpOnly")) }
        var done = 0
        compose.setContent { WindmillMaterial { SignInDoor(auth, { done++ }) } }
        compose.onNodeWithContentDescription("Email").performTextReplacement("a@example.com")
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Check your email").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Code").performTextReplacement(" 123456 ")
        compose.onNodeWithText("Sign in").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Sign-in could not be completed. Try again.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Code").assertTextContains(" 123456 ")
        assertNull(sessions.read())
        assertEquals(AuthStatus.SignedOut, auth.status)
        assertEquals(0, done)
        compose.onNodeWithText("Sign in").performClick()
        compose.waitUntil(5_000) { done == 1 }
        assertEquals("fresh", sessions.read())
        assertEquals(2, stages)
        assertEquals(listOf(
            "auth_restore" to mapOf("outcome" to "signed_out"),
            "auth_code_requested" to emptyMap(), "auth_code_sent" to emptyMap(),
            "auth_sign_in_started" to mapOf("method" to "code"),
            "auth_sign_in_started" to mapOf("method" to "code"),
            "auth_signed_in" to emptyMap(),
        ), events)
        assertEquals(listOf("auth_sign_in" to emptyMap<String, String>()), failures)
    }
    @Test fun aRecreatedFormAwaitsTheExistingHandoffAndCompletesExactlyOnce() = ownedHandoff(false)
    @Test fun aFailedOwnedHandoffKeepsThePriorAccountAndRetriesWithoutVerification() = ownedHandoff(true)

    private fun ownedHandoff(fails: Boolean) {
        val owner = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val prior = User("A", "a@example.com")
        val next = User("B", "b@example.com")
        val sessions = MemorySessions("sealed-A", prior)
        val failures = mutableListOf<String>()
        var visits = 0
        val auth = AuthStore(server.url("/"), sessions, handoffScope = owner,
            telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) = Unit
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
            }, lifecycle = object : AuthLifecycle {
                override suspend fun signedIn(user: User, token: String, restoring: Boolean) {
                    visits++
                    if (visits == 1) {
                        entered.complete(Unit); release.await()
                        if (fails) throw IOException("fixture storage failure")
                    }
                }
                override suspend fun signOut() = Unit
            })
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("""{"user":{"id":"B","email":"b@example.com"}}""")
            .addHeader("Set-Cookie", "wm_session=sealed-B; Path=/; HttpOnly"))
        var done = 0
        var busy = false
        val dark = mutableStateOf(true)
        val font = mutableFloatStateOf(1f)
        val restoration = StateRestorationTester(compose)
        restoration.setContent {
            CompositionLocalProvider(LocalWindmillDark provides dark.value, LocalDensity provides Density(1f, font.floatValue)) {
                WindmillMaterial { SignInDoor(auth, onDone = { done++ }, onBusy = { busy = it }) }
            }
        }
        try {
            compose.onNodeWithContentDescription("Email").performTextReplacement(next.email)
            compose.onNodeWithText("Send code").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Check your email").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("Code").performTextReplacement(" 123456 ")
            compose.onNodeWithText("Sign in").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { entered.isCompleted } }
            compose.onNodeWithText("Check your email").assertIsDisplayed()
            compose.onNodeWithText("Signing in…").assertIsNotEnabled()
            compose.onNodeWithContentDescription("Code").assertIsNotEnabled()
            restoration.emulateSavedInstanceStateRestore()
            compose.runOnIdle { dark.value = false; font.floatValue = 1.4f }
            compose.onNodeWithContentDescription("Code").assertTextContains(" 123456 ").assertIsNotEnabled()
            compose.onNodeWithText("Change email").assertIsNotEnabled()
            compose.runOnIdle { assertTrue(busy); assertEquals(1, visits); assertEquals(0, done); release.complete(Unit) }
            if (fails) {
                compose.waitUntil(10_000) { compose.onAllNodesWithText("Sign-in could not be completed. Try again.").fetchSemanticsNodes().isNotEmpty() }
                compose.runOnIdle {
                    assertEquals(0, done); assertFalse(busy)
                    assertEquals(AuthStatus.SignedIn(prior, verified = false), auth.status)
                    assertEquals("sealed-A", sessions.read())
                    assertEquals(listOf("auth_sign_in"), failures)
                }
                restoration.emulateSavedInstanceStateRestore()
                compose.onNodeWithContentDescription("Code").assertTextContains(" 123456 ")
                compose.onNodeWithText("Sign in").performClick()
            }
            compose.waitUntil(10_000) { compose.runOnIdle { done == 1 } }
            restoration.emulateSavedInstanceStateRestore()
            compose.runOnIdle {
                assertEquals(1, done); assertFalse(busy)
                assertEquals(if (fails) 2 else 1, visits)
                assertEquals(AuthStatus.SignedIn(next), auth.status)
                assertEquals("sealed-B", sessions.read()); assertNull(sessions.proposed)
                assertEquals(if (fails) listOf("auth_sign_in") else emptyList<String>(), failures)
            }
            assertEquals(2, server.requestCount)
            assertEquals(listOf("/v1/auth/magic-link", "/v1/auth/verify-code"), List(2) { server.takeRequest().path })
        } finally { release.complete(Unit); owner.cancel() }
    }

}
