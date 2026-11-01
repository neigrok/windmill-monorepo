package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.Quantum

object GymVolume {
    fun total(parts: List<VolumePart>): Double? {
        var total = 0.0
        for (part in parts.sortedBy { it.id }) {
            total += part.kg ?: return null
            if (!total.isFinite()) return null
        }
        return total
    }
    fun of(sets: List<TrainingSet>, catalogue: Catalogue): Double? = total(sets.map {
        VolumePart(it.id.json.jcs, it.weightKg, it.reps, catalogue.find(it.exerciseId)?.loadCount)
    })
}

class EstimateScore(weightKg: Double, reps: Int) : Comparable<EstimateScore> {
    val digits: String
    val exponent: Int

    init {
        require(weightKg.isFinite() && weightKg >= 0 && reps in 1..10)
        val parts = Json.of(Quantum(0.01).rounded(weightKg)).jcs.split('e')
        val mantissa = parts[0].split('.')
        var power = (if (parts.size == 2) parts[1].toInt() else 0) + 2 - (if (mantissa.size == 2) mantissa[1].length else 0)
        val product = mantissa.joinToString("").trimStart('0').ifEmpty { "0" }.toCharArray()
        var carry = 0
        val factor = if (reps == 1) 30 else 30 + reps
        for (index in product.indices.reversed()) {
            val number = (product[index] - '0') * factor + carry
            product[index] = ('0'.code + number % 10).toChar()
            carry = number / 10
        }
        val multiplied = (if (carry > 0) carry.toString() else "") + product.concatToString()
        val compact = multiplied.trimEnd('0')
        power += multiplied.length - compact.length
        digits = compact.ifEmpty { "0" }
        exponent = if (digits == "0") 0 else power
    }

    override fun compareTo(other: EstimateScore): Int {
        if (digits == "0" || other.digits == "0") return (digits != "0").compareTo(other.digits != "0")
        val length = digits.length + exponent
        val otherLength = other.digits.length + other.exponent
        if (length != otherLength) return length.compareTo(otherLength)
        for (index in 0 until maxOf(digits.length, other.digits.length)) {
            val left = digits.getOrElse(index) { '0' }
            val right = other.digits.getOrElse(index) { '0' }
            if (left != right) return left.compareTo(right)
        }
        return 0
    }
    override fun equals(other: Any?): Boolean = other is EstimateScore && digits == other.digits && exponent == other.exponent
    override fun hashCode(): Int = 31 * digits.hashCode() + exponent
    companion object { val zero = EstimateScore(0.0, 1) }
}

object GymEstimate {
    fun qualifies(weightKg: Double, reps: Int, rpe: Double?): Boolean = weightKg.isFinite() && weightKg > 0 && reps in 1..10 &&
        (rpe == null || rpe.isFinite() && rpe >= 7)

    fun value(weightKg: Double, reps: Int, rpe: Double? = null): Double? {
        if (!qualifies(weightKg, reps, rpe)) return null
        val value = if (reps == 1) weightKg else weightKg * (1 + reps / 30.0)
        return value.takeIf { it.isFinite() }
    }

    fun score(weightKg: Double, reps: Int, rpe: Double? = null): EstimateScore? {
        if (!qualifies(weightKg, reps, rpe)) return null
        return EstimateScore(weightKg, reps)
    }

    fun stated(e1rm: Double): Double = Quantum(0.1).rounded(e1rm)

    fun top(sets: List<TrainingSet>): Double? {
        val eligible = sets.filter { qualifies(it.weightKg, it.reps, it.rpe) }
        if (eligible.any { it.e1rm == null }) return null
        return eligible.mapNotNull { it.e1rm }.maxOrNull()
    }
}

class SessionReadout(session: Session, sets: List<TrainingSet>, catalogue: Catalogue) {
    val sessionId = session.id
    val name = session.name
    val durationMs = session.finishedAt?.let { maxOf(0, it.ms - session.startedAt.ms) }
    val workingSetCount = sets.count { it.sessionId == session.id }
    val movementCount = sets.filter { it.sessionId == session.id }.map { it.exerciseId }.toSet().size
    val volumeKg = GymVolume.of(sets.filter { it.sessionId == session.id }, catalogue)
    val topE1rm = GymEstimate.top(sets.filter { it.sessionId == session.id })
}

