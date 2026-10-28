package works.windmill.gym.domain

import kotlin.math.floor

object NumberEntry {
    enum class Field { Load, Reps }

    const val onePoint = "One decimal point only."
    const val notANumber = "That is not a number yet."
    const val outsideReps = "Whole reps, 1 to ${LoggedSetLimits.maxReps}."
    const val weightHint = "kg"
    const val repsHint = "whole reps"

    data class Reading(val value: Double?, val message: String) {
        val isValid: Boolean get() = value != null
    }

    fun normaliseSign(text: String): String = text.replace('−', '-')

    fun read(text: String, field: Field, keeping: Double): Reading {
        val raw = normaliseSign(text).trim()
        if (raw.isEmpty() || raw == "-") {
            return Reading(null, "Enter a number, or cancel to keep ${Readout.weight(keeping)}")
        }
        val normalised = raw.replace(",", ".")
        if (normalised.count { it == '.' } > 1) return Reading(null, onePoint)
        val value = normalised.toDoubleOrNull()
        if (value == null || !value.isFinite()) return Reading(null, notANumber)
        if (field == Field.Load) {
            return Reading(Ladder.round(value), weightHint)
        }
        if (value < 1 || value > LoggedSetLimits.maxReps || value != floor(value)) {
            return Reading(null, outsideReps)
        }
        return Reading(value, repsHint)
    }
}
