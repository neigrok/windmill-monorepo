package works.windmill.gym.domain

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sign

// One of three copies of this rule (apps/ios Ladder.swift, web/.../logger/ladder.js), pinned by
// packages/api-contract/gym-ladder.json — every copy reads that file as a test. Bands are read off the
// MAGNITUDE, and the step buttons do not clamp; only typed entry is bounded.

object Ladder {
    data class Band(val under: Double?, val small: Double, val large: Double)

    data class Steps(val small: Double, val large: Double)

    val bands = listOf(
        Band(under = 20.0, small = 1.0, large = 2.5),
        Band(under = 50.0, small = 2.5, large = 5.0),
        Band(under = null, small = 2.5, large = 10.0),
    )

    // A move that lightens reads the band just below the magnitude (`<` tightens to `<=`).
    fun steps(magnitude: Double, lightening: Boolean): Steps {
        // The open top band (`under: null`) answers true without comparing, so NaN lands there.
        val band = bands.firstOrNull { band ->
            val under = band.under ?: return@firstOrNull true
            if (lightening) magnitude <= under else magnitude < under
        } ?: bands.last()
        return Steps(band.small, band.large)
    }

    // Half away from zero, so round(−x) == −round(x).
    fun round(weight: Double): Double {
        val hundredths = floor(abs(weight) * 100.0 + 0.5)
        return (hundredths / 100.0) * sign(weight)
    }

    fun bump(weight: Double, direction: Int, big: Boolean): Double {
        val step = steps(abs(weight), lightening = direction * weight < 0)
        return round(weight + direction * (if (big) step.large else step.small))
    }

    fun labels(weight: Double): List<String> {
        val down = steps(abs(weight), lightening = weight > 0)
        val up = steps(abs(weight), lightening = weight < 0)
        return listOf("−${text(down.large)}", "−${text(down.small)}", "+${text(up.small)}", "+${text(up.large)}")
    }

    // The band is read the way a lift reads it (`<`): where the weight stands, not what the down key does.
    fun tier(weight: Double): String {
        val magnitude = abs(weight)
        val index = bands.indices.first { at ->
            val under = bands[at].under ?: return@first true
            magnitude < under
        }
        val band = bands[index]
        val where = when (index) {
            0 -> "under ${text(band.under ?: 0.0)} kg"
            bands.size - 1 -> "over ${text(bands[index - 1].under ?: 0.0)} kg"
            else -> "${text(bands[index - 1].under ?: 0.0)}–${text(band.under ?: 0.0)} kg"
        }
        return "$where · fine ${text(band.small)} · plate ${text(band.large)}"
    }

    // Steps print bare: "−5" and "+10", never "−5.0". The minus is U+2212, the plus ASCII.
    internal fun text(step: Double): String {
        if (step == floor(step)) return step.toInt().toString()
        return step.toString()
    }

    // Reps floor at 1: the backend refuses reps < 1, and the clamp is INTO the range.
    fun bumpReps(reps: Int, direction: Int): Int {
        if (direction < 0) return max(1, reps - 1)
        return reps + 1
    }
}
