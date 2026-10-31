package works.windmill.platform.you

import androidx.activity.ComponentDialog
import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.dp
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
import works.windmill.platform.User
import works.windmill.platform.auth.AuthLifecycle
import works.windmill.platform.auth.AuthSignOutChoice
import works.windmill.platform.auth.AuthSignOutSession
import works.windmill.platform.auth.AuthStatus
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

    private class HeldSignOut(private val count: Int) : AuthLifecycle {
        var prepares = 0
        var cancels = 0
        val choices = mutableListOf<AuthSignOutChoice>()
        override suspend fun signedIn(user: User, token: String, restoring: Boolean) = Unit
        override suspend fun signOut(): Unit = error("Only the confirmed prepared handle can sign out.")
        override suspend fun prepareSignOut(account: String): AuthSignOutSession {
            prepares++
            return object : AuthSignOutSession {
                override val account = account
                override val unsent = count
                override suspend fun finish(choice: AuthSignOutChoice) { choices += choice }
                override suspend fun cancel() { cancels++ }
            }
        }
    }

    @Test fun unsentQuestionSurvivesRecreationAndCancelLeavesTheAccountWritable() {
        val user = User("u1", "lifter@example.com")
        val sessions = MemorySessions("secret", user)
        val lifecycle = HeldSignOut(3)
        server.enqueue(MockResponse().setResponseCode(503))
        val auth = AuthStore(server.url("/"), sessions, lifecycle = lifecycle)
        runBlocking { auth.restore() }
        val restoration = StateRestorationTester(compose)
        restoration.setContent { WindmillMaterial { YouSheet(auth, {}) } }
        compose.onNodeWithText("Sign out").performClick()
        compose.onNodeWithText("Sign out?").assertIsDisplayed()
        compose.onNodeWithText("3 changes haven’t been confirmed by your account yet. Keep them on this phone until you sign in again, or discard them from this phone.").assertIsDisplayed()
        assertTrue(auth.transitionPending)
        assertFalse(sessions.signOutPending)
        assertEquals(emptyList<AuthSignOutChoice>(), lifecycle.choices)
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("Sign out?").assertIsDisplayed()
        assertEquals(1, lifecycle.prepares)
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithTag("sign-out-question").assertDoesNotExist()
        assertEquals(AuthStatus.SignedIn(user, false), auth.status)
        assertFalse(auth.transitionPending)
        assertEquals(1, lifecycle.cancels)
        assertEquals(emptyList<AuthSignOutChoice>(), lifecycle.choices)
    }

    @Test fun noUnsentQuestionRequiresTheExplicitSignOutAction() = confirmedQuestion(0, AuthSignOutChoice.Keep)
    @Test fun unsentKeepUsesTheHeldChoice() = confirmedQuestion(1, AuthSignOutChoice.Keep)
    @Test fun unsentDiscardUsesTheHeldChoice() = confirmedQuestion(3, AuthSignOutChoice.Discard)

    private fun confirmedQuestion(count: Int, choice: AuthSignOutChoice) {
        val user = User("u1", "lifter@example.com")
        val sessions = MemorySessions("secret", user)
        val lifecycle = HeldSignOut(count)
        server.enqueue(MockResponse().setResponseCode(503))
        val auth = AuthStore(server.url("/"), sessions, lifecycle = lifecycle)
        runBlocking { auth.restore() }
        var visible by mutableStateOf(true)
        compose.setContent { WindmillMaterial { if (visible) YouSheet(auth, { visible = false }) } }
        compose.onNodeWithText("Sign out").performClick()
        compose.onNodeWithText("Sign out?").assertIsDisplayed()
        assertEquals(emptyList<AuthSignOutChoice>(), lifecycle.choices)
        if (count == 0) {
            compose.onNodeWithText("Your log stays in your account and leaves this phone.").assertIsDisplayed()
            compose.onNodeWithText("Discard").assertDoesNotExist()
        }
        val label = if (count == 0) "Sign out" else if (choice == AuthSignOutChoice.Keep) "Keep" else "Discard"
        compose.onNode(hasText(label) and hasAnyAncestor(hasTestTag("sign-out-question"))).performClick()
        compose.waitUntil(5_000) { !visible }
        assertEquals(listOf(choice), lifecycle.choices)
        assertEquals(AuthStatus.SignedOut, auth.status)
        assertFalse(auth.transitionPending)
        assertNull(sessions.read())
    }

    @Test fun signedOutYouShowsCanonicalDestinationsInOrder() = canonicalOverview(false)

    @Test fun signedInYouShowsEmailAndCanonicalDestinationsInOrder() = canonicalOverview(true)

    private fun canonicalOverview(signedIn: Boolean) {
        val user = works.windmill.platform.User("u1", "lifter@example.com", "Lifter")
        val sessions = if (signedIn) MemorySessions("secret", user) else MemorySessions()
        if (signedIn) server.enqueue(MockResponse().setResponseCode(503))
        val auth = AuthStore(server.url("/"), sessions)
        runBlocking { auth.restore() }
        val rows = listOf("Notes", "Connected log", "About Windmill")
        compose.setContent { WindmillMaterial { YouSheet(auth, {},
            destinations = rows.map { YouDestination(it, it) {} }) } }
        compose.onNodeWithText("You").assertIsDisplayed()
        compose.onNodeWithTag("you-sheet-handle", useUnmergedTree = true)
            .assertWidthIsEqualTo(32.dp).assertHeightIsEqualTo(4.dp)
        if (signedIn) compose.onNodeWithText(user.email).assertIsDisplayed()
        else compose.onNodeWithText(user.email).assertDoesNotExist()
        compose.onNodeWithText(if (signedIn) "Sign out" else "Sign in").assertIsDisplayed()
        val bounds = rows.map { compose.onNodeWithText(it).assertIsDisplayed().fetchSemanticsNode().boundsInRoot }
        assertTrue(bounds.zipWithNext().all { (first, next) -> first.bottom < next.top })
        listOf("Gym settings", "Units", "lb", "One account across Windmill.").forEach {
            compose.onNodeWithText(it).assertDoesNotExist()
        }
    }

    @Test fun signedOutOverviewKeepsDestinationsAndDismissesBeforeOpeningOneOnce() {
        val auth = AuthStore(server.url("/"), MemorySessions())
        runBlocking { auth.restore() }
        var visible by mutableStateOf(true)
        val events = mutableListOf<String>()
        compose.setContent { WindmillMaterial { if (visible) YouSheet(auth,
            onDismiss = { events += "dismiss"; visible = false },
            destinations = listOf(YouDestination("settings", "Product settings") { events += "settings" })) } }
        compose.onNodeWithText("You").assertIsDisplayed()
        compose.onNodeWithText("Sign in").assertIsDisplayed()
        compose.onNodeWithContentDescription("Email field").assertDoesNotExist()
        val click = compose.onNodeWithText("Product settings").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnIdle { click(); click() }
        compose.waitUntil(5_000) { !visible }
        assertEquals(listOf("dismiss", "settings"), events)
        compose.onNodeWithText("You").assertDoesNotExist()
    }

    @Test fun authOnlyNativeBackDismissesTheSheetOnce() {
        val auth = AuthStore(server.url("/"), MemorySessions())
        runBlocking { auth.restore() }
        var visible by mutableStateOf(true)
        val events = mutableListOf<String>()
        compose.setContent { WindmillMaterial { if (visible) YouSheet(auth,
            onDismiss = { events += "dismiss"; visible = false }, startSignIn = true) } }
        compose.onNodeWithContentDescription("Email field").assertIsDisplayed()
        compose.onNodeWithText("You").assertDoesNotExist()
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(5_000) { !visible }
        assertEquals(listOf("dismiss"), events)
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
        var dismissed = 0
        compose.setContent { WindmillMaterial { if (visible) YouSheet(auth, { dismissed += 1; visible = false },
            startSignIn = true) } }
        compose.onNodeWithContentDescription("Email field").performTextReplacement("a@example.com")
        compose.onNodeWithText("Send code").performClick()
        compose.waitUntil(5_000) { server.requestCount == 1 }
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("Sending…").assertIsDisplayed().assertIsNotEnabled()
        compose.runOnIdle { assertTrue(visible); assertEquals(0, dismissed); release.countDown() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Try another email.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Email field").assertTextContains("a@example.com")
        compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(5_000) { !visible }
        assertEquals(1, dismissed)
    }

    @Test fun modalBodyRestoresRawCodeAndFallbackWithoutServerWordsWithAFreshAuthStore() {
        var auth by mutableStateOf(AuthStore(server.url("/"), MemorySessions()))
        runBlocking { auth.restore() }
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        val restoration = StateRestorationTester(compose)
        restoration.setContent { WindmillMaterial { YouSheet(auth, {}, startSignIn = true) } }
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
