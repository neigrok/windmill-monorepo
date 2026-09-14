package works.windmill.gym.domain

object Record {
    data class Tile(val label: String, val value: String, val caption: String, val loud: Boolean)
    data class Best(val effort: String, val estimate: String, val day: String, val standing: Boolean)
    data class Day(val day: String, val sets: String)
    data class Page(
        val name: String,
        val subhead: String,
        val tiles: List<Tile>,
        val records: List<Best>,
        val days: List<Day>,
        val nothingYet: String?,
        val noEstimate: String?,
    )

    fun page(record: MovementRecord, now: Long, progress: MovementProgress): Page {
        val best = progress.best
        val heaviest = progress.heaviest?.fact?.heaviest
        val untrained = progress.sessions.isEmpty() && record.recentDays.isEmpty()
        val tiles = buildList {
            best?.let { point ->
                add(Tile("Best e1RM", Readout.estimatedWeight(point.fact.estimate!!.e1rm),
                    "kg · ${Readout.briefDay(point.startedAt, now)}", true))
            }
            heaviest?.let {
                add(if (it.weightKg == 0.0) Tile("Most reps", "${it.reps}", "reps · no added load", false)
                    else Tile("Heaviest", Readout.weight(it.weightKg), "kg · ${Readout.repCount(it.reps)}", false))
            }
        }
        return Page(record.exercise.name,
            record.exercise.equipment.replaceFirstChar { it.titlecase() }, tiles,
            progress.records.asReversed().map { point ->
                val fact = point.fact.estimate!!
                Best(Readout.effort(fact.weightKg, fact.reps), Readout.estimate(fact.e1rm),
                    Readout.briefDay(point.startedAt, now), point.id == best?.id)
            }, record.recentDays.map { day ->
                Day(Readout.briefDay(day.startedAtMs, now), day.sets.joinToString(" · ") { set ->
                    val effort = Readout.effort(set.weightKg, set.reps)
                    if (set.kind == SetKind.Working) effort else "$effort ${set.kind.wire}"
                })
            },
            if (untrained) "Nothing logged for this movement yet. The first set you log lands here." else null,
            if (!untrained && best == null && (heaviest?.weightKg ?: 0.0) > 0)
                "No eligible estimate yet. Estimates use 1–10 reps at effort 7 or higher, or unrated sets." else null,
        )
    }
}
