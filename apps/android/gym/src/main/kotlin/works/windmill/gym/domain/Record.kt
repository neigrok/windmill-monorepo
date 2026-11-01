package works.windmill.gym.domain

import works.windmill.domain.kit.Id
import works.windmill.gym.domain.sync.Exercise as DomainExercise
import works.windmill.gym.domain.sync.recentDays

// One finished workout's sets of a movement, in logged order.
data class RecordDay(
    val sessionId: String,
    val startedAtMs: Long,
    val sets: List<TrainingSet> = emptyList(),
)

// A movement's page: the movement and its newest days, the shared `recentDays` read over the history the log holds.
// Its estimates and bests are read from `StatsProgress`.
data class MovementRecord(
    val exercise: Exercise,
    val recentDays: List<RecordDay> = emptyList(),
) {
    companion object {
        fun of(exercise: Exercise, history: List<SessionDetail>, asOf: Long): MovementRecord {
            val held = history.flatMap { it.sets }.associateBy { it.id }
            return MovementRecord(exercise, finishedLog(history, asOf).recentDays(Id(exercise.id, DomainExercise)).map { day ->
                RecordDay(day.session.id.record.string!!, day.session.startedAt.ms, day.sets.map { held.getValue(it.id.record.string!!) })
            })
        }
    }
}

object Record {
    data class Tile(val label: String, val value: String, val caption: String, val loud: Boolean)
    data class Best(val effort: String, val estimate: String, val day: String)
    data class Day(val day: String, val sets: String)
    // Before the first pull the phone's partial copy leaves claims out: the tiles, the strength card and `nothingYet` wait.
    data class Page(
        val name: String,
        val subhead: String,
        val tiles: List<Tile>,
        val records: List<Best>,
        val days: List<Day>,
        val nothingYet: String?,
        val noEstimate: String?,
        val strength: Boolean,
    )

    fun page(record: MovementRecord, now: Long, progress: MovementProgress): Page {
        val best = progress.best
        val heaviest = progress.heaviest?.fact?.heaviest
        val untrained = progress.isComplete && progress.sessions.isEmpty() && record.recentDays.isEmpty()
        val tiles = buildList {
            best?.let { point ->
                add(Tile("Best e1RM", Readout.estimatedWeight(requireNotNull(point.fact.estimate!!.e1rm)),
                    "kg · ${Readout.briefDay(point.startedAt, now)}", true))
            }
            heaviest?.takeIf { it.weightKg != 0.0 }?.let {
                add(Tile("Heaviest", Readout.weight(it.weightKg), "kg · ${Readout.repCount(it.reps)}", false))
            }
            progress.bodyweightReps?.fact?.bodyweightReps?.let {
                add(Tile("Most reps", "${it.reps}", "reps · no added load", false))
            }
        }
        return Page(record.exercise.name,
            when (record.exercise.equipment) {
                "dumbbell" -> "Dumbbells"
                else -> record.exercise.equipment.replaceFirstChar { it.titlecase() }
            }, tiles,
            progress.earlierRecords.asReversed().map { point ->
                val fact = point.fact.estimate!!
                Best(Readout.effort(fact.weightKg, fact.reps), Readout.estimate(requireNotNull(fact.e1rm)),
                    Readout.briefDay(point.startedAt, now))
            }, record.recentDays.map { day ->
                Day(Readout.briefDay(day.startedAtMs, now), day.sets.joinToString(" · ") { set ->
                    Readout.effort(set.weightKg, set.reps)
                })
            },
            if (untrained) "Nothing logged for this movement yet. The first set you log lands here." else null,
            if (!untrained && progress.estimatesComplete && best == null && (heaviest?.weightKg ?: 0.0) > 0)
                "No eligible estimate yet. Estimates use 1–10 reps at effort 7 or higher, or unrated sets." else null,
            progress.isComplete && progress.estimates.isNotEmpty(),
        )
    }
}
