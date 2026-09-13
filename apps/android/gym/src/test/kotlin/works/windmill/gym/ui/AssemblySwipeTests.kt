package works.windmill.gym.ui

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
        compose.mainClock.advanceTimeBy(1_600)
        compose.onRoot().performTouchInput { up() }
        compose.mainClock.autoAdvance = true
        compose.runOnIdle {
            assertTrue("a held edge reaches rows beyond the first viewport", rows.indexOfFirst { it.id == "movement-0" } >= 10)
            assertEquals((0..17).map { "movement-$it" }.toSet(), rows.map { it.id }.toSet())
        }
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
