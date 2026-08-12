package works.windmill.gym.domain

// A MOVEMENT'S RECORD — the one rule that turns `GET /v1/gym/exercises/:id/record` into the page
// §H draws. The wire shape itself lives in Training.kt; this decides what is drawn, once and
// outside a composable body, and it computes no number the log did not already decide.
//
// TWO ABSENCES DO ALL THE WORK HERE, and neither of them is a zero:
//
//   · Epley is undefined at or below zero load, so a bodyweight or band-assisted movement has NO
//     e1RM — no best tile, no chart, no personal records. It draws its heaviest set and its sets,
//     which is everything true about it, rather than a dash inside a chart frame.
//   · a movement in the catalog nobody has lifted has no history at all, and says so in one line
//     rather than drawing empty furniture with a name over it. The picker calls the same state
//     `never logged`, and this page has to agree with it.
//
// The two are told apart by the load: an estimate missing over a load Epley CAN speak for is this
// device's own silence, not the movement's — it is the anonymous log, whose marks are composed
// here by `MovementRecord.of` and carry no estimate. Collapsing the two into one blank would be
// the room reporting a fact about its account as a fact about the lifter's training.
//
// NOT A DASHBOARD: no volume by muscle group, no fatigue score, no percentile against strangers.
// One movement, one number, one arc. The weekly session and working-set bars that stood on the
// retired statistics screen are deliberately not here either — §H gives them no home, and they
// went with the room they belonged to.
object Record {
    // The server's window, restated so the caption can name it — `kRecordWindowMs`, twelve weeks,
    // the same way `Review.slightWorkingSets` restates `kSlightWorkingSets`.
    const val windowWeeks = 12

    // The label is a fact about the tile and the caption is the set that made it. `loud` is the
    // one gold thing on this page: a standing best is a KIND of moment, and at most one of them is
    // ever drawn.
    data class Tile(val label: String, val value: String, val caption: String, val loud: Boolean)

    // One session, one bar, and the height is a fraction of the STANDING BEST — the number the tile
    // above the chart prints. Bars are measured FROM ZERO, which is the same rule the room applied
    // to a count: a bar on a floating baseline overstates every difference on it, and an eighteen
    // per cent climb has to read as eighteen per cent. A sparkline may be normalised to its own
    // range because the shape is its whole content; a bar cannot, because its height is a claim
    // about a quantity — and that cuts at the top of the scale as well as the bottom (see `chart`).
    data class Bar(val height: Double, val standingBest: Boolean)

    // The two ends of the axis, printed rather than reachable: this surface has no hover and no
    // scrub, and a value a gesture the phone does not have would reveal is a decoration. `to` is
    // ABSENT where both ends spell the same day — an axis with one point on it is a point, and a
    // date printed twice would dress a single session as a span.
    //
    // §H's mock tiers its bars three ways. This draws TWO — ordinary, and the one that holds the
    // standing best — because the third tier would need a legend the chart has no room for, and
    // the Personal records list directly beneath it already enumerates every record with its date.
    data class Chart(val bars: List<Bar>, val window: String, val from: String, val to: String?)

    // A record row: what was lifted, what it estimates to, and when. `standing` is the one still
    // holding — the mark every later session is measured against.
    data class Best(val effort: String, val estimate: String, val day: String, val standing: Boolean)

    data class Day(val day: String, val sets: String)

    data class Page(
        val name: String,
        val subhead: String,
        val tiles: List<Tile>,
        val chart: Chart?,
        val records: List<Best>,
        val days: List<Day>,
        val nothingYet: String?,
        val noEstimate: String?,
    )

    fun page(record: MovementRecord, now: Long): Page {
        val untrained = record.heaviest == null && record.recentDays.isEmpty()
        return Page(
            name = record.exercise.name,
            subhead = subhead(record),
            tiles = tiles(record, now),
            chart = chart(record, now),
            records = records(record, now),
            // EVERY SET RIDES WITH ITS KIND, which is why the log sends one: a drop set printed as
            // `70 × 12` is counted as work by whoever reads the line, and the subhead directly above
            // it counts sessions by working sets only — one page telling two stories about the same
            // afternoon. The room's own word for it is the wire's, exactly as session detail says it.
            days = record.recentDays.map { day ->
                Day(
                    day = Readout.briefDay(day.startedAtMs, now),
                    sets = day.sets.joinToString(" · ") { set ->
                        val effort = Readout.effort(set.weightKg, set.reps)
                        if (set.kind == SetKind.Working) effort else "$effort ${set.kind.wire}"
                    },
                )
            },
            nothingYet = if (untrained)
                "Nothing logged for this movement yet. The first set you log lands here."
            else null,
            // Said only where the estimate is genuinely missing rather than undefined: a load above
            // zero that no mark carries an e1RM for is the anonymous log, not Epley declining to
            // answer. A movement lifted at or below zero says nothing, because there is nothing
            // absent — there is no such number.
            noEstimate = if (!untrained && record.bestE1rm == null && (record.heaviest?.weightKg ?: 0.0) > 0)
                "e1RM is computed on your log. Sign in and the chart arrives with it."
            else null,
        )
    }

