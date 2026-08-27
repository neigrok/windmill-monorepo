package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

// A row this room deletes LEAVES its list and comes back — put back by a log that refused the
// settle, or taken back by an Undo. Both are ordinary, and both used to re-fire the delete.
//
// `rememberSwipeToDismissBoxState` is a `rememberSaveable`: LazyColumn keeps what an item was
// holding under the item's own key and hands it back when the key returns, so the row came back
// already `EndToStart` and the settle effect spent the act again on a gesture nobody made. A refused
// delete then re-fired on its own nine-second clock forever, and an Undo re-deleted what it had just
// taken back — which is the way back this whole pattern exists to provide.
//
// The rule these pin: the value a composition STARTS at is never a gesture.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RowReturnReplayTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    // Short enough that a settle lands inside a test and long enough that a swipe finishes first.
    private val window = 300L

    private fun program(scope: CoroutineScope, server: FakeTraining): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            undoWindowMs = window,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam")))
            store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press"))
        }
        return store
    }

    private fun home(store: TrainingStore, deletes: MutableList<String>) {
        compose.setContent {
            RoutinesScreen(
                store = store,
                isSignedIn = true,
                lookedAt = emptySet(),
                seat = "s",
                onJustStart = {},
                onBuild = {},
                onOpenRoutine = {},
                onDeleteRoutine = { id ->
                    deletes += id
                    store.withhold(Deletion.Routine(id, store.routine(id)?.name ?: "?"))
                },
                onReview = {},
                onOpenSettings = {},
                onSignIn = {},
            )
        }
    }

    // The centrepiece defect. The log says no, the row comes back where it belongs — and the row
    // coming back used to be a second delete, which failed, which brought it back again: one
    // `DELETE` every nine seconds on the access log, for as long as the screen stood.
    @Test
    fun testARefusedSettleDoesNotFireTheDeleteAgainWhenTheRowComesBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.refuseRoutineDelete = IOException("the log is down")
        val store = program(scope, server)
        val deletes = mutableListOf<String>()
        home(store, deletes)

        val routineId = store.routines.single().id
        compose.onNodeWithText("Push Day").performTouchInput { swipeLeft() }
        compose.runOnIdle {
            assertEquals(1, deletes.size)
            assertTrue("withheld means not sent", server.calls.none { it == "deleteRoutine" })
        }

        // The window closes, the log refuses, and the row is back: nothing local was crossed out.
        compose.runOnIdle { runBlocking { store.settleWithheld(routineId) } }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(window * 3)
        compose.waitForIdle()

        compose.runOnIdle {
            assertEquals("one swipe is one delete", 1, deletes.size)
            assertEquals("and one DELETE on the wire, not one every window",
                1, server.calls.count { it == "deleteRoutine" })
            assertEquals("nothing is held any more", emptyList<Any>(), store.withheld)
        }
        compose.onNodeWithText("Push Day").assertIsDisplayed()
        scope.cancel()
    }

    // The other half, and the one that matters more: taking a delete back must not re-delete it.
    @Test
    fun testAnUndoLeavesTheRowStandingAndSendsNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = program(scope, server)
        val deletes = mutableListOf<String>()
        home(store, deletes)

        compose.onNodeWithText("Push Day").performTouchInput { swipeLeft() }
        compose.runOnIdle { assertEquals(1, store.withheld.size) }

        compose.runOnIdle { assertNotNull("the window was still the lifter's", store.keepWithheld()) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(window * 3)
        compose.waitForIdle()

        compose.runOnIdle {
            assertEquals("the row a lifter took back is not deleted again", 1, deletes.size)
            assertEquals("nothing is held", emptyList<Any>(), store.withheld)
            assertEquals("and nothing ever reached the log", emptyList<String>(),
                server.calls.filter { it == "deleteRoutine" })
        }
        // And it is a whole row again, where it belongs — not parked off the leading edge with the
        // offset the swipe that removed it left behind. Which is what the second stroke proves: a
        // state left sitting at `EndToStart` could never travel there again, so the row would be
        // undeletable for as long as the screen stood.
        compose.onNodeWithText("Push Day").assertIsDisplayed()
        compose.onNodeWithText("Push Day").performTouchInput { swipeLeft() }
        compose.runOnIdle {
            assertEquals("a row that came back can be deleted again", 2, deletes.size)
            assertEquals(1, store.withheld.size)
        }
        scope.cancel()
    }
}
