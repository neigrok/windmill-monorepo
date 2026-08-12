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
// THE ANSWER IS THE CONTRACT AND THE SENTENCE IS OURS. packages/api-contract/gym-plate-readout.json
// pins which of five answers comes back — loaded, bare, underBar, unloadable, none — for 22 racks,
// and PlatesTests runs every one of them out of the repo's own file. Three languages wrote this rule
// independently in one wave and disagreed on two edges inside the week; both edges were ruled in
// that file's README, and both of them cost THIS copy a defect. What stays ours is the line: each
// surface spells a number its own way and prints its own grammar.
//
// A BAR OF ZERO SAYS NOTHING AT ALL — the first ruling, and the one this copy lost. A machine or a
// pair of dumbbells is a lifter telling us there is no bar, so there is no sentence about one, and a
// per-side decomposition would claim a symmetry the equipment may not have. This copy used to answer
// a machine with plates, which reads plausibly and is a guess about somebody's gym.
//
// UNDER THE BAR IT SAYS SO — the second, and the one this copy lost the other way. Silence there
// left a lifter wondering where the plate list went; `lighter than the 20 kg bar` is true and it
// explains the absence. Below zero is a different question and stays silent: a band-assisted −20 is
// not a bar being loaded at all, and neither is a bodyweight zero.
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

    // The golden's `underBar`. Naming the bar is what makes the line worth printing: "lighter than
    // the 20 kg bar" both states the fact and accounts for the plate list that is not there.
    data class UnderBar(val barKg: Double) : PlateReadout {
        override val line: String
            get() = "lighter than the ${Readout.weight(barKg)} kg bar"
    }

    data class Loaded(val barKg: Double, val perSide: List<Plates.Stack>) : PlateReadout {
        // The design's own grammar: the bar bare, then the per-side plates heaviest first, then the
        // suffix that says which they are. `·2` appears only where a plate repeats, so the ordinary
        // line reads as a list rather than as a multiplication table.
        override val line: String
            get() = (listOf(Readout.weight(barKg)) + perSide.map { it.term })
                .joinToString(" + ") + " per side"
    }

    // BELOW IS ALWAYS THERE, ABOVE IS NOT. Every readout that reaches this far has a bar — a machine
    // says nothing at all — and the bare bar is a load every rack makes, so there is no such thing
    // as a target with nothing loadable under it. The ceiling is the one that goes missing: a gym
    // simply owns nothing heavier, and then the line names one neighbour instead of two.
    data class Unloadable(val targetKg: Double, val belowKg: Double, val aboveKg: Double?) : PlateReadout {
        override val line: String
            get() {
                val head = "these plates don’t make ${Readout.weight(targetKg)}"
                val below = Readout.weight(belowKg)
                val above = aboveKg ?: return "$head · $below is the nearest"
                return "$head · $below or ${Readout.weight(above)}"
            }
    }
}

object Plates {
    data class Stack(val kg: Double, val count: Int) {
        val term: String get() = if (count == 1) Readout.weight(kg) else "${Readout.weight(kg)}·$count"
    }

    // The golden's `capKg`, in the hundredths this file counts in — typed here and pinned there by
    // PlatesTests, exactly as Ladder.kt's band table is. It bounds the TOTAL and not the load, which
    // is the number every case in the golden is keyed by. Nobody past a tonne is reading a plate
    // list, and the keypad stops at 500 long before it, so this is the belt behind that rule rather
    // than a second opinion on it — and it is also what keeps the search below a table nobody wants
    // allocated on a phone.
    private const val capCents = 100_000L

    private const val unreachable = Int.MAX_VALUE

    // The band the STORE says a plate lives in, read from the store rather than typed again here:
    // anything wider is not a plate this rack holds, and it would index the search out of bounds.
    private val maxPlateCents = cents(GymPreferences.maxPlateKg)

    // The whole readout, or nothing to say. Since `UnderBar` exists, null is exactly ONE thing —
    // the golden's `none` — and no longer the two different silences that hid a defect for a wave.
    fun readout(totalKg: Double, preferences: GymPreferences): PlateReadout? {
        // A number that is not a number has no plate answer. This is the guard, not a rounding
        // rule: `cents` rounds, and rounding is exactly what NaN and an infinity break.
        if (!totalKg.isFinite() || !preferences.barWeightKg.isFinite()) return null
        val bar = cents(preferences.barWeightKg)
        val target = cents(totalKg)
        // Nothing true to say, three ways. Nothing is being loaded at all (a bodyweight zero, or a
        // band taking weight off below it); there is no bar to load, which is the lifter's own
        // statement and not a gap in ours; or the number is past the cap, where no plate list helps.
        if (target <= 0L || bar <= 0L || target > capCents) return null
        if (target < bar) return PlateReadout.UnderBar(preferences.barWeightKg)
        val load = target - bar
        if (load == 0L) return PlateReadout.JustTheBar

        // Finite, real, and inside the store's own band. `normalized()` keeps every document there,
        // so this is the belt for one rehydrated off disk or arriving from a future server — a plate
        // wider than the search would index the table out of bounds and take the logger down mid-set.
        val plates = preferences.platesKg
            .filter { it.isFinite() }
            .map { cents(it) }
            .filter { it > 0L && it <= maxPlateCents }
            .map { it.toInt() }
            .distinct()
            .sortedDescending()
        val floor = (load / 2).toInt()
        val heaviest = plates.firstOrNull() ?: 0
        val reach = Reach(plates, cap = floor + heaviest + 1)

        // An odd number of hundredths cannot be halved onto two sides at all, so an exact answer is
        // only ever asked for when the load divides evenly.
        if (load % 2 == 0L && reach.made(floor)) {
            return PlateReadout.Loaded(preferences.barWeightKg, reach.stacked(floor))
        }
        // An empty side is always reachable and there is always a bar holding it, so the walk down
        // always answers and the bare bar is the worst it can do. Where the load divides evenly the
        // floor itself was just refused and the search starts under it — never below zero, since an
        // even load that got this far is at least two hundredths. Where it does not divide, no side
        // makes the target at all and the floor is itself the load below.
        val belowFrom = if (load % 2 == 0L) floor - 1 else floor
        val below = (belowFrom downTo 0).first { reach.made(it) }
        val above = ((floor + 1)..reach.cap).firstOrNull { reach.made(it) }
        return PlateReadout.Unloadable(
            targetKg = target / 100.0,
            belowKg = (bar + 2L * below) / 100.0,
            aboveKg = above?.let { (bar + 2L * it) / 100.0 },
        )
    }

    // What one side of the bar can be built from, with the FEWEST plates — which is the objective a
    // lifter actually has, and the reason this is a table rather than a greedy walk down the rack.
    // Greedy is wrong on real gyms: a rack of 15s and 20s makes 45 as three 15s, and greedy takes
    // two 20s and strands 5.
    private class Reach(plates: List<Int>, val cap: Int) {
        private val steps = IntArray(cap + 1) { unreachable }
        private val chose = IntArray(cap + 1)

        init {
            steps[0] = 0
            for (side in 1..cap) {
                for (plate in plates) {
                    val from = side - plate
                    if (from < 0 || steps[from] == unreachable) continue
                    if (steps[from] + 1 >= steps[side]) continue
                    steps[side] = steps[from] + 1
                    chose[side] = plate
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
