package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.schema.Gym

internal class GymCommand(override val name: String, override val args: Map<String, Json>) : ServerCommand {
    override val specs: List<ValueSpec> get() = Companion.specs[name] ?: emptyList()
    companion object {
        val specs: Map<String, List<ValueSpec>> = mapOf(
            Gym.Commands.importSession to listOf(
                TextSpec("gym.importSession.sets.id", works.windmill.sync.core.MeasureUnit.chars, 8, 64, false, false),
                TextSpec("gym.importSession.sets.exerciseId", works.windmill.sync.core.MeasureUnit.chars, 1, 64, false, false),
                ChoiceSpec("gym.importSession.sets.kind", listOf("warmup", "working", "drop", "failure")),
                TextSpec("gym.importSession.sets.note", works.windmill.sync.core.MeasureUnit.bytes, 0, 4000, false, false),
            ),
            Gym.Commands.correctSession to listOf(
                TextSpec("gym.correctSession.requestId", works.windmill.sync.core.MeasureUnit.chars, 8, 64, false, false),
                TextSpec("gym.correctSession.routineName", works.windmill.sync.core.MeasureUnit.bytes, 0, 240, false, false),
                TextSpec("gym.correctSession.sets.id", works.windmill.sync.core.MeasureUnit.chars, 8, 64, false, false),
                TextSpec("gym.correctSession.sets.exerciseId", works.windmill.sync.core.MeasureUnit.chars, 1, 64, false, false),
                TextSpec("gym.correctSession.sets.note", works.windmill.sync.core.MeasureUnit.bytes, 0, 4000, false, false),
                ChoiceSpec("gym.correctSession.sets.kind", listOf("warmup", "working", "drop", "failure")),
            ),
        )
    }
}

data class TrainingState(val drawn: List<Session>, val stored: List<Session>, val sets: List<TrainingSet>, val catalogue: Catalogue, val moment: Moment, val drawnSets: List<TrainingSet> = sets) {
    constructor(read: Reader) : this(read.repository(Session).all(ViewMode.drawn), read.repository(Session).all(ViewMode.stored),
        read.repository(TrainingSet).all(ViewMode.stored), Catalogue(read, ViewMode.stored), read.moment, read.repository(TrainingSet).all(ViewMode.drawn))
    fun session(id: Id<Session>): Session? = stored.firstOrNull { it.id == id } ?: drawn.firstOrNull { it.id == id }
    fun overlap(start: Instant, finish: Instant, excluding: Id<Session>): Session? = stored
        .filter { it.id != excluding && SessionRules.crosses(start, finish, it) }.minWithOrNull(compareBy({ it.startedAt }, { it.id }))
}

class StartSession(val id: Id<Session>, val routineId: Id<Routine>? = null, val startedAt: Instant? = null) : Action<StartSession.Loaded, Id<Session>, GymRefusal> {
    data class Loaded(val state: TrainingState, val routine: Routine?, val prior: Boolean)
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = Loaded(TrainingState(read), routineId?.let { read.repository(Routine).find(it, ViewMode.drawn) }, read.repository(Session).record(id, ViewMode.stored) != null)
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Id<Session>, GymRefusal> {
        if (loaded.prior) return Decision.Unchanged(id)
        val at = startedAt ?: loaded.state.moment.now
        val open = loaded.state.stored.firstOrNull { SessionRules.drawn(it, loaded.state.sets, loaded.state.moment.now).isOpen }
        val args = buildMap {
            put("id", id.json); routineId?.let { put("routineId", it.json) }; put("startedAt", Json.of(at.ms)); put("joinOpenSession", Json.of(true))
        }
        if (open != null) return Decision.Write(Plan(GymCommand(Gym.Commands.start, args)), open.id)
        SessionRules.instant(at, "session.startedAt", Path("startedAt"))
        val routine = loaded.routine
        val predicted = Session(id, at, routineId = routine?.id, plan = routine?.let(::PlanSnapshot))
        return Decision.Write(Plan(GymCommand(Gym.Commands.start, args), listOf(Prediction.create(Session, id, predicted.fields()))), id)
    }
}

