package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.LogLevel
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.OAuthGrant
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

// The two-state screen, drawn from the two reads: what a grant reaches as three rows of facts, one
// caption, one action, one disclosure closed by default — and the connected list where there is one.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class ConnectedLogScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val firstPaint = listOf(
        ConnectedLog.title, ConnectedLog.head,
        LogLevel.Read.label, LogLevel.Read.meta,
        LogLevel.Write.label, LogLevel.Write.meta,
        LogLevel.Delete.label, LogLevel.Delete.meta,
        ConnectedLog.caption, ConnectedLog.action, ConnectedLog.disclosure,
    )

    // Word counts the brief's way: a token is a run of letters, digits or an apostrophe, so
    // `weigh-ins` is two and `·` and `→` are none. The same count `ConnectedLogTests` makes.
    private fun words(lines: List<String>): Int =
        lines.sumOf { Regex("[\\p{L}\\p{N}’']+").findAll(it).count() }

    private fun ms(date: String): Long =
        LocalDate.parse(date).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()

    private fun store(scope: CoroutineScope, server: FakeTraining, signedIn: Boolean): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = if (signedIn) User(id = "u1", email = "sam@example.com", name = "Sam") else null,
            ))
        }
        return store
    }

    private fun screen(
        store: TrainingStore,
        signedIn: Boolean,
        opened: MutableList<String> = mutableListOf(),
        signIns: MutableList<String> = mutableListOf(),
    ) {
        compose.setContent {
            val browser = object : UriHandler {
                override fun openUri(uri: String) { opened += uri }
            }
            CompositionLocalProvider(LocalUriHandler provides browser) {
                ConnectedLogScreen(
                    store = store,
                    isSignedIn = signedIn,
                    origin = "https://windmill.works",
                    backTo = "Settings",
                    onBack = {},
                    onSignIn = { signIns += "you" },
                )
            }
        }
    }

    // Nothing connected: the first paint is the brief's arithmetic — 52 words drawn, 110 with the
    // disclosure open — and every line the brief struck is absent. The one action leaves the app and
    // its glyph says so, once.
    @Test
    fun testNothingConnectedDrawsTheHeadTheThreeRowsTheCaptionAndTheActionAndNothingElse() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val opened = mutableListOf<String>()
        screen(store(scope, FakeTraining(), signedIn = true), signedIn = true, opened)

        assertEquals(52, words(firstPaint))
        assertEquals(110, words(firstPaint + ConnectedLog.how))
        firstPaint.forEach { compose.onNodeWithText(it).assertIsDisplayed() }
        ConnectedLog.how.forEach { compose.onNodeWithText(it).assertDoesNotExist() }
        compose.onNodeWithText(ConnectedLog.connectedHead).assertDoesNotExist()
        compose.onNodeWithText(ConnectedLog.manage).assertDoesNotExist()
        compose.onNodeWithText(ConnectedLog.unread).assertDoesNotExist()
        compose.onNodeWithText(ConnectedLog.actionSignedOut).assertDoesNotExist()
        listOf("free", "Sunday", "Monday", "apply tool", "cannot", "never", "CSV", "export").forEach {
            compose.onAllNodesWithText(it, substring = true, ignoreCase = true).assertCountEquals(0)
        }
        compose.onAllNodes(hasContentDescription(ConnectedLog.opensInBrowser), useUnmergedTree = true)
            .assertCountEquals(1)

        compose.onNode(hasText(ConnectedLog.action) and hasClickAction()).performClick()
        assertEquals(listOf("https://windmill.works/#/connect"), opened)
        scope.cancel()
    }

    // The disclosure is the only long form: closed by default, five lines when open, and the same
    // tap closes it again. A screen reader hears the state on the row, not a chevron.
    @Test
    fun testHowThisWorksOpensInPlaceWithTheFiveLinesAndClosesAgain() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        screen(store(scope, FakeTraining(), signedIn = true), signedIn = true)
        fun state(said: String) = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, said)

        compose.onNodeWithText(ConnectedLog.disclosure).performScrollTo().assert(state("closed")).performClick()
        ConnectedLog.how.forEach { compose.onNodeWithText(it).performScrollTo().assertIsDisplayed() }
        compose.onNodeWithText(ConnectedLog.disclosure).performScrollTo().assert(state("open")).performClick()
        ConnectedLog.how.forEach { compose.onNodeWithText(it).assertDoesNotExist() }
        compose.onNodeWithText(ConnectedLog.disclosure).assert(state("closed"))
        scope.cancel()
    }

    // One read per seat, however many screens ask: settings, the screen pushed over it and the pop
    // back share the store's one answer. The app coming back from the browser a door opened reads
    // again, so a tool just connected is here without a pull; a pull forces one; a change of seat
    // drops the answer and the standing screen asks again.
    @Test
    fun testTheTwoScreensShareOneReadPerSeatAndOnlyAReturnAPullOrANewSeatReadsAgain() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.grants += OAuthGrant(clientId = "c1", name = "Claude Desktop", grantedMs = 1L, scope = "gym:read")
        val store = store(scope, server, signedIn = true)
        val app = object : LifecycleOwner {
            override val lifecycle = LifecycleRegistry(this)
        }
        app.lifecycle.currentState = Lifecycle.State.RESUMED
        var standing by mutableStateOf("settings")
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides app) {
                if (standing == "settings") SettingsScreen(
                    store = store, isSignedIn = true, backTo = "routines", onBack = {}, onNotes = {},
                    onConnectedLog = { standing = "connected" }, say = {},
                ) else ConnectedLogScreen(
                    store = store, isSignedIn = true, origin = "https://windmill.works", backTo = "Settings",
                    onBack = { standing = "settings" }, onSignIn = {},
                )
            }
        }
        fun credentialReads() = server.calls.count { it == "grants" || it == "mcpKeys" }

        compose.onNodeWithText("Claude Desktop · read").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.title).performScrollTo().performClick()
        compose.onNodeWithText("Claude Desktop").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back to Settings").performClick()
        compose.onNodeWithText("Claude Desktop · read").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertEquals(2, credentialReads()) }

        compose.runOnIdle { standing = "connected" }
        compose.onNodeWithText("Claude Desktop").assertIsDisplayed()
        compose.runOnIdle {
            // A dialog over the room only pauses: not a return.
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(2, credentialReads()) }
        compose.runOnIdle {
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START)
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(4, credentialReads()) }

        compose.onNode(hasScrollAction()).performTouchInput { swipeDown() }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(6, credentialReads()) }

        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u2", email = "kim@example.com", name = "Kim"),
            ))
        }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(8, credentialReads()) }
        scope.cancel()
    }

    // Signed out the log is device-local and a grant belongs to an account: the label names what
    // will happen, the tap opens the sign-in door, no glyph and no caption explains it.
    @Test
    fun testSignedOutTheActionIsSignInFirstAndOpensTheDoor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val opened = mutableListOf<String>()
        val signIns = mutableListOf<String>()
        screen(store(scope, FakeTraining(), signedIn = false), signedIn = false, opened, signIns)

        compose.onNodeWithText(ConnectedLog.head).assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.action).assertDoesNotExist()
        compose.onAllNodes(hasContentDescription(ConnectedLog.opensInBrowser), useUnmergedTree = true)
            .assertCountEquals(0)
        compose.onNode(hasText(ConnectedLog.actionSignedOut) and hasClickAction()).performClick()
        assertEquals(listOf("you"), signIns)
        assertEquals(emptyList<String>(), opened)
        scope.cancel()
    }

    // Something connected: the head steps aside for the list, each row's meta is the levels held and
    // the day it was made, the three level rows stay, and `Manage connections` is a browser door to
    // the shell's settings.
    @Test
    fun testSomethingConnectedListsEachCredentialAndOpensTheShellToManageThem() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.grants += OAuthGrant(clientId = "c1", name = "Claude Desktop",
            grantedMs = ms(LocalDate.now().year.toString() + "-08-12"), scope = "gym:read gym:write gym:delete")
        server.grants += OAuthGrant(clientId = "c2", name = "", grantedMs = ms("2025-12-01"), scope = "")
        server.keys += McpKey(id = "k1", name = "", createdMs = ms("2025-07-04"))
        val opened = mutableListOf<String>()
        screen(store(scope, server, signedIn = true), signedIn = true, opened)

        compose.onNodeWithText(ConnectedLog.connectedHead).assertIsDisplayed()
        compose.onNodeWithText("Claude Desktop").assertIsDisplayed()
        compose.onNodeWithText("read · write · delete · since 12 Aug").assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.unnamedGrant).assertIsDisplayed()
        compose.onNodeWithText("whole account · since 1 Dec 2025").assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.unnamedKey).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("API key · whole account · since 4 Jul 2025").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.head).assertDoesNotExist()
        LogLevel.entries.forEach { compose.onNodeWithText(it.meta).performScrollTo().assertIsDisplayed() }
        compose.onNodeWithText(ConnectedLog.caption).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.action).assertIsDisplayed()
        compose.onAllNodes(hasContentDescription(ConnectedLog.opensInBrowser), useUnmergedTree = true)
            .assertCountEquals(2)

        compose.onNodeWithText(ConnectedLog.manage).performScrollTo().performClick()
        assertEquals(listOf("https://windmill.works/#/settings"), opened)
        scope.cancel()
    }

    // Both reads or neither: one failing draws the unknown row rather than an undercount, and the
    // invitation still stands under it. A pull that reads both draws the list.
    @Test
    fun testARefusedReadDrawsOneUnreadRowAndTheInvitationStillStands() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.grants += OAuthGrant(clientId = "c1", name = "Claude Desktop", grantedMs = 1L, scope = "gym:read")
        server.refuseKeys = IllegalStateException("down")
        val store = store(scope, server, signedIn = true)
        screen(store, signedIn = true)

        compose.onNodeWithText(ConnectedLog.connectedHead).assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.unread).assertIsDisplayed()
        compose.onNodeWithText("Claude Desktop").assertDoesNotExist()
        compose.onNodeWithText(ConnectedLog.head).assertDoesNotExist()
        compose.onNodeWithText(ConnectedLog.action).assertIsDisplayed()

        server.refuseKeys = null
        runBlocking { store.readConnectedLog() }
        compose.onNodeWithText("Claude Desktop").assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.unread).assertDoesNotExist()
        scope.cancel()
    }
}
