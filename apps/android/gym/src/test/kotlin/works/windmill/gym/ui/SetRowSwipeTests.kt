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
import java.io.File
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
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.CoachDoors
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionSummary
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

    private val doors = CoachDoors(
        origin = "https://windmill.works",
        mint = { error("no link is minted here") },
        revoke = { error("no link is revoked here") },
    )

    private fun store(scope: CoroutineScope, server: FakeTraining): TrainingStore {
        val root = File(System.getProperty("java.io.tmpdir"), "swipe-${System.nanoTime()}")
        root.mkdirs()
        val store = TrainingStore(
            queue = SetQueue(File(root, "queue.json")),
            deviceCopy = DeviceCopy(File(root, "catalog.json")),
            localLog = LocalLog(File(root, "local.json")),
            localPreferences = LocalPreferences(File(root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            undoWindowMs = SetQueue.undoWindowMs,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam")))
            store.choose("bench-press")
            store.logSet(weightKg = 82.5, reps = 5)
            store.logSet(weightKg = 90.0, reps = 3)
            store.flushPendingSets(force = true)
            store.finish()
        }
        return store
    }

    private fun session(store: TrainingStore): SessionSummary = store.recent.single()

    private fun screen(
        store: TrainingStore,
        summary: SessionSummary,
        standing: MutableState<Boolean> = mutableStateOf(true),
    ): MutableState<Boolean> {
        compose.setContent {
            if (standing.value) {
                SessionScreen(
                    summary = summary,
                    store = store,
                    coach = doors,
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
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        screen(store, session(store))

        compose.onNodeWithText("82.5 × 5").assertIsDisplayed()
        compose.onNodeWithText("82.5 × 5").performTouchInput { swipeRight() }
        compose.runOnIdle {
            assertEquals("nothing on the leading edge", emptySet<String>(), store.withheldIds)
        }
        compose.onNodeWithText("82.5 × 5").assertIsDisplayed()

        compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
        compose.runOnIdle {
            assertEquals(1, store.withheld.size)
            assertTrue(store.withheld.single().deletion is Deletion.Set)
            assertTrue("and nothing is on the wire", server.removed.isEmpty())
        }
        scope.cancel()
    }

    // A stroke carried the whole way across is still ONE decision. `SwipeToDismissBox` settles on
    // release, so there is no trigger-without-lifting to guard against — what has to hold is that
    // the longest possible stroke does not delete twice, or open a second window over the same row.
    @Test
    fun testAStrokeCarriedTheWholeWayAcrossDeletesExactlyOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        screen(store, session(store))

        compose.onNodeWithText("82.5 × 5").performTouchInput {
            swipeLeft(startX = right - 1f, endX = left + 1f)
        }

        compose.runOnIdle {
            assertEquals("one window, not two", 1, store.withheld.size)
            assertEquals(emptyList<Pair<String, String>>(), server.removed)
        }
        scope.cancel()
    }

    // Law 1, the Android half. Without this the swipe is half-built: a lifter on TalkBack has no way
    // to delete a set at all, because the fix sheet's own Delete is behind a tap this row's drag
    // cannot stand in for.
    @Test
    fun testTheRowDeclaresDeleteAsACustomActionAndItDoesTheSameThing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        screen(store, session(store))

        val row = compose.onNodeWithText("82.5 × 5").fetchSemanticsNode()
        val declared = generateSequence(row) { it.parent }
            .mapNotNull { it.config.getOrNull(SemanticsActions.CustomActions) }
            .flatten()
            .toList()
        assertEquals(listOf("Delete"), declared.map { it.label })

        compose.runOnIdle { assertTrue(declared.single().action?.invoke() == true) }
        compose.runOnIdle {
            assertEquals(1, store.withheld.size)
            assertTrue("and it is withheld, exactly as the swipe leaves it", server.removed.isEmpty())
        }
        scope.cancel()
    }

    // The row that moves up into a deleted row's place is a whole row again — where it belongs, and
    // still opening the fix sheet. (What put this here was a leftover swipe offset seen on a phone;
    // Robolectric does not reproduce that, so this pins the outcome and not the cause.)
    @Test
    fun theRowThatMovesUpIntoADeletedRowsPlaceIsAWholeRowAgain() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        screen(store, session(store))

        compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
        compose.runOnIdle { assertEquals(1, store.withheld.size) }

        val survivor = compose.onNodeWithText("90 × 3").fetchSemanticsNode().boundsInRoot
        assertTrue("the survivor is drawn where a row belongs, not parked off the leading edge: " +
            "left was ${survivor.left}", survivor.left >= 0f)
        compose.onNodeWithText("90 × 3").performClick()
        compose.onNodeWithText("Fix this set").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testATapStillOpensTheFixSheet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        screen(store, session(store))

        compose.onNodeWithText("82.5 × 5").performClick()

        compose.onNodeWithText("Fix this set").assertIsDisplayed()
        compose.onNodeWithText("Set note").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptySet<String>(), store.withheldIds) }
        scope.cancel()
    }

    // Swipe, then back. Two completely ordinary acts, and before this wave the second one committed
    // the first — the row was destroyed while its Undo was still nominally on screen.
    @Test
    fun testSwipeThenLeavingTheScreenDoesNotSendTheDelete() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        val standing = screen(store, session(store))

        compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
        compose.runOnIdle { assertEquals(1, store.withheld.size) }

        standing.value = false
        compose.runOnIdle { }
        compose.onNodeWithText("somewhere else").assertIsDisplayed()

        compose.runOnIdle {
            assertTrue("the window follows the lifter rather than dying with the screen",
                store.withheld.single().takeable)
            assertEquals("and nothing was sent", emptyList<Pair<String, String>>(), server.removed)
            assertEquals("both sets are still on the log",
                listOf(82.5, 90.0), server.sets.getValue("ses_1").map { it.weightKg })
        }
        scope.cancel()
    }

    @Test
    fun testTheWindowStillHoldsTheRowAfterTheScreenIsGoneAndUndoBringsItBack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = store(scope, server)
        val standing = screen(store, session(store))

        compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
        compose.runOnIdle { assertEquals(1, store.withheld.size) }
        standing.value = false
        compose.runOnIdle { }

        compose.runOnIdle { assertNotNull(store.keepWithheld()) }
        standing.value = true
        compose.runOnIdle { }
        compose.onNodeWithText("82.5 × 5").assertIsDisplayed()
        scope.cancel()
    }
}
