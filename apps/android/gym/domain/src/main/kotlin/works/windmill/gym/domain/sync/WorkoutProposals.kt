package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

data class WorkoutProposal(override val id: Id<WorkoutProposal>, val sessionId: Id<Session>, val summary: String, val changes: List<RoutineChange>,
    val door: String = "ask", val connection: String = "", val agent: String = "", val state: String = "pending",
    val supersededBy: Id<WorkoutProposal>? = null, val settledAt: Instant? = null, val baseRevision: Int? = null,
    val changeCount: Int? = null, val threadId: String? = null) : Writable<WorkoutProposal> {
    override fun fields(): Map<String, Json> = mapOf("sessionId" to sessionId.json, "summary" to Json.of(summary),
        "changes" to Json.Arr(changes.map { it.json }), "door" to Json.of(door), "connection" to Json.of(connection), "agent" to Json.of(agent))
    val document: List<RoutineEntry> get() = RoutineChange.document(changes)
    companion object : WritableType<WorkoutProposal> {
        override val type = Gym.Types.workoutProposal
        override val scope = ScopeRef(Gym.scope)
        override fun decode(f: Fields) = WorkoutProposal(Id(f.id, this), f.ref("sessionId", Session), f.string("summary", ""),
            f.list("changes", RoutineChange::decode), f.string("door", "ask"), f.string("connection", ""), f.string("agent", ""),
            f.string("state", "pending"), f.optionalRef("supersededBy", this), f.optionalInstant("settledAt"), f.optionalInt("baseRevision"),
            f.optionalInt("changeCount"), f.optionalString("threadId"))
        override val checks = listOf(
            Check<WorkoutProposal>("summary") { value, _ -> value.copy(summary = WorkoutProposalRules.change.summary.apply(value.summary, Path("summary"))) },
            Check<WorkoutProposal>("changes") { value, _ -> value.copy(changes = WorkoutProposalRules.change.validated(value.changes, Path("changes"))) },
            Check<WorkoutProposal>("door") { value, _ -> value.copy(door = WorkoutProposalRules.change.door.apply(value.door, Path("door"))) },
            Check<WorkoutProposal>("connection") { value, _ -> value.copy(connection = WorkoutProposalRules.change.connection.apply(value.connection, Path("connection"))) },
            Check<WorkoutProposal>("agent") { value, _ -> value.copy(agent = WorkoutProposalRules.change.agent.apply(value.agent, Path("agent"))) },
        )
    }
}

object WorkoutProposalRules {
    val change = ChangeRules("workoutProposal")
    val rules = change.specs.map(Rule::local) + Rule.local(change.zeroTarget, WorkoutProposal.type) + listOf(
        Rule.serverDecided("workoutProposal.exercise", listOf(RefusalCode(Gym.Codes.unknownExercise)), WorkoutProposal.type),
        Rule.serverDecided("workoutProposal.plan", listOf(RefusalCode(Gym.Codes.planLogged)), WorkoutProposal.type),
        Rule.serverDecided("workoutProposal.session", listOf(RefusalCode(Gym.Codes.sessionFinished)), WorkoutProposal.type),
        Rule.serverDecided("workoutProposal.settled", listOf(RefusalCode(Gym.Codes.proposalSettled)), WorkoutProposal.type),
        Rule.serverDecided("workoutProposal.superseded", listOf(RefusalCode(Gym.Codes.proposalSuperseded)), WorkoutProposal.type),
    )
}

// The Coach's whole plan for the open workout, as a diff against the plan this phone stores, guarding it. The proposal
// refuses what the log would: a movement it cannot name, more entries of a movement than the plan gave it (one, for a
// movement it does not hold), and a change to the entries of a movement with a logged set, which may move but stand in the
// proposal as they stand in the plan.
class ProposeWorkout(val id: Id<WorkoutProposal>, val sessionId: Id<Session>, val entries: List<RoutineEntry>, val summary: String) :
    Action<OpenWorkout, Id<WorkoutProposal>, GymRefusal> {
    override val scope = WorkoutProposal.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = OpenWorkout(read, sessionId)
    override fun decide(loaded: OpenWorkout, ids: IDSource): Decision<Id<WorkoutProposal>, GymRefusal> = when (val proposed = proposed(loaded)) {
        is Proposed.Refuse -> Decision.Refuse(proposed.refusal)
        Proposed.Unchanged -> Decision.Unchanged(id)
        is Proposed.Minted -> Decision.Write(proposed.plan, id)
    }
    fun proposed(over: OpenWorkout): Proposed<WorkoutProposal> {
        over.refusal(id.ref)?.let { return Proposed.Refuse(it) }
        val stored = over.plan.entries
        if (entries == stored) return Proposed.Unchanged
        val proposal = Valid(WorkoutProposal(id, sessionId, summary, RoutineChange.between(stored, entries)), WorkoutProposal, at = over.moment)
        if (entries.any { over.catalogue.find(it.exerciseId) == null }) return Proposed.Refuse(GymRefusal.predicted(Gym.Codes.unknownExercise, id.ref))
        fun held(plan: List<RoutineEntry>, movement: Id<Exercise>) = plan.filter { it.exerciseId == movement }
        entries.withIndex().firstOrNull { (at, entry) ->
            held(entries.take(at + 1), entry.exerciseId).size > maxOf(1, held(stored, entry.exerciseId).size)
        }?.let { (at, _) -> throw Violation(WorkoutPlanRules.duplicate, Path("entries") + at + "exerciseId", Violation.Reason.Custom("duplicate")) }
        val changed = (stored + entries).map { it.exerciseId }.firstOrNull { it in over.logged && held(stored, it) != held(entries, it) }
        if (changed != null) return Proposed.Refuse(WorkoutPlanRules.logged(changed, id.ref))
        RoutineRules.floored(proposal.value.changes, over.catalogue)
        val plan = Plan()
        plan.create(proposal)
        plan.guardRead(sessionId, listOf("plan"))
        return Proposed.Minted(proposal, plan)
    }
}

