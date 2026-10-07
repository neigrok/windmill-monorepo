package works.windmill.gym.ui

import android.os.Looper
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.sync.core.Json
import works.windmill.sync.modelserver.ModelServer

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

    // Push Day, synced: the routine is on the account's log and nothing is owed.
    private fun program(scope: CoroutineScope, server: ModelServer): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope, undoWindowMs = window)
        room.now = System.currentTimeMillis()
        runBlocking {
            room.select("u1")
            room.pull(server)
            assertTrue(room.store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) is GymResult.Ok)
            room.sync(server)
            room.store.refreshEngine()
        }
        room.store.observeEngine()
        return room
    }

    private fun home(room: EngineRoomFixture, deletes: MutableList<String>) {
        compose.setContent {
            RoutinesScreen(
                store = room.store,
                isSignedIn = true,
                lookedAt = emptySet(),
                seat = "s",
                onJustStart = {},
                onBuild = {},
                onOpenRoutine = {},
                onDeleteRoutine = { id ->
                    deletes += id
                    room.store.withhold(Deletion.Routine(id, room.store.routine(id)?.name ?: "?"))
                },
                onReview = {},
                onSignIn = {},
            )
        }
    }

    // The routine deletes the outbox holds: a delete on the wire is one of these until the log answers.
    private fun routineDeletes(room: EngineRoomFixture): List<String> = room.outbox()
        .flatMap { it.member("intent")["d"]?.arr().orEmpty() }
        .filter { it.member("t").str() == "routine" && it["life"]?.arr()?.first() == Json.of("dead") }
        .map { it.member("id").str() }

    // The centrepiece defect. The log says no, the row comes back where it belongs — and the row
    // coming back used to be a second delete, which failed, which brought it back again: one
    // delete every nine seconds on the wire, for as long as the screen stood.
    @Test
    fun testARefusedSettleDoesNotFireTheDeleteAgainWhenTheRowComesBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        try { program(scope, server).use { room ->
            val deletes = mutableListOf<String>()
            home(room, deletes)

            val routineId = room.store.routines.single().id
            compose.onNodeWithText("Push Day").performTouchInput { swipeLeft() }
            compose.runOnIdle {
                assertEquals(1, deletes.size)
                assertEquals("withheld means not sent", emptyList<Json>(), room.outbox())
            }

            // The window closes and the delete goes out; the log refuses it, and the row is back:
            // nothing the log holds was crossed out.
            compose.runOnIdle { runBlocking { room.store.settleWithheld(routineId) } }
            compose.runOnIdle {
                assertEquals("the settled row has left the list", emptyList<String>(), room.store.routines.map { it.id })
                assertEquals("one delete on the wire", listOf(routineId), routineDeletes(room))
                server.refuse(code = "stale")
                room.sync(server)
            }
            compose.waitUntil(2_000) {
                shadowOf(Looper.getMainLooper()).idle()
                room.store.routines.map { it.id } == listOf(routineId)
            }
            compose.waitForIdle()
            compose.mainClock.advanceTimeBy(window * 3)
            compose.waitForIdle()

            compose.runOnIdle {
                assertEquals("one swipe is one delete", 1, deletes.size)
                assertEquals("and the row coming back sent no second delete", emptyList<String>(), routineDeletes(room))
                assertEquals("nothing is held any more", emptyList<Any>(), room.store.withheld)
            }
            compose.onNodeWithText("Push Day").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // The other half, and the one that matters more: taking a delete back must not re-delete it.
    @Test
    fun testAnUndoLeavesTheRowStandingAndSendsNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { program(scope, EngineRoomFixture.server()).use { room ->
            val deletes = mutableListOf<String>()
            home(room, deletes)

            compose.onNodeWithText("Push Day").performTouchInput { swipeLeft() }
            compose.runOnIdle { assertEquals(1, room.store.withheld.size) }

            compose.runOnIdle { assertNotNull("the window was still the lifter's", room.store.keepWithheld()) }
            compose.waitForIdle()
            compose.mainClock.advanceTimeBy(window * 3)
            compose.waitForIdle()

            compose.runOnIdle {
                assertEquals("the row a lifter took back is not deleted again", 1, deletes.size)
                assertEquals("nothing is held", emptyList<Any>(), room.store.withheld)
                assertEquals("and nothing ever reached the log", emptyList<Json>(), room.outbox())
            }
            // And it is a whole row again, where it belongs — not parked off the leading edge with the
            // offset the swipe that removed it left behind. Which is what the second stroke proves: a
            // state left sitting at `EndToStart` could never travel there again, so the row would be
            // undeletable for as long as the screen stood.
            compose.onNodeWithText("Push Day").assertIsDisplayed()
            compose.onNodeWithText("Push Day").performTouchInput { swipeLeft() }
            compose.runOnIdle {
                assertEquals("a row that came back can be deleted again", 2, deletes.size)
                assertEquals(1, room.store.withheld.size)
            }
        } } finally { scope.cancel() }
    }
}
