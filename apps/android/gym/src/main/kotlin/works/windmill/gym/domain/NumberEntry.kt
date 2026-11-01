package works.windmill.gym.domain

import kotlin.math.floor

object NumberEntry {
    enum class Field { Load, Reps }

    const val onePoint = "One decimal point only."
    const val notANumber = "That is not a number yet."
    const val outsideReps = "Whole reps, 1 to ${LoggedSetLimits.maxReps}."
    const val weightHint = "kg"
    const val repsHint = "whole reps"

    // A load moved under the floor refuses as it is typed; the value it keeps stands, and other refusals wait for a commit.
    data class Reading(val value: Double?, val message: String, val belowFloor: Boolean = false) {
        val isValid: Boolean get() = value != null
    }

    fun belowFloor(floor: Double, keeping: Double): String =
        "Enter ${Readout.weight(floor)} or more, or cancel to keep ${Readout.weight(keeping)}"

    fun read(text: String, field: Field, keeping: Double, floor: Double? = null): Reading {
        val raw = text.replace('−', '-').trim()
        if (raw.isEmpty() || raw == "-") {
            return Reading(null, "Enter a number, or cancel to keep ${Readout.weight(keeping)}")
        }
        val normalised = raw.replace(",", ".")
        if (normalised.count { it == '.' } > 1) return Reading(null, onePoint)
        val value = normalised.toDoubleOrNull()
        if (value == null || !value.isFinite()) return Reading(null, notANumber)
        if (field == Field.Load) {
            val load = Ladder.round(value)
            if (floor != null && load < floor && load != keeping) return Reading(null, belowFloor(floor, keeping), belowFloor = true)
            return Reading(load, weightHint)
        }
        if (value < 1 || value > LoggedSetLimits.maxReps || value != floor(value)) {
            return Reading(null, outsideReps)
        }
        return Reading(value, repsHint)
    }

    // The ladder never clamps; a load field with a floor stops a step at it, and a load kept from under it
    // only climbs back to it.
    fun bumped(load: Double, direction: Int, big: Boolean, floor: Double?): Double {
        val next = Ladder.bump(load, direction, big)
        if (floor == null || next >= floor) return next
        return if (direction < 0) minOf(load, floor) else floor
    }
}
