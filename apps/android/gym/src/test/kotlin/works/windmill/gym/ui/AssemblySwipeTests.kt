package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import org.junit.Assert.assertEquals
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
    fun testOneSwipeDropsTheRowExactlyOnce() {
        val dropped = mutableListOf<String>()
        compose.setContent {
            AssemblySheet(
                rows = listOf(row("bench-press", canDrop = true), row("row", canDrop = false)),
                elapsedMs = 0,
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
                elapsedMs = 0,
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
                elapsedMs = 0,
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
}
