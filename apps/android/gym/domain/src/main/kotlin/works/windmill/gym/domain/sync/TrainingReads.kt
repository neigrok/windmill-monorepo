package works.windmill.gym.domain.sync

import kotlin.math.abs
import works.windmill.domain.kit.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.Quantum

object GymEstimate {
    fun value(weightKg: Double, reps: Int, kind: String = "working", rpe: Double? = null): Double? {
        if (kind != "working" || !weightKg.isFinite() || weightKg <= 0 || reps !in 1..10 ||
            (rpe != null && (!rpe.isFinite() || rpe < 7))) return null
        return if (reps == 1) weightKg else weightKg * (1 + reps / 30.0)
    }
}

class SessionReadout(session: Session, sets: List<TrainingSet>) {
    val sessionId = session.id
    val name = session.name
    val durationMs = session.finishedAt?.let { maxOf(0, it.ms - session.startedAt.ms) }
    val workingSetCount = sets.count { it.sessionId == session.id && it.kind == "working" }
    val movementCount = sets.filter { it.sessionId == session.id }.map { it.exerciseId }.toSet().size
    val volumeKg = sets.filter { it.sessionId == session.id }.sumOf { it.volumeKg }
    val topE1rm = sets.filter { it.sessionId == session.id }.mapNotNull { it.e1rm }.maxOrNull()
}

data class LastTime(val exerciseId: Id<Exercise>, val session: Session? = null,
    val sets: List<TrainingSet> = emptyList(), val isComplete: Boolean = true) {
    val routine: String? get() = session?.name
    val isFirstTime: Boolean get() = isComplete && session == null

    companion object {
        fun of(exerciseId: Id<Exercise>, log: TrainingLog): LastTime {
            for (session in log.drawnSessions.filter { !it.isOpen }) {
                val sets = log.sets(session.id).filter { it.exerciseId == exerciseId && it.kind != "warmup" }
                if (sets.isNotEmpty()) return LastTime(exerciseId, session, sets, log.firstPullComplete)
            }
            return LastTime(exerciseId, isComplete = log.firstPullComplete)
        }
    }
}

data class Prefill(val weightKg: Double = emptyBarKg, val reps: Int = emptyBarReps) {
    companion object {
        const val emptyBarKg = 20.0
        const val emptyBarReps = 5
        fun of(todaySets: List<TrainingSet>, planEntry: RoutineEntry?, lastTime: LastTime?): Prefill {
            val scheme = planEntry?.sets.orEmpty()
            val working = todaySets.filter { it.kind == "working" }
            val sticky = working.lastOrNull()
            val history = lastTime?.sets.orEmpty()
            val straight = scheme.firstOrNull()?.let { first -> scheme.all { it == first } } ?: true
            if (scheme.isNotEmpty() && !straight) {
                val slot = scheme.getOrNull(working.size)
                val lastNth = history.filter { it.kind == "working" }.getOrNull(working.size)
                return Prefill(slot?.weightKg ?: lastNth?.weightKg ?: sticky?.weightKg ?: emptyBarKg,
                    maxOf(1, slot?.reps ?: lastNth?.reps ?: sticky?.reps ?: emptyBarReps))
            }
            if (sticky != null) return Prefill(sticky.weightKg, maxOf(1, sticky.reps))
            val planned = scheme.firstOrNull()
            return Prefill(planned?.weightKg ?: history.lastOrNull()?.weightKg ?: emptyBarKg,
                maxOf(1, planned?.reps ?: history.firstOrNull()?.reps ?: emptyBarReps))
        }
    }
}

data class PerformedFact(val setId: Id<TrainingSet>, val weightKg: Double, val reps: Int, val rpe: Double? = null) {
    constructor(set: TrainingSet) : this(set.id, set.weightKg, set.reps, set.rpe)
    val json: Json get() = Json.Obj(buildList {
        add("setId" to setId.json); add("weightKg" to Json.of(weightKg)); add("reps" to Json.of(reps))
        rpe?.let { add("rpe" to Json.of(it)) }
    })
}

data class EstimatedFact(val performed: PerformedFact, val e1rm: Double) {
    constructor(set: TrainingSet, e1rm: Double) : this(PerformedFact(set), e1rm)
    val setId get() = performed.setId
    val weightKg get() = performed.weightKg
    val reps get() = performed.reps
    val rpe get() = performed.rpe
    val json: Json get() = Json.Obj(performed.json.obj().toList() + ("e1rm" to Json.of(e1rm)))
}