class FinishSession(val id: Id<Session>, val finishedAt: Instant? = null) : Action<TrainingState, Unit, GymRefusal> {
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = TrainingState(read)
    override fun decide(loaded: TrainingState, ids: IDSource): Decision<Unit, GymRefusal> {
        val session = loaded.session(id)?.takeIf { loaded.drawn.any { drawn -> drawn.id == id } } ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted)))
        val at = finishedAt ?: loaded.moment.now
        if (!SessionRules.canFinishAt(session, at)) return Decision.Refuse(GymRefusal.of(Refused(RefusalCode(Gym.Codes.badInstant), id.ref, path = Refused.Path.predicted)))
        val finished = SessionRules.finish(session, at)
        if (finished == session) return Decision.Unchanged(Unit)
        return Decision.Write(Plan(GymCommand(Gym.Commands.finish, mapOf("sessionId" to id.json, "finishedAt" to Json.of(at.ms))),
            listOf(Prediction.update(Session, id, mapOf("finishedAt" to Json.of(finished.finishedAt!!.ms), "closedBy" to Json.of("finish"))))), Unit)
    }
}

class AppendSet(val value: TrainingSet) : Action<TrainingState, Id<TrainingSet>, GymRefusal> {
    override val scope = TrainingSet.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = TrainingState(read)
    override fun decide(loaded: TrainingState, ids: IDSource): Decision<Id<TrainingSet>, GymRefusal> {
        val valid = Valid(value, TrainingSet, at = loaded.moment)
        val session = loaded.session(value.sessionId)?.takeIf { loaded.drawn.any { drawn -> drawn.id == value.sessionId } }
            ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, value.sessionId.ref, path = Refused.Path.predicted)))
        if (!SessionRules.lateSetLands(session, value.completedAt)) return Decision.Refuse(GymRefusal.of(Refused(RefusalCode(Gym.Codes.sessionFinished), value.id.ref, path = Refused.Path.predicted)))
        if (loaded.catalogue.find(value.exerciseId) == null) return Decision.Refuse(GymRefusal.of(Refused(RefusalCode(Gym.Codes.unknownExercise), value.id.ref, path = Refused.Path.predicted)))
        val existing = loaded.sets.firstOrNull { it.id == value.id }
        if (existing != null) return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.idTaken, value.id.ref, path = Refused.Path.predicted)))
        if (SetRules.nextNumber(loaded.sets, value.sessionId, value.exerciseId) == null)
            throw Violation("set.setNumber", Path("setNumber"), Violation.Reason.Above(Int.MAX_VALUE.toDouble()))
        val plan = Plan()
        plan.create(valid)
        return Decision.Write(plan, value.id)
    }
}

class CorrectSet(val value: TrainingSet) : Action<TrainingState, Unit, GymRefusal> {
    override val scope = TrainingSet.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = TrainingState(read)
    override fun decide(loaded: TrainingState, ids: IDSource): Decision<Unit, GymRefusal> {
        val old = loaded.sets.firstOrNull { it.id == value.id && loaded.drawnSets.any { drawn -> drawn.id == value.id } } ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, value.id.ref, path = Refused.Path.predicted)))
        if (old.sessionId != value.sessionId || old.exerciseId != value.exerciseId || old.completedAt != value.completedAt || old.setNumber != value.setNumber)
            throw Violation("set.identity", Path("id"), Violation.Reason.Custom("immutable"))
        val fields = listOf("weightKg", "reps", "kind", "rpe", "note")
        val valid = Valid(value, TrainingSet, fields, loaded.moment)
        val changed = fields.filter { valid.value.fields()[it] != old.fields()[it] }
        if (changed.isEmpty()) return Decision.Unchanged(Unit)
        val plan = Plan()
        plan.update(valid, changed)
        return Decision.Write(plan, Unit)
    }
}

