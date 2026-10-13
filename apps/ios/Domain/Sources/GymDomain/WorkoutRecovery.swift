import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A signed-out workout the account has not taken: why it is still on this phone, what a retry does and the sets it would move.
public struct WorkoutRecovery: Equatable, Sendable, Identifiable {
  // The raw value is the bounded label telemetry carries; copy is the surface's.
  public enum Reason: String, CaseIterable, Sendable {
    case accountWorkoutOpen = "session-open"
    case overlap = "session-overlap"
    case identityTaken = "id-taken"
    case badTime = "bad-instant"
    case tooManySets = "too-many-sets"
    case invalidSet = "invalid-set"
    case unknownMovement = "unknown-exercise"
    case strandedSets = "session-finished"
    case unsent = "unsent"
    case other = "other"

    public init(_ refusal: GymRefusal) {
      switch refusal {
      case .sessionOpen: self = .accountWorkoutOpen
      case .sessionOverlap: self = .overlap
      case .taken, .payloadConflict: self = .identityTaken
      case .badInstant: self = .badTime
      case .invalid(let violation) where violation.rule == "session.sets": self = .tooManySets
      case .invalid(let violation) where ["session.startedAt", "session.finishedAt", "set.completedAt"].contains(violation.rule): self = .badTime
      case .invalid: self = .invalidSet
      case .unknownExercise: self = .unknownMovement
      case .sessionFinished: self = .strandedSets
      case .full, .stale, .gone, .future, .proposalSettled, .proposalSuperseded, .other: self = .other
      }
    }
  }

  // Which action a retry runs: the import of a finished copy, the start of an open one, or the sets a landed workout refused.
  public enum Retry: Sendable { case importWorkout, restartWorkout, restoreSets }

  public let workout: SignedOutWorkout
  public let reason: Reason
  public let refusal: GymRefusal?
  public let retry: Retry
  public let noticeIds: [String]
  public let strandedSets: [TrainingSet]
  public let movementNames: [ID<Exercise>: String]

  public var id: ID<Session> { workout.session.id }
  // A landed workout's stranded sets are placed by Retry, and a spent identity stays spent whatever the copy says.
  public var canFix: Bool { retry != .restoreSets && reason != .identityTaken }

  // Every saved workout the account has not taken and nothing is carrying: refused by a notice, refused by this phone, or
  // never sent. A workout drawn on the log is on its way, or there, and is listed only for the sets it refused.
  public static func review(_ workouts: [SignedOutWorkout], notices: [DomainNotice<GymRefusal>], log: TrainingLog,
                            catalogue: Catalogue) -> [WorkoutRecovery] {
    let sessions = log.drawnSessions
    return workouts.compactMap { workout in
      let id = workout.session.id
      let linked = notices.filter { notice in
        guard let subject = notice.subject else { return false }
        if subject == id.ref { return true }
        return subject.type == TrainingSet.type && notice.values(of: subject)["sessionId"] == id.json
      }
      let landed = sessions.contains { $0.id == id }
      let retry: Retry = landed ? .restoreSets : workout.session.isOpen ? .restartWorkout : .importWorkout
      let names = Dictionary(uniqueKeysWithValues: Set(workout.sets.map(\.exerciseId)).compactMap { exercise in
        catalogue.find(exercise).map { (exercise, $0.name) }
      })
      let reviewed = { (reason: Reason, refusal: GymRefusal?) in
        WorkoutRecovery(workout: workout, reason: reason, refusal: refusal, retry: retry, noticeIds: linked.map(\.id),
                      strandedSets: workout.sets.filter { set in linked.contains { $0.subject == set.id.ref } }, movementNames: names)
      }
      if landed {
        guard let latest = linked.last(where: { $0.subject?.type == TrainingSet.type }) else { return nil }
        return reviewed(Reason(latest.refusal), latest.refusal)
      }
      if let latest = linked.last { return reviewed(Reason(latest.refusal), latest.refusal) }
      if let refusal = workout.importRefusal(at: log.moment, among: sessions) { return reviewed(Reason(refusal), refusal) }
      if workout.session.isOpen, log.open != nil {
        return reviewed(.accountWorkoutOpen, .sessionOpen(Refused(Gym.Codes.sessionOpen, subject: id.ref, path: .predicted)))
      }
      return reviewed(.unsent, nil)
    }
  }
}