data class LastTime(val exerciseId: Id<Exercise>, val session: Session? = null,
    val sets: List<TrainingSet> = emptyList(), val isComplete: Boolean = true) {
    val routine: String? get() = session?.name
    val isFirstTime: Boolean get() = isComplete && session == null

    companion object {
        fun of(exerciseId: Id<Exercise>, log: TrainingLog): LastTime {
            for (session in log.drawnSessions.filter { !it.isOpen }) {
                val sets = log.sets(session.id).filter { it.exerciseId == exerciseId }
                if (sets.isNotEmpty()) return LastTime(exerciseId, session, sets, log.firstPullComplete)
            }
            return LastTime(exerciseId, isComplete = log.firstPullComplete)
        }
    }
}

// The last set of each movement's last finished workout in logged order, at that workout's start. A set number is the
// server's serial and absent until it answers, so it never orders the sets. Sparse: a movement absent is never logged,
// which holds only once the account's history has been read.
data class LastSet(val exerciseId: Id<Exercise>, val weightKg: Double, val reps: Int, val at: Instant) {
    companion object {
        fun all(log: TrainingLog): List<LastSet> = log.drawnSessions.filter { !it.isOpen }.flatMap { log.sets(it.id) }.map { it.exerciseId }
            .distinct().sorted().mapNotNull { id ->
                val last = log.lastTime(id)
                last.sets.maxWithOrNull(compareBy<TrainingSet> { it.completedAt }.thenBy { it.id })
                    ?.let { LastSet(id, it.weightKg, it.reps, last.session!!.startedAt) }
            }
    }
}

data class Prefill(val weightKg: Double = emptyBarKg, val reps: Int = emptyBarReps) {
    companion object {
        const val emptyBarKg = 20.0
        const val emptyBarReps = 5
        fun of(todaySets: List<TrainingSet>, planEntry: RoutineEntry?, lastTime: LastTime?): Prefill =
            at(todaySets.size, todaySets.lastOrNull()?.let { Prefill(it.weightKg, maxOf(1, it.reps)) }, planEntry, lastTime)

        // The load the rack offers at each set the plan still holds, the set in hand first, each later set offered as though
        // the one before it were logged as offered. A load that would come from a last time not read yet is null.
        fun offeredLoads(todaySets: List<TrainingSet>, planEntry: RoutineEntry?, lastTime: LastTime): List<Double?> {
            val scheme = planEntry?.sets.orEmpty()
            val slots = todaySets.size until scheme.size
            if (lastTime.session != null || lastTime.isComplete) {
                var sticky = todaySets.lastOrNull()?.let { Prefill(it.weightKg, maxOf(1, it.reps)) }
                return slots.map { slot -> at(slot, sticky, planEntry, lastTime).also { sticky = it }.weightKg }
            }
            val straight = scheme.all { it == scheme.first() }
            var sticky: Double? = todaySets.lastOrNull()?.weightKg
            return slots.map { slot -> (if (straight) sticky ?: scheme.first().weightKg else scheme[slot].weightKg).also { sticky = it } }
        }

        // The offer at a slot, `sticky` being the set logged just before it.
        fun at(slot: Int, sticky: Prefill?, planEntry: RoutineEntry?, lastTime: LastTime?): Prefill {
            val scheme = planEntry?.sets.orEmpty()
            val history = lastTime?.sets.orEmpty()
            val straight = scheme.firstOrNull()?.let { first -> scheme.all { it == first } } ?: true
            if (scheme.isNotEmpty() && !straight) {
                val target = scheme.getOrNull(slot)
                val lastNth = history.getOrNull(slot)
                return Prefill(target?.weightKg ?: lastNth?.weightKg ?: sticky?.weightKg ?: emptyBarKg,
                    maxOf(1, target?.reps ?: lastNth?.reps ?: sticky?.reps ?: emptyBarReps))
            }
            if (sticky != null) return sticky
            val planned = scheme.firstOrNull()
            return Prefill(planned?.weightKg ?: history.lastOrNull()?.weightKg ?: emptyBarKg,
                maxOf(1, planned?.reps ?: history.firstOrNull()?.reps ?: emptyBarReps))
        }
    }
}

// The rest a movement asks between its sets: its plan entry's, else the lifter's rest preference, else none. The rest is
// reached the moment the time since the last set comes to it.
data class RestTarget(val seconds: Int) {
    fun isReached(sinceMs: Long): Boolean = sinceMs >= seconds * 1_000L

    companion object {
        fun of(entry: RoutineEntry?, rest: RestSettings): RestTarget? = (entry?.restSeconds ?: rest.seconds)?.let(::RestTarget)
    }
}

