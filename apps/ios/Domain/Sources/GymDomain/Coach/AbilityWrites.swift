import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// The abilities Coach writes with on the replica, each composing the gesture's own decider (kit §9.3) under the id the
// turn gave the call (Coach G-7). A replay finds its record stored and answers as the first call did.

// `create_exercise`: a movement lands in the catalogue; one already there under the call's id is its replay.
public struct CreateExerciseCall: Decider {
  public let exercise: Exercise

  public init(_ exercise: Exercise) {
    self.exercise = exercise
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> (stored: Exercise?, moment: Moment) {
    (try read.repository(Exercise.self).find(exercise.id, in: .stored), read.moment)
  }

  public func decide(_ loaded: (stored: Exercise?, moment: Moment), ids: IDSource) throws(Violation) -> Decision<AbilityAnswer, GymRefusal> {
    if let stored = loaded.stored { return .unchanged(AbilityAnswer(CoachDocuments.exercise(stored))) }
    let valid = try Valid(exercise, at: loaded.moment)
    switch CreateExercise(exercise).decision(loaded.moment, ids: ids) {
    case .refuse(let refusal): return .refuse(refusal)
    case .unchanged: return .unchanged(AbilityAnswer(CoachDocuments.exercise(valid.value)))
    case .write(let plan, let id): return .write(plan, AbilityAnswer(CoachDocuments.exercise(valid.value), created: [id.ref]))
    }
  }
}

// `create_routine`: a new day of the program lands as the lifter's editor would save it. A routine already standing
// under the call's id replays when it holds this document in its stored form, composed and trimmed, and refuses another.
public struct CreateRoutineCall: Decider {
  public struct Loaded {
    let stored: Routine?
    let creation: RoutineCreation?
    let catalogue: Catalogue
    let moment: Moment
  }

  public let routine: Routine

  public init(_ routine: Routine) {
    self.routine = routine
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    Loaded(stored: try read.repository(Routine.self).find(routine.id, in: .stored),
           creation: try read.repository(RoutineCreation.self).find(ID(routine.id.record), in: .stored),
           catalogue: try Catalogue(read), moment: read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<AbilityAnswer, GymRefusal> {
    if let snapshot = loaded.creation?.snapshot { return .unchanged(AbilityAnswer(snapshot)) }
    let valid = try Valid(routine, at: loaded.moment)
    if let stored = loaded.stored {
      guard stored.fields == valid.value.fields else { return .refuse(GymRefusal(Refused(.idTaken, subject: routine.id.ref, path: .predicted))) }
      return .unchanged(AbilityAnswer(CoachDocuments.routine(stored)))
    }
    if valid.value.entries.contains(where: { loaded.catalogue.find($0.exerciseId) == nil }) {
      return .refuse(GymRefusal(Refused(Gym.Codes.unknownExercise, subject: routine.id.ref, path: .predicted)))
    }
    var plan = Plan()
    plan.create(valid)
    return .write(plan, AbilityAnswer(CoachDocuments.routine(valid.value), created: [routine.id.ref]))
  }
}

// `save_note`: Coach's note goes below every stored note; a duplicate or a replay answers the note that stands.
public struct SaveNoteAbility: Decider {
  public let note: Note

  public init(_ note: Note) {
    self.note = note
  }

  public var scope: ScopeRef { Gym.scope }
  public func load(_ read: Reader) throws -> SaveNoteCall.Loaded { try SaveNoteCall(note).load(read) }

  public func decide(_ loaded: SaveNoteCall.Loaded, ids: IDSource) throws(Violation) -> Decision<AbilityAnswer, GymRefusal> {
    switch SaveNoteCall(note).decision(loaded, ids: ids) {
    case .refuse(let refusal): return .refuse(refusal)
    case .unchanged(let id):
      guard let standing = loaded.stored.first(where: { $0.id == id }), let position = Note.position(of: id, stored: loaded.stored) else {
        return .refuse(GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted)))
      }
      return .unchanged(AbilityAnswer(["saved": true, "note": CoachDocuments.note(standing, position: position)]))
    case .write(let plan, let id):
      let saved = try Valid(note, at: loaded.save.moment).value
      return .write(plan, AbilityAnswer(["saved": true, "note": CoachDocuments.note(saved, position: loaded.stored.count)], created: [id.ref]))
    }
  }
}

// `propose_routine_change` and `propose_routine_removal`: a proposal is minted under the call's id and the lifter decides;
// a proposal already standing under that id is its replay, whatever it holds.
public struct ProposeRoutineCall: Decider {
  public struct Loaded {
    let stored: Proposal?
    let proposing: ProposeRoutine.Loaded
    let setsByExercise: [ID<Exercise>: Int]
  }

  public let proposing: ProposeRoutine
  public let appBaseUrl: String

  public init(_ proposing: ProposeRoutine, appBaseUrl: String) {
    self.proposing = proposing
    self.appBaseUrl = appBaseUrl
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    let log = try TrainingLog(read)
    let counted = Dictionary(grouping: log.drawnSessions.flatMap { log.sets(session: $0.id) }, by: \.exerciseId).mapValues(\.count)
    return Loaded(stored: try read.repository(Proposal.self).find(proposing.id, in: .stored), proposing: try proposing.load(read),
                  setsByExercise: counted)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<AbilityAnswer, GymRefusal> {
    let receipt = { (proposal: Proposal) in
      CoachDocuments.proposal(proposal, routine: loaded.proposing.routine, loggedSets: { loaded.setsByExercise[$0] ?? 0 }, appBaseUrl: appBaseUrl)
    }
    if let stored = loaded.stored { return .unchanged(AbilityAnswer(receipt(stored))) }
    switch try proposing.proposed(over: loaded.proposing) {
    case .refuse(let refusal): return .refuse(refusal)
    case .unchanged: throw Violation(rule: "proposal.changes", path: "entries", reason: .custom("noChange"))
    case .proposal(let valid, let plan): return .write(plan, AbilityAnswer(receipt(valid.value), created: [proposing.id.ref]))
    }
  }
}

// `propose_workout_change`: a workout proposal is minted under the call's id and the lifter decides on the workout's card;
// a proposal already standing under that id is its replay, whatever it holds.
public struct ProposeWorkoutCall: Decider {
  public struct Loaded {
    let stored: WorkoutProposal?
    let workout: OpenWorkout
  }

  public let proposing: ProposeWorkout

  public init(_ proposing: ProposeWorkout) {
    self.proposing = proposing
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    Loaded(stored: try read.repository(WorkoutProposal.self).find(proposing.id, in: .stored), workout: try proposing.load(read))
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<AbilityAnswer, GymRefusal> {
    let session = loaded.workout.session
    let receipt = { (proposal: WorkoutProposal) in
      CoachDocuments.workoutProposal(proposal, base: session?.plan?.entries ?? [], planRevision: session?.planRevision)
    }
    if let stored = loaded.stored { return .unchanged(AbilityAnswer(receipt(stored))) }
    switch try proposing.proposed(over: loaded.workout) {
    case .refuse(let refusal): return .refuse(refusal)
    case .unchanged: throw Violation(rule: WorkoutProposalRules.lines.changes.path, path: "entries", reason: .custom("noChange"))
    case .proposal(let valid, let plan): return .write(plan, AbilityAnswer(receipt(valid.value), created: [proposing.id.ref]))
    }
  }
}
