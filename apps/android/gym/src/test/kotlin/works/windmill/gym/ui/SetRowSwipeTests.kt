package works.windmill.gym.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.sharing.WorkoutShareActions
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FinishOutcome

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

    private fun store(scope: CoroutineScope): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        room.now = System.currentTimeMillis() - 60_000
        val server = EngineRoomFixture.server()
        runBlocking {
            room.select("u1")
            room.pull(server)
            room.startExternalWorkout()
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
    fun aTrailingSwipeDeletesTheRowAndALeadingOneDoesNothing() {
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
                assertEquals(emptyList<Any>(), room.store.withheld)
                assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() })
                assertNull(room.store.keepWithheld())
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun testAStrokeCarriedTheWholeWayAcrossDeletesExactlyOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            screen(room, session(room))

            compose.onNodeWithText("82.5 × 5").performTouchInput {
                swipeLeft(startX = right - 1f, endX = left + 1f)
            }

            compose.runOnIdle {
                assertEquals(emptyList<Any>(), room.store.withheld)
                assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() })
            }
        } } finally { scope.cancel() }
    }

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
                assertEquals(emptyList<Any>(), room.store.withheld)
                assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() })
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun theRowThatMovesUpIntoADeletedRowsPlaceIsAWholeRowAgain() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            screen(room, session(room))

            compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
            compose.runOnIdle { assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() }) }

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

    @Test
    fun aSettledSwipeStaysQueuedAfterLeavingTheScreen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            val summary = session(room)
            val standing = screen(room, summary)

            compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
            compose.runOnIdle { assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() }) }

            standing.value = false
            compose.runOnIdle { }
            compose.onNodeWithText("somewhere else").assertIsDisplayed()

            compose.runOnIdle {
                assertEquals(emptyList<Any>(), room.store.withheld)
                assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() })
                assertEquals(listOf(90.0), room.training.details().single { it.session.id == summary.id }.sets.map { it.weightKg })
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun aDeletedRowStaysGoneWhenTheScreenReopens() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { store(scope).use { room ->
            val standing = screen(room, session(room))

            compose.onNodeWithText("82.5 × 5").performTouchInput { swipeLeft() }
            compose.runOnIdle { assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() }) }
            standing.value = false
            compose.runOnIdle { }

            compose.runOnIdle { assertNull(room.store.keepWithheld()) }
            standing.value = true
            compose.onNodeWithText("90 × 3").assertIsDisplayed()
            assertEquals(emptyList<Any>(), compose.onAllNodesWithText("82.5 × 5").fetchSemanticsNodes())
        } } finally { scope.cancel() }
    }
}
