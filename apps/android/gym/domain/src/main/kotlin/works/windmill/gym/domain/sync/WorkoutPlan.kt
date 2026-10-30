package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.schema.Gym

// An open workout as an edit of its plan reads it: the session as this phone draws it (closed once stale) and as it
// stores it, the movements with a set alive in it on either view, and the movements the account can name.
data class OpenWorkout(val id: Id<Session>, val drawn: Session?, val stored: Session?, val logged: Set<Id<Exercise>>,
    val catalogue: Catalogue, val moment: Moment) {
    constructor(read: Reader, id: Id<Session>) : this(id,
        read.repository(Session).find(id, ViewMode.drawn)?.let { SessionRules.drawn(it, read.repository(TrainingSet).all(ViewMode.drawn), read.moment.now) },
        read.repository(Session).find(id, ViewMode.stored),
        (read.repository(TrainingSet).all(ViewMode.drawn) + read.repository(TrainingSet).all(ViewMode.stored)).filter { it.sessionId == id }.map { it.exerciseId }.toSet(),
        Catalogue(read), read.moment)

    // A workout this phone does not draw is gone; a closed one is finished, said of the record the edit writes.
    fun refusal(subject: RecordRef): GymRefusal? {
        if (drawn == null || stored == null) return GymRefusal.of(Refused(RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted))
        if (!drawn.isOpen) return GymRefusal.predicted(Gym.Codes.sessionFinished, subject)
        return null
    }

    val plan: PlanSnapshot get() = stored?.plan ?: throw Violation(WorkoutPlanRules.absent, Path("plan"), Violation.Reason.Custom("absent"))
}

// One edit of the plan. It names the entry it edits by `index`, a planned set of that entry by `set`, and the movement it
// brings into the plan by `movement`; the plan checks each name before the edit changes its lines.
sealed class PlanOperation {
    open val index: Int? = null
    open val set: Int? = null
    open val movement: Id<Exercise>? = null
    abstract fun changed(lines: List<WorkoutPlan.Line>, catalogue: Catalogue): List<WorkoutPlan.Line>

    protected fun List<WorkoutPlan.Line>.rewriting(index: Int, edit: (RoutineEntry) -> RoutineEntry) =
        mapIndexed { at, line -> if (at == index) WorkoutPlan.Line(edit(line.entry), written = true) else line }

    data class Retarget(override val index: Int, override val set: Int, val target: SetTarget) : PlanOperation() {
        override fun changed(lines: List<WorkoutPlan.Line>, catalogue: Catalogue) =
            lines.rewriting(index) { entry -> entry.copy(sets = entry.sets.orEmpty().mapIndexed { at, planned -> if (at == set) target else planned }) }
    }
    data class AddSet(override val index: Int) : PlanOperation() {
        override fun changed(lines: List<WorkoutPlan.Line>, catalogue: Catalogue) =
            lines.rewriting(index) { entry -> entry.copy(sets = entry.sets.orEmpty() + (entry.sets?.lastOrNull() ?: SetTarget())) }
    }
    data class RemoveSet(override val index: Int, override val set: Int) : PlanOperation() {
        override fun changed(lines: List<WorkoutPlan.Line>, catalogue: Catalogue) =
            lines.rewriting(index) { entry -> entry.copy(sets = entry.sets.orEmpty().filterIndexed { at, _ -> at != set }.ifEmpty { null }) }
    }
    // A movement in another's place keeps its planned sets and rest; its loads stand only where both read in the same unit.
    data class Swap(override val index: Int, val exerciseId: Id<Exercise>) : PlanOperation() {
        override val movement get() = exerciseId
        override fun changed(lines: List<WorkoutPlan.Line>, catalogue: Catalogue) = lines.rewriting(index) { entry ->
            fun unit(id: Id<Exercise>) = catalogue.find(id).let { Readout.loadUnit(it?.equipment, it?.loadCount ?: 1) }
            entry.copy(exerciseId = exerciseId, sets = if (unit(entry.exerciseId) == unit(exerciseId)) entry.sets else entry.sets?.map { it.copy(weightKg = null) })
        }
    }
    data class AddMovement(val exerciseId: Id<Exercise>) : PlanOperation() {
        override val movement get() = exerciseId
        override fun changed(lines: List<WorkoutPlan.Line>, catalogue: Catalogue) = lines + WorkoutPlan.Line(RoutineEntry(exerciseId), written = true)
    }
    data class RemoveMovement(override val index: Int) : PlanOperation() {
        override fun changed(lines: List<WorkoutPlan.Line>, catalogue: Catalogue) = lines.filterIndexed { at, _ -> at != index }
    }
    data class SetRest(override val index: Int, val restSeconds: Int?) : PlanOperation() {
        override fun changed(lines: List<WorkoutPlan.Line>, catalogue: Catalogue) = lines.rewriting(index) { it.copy(restSeconds = restSeconds) }
    }
}

// A workout's plan under the lifter's edits. A movement with a logged set stands as it is: no edit touches its entry and no
// edit brings it back in. Every entry an edit wrote then takes a routine entry's bounds; an entry no edit wrote stands as stored.
class WorkoutPlan(val plan: PlanSnapshot, val logged: Set<Id<Exercise>>, val catalogue: Catalogue, val subject: RecordRef) {
    data class Line(val entry: RoutineEntry, val written: Boolean)

