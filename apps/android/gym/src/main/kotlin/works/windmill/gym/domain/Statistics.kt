package works.windmill.gym.domain

import kotlin.math.max

// STATISTICS — the one rule that turns `GET /v1/gym/stats` into something a phone can draw. The
// wire shape itself lives in Training.kt (StatWeek, StatPoint, StatMovement, TrainingStatistics);
// this is the native twin of backend/products/gym/domain/Statistics.h, and its list of REFUSALS is
// the load-bearing half:
//
//   · no volume, anywhere. Band-assisted work logs a negative load, so `weight × reps` falls as a
//     lifter gets stronger, and four light sets outrank three heavy ones.
//   · no muscle groups and no taxonomy for one. Pattern is the only classification gym has and it is
//     single-valued on purpose; a bench set counted into chest AND triceps is the bug the schema was
//     written against.
//   · no streak, no cardio, no duration axis, and nothing here is a grade — no score, no percentage,
//     nothing green and nothing red. Every line below is a fact with a direction, which is the finish
//     screen's rule applied to a longer window.
//
// Nothing in this file computes a number the server did not already decide. Epley lives in one place
// per language and this is not it: an estimate arrives with the point or is absent from it.

// THE BOARD — everything the statistics screen draws, decided once, outside a composable body. The
// banked rule this obeys is Lift's: a trend computed inside a landing screen's body is recomputed on
// every keystroke elsewhere in the app, and a cache keyed on a collection's LENGTH goes stale the
// day a session is edited rather than added. There is no cache here at all — the screen asks the
// log, this shapes the answer once, and a second visit asks again.
object Stats {
    // One row of bars, normalised to ITS OWN peak and never to a shared axis: sessions and working
    // sets are counts of different things, and one axis across both is the chart that made Lift's
    // progress tab unreadable. The peak travels with the row because a phone has no hover and no
    // scrub — without it a bar's height means nothing at all.
    data class Series(
        val label: String,
        val peak: String,
        val heights: List<Double>,      // 0…1, one per week, oldest first
    )

    data class Weeks(val sets: Series, val sessions: Series, val span: String)

    // WHICH AXIS A MOVEMENT'S LINE IS DRAWN ON, decided by the data and never by a setting — the
    // native statement of stats.js `axisOf`/`valueOf`, tested in the order the web tests it. Three
    // cases, and the third is the one a chin-up needs:
    //   · every point carries an estimate — the line is e1RM, the movement's own strength curve
    //   · an estimate is missing somewhere but the load MOVES — the line is the top set's load, the
    //     honest axis across the assisted → bodyweight → weighted crossing that left Epley undefined
    //   · the load never moves — then the load is not the story and the reps are. A point is already
    //     the heaviest set of its session, ties going to more reps, so at one fixed load the top set
    //     IS the best set of reps at it, and drawing the load would be drawing a constant.
    internal enum class Axis {
        E1rm, Load, Reps;

        val unit: String
            get() = when (this) {
                E1rm -> "e1RM"
                Load -> "load"
                Reps -> "reps"
            }

        // The estimate cannot be missing on the axis that was chosen BY every point having one, so
        // the fallback is unreachable — and a zero there would be a number nobody lifted rather than
        // a crash on the statistics screen.
        fun value(point: StatPoint): Double = when (this) {
            E1rm -> point.e1rm ?: 0.0
            Load -> point.weightKg
            Reps -> point.reps.toDouble()
        }

        companion object {
            fun of(points: List<StatPoint>): Axis {
                if (points.isNotEmpty() && points.all { it.e1rm != null }) return E1rm
                if (points.map { it.weightKg }.toSet().size > 1) return Load
                return Reps
            }
        }
    }

    // One movement's line. `unit` names which of the three the axis picked, because they are not the
    // same fact and a reader who is not told reads a chin-up's 8 → 12 as kilograms.
    data class Line(
        val id: String,
        val movement: String,
        val value: String,
        val unit: String,
        val lastTrained: String,
        val heights: List<Double>,      // 0…1, oldest first
        val span: String,
        val bests: List<String>,
    )

    data class Board(val weeks: Weeks?, val lines: List<Line>) {
        val isEmpty: Boolean get() = weeks == null && lines.isEmpty()
    }

    // Twelve weeks is what fits across a phone as bars a thumb-width apart. The window is taken off
    // the END of the series — the recent weeks are the ones a lifter is asking about — and the span
    // line prints the two dates it landed on rather than claiming a period.
    const val weeksShown = 12

    fun board(statistics: TrainingStatistics, catalog: List<Exercise>,
              now: Long, weeksShown: Int = Stats.weeksShown): Board =
        Board(weeks = weeks(statistics.weeks, showing = weeksShown),
              lines = statistics.movements.mapNotNull { line(it, catalog, now) })

