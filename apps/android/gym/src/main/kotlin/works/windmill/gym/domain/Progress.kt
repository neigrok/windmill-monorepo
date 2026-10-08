package works.windmill.gym.domain

import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Moment
import works.windmill.domain.kit.Instant as DomainInstant
import works.windmill.gym.domain.sync.Exercise as DomainExercise
import works.windmill.gym.domain.sync.PerformedFact as DomainPerformedFact
import works.windmill.gym.domain.sync.Session as DomainSession
import works.windmill.gym.domain.sync.StatsProgress as DomainStatsProgress
import works.windmill.gym.domain.sync.TrainingLog as DomainTrainingLog
import works.windmill.gym.domain.sync.TrainingSet as DomainTrainingSet
import works.windmill.gym.domain.sync.GymEstimate

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

    companion object {
        fun of(details: List<SessionDetail>, asOf: Long): StatsProgress {
            val moment = Moment(DomainInstant(asOf), FixedZone(0))
            return StatsProgress(asOf, details.filter { !it.session.isOpen }.mapNotNull { detail ->
                val id = Id(detail.session.id, DomainSession)
                val log = DomainTrainingLog(listOf(DomainSession(id, DomainInstant(detail.session.startedAtMs),
                    DomainInstant(detail.session.finishedAtMs!!))), detail.sets.map { set ->
                    DomainTrainingSet(Id(set.id, DomainTrainingSet), id, Id(set.exerciseId, DomainExercise),
                        set.weightKg, set.reps, set.kind.wire, set.rpe, set.note, DomainInstant(set.completedAtMs), set.setNumber)
                }, moment)
                val session = DomainStatsProgress(log).sessions.singleOrNull() ?: return@mapNotNull null
                ProgressSession(session.sessionId.record.string!!, session.startedAt.ms, session.movements.map { fact ->
                    MovementSessionFact(fact.exerciseId.record.string!!, fact.workingSetCount, PerformedFact(fact.heaviest),
                        fact.estimate?.let { EstimatedFact(it.setId.record.string!!, it.weightKg, it.reps, it.rpe, it.e1rm) },
                        fact.bodyweightReps?.let(::PerformedFact))
                })
            }.sortedWith(compareBy({ it.startedAt }, { it.sessionId })))
        }

        fun estimate(weightKg: Double, reps: Int, rpe: Double?): Double? = GymEstimate.value(weightKg, reps, rpe = rpe)
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
    @SerialName("mostReps") val bodyweightReps: PerformedFact? = heaviest.takeIf { it.weightKg == 0.0 },
)

@Serializable
data class PerformedFact(val setId: String, val weightKg: Double, val reps: Int, val rpe: Double? = null) {
    constructor(fact: DomainPerformedFact) : this(fact.setId.record.string!!, fact.weightKg, fact.reps, fact.rpe)
}

@Serializable
data class EstimatedFact(val setId: String, val weightKg: Double, val reps: Int, val rpe: Double? = null, val e1rm: Double) {
    val score: Double get() = GymEstimate.score(weightKg, reps, rpe = rpe) ?: 0.0
}

data class MovementProgress(val exerciseId: String, val sessions: List<Session>) {
    companion object {
        const val maxGapDays = 21L
    }

    data class Session(val id: String, val startedAt: Long, val fact: MovementSessionFact)

    val estimates: List<Session> get() = sessions.filter { it.fact.estimate != null }
    val latest: Session? get() = estimates.lastOrNull()
    val best: Session? get() = estimates.sortedWith(compareByDescending<Session> { it.fact.estimate!!.score }
        .thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val heaviest: Session? get() = sessions.sortedWith(compareByDescending<Session> { it.fact.heaviest.weightKg }
        .thenByDescending { it.fact.heaviest.reps }.thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val bodyweightReps: Session? get() = sessions.filter { it.fact.bodyweightReps != null }
        .sortedWith(compareByDescending<Session> { it.fact.bodyweightReps!!.reps }.thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val records: List<Session> get() {
        val records = mutableListOf<Session>()
        for (session in estimates) {
            if (session.fact.estimate!!.score > (records.lastOrNull()?.fact?.estimate?.score ?: 0.0)) records += session
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
