package works.windmill.gym.ui

import android.content.Context
import androidx.annotation.StringRes
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
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
import androidx.test.core.app.ApplicationProvider
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.R
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.GymRest
import works.windmill.gym.presentation.ConnectedLog
import works.windmill.gym.presentation.LogLevel
import works.windmill.gym.presentation.McpKey
import works.windmill.gym.presentation.OAuthGrant
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApiException

// Both credential reads decide the root state; the separate disclosure keeps the permitted levels.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class ConnectedLogScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val firstPaint = listOf(
        string(R.string.gym_connected_title), string(R.string.gym_connected_head),
        string(LogLevel.Read.named), string(LogLevel.Read.reaches),
        string(LogLevel.Write.named), string(LogLevel.Write.reaches),
        string(LogLevel.Delete.named), string(LogLevel.Delete.reaches),
        string(R.string.gym_connected_caption), string(R.string.gym_connected_action), string(R.string.gym_connected_disclosure),
    )

    private fun ms(date: String): Long =
        LocalDate.parse(date).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()

    private val rooms = mutableListOf<EngineRoomFixture>()

    @After
    fun closeRooms() = rooms.forEach(EngineRoomFixture::close)

    private fun room(scope: CoroutineScope, rest: GymRest, signedIn: Boolean): EngineRoomFixture =
        EngineRoomFixture(tmp.newFolder(), scope, rest = rest).also { room ->
            rooms += room
            runBlocking { room.select(if (signedIn) "u1" else null) }
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
                remember(store) { ConnectionsBinding(store) }.let { connections -> ConnectedLogScreen(
                    state = connections,
                    events = connections,
                    isSignedIn = signedIn,
                    origin = "https://windmill.works",
                    backTo = "Settings",
                    onBack = {},
                    onSignIn = { signIns += "you" },
                ) }
            }
        }
    }

    @Test fun nothingConnectedShowsTheExactLevelsAndTheBrowserAction() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val opened = mutableListOf<String>()
        screen(room(scope, FakeGymRest(), true).store, true, opened)
        firstPaint.forEach { compose.onNodeWithText(it).assertIsDisplayed() }
        compose.onNodeWithText("Manage connections").assertDoesNotExist()
        compose.onNodeWithText(string(R.string.gym_connected_connected_head)).assertDoesNotExist()
        ConnectedLog.howItWorks.forEach { compose.onNodeWithText(string(it)).assertDoesNotExist() }
        compose.onNodeWithText(string(R.string.gym_connected_action)).performClick()
        assertEquals(listOf("https://windmill.works/#/connect"), opened)
        scope.cancel()
    }

    @Test fun emptyDisclosureIsAPushedPageAndBackReturnsToTheLevels() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        screen(room(scope, FakeGymRest(), true).store, true)
        compose.onNodeWithText(string(R.string.gym_connected_disclosure)).performScrollTo().performClick()
        ConnectedLog.howItWorks.forEach { compose.onNodeWithText(string(it)).performScrollTo().assertIsDisplayed() }
        LogLevel.entries.forEach { compose.onNodeWithText(string(it.reaches)).assertDoesNotExist() }
        compose.onNodeWithText(string(R.string.gym_connected_action)).assertDoesNotExist()
        compose.onNodeWithContentDescription("Back to Connected log").performClick()
        compose.onNodeWithText(string(R.string.gym_connected_head)).assertIsDisplayed()
        scope.cancel()
    }

    @Test fun connectedCredentialsEachOpenTheBrowserAndLevelsLiveOnThePushedDisclosure() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeGymRest()
        server.grants += OAuthGrant("c1", "Claude Desktop", ms("2025-12-01"), "gym:read gym:write")
        server.keys += McpKey("k1", "", ms("2025-07-04"))
        val opened = mutableListOf<String>()
        screen(room(scope, server, true).store, true, opened)
        compose.onNodeWithText(string(R.string.gym_connected_connected_head)).assertIsDisplayed()
        compose.onNodeWithText("Claude Desktop").assertIsDisplayed()
        compose.onNodeWithText("read · write · since 1 Dec 2025").assertIsDisplayed()
        compose.onNodeWithText("API key · whole account · since 4 Jul 2025").assertIsDisplayed()
        LogLevel.entries.forEach { compose.onNodeWithText(string(it.reaches)).assertDoesNotExist() }
        compose.onNodeWithText(string(R.string.gym_connected_caption)).assertDoesNotExist()
        compose.onNodeWithText(string(R.string.gym_connected_head)).assertDoesNotExist()
        compose.onNodeWithText("Manage connections").assertDoesNotExist()
        compose.onNodeWithText("Claude Desktop").performClick()
        compose.onNodeWithText(string(R.string.gym_connected_unnamed_key)).performClick()
        assertEquals(List(2) { "https://windmill.works/#/settings" }, opened)
        compose.onNodeWithText(string(R.string.gym_connected_disclosure)).performClick()
        ConnectedLog.howItWorks.forEach { compose.onNodeWithText(string(it)).performScrollTo().assertIsDisplayed() }
        LogLevel.entries.forEach { compose.onNodeWithText(string(it.reaches)).performScrollTo().assertIsDisplayed() }
        compose.onNodeWithText(string(R.string.gym_connected_caption)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Back to Connected log").performClick()
        compose.onNodeWithText("Claude Desktop").assertIsDisplayed()
        scope.cancel()
    }

    @Test fun signedOutInvitesSignInAndNeverOpensTheBrowser() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val opened = mutableListOf<String>(); val signIns = mutableListOf<String>()
        screen(room(scope, FakeGymRest(), false).store, false, opened, signIns)
        compose.onNodeWithText(string(R.string.gym_connected_head)).assertIsDisplayed()
        compose.onNodeWithText(string(R.string.gym_connected_action_signed_out)).performClick()
        assertEquals(listOf("you"), signIns)
        assertEquals(emptyList<String>(), opened)
        scope.cancel()
    }

    @Test fun aFailedPairNeverLooksEmptyAndRetryRestoresBothCredentialKinds() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeGymRest()
        server.grants += OAuthGrant("same", "Scoped", 1L, "gym:read")
        server.keys += McpKey("same", "Static", 2L)
        server.refuseKeys = IllegalStateException("fixture unread")
        val store = room(scope, server, true).store
        screen(store, true)
        compose.onNodeWithText(string(R.string.gym_connected_unread)).assertIsDisplayed()
        compose.onNodeWithText(string(R.string.gym_connected_head)).assertDoesNotExist()
        compose.onNodeWithText(string(R.string.gym_connected_connected_head)).assertDoesNotExist()
        compose.onNodeWithText("Scoped").assertDoesNotExist()
        LogLevel.entries.forEach { compose.onNodeWithText(string(it.reaches)).assertDoesNotExist() }
        server.refuseKeys = null
        compose.onNodeWithText("Try again").performClick()
        compose.onNodeWithText("Scoped").assertIsDisplayed()
        compose.onNodeWithText("Static").assertIsDisplayed()
        compose.onNodeWithText(string(R.string.gym_connected_unread)).assertDoesNotExist()
        scope.cancel()
    }

    @Test fun knownOfflineUsesItsConnectionSentenceAndKeepsTheRootDoors() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeGymRest().apply { refuseGrants = WindmillApiException.Offline }
        screen(room(scope, server, true).store, true)
        compose.onNodeWithText(string(R.string.gym_connected_offline)).assertIsDisplayed()
        compose.onNodeWithText(string(R.string.gym_connected_unread)).assertDoesNotExist()
        compose.onNodeWithText(string(R.string.gym_connected_head)).assertDoesNotExist()
        compose.onNodeWithText(string(R.string.gym_connected_disclosure)).assertIsDisplayed()
        compose.onNodeWithText(string(R.string.gym_connected_action)).assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun connectedLogReadsAgainOnlyOnReturnPullOrNewSeat() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeGymRest()
        server.grants += OAuthGrant(clientId = "c1", name = "Claude Desktop", grantedMs = 1L, scope = "gym:read")
        val room = room(scope, server, signedIn = true)
        val store = room.store
        val app = object : LifecycleOwner {
            override val lifecycle = LifecycleRegistry(this)
        }
        app.lifecycle.currentState = Lifecycle.State.RESUMED
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides app) {
                remember(store) { ConnectionsBinding(store) }.let { connections -> ConnectedLogScreen(connections, connections, true, "https://windmill.works", "Routines", {}, {}) }
            }
        }
        fun credentialReads() = server.calls.count { it == "grants" || it == "mcpKeys" }

        compose.onNodeWithText("Claude Desktop").assertIsDisplayed()
        compose.runOnIdle { assertEquals(2, credentialReads()) }
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

        runBlocking { room.select("u2") }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(8, credentialReads()) }
        scope.cancel()
    }

    @Test fun anUnansweredPairDoesNotClaimThatNothingIsConnected() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val release = CompletableDeferred<Unit>()
        val server = object : GymRest by FakeGymRest() {
            override suspend fun grants(): List<OAuthGrant> { release.await(); return listOf(OAuthGrant("grant", "Scoped", 1, "gym:read")) }
            override suspend fun mcpKeys() = listOf(McpKey("key", "Static", 2))
        }
        screen(room(scope, server, true).store, true)
        compose.onNodeWithText("Reading your connections…").assertIsDisplayed()
        compose.onNodeWithText(string(R.string.gym_connected_head)).assertDoesNotExist()
        compose.onNodeWithText(string(R.string.gym_connected_connected_head)).assertDoesNotExist()
        LogLevel.entries.forEach { compose.onNodeWithText(string(it.reaches)).assertDoesNotExist() }
        compose.runOnIdle { release.complete(Unit) }
        compose.onNodeWithText("Scoped").assertIsDisplayed()
        compose.onNodeWithText("Static").assertIsDisplayed()
        scope.cancel()
    }
    @Test fun sameOwnerReconnectRestartsTheConnectedScreenPairWhenLoadingIsAlreadySettled() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val release = CompletableDeferred<Unit>()
        var grantReads = 0
        var keyReads = 0
        val server = object : GymRest by FakeGymRest() {
            override suspend fun grants(): List<OAuthGrant> {
                val ordinal = ++grantReads
                if (ordinal == 1) release.await()
                return listOf(OAuthGrant("grant", if (ordinal == 1) "Old grant" else "Current grant", 1, "gym:read"))
            }
            override suspend fun mcpKeys(): List<McpKey> {
                keyReads += 1
                return listOf(McpKey("key", "Static", 2))
            }
        }
        val phone = room(scope, server, true)
        val store = phone.store
        try {
            screen(store, true)
            val reconnecting = compose.runOnIdle { scope.async {
                assertEquals(1, grantReads)
                val original = phone.account()
                store.connect(Account(original.origin, original.user, identityRevision = original.identityRevision))
                assertFalse(store.seat.isLoading)
                release.complete(Unit)
            } }
            compose.waitUntil(10_000) { compose.runOnIdle { reconnecting.isCompleted } }
            runBlocking { reconnecting.await() }
            compose.waitUntil(5_000) { compose.runOnIdle { grantReads == 2 && store.sharing.connectedLog.answered } }
            compose.runOnIdle {
                assertEquals(listOf(2, 2), listOf(grantReads, keyReads))
                assertEquals(ConnectedLog.state(listOf(OAuthGrant("grant", "Current grant", 1, "gym:read")),
                    listOf(McpKey("key", "Static", 2))), store.sharing.connectedLog)
            }
            compose.onNodeWithText("Current grant").assertIsDisplayed()
            compose.onNodeWithText("Old grant").assertDoesNotExist()
        } finally { scope.cancel() }
    }

}

private fun string(@StringRes id: Int, vararg args: Any): String = ApplicationProvider.getApplicationContext<Context>().getString(id, *args)
