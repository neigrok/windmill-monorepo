package works.windmill.gym.domain

import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Moment
import works.windmill.domain.kit.Instant as DomainInstant
import works.windmill.gym.domain.sync.Catalogue as DomainCatalogue
import works.windmill.gym.domain.sync.Exercise as DomainExercise
import works.windmill.gym.domain.sync.PerformedFact as DomainPerformedFact
import works.windmill.gym.domain.sync.ProgressRecords
import works.windmill.gym.domain.sync.Session as DomainSession
import works.windmill.gym.domain.sync.StatsProgress as DomainStatsProgress
import works.windmill.gym.domain.sync.TrainingLog as DomainTrainingLog
import works.windmill.gym.domain.sync.TrainingSet as DomainTrainingSet
import works.windmill.gym.domain.sync.GymEstimate

// The shared progress read, projected for the screens. `source` is the read itself, kept so the log's new bests are
// decided by the shared rule over exactly the sessions this projection shows; the wire form carries none.
@Serializable
data class StatsProgress(val asOf: Long, val sessions: List<ProgressSession>, @Transient private val source: DomainStatsProgress? = null) {
    fun movement(exerciseId: String): MovementProgress = MovementProgress(exerciseId,
        sessions.sortedWith(compareBy({ it.startedAt }, { it.sessionId })).mapNotNull { session ->
            session.movements.firstOrNull { it.exerciseId == exerciseId }?.let {
                MovementProgress.Session(session.sessionId, session.startedAt, it)
            }
        })

    fun sessionEstimate(sessionId: String): Double? = sessions.firstOrNull { it.sessionId == sessionId }
        ?.movements?.mapNotNull { it.estimate?.e1rm }?.maxOrNull()

    // Two projections of the same facts are equal however they were read.
    override fun equals(other: Any?): Boolean = other is StatsProgress && asOf == other.asOf && sessions == other.sessions
    override fun hashCode(): Int = 31 * asOf.hashCode() + sessions.hashCode()

    val newBests: List<NewBest>
        get() {
            val read = source ?: return emptyList()
            val shown = read.sessions.filter { session -> sessions.any { it.sessionId == session.sessionId.record.string } }
            return ProgressRecords(read.copy(sessions = shown)).movements.flatMap { (exerciseId, run) ->
                run.map { NewBest(exerciseId.record.string!!, it) }
            }
        }

    companion object {
        // Progress reads estimates, never load counts, so its log carries no movements.
        fun of(details: List<SessionDetail>, asOf: Long, complete: Boolean = true): StatsProgress {
            val finished = details.filter { !it.session.isOpen }
            val log = DomainTrainingLog(finished.map { detail ->
                DomainSession(Id(detail.session.id, DomainSession), DomainInstant(detail.session.startedAtMs), DomainInstant(detail.session.finishedAtMs!!))
            }, finished.flatMap { detail -> detail.sets.map { set ->
                DomainTrainingSet(Id(set.id, DomainTrainingSet), Id(detail.session.id, DomainSession), Id(set.exerciseId, DomainExercise),
                    set.weightKg, set.reps, set.kind.wire, set.rpe, set.note, DomainInstant(set.completedAtMs), set.setNumber)
            } }, DomainCatalogue(emptyList()), Moment(DomainInstant(asOf), FixedZone(0)), complete)
            val source = DomainStatsProgress(log)
            return StatsProgress(asOf, source.sessions.map { session ->
                ProgressSession(session.sessionId.record.string!!, session.startedAt.ms, session.movements.map { fact ->
                    MovementSessionFact(fact.exerciseId.record.string!!, fact.workingSetCount, PerformedFact(fact.heaviest),
                        fact.estimate?.let { EstimatedFact(it.setId.record.string!!, it.weightKg, it.reps, it.rpe, it.e1rm) },
                        fact.bodyweightReps?.let(::PerformedFact))
                })
            }, source)
        }

        fun estimate(weightKg: Double, reps: Int, rpe: Double?): Double? = GymEstimate.value(weightKg, reps, rpe = rpe)
    }
}

// One new best the log weaves: the session that set it, the best it beat, and both stated to 0.1 kg.
data class NewBest(val exerciseId: String, val sessionId: String, val startedAt: Long,
    val previousSessionId: String, val previousStartedAt: Long, val estimate: Double, val gain: Double) {
    constructor(exerciseId: String, record: ProgressRecords.Record) : this(exerciseId, record.point.id.record.string!!, record.point.startedAt.ms,
        record.previous.id.record.string!!, record.previous.startedAt.ms, record.estimate, record.gain)
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