    // `barbell · in 2 routines · 34 sessions`, and every clause is dropped rather than faked where
    // its fact is missing: an older server sends no counts, and a movement in no routine has
    // nothing to say about routines. A movement nobody has lifted borrows the picker's own word.
    private fun subhead(record: MovementRecord): String {
        val facts = mutableListOf(record.exercise.equipment)
        record.routineCount?.takeIf { it > 0 }?.let {
            facts.add(if (it == 1) "in 1 routine" else "in $it routines")
        }
        record.sessionCount?.let {
            facts.add(if (it == 0) "never logged" else Readout.sessionCount(it))
        }
        return facts.joinToString(" · ")
    }

    // Two tiles at most, and each one exists only where its mark does. The best-e1RM tile carries
    // the set that made it; the heaviest tile carries the unit and the reps, because the number
    // above it is already the load.
    //
    // ZERO IS NOT A LOAD, IT IS THE ABSENCE OF ONE — the finish screen's rule and the statistics
    // screen's before it — so a movement whose heaviest set moved nothing external is titled by
    // what it actually says: the reps. A band-assisted −20 is a real point on the number line and
    // stays "heaviest", because the least assisted set IS the heaviest one.
    private fun tiles(record: MovementRecord, now: Long): List<Tile> {
        val tiles = mutableListOf<Tile>()
        val best = record.bestE1rm
        val estimate = best?.e1rm
        if (best != null && estimate != null) {
            tiles.add(Tile(
                label = "best e1RM",
                value = Readout.weight(estimate),
                caption = "${Readout.briefDay(best.atMs, now)} · ${Readout.effort(best.weightKg, best.reps)}",
                loud = true,
            ))
        }
        record.heaviest?.let { heaviest ->
            if (heaviest.weightKg == 0.0) {
                tiles.add(Tile("most reps", heaviest.reps.toString(), "reps · no added load", loud = false))
                return@let
            }
            tiles.add(Tile("heaviest", Readout.weight(heaviest.weightKg), "kg · for ${heaviest.reps}", loud = false))
        }
        return tiles
    }

    // A CHART WITH A HOLE IN IT IS NOT THE TRUE STORY — the axis rule the statistics screen banked,
    // applied to bars. The wire carries an estimate on every point of this series by contract, so
    // one arriving without means a session this build cannot place; drawing it at zero would be a
    // bar nobody lifted, and skipping it would be a session silently missing from twelve weeks.
    //
    // THE CEILING IS THE STANDING BEST AND NOT THE WINDOW'S OWN PEAK, because the tile directly
    // above this card prints the LIFETIME best and the series is only the last twelve weeks. A
    // chart normalised to its own window would stand a full-height bar under a number forty per
    // cent higher than it — the floating baseline this page refuses, arrived at from the other end.
    // A lifter past their peak gets bars that stop short of the top, which is exactly what being
    // past it looks like, and no gold bar, because the session holding the best is not in view.
    private fun chart(record: MovementRecord, now: Long): Chart? {
        val series = record.e1rmSeries
        if (series.isEmpty() || series.any { it.e1rm == null }) return null
        val ceiling = maxOf(series.maxOf { it.e1rm ?: 0.0 }, record.bestE1rm?.e1rm ?: 0.0)
        if (ceiling <= 0) return null
        val standing = record.bestE1rm?.atMs
        val from = Readout.shortDate(series.first().atMs, now)
        val to = Readout.shortDate(series.last().atMs, now)
        return Chart(
            bars = series.map { Bar(height = (it.e1rm ?: 0.0) / ceiling, standingBest = it.atMs == standing) },
            window = "$windowWeeks weeks",
            from = from,
            to = if (to == from) null else to,
        )
    }

    // Newest first, exactly as the log sends them — the first row is the one still holding, and it
    // is the row the standing-best tile and the gold bar are both about. A record without an
    // estimate cannot arrive (the list is absent wherever Epley is), and one that did would be a
    // row with nothing in its middle column, so it is left out.
    private fun records(record: MovementRecord, now: Long): List<Best> =
        record.records.mapNotNull { mark ->
            val estimate = mark.e1rm ?: return@mapNotNull null
            Best(
                effort = Readout.effort(mark.weightKg, mark.reps),
                estimate = Readout.estimate(estimate),
                day = Readout.briefDay(mark.atMs, now),
                standing = mark.atMs == record.bestE1rm?.atMs,
            )
        }
}
