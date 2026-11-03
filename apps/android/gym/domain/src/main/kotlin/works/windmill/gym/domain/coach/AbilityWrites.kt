package works.windmill.gym.domain.coach

import works.windmill.domain.kit.*
import works.windmill.gym.domain.sync.Catalogue
import works.windmill.gym.domain.sync.CreateExercise
import works.windmill.gym.domain.sync.Exercise
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.Note
import works.windmill.gym.domain.sync.OpenWorkout
import works.windmill.gym.domain.sync.Proposal
import works.windmill.gym.domain.sync.ProposalRules
import works.windmill.gym.domain.sync.ProposeRoutine
import works.windmill.gym.domain.sync.ProposeWorkout
import works.windmill.gym.domain.sync.Proposed
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.domain.sync.RoutineCreation
import works.windmill.gym.domain.sync.SaveNoteCall
import works.windmill.gym.domain.sync.TrainingHistory
import works.windmill.gym.domain.sync.TrainingLog
import works.windmill.gym.domain.sync.WorkoutProposal
import works.windmill.gym.domain.sync.WorkoutProposalRules
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.schema.Gym

// The abilities Coach writes with on the replica, each composing the gesture's own decider (kit §9.3) under the id the turn gave the call (Coach G-7). A replay finds its record stored and answers as the first call did, creating nothing.

// `create_exercise`: a movement lands in the catalogue; one already there under the call's id is its replay.
class CreateExerciseCall(val exercise: Exercise) : Decider<CreateExerciseCall.Loaded, AbilityAnswer, GymRefusal> {
    data class Loaded(val stored: Exercise?, val moment: Moment)

    override val scope = Exercise.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded(read.repository(Exercise).find(exercise.id, ViewMode.stored), read.moment)

    override fun decide(loaded: Loaded, ids: IDSource): Decision<AbilityAnswer, GymRefusal> {
        if (loaded.stored != null) return Decision.Unchanged(AbilityAnswer(TrainingHistory.exerciseDocument(loaded.stored)))
        val document = TrainingHistory.exerciseDocument(Valid(exercise, Exercise, at = loaded.moment).value)
        return when (val created = CreateExercise(exercise).decision(loaded.moment, ids)) {
            is Decision.Refuse -> created
            is Decision.Unchanged -> Decision.Unchanged(AbilityAnswer(document))
            is Decision.Write -> Decision.Write(created.plan, AbilityAnswer(document, created = listOf(created.result.ref)))
        }
    }
}

// `create_routine`: a new day of the program lands as the lifter's editor would save it. A routine already standing under the call's id replays when it holds this document in its stored form, composed and trimmed, and refuses another.
class CreateRoutineCall(val routine: Routine) : Decider<CreateRoutineCall.Loaded, AbilityAnswer, GymRefusal> {
    data class Loaded(val stored: Routine?, val creation: RoutineCreation?, val catalogue: Catalogue, val moment: Moment)

    override val scope = Routine.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded(read.repository(Routine).find(routine.id, ViewMode.stored),
        read.repository(RoutineCreation).find(Id(routine.id.record, RoutineCreation), ViewMode.stored), Catalogue(read), read.moment)

    override fun decide(loaded: Loaded, ids: IDSource): Decision<AbilityAnswer, GymRefusal> {
        loaded.creation?.snapshot?.let { return Decision.Unchanged(AbilityAnswer(it)) }
        val valid = Valid(routine, Routine, at = loaded.moment)
        if (loaded.stored != null) {
            if (loaded.stored.fields() != valid.value.fields()) return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.idTaken, routine.id.ref, path = Refused.Path.predicted)))
            return Decision.Unchanged(AbilityAnswer(CoachDocuments.routine(loaded.stored)))
        }
        if (valid.value.entries.any { loaded.catalogue.find(it.exerciseId) == null }) return Decision.Refuse(GymRefusal.predicted(Gym.Codes.unknownExercise, routine.id.ref))
        val plan = Plan()
        plan.create(valid)
        return Decision.Write(plan, AbilityAnswer(CoachDocuments.routine(valid.value), created = listOf(routine.id.ref)))
    }
}

// `save_note`: Coach's note goes below every stored note; a duplicate or a replay answers the note that stands.
class SaveNoteAbility(val note: Note) : Decider<SaveNoteCall.Loaded, AbilityAnswer, GymRefusal> {
    private val saving = SaveNoteCall(note)

