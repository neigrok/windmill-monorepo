package works.windmill.gym.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutineEditorTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope) = TrainingStore(
        queue = SetQueue(File(tmp.root, "queue.json")),
        deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
        localLog = LocalLog(File(tmp.root, "local.json")),
        localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
        localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
        scope = scope,
        sync = { null },
    )

    private fun editor(scope: CoroutineScope, opening: RoutineDraft): () -> RoutineDraft {
        val store = store(scope)
        var draft by mutableStateOf(opening)
        compose.setContent {
            RoutineBuilder(
                draft = draft,
                store = store,
                saving = false,
                onDraft = { draft = it },
                onSave = {},
                onClose = {},
                say = {},
            )
        }
        return { draft }
    }

    private fun actionsOn(movement: String): List<CustomAccessibilityAction> {
        val row = compose.onNodeWithText(movement).fetchSemanticsNode()
        if (!row.config.contains(SemanticsActions.CustomActions)) return emptyList()
        return row.config[SemanticsActions.CustomActions]
    }

    private fun handle(name: String) = compose.onNodeWithContentDescription(name, useUnmergedTree = true)

    @Test
    fun testAMovementRowOffersRemoveAsACustomActionAndNotOnlyAsASwipe() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat"))

        val steps = actionsOn("bench-press")
        assertEquals(listOf("Delete bench-press", "Move down"), steps.map { it.label })

        compose.runOnIdle { steps.first { it.label == "Delete bench-press" }.action() }
        compose.runOnIdle {
            assertEquals("and it removes the same line the swipe would",
                listOf("squat"), draft().entries.map { it.exerciseId })
        }
        scope.cancel()
    }

    @Test
    fun testAFreshEditorOpensWithTheNameFieldFocused() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft())
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Routine name").assertIsFocused()
        scope.cancel()
    }

    @Test
    fun testTheNameCounterIsSilentUntilTheLastFifth() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day"))

        compose.onNodeWithText("7/60").assertDoesNotExist()
        assertEquals(48, Program.counterFrom)

        compose.onNodeWithContentDescription("Routine name").performTextReplacement("a".repeat(47))
        compose.onNodeWithText("47/60").assertDoesNotExist()

        compose.onNodeWithContentDescription("Routine name").performTextReplacement("a".repeat(53))
        compose.onNodeWithText("53/60").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testFreshBlankDraftIsQuietAndANamedEmptyDraftExplainsItsMissingMovement() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft())

        compose.onNodeWithText("Name it to save it.").assertDoesNotExist()
        compose.onNodeWithText("A routine is at least one movement.").assertDoesNotExist()

        compose.onNodeWithContentDescription("Routine name").performTextReplacement("Push Day")
        compose.onNodeWithText("Name it to save it.").assertDoesNotExist()
        compose.onNodeWithText("A routine is at least one movement.").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testTheEditorPrintsOpenPerRowAndLeavesTheSentenceToTheTargetSheet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat")
            .targeting("squat", List(3) { SetTarget(5, 60.0) }))

        compose.onNodeWithText("open").assertIsDisplayed()
        compose.onNodeWithText("You decide the numbers at the rack.").assertDoesNotExist()

        compose.onNodeWithText("bench-press").performClick()
        compose.onAllNodesWithText("You decide the numbers at the rack.").assertCountEquals(1)
        compose.onNodeWithText("You decide the numbers at the rack.").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testARoutineWhoseEveryLineNamesItsNumbersSaysNothingAboutTheRack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press")
            .targeting("bench-press", List(3) { SetTarget(5, 60.0) }))

        compose.onNodeWithText("You decide the numbers at the rack.").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun testASavableDraftSaysNothingAtAll() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press"))

        compose.onNodeWithText("Name it to save it.").assertDoesNotExist()
        compose.onNodeWithText("A routine is at least one movement.").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun testLongPressDragReordersAndRenumbersTheWholeDraft() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat").adding("row"))
        val start = handle("Move bench-press, 1 of 3").fetchSemanticsNode().boundsInRoot.center
        val end = handle("Move row, 3 of 3").fetchSemanticsNode().boundsInRoot.center
        handle("Move bench-press, 1 of 3").performTouchInput {
            down(center)
        }
        compose.mainClock.advanceTimeBy(650)
        handle("Move bench-press, 1 of 3").performTouchInput {
            moveBy(Offset(0f, end.y - start.y), delayMillis = 300)
            up()
        }
        compose.runOnIdle {
            assertEquals(listOf("squat", "row", "bench-press"), draft().entries.map { it.exerciseId })
            assertEquals(listOf(1, 2, 3), draft().entries.map { it.position })
        }
        scope.cancel()
    }

    @Test
    fun testMoveActionsBelongToTheirRowAndDoNotWrapAtEitherEnd() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat").adding("row"))
        assertEquals(listOf("Delete bench-press", "Move down"), actionsOn("bench-press").map { it.label })
        assertEquals(listOf("Delete squat", "Move up", "Move down"), actionsOn("squat").map { it.label })
        assertEquals(listOf("Delete row", "Move up"), actionsOn("row").map { it.label })
        compose.runOnIdle { actionsOn("row").first { it.label == "Move up" }.action() }
        compose.runOnIdle { assertEquals(listOf("bench-press", "row", "squat"), draft().entries.map { it.exerciseId }) }
        compose.onNodeWithText("row, 2 of 3").assertIsDisplayed()
        compose.runOnIdle { actionsOn("bench-press").first { it.label == "Move down" }.action() }
        compose.runOnIdle { assertEquals(listOf("row", "bench-press", "squat"), draft().entries.map { it.exerciseId }) }
        compose.onNodeWithText("bench-press, 2 of 3").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun testSwipeRemovesAnAddedMovementAndRenumbersTheRemainingRows() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val draft = editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat").adding("row"))
        compose.onNodeWithText("squat").performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(listOf("bench-press", "row"), draft().entries.map { it.exerciseId })
            assertEquals(listOf(1, 2), draft().entries.map { it.position })
        }
        scope.cancel()
    }

    @Test
    fun testTheMoveIsSaidOnOneStablePoliteLiveRegion() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        editor(scope, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat"))
        val lines = compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
        lines.assertCountEquals(1)
        val standing = lines.fetchSemanticsNodes().single()
        assertEquals("", standing.config[SemanticsProperties.Text].joinToString { it.text })
        compose.runOnIdle { actionsOn("squat").first { it.label == "Move up" }.action() }
        val said = lines.fetchSemanticsNodes().single()
        assertEquals("squat, 1 of 2", said.config[SemanticsProperties.Text].joinToString { it.text })
        assertEquals(standing.id, said.id)
        scope.cancel()
    }
    @Test
    fun testHoldingTheGripAtTheViewportEdgeScrollsBeyondInitiallyVisibleRows() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val initial = (1..20).fold(RoutineDraft(name = "Long day")) { draft, id -> draft.adding("movement-$id") }
        val draft = editor(scope, initial)
        val body = compose.onNodeWithTag("routine-editor-body").fetchSemanticsNode().boundsInRoot
        val grip = handle("Move movement-1, 1 of 20").fetchSemanticsNode().boundsInRoot
        compose.mainClock.autoAdvance = false
        handle("Move movement-1, 1 of 20").performTouchInput { down(center) }
        compose.mainClock.advanceTimeBy(650)
        handle("Move movement-1, 1 of 20").performTouchInput {
            moveBy(Offset(0f, body.bottom - 12f - grip.center.y), delayMillis = 300)
        }
        compose.mainClock.advanceTimeBy(4_000)
        compose.onRoot().performTouchInput { up() }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertTrue("the first movement reaches rows that started below the viewport", draft().entries.indexOfFirst { it.exerciseId == "movement-1" } >= 12)
        assertEquals((1..20).toList(), draft().entries.map { it.position })
        assertEquals(initial.entries.map { it.exerciseId }.toSet(), draft().entries.map { it.exerciseId }.toSet())
        scope.cancel()
    }

}