    sealed interface Revision {
        data class Revised(val plan: PlanSnapshot) : Revision
        data class Refused(val refusal: GymRefusal) : Revision
    }

    fun revised(operations: List<PlanOperation>): Revision {
        var lines = plan.entries.map { Line(it, written = false) }
        for ((k, operation) in operations.withIndex()) {
            val at = Path("operations") + k
            operation.index?.let { index ->
                val entry = lines.getOrNull(index)?.entry
                val set = operation.set
                if (entry == null || (set != null && set !in entry.sets.orEmpty().indices))
                    throw Violation(WorkoutPlanRules.operation, at, Violation.Reason.Custom("outOfRange"))
                if (entry.exerciseId in logged) return Revision.Refused(WorkoutPlanRules.logged(entry.exerciseId, subject))
            }
            operation.movement?.let { movement ->
                if (catalogue.find(movement) == null) return Revision.Refused(GymRefusal.predicted(Gym.Codes.unknownExercise, subject))
                if (lines.any { it.entry.exerciseId == movement })
                    throw Violation(WorkoutPlanRules.duplicate, at + "exerciseId", Violation.Reason.Custom("duplicate"))
                if (movement in logged) return Revision.Refused(WorkoutPlanRules.logged(movement, subject))
            }
            lines = operation.changed(lines, catalogue)
        }
        val bounded = WorkoutPlanRules.entries.apply(lines, Path("plan.entries")) { line, path -> if (line.written) line.copy(entry = line.entry.validated(path)) else line }
        return Revision.Revised(plan.copy(entries = bounded.map { it.entry }))
    }
}

object WorkoutPlanRules {
    val entries = CountSpec("session.plan.entries", 0, 50)
    const val absent = "session.plan.absent"
    const val duplicate = "session.plan.duplicate"
    const val operation = "session.plan.operation"
    val rules = listOf(
        Rule.local(entries),
        Rule.local(absent, Session.type),
        Rule.local(duplicate, Session.type),
        Rule.local(operation, Session.type),
        Rule.serverDecided("session.plan.exercise", listOf(RefusalCode(Gym.Codes.unknownExercise)), Session.type),
        Rule.serverDecided("session.plan.logged", listOf(RefusalCode(Gym.Codes.planLogged)), Session.type),
        Rule.serverDecided("session.finished", listOf(RefusalCode(Gym.Codes.sessionFinished)), Session.type),
        Rule.serverDecided("session.stale", listOf(RefusalCode.stale), Session.type),
    )

    // A movement with a logged set stands as the plan holds it; the refusal names it.
    fun logged(movement: Id<Exercise>, subject: RecordRef): GymRefusal =
        GymRefusal.predicted(Gym.Codes.planLogged, subject, Json.objectOf("exerciseId" to movement.json))
}

// The lifter's edit of the open workout's plan: every operation in order, then one guarded write of the whole plan, or
// nothing when the plan stands. `base` is the plan the editor read; any other stored plan is stale.
class ReviseWorkoutPlan(val sessionId: Id<Session>, val base: PlanSnapshot?, val operations: List<PlanOperation>) : Action<OpenWorkout, Unit, GymRefusal> {
    override val scope = Session.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = OpenWorkout(read, sessionId)
    override fun decide(loaded: OpenWorkout, ids: IDSource): Decision<Unit, GymRefusal> {
        loaded.refusal(sessionId.ref)?.let { return Decision.Refuse(it) }
        val stored = loaded.plan
        if (base != stored) return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.stale, sessionId.ref, path = Refused.Path.predicted)))
        val revised = when (val revision = WorkoutPlan(stored, loaded.logged, loaded.catalogue, sessionId.ref).revised(operations)) {
            is WorkoutPlan.Revision.Refused -> return Decision.Refuse(revision.refusal)
            is WorkoutPlan.Revision.Revised -> revision.plan
        }
        if (revised == stored) return Decision.Unchanged(Unit)
        val plan = Plan()
        plan.update(Valid(loaded.stored!!.copy(plan = revised), Session, listOf("plan"), loaded.moment), guarded = true)
        return Decision.Write(plan, Unit)
    }
}

// The receipt's card: the plan as the workout leaves it against its routine as drawn, R118's count with no name term, and
// whether the routine still stands as the workout started from it. No card for a plan that matches, no routine or no plan.
data class PlanChanges(val changes: List<RoutineChange>, val changeCount: Int, val offer: Offer) {
    enum class Offer { save, routineChanged, none }

    companion object {
        val none = PlanChanges(emptyList(), 0, Offer.none)

        fun of(read: Reader, id: Id<Session>): PlanChanges {
            val session = read.repository(Session).find(id, ViewMode.drawn)
            return of(session, session?.routineId?.let { read.repository(Routine).find(it, ViewMode.drawn) })
        }

        fun of(session: Session?, routine: Routine?): PlanChanges {
            val plan = session?.plan ?: return none
            if (routine == null || plan.entries == routine.entries) return none
            val changes = RoutineChange.between(routine.entries, plan.entries)
            val offer = if (routine.revision != null && routine.revision == session.routineRevision) Offer.save else Offer.routineChanged
            return PlanChanges(changes, RoutineChange.count(routine.entries, changes), offer)
        }
    }
}
