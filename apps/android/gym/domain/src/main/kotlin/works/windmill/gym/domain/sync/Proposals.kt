package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

data class EntryTargets(val sets: List<SetTarget>? = null, val restSeconds: Int? = null) {
    constructor(value: RoutineEntry) : this(value.sets, value.restSeconds)
    val json: Json get() = Json.Obj(buildList {
        sets?.let { add("sets" to Json.Arr(it.map(SetTarget::json))) }; restSeconds?.let { add("restSeconds" to Json.of(it)) }
    })
    companion object {
        fun decode(f: Fields) = EntryTargets(f.optionalList("sets", SetTarget), f.optionalInt("restSeconds"))
    }
}

data class RoutineChange(val kind: String, val exerciseId: Id<Exercise>, val before: EntryTargets? = null, val after: EntryTargets? = null) {
    val json: Json get() = Json.Obj(buildList {
        add("kind" to Json.of(kind)); add("exerciseId" to exerciseId.json)
        before?.let { add("before" to it.json) }; after?.let { add("after" to it.json) }
    })
    companion object {
        fun decode(f: Fields) = RoutineChange(f.string("kind"), f.ref("exerciseId", Exercise), f.optionalValue("before", EntryTargets::decode),
            f.optionalValue("after", EntryTargets::decode))

        // Each proposed entry against the first unmatched base entry of its movement, in the proposed order, then every base
        // entry left unmatched as a removal.
        fun between(base: List<RoutineEntry>, proposed: List<RoutineEntry>): List<RoutineChange> {
            val matched = mutableSetOf<Int>()
            val changes = proposed.map { entry ->
                val index = base.indices.firstOrNull { it !in matched && base[it].exerciseId == entry.exerciseId }
                if (index == null) return@map RoutineChange("added", entry.exerciseId, after = EntryTargets(entry))
                matched += index
                val previous = EntryTargets(base[index])
                val next = EntryTargets(entry)
                RoutineChange(if (previous == next) "kept" else "retargeted", entry.exerciseId, previous, next)
            }
            return changes + base.withIndex().filter { it.index !in matched }.map { RoutineChange("removed", it.value.exerciseId, before = EntryTargets(it.value)) }
        }

        fun document(changes: List<RoutineChange>): List<RoutineEntry> =
            changes.filter { it.kind != "removed" }.map { RoutineEntry(it.exerciseId, it.after?.sets, it.after?.restSeconds) }

        // R118's count: every line that is not kept, and one more when the kept movements left the base's order.
        fun count(base: List<RoutineEntry>, changes: List<RoutineChange>): Int {
            val unmatched = base.indices.toMutableList()
            val retained = changes.filter { it.kind == "kept" || it.kind == "retargeted" }.mapNotNull { change ->
                val at = unmatched.indexOfFirst { base[it].exerciseId == change.exerciseId }
                if (at < 0) null else unmatched.removeAt(at)
            }
            return changes.count { it.kind != "kept" } + (if (retained != retained.sorted()) 1 else 0)
        }
    }
}

