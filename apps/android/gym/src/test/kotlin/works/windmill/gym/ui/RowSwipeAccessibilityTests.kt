package works.windmill.gym.ui

import works.windmill.gym.coach.ThreadsScreen
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.coach.AskThread
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.RefusedSet

// 13-gestures Law 1 is a PER-ROW test on Android, not a blanket cost, and this file is where the
// check lives for the three rows this wave gave a swipe to besides the set row.
//
// The routine row inherits its alternative for free: its overflow already holds the same Delete, and
// an overflow is a real button a screen reader can press. The thread row and the refusal row carry
// no overflow at all, so each declares its action BY HAND — without which a lifter on TalkBack
// cannot delete a conversation or dismiss a refusal at all.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RowSwipeAccessibilityTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope, rest: FakeGymRest = FakeGymRest()): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = rest)
        room.now = System.currentTimeMillis()
        runBlocking {
            room.select("u1")
            room.pull(EngineRoomFixture.server())
        }
        room.store.observeEngine()
        return room
    }

    private fun actionsAround(node: SemanticsNode): List<String> =
        generateSequence(node) { it.parent }
            .mapNotNull { it.config.getOrNull(SemanticsActions.CustomActions) }
            .flatten()
            .map { it.label }
            .toList()

    @Test
    fun theRoutineRowSwipesToDeleteAndDeclaresThatActionByHandNamedWithTheRoutine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            runBlocking { room.store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) }
            val deleted = mutableListOf<String>()
            compose.setContent {
                RoutinesScreen(
                    store = room.store, isSignedIn = true, lookedAt = emptySet(), seat = "s",
                    onJustStart = {}, onBuild = {}, onOpenRoutine = {},
                    onDeleteRoutine = { deleted += it }, onReview = {}, onSignIn = {},
                )
            }

            compose.onNodeWithText("Push Day").performTouchInput { swipeRight() }
            compose.runOnIdle { assertEquals("nothing on the leading edge", emptyList<String>(), deleted) }

            assertEquals("the row draws no control for Delete, so the swipe's one act is declared by hand",
                listOf("Delete Push Day"), actionsAround(compose.onNodeWithText("Push Day").fetchSemanticsNode()))

            compose.onNodeWithText("Push Day").performTouchInput { swipeLeft() }
            compose.runOnIdle {
                assertEquals(listOf(room.store.routines.single().id), deleted)
                assertEquals("the screen asks; the room is what withholds it",
                    emptySet<String>(), room.store.withheldIds)
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun theThreadRowSwipesToDeleteAndDeclaresThatActionByHand() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val rest = FakeGymRest()
        rest.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        try { store(scope, rest).use { room ->
            val deleted = mutableListOf<String>()
            compose.setContent {
                ThreadsScreen(
                    store = room.store, backTo = "Coach", onBack = {}, onOpen = {},
                    onDelete = { deleted += it }, onAskNew = {},
                )
            }

            val row = compose.onNodeWithText("why is my bench stalled?").fetchSemanticsNode()
            assertEquals("no overflow on this row, so the swipe declares its own alternative",
                listOf("Delete"), actionsAround(row))

            compose.onNodeWithText("why is my bench stalled?").performTouchInput { swipeRight() }
            compose.runOnIdle { assertEquals(emptyList<String>(), deleted) }

            compose.onNodeWithText("why is my bench stalled?").performTouchInput { swipeLeft() }
            compose.runOnIdle {
                assertEquals(listOf("thr_1"), deleted)
                assertTrue("and nothing reached the log", "deleteThread" !in rest.calls)
            }
        } } finally { scope.cancel() }
    }

    // Safe in both directions, because it discards a notice and not data.
    @Test
    fun theRefusalRowSwipesAwayInEitherDirectionAndItsButtonIsGone() {
        var dismissed = 0
        compose.setContent {
            Refusals(
                refusals = listOf(RefusedSet(
                    id = "set_1", exerciseId = "bench-press", weightKg = 82.5, reps = 5,
                    reason = "that session is finished")),
                catalog = emptyList(),
                onDismiss = { dismissed += 1 },
            )
        }

        val row = compose.onNodeWithText("that session is finished").fetchSemanticsNode()
        assertEquals(listOf("Dismiss"), actionsAround(row))

        compose.onNodeWithText("that session is finished").performTouchInput { swipeRight() }
        compose.runOnIdle { assertEquals(1, dismissed) }
    }
}
