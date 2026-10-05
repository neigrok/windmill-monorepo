package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

data class EntryTargets(val sets: List<SetTarget>? = null, val restSeconds: Int? = null) : ValueObject<EntryTargets> {
    constructor(value: RoutineEntry) : this(value.sets, value.restSeconds)
    override val json: Json get() = Json.Obj(buildList {
        sets?.let { add("sets" to Json.Arr(it.map(SetTarget::json))) }; restSeconds?.let { add("restSeconds" to Json.of(it)) }
    })
    override fun validated(at: Path) = (if (at.text.endsWith(".before")) ProposalRules.before else ProposalRules.after).validate(this, at)
    companion object : ValueType<EntryTargets> {
        override fun decode(f: Fields) = EntryTargets(f.optionalList("sets", SetTarget), f.optionalInt("restSeconds"))
    }
}

data class RoutineChange(val kind: String, val exerciseId: Id<Exercise>, val before: EntryTargets? = null, val after: EntryTargets? = null) : ValueObject<RoutineChange> {
    override val json: Json get() = Json.Obj(buildList {
        add("kind" to Json.of(kind)); add("exerciseId" to exerciseId.json)
        before?.let { add("before" to it.json) }; after?.let { add("after" to it.json) }
    })
    override fun validated(at: Path): RoutineChange {
        ProposalRules.kind.apply(kind, at + "kind")
        ProposalRules.exercise.apply(exerciseId.record.string ?: "", at + "exerciseId")
        if ((kind == "added") != (before == null) || (kind == "removed") != (after == null))
            throw Violation("proposal.changes", at, Violation.Reason.Custom("side"))
        return copy(before = before?.validated(at + "before"), after = after?.validated(at + "after"))
    }
    companion object : ValueType<RoutineChange> {
        override fun decode(f: Fields) = RoutineChange(f.string("kind"), f.ref("exerciseId", Exercise), f.optionalValue("before", EntryTargets), f.optionalValue("after", EntryTargets))
    }
}

data class Proposal(override val id: Id<Proposal>, val routineId: Id<Routine>, val intent: String, val proposedName: String,
    val summary: String, val changes: List<RoutineChange>, val door: String = "ask", val connection: String = "", val agent: String = "",
    val state: String = "pending", val supersededBy: Id<Proposal>? = null, val settledAt: Instant? = null,
    val baseRevision: Int? = null, val baseName: String? = null, val threadId: String? = null) : Writable<Proposal> {
    override fun fields(): Map<String, Json> = mapOf("routineId" to routineId.json, "intent" to Json.of(intent), "proposedName" to Json.of(proposedName),
        "summary" to Json.of(summary), "changes" to Json.Arr(changes.map { it.json }), "door" to Json.of(door), "connection" to Json.of(connection), "agent" to Json.of(agent))
    val document: List<RoutineEntry> get() = changes.filter { it.kind != "removed" }.map { RoutineEntry(it.exerciseId, it.after?.sets, it.after?.restSeconds) }
    fun changeCount(base: Routine): Int {
        val moved = changes.count { it.kind != "kept" }
        val reordered = changes.filter { it.kind == "kept" || it.kind == "retargeted" }.map { it.exerciseId } !=
            base.entries.filter { entry -> changes.any { it.exerciseId == entry.exerciseId && it.kind != "added" && it.kind != "removed" } }.map { it.exerciseId }
        return moved + (if (base.name != proposedName) 1 else 0) + (if (reordered) 1 else 0)
    }
    companion object : WritableType<Proposal> {
        override val type = Gym.Types.proposal
        override val scope = ScopeRef(Gym.scope)
        override fun decode(f: Fields) = Proposal(Id(f.id, this), f.ref("routineId", Routine), f.string("intent"), f.string("proposedName", ""), f.string("summary", ""),
            f.list("changes", RoutineChange), f.string("door", "ask"), f.string("connection", ""), f.string("agent", ""), f.string("state", "pending"),
            f.optionalRef("supersededBy", this), f.optionalInstant("settledAt"), f.optionalInt("baseRevision"), f.optionalString("baseName"), f.optionalString("threadId"))
        override val checks = listOf(
            Check<Proposal>("intent") { value, _ -> value.copy(intent = ProposalRules.intent.apply(value.intent, Path("intent"))) },
            Check<Proposal>("proposedName") { value, _ -> value.copy(proposedName = ProposalRules.name.apply(value.proposedName, Path("proposedName"))) },
            Check<Proposal>("summary") { value, _ -> value.copy(summary = ProposalRules.summary.apply(value.summary, Path("summary"))) },
            Check<Proposal>("changes") { value, _ ->
                val checked = ProposalRules.changes.apply(value.changes, Path("changes"))
                if (checked.dropWhile { it.kind != "removed" }.any { it.kind != "removed" }) throw Violation("proposal.changes", Path("changes"), Violation.Reason.Custom("removalsLast"))
                value.copy(changes = checked)
            },
            Check<Proposal>("door") { value, _ -> value.copy(door = ProposalRules.door.apply(value.door, Path("door"))) },
            Check<Proposal>("connection") { value, _ -> value.copy(connection = ProposalRules.connection.apply(value.connection, Path("connection"))) },
            Check<Proposal>("agent") { value, _ -> value.copy(agent = ProposalRules.agent.apply(value.agent, Path("agent"))) },
        )
    }
}

