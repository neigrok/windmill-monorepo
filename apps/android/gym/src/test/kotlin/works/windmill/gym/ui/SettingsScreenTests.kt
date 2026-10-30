package works.windmill.gym.ui

import works.windmill.gym.store.EngineRoomFixture
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.OAuthGrant
import works.windmill.gym.domain.Units
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.TrainingStore

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SettingsScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun room(scope: CoroutineScope, rest: FakeGymRest, signedIn: Boolean): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = rest)
        runBlocking { room.select(if (signedIn) "u1" else null) }
        return room
    }

    private fun settings(store: TrainingStore, signedIn: Boolean, opened: MutableList<String> = mutableListOf()) {
        compose.setContent {
            SettingsScreen(
                store = store,
                isSignedIn = signedIn,
                backTo = "routines",
                onBack = {},
                onNotes = { opened += "notes" },
                accountEmail = if (signedIn) "u1@example.com" else null,
                onAccount = { opened += "account" },
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
        room(scope, FakeGymRest(), signedIn = true).use { room ->
            settings(room.store, signedIn = true)

            compose.onNodeWithText("CSV export").assertDoesNotExist()
            compose.onAllNodesWithText("export", substring = true, ignoreCase = true).assertCountEquals(0)
            compose.onAllNodesWithText("CSV", substring = true).assertCountEquals(0)
            compose.onAllNodes(hasContentDescription(ConnectedLog.opensInBrowser), useUnmergedTree = true)
                .assertCountEquals(0)
        }
        scope.cancel()
    }

    // The row prints the state and nothing else, and opens the screen where the words are. Signed in
    // with one tool the meta is that tool and its levels; no pitch, no precondition, no caption.
    @Test
    fun testTheConnectedLogRowPrintsTheStateAndOpensTheScreen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val rest = FakeGymRest()
        rest.grants += OAuthGrant(clientId = "c1", name = "Claude Desktop", grantedMs = 1L, scope = "gym:read gym:write")
        val opened = mutableListOf<String>()
        room(scope, rest, signedIn = true).use { room ->
            settings(room.store, signedIn = true, opened)

            compose.onNodeWithText("Claude Desktop · read · write").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(ConnectedLog.head).assertDoesNotExist()
            compose.onNodeWithText(ConnectedLog.caption).assertDoesNotExist()
            compose.onNodeWithText(ConnectedLog.action).assertDoesNotExist()
            compose.onAllNodesWithText("free", substring = true, ignoreCase = true).assertCountEquals(0)
            compose.onNodeWithText(ConnectedLog.title).performScrollTo().performClick()
            compose.runOnIdle { assertEquals(listOf("connected-log"), opened) }
        }
        scope.cancel()
    }

    // Signed out nothing reaches a device-local log, and the row says so as a state rather than as a
    // sentence about signing in.
    @Test
    fun testSignedOutTheRowSaysNothingIsConnected() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        room(scope, FakeGymRest(), signedIn = false).use { room ->
            settings(room.store, signedIn = false)

            compose.onNodeWithText(ConnectedLog.settingsNone).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(ConnectedLog.settingsUnknown).assertDoesNotExist()
        }
        scope.cancel()
    }

    // Either credential read failing leaves the row on the meta that claims nothing.
    @Test
    fun testARefusedReadLeavesTheRowClaimingNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val rest = FakeGymRest()
        rest.refuseKeys = IllegalStateException("down")
        room(scope, rest, signedIn = true).use { room ->
            settings(room.store, signedIn = true)

            compose.onNodeWithText(ConnectedLog.settingsUnknown).performScrollTo().assertIsDisplayed()
        }
        scope.cancel()
    }

    // The bar names the screen, and nothing else does: the head line that used to say what the
    // screen was for is gone, because the platform's title already says it.
    @Test
    fun testTheBarNamesTheScreenAndNoHeadLineRepeatsIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        room(scope, FakeGymRest(), signedIn = true).use { room ->
            settings(room.store, signedIn = true)

            compose.onNodeWithText("Gym settings").assertIsDisplayed()
            compose.onNodeWithText("how this room behaves at the rack").assertDoesNotExist()
        }
        scope.cancel()
    }

    // A caption is drawn only in the state it describes: on kg the pounds clause is a sentence about
    // nothing. Tapping `lb` writes the answer and the clause arrives with it.
    @Test
    fun testThePoundsClauseIsDrawnUnderPoundsAndNowhereElse() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        room(scope, FakeGymRest(), signedIn = true).use { room ->
            settings(room.store, signedIn = true)

            assertEquals(Units.Kilograms, room.store.preferences.units)
            compose.onNodeWithText(Bodyweight.kilogramsOnly).assertDoesNotExist()

            compose.onNodeWithText(Units.Pounds.wire).performScrollTo().performClick()
            compose.onNodeWithText(Bodyweight.kilogramsOnly).performScrollTo().assertIsDisplayed()
        }
        scope.cancel()
    }

    @Test
    fun unitsRemainEditableWithoutRestControls() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val preferences = GymPreferences(confirmHaptic = true, confirmSound = true)
        room(scope, FakeGymRest(), signedIn = true).use { room ->
            assertNull(runBlocking { room.store.savePreferences(preferences) })
            settings(room.store, signedIn = true)

            compose.onAllNodesWithText("rest", substring = true, ignoreCase = true).assertCountEquals(0)
            compose.onNodeWithText("At the rack").assertDoesNotExist()
            compose.onNodeWithText("lb").performClick()
            compose.runOnIdle {
                assertEquals(preferences.copy(units = Units.Pounds), room.store.preferences)
                assertEquals(room.store.preferences, room.training.settings())
            }
        }
        scope.cancel()
    }

    @Test
    fun theAccountRowShowsTheCurrentEmailAndOpensTheAccountSheet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val opened = mutableListOf<String>()
        room(scope, FakeGymRest(), signedIn = true).use { room ->
            settings(room.store, signedIn = true, opened)

            compose.onNodeWithText("u1@example.com").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("Account").performScrollTo().performClick()
            compose.runOnIdle { assertEquals(listOf("account"), opened) }
        }
        scope.cancel()
    }

}
