package works.windmill.gym.domain

import kotlin.math.roundToLong

// WHAT WOULD ACTUALLY GO ON THE BAR — §K's line under the numeral, and the one thing in gym that
// reads the lifter's own rack. `20 + 25 + 15 + 2.5 per side` is a fact about their gym; a bare
// numeral is a fact about arithmetic, and a lifter standing at a rack needs the first one.
//
// THE LADDER DOES NOT READ THIS, and that is the wave's ruling rather than an omission. §I said the
// fine step and this readout both came from plate math; §K fixes the step as a band table read off
// the load, and packages/api-contract/gym-ladder.json pins that table across three languages. A
// step that depended on a lifter's inventory could not be pinned that way, and the drift gate has
// already caught two real defects. So the truth about what can be loaded lives HERE, in a readout
// that says it out loud, rather than in buttons that quietly refuse to offer a weight. A button
// that hid 102.5 would be a product deciding what a lifter is allowed to lift; a line that says
// "these plates don't make 102.5 · 100 or 105" is a product telling them something true — and the
// tap still logs, because they might be at a different gym today.
//
// IT SPEAKS ONLY AT OR ABOVE THE BAR. Under it there is no bar being loaded — a fixed barbell, a
// dumbbell, a band-assisted −20 — so the line is absent rather than lecturing about a rack nobody
// is standing at. A bar of 0 (a machine, a pair of dumbbells) is legal and simply drops the bar
// term; everything from zero up is then plates. It also takes the FLOOR away with it: with a bar
// there is always one load every rack makes and it is the bare bar, and with no bar there is not —
// zero kilograms is not something anybody lifts, and naming it as the nearest load would be the
// false statement this readout exists to avoid.
//
// THE ARITHMETIC IS IN WHOLE HUNDREDTHS OF A KILOGRAM, never in doubles: `platesKg` is one SIDE and
// the ladder's number is the TOTAL, so every answer is a halving, and a halving on binary doubles
// is where 42.5 becomes 42.499999999999996 and a loadable weight reads as unloadable.
//
// AND NOTHING HERE THROWS ON A WEIGHT REHYDRATED FROM STORAGE, which is the law Ladder.kt states
// for the same numbers. The logger's prefill puts a stored weight through this on the frame it
// draws, so a value that is not a number answers with silence rather than with an exception in the
// middle of somebody's set.

sealed interface PlateReadout {
    val line: String

    data object JustTheBar : PlateReadout {
        override val line = "just the bar"
    }

    data class Loaded(val barKg: Double, val perSide: List<Plates.Stack>) : PlateReadout {
        // The design's own grammar: the bar bare, then the per-side plates heaviest first, then the
        // suffix that says which they are. `·2` appears only where a plate repeats, so the ordinary
        // line reads as a list rather than as a multiplication table.
        override val line: String
            get() {
                val terms = perSide.map { it.term }
                val head = if (barKg > 0) listOf(Readout.weight(barKg)) + terms else terms
                return head.joinToString(" + ") + " per side"
            }
    }

    // EITHER NEIGHBOUR CAN BE MISSING, and which one depends on the bar. `above` goes when the gym
    // simply owns nothing heavier. `below` goes only where there is no bar: with one, the bare bar
    // is a load every rack makes, and without one there is no floor at all — the lightest thing a
    // plateless machine makes is the lightest PLATE, and under that there is nothing honest to
    // name. Both missing is a rack that makes no load whatever, and then there is no line: the
    // factory answers null rather than minting one, and the head alone is what this type says if
    // it is ever built by hand.
    data class Unloadable(val targetKg: Double, val belowKg: Double?, val aboveKg: Double?) : PlateReadout {
        override val line: String
            get() {
                val head = "these plates don’t make ${Readout.weight(targetKg)}"
                val near = listOfNotNull(belowKg, aboveKg).map { Readout.weight(it) }
                if (near.size == 2) return "$head · ${near[0]} or ${near[1]}"
                val only = near.firstOrNull() ?: return head
                return "$head · $only is the nearest"
            }
    }
}

object Plates {
    data class Stack(val kg: Double, val count: Int) {
        val term: String get() = if (count == 1) Readout.weight(kg) else "${Readout.weight(kg)}·$count"
    }

    // The heaviest side this answers about at all. The keypad already refuses over 500 kg, so this
    // is the belt behind that rule rather than a second opinion on it — and it is what keeps the
    // search below a table nobody wants allocated on a phone.
    private const val maxPerSideCents = 30_000L

