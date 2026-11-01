package works.windmill.gym.ui

import works.windmill.gym.coach.ThreadsScreen
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
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
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.RefusedSet

// Gesture law 1 (`docs/design/guidelines/system-architecture.md` §3) is a PER-ROW test on Android, not a blanket cost, and this file is where the
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

    @Test fun theSharedDeleteRowNamesItsActionAndOnlySettlesEndToStart() {
        var requests = 0
        compose.setContent {
            GymMaterial {
                DeleteSwipeRow("Delete routine", { requests++; true }, Modifier.testTag("swipe-row")) {
                    Box(Modifier.fillMaxWidth().height(68.dp).background(LocalGymColors.current.surface)) { Text("Push A") }
                }
            }
        }
        val row = compose.onNodeWithTag("swipe-row")
        assertEquals(listOf("Delete routine"), actionsAround(compose.onNodeWithText("Push A").fetchSemanticsNode()))
        row.performTouchInput { swipeRight() }
        compose.runOnIdle { assertEquals(0, requests) }
        row.performTouchInput { swipeLeft() }
        compose.runOnIdle { assertEquals(1, requests) }
    }

    @Test fun aRefusedSharedDeleteResetsAndCanBeSwipedAgain() {
        var requests = 0
        compose.setContent {
            GymMaterial {
                DeleteSwipeRow("Remove movement", { requests++; false }, Modifier.testTag("swipe-row")) {
                    Box(Modifier.fillMaxWidth().height(56.dp).background(LocalGymColors.current.surface)) { Text("Bench Press") }
                }
            }
        }
        repeat(2) { index ->
            compose.onNodeWithTag("swipe-row").performTouchInput { swipeLeft() }
            compose.runOnIdle { assertEquals(index + 1, requests) }
        }
    }

    @Test
    fun theRoutineRowSwipesToDeleteAndDeclaresThatActionByHandNamedWithTheRoutine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            runBlocking { room.store.routines.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) }
            val deleted = mutableListOf<String>()
            compose.setContent {
                RoutinesScreen(
                    store = room.store, lookedAt = emptySet(), seat = "s", onBuild = {}, onOpenRoutine = {},
                    onDeleteRoutine = { deleted += it; true }, onReview = {},
                )
            }

            compose.onNodeWithText("Push Day").performTouchInput { swipeRight() }
            compose.runOnIdle { assertEquals("nothing on the leading edge", emptyList<String>(), deleted) }

            assertEquals("the row draws no control for Delete, so the swipe's one act is declared by hand",
                listOf("Delete Push Day"), actionsAround(compose.onNodeWithText("Push Day").fetchSemanticsNode()))

            compose.onNodeWithText("Push Day").performTouchInput { swipeLeft() }
            compose.runOnIdle {
                assertEquals(listOf(room.store.routines.all.single().id), deleted)
                assertEquals("the screen asks; the room is what withholds it",
                    emptySet<String>(), room.store.held.withheldIds)
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun theThreadRowSwipesToDeleteAndDeclaresThatActionByHand() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val rest = FakeGymRest()
        rest.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        try { store(scope, rest).use { room ->
            compose.setContent {
                ThreadsScreen(
                    store = room.store, backTo = "Coach", onBack = {}, onOpen = {},
                    onAskNew = {},
                )
            }

            val row = compose.onNodeWithText("why is my bench stalled?").fetchSemanticsNode()
            assertEquals("no overflow on this row, so the swipe declares its own alternative",
                listOf("Delete conversation"), actionsAround(row))

            compose.onNodeWithText("why is my bench stalled?").performTouchInput { swipeRight() }
            compose.onNodeWithText("Delete this conversation?").assertDoesNotExist()

            compose.onNodeWithText("why is my bench stalled?").performTouchInput { swipeLeft() }
            compose.onNodeWithText("Delete this conversation?").assertIsDisplayed()
            compose.runOnIdle { assertTrue("confirmation is required", "deleteThread" !in rest.calls) }
            compose.onNodeWithText("Cancel").performClick()
            compose.onNodeWithText("why is my bench stalled?").assertIsDisplayed()
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
