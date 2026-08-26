package works.windmill.gym

import androidx.compose.ui.graphics.Color
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.ui.GymSkin

// Ledger `1v`: the rail may not carry its whole selected state in two colours that barely differ.
// The numbers are measured here rather than asserted in a comment, because a token can move.
class GymRailTests {
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
    fun testTheSelectedTintIsFarEnoughFromTheUnselectedInkToReadAsADifference() {
        val separation = contrast(GymSkin.ink, GymSkin.inkFaint)
        assertEquals("the room's brightest ink against the faint ink — iOS picked the same token",
                     2.91, separation, 0.01)
        assertTrue("the accent is what `1v` refused: 1.17:1 between the two",
                   contrast(GymSkin.accent, GymSkin.inkFaint) < 1.2)
    }

    @Test
    fun testTheIndicatorIsVisibleAgainstTheBarItSitsOn() {
        assertEquals("border-default on the bar's own ground", 1.63,
                     contrast(GymSkin.lineStrong, GymSkin.surface), 0.01)
        assertTrue("the accent wash it replaced read as nothing at all",
                   contrast(GymSkin.accentSoft.compositeOver(GymSkin.surface), GymSkin.surface) < 1.1)
    }

    // Colour is one channel of four; the glyph is a second, and it may not be the same drawing in
    // both states.
    @Test
    fun testEverySeatDrawsADifferentGlyphSelectedAndUnselected() {
        Tab.entries.forEach { tab ->
            assertNotEquals("${tab.title} draws one glyph for both states",
                            railIcon(tab, selected = true).name, railIcon(tab, selected = false).name)
        }
    }
}

private fun Color.compositeOver(ground: Color): Color = Color(
    red = red * alpha + ground.red * (1 - alpha),
    green = green * alpha + ground.green * (1 - alpha),
    blue = blue * alpha + ground.blue * (1 - alpha),
)