    internal fun weeks(weeks: List<StatWeek>, showing: Int): Weeks? {
        val shown = weeks.takeLast(max(0, showing))
        val first = shown.firstOrNull() ?: return null
        val last = shown.last()
        return Weeks(
            sets = series("Working sets", shown.map { it.workingSets }),
            sessions = series("Sessions", shown.map { it.sessions }),
            span = if (shown.size == 1)
                "1 week · ${Readout.day(first.startedAtMs, utc = true)}"
            else
                "${shown.size} weeks · ${Readout.day(first.startedAtMs, utc = true)} → ${Readout.day(last.startedAtMs, utc = true)}"
        )
    }

    // Bars are counts, so they are measured FROM ZERO — a bar chart on a floating baseline overstates
    // every difference on it. A week with nothing in it draws no bar at all, which is what makes a
    // gap read as a gap against the baseline rule under the row.
    private fun series(label: String, values: List<Int>): Series {
        val peak = values.maxOrNull() ?: 0
        if (peak <= 0) return Series(label = label, peak = "peak 0", heights = values.map { 0.0 })
        return Series(label = label, peak = "peak $peak",
                      heights = values.map { it.toDouble() / peak })
    }

    internal fun line(movement: StatMovement, catalog: List<Exercise>, now: Long): Line? {
        // The server builds a movement out of its points, so one with none cannot arrive. A line with
        // nothing to draw is left out rather than drawn as an empty frame with a name over it.
        if (movement.points.isEmpty()) return null
        val axis = Axis.of(movement.points)
        val values = movement.points.map { axis.value(it) }

        return Line(
            id = movement.exerciseId,
            movement = Readout.movement(movement.exerciseId, catalog),
            value = Readout.weight(values.last()),
            unit = axis.unit,
            lastTrained = "trained ${Readout.ago(movement.lastTrainedAtMs ?: 0, now)}",
            heights = normalised(values),
            span = span(values),
            bests = bests(movement.bestE1rm, movement.heaviest)
        )
    }

    // A LINE is normalised to its own min and max, where a bar row is normalised from zero: a
    // progression from 82.5 to 96.9 drawn against a zero baseline is a flat line, and the whole
    // content of a sparkline is the shape. A movement that has never moved is honestly flat, drawn
    // down the middle rather than pinned to one edge by a divide-by-nothing.
    private fun normalised(values: List<Double>): List<Double> {
        val low = values.minOrNull() ?: return emptyList()
        val high = values.max()
        if (high <= low) return values.map { 0.5 }
        return values.map { (it - low) / (high - low) }
    }

    // The two endpoints, which is everything a sparkline says on a surface with no hover — and a
    // direction rather than a delta, because a delta is one subtraction away from a score.
    private fun span(values: List<Double>): String {
        val count = Readout.sessionCount(values.size)
        if (values.size <= 1) return "$count · ${Readout.weight(values[0])}"
        return "$count · ${Readout.weight(values[0])} → ${Readout.weight(values.last())}"
    }

    // ONE SET OFTEN HOLDS BOTH MARKS — a lifter adding 2.5 kg a week tops their estimate and their
    // load on the same set every time — so the common case is one line and not two saying the same
    // day twice. A zero load is not a load: a chin-up's best reads as its reps, which is the finish
    // screen's own rule about the absence of a weight.
    private fun bests(bestE1rm: StatPoint?, heaviest: StatPoint?): List<String> {
        val estimate = bestE1rm?.e1rm
        if (bestE1rm != null && estimate != null && heaviest != null && sameSet(bestE1rm, heaviest)) {
            return listOf("best ${effort(bestE1rm)} · e1RM ${Readout.weight(estimate)} kg · ${Readout.day(bestE1rm.atMs)}")
        }
        val lines = mutableListOf<String>()
        if (bestE1rm != null && estimate != null) {
            lines.add("best e1RM ${Readout.weight(estimate)} kg · ${effort(bestE1rm)} · ${Readout.day(bestE1rm.atMs)}")
        }
        if (heaviest != null) {
            lines.add("heaviest ${effort(heaviest)} · ${Readout.day(heaviest.atMs)}")
        }
        return lines
    }

    private fun sameSet(left: StatPoint, right: StatPoint): Boolean =
        left.weightKg == right.weightKg && left.reps == right.reps && left.atMs == right.atMs

    private fun effort(best: StatPoint): String {
        if (best.weightKg == 0.0) return "${best.reps} reps"
        return Readout.effort(best.weightKg, best.reps)
    }
}
