package works.windmill.gym.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.OAuthGrant
import works.windmill.gym.domain.Units
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.Withheld
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SettingsScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

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

    private fun settings(store: TrainingStore, signedIn: Boolean, opened: MutableList<String> = mutableListOf()) {
        compose.setContent {
            SettingsScreen(
                store = store,
                isSignedIn = signedIn,
                backTo = "routines",
                onBack = {},
                onNotes = {},
                onConnectedLog = { opened += "connected-log" },
                say = {},
            )
        }
    }

    // No export door anywhere in gym: the row went, and with it the one browser glyph this screen
    // carried. Nothing on the screen names an export.
    @Test
    fun testThereIsNoCsvDoorAndNoBrowserGlyphOnTheSettingsScreen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(store(scope, FakeTraining(), signedIn = true), signedIn = true)

        compose.onNodeWithText("CSV export").assertDoesNotExist()
        compose.onAllNodesWithText("export", substring = true, ignoreCase = true).assertCountEquals(0)
        compose.onAllNodesWithText("CSV", substring = true).assertCountEquals(0)
        compose.onAllNodes(hasContentDescription(ConnectedLog.opensInBrowser), useUnmergedTree = true)
            .assertCountEquals(0)
        scope.cancel()
    }

    // The row prints the state and nothing else, and opens the screen where the words are. Signed in
    // with one tool the meta is that tool and its levels; no pitch, no precondition, no caption.
    @Test
    fun testTheConnectedLogRowPrintsTheStateAndOpensTheScreen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.grants += OAuthGrant(clientId = "c1", name = "Claude Desktop", grantedMs = 1L, scope = "gym:read gym:write")
        val opened = mutableListOf<String>()
        settings(store(scope, server, signedIn = true), signedIn = true, opened)

        compose.onNodeWithText("Claude Desktop · read · write").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.head).assertDoesNotExist()
        compose.onNodeWithText(ConnectedLog.caption).assertDoesNotExist()
        compose.onNodeWithText(ConnectedLog.action).assertDoesNotExist()
        compose.onAllNodesWithText("free", substring = true, ignoreCase = true).assertCountEquals(0)
        compose.onNodeWithText(ConnectedLog.title).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("connected-log"), opened) }
        scope.cancel()
    }

    // Signed out nothing reaches a device-local log, and the row says so as a state rather than as a
    // sentence about signing in.
    @Test
    fun testSignedOutTheRowSaysNothingIsConnected() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(store(scope, FakeTraining(), signedIn = false), signedIn = false)

        compose.onNodeWithText(ConnectedLog.settingsNone).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.settingsUnknown).assertDoesNotExist()
        scope.cancel()
    }

    // Either credential read failing leaves the row on the meta that claims nothing.
    @Test
    fun testARefusedReadLeavesTheRowClaimingNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.refuseKeys = IllegalStateException("down")
        settings(store(scope, server, signedIn = true), signedIn = true)

        compose.onNodeWithText(ConnectedLog.settingsUnknown).performScrollTo().assertIsDisplayed()
        scope.cancel()
    }

    // The bar names the screen, and nothing else does: the head line that used to say what the
    // screen was for is gone, because the platform's title already says it.
    @Test
    fun testTheBarNamesTheScreenAndNoHeadLineRepeatsIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(store(scope, FakeTraining(), signedIn = true), signedIn = true)

        compose.onNodeWithText("Settings").assertIsDisplayed()
        compose.onNodeWithText("how this room behaves at the rack").assertDoesNotExist()
        scope.cancel()
    }

    // A caption is drawn only in the state it describes: on kg the pounds clause is a sentence about
    // nothing. Tapping `lb` writes the answer and the clause arrives with it.
    @Test
    fun testThePoundsClauseIsDrawnUnderPoundsAndNowhereElse() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope, FakeTraining(), signedIn = true)
        settings(store, signedIn = true)

        assertEquals(Units.Kilograms, store.preferences.units)
        compose.onNodeWithText(Bodyweight.kilogramsOnly).assertDoesNotExist()

        compose.onNodeWithText(Units.Pounds.wire).performScrollTo().performClick()
        compose.onNodeWithText(Bodyweight.kilogramsOnly).performScrollTo().assertIsDisplayed()
        scope.cancel()
    }

    // The rest dial is the web's: nothing on this phone draws it.
    @Test
    fun testThereIsNoRestCard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(store(scope, FakeTraining(), signedIn = true), signedIn = true)

        compose.onNodeWithText("Rest timer").assertDoesNotExist()
        compose.onNodeWithText("Sound when it ends").assertDoesNotExist()
        scope.cancel()
    }

    // The shelf's discard is one tap and nine seconds of Undo, in place of an arm-and-relabel that
    // had no cancel and no timeout. The WHOLE row goes with it — the store holds the shelf for the
    // length of the window, so a claim button left drawing could take training a pending discard
    // wipes nine seconds later.
    @Test
    fun testDiscardingTheShelfTakesTheWholeRowAndSendsNothingWhileTheWindowRuns() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        File(tmp.root, "local.json").writeText("""{"routines":[{"id":"rt_old","name":"Somebody’s"}]}""")
        val store = store(scope, FakeTraining(), signedIn = true)
        settings(store, signedIn = true)

        compose.onNodeWithText("Saved on this phone, unclaimed").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("These are mine").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Delete for good?").assertDoesNotExist()
        compose.onNodeWithText("Not mine").performScrollTo().performClick()

        compose.onNodeWithText("Not mine").assertDoesNotExist()
        compose.onNodeWithText("These are mine").assertDoesNotExist()
        compose.onNodeWithText("Saved on this phone, unclaimed").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf("unattributed"), store.withheld.map { it.subjectId })
            assertNotNull("nothing has left the disk while the window is open", store.unattributed)
            assertEquals("Unclaimed training deleted — it was only on this phone.",
                Withheld.line(store.withheld))
        }
        scope.cancel()
    }
}
