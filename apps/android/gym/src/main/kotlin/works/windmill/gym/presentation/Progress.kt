package works.windmill.gym.presentation

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Moment
import works.windmill.domain.kit.Zone
import works.windmill.domain.kit.Instant as DomainInstant
import works.windmill.gym.domain.sync.Catalogue as DomainCatalogue
import works.windmill.gym.domain.sync.EstimateScore
import works.windmill.gym.domain.sync.EstimatedFact as DomainEstimatedFact
import works.windmill.gym.domain.sync.Exercise as DomainExercise
import works.windmill.gym.domain.sync.GymEstimate
import works.windmill.gym.domain.sync.MovementProgress as DomainMovementProgress
import works.windmill.gym.domain.sync.MovementSessionFact as DomainMovementSessionFact
import works.windmill.gym.domain.sync.PerformedFact as DomainPerformedFact
import works.windmill.gym.domain.sync.ProgressRecords
import works.windmill.gym.domain.sync.ProgressSession as DomainProgressSession
import works.windmill.gym.domain.sync.Session as DomainSession
import works.windmill.gym.domain.sync.StatsProgress as DomainStatsProgress
import works.windmill.gym.domain.sync.TrainingLog as DomainTrainingLog

// The shared progress read, projected for the screens with string ids and epoch-ms instants. Every best, record,
// window and chart threshold is the shared read's own, completeness gate included; nothing here decides one.
class StatsProgress(private val read: DomainStatsProgress) {
    val asOf: Long get() = read.asOf.ms
    val sessions: List<ProgressSession> = read.sessions.map(::ProgressSession)

    fun movement(exerciseId: String): MovementProgress {
        val id = Id(exerciseId, DomainExercise)
        val earlier = ProgressRecords(read).movements[id].orEmpty().map { it.previous.id }.toSet()
        val movement = read.movement(id)
        return MovementProgress(movement, movement.sessions.filter { it.id in earlier }.map(MovementProgress::Point))
    }

    fun sessionEstimate(sessionId: String): Double? = read.sessionEstimate(Id(sessionId, DomainSession))

    val newBests: List<NewBest>
        get() = ProgressRecords(read).movements.flatMap { (exerciseId, run) -> run.map { NewBest(exerciseId.record.string!!, it) } }

    // The read as it stood at `nowMs`: a workout that starts later is not drawn yet.
    fun until(nowMs: Long): StatsProgress = StatsProgress(read.copy(sessions = read.sessions.filter { it.startedAt.ms <= nowMs }))

    // The read without workouts a held delete hides.
    fun without(sessionIds: Set<String>): StatsProgress =
        StatsProgress(read.copy(sessions = read.sessions.filterNot { it.sessionId.record.string in sessionIds }))

    override fun equals(other: Any?): Boolean = other is StatsProgress && read == other.read
    override fun hashCode(): Int = read.hashCode()
    override fun toString(): String = "StatsProgress(asOf=$asOf, sessions=$sessions, complete=${read.isComplete})"

    companion object {
        fun of(details: List<SessionDetail>, asOf: Long, complete: Boolean = true): StatsProgress =
            StatsProgress(DomainStatsProgress(finishedLog(details, asOf, complete)))

        fun empty(asOf: Long): StatsProgress = StatsProgress(DomainStatsProgress(DomainInstant(asOf), emptyList()))
    }
}

// The finished workouts of `details` as the shared training log, for the shared reads over them. Those reads take
// estimates and sets, never load counts, so the log carries no movements.
fun finishedLog(details: List<SessionDetail>, asOf: Long, complete: Boolean = true): DomainTrainingLog {
    val finished = details.filter { !it.session.isOpen }
    return DomainTrainingLog(finished.map { detail ->
        DomainSession(Id(detail.session.id, DomainSession), DomainInstant(detail.session.startedAtMs), DomainInstant(detail.session.finishedAtMs!!))
    }, finished.flatMap { detail -> detail.sets.map { it.domain(detail.session.id) } },
        DomainCatalogue(emptyList()), Moment(DomainInstant(asOf), FixedZone(0)), complete)
}

// One new best the log weaves: the session that set it, the best it beat, and both stated to 0.1 kg.
data class NewBest(val exerciseId: String, val sessionId: String, val startedAt: Long,
    val previousSessionId: String, val previousStartedAt: Long, val estimate: Double, val gain: Double) {
    constructor(exerciseId: String, record: ProgressRecords.Record) : this(exerciseId, record.point.id.record.string!!, record.point.startedAt.ms,
        record.previous.id.record.string!!, record.previous.startedAt.ms, record.estimate, record.gain)
}