// The rules every proposal's change lines obey, each proposal type under its own paths: a routine's at `proposal.*`, a
// workout's at `workoutProposal.*`.
class ChangeRules(val type: String) {
    class Targets(path: String, private val zeroTarget: String) {
        val sets = CountSpec("$path.sets", 1, 20)
        val reps = NumberSpec("$path.sets.reps", 1.0, 100.0, integer = true)
        val weight = NumberSpec("$path.sets.weightKg", quantum = 0.01)
        val rest = NumberSpec("$path.restSeconds", 15.0, 900.0, integer = true)
        val specs: List<ValueSpec> get() = listOf(sets, reps, weight, rest)
        fun validate(value: EntryTargets, at: Path): EntryTargets = value.copy(
            sets = value.sets?.let { items -> sets.apply(items, at + "sets") { target, path ->
                if (target.reps == 0) throw Violation(zeroTarget, path + "reps", Violation.Reason.Custom("zeroTarget"))
                val checkedReps = reps.applyOptional(target.reps, path + "reps")
                val checkedWeight = weight.applyOptional(target.weightKg, path + "weightKg")
                if (checkedWeight == 0.0 && target.weightKg != 0.0) throw Violation(zeroTarget, path + "weightKg", Violation.Reason.Custom("zeroTarget"))
                SetTarget(checkedReps, checkedWeight)
            } }, restSeconds = rest.applyOptional(value.restSeconds, at + "restSeconds"),
        )
    }
    val zeroTarget = "$type.zeroTarget"
    val before = Targets("$type.changes.before", zeroTarget)
    val after = Targets("$type.changes.after", zeroTarget)
    val summary = TextSpec("$type.summary", MeasureUnit.bytes, 0, 400, trim = true, nfc = true)
    val changes = CountSpec("$type.changes", 0, 100)
    val kind = ChoiceSpec("$type.changes.kind", listOf("kept", "added", "removed", "retargeted"))
    val door = ChoiceSpec("$type.door", listOf("ask"))
    val connection = TextSpec("$type.connection", MeasureUnit.bytes, 0, 0, trim = false, nfc = false)
    val agent = TextSpec("$type.agent", MeasureUnit.chars, 0, 0, trim = false, nfc = false)
    val exercise = TextSpec("$type.changes.exerciseId", MeasureUnit.chars, 1, 64, false, false)
    val specs: List<ValueSpec> get() = listOf(summary, changes, kind, door, connection, agent, exercise) + before.specs + after.specs

    fun validated(lines: List<RoutineChange>, at: Path): List<RoutineChange> {
        val checked = changes.apply(lines, at) { change, path ->
            kind.apply(change.kind, path + "kind")
            exercise.apply(change.exerciseId.record.string ?: "", path + "exerciseId")
            if ((change.kind == "added") != (change.before == null) || (change.kind == "removed") != (change.after == null))
                throw Violation(changes.path, path, Violation.Reason.Custom("side"))
            change.copy(before = change.before?.let { before.validate(it, path + "before") }, after = change.after?.let { after.validate(it, path + "after") })
        }
        if (checked.dropWhile { it.kind != "removed" }.any { it.kind != "removed" }) throw Violation(changes.path, at, Violation.Reason.Custom("removalsLast"))
        return checked
    }
}

data class Proposal(override val id: Id<Proposal>, val routineId: Id<Routine>, val intent: String, val proposedName: String,
    val summary: String, val changes: List<RoutineChange>, val door: String = "ask", val connection: String = "", val agent: String = "",
    val state: String = "pending", val supersededBy: Id<Proposal>? = null, val settledAt: Instant? = null,
    val baseRevision: Int? = null, val baseName: String? = null, val threadId: String? = null, val changeCount: Int? = null) : Writable<Proposal> {
    override fun fields(): Map<String, Json> = mapOf("routineId" to routineId.json, "intent" to Json.of(intent), "proposedName" to Json.of(proposedName),
        "summary" to Json.of(summary), "changes" to Json.Arr(changes.map { it.json }), "door" to Json.of(door), "connection" to Json.of(connection), "agent" to Json.of(agent))
    val document: List<RoutineEntry> get() = RoutineChange.document(changes)
    fun changeCount(base: Routine): Int = changeCount ?: (RoutineChange.count(base.entries, changes) + if (base.name != proposedName) 1 else 0)
    companion object : WritableType<Proposal> {
        override val type = Gym.Types.proposal
        override val scope = ScopeRef(Gym.scope)
        override fun decode(f: Fields) = Proposal(Id(f.id, this), f.ref("routineId", Routine), f.string("intent"), f.string("proposedName", ""), f.string("summary", ""),
            f.list("changes", RoutineChange::decode), f.string("door", "ask"), f.string("connection", ""), f.string("agent", ""), f.string("state", "pending"),
            f.optionalRef("supersededBy", this), f.optionalInstant("settledAt"), f.optionalInt("baseRevision"), f.optionalString("baseName"), f.optionalString("threadId"),
            f.optionalInt("changeCount"))
        override val checks = listOf(
            Check<Proposal>("intent") { value, _ -> value.copy(intent = ProposalRules.intent.apply(value.intent, Path("intent"))) },
            Check<Proposal>("proposedName") { value, _ -> value.copy(proposedName = ProposalRules.name.apply(value.proposedName, Path("proposedName"))) },
            Check<Proposal>("summary") { value, _ -> value.copy(summary = ProposalRules.change.summary.apply(value.summary, Path("summary"))) },
            Check<Proposal>("changes") { value, _ -> value.copy(changes = ProposalRules.change.validated(value.changes, Path("changes"))) },
            Check<Proposal>("door") { value, _ -> value.copy(door = ProposalRules.change.door.apply(value.door, Path("door"))) },
            Check<Proposal>("connection") { value, _ -> value.copy(connection = ProposalRules.change.connection.apply(value.connection, Path("connection"))) },
            Check<Proposal>("agent") { value, _ -> value.copy(agent = ProposalRules.change.agent.apply(value.agent, Path("agent"))) },
        )
    }
}

