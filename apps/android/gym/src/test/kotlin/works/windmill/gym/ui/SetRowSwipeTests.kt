package works.windmill.gym.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
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
import org.robolectric.annotation.Config
import works.windmill.gym.sharing.WorkoutShareActions
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FinishOutcome
import works.windmill.sync.core.Json

// The one row 13-gestures says is ready for a swipe today, and the four things that make it safe:
// one trailing action, no leading one, a tap that still opens the fix sheet, and — the Android half
// of Law 1 — a custom accessibility action declared by hand, because TalkBack sees a drag and this
// row carries no overflow to inherit a real button from.
//
// And the two that make it survivable: a stroke carried the WHOLE way across performs exactly one
// delete, and leaving the screen the gesture was made on does not send it.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SetRowSwipeTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val doors = WorkoutShareActions(
        origin = "https://windmill.works",
        mint = { error("no link is minted here") },
        revoke = { error("no link is revoked here") },
    )

    // A finished workout of two sets, synced: both are on the account's log and nothing is owed.
    private fun store(scope: CoroutineScope): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        // A minute's workout that has just finished, on the wall clock.
        room.now = System.currentTimeMillis() - 60_000
        val server = EngineRoomFixture.server()
        runBlocking {
            room.select("u1")
            room.pull(server)
            room.store.start()
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.store.logSet(weightKg = 90.0, reps = 3)
            room.now += 60_000
            assertTrue(room.store.finish() is FinishOutcome.Closed)
            room.sync(server)
            room.store.refreshEngine()
        }
        room.store.observeEngine()
        return room
    }

    private fun session(room: EngineRoomFixture): SessionSummary = room.store.recent.single()

    private fun screen(
        room: EngineRoomFixture,
        summary: SessionSummary,
        standing: MutableState<Boolean> = mutableStateOf(true),
    ): MutableState<Boolean> {
        compose.setContent {
            if (standing.value) {
                SessionScreen(
                    summary = summary,
                    store = room.store,
                    sharing = doors,
                    backTo = "The log",
                    onBack = {},
                    say = {},
                    onOpenMovement = {},
                    onDiscard = {},
                )
            } else {
                Text("somewhere else")
            }
        }
        return standing
    }

    @Test
    fun testATrailingSwipeWithheldsTheRowAndALeadingOneDoesNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            screen(room, session(room))

            compose.onNodeWithText("82.5 × 5").assertIsDisplayed()
            compose.onNodeWithText("82.5 × 5").performTouchInput { swipeRight() }
            compose.runOnIdle {
                assertEquals("nothing on the leading edge", emptySet<String>(), room.store.withheldIds)
            }
            compose.onNodeWithText("82.5 × 5").assertIsDisplayed()

            compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
            compose.runOnIdle {
                assertEquals(1, room.store.withheld.size)
                assertTrue(room.store.withheld.single().deletion is Deletion.Set)
                assertEquals("and nothing is on the wire", emptyList<Json>(), room.outbox())
            }
        } } finally { scope.cancel() }
    }

    // A stroke carried the whole way across is still ONE decision. `SwipeToDismissBox` settles on
    // release, so there is no trigger-without-lifting to guard against — what has to hold is that
    // the longest possible stroke does not delete twice, or open a second window over the same row.
    @Test
    fun testAStrokeCarriedTheWholeWayAcrossDeletesExactlyOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            screen(room, session(room))

            compose.onNodeWithText("82.5 × 5").performTouchInput {
                swipeLeft(startX = right - 1f, endX = left + 1f)
            }

            compose.runOnIdle {
                assertEquals("one window, not two", 1, room.store.withheld.size)
                assertEquals(emptyList<Json>(), room.outbox())
            }
        } } finally { scope.cancel() }
    }

    // Law 1, the Android half. Without this the swipe is half-built: a lifter on TalkBack has no way
    // to delete a set at all, because the fix sheet's own Delete is behind a tap this row's drag
    // cannot stand in for.
    @Test
    fun testTheRowDeclaresDeleteAsACustomActionAndItDoesTheSameThing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            screen(room, session(room))

            val row = compose.onNodeWithText("82.5 × 5").fetchSemanticsNode()
            val declared = generateSequence(row) { it.parent }
                .mapNotNull { it.config.getOrNull(SemanticsActions.CustomActions) }
                .flatten()
                .toList()
            assertEquals(listOf("Delete"), declared.map { it.label })

            compose.runOnIdle { assertTrue(declared.single().action?.invoke() == true) }
            compose.runOnIdle {
                assertEquals(1, room.store.withheld.size)
                assertEquals("and it is withheld, exactly as the swipe leaves it", emptyList<Json>(), room.outbox())
            }
        } } finally { scope.cancel() }
    }

    // The row that moves up into a deleted row's place is a whole row again — where it belongs, and
    // still opening the fix sheet. (What put this here was a leftover swipe offset seen on a phone;
    // Robolectric does not reproduce that, so this pins the outcome and not the cause.)
    @Test
    fun theRowThatMovesUpIntoADeletedRowsPlaceIsAWholeRowAgain() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            screen(room, session(room))

            compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
            compose.runOnIdle { assertEquals(1, room.store.withheld.size) }

            val survivor = compose.onNodeWithText("90 × 3").fetchSemanticsNode().boundsInRoot
            assertTrue("the survivor is drawn where a row belongs, not parked off the leading edge: " +
                "left was ${survivor.left}", survivor.left >= 0f)
            compose.onNodeWithText("90 × 3").performClick()
            compose.onNodeWithText("Fix set").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun testATapStillOpensTheFixSheet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            screen(room, session(room))

            compose.onNodeWithText("82.5 × 5").performClick()

            compose.onNodeWithText("Fix set").assertIsDisplayed()
            compose.onNodeWithText("Set note").assertIsDisplayed()
            compose.runOnIdle { assertEquals(emptySet<String>(), room.store.withheldIds) }
        } } finally { scope.cancel() }
    }

    // Swipe, then back. Two completely ordinary acts, and before this wave the second one committed
    // the first — the row was destroyed while its Undo was still nominally on screen.
    @Test
    fun testSwipeThenLeavingTheScreenDoesNotSendTheDelete() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            val summary = session(room)
            val standing = screen(room, summary)

            compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
            compose.runOnIdle { assertEquals(1, room.store.withheld.size) }

            standing.value = false
            compose.runOnIdle { }
            compose.onNodeWithText("somewhere else").assertIsDisplayed()

            compose.runOnIdle {
                assertTrue("the window follows the lifter rather than dying with the screen",
                    room.store.withheld.single().takeable)
                assertEquals("and nothing was sent", emptyList<Json>(), room.outbox())
                assertEquals("both sets are still on the log",
                    listOf(82.5, 90.0), room.training.details().single { it.session.id == summary.id }.sets.map { it.weightKg })
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun testTheWindowStillHoldsTheRowAfterTheScreenIsGoneAndUndoBringsItBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            val standing = screen(room, session(room))

            compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
            compose.runOnIdle { assertEquals(1, room.store.withheld.size) }
            standing.value = false
            compose.runOnIdle { }

            compose.runOnIdle { assertNotNull(room.store.keepWithheld()) }
            standing.value = true
            compose.runOnIdle { }
            compose.onNodeWithText("82.5 × 5").assertIsDisplayed()
        } } finally { scope.cancel() }
    }
}