// A workout proposal with its workout as this phone stores it. Out of date, it can no longer be applied, by the first that
// holds: a newer proposal replaced it, its workout closed, the plan changed since it was made, or a movement it changes
// was logged since.
data class WorkoutProposalState(val proposal: WorkoutProposal?, val workout: OpenWorkout?, val moment: Moment) {
    data class OutOfDate(val reason: String, val exerciseId: Id<Exercise>? = null) {
        val json: Json get() = Json.Obj(listOfNotNull("reason" to Json.of(reason), exerciseId?.let { "exerciseId" to it.json }))
    }

    constructor(read: Reader, id: Id<WorkoutProposal>, workouts: OpenWorkouts = OpenWorkouts(read)) : this(read, read.repository(WorkoutProposal).find(id, ViewMode.stored), workouts)
    private constructor(read: Reader, proposal: WorkoutProposal?, workouts: OpenWorkouts) : this(proposal, proposal?.let { workouts.of(it.sessionId) }, read.moment)

    val outOfDate: OutOfDate? get() {
        val value = proposal ?: return null
        if (value.state == "superseded") return OutOfDate(if (value.supersededBy != null) "replaced" else "workout-changed")
        val session = workout?.session
        if (value.state != "pending" || session == null) return null
        if (workout.isClosed) return OutOfDate("workout-finished")
        if (value.baseRevision != null && (session.planRevision ?: 1) != value.baseRevision) return OutOfDate("workout-changed")
        // A plan edit this phone has not had confirmed moves no revision yet, so the stored plan itself must still be the
        // plan the proposal diffs, its kept lines included.
        val plan = session.plan
        if (plan != null && RoutineChange.between(plan.entries, value.document).map { it.json } != value.changes.map { it.json }) return OutOfDate("workout-changed")
        return value.changes.firstOrNull { it.kind != "kept" && it.exerciseId in workout.logged }?.let { OutOfDate("workout-moved", it.exerciseId) }
    }

    // What the log would answer the decision, said before it is sent. Applying asks more than turning down: the workout must
    // be in sight and the proposal current.
    fun refusal(id: Id<WorkoutProposal>, applying: Boolean): GymRefusal? {
        val value = proposal ?: return GymRefusal.of(Refused(RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted))
        when (value.state) {
            "pending" -> {
                if (!applying) return null
                if (workout?.session == null || !workout.visible) return GymRefusal.of(Refused(RefusalCode.unknownRecord, value.sessionId.ref, path = Refused.Path.predicted))
            }
            "superseded" -> {}
            if (applying) "applied" else "dismissed" -> return null
            else -> return GymRefusal.predicted(Gym.Codes.proposalSettled, id.ref, Json.objectOf("state" to Json.of(value.state)))
        }
        return outOfDate?.let { GymRefusal.predicted(Gym.Codes.proposalSuperseded, id.ref, Json.objectOf("reason" to Json.of(it.reason))) }
    }
}

class ApplyWorkoutProposal(val id: Id<WorkoutProposal>) : Action<WorkoutProposalState, Unit, GymRefusal> {
    override val scope = WorkoutProposal.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = WorkoutProposalState(read, id)
    override fun decide(loaded: WorkoutProposalState, ids: IDSource): Decision<Unit, GymRefusal> {
        loaded.refusal(id, applying = true)?.let { return Decision.Refuse(it) }
        val proposal = loaded.proposal!!
        if (proposal.state == "applied") return Decision.Unchanged(Unit)
        val workout = loaded.workout!!
        RoutineRules.floored(proposal.changes, workout.catalogue)
        val settled = Prediction.update(WorkoutProposal, id, mapOf("state" to Json.of("applied"), "settledAt" to Json.of(loaded.moment.now.ms)))
        val plan = Prediction.update(Session, proposal.sessionId, mapOf("plan" to workout.plan.copy(entries = proposal.document).json))
        return Decision.Write(Plan(GymCommand(Gym.Commands.applyWorkoutProposal, mapOf("proposalId" to id.json)), listOf(settled, plan)), Unit)
    }
}

class DismissWorkoutProposal(val id: Id<WorkoutProposal>) : Action<WorkoutProposalState, Unit, GymRefusal> {
    override val scope = WorkoutProposal.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = WorkoutProposalState(read, id)
    override fun decide(loaded: WorkoutProposalState, ids: IDSource): Decision<Unit, GymRefusal> {
        loaded.refusal(id, applying = false)?.let { return Decision.Refuse(it) }
        if (loaded.proposal!!.state == "dismissed") return Decision.Unchanged(Unit)
        val settled = Prediction.update(WorkoutProposal, id, mapOf("state" to Json.of("dismissed"), "settledAt" to Json.of(loaded.moment.now.ms)))
        return Decision.Write(Plan(GymCommand(Gym.Commands.dismissWorkoutProposal, mapOf("proposalId" to id.json)), listOf(settled)), Unit)
    }
}