data class MovementSessionFact(val exerciseId: Id<Exercise>, val workingSetCount: Int,
    val heaviest: PerformedFact, val mostReps: PerformedFact, val estimate: EstimatedFact? = null) {
    val json: Json get() = Json.Obj(buildList {
        add("exerciseId" to exerciseId.json); add("workingSetCount" to Json.of(workingSetCount)); add("heaviest" to heaviest.json)
        estimate?.let { add("estimate" to it.json) }
    })
}

data class ProgressSession(val sessionId: Id<Session>, val startedAt: Instant, val movements: List<MovementSessionFact>) {
    val json: Json get() = Json.objectOf("sessionId" to sessionId.json, "startedAt" to Json.of(startedAt.ms),
        "movements" to Json.Arr(movements.map { it.json }))
}

data class StatsProgress(val asOf: Instant, val sessions: List<ProgressSession>, val isComplete: Boolean = true) {
    constructor(log: TrainingLog, asOf: Instant = log.moment.now) : this(asOf,
        log.drawnSessions.filter { !it.isOpen }.mapNotNull { session ->
            val movements = log.sets(session.id).filter { it.kind == "working" }.groupBy { it.exerciseId }
                .toSortedMap().map { (exerciseId, sets) ->
                    val heaviest = sets.sortedWith(compareByDescending<TrainingSet> { it.weightKg }.thenByDescending { it.reps }.thenBy { it.id }).first()
                    val mostReps = sets.sortedWith(compareByDescending<TrainingSet> { it.reps }.thenByDescending { it.weightKg }.thenBy { it.id }).first()
                    val estimate = sets.mapNotNull { set -> set.e1rm?.let { EstimatedFact(set, it) } }
                        .sortedWith(compareByDescending<EstimatedFact> { it.e1rm }.thenBy { it.setId }).firstOrNull()
                    MovementSessionFact(exerciseId, sets.size, PerformedFact(heaviest), PerformedFact(mostReps), estimate)
                }
            if (movements.isEmpty()) null else ProgressSession(session.id, session.startedAt, movements)
        }.sortedWith(compareBy({ it.startedAt }, { it.sessionId })), log.firstPullComplete)
    constructor(read: Reader) : this(TrainingLog(read))

    val json: Json get() = Json.objectOf("asOf" to Json.of(asOf.ms), "sessions" to Json.Arr(sessions.map { it.json }))
    fun movement(exerciseId: Id<Exercise>): MovementProgress = MovementProgress(exerciseId, sessions.mapNotNull { session ->
        session.movements.firstOrNull { it.exerciseId == exerciseId }?.let { MovementProgress.Point(session.sessionId, session.startedAt, it) }
    }, isComplete)
    fun sessionEstimate(id: Id<Session>): Double? = sessions.firstOrNull { it.sessionId == id }?.movements?.mapNotNull { it.estimate?.e1rm }?.maxOrNull()
    fun consistency(now: Instant, zone: Zone): Int? {
        if (!isComplete) return null
        val today = LocalDay.from(now, zone)
        val monday = today.adding(1L - today.weekday)
        val weeks = sessions.map { session ->
            val day = LocalDay.from(session.startedAt, zone)
            day.adding(1L - day.weekday)
        }.toSet()
        if (weeks.size < 2) return null
        return (0..3).count { monday.adding(-7L * it) in weeks }.takeIf { it > 0 }
    }
}

