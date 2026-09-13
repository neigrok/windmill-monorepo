package works.windmill.gym

import androidx.compose.ui.graphics.Color
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.ui.GymSkin

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
    fun navigationLabelsAndGlyphsStayLegibleInBothModes() {
        listOf(GymSkin.Instrument, GymSkin.Daylight).forEach { skin ->
            assertTrue("selected label", contrast(skin.ink, skin.surface) >= 4.5)
            assertTrue("unselected label", contrast(skin.inkDim, skin.surface) >= 4.5)
            assertTrue("selected icon", contrast(skin.accent, skin.raised) >= 3.0)
            assertTrue("unselected icon", contrast(skin.inkDim, skin.surface) >= 3.0)
        }
    }
}
