package works.windmill.gym.presentation

import androidx.annotation.StringRes
import works.windmill.gym.R
import works.windmill.platform.i18n.Words
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

data class MovementRead(val record: MovementRecord, val progress: MovementProgress, val asOf: Long)

object Record {
    data class Tile(@StringRes val named: Int, val value: String, val said: Words, val loud: Boolean)
    data class Best(val effort: String, val estimated: Words, val on: Words)
    data class Day(val on: Words, val sets: String)
    // Before the first pull the phone's partial copy leaves claims out: the tiles, the strength card and `untrained` wait.
    data class Page(
        val name: String,
        val equipment: Words,
        val tiles: List<Tile>,
        val records: List<Best>,
        val days: List<Day>,
        val untrained: Words?,
        val noEstimateYet: Words?,
        val strength: Boolean,
    )

    fun page(read: MovementRead, now: Long): Page {
        val record = read.record
        val progress = read.progress
        val best = progress.best
        val heaviest = progress.heaviest?.fact?.heaviest
        val untrained = progress.isComplete && progress.sessions.isEmpty() && record.recentDays.isEmpty()
        val tiles = buildList {
            best?.let { point ->
                add(Tile(R.string.gym_record_tile_best, Readout.estimatedWeight(requireNotNull(point.fact.estimate!!.e1rm)),
                    Words.Message(R.string.gym_record_tile_kg_on, listOf(Readout.brief(point.startedAt, now))), true))
            }
            heaviest?.takeIf { it.weightKg != 0.0 }?.let {
                add(Tile(R.string.gym_record_tile_heaviest, Readout.weight(it.weightKg),
                    Words.Message(R.string.gym_record_tile_kg_on, listOf(Readout.reps(it.reps))), false))
            }
            progress.bodyweightReps?.fact?.bodyweightReps?.let {
                add(Tile(R.string.gym_record_tile_most_reps, "${it.reps}", Words.Message(R.string.gym_record_tile_no_added_load), false))
            }
        }
        return Page(record.exercise.name,
            when (record.exercise.equipment) {
                "dumbbell" -> Words.Message(R.string.gym_record_equipment_dumbbells)
                "barbell" -> Words.Message(R.string.gym_record_equipment_barbell)
                "machine" -> Words.Message(R.string.gym_record_equipment_machine)
                "bodyweight" -> Words.Message(R.string.gym_record_equipment_bodyweight)
                "other" -> Words.Message(R.string.gym_record_equipment_other)
                else -> Words.Plain(record.exercise.equipment.replaceFirstChar { it.titlecase() })
            }, tiles,
            progress.earlierRecords.asReversed().map { point ->
                val fact = point.fact.estimate!!
                Best(Readout.effort(fact.weightKg, fact.reps), Readout.e1rm(requireNotNull(fact.e1rm)),
                    Readout.brief(point.startedAt, now))
            }, record.recentDays.map { day ->
                Day(Readout.brief(day.startedAtMs, now), day.sets.joinToString(" · ") { set ->
                    Readout.effort(set.weightKg, set.reps)
                })
            },
            if (untrained) Words.Message(R.string.gym_record_untrained) else null,
            if (!untrained && progress.estimatesComplete && best == null && (heaviest?.weightKg ?: 0.0) > 0)
                Words.Message(R.string.gym_record_no_estimate) else null,
            progress.isComplete && progress.estimates.isNotEmpty(),
        )
    }
}