class DiscardSession(val id: Id<Session>) : Action<TrainingState, Unit, GymRefusal> {
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = TrainingState(read)
    override fun decide(loaded: TrainingState, ids: IDSource): Decision<Unit, GymRefusal> {
        val session = loaded.session(id)?.takeIf { loaded.drawn.any { drawn -> drawn.id == id } } ?: return Decision.Unchanged(Unit)
        if (session.isOpen && SessionRules.autoCloseAt(session, loaded.sets, loaded.moment.now) == null)
            return Decision.Refuse(GymRefusal.of(Refused(RefusalCode(Gym.Codes.sessionOpen), id.ref, path = Refused.Path.predicted)))
        val plan = Plan()
        plan.remove(id)
        return Decision.Write(plan, Unit)
    }
}

data class ImportedSet(val id: Id<TrainingSet>, val exerciseId: Id<Exercise>, val weightKg: Double, val reps: Int,
    val completedAt: Instant, val kind: String? = null, val rpe: Double? = null, val note: String? = null,
    val rpeNamed: Boolean = rpe != null) {
    fun value(session: Id<Session>) = TrainingSet(id, session, exerciseId, weightKg, reps, kind ?: "working", rpe, note ?: "", completedAt)
}

class ImportSession(val id: Id<Session>, val startedAt: Instant, val finishedAt: Instant, val sets: List<ImportedSet>, val routineId: Id<Routine>? = null) : Action<ImportSession.Loaded, Id<Session>, GymRefusal> {
    data class Loaded(val state: TrainingState, val routine: Routine?)
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = Loaded(TrainingState(read), routineId?.let { read.repository(Routine).find(it, ViewMode.drawn) })
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Id<Session>, GymRefusal> {
        SessionRules.instant(startedAt, "session.startedAt", Path("startedAt"))
        SessionRules.instant(finishedAt, "session.finishedAt", Path("finishedAt"))
        if (sets.size > 200 || sets.map { it.id }.distinct().size != sets.size) throw Violation("session.sets", Path("sets"), Violation.Reason.Custom("invalid"))
        if (finishedAt < startedAt || sets.any { it.completedAt !in startedAt..finishedAt })
            return Decision.Refuse(GymRefusal.of(Refused(RefusalCode(Gym.Codes.badInstant), id.ref, path = Refused.Path.predicted)))
        val checked = sets.map { set ->
            Valid(set.value(id), TrainingSet, at = loaded.state.moment).value
        }
        val routine = loaded.routine
        val predicted = Session(id, startedAt, finishedAt, "finish", routine?.id, plan = routine?.let(::PlanSnapshot))
        val args = buildMap {
            put("id", id.json); routineId?.let { put("routineId", it.json) }; put("startedAt", Json.of(startedAt.ms)); put("finishedAt", Json.of(finishedAt.ms))
            put("sets", Json.Arr(sets.map { set -> Json.Obj(buildList {
                add("id" to set.id.json); add("exerciseId" to set.exerciseId.json)
                add("weightKg" to Json.of(set.weightKg)); add("reps" to Json.of(set.reps)); add("completedAt" to Json.of(set.completedAt.ms))
                set.kind?.let { add("kind" to Json.of(it)) }; set.note?.let { add("note" to Json.of(it)) }
                if (set.rpeNamed) add("rpe" to (set.rpe?.let(Json::of) ?: Json.Null))
            }) }))
        }
        val predictions = listOf(Prediction.create(Session, id, predicted.fields())) + checked.map { Prediction.create(TrainingSet, it.id, it.fields()) }
        return Decision.Write(Plan(GymCommand(Gym.Commands.importSession, args), predictions), id)
    }
}

data class CorrectedSet(val id: Id<TrainingSet>, val exerciseId: Id<Exercise>, val setNumber: Long, val weightKg: Double, val reps: Int,
    val completedAt: Instant, val rpe: Double? = null, val note: String? = null, val rpeNamed: Boolean = rpe != null, val kind: String? = null)

