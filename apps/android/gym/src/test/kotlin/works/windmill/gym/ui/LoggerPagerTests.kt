package works.windmill.gym.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.test.swipeUp
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
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LoggerPagerTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    // Signed in, with yesterday's bench and row on the log as last time, and standing in Push and
    // pull's bench.
    private fun logger(
        scope: CoroutineScope,
        heavier: Boolean = false,
        benchTarget: SetTarget = SetTarget(5, 82.5),
        rowTarget: SetTarget = SetTarget(8, 60.0),
    ): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope, undoWindowMs = 0)
        // On the wall clock, which the screen's own clocks read.
        val today = System.currentTimeMillis()
        room.now = today - 86_400_000
        runBlocking {
            room.select("u1")
            room.pull(EngineRoomFixture.server())
            room.store.start()
            room.store.choose("bench-press")
            room.store.logSet(80.0, 5)
            room.store.choose("barbell-row")
            room.store.logSet(55.0, 8)
            room.now += 60_000
            assertTrue(room.store.finish() is FinishOutcome.Closed)
            room.now = today
            val routine = (room.store.saveRoutine(
                RoutineDraft(name = "Push and pull")
                    .adding("bench-press")
                    .adding("barbell-row")
                    .targeting("bench-press", List(8) { benchTarget })
                    .targeting("barbell-row", List(3) { rowTarget })
            ) as GymResult.Ok).value
            room.store.start(routine.id)
            room.store.choose("bench-press")
            if (heavier) room.store.logSet(87.5, 5)
        }
        room.store.observeEngine()
        compose.setContent {
            LoggerScreen(store = room.store, isSignedIn = true, say = {},
                onFinish = {}, onSignIn = {}, onSettings = {})
        }
        return room
    }

    @Test
    fun aDragPreviewsTheAdjacentMovementAndReversingKeepsTheDraftAndDepartureQuestion() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, heavier = true).use { room ->
            compose.onNode(hasText("+2.5") and hasClickAction()).performClick()
            compose.onNode(hasContentDescription("one rep more")).performClick()
            compose.onNode(hasContentDescription("Weight 90 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()

            val pager = compose.onNodeWithTag("Movement pager")
            val y = compose.onNodeWithText("Bench Press").fetchSemanticsNode().boundsInRoot.center.y -
                pager.fetchSemanticsNode().boundsInRoot.top
            pager.performTouchInput {
                down(Offset(width * 0.9f, y))
                moveTo(Offset(width * 0.25f, y), delayMillis = 600)
            }

            compose.onNodeWithText("Bench Press").assertIsDisplayed()
            compose.onNodeWithText("Barbell Row").assertIsDisplayed()
            compose.onNode(hasContentDescription("Set 1, current, target 60 kg, 8 reps")).assertIsDisplayed()
            compose.onNodeWithText("Heavier than the plan").assertDoesNotExist()
            compose.onNodeWithText("Log set").assertIsNotEnabled()
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }

            pager.performTouchInput {
                moveTo(Offset(width * 0.9f, y), delayMillis = 600)
                advanceEventTime(200)
                up()
            }
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }
            compose.onNode(hasContentDescription("Weight 90 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()
            compose.onNodeWithText("Log set").assertIsEnabled()
            compose.onNodeWithText("Heavier than the plan").assertDoesNotExist()

            compose.onNodeWithText("Bench Press").performTouchInput {
                swipeLeft(startX = width * 0.9f, endX = width * 0.1f)
            }
            compose.runOnIdle { assertEquals("barbell-row", room.store.exerciseId) }
            compose.onNodeWithText("Heavier than the plan").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun releasingAShortSlowDragReturnsToTheSameMovement() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use { room ->
            val pager = compose.onNodeWithTag("Movement pager")
            val y = compose.onNodeWithText("Bench Press").fetchSemanticsNode().boundsInRoot.center.y -
                pager.fetchSemanticsNode().boundsInRoot.top

            pager.performTouchInput {
                down(Offset(width * 0.7f, y))
                moveTo(Offset(width * 0.5f, y), delayMillis = 600)
                advanceEventTime(200)
                up()
            }

            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }
            compose.onNodeWithText("Bench Press").assertIsDisplayed()
            compose.onNode(hasContentDescription("Exercise 1 of 2")).assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun aRackDragPreviewsTheMovementWhileTheRackStaysPinnedAndReversalDoesNotLog() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use { room ->
            val log = compose.onNodeWithText("Log set")
            val button = log.fetchSemanticsNode().boundsInRoot
            val weight = compose.onNode(hasContentDescription("Weight 82.5 kg"))
                .fetchSemanticsNode().boundsInRoot

            log.performTouchInput {
                down(Offset(width * 0.9f, centerY))
                moveTo(Offset(width * 0.25f, centerY), delayMillis = 600)
            }
            compose.onNodeWithText("Bench Press").assertIsDisplayed()
            compose.onNodeWithText("Barbell Row").assertIsDisplayed()
            log.assertIsNotEnabled()
            assertEquals(button, log.fetchSemanticsNode().boundsInRoot)
            assertEquals(weight, compose.onNode(hasContentDescription("Weight 82.5 kg"))
                .fetchSemanticsNode().boundsInRoot)
            compose.runOnIdle {
                assertEquals("bench-press", room.store.exerciseId)
                assertEquals(emptyList<TrainingSet>(), room.store.sets)
            }

            log.performTouchInput {
                moveTo(Offset(width * 0.9f, centerY), delayMillis = 600)
                advanceEventTime(200)
                up()
            }
            log.assertIsEnabled()
            compose.runOnIdle {
                assertEquals("bench-press", room.store.exerciseId)
                assertEquals(emptyList<TrainingSet>(), room.store.sets)
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun aCancelledTouchPastTheMidpointKeepsTheMovementDraftAndDepartureQuestion() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, heavier = true).use { room ->
            val sets = room.store.sets.toList()
            compose.onNode(hasText("+2.5") and hasClickAction()).performClick()
            val pager = compose.onNodeWithTag("Movement pager")
            val y = compose.onNodeWithText("Bench Press").fetchSemanticsNode().boundsInRoot.center.y -
                pager.fetchSemanticsNode().boundsInRoot.top
            pager.performTouchInput {
                down(Offset(width * 0.9f, y))
                moveTo(Offset(width * 0.25f, y), delayMillis = 600)
            }
            compose.onNodeWithText("Barbell Row").assertIsDisplayed()
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }

            pager.performTouchInput { cancel() }
            compose.runOnIdle {
                assertEquals("bench-press", room.store.exerciseId)
                assertEquals(sets, room.store.sets)
            }
            compose.onNodeWithText("Bench Press").assertIsDisplayed()
            compose.onNode(hasContentDescription("Weight 90 kg")).assertIsDisplayed()
            compose.onNodeWithText("Heavier than the plan").assertDoesNotExist()
            compose.onNodeWithText("Log set").assertIsEnabled()
        } } finally { scope.cancel() }
    }

    @Test
    fun equalPrefillsKeepTheDraftOnReversalAndResetItWhenTheOtherMovementSettles() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, benchTarget = SetTarget(5, 20.0), rowTarget = SetTarget(5, 20.0)).use { room ->
            compose.onNode(hasText("+2.5") and hasClickAction()).performClick()
            compose.onNode(hasContentDescription("one rep more")).performClick()
            compose.onNode(hasContentDescription("Weight 22.5 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()

            val pager = compose.onNodeWithTag("Movement pager")
            val y = compose.onNodeWithText("Bench Press").fetchSemanticsNode().boundsInRoot.center.y -
                pager.fetchSemanticsNode().boundsInRoot.top
            pager.performTouchInput {
                down(Offset(width * 0.9f, y))
                moveTo(Offset(width * 0.25f, y), delayMillis = 600)
            }
            compose.onNodeWithText("Barbell Row").assertIsDisplayed()
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }
            pager.performTouchInput {
                moveTo(Offset(width * 0.9f, y), delayMillis = 600)
                advanceEventTime(200)
                up()
            }
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }
            compose.onNode(hasContentDescription("Weight 22.5 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()

            compose.onNodeWithText("Bench Press").performTouchInput {
                swipeLeft(startX = width * 0.9f, endX = width * 0.1f)
            }
            compose.runOnIdle { assertEquals("barbell-row", room.store.exerciseId) }
            compose.onNode(hasContentDescription("Weight 20 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 5")).assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun aSettledPageUpdatesTheRackAndTheReturnSwipeUsesTheSameOrder() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use { room ->
            compose.onNodeWithText("Bench Press").performTouchInput {
                swipeLeft(startX = width * 0.9f, endX = width * 0.1f)
            }
            compose.runOnIdle { assertEquals("barbell-row", room.store.exerciseId) }
            compose.onNodeWithText("Barbell Row").assertIsDisplayed()
            compose.onNode(hasContentDescription("Set 1, current, target 60 kg, 8 reps")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Weight 60 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 8")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Exercise 2 of 2")).assertIsDisplayed()

            compose.onNodeWithText("Barbell Row").performTouchInput {
                swipeRight(startX = width * 0.1f, endX = width * 0.9f)
            }
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }
            compose.onNode(hasContentDescription("Weight 82.5 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 5")).assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // Only the ledger scrolls: a vertical stroke on it reads the sets and leaves the head where it
    // stood, and a horizontal stroke on the same rows still walks to the next movement.
    @Test
    fun aVerticalStrokeScrollsOnlyTheLedgerAndAHorizontalOneWalks() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use { room ->
            val ledger = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange))
            val head = compose.onNodeWithText("Bench Press").assertIsDisplayed().getBoundsInRoot()
            val initial = ledger.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
            assertTrue("the ledger overflows",
                ledger.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].maxValue() > 0f)

            ledger.performTouchInput { swipeUp() }
            val after = ledger.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
            assertTrue("vertical drag scrolls the ledger", after > initial)
            assertEquals("and the head stays pinned", head, compose.onNodeWithText("Bench Press").getBoundsInRoot())
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }

            ledger.performTouchInput { swipeDown() }
            assertTrue("the return drag scrolls back through the same movement",
                ledger.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() < after)
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }

            ledger.performTouchInput { swipeLeft(startX = width * 0.9f, endX = width * 0.1f) }
            compose.runOnIdle { assertEquals("barbell-row", room.store.exerciseId) }
        } } finally { scope.cancel() }
    }

    @Test
    fun anAssemblyJumpAndANewMovementLeaveThePagerSynchronized() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use { room ->
            compose.onNodeWithText("Bench Press").performClick()
            compose.onAllNodes(hasText("Barbell Row") and hasClickAction()).onFirst().performClick()
            compose.runOnIdle { assertEquals("barbell-row", room.store.exerciseId) }
            compose.onNodeWithText("Barbell Row").assertIsDisplayed()
            compose.onNodeWithText("Barbell Row").performTouchInput {
                swipeRight(startX = width * 0.1f, endX = width * 0.9f)
            }
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }

            compose.onNodeWithText("Add movement").performScrollTo().performClick()
            // The picker holds the whole catalogue, so Cable Fly is scrolled to.
            compose.onNodeWithText("Cable Fly").performScrollTo().performClick()
            compose.runOnIdle { assertEquals("cable-fly", room.store.exerciseId) }
            compose.onNode(hasContentDescription("Exercise 3 of 3")).assertIsDisplayed()
            compose.onNodeWithText("Cable Fly").performTouchInput {
                swipeRight(startX = width * 0.1f, endX = width * 0.9f)
            }
            compose.runOnIdle { assertEquals("barbell-row", room.store.exerciseId) }
            compose.onNodeWithText("Barbell Row").assertIsDisplayed()
        } } finally { scope.cancel() }
    }
}