data class PerformedFact(val setId: Id<TrainingSet>, val weightKg: Double, val reps: Int, val rpe: Double? = null) {
    constructor(set: TrainingSet) : this(set.id, set.weightKg, set.reps, set.rpe)
    val json: Json get() = Json.Obj(buildList {
        add("setId" to setId.json); add("weightKg" to Json.of(weightKg)); add("reps" to Json.of(reps))
        rpe?.let { add("rpe" to Json.of(it)) }
    })
}

data class EstimatedFact(val performed: PerformedFact, val e1rm: Double?) {
    constructor(set: TrainingSet, e1rm: Double?) : this(PerformedFact(set), e1rm)
    val setId get() = performed.setId
    val weightKg get() = performed.weightKg
    val reps get() = performed.reps
    val rpe get() = performed.rpe
    val score get() = GymEstimate.score(weightKg, reps, rpe) ?: EstimateScore.zero
    val json: Json get() = Json.Obj(performed.json.obj().toList() + ("e1rm" to (e1rm?.let(Json::of) ?: Json.Null)))
}

data class MovementSessionFact(val exerciseId: Id<Exercise>, val workingSetCount: Int,
    val heaviest: PerformedFact, val mostReps: PerformedFact, val estimate: EstimatedFact? = null,
    val bodyweightReps: PerformedFact? = null, val estimatesComplete: Boolean = true) {
    val json: Json get() = Json.Obj(buildList {
        add("exerciseId" to exerciseId.json); add("workingSetCount" to Json.of(workingSetCount)); add("heaviest" to heaviest.json)
        estimate?.let { add("estimate" to it.json) }
        if (!estimatesComplete) add("estimatesComplete" to Json.Bool(false))
    })
}

data class ProgressSession(val sessionId: Id<Session>, val startedAt: Instant, val movements: List<MovementSessionFact>) {
    val json: Json get() = Json.objectOf("sessionId" to sessionId.json, "startedAt" to Json.of(startedAt.ms),
        "movements" to Json.Arr(movements.map { it.json }))
}

data class StatsProgress(val asOf: Instant, val sessions: List<ProgressSession>, val isComplete: Boolean = true) {
    constructor(log: TrainingLog, asOf: Instant = log.moment.now) : this(asOf,
        log.drawnSessions.filter { !it.isOpen }.mapNotNull { session ->
            val movements = log.sets(session.id).groupBy { it.exerciseId }
                .toSortedMap().map { (exerciseId, sets) ->
                    val heaviest = sets.sortedWith(compareByDescending<TrainingSet> { it.weightKg }.thenByDescending { it.reps }.thenBy { it.id }).first()
                    val mostReps = sets.sortedWith(compareByDescending<TrainingSet> { it.reps }.thenByDescending { it.weightKg }.thenBy { it.id }).first()
                    val estimates = sets.filter { GymEstimate.qualifies(it.weightKg, it.reps, it.rpe) }.map { EstimatedFact(it, it.e1rm) }
                    val estimate = estimates
                        .sortedWith(compareByDescending<EstimatedFact> { it.score }.thenBy { it.setId }).firstOrNull()
                    val bodyweightReps = sets.filter { it.weightKg == 0.0 }.sortedWith(compareByDescending<TrainingSet> { it.reps }.thenBy { it.id }).firstOrNull()
                    MovementSessionFact(exerciseId, sets.size, PerformedFact(heaviest), PerformedFact(mostReps), estimate,
                        bodyweightReps?.let(::PerformedFact), estimates.all { it.e1rm != null })
                }
            if (movements.isEmpty()) null else ProgressSession(session.id, session.startedAt, movements)
        }.sortedWith(compareBy({ it.startedAt }, { it.sessionId })), log.firstPullComplete)
    constructor(read: Reader) : this(TrainingLog(read))

