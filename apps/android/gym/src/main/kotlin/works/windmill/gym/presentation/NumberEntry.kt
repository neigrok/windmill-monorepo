package works.windmill.gym.presentation

import kotlin.math.floor
import works.windmill.gym.R
import works.windmill.platform.i18n.Words

object NumberEntry {
    enum class Field { Load, Reps }

    private val onePoint: Words = Words.Message(R.string.gym_entry_one_point)
    private val notANumber: Words = Words.Message(R.string.gym_entry_not_a_number)
    private val outsideReps: Words = Words.Message(R.string.gym_entry_outside_reps, listOf(LoggedSetLimits.maxReps.toString()))
    private val weightHint: Words = Words.Message(R.string.gym_readout_kg)
    private val repsHint: Words = Words.Message(R.string.gym_entry_reps_hint)

    // A load moved under the floor refuses as it is typed; the value it keeps stands, and other refusals wait for a commit.
    data class Reading(val value: Double?, val said: Words, val belowFloor: Boolean = false) {
        val isValid: Boolean get() = value != null
    }

    fun underFloor(floor: Double, keeping: Double): Words =
        Words.Message(R.string.gym_entry_below_floor, listOf(Readout.weight(floor), Readout.weight(keeping)))

    fun read(text: String, field: Field, keeping: Double, floor: Double? = null): Reading {
        val raw = text.replace('−', '-').trim()
        if (raw.isEmpty() || raw == "-") {
            return Reading(null, Words.Message(R.string.gym_entry_empty, listOf(Readout.weight(keeping))))
        }
        val normalised = raw.replace(",", ".")
        if (normalised.count { it == '.' } > 1) return Reading(null, onePoint)
        val value = normalised.toDoubleOrNull()
        if (value == null || !value.isFinite()) return Reading(null, notANumber)
        if (field == Field.Load) {
            val load = Ladder.round(value)
            if (floor != null && load < floor && load != keeping) return Reading(null, underFloor(floor, keeping), belowFloor = true)
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