object ProposalRules {
    val change = ChangeRules("proposal")
    val intent = ChoiceSpec("proposal.intent", listOf("revise", "remove"))
    val name = TextSpec("proposal.proposedName", MeasureUnit.bytes, 0, 240, trim = true, nfc = true)
    val rules = (listOf(intent, name) + change.specs).map(Rule::local) + Rule.local(change.zeroTarget, Proposal.type)
    fun changesBetween(base: List<RoutineEntry>, proposed: List<RoutineEntry>): List<RoutineChange> =
        RoutineChange.between(base, proposed.map { it.validated(Path("entries")) })
}

class ProposeRoutine(val id: Id<Proposal>, val routineId: Id<Routine>, val name: String, val entries: List<RoutineEntry>, val summary: String,
    val removing: Boolean = false) : Action<ProposeRoutine.Loaded, Id<Proposal>, GymRefusal> {
    data class Loaded(val routine: Routine?, val catalogue: Catalogue, val moment: Moment, val routineVisible: Boolean = true)
    override val scope = Proposal.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = Loaded(read.repository(Routine).find(routineId, ViewMode.stored), Catalogue(read, ViewMode.stored), read.moment,
        read.repository(Routine).find(routineId, ViewMode.drawn) != null)
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Id<Proposal>, GymRefusal> {
        val base = loaded.routine?.takeIf { loaded.routineVisible } ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, routineId.ref, path = Refused.Path.predicted)))
        val proposed = if (removing) emptyList() else RoutineRules.entries.apply(entries, Path("entries"))
        val proposedName = if (removing) "" else RoutineRules.name.apply(name, Path("name"))
        if (proposed.any { loaded.catalogue.find(it.exerciseId) == null }) return Decision.Refuse(GymRefusal.of(Refused(RefusalCode(Gym.Codes.unknownExercise), id.ref, path = Refused.Path.predicted)))
        val changes = RoutineChange.between(base.entries, proposed)
        RoutineRules.floored(changes, loaded.catalogue)
        if (!removing && base.name == proposedName && base.entries == proposed) return Decision.Unchanged(id)
        val proposal = Proposal(id, base.id, if (removing) "remove" else "revise", proposedName, summary, changes)
        val plan = Plan()
        plan.create(Valid(proposal, Proposal, at = loaded.moment))
        plan.guardRead(base.id, listOf("entries", "name"))
        return Decision.Write(plan, id)
    }
}