class CorrectSession(val id: Id<Session>, val requestId: String, val startedAt: Instant, val finishedAt: Instant,
    val routineName: String?, val sets: List<CorrectedSet>, val preserveOtherSets: Boolean = false) : Action<TrainingState, Unit, GymRefusal> {
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = TrainingState(read)
    override fun decide(loaded: TrainingState, ids: IDSource): Decision<Unit, GymRefusal> {
        val session = loaded.session(id)
        if (!requestId.matches(Regex("^[A-Za-z0-9_-]{8,64}$"))) throw Violation("session.requestId", Path("requestId"), Violation.Reason.Custom("invalid"))
        SessionRules.instant(startedAt, "session.startedAt", Path("startedAt"))
        SessionRules.instant(finishedAt, "session.finishedAt", Path("finishedAt"))
        if (sets.size !in 1..200 || sets.map { it.id }.distinct().size != sets.size || sets.any { it.setNumber !in 1..Int.MAX_VALUE.toLong() } ||
            sets.map { it.exerciseId to it.setNumber }.distinct().size != sets.size)
            throw Violation("session.sets", Path("sets"), Violation.Reason.Custom("invalid"))
        if (finishedAt < startedAt || sets.any { it.completedAt !in startedAt..finishedAt })
            return Decision.Refuse(GymRefusal.of(Refused(RefusalCode(Gym.Codes.badInstant), id.ref, path = Refused.Path.predicted)))
        val old = loaded.sets.filter { it.sessionId == id }
        val retained = if (preserveOtherSets) old.filter { prior -> sets.none { it.id == prior.id } } else emptyList()
        if (retained.any { it.completedAt !in startedAt..finishedAt })
            return Decision.Refuse(GymRefusal.of(Refused(RefusalCode(Gym.Codes.badInstant), id.ref, path = Refused.Path.predicted)))
        if (sets.any { named -> retained.any { it.exerciseId == named.exerciseId && it.setNumber?.toLong() == named.setNumber } })
            throw Violation("session.sets", Path("sets"), Violation.Reason.Custom("invalid"))
        val checked = sets.map { set ->
            val previous = loaded.sets.firstOrNull { it.id == set.id }
            val current = TrainingSet(set.id, id, set.exerciseId, set.weightKg, set.reps, previous?.kind ?: set.kind ?: "working",
                if (set.rpeNamed) set.rpe else previous?.rpe, set.note ?: previous?.note ?: "", set.completedAt, set.setNumber.toInt())
            Valid(current, TrainingSet, at = loaded.moment).value
        }
        val name = routineName?.let { TextSpec("gym.correctSession.routineName", works.windmill.sync.core.MeasureUnit.bytes, 0, 240, trim = false, nfc = false).apply(it, Path("routineName")) }
        val predicted = session?.copy(startedAt = startedAt, finishedAt = finishedAt, closedBy = "finish", displayName = name)
        val args = mapOf("sessionId" to id.json, "requestId" to Json.of(requestId), "startedAt" to Json.of(startedAt.ms), "finishedAt" to Json.of(finishedAt.ms),
            "routineName" to (name?.let(Json::of) ?: Json.Null), "sets" to Json.Arr(sets.zip(checked).map { (input, value) -> Json.Obj(buildList {
                add("id" to value.id.json); add("exerciseId" to value.exerciseId.json); add("setNumber" to Json.of(input.setNumber))
                add("weightKg" to Json.of(input.weightKg)); add("reps" to Json.of(input.reps)); add("completedAt" to Json.of(input.completedAt.ms))
                input.kind?.let { add("kind" to Json.of(it)) }
                if (input.rpeNamed) add("rpe" to (input.rpe?.let(Json::of) ?: Json.Null)); input.note?.let { add("note" to Json.of(it)) }
            }) })) + if (preserveOtherSets) mapOf("preserveOtherSets" to Json.of(true)) else emptyMap()
        val predictions = (predicted?.let { listOf(Prediction.update(Session, id, it.fields())) } ?: emptyList()) + checked.map { set ->
            if (old.any { it.id == set.id }) Prediction.update(TrainingSet, set.id, set.fields())
            else Prediction.create(TrainingSet, set.id, set.fields())
        } + if (preserveOtherSets) emptyList() else old.filter { prior -> checked.none { it.id == prior.id } }.map { Prediction.remove(TrainingSet, it.id) }
        return Decision.Write(Plan(GymCommand(Gym.Commands.correctSession, args), predictions), Unit)
    }
}

fun deleteSet(id: Id<TrainingSet>) = Remove(TrainingSet, id, GymRefusal)
