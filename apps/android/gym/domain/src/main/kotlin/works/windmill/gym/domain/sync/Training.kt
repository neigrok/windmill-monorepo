package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

data class Session(override val id: Id<Session>, val startedAt: Instant, val finishedAt: Instant? = null,
    val closedBy: String? = null, val routineId: Id<Routine>? = null, val historyRoutineId: Id<Routine>? = routineId,
    val plan: PlanSnapshot? = null, val displayName: String? = null) : Entity<Session> {
    val isOpen: Boolean get() = finishedAt == null
    val name: String? get() = displayName ?: plan?.routine
    fun fields(): Map<String, Json> = mapOf("startedAt" to Json.of(startedAt.ms), "finishedAt" to (finishedAt?.ms?.let(Json::of) ?: Json.Null),
        "closedBy" to (closedBy?.let(Json::of) ?: Json.Null), "routineId" to (routineId?.json ?: Json.Null),
        "historyRoutineId" to (historyRoutineId?.json ?: Json.Null), "plan" to (plan?.json ?: Json.Null), "displayName" to (displayName?.let(Json::of) ?: Json.Null))
    companion object : EntityType<Session>, RemovableType<Session> {
        override val type = Gym.Types.session
        override val scope = ScopeRef(Gym.scope)
        override val heldRemoval = true
        override fun decode(f: Fields) = Session(Id(f.id, this), f.instant("startedAt"), f.optionalInstant("finishedAt"), f.optionalString("closedBy"),
            f.optionalRef("routineId", Routine), f.optionalRef("historyRoutineId", Routine), PlanSnapshot.decode(f.json("plan")), f.optionalString("displayName"))
    }
}

data class TrainingSet(override val id: Id<TrainingSet>, val sessionId: Id<Session>, val exerciseId: Id<Exercise>,
    val weightKg: Double, val reps: Int, val kind: String = "working", val rpe: Double? = null, val note: String = "",
    val completedAt: Instant, val setNumber: Int? = null) : Writable<TrainingSet> {
    override fun fields(): Map<String, Json> = mapOf("sessionId" to sessionId.json, "exerciseId" to exerciseId.json, "weightKg" to Json.of(weightKg),
        "reps" to Json.of(reps), "kind" to Json.of(kind), "rpe" to (rpe?.let(Json::of) ?: Json.Null), "note" to Json.of(note), "completedAt" to Json.of(completedAt.ms))
    val volumeKg: Double get() = if (kind == "working") maxOf(0.0, weightKg) * reps else 0.0
    val e1rm: Double? get() = if (kind == "working" && weightKg > 0) works.windmill.sync.core.Quantum(0.1).rounded(weightKg * (1 + reps / 30.0)) else null
    companion object : WritableType<TrainingSet>, RemovableType<TrainingSet> {
        override val type = Gym.Types.set
        override val scope = ScopeRef(Gym.scope)
        override val heldRemoval = true
        override fun decode(f: Fields) = TrainingSet(Id(f.id, this), f.ref("sessionId", Session), f.ref("exerciseId", Exercise), f.double("weightKg"),
            f.int("reps"), f.string("kind", "working"), f.optionalDouble("rpe"), f.string("note", ""), f.instant("completedAt"), f.serial("setNumber") ?: f.optionalInt("setNumber"))
        override val checks = listOf(
            Check<TrainingSet>("weightKg") { value, _ -> value.copy(weightKg = SetRules.weightKg.apply(value.weightKg, Path("weightKg"))) },
            Check<TrainingSet>("reps") { value, _ -> value.copy(reps = SetRules.reps.apply(value.reps, Path("reps"))) },
            Check<TrainingSet>("kind") { value, _ -> value.copy(kind = SetRules.kind.apply(value.kind, Path("kind"))) },
            Check<TrainingSet>("rpe") { value, _ -> value.copy(rpe = SetRules.rpe.applyOptional(value.rpe, Path("rpe"))) },
            Check<TrainingSet>("note") { value, _ -> value.copy(note = SetRules.note.apply(value.note, Path("note"))) },
            Check<TrainingSet>("completedAt") { value, _ -> SessionRules.instant(value.completedAt, "set.completedAt", Path("completedAt")); value },
        )
    }
}

