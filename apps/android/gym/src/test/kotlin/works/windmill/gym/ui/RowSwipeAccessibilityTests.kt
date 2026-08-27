package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.RefusedSet
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

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

    private fun store(scope: CoroutineScope, server: FakeTraining?): TrainingStore {
        val root = File(System.getProperty("java.io.tmpdir"), "rows-${System.nanoTime()}")
        root.mkdirs()
        val store = TrainingStore(
            queue = SetQueue(File(root, "queue.json")),
            deviceCopy = DeviceCopy(File(root, "catalog.json")),
            localLog = LocalLog(File(root, "local.json")),
            localPreferences = LocalPreferences(File(root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(root, "bodyweight.json")),
            scope = scope,
            undoWindowMs = SetQueue.undoWindowMs,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam")))
        }
        return store
    }

    private fun actionsAround(node: SemanticsNode): List<String> =
        generateSequence(node) { it.parent }
            .mapNotNull { it.config.getOrNull(SemanticsActions.CustomActions) }
            .flatten()
            .map { it.label }
            .toList()

    @Test
    fun theRoutineRowSwipesToDeleteAndItsOverflowIsTheAlternativeSoNoActionIsDeclaredTwice() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope, FakeTraining())
        runBlocking { store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) }
        val deleted = mutableListOf<String>()
        compose.setContent {
            RoutinesScreen(
                store = store, isSignedIn = true, lookedAt = emptySet(), seat = "s",
                onJustStart = {}, onBuild = {}, onOpenRoutine = {},
                onDeleteRoutine = { deleted += it }, onReview = {}, onOpenSettings = {}, onSignIn = {},
            )
        }

        compose.onNodeWithText("Push Day").performTouchInput { swipeRight() }
        compose.runOnIdle { assertEquals("nothing on the leading edge", emptyList<String>(), deleted) }

        assertEquals("the overflow already carries it, so the row declares nothing twice",
            emptyList<String>(), actionsAround(compose.onNodeWithText("Push Day").fetchSemanticsNode()))

        compose.onNodeWithText("Push Day").performTouchInput { swipeLeft() }
        compose.runOnIdle {
            assertEquals(listOf(store.routines.single().id), deleted)
            assertEquals("the screen asks; the room is what withholds it",
                emptySet<String>(), store.withheldIds)
        }
        scope.cancel()
    }

    @Test
    fun theThreadRowSwipesToDeleteAndDeclaresThatActionByHand() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val store = store(scope, server)
        val deleted = mutableListOf<String>()
        compose.setContent {
            ThreadsScreen(
                store = store, backTo = "Coach", onBack = {}, onOpen = {},
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
            assertTrue("and nothing reached the log", "deleteThread" !in server.calls)
        }
        scope.cancel()
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
