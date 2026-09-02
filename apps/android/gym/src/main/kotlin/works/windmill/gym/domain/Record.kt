package works.windmill.gym.domain

// Two absences, neither of them a zero: Epley is undefined at or below zero load, so a bodyweight or
// band-assisted movement has NO e1RM, and a movement nobody has lifted has no history.
object Record {
    // The server's own window.
    const val windowWeeks = 12

    data class Tile(val label: String, val value: String, val caption: String, val loud: Boolean)

    // Height is a fraction of the standing best and measured FROM ZERO.
    data class Bar(val height: Double, val standingBest: Boolean)

    data class Chart(val bars: List<Bar>, val window: String, val from: String, val to: String?)

    data class Best(val effort: String, val estimate: String, val day: String, val standing: Boolean)

    data class Day(val day: String, val sets: String)

    // A row with nothing behind it is dropped rather than printed with a zero in it.
    data class Proof(val label: String, val value: String)

    fun proof(record: MovementRecord, aliased: Boolean): List<Proof> {
        val proof = mutableListOf<Proof>()
        record.sessionCount?.takeIf { it > 0 }?.let { proof.add(Proof("sessions", "$it · unchanged")) }
        marks(record)?.let { proof.add(Proof("records", it)) }
        record.routines.takeIf { it.isNotEmpty() }
            ?.let { proof.add(Proof("routines", it.joinToString(" · "))) }
        if (aliased) proof.add(Proof("old name", "searchable as an alias"))
        return proof
    }

    private fun marks(record: MovementRecord): String? {
        val ladder = record.records.size.takeIf { it > 0 }
            ?.let { if (it == 1) "1 PR" else "$it PRs" }
        val standing = record.bestE1rm?.e1rm?.let { Readout.estimate(it) }
        if (ladder == null) return standing?.let { "$it kept" }
        if (standing == null) return "$ladder kept"
        return "$ladder · $standing kept"
    }

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
            // Only where the estimate is genuinely missing rather than undefined — and it names the
            // way out, which is why it is drawn at all.
            noEstimate = if (!untrained && record.bestE1rm == null && (record.heaviest?.weightKg ?: 0.0) > 0)
                "e1RM needs your account — sign in for the chart."
            else null,
        )
    }

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

    // Zero is the absence of a load, so a heaviest set of 0 is titled by its reps.
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

    // A point with no estimate drops the whole chart. The ceiling is the LIFETIME standing best.
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

    // A record with no estimate is left out.
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