// The editor over a saved workout the account refused: its times, its routine link and each set. `workout` is the corrected
// copy a retry submits; a set is removed by taking it out of `sets`.
public struct WorkoutFix: Equatable, Sendable {
  public struct SetFix: Equatable, Sendable, Identifiable {
    public let id: ID<TrainingSet>
    public var exerciseId: ID<Exercise>
    public var weightKg: Double
    public var reps: Int
    public var kind: String
    public var rpe: Double?
    public var note: String
    public var completedAt: Instant

    public init(_ set: TrainingSet) {
      id = set.id; exerciseId = set.exerciseId; weightKg = set.weightKg; reps = set.reps; kind = set.kind
      rpe = set.rpe; note = set.note; completedAt = set.completedAt
    }
    public func set(in session: ID<Session>) -> TrainingSet {
      TrainingSet(id: id, sessionId: session, exerciseId: exerciseId, weightKg: weightKg, reps: reps, kind: kind, rpe: rpe,
                  note: note, completedAt: completedAt)
    }
  }

  public let original: SignedOutWorkout
  public var startedAt: Instant
  public var finishedAt: Instant?
  public var keepsRoutine: Bool
  public var sets: [SetFix]

  public init(_ workout: SignedOutWorkout) {
    original = workout
    startedAt = workout.session.startedAt; finishedAt = workout.session.finishedAt
    keepsRoutine = workout.session.routineId != nil
    sets = workout.sets.map(SetFix.init)
  }

  public var hasRoutine: Bool { original.session.routineId != nil }
  public var isOpen: Bool { finishedAt == nil }
  public var isChanged: Bool { workout != original }

  // Finished at its last set, or at its start when it has none.
  public mutating func markFinished() {
    finishedAt = max(startedAt, sets.map(\.completedAt).max() ?? startedAt)
  }

  public var workout: SignedOutWorkout {
    let saved = original.session
    let closedBy = finishedAt == nil ? nil : finishedAt == saved.finishedAt ? saved.closedBy : "finish"
    let session = Session(id: saved.id, startedAt: startedAt, finishedAt: finishedAt, closedBy: closedBy,
                          routineId: keepsRoutine ? saved.routineId : nil, historyRoutineId: keepsRoutine ? saved.historyRoutineId : nil,
                          plan: keepsRoutine ? saved.plan : nil, displayName: saved.displayName,
                          unreadablePlan: keepsRoutine ? saved.unreadablePlan : nil)
    return SignedOutWorkout(session: session, sets: sets.map { $0.set(in: session.id) })
  }

  // The editor's live line: what this phone would refuse before asking the account. An open copy restarts only while
  // the account has no open workout of its own.
  public func refusal(at moment: Moment, among sessions: [Session]) -> GymRefusal? {
    if isOpen, sessions.contains(where: { $0.isOpen && $0.id != original.session.id }) {
      return .sessionOpen(Refused(Gym.Codes.sessionOpen, subject: original.session.id.ref, path: .predicted))
    }
    return workout.importRefusal(at: moment, among: sessions)
  }
}

// Drops a saved copy the account has not taken, with every set it holds.
public struct DiscardSignedOutWorkout: Action {
  public let id: ID<Session>
  public init(_ id: ID<Session>) { self.id = id }
  public var scope: ScopeRef { Gym.scope }
  public func load(_ read: Reader) throws -> [SignedOutWorkout] { try SignedOutWorkout.read(read) }
  public func decide(_ saved: [SignedOutWorkout], ids: IDSource) -> Decision<Void, GymRefusal> {
    guard saved.contains(where: { $0.session.id == id }) else { return .unchanged(()) }
    let kept = JSON.Object(uniqueKeysWithValues: saved.filter { $0.session.id != id }.map { ($0.session.id.description, $0.json) })
    var plan = Plan()
    plan.device(SignedOutWorkout.key, kept.isEmpty ? nil : .object(kept))
    return .write(plan)
  }
}

