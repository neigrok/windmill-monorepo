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
                     4.01, separation, 0.01)
        assertEquals("the accent is what `1v` refused: it separates by half as much",
                     2.37, contrast(GymSkin.accent, GymSkin.inkFaint), 0.01)
        assertTrue("the tint must beat the accent, or `1v` reopens on a token move",
                   separation > contrast(GymSkin.accent, GymSkin.inkFaint))
    }

    @Test
    fun testTheIndicatorIsVisibleAgainstTheBarItSitsOn() {
        val wash = contrast(GymSkin.accentSoft.compositeOver(GymSkin.surface), GymSkin.surface)
        val hairline = contrast(GymSkin.lineStrong, GymSkin.surface)
        assertEquals("the accent wash the indicator sits on, over the bar's own ground", 1.52, wash, 0.01)
        assertEquals("border-default, which the indicator does not use", 1.30, hairline, 0.01)
        assertTrue("the wash must stay the more visible of the two, or the indicator moves back", wash > hairline)
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

// Composited the way the bar is painted: per channel, then quantized to 8 bits.
private fun Color.compositeOver(ground: Color): Color {
    fun channel(top: Float, under: Float) = (top * alpha + under * (1 - alpha)) * 255f
    return Color(
        red = Math.round(channel(red, ground.red)),
        green = Math.round(channel(green, ground.green)),
        blue = Math.round(channel(blue, ground.blue)),
    )
}