class MovementProgress(val exerciseId: Id<Exercise>, sessions: List<Point>, val isComplete: Boolean = true) {
    data class Point(val id: Id<Session>, val startedAt: Instant, val fact: MovementSessionFact)
    data class Gap(val before: Point, val after: Point)
    val sessions = sessions.sortedWith(compareBy({ it.startedAt }, { it.id }))
    val estimates: List<Point> get() = sessions.filter { it.fact.estimate != null }
    val latest: Point? get() = estimates.lastOrNull()
    val best: Point? get() = if (!isComplete) null else estimates.sortedWith(compareByDescending<Point> { it.fact.estimate!!.e1rm }
        .thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val heaviest: Point? get() = if (!isComplete) null else sessions.sortedWith(compareByDescending<Point> { it.fact.heaviest.weightKg }
        .thenByDescending { it.fact.heaviest.reps }.thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val mostReps: Point? get() = if (!isComplete) null else sessions.sortedWith(compareByDescending<Point> { it.fact.mostReps.reps }
        .thenByDescending { it.fact.mostReps.weightKg }.thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val records: List<Point> get() {
        if (!isComplete) return emptyList()
        val records = mutableListOf<Point>()
        for (point in estimates) if (point.fact.estimate!!.e1rm > (records.lastOrNull()?.fact?.estimate?.e1rm ?: 0.0)) records.add(point)
        return records
    }
    fun window(now: Instant, zone: Zone): MovementProgress {
        val start = LocalDay.from(now, zone).adding(-84)
        return MovementProgress(exerciseId, sessions.filter { it.startedAt <= now && LocalDay.from(it.startedAt, zone) >= start }, isComplete)
    }
    fun hasChart(zone: Zone): Boolean {
        if (!isComplete) return false
        val points = estimates
        if (points.size < 4) return false
        return LocalDay.from(points.first().startedAt, zone).daysUntil(LocalDay.from(points.last().startedAt, zone)) >= 21
    }
    fun gaps(zone: Zone): List<Gap> = estimates.zipWithNext().mapNotNull { (before, after) ->
        if (LocalDay.from(before.startedAt, zone).daysUntil(LocalDay.from(after.startedAt, zone)) > gapDays) Gap(before, after) else null
    }
    companion object { const val gapDays = 21 }
}

fun TrainingLog.readout(session: Id<Session>): SessionReadout? = drawnSessions.firstOrNull { it.id == session }?.let { SessionReadout(it, sets(session)) }
fun TrainingLog.lastTime(exerciseId: Id<Exercise>): LastTime = LastTime.of(exerciseId, this)
val TrainingLog.progress: StatsProgress get() = StatsProgress(this)

object Readout {
    const val noRoutine = "Free session"
    const val openTarget = "open"
    private val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    fun weight(kg: Double, units: GymUnits = GymUnits.kg): String {
        val value = WeightLadder.round(units.display(kg))
        if (!value.isFinite()) return value.toString()
        val hundredths = Quantum.halfAway(abs(value) * 100).toLong()
        val whole = (hundredths / 100).toString()
        val tail = hundredths % 100
        val digits = if (tail == 0L) whole else if (tail % 10 == 0L) "$whole.${tail / 10}" else "$whole.${tail.toString().padStart(2, '0')}"
        return (if (value < 0) "−" else "") + digits
    }
    fun effort(weightKg: Double, reps: Int, units: GymUnits = GymUnits.kg): String = "${weight(weightKg, units)} × $reps"
    fun estimatedWeight(e1rm: Double, units: GymUnits = GymUnits.kg): String =
        weight(Quantum(0.1).rounded(if (units == GymUnits.lb) e1rm / GymUnits.kilogramsPerPound else e1rm))
    fun estimate(e1rm: Double, units: GymUnits = GymUnits.kg): String = "e1RM ${estimatedWeight(e1rm, units)}"
    fun repTarget(reps: Int?): String = reps?.toString() ?: "max"
    fun setTarget(set: SetTarget): String = "${set.weightKg?.let { weight(it) } ?: "last"} × ${repTarget(set.reps)}"
    fun ladder(sets: List<SetTarget>): String = sets.joinToString(" · ") { setTarget(it) }
    fun target(sets: List<SetTarget>?): String {
        if (sets.isNullOrEmpty()) return openTarget
        val reps = sets.mapNotNull { it.reps }
        val loads = sets.mapNotNull { it.weightKg }.map(WeightLadder::round)
        val repColumn = if (reps.isEmpty()) "max" else if (reps.size < sets.size) "${reps.min()}–max" else
            if (reps.min() == reps.max()) reps.min().toString() else "${reps.min()}–${reps.max()}"
        if (loads.isEmpty()) return "${sets.size} × $repColumn"
        val load = if (loads.size < sets.size) "${weight(loads.min())}–last" else
            if (loads.min() == loads.max()) weight(loads.min()) else "${weight(loads.min())}–${weight(loads.max())}"
        return "${sets.size} × $repColumn · $load"
    }
    fun tonnes(kg: Double): String? {
        if (!kg.isFinite() || kg <= 0) return null
        val tenths = Quantum.halfAway(kg / 100).toLong()
        return if (tenths > 0) "${tenths / 10}.${tenths % 10} t" else null
    }
    fun duration(milliseconds: Long): String {
        val minutes = maxOf(1L, milliseconds / 60_000)
        return if (minutes < 60) "${minutes}m" else "${minutes / 60}h ${(minutes % 60).toString().padStart(2, '0')}m"
    }
    fun briefDay(instant: Instant, now: Instant, zone: Zone): String {
        val day = LocalDay.from(instant, zone)
        val today = LocalDay.from(now, zone)
        if (day == today) return "today"
        val date = "${day.day} ${months[day.month - 1]}"
        return if (day.year == today.year) date else "$date ${day.year}"
    }
    fun ago(instant: Instant, now: Instant, zone: Zone): String {
        val days = LocalDay.from(instant, zone).daysUntil(LocalDay.from(now, zone))
        if (days <= 0) return "today"
        return if (days == 1L) "yesterday" else "$days days ago"
    }
}