// A set the account refused after its workout had landed and finished lives only in its notice; the saved copy still holds
// it. `intoWorkout` puts the sets inside the workout's window back into it, numbered after the ones it kept, and leaves its
// times alone; `separately` imports the ones outside it as a workout of their own, from the first to the last.
public struct RecoverStrandedSets: Action {
  public enum Placement: Sendable { case intoWorkout, separately }
  public struct Loaded {
    let workout: SignedOutWorkout?
    let session: Session?
    let stranded: [TrainingSet]
    let state: TrainingState
  }
  public let id: ID<Session>
  public let placement: Placement
  public init(_ id: ID<Session>, _ placement: Placement) { self.id = id; self.placement = placement }
  public var scope: ScopeRef { Gym.scope }
  public func load(_ read: Reader) throws -> Loaded {
    let state = try TrainingState(read)
    let workout = try SignedOutWorkout.read(read).first { $0.session.id == id }
    var stranded: [TrainingSet] = []
    for set in workout?.sets ?? [] where try read.confirmed(TrainingSet.self, set.id) == nil && !state.drawnSets.contains(where: { $0.id == set.id }) {
      stranded.append(set)
    }
    return Loaded(workout: workout, session: try read.repository(Session.self).find(id, in: .stored), stranded: stranded, state: state)
  }
  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard loaded.workout != nil, !loaded.stranded.isEmpty else { return .unchanged(()) }
    guard let session = loaded.session else { return .refuse(.gone(id.ref, .predicted)) }
    guard let finish = session.finishedAt else { return .refuse(.sessionOpen(Refused(Gym.Codes.sessionOpen, subject: id.ref, path: .predicted))) }
    let inside = loaded.stranded.filter { $0.completedAt >= session.startedAt && $0.completedAt <= finish }
    switch placement {
    case .intoWorkout:
      guard !inside.isEmpty else { return .unchanged(()) }
      var numbers: [ID<Exercise>: Int] = [:]
      var corrected: [CorrectedSet] = []
      for set in inside {
        let next = numbers[set.exerciseId] ?? SetRules.nextNumber(loaded.state.sets, sessionId: id, exerciseId: set.exerciseId)
        guard let next, next <= SetRules.maxNumber else { throw Violation(rule: "set.setNumber", path: "setNumber", reason: .above(max: Double(SetRules.maxNumber))) }
        numbers[set.exerciseId] = next + 1
        corrected.append(CorrectedSet(id: set.id, exerciseId: set.exerciseId, setNumber: next, weightKg: set.weightKg, reps: set.reps,
                                      completedAt: set.completedAt, rpe: set.rpe, note: set.note, rpeNamed: true, kind: set.kind))
      }
      let correction = CorrectSession(id: id, requestId: ids.opaqueID(), startedAt: session.startedAt, finishedAt: finish,
                                      routineName: session.displayName, sets: corrected, preserveOtherSets: true)
      return correction.decision(loaded.state, ids: ids)
    case .separately:
      let outside = loaded.stranded.filter { set in !inside.contains { $0.id == set.id } }
      guard let first = outside.first, let last = outside.last else { return .unchanged(()) }
      let imported = ImportSession(id: ids.mint(Session.self), startedAt: first.completedAt, finishedAt: last.completedAt,
        sets: outside.map { ImportedSet(id: $0.id, exerciseId: $0.exerciseId, weightKg: $0.weightKg, reps: $0.reps,
          completedAt: $0.completedAt, kind: $0.kind, rpe: $0.rpe, note: $0.note, rpeNamed: true) })
      switch imported.decision((state: loaded.state, routine: nil), ids: ids) {
      case .write(let plan, _): return .write(plan)
      case .refuse(let refusal): return .refuse(refusal)
      case .unchanged: return .unchanged(())
      }
    }
  }
}