object ProposalRules {
    class Targets(path: String) {
        val sets = CountSpec("$path.sets", 1, 20)
        val reps = NumberSpec("$path.sets.reps", 1.0, 100.0, integer = true)
        val weight = NumberSpec("$path.sets.weightKg", -500.0, 500.0, quantum = 0.01)
        val rest = NumberSpec("$path.restSeconds", 15.0, 900.0, integer = true)
        val specs: List<ValueSpec> get() = listOf(sets, reps, weight, rest)
        fun validate(value: EntryTargets, at: Path): EntryTargets = value.copy(
            sets = value.sets?.let { items -> sets.apply(items, at + "sets") { target, path ->
                if (target.reps == 0) throw Violation("proposal.zeroTarget", path + "reps", Violation.Reason.Custom("zeroTarget"))
                val checkedReps = reps.applyOptional(target.reps, path + "reps")
                val checkedWeight = weight.applyOptional(target.weightKg, path + "weightKg")
                if (checkedWeight == 0.0) throw Violation("proposal.zeroTarget", path + "weightKg", Violation.Reason.Custom("zeroTarget"))
                SetTarget(checkedReps, checkedWeight)
            } }, restSeconds = rest.applyOptional(value.restSeconds, at + "restSeconds"),
        )
    }
    val before = Targets("proposal.changes.before")
    val after = Targets("proposal.changes.after")
    val intent = ChoiceSpec("proposal.intent", listOf("revise", "remove"))
    val name = TextSpec("proposal.proposedName", MeasureUnit.bytes, 0, 240, trim = true, nfc = true)
    val summary = TextSpec("proposal.summary", MeasureUnit.bytes, 0, 400, trim = true, nfc = true)
    val changes = CountSpec("proposal.changes", 0, 100)
    val kind = ChoiceSpec("proposal.changes.kind", listOf("kept", "added", "removed", "retargeted"))
    val door = ChoiceSpec("proposal.door", listOf("ask"))
    val connection = TextSpec("proposal.connection", MeasureUnit.bytes, 0, 0, trim = false, nfc = false)
    val agent = TextSpec("proposal.agent", MeasureUnit.chars, 0, 0, trim = false, nfc = false)
    val exercise = TextSpec("proposal.changes.exerciseId", MeasureUnit.chars, 1, 64, false, false)
    val rules = (listOf(intent, name, summary, changes, kind, door, connection, agent, exercise) + before.specs + after.specs).map(Rule::local) +
        Rule.local("proposal.zeroTarget", Proposal.type)
    fun changesBetween(base: List<RoutineEntry>, proposed: List<RoutineEntry>): List<RoutineChange> {
        val before = base
        val after = proposed.map { it.validated(Path("entries")) }
        val matched = mutableSetOf<Int>()
        val changes = after.map { entry ->
            val index = before.indices.firstOrNull { it !in matched && before[it].exerciseId == entry.exerciseId }
            if (index == null) return@map RoutineChange("added", entry.exerciseId, after = EntryTargets(entry))
            matched += index
            val previous = EntryTargets(before[index])
            val next = EntryTargets(entry)
            RoutineChange(if (previous == next) "kept" else "retargeted", entry.exerciseId, previous, next)
        }
        return changes + before.withIndex().filter { it.index !in matched }.map { RoutineChange("removed", it.value.exerciseId, before = EntryTargets(it.value)) }
    }
}