    val json: Json get() = Json.objectOf("asOf" to Json.of(asOf.ms), "sessions" to Json.Arr(sessions.map { it.json }))
    fun movement(exerciseId: Id<Exercise>): MovementProgress = MovementProgress(exerciseId, sessions.mapNotNull { session ->
        session.movements.firstOrNull { it.exerciseId == exerciseId }?.let { MovementProgress.Point(session.sessionId, session.startedAt, it) }
    }, isComplete)
    fun sessionEstimate(id: Id<Session>): Double? {
        val movements = sessions.firstOrNull { it.sessionId == id }?.movements ?: return null
        if (movements.any { !it.estimatesComplete }) return null
        return movements.mapNotNull { it.estimate?.e1rm }.maxOrNull()
    }
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
    val estimatesComplete: Boolean get() = sessions.all { it.fact.estimatesComplete }
    val estimates: List<Point> get() = if (estimatesComplete) sessions.filter { it.fact.estimate?.e1rm != null } else emptyList()
    val latest: Point? get() = estimates.lastOrNull()
    val best: Point? get() = if (!isComplete || !estimatesComplete) null else estimates.sortedWith(compareByDescending<Point> { it.fact.estimate!!.score }
        .thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val heaviest: Point? get() = if (!isComplete) null else sessions.sortedWith(compareByDescending<Point> { it.fact.heaviest.weightKg }
        .thenByDescending { it.fact.heaviest.reps }.thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val mostReps: Point? get() = if (!isComplete) null else sessions.sortedWith(compareByDescending<Point> { it.fact.mostReps.reps }
        .thenByDescending { it.fact.mostReps.weightKg }.thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val bodyweightReps: Point? get() = if (!isComplete) null else sessions.filter { it.fact.bodyweightReps != null }
        .sortedWith(compareByDescending<Point> { it.fact.bodyweightReps!!.reps }.thenBy { it.startedAt }.thenBy { it.id }).firstOrNull()
    val records: List<Point> get() {
        if (!isComplete || !estimatesComplete) return emptyList()
        val records = mutableListOf<Point>()
        for (point in estimates) if (records.isEmpty() || GymEstimate.stated(point.fact.estimate!!.e1rm!!) >
            GymEstimate.stated(records.last().fact.estimate!!.e1rm!!)) records.add(point)
        return records
    }
    fun window(now: Instant, zone: Zone): MovementProgress {
        val start = LocalDay.from(now, zone).adding(-84)
        return MovementProgress(exerciseId, sessions.filter { it.startedAt <= now && LocalDay.from(it.startedAt, zone) >= start }, isComplete)
    }
    fun hasChart(zone: Zone): Boolean {
        if (!isComplete || !estimatesComplete) return false
        val points = estimates
        if (points.size < 4) return false
        return LocalDay.from(points.first().startedAt, zone).daysUntil(LocalDay.from(points.last().startedAt, zone)) >= 21
    }
    fun gaps(zone: Zone): List<Gap> = estimates.zipWithNext().mapNotNull { (before, after) ->
        if (LocalDay.from(before.startedAt, zone).daysUntil(LocalDay.from(after.startedAt, zone)) > gapDays) Gap(before, after) else null
    }
    companion object { const val gapDays = 21 }
}

// The log's new bests: a movement's first estimate is its baseline; a new best beats the best before it as stated.
class ProgressRecords(val progress: StatsProgress) {
    data class Record(val point: MovementProgress.Point, val previous: MovementProgress.Point, val estimate: Double, val gain: Double)
    data class Stated(val point: MovementProgress.Point, val estimate: Double)
    constructor(read: Reader) : this(StatsProgress(read))

    val movements: Map<Id<Exercise>, List<Record>>
    val sessions: Set<Id<Session>>

    init {
        val series = linkedMapOf<Id<Exercise>, MutableList<Stated>>()
        if (progress.isComplete) for (session in progress.sessions) for (fact in session.movements) {
            if (!progress.movement(fact.exerciseId).estimatesComplete) continue
            val estimate = fact.estimate?.e1rm ?: continue
            series.getOrPut(fact.exerciseId) { mutableListOf() } +=
                Stated(MovementProgress.Point(session.sessionId, session.startedAt, fact), GymEstimate.stated(estimate))
        }
        movements = series.mapValues { (_, estimates) ->
            var best = estimates.first()
            val run = mutableListOf<Record>()
            for (next in estimates.drop(1)) {
                val gain = GymEstimate.stated(next.estimate - best.estimate)
                if (gain <= 0) continue
                run += Record(next.point, best.point, next.estimate, gain)
                best = next
            }
            run.toList()
        }.filterValues { it.isNotEmpty() }
        sessions = movements.values.flatten().mapTo(mutableSetOf()) { it.point.id }
    }
}

// The log's top set: the heaviest load, then the most reps at it.
fun topSet(sets: List<TrainingSet>): TrainingSet? =
    sets.sortedWith(compareByDescending<TrainingSet> { it.weightKg }.thenByDescending { it.reps }.thenBy { it.id }).firstOrNull()

// The record a workout earned against every finished workout before it: a stated estimate gain ranks first, then a
// heavier top set, then more reps at a load. Nothing before the account's first pull, when that history is not yet here.
data class PersonalRecord(val kind: String, val exerciseId: Id<Exercise>, val value: Double, val weightKg: Double, val reps: Int,
    val previous: Double, val previousAt: Instant) {
    val json: Json get() = Json.objectOf("kind" to Json.of(kind), "exerciseId" to exerciseId.json, "value" to Json.of(value), "weightKg" to Json.of(weightKg),
        "reps" to Json.of(reps), "previous" to Json.of(previous), "previousAt" to Json.of(previousAt.ms))

    companion object {
        fun of(session: Session, log: TrainingLog): PersonalRecord? {
            if (!log.firstPullComplete) return null
            val previous = log.drawnSessions.filter { !it.isOpen && (it.startedAt < session.startedAt || (it.startedAt == session.startedAt && it.id < session.id)) }
            val prior = StatsProgress(log.copy(sessions = previous))
            val current = StatsProgress(log.copy(sessions = listOf(session)))
            data class Candidate(val rank: Int, val record: PersonalRecord, val fact: PerformedFact) {
                val score get() = GymEstimate.score(fact.weightKg, fact.reps, fact.rpe) ?: EstimateScore.zero
            }
            fun candidate(rank: Int, kind: String, exercise: Id<Exercise>, fact: PerformedFact, amount: Double, before: Double, beforeAt: Instant) =
                Candidate(rank, PersonalRecord(kind, exercise, amount, fact.weightKg, fact.reps, before, beforeAt), fact)
            val candidates = mutableListOf<Candidate>()
            for (fact in current.sessions.flatMap { it.movements }) {
                val now = fact.estimate
                val before = prior.movement(fact.exerciseId).best
                val amount = now?.e1rm
                val previousEstimate = before?.fact?.estimate?.e1rm
                if (fact.estimatesComplete && now != null && amount != null && before != null && previousEstimate != null && GymEstimate.stated(amount) > GymEstimate.stated(previousEstimate))
                    candidates += candidate(0, "e1rm", fact.exerciseId, now.performed, amount, previousEstimate, before.startedAt)
                val today = log.sets(session.id).filter { it.exerciseId == fact.exerciseId }
                val priors = previous.flatMap { earlier -> log.sets(earlier.id).filter { it.exerciseId == fact.exerciseId }.map { it to earlier } }
                val heavy = priors.sortedWith(compareByDescending<Pair<TrainingSet, Session>> { it.first.weightKg }.thenByDescending { it.first.reps }.thenBy { it.second.startedAt }.thenBy { it.first.id }).firstOrNull()
                val todayTop = topSet(today)
                if (todayTop != null && heavy != null && todayTop.weightKg > heavy.first.weightKg)
                    candidates += candidate(1, "heaviest", fact.exerciseId, PerformedFact(todayTop), todayTop.weightKg, heavy.first.weightKg, heavy.second.startedAt)
                for (load in today.map { it.weightKg }.distinct()) {
                    val atLoad = topSet(today.filter { it.weightKg == load })!!
                    val earlier = priors.filter { it.first.weightKg == load }.sortedWith(compareByDescending<Pair<TrainingSet, Session>> { it.first.reps }.thenBy { it.second.startedAt }.thenBy { it.first.id }).firstOrNull()
                    if (earlier != null && atLoad.reps > earlier.first.reps)
                        candidates += candidate(2, "reps-at-weight", fact.exerciseId, PerformedFact(atLoad), atLoad.reps.toDouble(), earlier.first.reps.toDouble(), earlier.second.startedAt)
                }
            }
            return candidates.sortedWith(compareBy<Candidate> { it.rank }.thenByDescending { it.score }.thenByDescending { it.fact.weightKg }
                .thenBy { it.record.exerciseId }).firstOrNull()?.record
        }
    }
}

// A workout read back: how long and how much, and once it is more than slight, the record it earned and the routine's
// previous workout beside it movement by movement, with what the frozen plan asked.
data class SessionReview(val durationMs: Long, val workingSets: Int, val topE1rm: Double?,
    val record: PersonalRecord? = null, val against: Against? = null) {
    data class Against(val previous: Session, val movements: List<Movement>)
    data class Movement(val exerciseId: Id<Exercise>, val now: List<TrainingSet>, val before: List<TrainingSet>, val planned: RoutineEntry?)

    val slight: Boolean get() = workingSets < slightSets

    val json: Json get() {
        fun effort(sets: List<TrainingSet>): Json? = topSet(sets)?.let { top ->
            Json.objectOf("weightKg" to Json.of(top.weightKg), "reps" to Json.of(top.reps), "sets" to Json.of(sets.count { it.weightKg == top.weightKg }))
        }
        val stats = Json.objectOf("durationMs" to Json.of(durationMs), "workingSets" to Json.of(workingSets), "topE1rm" to (topE1rm?.let(Json::of) ?: Json.Null))
        return Json.Obj(buildList {
            add("stats" to stats); add("slight" to Json.of(slight))
            record?.let { add("record" to it.json) }
            against?.let { against -> add("against" to Json.Obj(buildList {
                add("sessionId" to against.previous.id.json); add("startedAt" to Json.of(against.previous.startedAt.ms))
                against.previous.plan?.routine?.takeIf { it.isNotEmpty() }?.let { add("routine" to Json.of(it)) }
                add("movements" to Json.Arr(against.movements.map { movement -> Json.Obj(buildList {
                    add("exerciseId" to movement.exerciseId.json); add("now" to (effort(movement.now) ?: Json.Null))
                    effort(movement.before)?.let { add("before" to it) }
                    movement.planned?.let { add("planned" to Json.Obj(if (it.sets == null) emptyList() else listOf("sets" to Json.Arr(it.sets.map { target -> target.json })))) }
                }) }))
            })) }
        })
    }

    companion object {
        const val slightSets = 4

        fun of(id: Id<Session>, log: TrainingLog): SessionReview? {
            val value = log.drawnSessions.firstOrNull { it.id == id } ?: return null
            val facts = log.readout(id)!!
            val read = SessionReview(facts.durationMs ?: maxOf(0, SessionRules.lastActivity(value, log.sets).ms - value.startedAt.ms),
                facts.workingSetCount, facts.topE1rm)
            if (read.slight) return read
            val held = log.sets(id)
            val previous = log.drawnSessions.firstOrNull { !it.isOpen && it.routineId == value.routineId && value.routineId != null &&
                (it.startedAt < value.startedAt || (it.startedAt == value.startedAt && it.id < value.id)) }
            return read.copy(record = PersonalRecord.of(value, log), against = previous?.let { before ->
                Against(before, held.map { it.exerciseId }.distinct().map { exercise ->
                    Movement(exercise, held.filter { it.exerciseId == exercise }, log.sets(before.id).filter { it.exerciseId == exercise },
                        value.plan?.entries?.firstOrNull { it.exerciseId == exercise })
                })
            })
        }
    }
}

fun TrainingLog.readout(session: Id<Session>): SessionReadout? = drawnSessions.firstOrNull { it.id == session }?.let { SessionReadout(it, sets(session), catalogue) }
fun TrainingLog.lastTime(exerciseId: Id<Exercise>): LastTime = LastTime.of(exerciseId, this)
val TrainingLog.progress: StatsProgress get() = StatsProgress(this)

object Readout {
    const val noRoutine = "Free session"
    const val openTarget = "open"
    private val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    fun weight(kg: Double, units: GymUnits = GymUnits.kg): String {
        val value = WeightLadder.round(units.display(kg))
        if (!value.isFinite()) return "—"
        return Json.of(value).jcs.replace('-', '−')
    }
    fun effort(weightKg: Double, reps: Int, units: GymUnits = GymUnits.kg): String = "${weight(weightKg, units)} × $reps"
    fun estimatedWeight(e1rm: Double, units: GymUnits = GymUnits.kg): String =
        weight(GymEstimate.stated(if (units == GymUnits.lb) e1rm / GymUnits.kilogramsPerPound else e1rm))
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
    fun loadUnit(equipment: String?, loadCount: Int): String = when (equipment) {
        "dumbbell" -> if (loadCount == 2) "kg each" else "kg"
        "barbell", "machine" -> "kg total"
        "bodyweight" -> "kg added"
        else -> "kg"
    }
    fun tonnes(kg: Double): String? {
        if (!kg.isFinite() || kg <= 0) return null
        val tonnes = Quantum(0.1).rounded(kg / 1000)
        if (tonnes <= 0) return null
        val digits = Json.of(tonnes).jcs
        return "${if ('.' in digits || 'e' in digits) digits else "$digits.0"} t"
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