data class ProgressSession(val sessionId: String, val startedAt: Long, val movements: List<MovementSessionFact>) {
    constructor(session: DomainProgressSession) : this(session.sessionId.record.string!!, session.startedAt.ms,
        session.movements.map(::MovementSessionFact))
}

data class MovementSessionFact(
    val exerciseId: String,
    val workingSetCount: Int,
    val heaviest: PerformedFact,
    val estimate: EstimatedFact? = null,
    val bodyweightReps: PerformedFact? = null,
    val estimatesComplete: Boolean = true,
) {
    constructor(fact: DomainMovementSessionFact) : this(fact.exerciseId.record.string!!, fact.workingSetCount, PerformedFact(fact.heaviest),
        fact.estimate?.let(::EstimatedFact), fact.bodyweightReps?.let(::PerformedFact), fact.estimatesComplete)
}

data class PerformedFact(val setId: String, val weightKg: Double, val reps: Int, val rpe: Double? = null) {
    constructor(fact: DomainPerformedFact) : this(fact.setId.record.string!!, fact.weightKg, fact.reps, fact.rpe)
}

data class EstimatedFact(val setId: String, val weightKg: Double, val reps: Int, val rpe: Double? = null, val e1rm: Double?) {
    constructor(fact: DomainEstimatedFact) : this(fact.setId.record.string!!, fact.weightKg, fact.reps, fact.rpe, fact.e1rm)
    val score: EstimateScore get() = GymEstimate.score(weightKg, reps, rpe = rpe) ?: EstimateScore.zero
}

// One movement's series from the shared read: its standing best, heaviest and most reps answer nothing until the
// account's history has been read, and `earlierRecords` are the bests the standing one beat on its way up.
class MovementProgress(private val read: DomainMovementProgress, val earlierRecords: List<Point> = emptyList()) {
    data class Point(val id: String, val startedAt: Long, val fact: MovementSessionFact) {
        constructor(point: DomainMovementProgress.Point) : this(point.id.record.string!!, point.startedAt.ms, MovementSessionFact(point.fact))
    }

    val exerciseId: String = read.exerciseId.record.string!!
    val sessions: List<Point> = read.sessions.map(::Point)
    val isComplete: Boolean get() = read.isComplete
    val estimatesComplete: Boolean get() = read.estimatesComplete
    val estimates: List<Point> get() = read.estimates.map(::Point)
    val best: Point? get() = read.best?.let(::Point)
    val heaviest: Point? get() = read.heaviest?.let(::Point)
    val bodyweightReps: Point? get() = read.bodyweightReps?.let(::Point)

    fun window(nowMs: Long, zone: ZoneId): MovementProgress = MovementProgress(read.window(DomainInstant(nowMs), zone.domain))
    fun hasChart(zone: ZoneId): Boolean = read.hasChart(zone.domain)
}

private val ZoneId.domain: Zone get() = Zone { at -> rules.getOffset(Instant.ofEpochMilli(at.ms)).totalSeconds }

fun progressReading(point: MovementProgress.Point, nowMs: Long): String {
    val fact = point.fact.estimate!!
    return "${Readout.estimatedWeight(requireNotNull(fact.e1rm))} kg est · ${Readout.briefDay(point.startedAt, nowMs)} · ${Readout.effort(fact.weightKg, fact.reps)}"
}

fun progressSeries(progress: MovementProgress, nowMs: Long, zone: ZoneId, all: Boolean = false): DatedSeries {
    val points = progress.estimates.groupBy { Instant.ofEpochMilli(it.startedAt).atZone(zone).toLocalDate() }
        .values.map { day -> day.sortedWith(compareByDescending<MovementProgress.Point> { it.fact.estimate!!.score }
            .thenBy { it.startedAt }.thenBy { it.id }).first() }
        .sortedWith(compareBy({ it.startedAt }, { it.id }))
        .map { DatedPoint(it.id, it.startedAt, requireNotNull(it.fact.estimate!!.e1rm), progressReading(it, nowMs)) }
    val from = if (all) points.firstOrNull()?.atMs ?: nowMs else LocalDate.parse(DomainMovementProgress.windowStart(DomainInstant(nowMs), zone.domain).text)
        .atStartOfDay(zone).toInstant().toEpochMilli()
    return DatedSeries(points, from, nowMs, zone, DomainMovementProgress.gapDays.toLong())
}
