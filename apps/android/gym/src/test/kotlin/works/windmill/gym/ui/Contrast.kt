package works.windmill.gym.ui

import androidx.compose.ui.graphics.Color
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

internal fun contrast(a: Color, b: Color): Double {
    val (one, other) = listOf(a, b).map { colour ->
        val (red, green, blue) = listOf(colour.red, colour.green, colour.blue).map channel@{ part ->
            val value = part.toDouble()
            if (value <= 0.03928) return@channel value / 12.92
            ((value + 0.055) / 1.055).pow(2.4)
        }
        0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
    return (max(one, other) + 0.05) / (min(one, other) + 0.05)
}