    override val scope = Note.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = saving.load(read)

    override fun decide(loaded: SaveNoteCall.Loaded, ids: IDSource): Decision<AbilityAnswer, GymRefusal> = when (val saved = saving.decision(loaded, ids)) {
        is Decision.Refuse -> saved
        is Decision.Unchanged -> {
            val standing = loaded.stored.firstOrNull { it.id == saved.result }
            val position = Note.position(saved.result, loaded.stored)
            if (standing == null || position == null) Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, saved.result.ref, path = Refused.Path.predicted)))
            else Decision.Unchanged(AbilityAnswer(answer(standing, position)))
        }
        is Decision.Write -> Decision.Write(saved.plan, AbilityAnswer(answer(Valid(note, Note, at = loaded.save.moment).value, loaded.stored.size), created = listOf(saved.result.ref)))
    }

    private fun answer(value: Note, position: Int) = Json.objectOf("saved" to Json.of(true), "note" to CoachDocuments.note(value, position))
}

// `propose_routine_change` and `propose_routine_removal`: a proposal is minted under the call's id and the lifter decides; a proposal already standing under that id is its replay, whatever it holds.
class ProposeRoutineCall(val proposing: ProposeRoutine, val appBaseUrl: String) : Decider<ProposeRoutineCall.Loaded, AbilityAnswer, GymRefusal> {
    data class Loaded(val stored: Proposal?, val proposing: ProposeRoutine.Loaded, val setsByExercise: Map<Id<Exercise>, Int>)

    override val scope = Proposal.scope
    override val refusals = GymRefusal

    override fun load(read: Reader): Loaded {
        val log = TrainingLog(read)
        val workouts = log.sessions.map { it.id }.toSet()
        return Loaded(read.repository(Proposal).find(proposing.id, ViewMode.stored), proposing.load(read),
            log.sets.filter { it.sessionId in workouts }.groupingBy { it.exerciseId }.eachCount())
    }

    override fun decide(loaded: Loaded, ids: IDSource): Decision<AbilityAnswer, GymRefusal> {
        fun receipt(proposal: Proposal) = CoachDocuments.proposal(proposal, loaded.proposing.routine, { loaded.setsByExercise[it] ?: 0 }, appBaseUrl)
        if (loaded.stored != null) return Decision.Unchanged(AbilityAnswer(receipt(loaded.stored)))
        return when (val proposed = proposing.proposed(loaded.proposing)) {
            is Proposed.Refuse -> Decision.Refuse(proposed.refusal)
            Proposed.Unchanged -> throw Violation(ProposalRules.change.changes.path, Path("entries"), Violation.Reason.Custom("noChange"))
            is Proposed.Minted -> Decision.Write(proposed.plan, AbilityAnswer(receipt(proposed.proposal.value), created = listOf(proposing.id.ref)))
        }
    }
}

// `propose_workout_change`: a workout proposal is minted under the call's id and the lifter decides on the workout's card; a proposal already standing under that id is its replay, whatever it holds.
class ProposeWorkoutCall(val proposing: ProposeWorkout) : Decider<ProposeWorkoutCall.Loaded, AbilityAnswer, GymRefusal> {
    data class Loaded(val stored: WorkoutProposal?, val workout: OpenWorkout)

    override val scope = WorkoutProposal.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded(read.repository(WorkoutProposal).find(proposing.id, ViewMode.stored), proposing.load(read))

    override fun decide(loaded: Loaded, ids: IDSource): Decision<AbilityAnswer, GymRefusal> {
        val session = loaded.workout.session
        fun receipt(proposal: WorkoutProposal) = CoachDocuments.workoutProposal(proposal, session?.plan?.entries.orEmpty(), session?.planRevision)
        if (loaded.stored != null) return Decision.Unchanged(AbilityAnswer(receipt(loaded.stored)))
        return when (val proposed = proposing.proposed(loaded.workout)) {
            is Proposed.Refuse -> Decision.Refuse(proposed.refusal)
            Proposed.Unchanged -> throw Violation(WorkoutProposalRules.change.changes.path, Path("entries"), Violation.Reason.Custom("noChange"))
            is Proposed.Minted -> Decision.Write(proposed.plan, AbilityAnswer(receipt(proposed.proposal.value), created = listOf(proposing.id.ref)))
        }
    }
}
