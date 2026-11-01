package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.hasTestTag
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
        telemetry: Telemetry = Telemetry.None,
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
            room.startExternalWorkout()
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
                    .targeting("barbell-row", List(3) { rowTarget }).capturingMovements(room.store.catalog)
            ) as GymResult.Ok).value
            room.store.start(routine.id)
            room.store.choose("bench-press")
            if (heavier) room.store.logSet(87.5, 5)
        }
        room.store.observeEngine()
        compose.setContent {
            CompositionLocalProvider(LocalTelemetry provides telemetry) {
                LoggerScreen(store = room.store, say = {}, onFinish = {})
            }
        }
        return room
    }

    @Test
    fun aDragPreviewsTheAdjacentMovementAndReversingKeepsTheDraft() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, heavier = true).use { room ->
            compose.onNode(hasText("+2.5") and hasClickAction()).performClick()
            compose.onNode(hasContentDescription("Increase Reps")).performClick()
            compose.onNode((hasContentDescription("Load, kg total") and hasText("90"))).assertIsDisplayed()
            compose.onNode((hasContentDescription("Reps") and hasText("6"))).assertIsDisplayed()

            val pager = compose.onNodeWithTag("Movement pager")
            val y = compose.onNodeWithText("Bench Press").fetchSemanticsNode().boundsInRoot.center.y -
                pager.fetchSemanticsNode().boundsInRoot.top
            pager.performTouchInput {
                down(Offset(width * 0.9f, y))
                moveTo(Offset(width * 0.25f, y), delayMillis = 600)
            }

            compose.onNodeWithText("Bench Press").assertIsDisplayed()
            compose.onNodeWithText("Barbell Row").assertIsDisplayed()
            compose.onNode(hasContentDescription("Set 1, current, 60 kg total, 8 reps")).assertIsDisplayed()
            compose.onNodeWithText("Heavier than the plan").assertDoesNotExist()
            compose.onNodeWithText("Log set").assertIsNotEnabled()
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }

            pager.performTouchInput {
                moveTo(Offset(width * 0.9f, y), delayMillis = 600)
                advanceEventTime(200)
                up()
            }
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }
            compose.onNode((hasContentDescription("Load, kg total") and hasText("90"))).assertIsDisplayed()
            compose.onNode((hasContentDescription("Reps") and hasText("6"))).assertIsDisplayed()
            compose.onNodeWithText("Log set").assertIsEnabled()
            compose.onNodeWithText("Heavier than the plan").assertDoesNotExist()

            compose.onNodeWithText("Bench Press").performTouchInput {
                swipeLeft(startX = width * 0.9f, endX = width * 0.1f)
            }
            compose.runOnIdle { assertEquals("barbell-row", room.store.exerciseId) }
            compose.onNodeWithText("Heavier than the plan").assertDoesNotExist()
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
            val weight = compose.onNode((hasContentDescription("Load, kg total") and hasText("82.5")))
                .fetchSemanticsNode().boundsInRoot

            log.performTouchInput {
                down(Offset(width * 0.9f, centerY))
                moveTo(Offset(width * 0.25f, centerY), delayMillis = 600)
            }
            compose.onNodeWithText("Bench Press").assertIsDisplayed()
            compose.onNodeWithText("Barbell Row").assertIsDisplayed()
            log.assertIsNotEnabled()
            assertEquals(button, log.fetchSemanticsNode().boundsInRoot)
            assertEquals(weight, compose.onNode((hasContentDescription("Load, kg total") and hasText("82.5")))
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
    fun aCancelledTouchPastTheMidpointKeepsTheMovementDraft() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        try { logger(scope, heavier = true, telemetry = telemetry).use { room ->
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
            compose.onNode((hasContentDescription("Load, kg total") and hasText("90"))).assertIsDisplayed()
            compose.onNodeWithText("Heavier than the plan").assertDoesNotExist()
            compose.onNodeWithText("Log set").assertIsEnabled()
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), events)
            compose.onNodeWithText("Bench Press").performTouchInput {
                swipeLeft(startX = width * 0.9f, endX = width * 0.1f)
            }
            compose.runOnIdle { assertEquals("barbell-row", room.store.exerciseId) }
            compose.onNodeWithText("Barbell Row").performClick()
            compose.onNodeWithText("This workout").assertIsDisplayed()
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "workout", "action" to "movement_switch", "outcome" to "ok"),
                "gym_action" to mapOf("screen" to "workout", "action" to "open_workout", "outcome" to "ok"),
            ), events)
        } } finally { scope.cancel() }
    }

    @Test
    fun equalPrefillsKeepTheDraftOnReversalAndResetItWhenTheOtherMovementSettles() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, benchTarget = SetTarget(5, 20.0), rowTarget = SetTarget(5, 20.0)).use { room ->
            compose.onNode(hasText("+2.5") and hasClickAction()).performClick()
            compose.onNode(hasContentDescription("Increase Reps")).performClick()
            compose.onNode((hasContentDescription("Load, kg total") and hasText("22.5"))).assertIsDisplayed()
            compose.onNode((hasContentDescription("Reps") and hasText("6"))).assertIsDisplayed()

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
            compose.onNode((hasContentDescription("Load, kg total") and hasText("22.5"))).assertIsDisplayed()
            compose.onNode((hasContentDescription("Reps") and hasText("6"))).assertIsDisplayed()

            compose.onNodeWithText("Bench Press").performTouchInput {
                swipeLeft(startX = width * 0.9f, endX = width * 0.1f)
            }
            compose.runOnIdle { assertEquals("barbell-row", room.store.exerciseId) }
            compose.onNode((hasContentDescription("Load, kg total") and hasText("20"))).assertIsDisplayed()
            compose.onNode((hasContentDescription("Reps") and hasText("5"))).assertIsDisplayed()
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
            compose.onNode(hasContentDescription("Set 1, current, 60 kg total, 8 reps")).assertIsDisplayed()
            compose.onNode((hasContentDescription("Load, kg total") and hasText("60"))).assertIsDisplayed()
            compose.onNode((hasContentDescription("Reps") and hasText("8"))).assertIsDisplayed()
            compose.onNode(hasContentDescription("Exercise 2 of 2")).assertIsDisplayed()

            compose.onNodeWithText("Barbell Row").performTouchInput {
                swipeRight(startX = width * 0.1f, endX = width * 0.9f)
            }
            compose.runOnIdle { assertEquals("bench-press", room.store.exerciseId) }
            compose.onNode((hasContentDescription("Load, kg total") and hasText("82.5"))).assertIsDisplayed()
            compose.onNode((hasContentDescription("Reps") and hasText("5"))).assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // Only the ledger scrolls: a vertical stroke on it reads the sets and leaves the head where it
    // stood, and a horizontal stroke on the same rows still walks to the next movement.
    @Test
    fun aVerticalStrokeScrollsOnlyTheLedgerAndAHorizontalOneWalks() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use { room ->
            val ledger = compose.onNode(hasTestTag("Set ledger"))
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

            compose.onNodeWithText("Add movement").assertDoesNotExist()
            compose.onNodeWithText("Bench Press").performClick()
            compose.onNodeWithText("Add movement").performClick()
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
