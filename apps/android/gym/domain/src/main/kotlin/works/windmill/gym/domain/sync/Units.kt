package works.windmill.gym.domain.sync

import kotlin.math.abs
import works.windmill.sync.core.Quantum

enum class GymUnits {
    kg, lb;

    fun display(kilograms: Double): Double = if (this == lb) Quantum(0.1).rounded(kilograms / kilogramsPerPound) else kilograms
    fun kilograms(displayed: Double): Double = Quantum(0.01).rounded(if (this == lb) displayed * kilogramsPerPound else displayed)

    companion object {
        const val kilogramsPerPound = 0.45359237
        fun reading(value: String?): GymUnits = if (value == "lb") lb else kg
    }
}

object WeightLadder {
    data class Steps(val small: Double, val large: Double)

    fun steps(magnitude: Double, lightening: Boolean = false): Steps {
        if (if (lightening) magnitude <= 20 else magnitude < 20) return Steps(1.0, 2.5)
        if (if (lightening) magnitude <= 50 else magnitude < 50) return Steps(2.5, 5.0)
        return Steps(2.5, 10.0)
    }

    fun round(weight: Double): Double = Quantum(0.01).rounded(weight)
    fun onGrid(weight: Double): Double {
        val step = steps(abs(weight)).small
        val magnitude = Quantum.halfAway(abs(weight) / step) * step
        return round(if (weight < 0) -magnitude else magnitude)
    }
    fun bump(weight: Double, direction: Int, big: Boolean = false): Double {
        val step = steps(abs(weight), direction * weight < 0)
        return round(weight + direction * if (big) step.large else step.small)
    }
    fun labels(weight: Double): List<String> {
        val down = steps(abs(weight), weight > 0)
        val up = steps(abs(weight), weight < 0)
        return listOf("−${Readout.weight(down.large)}", "−${Readout.weight(down.small)}", "+${Readout.weight(up.small)}", "+${Readout.weight(up.large)}")
    }
    fun bumpReps(reps: Int, direction: Int): Int {
        if (direction < 0) return if (reps <= 1) 1 else reps - 1
        return if (reps == Int.MAX_VALUE) reps else maxOf(1, reps + 1)
    }
}
