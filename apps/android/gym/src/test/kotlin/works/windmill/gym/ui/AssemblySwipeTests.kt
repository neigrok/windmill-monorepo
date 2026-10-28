package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.test.swipeLeft
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.LiveLines

// The walk's swipe-to-drop. `confirmValueChange` is a VETO the framework may ask more than once per
// gesture, so the drop itself may not live there: a `drop` that is not idempotent would double-apply.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class AssemblySwipeTests {
    @get:Rule
    val compose = createComposeRule()

    private fun row(id: String, canDrop: Boolean) = LiveLines.MovementRow(
        id = id,
        name = id,
        tag = null,
        line = null,
        sets = emptyList(),
        isCurrent = false,
        justAdded = false,
        canDrop = canDrop,
    )

    @Test
    @Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
    fun doubleTextKeepsTheTitleAddActionAndLastRowReachable() {
        val rows = List(12) { row("Long movement name $it", canDrop = true).copy(metadata = "Up next · 3 × 10 · 24 kg each") }
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                AssemblySheet(rows, "Push A", {}, { _, _ -> }, { false }, {})
            }
        }
        compose.onNodeWithText("This workout").assertIsDisplayed()
        compose.onNodeWithText("Add movement").assertIsDisplayed()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("Long movement name 11"))
        compose.onNodeWithText("Long movement name 11").assertIsDisplayed()
        compose.onNodeWithText("Add movement").assertIsDisplayed()
    }

    @Test
    fun holdingTheGripAtTheViewportEdgeMovesPastInitiallyVisibleRows() {
        var rows by mutableStateOf(List(18) { row("movement-$it", canDrop = false) })
        compose.setContent {
            AssemblySheet(rows, "Push A", onJump = {},
                onReorder = { from, to -> rows = rows.toMutableList().apply { add(to, removeAt(from)) } },
                onDrop = { false }, onAdd = {})
        }
        val grip = compose.onNodeWithContentDescription("Reorder movement-0", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val viewport = compose.onNode(hasScrollAction()).fetchSemanticsNode().boundsInRoot
        compose.mainClock.autoAdvance = false
        compose.onRoot().performTouchInput {
            down(grip.center)
            advanceEventTime(600)
            moveTo(Offset(grip.center.x, viewport.bottom - 10f), delayMillis = 100)
        }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(1_600)
        compose.onRoot().performTouchInput { up() }
        compose.mainClock.autoAdvance = true
        compose.runOnIdle {
            assertTrue("a held edge reaches rows beyond the first viewport: ${rows.map { it.id }}", rows.indexOfFirst { it.id == "movement-0" } >= 10)
            assertEquals((0..17).map { "movement-$it" }.toSet(), rows.map { it.id }.toSet())
        }
    }

    @Test
    fun aHandleSwipeAndCancelledPreviewNeverSaveOrRemoveAMovement() {
        val initial = List(3) { row("movement-$it", canDrop = true) }
        var rows by mutableStateOf(initial)
        val saves = mutableListOf<Pair<Int, Int>>()
        val removals = mutableListOf<String>()
        compose.setContent {
            AssemblySheet(rows, null, {}, { from, to ->
                saves += from to to
                rows = rows.toMutableList().apply { add(to, removeAt(from)) }
            }, { removals += it; true }, {})
        }
        val grip = compose.onNodeWithContentDescription("Reorder movement-0", useUnmergedTree = true)
        grip.performTouchInput { swipeLeft() }
        assertEquals(initial, rows)
        assertEquals(emptyList<String>(), removals)
        val target = compose.onNodeWithContentDescription("Reorder movement-1", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val start = grip.fetchSemanticsNode().boundsInRoot
        compose.mainClock.autoAdvance = false
        compose.onRoot().performTouchInput {
            down(start.center)
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 100)
            moveTo(Offset(start.center.x, target.bottom + 10f))
        }
        compose.waitUntil(2_000) {
            compose.mainClock.advanceTimeByFrame()
            compose.onNodeWithText("movement-1").fetchSemanticsNode().boundsInRoot.top <
                compose.onNodeWithText("movement-0").fetchSemanticsNode().boundsInRoot.top
        }
        assertEquals(initial, rows)
        compose.onRoot().performTouchInput { cancel() }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertTrue(compose.onNodeWithText("movement-0").fetchSemanticsNode().boundsInRoot.top <
            compose.onNodeWithText("movement-1").fetchSemanticsNode().boundsInRoot.top)
        assertEquals(initial, rows)
        assertEquals(emptyList<Pair<Int, Int>>(), saves)
        assertEquals(emptyList<String>(), removals)
    }

    @Test
    fun anAncestorConsumingTheDragCancelsItsPreviewWithoutSaving() {
        val rows = List(3) { row("movement-$it", canDrop = true) }
        var consume = false
        val saves = mutableListOf<Pair<Int, Int>>()
        val removals = mutableListOf<String>()
        compose.setContent {
            Box(Modifier.pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        if (consume) event.changes.forEach { it.consume() }
                    }
                }
            }) { AssemblySheet(rows, null, {}, { from, to -> saves += from to to }, { removals += it; true }, {}) }
        }
        val grip = compose.onNodeWithContentDescription("Reorder movement-0", useUnmergedTree = true)
        val start = grip.fetchSemanticsNode().boundsInRoot
        val target = compose.onNodeWithContentDescription("Reorder movement-1", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        compose.mainClock.autoAdvance = false
        compose.onRoot().performTouchInput {
            down(start.center)
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 100)
            moveTo(Offset(start.center.x, target.bottom + 10f))
        }
        compose.waitUntil(2_000) {
            compose.mainClock.advanceTimeByFrame()
            compose.onNodeWithText("movement-1").fetchSemanticsNode().boundsInRoot.top <
                compose.onNodeWithText("movement-0").fetchSemanticsNode().boundsInRoot.top
        }
        consume = true
        compose.onRoot().performTouchInput { moveTo(Offset(start.center.x, target.bottom + 20f)); up() }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertTrue(compose.onNodeWithText("movement-0").fetchSemanticsNode().boundsInRoot.top <
            compose.onNodeWithText("movement-1").fetchSemanticsNode().boundsInRoot.top)
        assertEquals(emptyList<Pair<Int, Int>>(), saves)
        assertEquals(emptyList<String>(), removals)
    }

    @Test
    fun aStartToEndSwipeNeverDropsAndTheEndToStartActionIsNamed() {
        val removed = mutableListOf<String>()
        compose.setContent { AssemblySheet(listOf(row("movement", true)), null, {}, { _, _ -> }, { removed += it; true }, {}) }
        compose.onNodeWithText("movement").performTouchInput { swipeRight() }
        assertEquals(emptyList<String>(), removed)
        compose.onNodeWithText("movement").assertIsDisplayed()
        val labels = compose.onAllNodes(SemanticsMatcher.keyIsDefined(androidx.compose.ui.semantics.SemanticsActions.CustomActions),
            useUnmergedTree = true).fetchSemanticsNodes().flatMap {
            it.config[androidx.compose.ui.semantics.SemanticsActions.CustomActions].map { action -> action.label }
        }
        assertEquals(listOf("Remove movement"), labels)
        compose.onNodeWithText("Remove").assertDoesNotExist()
    }

    @Test
    fun testOneSwipeDropsTheRowExactlyOnce() {
        val dropped = mutableListOf<String>()
        compose.setContent {
            AssemblySheet(
                rows = listOf(row("bench-press", canDrop = true), row("row", canDrop = false)),
                routine = null,
                onJump = {},
                onReorder = { _, _ -> },
                onDrop = { dropped.add(it); true },
                onAdd = {},
            )
        }

        compose.onNodeWithText("bench-press").performTouchInput { swipeLeft() }
        compose.waitForIdle()

        assertEquals(listOf("bench-press"), dropped)
    }

    // The veto the predicate used to carry: a drop the walk refuses puts the row back rather than
    // leaving a dismissed box over a row that is still there.
    @Test
    fun testADropTheWalkRefusesIsAppliedOnceAndPutsTheRowBack() {
        val asked = mutableListOf<String>()
        compose.setContent {
            AssemblySheet(
                rows = listOf(row("bench-press", canDrop = true), row("row", canDrop = false)),
                routine = null,
                onJump = {},
                onReorder = { _, _ -> },
                onDrop = { asked.add(it); false },
                onAdd = {},
            )
        }

        compose.onNodeWithText("bench-press").performTouchInput { swipeLeft() }
        compose.waitForIdle()

        assertEquals(listOf("bench-press"), asked)
        compose.onNodeWithText("bench-press").assertIsDisplayed()
        compose.onNodeWithText("The movement could not be removed. Check the current workout.").assertIsDisplayed()
    }

    @Test
    fun testARowWithSetsOnItIsNotWrappedAndCannotBeSwipedAway() {
        val dropped = mutableListOf<String>()
        compose.setContent {
            AssemblySheet(
                rows = listOf(row("row", canDrop = false)),
                routine = null,
                onJump = {},
                onReorder = { _, _ -> },
                onDrop = { dropped.add(it); true },
                onAdd = {},
            )
        }

        compose.onNodeWithText("row").performTouchInput { swipeLeft() }
        compose.waitForIdle()

        assertEquals(emptyList<String>(), dropped)
    }
    @Test
    fun aNewMovementAtTheEndOfALongWalkIsRevealedAndAnnouncedAsCurrent() {
        val rows = List(18) { row("movement-$it", canDrop = true) }.mapIndexed { index, item ->
            if (index == 17) item.copy(isCurrent = true, justAdded = true) else item
        }
        compose.setContent { AssemblySheet(rows, null, {}, { _, _ -> }, { false }, {}) }
        compose.onNodeWithText("movement-17").assertIsDisplayed().assertIsSelected().assertIsFocused()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Just added, Current movement"))
    }

}