class ProposeRoutine(val id: Id<Proposal>, val routineId: Id<Routine>, val name: String, val entries: List<RoutineEntry>, val summary: String,
    val removing: Boolean = false) : Action<ProposeRoutine.Loaded, Id<Proposal>, GymRefusal> {
    data class Loaded(val routine: Routine?, val catalogue: Catalogue, val moment: Moment)
    override val scope = Proposal.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = Loaded(read.repository(Routine).find(routineId, ViewMode.stored), Catalogue(read, ViewMode.stored), read.moment)
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Id<Proposal>, GymRefusal> {
        val base = loaded.routine ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, routineId.ref, path = Refused.Path.predicted)))
        val proposed = if (removing) emptyList() else RoutineRules.entries.apply(entries, Path("entries"))
        val proposedName = if (removing) "" else RoutineRules.name.apply(name, Path("name"))
        if (proposed.any { loaded.catalogue.find(it.exerciseId) == null }) return Decision.Refuse(GymRefusal.of(Refused(RefusalCode(Gym.Codes.unknownExercise), id.ref, path = Refused.Path.predicted)))
        if (!removing && base.name == proposedName && base.entries == proposed) return Decision.Unchanged(id)
        val proposal = Proposal(id, base.id, if (removing) "remove" else "revise", proposedName, summary, ProposalRules.changesBetween(base.entries, proposed))
        val plan = Plan()
        plan.create(Valid(proposal, Proposal, at = loaded.moment))
        plan.guardRead(base.id, listOf("entries", "name"))
        return Decision.Write(plan, id)
    }
}

data class ProposalState(val proposal: Proposal?, val routine: Routine?, val moment: Moment) {
    constructor(read: Reader, id: Id<Proposal>) : this(read.repository(Proposal).find(id, ViewMode.stored), read.repository(Proposal).find(id, ViewMode.stored)?.let {
        read.repository(Routine).find(it.routineId, ViewMode.stored)
    }, read.moment)
    fun refusal(id: Id<Proposal>, applying: Boolean): GymRefusal? {
        val value = proposal ?: return GymRefusal.of(Refused(RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted))
        if (value.state == "superseded") return if (value.supersededBy == null) null else
            GymRefusal.of(Refused(RefusalCode(Gym.Codes.proposalSuperseded), id.ref, Json.objectOf("reason" to Json.of("replaced")), Refused.Path.predicted))
        if (value.state != "pending" && value.state != if (applying) "applied" else "dismissed")
            return GymRefusal.of(Refused(RefusalCode(Gym.Codes.proposalSettled), id.ref, Json.objectOf("state" to Json.of(value.state)), Refused.Path.predicted))
        return null
    }
}

class ApplyProposal(val id: Id<Proposal>) : Action<ProposalState, Unit, GymRefusal> {
    override val scope = Proposal.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = ProposalState(read, id)
    override fun decide(loaded: ProposalState, ids: IDSource): Decision<Unit, GymRefusal> {
        loaded.refusal(id, true)?.let { return Decision.Refuse(it) }
        val proposal = loaded.proposal!!
        if (proposal.state == "applied") return Decision.Unchanged(Unit)
        if (proposal.state == "superseded") return Decision.Write(Plan(GymCommand(Gym.Commands.applyProposal, mapOf("proposalId" to id.json))), Unit)
        val routine = loaded.routine ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, proposal.routineId.ref, path = Refused.Path.predicted)))
        val change = if (proposal.intent == "remove") Prediction.remove(Routine, routine.id)
        else Prediction.update(Routine, routine.id, mapOf("name" to Json.of(proposal.proposedName), "entries" to Json.Arr(proposal.document.map { it.json })))
        val settled = Prediction.update(Proposal, id, mapOf("state" to Json.of("applied"), "settledAt" to Json.of(loaded.moment.now.ms)))
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
