package works.windmill.gym.domain

import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters
import kotlinx.serialization.Serializable

@Serializable
data class StatsProgress(val asOf: Long, val sessions: List<ProgressSession>) {
    fun movement(exerciseId: String): MovementProgress = MovementProgress(exerciseId,
        sessions.sortedWith(compareBy({ it.startedAt }, { it.sessionId })).mapNotNull { session ->
            session.movements.firstOrNull { it.exerciseId == exerciseId }?.let {
                MovementProgress.Session(session.sessionId, session.startedAt, it)
            }
        })

    fun sessionEstimate(sessionId: String): Double? = sessions.firstOrNull { it.sessionId == sessionId }
        ?.movements?.mapNotNull { it.estimate?.e1rm }?.maxOrNull()

    fun trainedWeeks(nowMs: Long, zone: ZoneId): Int {
        val monday = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
            .with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        return sessions.filter { it.movements.any { fact -> fact.workingSetCount > 0 } }
            .map { Instant.ofEpochMilli(it.startedAt).atZone(zone).toLocalDate() }
            .filter { !it.isBefore(monday.minusWeeks(3)) && it.isBefore(monday.plusWeeks(1)) }
            .map { it.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)) }.distinct().size
    }

    fun consistencyWeeks(nowMs: Long, zone: ZoneId): Int? {
        val weeks = sessions.filter { it.movements.any { fact -> fact.workingSetCount > 0 } }
            .map { Instant.ofEpochMilli(it.startedAt).atZone(zone).toLocalDate()
                .with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)) }.distinct()
        if (weeks.size < 2) return null
        return trainedWeeks(nowMs, zone).takeIf { it > 0 }
    }

    fun recentMovements(nowMs: Long, zone: ZoneId): List<MovementProgress> = sessions
        .flatMap { it.movements }.map { it.exerciseId }.distinct()
        .map { movement(it).window(nowMs, zone) }.filter { it.sessions.isNotEmpty() }
        .sortedWith(compareByDescending<MovementProgress> { it.sessions.last().startedAt }
            .thenBy { it.exerciseId })

    companion object {
        fun of(details: List<SessionDetail>, asOf: Long): StatsProgress = StatsProgress(asOf,
            details.filter { !it.session.isOpen }.mapNotNull { detail ->
                val movements = detail.sets.filter { it.kind == SetKind.Working }
                    .groupBy { it.exerciseId }.toSortedMap().map { (id, sets) ->
                        val heaviest = sets.sortedWith(compareByDescending<TrainingSet> { it.weightKg }
                            .thenByDescending { it.reps }.thenBy { it.id }).first()
                        val estimate = sets.mapNotNull { set ->
                            val e1rm = estimate(set.weightKg, set.reps, set.rpe) ?: return@mapNotNull null
                            EstimatedFact(set.id, set.weightKg, set.reps, set.rpe, e1rm)
                        }.sortedWith(compareByDescending<EstimatedFact> { it.e1rm }.thenBy { it.setId }).firstOrNull()
                        MovementSessionFact(id, sets.size,
                            PerformedFact(heaviest.id, heaviest.weightKg, heaviest.reps, heaviest.rpe), estimate)
                    }
                if (movements.isEmpty()) null else ProgressSession(detail.session.id, detail.session.startedAtMs, movements)
            }.sortedWith(compareBy({ it.startedAt }, { it.sessionId })))

        fun estimate(weightKg: Double, reps: Int, rpe: Double?): Double? {
            if (weightKg <= 0 || reps !in 1..10 || (rpe != null && rpe < 7)) return null
            return if (reps == 1) weightKg else weightKg * (1 + reps / 30.0)
        }
    }
}

@Serializable
data class ProgressSession(val sessionId: String, val startedAt: Long, val movements: List<MovementSessionFact>)

@Serializable
data class MovementSessionFact(
    val exerciseId: String,
    val workingSetCount: Int,
    val heaviest: PerformedFact,
    val estimate: EstimatedFact? = null,
)

@Serializable
data class PerformedFact(val setId: String, val weightKg: Double, val reps: Int, val rpe: Double? = null)

@Serializable
data class EstimatedFact(val setId: String, val weightKg: Double, val reps: Int, val rpe: Double? = null, val e1rm: Double)

data class MovementProgress(val exerciseId: String, val sessions: List<Session>) {
    companion object {
        const val maxGapDays = 21L
    }

    data class Session(val id: String, val startedAt: Long, val fact: MovementSessionFact)

    val estimates: List<Session> get() = sessions.filter { it.fact.estimate != null }
    val latest: Session? get() = estimates.lastOrNull()
    val best: Session? get() = estimates.sortedWith(compareByDescending<Session> { it.fact.estimate!!.e1rm }
        .thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val heaviest: Session? get() = sessions.sortedWith(compareByDescending<Session> { it.fact.heaviest.weightKg }
        .thenByDescending { it.fact.heaviest.reps }.thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val records: List<Session> get() {
        val records = mutableListOf<Session>()
        for (session in estimates) {
            if (session.fact.estimate!!.e1rm > (records.lastOrNull()?.fact?.estimate?.e1rm ?: 0.0)) records += session
        }
        return records
    }

    fun window(nowMs: Long, zone: ZoneId): MovementProgress {
        val start = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate().minusWeeks(12).atStartOfDay(zone).toInstant().toEpochMilli()
        return copy(sessions = sessions.filter { it.startedAt in start..nowMs })
    }

    fun hasChart(zone: ZoneId): Boolean {
        val points = estimates
        if (points.size < 4) return false
        val first = Instant.ofEpochMilli(points.first().startedAt).atZone(zone).toLocalDate()
        val last = Instant.ofEpochMilli(points.last().startedAt).atZone(zone).toLocalDate()
        return ChronoUnit.DAYS.between(first, last) >= 21
    }
}

fun progressReading(point: MovementProgress.Session, nowMs: Long): String {
    val fact = point.fact.estimate!!
    return "${Readout.estimatedWeight(fact.e1rm)} kg est · ${Readout.briefDay(point.startedAt, nowMs)} · ${Readout.effort(fact.weightKg, fact.reps)}"
}

fun progressSeries(progress: MovementProgress, nowMs: Long, zone: ZoneId, all: Boolean = false): DatedSeries {
    val points = progress.estimates.map { DatedPoint(it.id, it.startedAt, it.fact.estimate!!.e1rm, progressReading(it, nowMs)) }
    val from = if (all) points.firstOrNull()?.atMs ?: nowMs else Instant.ofEpochMilli(nowMs).atZone(zone)
        .toLocalDate().minusWeeks(12).atStartOfDay(zone).toInstant().toEpochMilli()
    return DatedSeries(points, from, nowMs, zone, MovementProgress.maxGapDays)
}
