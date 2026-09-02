package works.windmill.gym.ui

import androidx.compose.ui.test.assertCountEquals
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
import works.windmill.gym.domain.Units
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.Withheld

// The settings row is Android's only connect door since the routines-list card came off. A door that
// offers is a door that has to say who it is for: the precondition is the pitch's own honesty line
// and it came off with the card.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SettingsConnectPitchTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun settings(scope: CoroutineScope): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { null },
        )
        compose.setContent {
            SettingsScreen(
                store = store,
                isSignedIn = true,
                origin = "https://windmill.works",
                backTo = "routines",
                onBack = {},
                onNotes = {},
                say = {},
            )
        }
        return store
    }

    // The bar names the screen, and nothing else does: the head line that used to say what the
    // screen was for is gone, because the platform's title already says it.
    @Test
    fun testTheBarNamesTheScreenAndNoHeadLineRepeatsIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(scope)

        compose.onNodeWithText("Settings").assertIsDisplayed()
        compose.onNodeWithText("how this room behaves at the rack").assertDoesNotExist()
        scope.cancel()
    }

    // A caption is drawn only in the state it describes: on kg the pounds clause is a sentence about
    // nothing. Tapping `lb` writes the answer and the clause arrives with it.
    @Test
    fun testThePoundsClauseIsDrawnUnderPoundsAndNowhereElse() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = settings(scope)

        assertEquals(Units.Kilograms, store.preferences.units)
        compose.onNodeWithText(Bodyweight.kilogramsOnly).assertDoesNotExist()

        compose.onNodeWithText(Units.Pounds.wire).performScrollTo().performClick()
        compose.onNodeWithText(Bodyweight.kilogramsOnly).performScrollTo().assertIsDisplayed()
        scope.cancel()
    }

    // The rest override is said on the timer, where it is in force, and a fact is drawn once: the
    // Rest card here says nothing about a routine's own rest beating this dial.
    @Test
    fun testTheRestCardSaysNothingAboutTheOverride() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(scope)

        compose.onNodeWithText("Rest timer").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("wins over this dial", substring = true).assertDoesNotExist()
        compose.onNodeWithText("from the routine", substring = true).assertDoesNotExist()
        compose.onNodeWithText("its own rest", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    // The offer, its precondition beside it, and nothing on the card said twice: the price rides in
    // the precondition — the one line that rules a lifter OUT rather than in — and the connections
    // list with its Disconnect is the web's, reached through the row at the head of this card.
    @Test
    fun testTheOfferIsMadeWithItsPreconditionBesideItAndSaysNothingTwice() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(scope)

        compose.onNodeWithText(ConnectedLog.connect).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.precondition).performScrollTo().assertIsDisplayed()
        compose.onAllNodesWithText("free", substring = true, ignoreCase = true).assertCountEquals(1)
        compose.onAllNodesWithText("disconnect", substring = true, ignoreCase = true)
            .assertCountEquals(0)
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
        val store = settings(scope)

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
