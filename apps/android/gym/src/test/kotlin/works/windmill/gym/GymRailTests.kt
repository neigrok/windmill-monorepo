package works.windmill.gym

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.ui.GymMaterial
import works.windmill.gym.ui.GymSkin

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GymRailTests {
    @get:Rule val compose = createComposeRule()

    private fun channel(part: Float): Double {
        val value = part.toDouble()
        if (value <= 0.03928) return value / 12.92
        return ((value + 0.055) / 1.055).pow(2.4)
    }

    private fun luminance(colour: Color): Double =
        0.2126 * channel(colour.red) + 0.7152 * channel(colour.green) + 0.0722 * channel(colour.blue)

    private fun contrast(a: Color, b: Color): Double {
        val one = luminance(a)
        val other = luminance(b)
        return (max(one, other) + 0.05) / (min(one, other) + 0.05)
    }

    @Test
    fun navigationLabelsAndGlyphsStayLegibleInBothModes() {
        listOf(GymSkin.Instrument, GymSkin.Daylight).forEach { skin ->
            assertTrue("selected label", contrast(skin.ink, skin.surface) >= 4.5)
            assertTrue("unselected label", contrast(skin.inkDim, skin.surface) >= 4.5)
            assertTrue("selected icon", contrast(skin.accent, skin.raised) >= 3.0)
            assertTrue("unselected icon", contrast(skin.inkDim, skin.surface) >= 3.0)
        }
    }

    // 00.7: at 320 dp a label keeps every letter at 200 % text; The log wraps at its space and only there. Each label's
    // ink stays inside the rail and clear of its neighbours.
    @Test
    fun labelsStayWholeAtTheNarrowestWidthAndTheLargestText() {
        var fontScale by mutableFloatStateOf(2f)
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f, fontScale)) {
                GymMaterial { Box(Modifier.testTag("Rail")) { TabRail(current = Tab.Log, recoveryCount = 0, onPick = {}) } }
            }
        }
        fun lines(): List<List<String>> {
            val rail = compose.onNodeWithTag("Rail").fetchSemanticsNode().boundsInRoot
            val labels = Tab.entries.map { tab ->
                val node = compose.onNodeWithText(tab.title, useUnmergedTree = true).fetchSemanticsNode()
                val layouts = mutableListOf<TextLayoutResult>()
                node.config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
                val layout = layouts.single()
                assertTrue("${tab.title} is never cut", !layout.hasVisualOverflow)
                val lineIndices = 0 until layout.lineCount
                val ink = Rect(node.boundsInRoot.left + lineIndices.minOf(layout::getLineLeft), node.boundsInRoot.top,
                    node.boundsInRoot.left + lineIndices.maxOf(layout::getLineRight), node.boundsInRoot.top + layout.size.height)
                assertTrue("${tab.title} at $ink leaves the rail at $rail",
                    ink.left >= rail.left && ink.right <= rail.right && ink.top >= rail.top && ink.bottom <= rail.bottom)
                ink to lineIndices.map { layout.layoutInput.text.text.substring(layout.getLineStart(it), layout.getLineEnd(it)) }
            }
            labels.zipWithNext().forEach { (one, next) ->
                assertTrue("${one.second} at ${one.first} crowds ${next.second} at ${next.first}", one.first.right <= next.first.left)
            }
            return labels.map { it.second }
        }
        assertEquals(listOf(listOf("Routines"), listOf("The ", "log"), listOf("Coach")), lines())
        compose.runOnIdle { fontScale = 1f }
        assertEquals(listOf(listOf("Routines"), listOf("The log"), listOf("Coach")), lines())
    }

    @Test
    fun aLabelWrapsOnlyWhereItWouldCrowdANeighbourOrLeaveTheBar() {
        assertEquals("all fit", listOf(50f, 40f, 30f),
            RailLabels.widths(pitch = 100f, edge = 60f, gap = 8f, line = listOf(50f, 40f, 30f), word = listOf(50f, 20f, 30f)))
        assertEquals("the crowded neighbour that can wrap does", listOf(102f, 40f, 70f),
            RailLabels.widths(pitch = 101f, edge = 58f, gap = 8f, line = listOf(102f, 88f, 70f), word = listOf(102f, 40f, 70f)))
        assertEquals("of two that can wrap, the wider", listOf(70f, 30f),
            RailLabels.widths(pitch = 80f, edge = 100f, gap = 8f, line = listOf(70f, 90f), word = listOf(30f, 30f)))
        assertEquals("a label past the bar's edge wraps", listOf(40f, 10f),
            RailLabels.widths(pitch = 200f, edge = 30f, gap = 8f, line = listOf(80f, 10f), word = listOf(40f, 10f)))
        assertEquals("a single word is never broken, even crowded", listOf(120f, 120f),
            RailLabels.widths(pitch = 100f, edge = 70f, gap = 8f, line = listOf(120f, 120f), word = listOf(120f, 120f)))
    }
}