object SetRules {
    val weightKg = NumberSpec("set.weightKg", -500.0, 500.0, quantum = 0.01)
    val reps = NumberSpec("set.reps", 1.0, 500.0, integer = true)
    val kind = ChoiceSpec("set.kind", listOf("warmup", "working", "drop", "failure"))
    val rpe = NumberSpec("set.rpe", 1.0, 10.0, quantum = 0.1)
    val note = TextSpec("set.note", MeasureUnit.bytes, 0, 4000, trim = false, nfc = false)
    val rules = listOf(weightKg, reps, kind, rpe, note).map(Rule::local) + Rule.local("set.completedAt", Gym.Types.set)
    fun nextNumber(sets: List<TrainingSet>, sessionId: Id<Session>, exerciseId: Id<Exercise>): Int? {
        val last = sets.filter { it.sessionId == sessionId && it.exerciseId == exerciseId }.maxOfOrNull { it.setNumber ?: 0 } ?: 0
        return if (last == Int.MAX_VALUE) null else last + 1
    }
}

object SessionRules {
    const val staleAfterMs = 4L * 60 * 60 * 1000
    const val maxClockAheadMs = 5L * 60 * 1000
    const val maxInstantMs = 253402300799000L
    fun instant(value: Instant, rule: String, path: Path) {
        if (value.ms <= 0) throw Violation(rule, path, Violation.Reason.Below(1.0))
        if (value.ms > maxInstantMs) throw Violation(rule, path, Violation.Reason.Above(maxInstantMs.toDouble()))
    }
    fun lastActivity(session: Session, sets: List<TrainingSet>): Instant =
        sets.filter { it.sessionId == session.id }.maxOfOrNull { it.completedAt } ?: session.startedAt
    fun autoCloseAt(session: Session, sets: List<TrainingSet>, now: Instant): Instant? {
        if (!session.isOpen) return null
        val last = lastActivity(session, sets)
        return last.takeIf { now.ms - it.ms >= staleAfterMs }
    }
    fun drawn(session: Session, sets: List<TrainingSet>, now: Instant): Session =
        autoCloseAt(session, sets, now)?.let { session.copy(finishedAt = it, closedBy = "stale") } ?: session
    fun canFinishAt(session: Session, at: Instant): Boolean = at.ms in session.startedAt.ms..maxInstantMs && at.ms > 0
    fun canStartAt(at: Instant, now: Instant): Boolean = at.ms > 0 && at.ms <= maxInstantMs && at.ms - now.ms <= maxClockAheadMs
    fun lateSetLands(session: Session, completedAt: Instant): Boolean {
        val finish = session.finishedAt ?: return true
        return session.closedBy == "stale" && completedAt.ms <= finish.ms + staleAfterMs
    }
    fun finish(session: Session, at: Instant): Session {
        if (!canFinishAt(session, at)) throw Violation("session.finishedAt", Path("finishedAt"), Violation.Reason.Custom("badInstant"))
        val finish = session.finishedAt
        if (finish == null) return session.copy(finishedAt = at, closedBy = "finish")
        if (session.closedBy != "stale") return session
        return session.copy(finishedAt = if (at.ms > finish.ms + staleAfterMs) finish else maxOf(finish, at), closedBy = "finish")
    }
    fun crosses(startedAt: Instant, finishedAt: Instant, other: Session): Boolean {
        val otherFinish = other.finishedAt ?: return false
        val end = maxOf(finishedAt.ms, startedAt.ms + 1)
        val otherEnd = maxOf(otherFinish.ms, other.startedAt.ms + 1)
        return startedAt.ms < otherEnd && other.startedAt.ms < end
    }
}

data class TrainingLog(val sessions: List<Session>, val sets: List<TrainingSet>, val moment: Moment) {
    constructor(read: Reader) : this(read.repository(Session).all(works.windmill.sync.api.ViewMode.drawn), read.repository(TrainingSet).all(works.windmill.sync.api.ViewMode.drawn), read.moment)
    val drawnSessions: List<Session> get() = sessions.map { SessionRules.drawn(it, sets, moment.now) }.sortedByDescending { it.startedAt }
    val open: Session? get() = drawnSessions.firstOrNull { it.isOpen }
    val liveHint: Boolean get() = open != null
    fun sets(session: Id<Session>): List<TrainingSet> = sets.filter { it.sessionId == session }.sortedWith(compareBy({ it.completedAt }, { it.id }))
    fun volumeKg(session: Id<Session>): Double = sets(session).sumOf { it.volumeKg }
    fun topE1rm(session: Id<Session>): Double? = sets(session).mapNotNull { it.e1rm }.maxOrNull()
}