// A proposal with its routine three ways: as this phone stores it, whether it is in sight, and as the log last confirmed it.
data class ProposalState(val proposal: Proposal?, val routine: Routine?, val moment: Moment, val routineVisible: Boolean = true,
    val confirmedRoutine: Routine? = null) {
    constructor(read: Reader, id: Id<Proposal>) : this(read, read.repository(Proposal).find(id, ViewMode.stored))
    private constructor(read: Reader, proposal: Proposal?) : this(proposal,
        proposal?.let { read.repository(Routine).find(it.routineId, ViewMode.stored) }, read.moment,
        proposal?.let { read.repository(Routine).find(it.routineId, ViewMode.drawn) } != null,
        proposal?.let { read.confirmed(Routine, it.routineId) }?.let { Routine.decode(Fields(it)) })

    // What the log would answer the decision, said before it is sent. Applying asks more than turning down: the routine
    // must stand as the proposal found it, on the log and on this phone, and in sight.
    fun refusal(id: Id<Proposal>, applying: Boolean): GymRefusal? {
        fun superseded(reason: String) = GymRefusal.of(Refused(RefusalCode(Gym.Codes.proposalSuperseded), id.ref, Json.objectOf("reason" to Json.of(reason)), Refused.Path.predicted))
        val value = proposal ?: return GymRefusal.of(Refused(RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted))
        if (value.state == "superseded") {
            if (value.supersededBy != null) return superseded("replaced")
            val revision = routine?.revision ?: return null
            val base = value.baseRevision ?: return null
            return superseded(if (revision == base) "superseded" else "routine-changed")
        }
        if (value.state == "pending") {
            if (!applying) return null
            if (routineMoved) return superseded("routine-changed")
            if (routine == null || !routineVisible) return GymRefusal.of(Refused(RefusalCode.unknownRecord, value.routineId.ref, path = Refused.Path.predicted))
            return null
        }
        if (value.state == if (applying) "applied" else "dismissed") return null
        return GymRefusal.of(Refused(RefusalCode(Gym.Codes.proposalSettled), id.ref, Json.objectOf("state" to Json.of(value.state)), Refused.Path.predicted))
    }

    // Out of date, a proposal can no longer be applied: a newer one replaced it, the log set it aside, or its routine
    // moved while it waited, on the log, in an edit the log has not confirmed, or out of sight.
    val outOfDate: Boolean get() {
        val value = proposal ?: return false
        if (value.state == "superseded" || value.supersededBy != null) return true
        return value.state == "pending" && refusal(value.id, applying = true) != null
    }

    // The routine moved under the proposal: the log counted a new revision, or this phone holds a new name or new
    // movements the log has not confirmed yet, which it will count before it reads the decision.
    val routineMoved: Boolean get() {
        val value = proposal ?: return false
        if (routine?.revision != null && value.baseRevision != null && routine.revision != value.baseRevision) return true
        val held = routine ?: return false
        val confirmed = confirmedRoutine ?: return false
        return held.name != confirmed.name || held.entries != confirmed.entries
    }
}

class ApplyProposal(val id: Id<Proposal>) : Action<ApplyProposal.Loaded, Unit, GymRefusal> {
    data class Loaded(val state: ProposalState, val catalogue: Catalogue)
    override val scope = Proposal.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = Loaded(ProposalState(read, id), Catalogue(read, ViewMode.stored))
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Unit, GymRefusal> {
        val state = loaded.state
        state.refusal(id, true)?.let { return Decision.Refuse(it) }
        val proposal = state.proposal!!
        if (proposal.state == "applied") return Decision.Unchanged(Unit)
        if (proposal.state == "superseded") return Decision.Write(Plan(GymCommand(Gym.Commands.applyProposal, mapOf("proposalId" to id.json))), Unit)
        RoutineRules.floored(proposal.changes, loaded.catalogue)
        val routine = state.routine!!
        val change = if (proposal.intent == "remove") Prediction.remove(Routine, routine.id)
        else Prediction.update(Routine, routine.id, mapOf("name" to Json.of(proposal.proposedName), "entries" to Json.Arr(proposal.document.map { it.json })))
        val settled = Prediction.update(Proposal, id, mapOf("state" to Json.of("applied"), "settledAt" to Json.of(state.moment.now.ms)))
        return Decision.Write(Plan(GymCommand(Gym.Commands.applyProposal, mapOf("proposalId" to id.json)), listOf(settled, change)), Unit)
    }
}

class DismissProposal(val id: Id<Proposal>) : Action<ProposalState, Unit, GymRefusal> {
    override val scope = Proposal.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = ProposalState(read, id)
    override fun decide(loaded: ProposalState, ids: IDSource): Decision<Unit, GymRefusal> {
        loaded.refusal(id, false)?.let { return Decision.Refuse(it) }
        if (loaded.proposal!!.state == "dismissed") return Decision.Unchanged(Unit)
        if (loaded.proposal.state == "superseded") return Decision.Write(Plan(GymCommand(Gym.Commands.dismissProposal, mapOf("proposalId" to id.json))), Unit)
        val settled = Prediction.update(Proposal, id, mapOf("state" to Json.of("dismissed"), "settledAt" to Json.of(loaded.moment.now.ms)))
        return Decision.Write(Plan(GymCommand(Gym.Commands.dismissProposal, mapOf("proposalId" to id.json)), listOf(settled)), Unit)
    }
}