    private const val unreachable = Int.MAX_VALUE

    // The whole readout, or nothing to say. Nothing is a real answer here: silence beats a sentence
    // about a bar the lifter is not standing at.
    fun readout(totalKg: Double, preferences: GymPreferences): PlateReadout? {
        // A number that is not a number has no plate answer. This is the guard, not a rounding
        // rule: `cents` rounds, and rounding is exactly what NaN and an infinity break.
        if (!totalKg.isFinite() || !preferences.barWeightKg.isFinite()) return null
        val bar = cents(preferences.barWeightKg)
        val target = cents(totalKg)
        if (target < bar) return null
        val load = target - bar
        if (load == 0L) {
            if (bar == 0L) return null
            return PlateReadout.JustTheBar
        }

        // Finite, real, and inside the table's own ceiling. The band `normalized()` enforces is 0.01
        // to 100 kg, so nothing that arrived through a screen or the wire is touched here — this is
        // the belt for a document rehydrated off disk, where a plate wider than the search would
        // index the table out of bounds and take the logger down mid-set.
        val plates = preferences.platesKg
            .filter { it.isFinite() }
            .map { cents(it) }
            .filter { it > 0 && it <= maxPerSideCents }
            .distinct()
            .sortedDescending()
        val floor = (load / 2).toInt()
        if (floor > maxPerSideCents) return null
        val heaviest = plates.firstOrNull()?.toInt() ?: 0
        val reach = Reach(plates, cap = floor + heaviest + 1)

        // An odd number of hundredths cannot be halved onto two sides at all, so an exact answer is
        // only ever asked for when the load divides evenly.
        if (load % 2 == 0L && reach.made(floor)) {
            return PlateReadout.Loaded(preferences.barWeightKg, reach.stacked(floor))
        }
        // An empty side is a real load only while there is a bar holding it up. On a machine or a
        // pair of dumbbells the search stops at the lightest plate, and a target under that has no
        // neighbour below to name — `0 kg` is not a load and printing it would be the readout
        // lying about the physical world on the screen a lifter reads at the rack.
        val emptySide = if (bar > 0L) 0 else 1
        val belowFrom = if (load % 2 == 0L) floor - 1 else floor
        val below = (belowFrom downTo emptySide).firstOrNull { reach.made(it) }
        val above = ((floor + 1)..reach.cap).firstOrNull { reach.made(it) }
        if (below == null && above == null) return null
        return PlateReadout.Unloadable(
            targetKg = target / 100.0,
            belowKg = below?.let { (bar + 2L * it) / 100.0 },
            aboveKg = above?.let { (bar + 2L * it) / 100.0 },
        )
    }

    // What one side of the bar can be built from, with the FEWEST plates — which is the objective a
    // lifter actually has, and the reason this is a table rather than a greedy walk down the rack.
    // Greedy is wrong on real gyms: a rack of 15s and 20s makes 45 as three 15s, and greedy takes
    // two 20s and strands 5.
    private class Reach(plates: List<Long>, val cap: Int) {
        private val steps = IntArray(cap + 1) { unreachable }
        private val chose = IntArray(cap + 1)

        init {
            steps[0] = 0
            for (side in 1..cap) {
                for (plate in plates) {
                    val from = side - plate.toInt()
                    if (from < 0 || steps[from] == unreachable) continue
                    if (steps[from] + 1 >= steps[side]) continue
                    steps[side] = steps[from] + 1
                    chose[side] = plate.toInt()
                }
            }
        }

        fun made(side: Int): Boolean = side in steps.indices && steps[side] != unreachable

        fun stacked(side: Int): List<Stack> {
            val counts = mutableMapOf<Int, Int>()
            var left = side
            while (left > 0) {
                val plate = chose[left]
                counts[plate] = (counts[plate] ?: 0) + 1
                left -= plate
            }
            return counts.entries.sortedByDescending { it.key }.map { Stack(it.key / 100.0, it.value) }
        }
    }

    // Onto the ladder's own 0.01 grid first and into whole hundredths second, so a weight that
    // arrived from storage, from a keypad or from a plate chip all round the one way this product
    // rounds. Rounding twice is what stops 2.5 arriving as 249 hundredths.
    private fun cents(kg: Double): Long = (Ladder.round(kg) * 100.0).roundToLong()
}
