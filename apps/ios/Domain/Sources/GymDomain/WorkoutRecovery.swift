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
  // The copy is the phone's to correct, except that a spent identity stays spent whatever the copy says.
  public var canFix: Bool { reason != .identityTaken }

  // Every saved workout the account has not taken and nothing is carrying: refused by a notice it owns, refused by this
  // phone, or never sent. A retry dismisses the notices it answers, so a dismissed notice says nothing here; the newest
  // live one is the reason. A workout drawn on the log is there or on its way, and waits only on its own sets the log
  // does not draw: with none missing it is still adding, or confirmed and about to leave.
  public static func review(_ workouts: [SignedOutWorkout], notices: [DomainNotice<GymRefusal>], log: TrainingLog,
                            catalogue: Catalogue) -> [WorkoutRecovery] {
    let sessions = log.drawnSessions
    return workouts.compactMap { workout in
      let id = workout.session.id
      let live = notices.filter { workout.owns($0) && !$0.notice.isDismissed }
      let names = Dictionary(uniqueKeysWithValues: Set(workout.sets.map(\.exerciseId)).compactMap { exercise in
        catalogue.find(exercise).map { (exercise, $0.name) }
      })
      let reviewed = { (reason: Reason, refusal: GymRefusal?, retry: Retry, stranded: [TrainingSet]) in
        WorkoutRecovery(workout: workout, reason: reason, refusal: refusal, retry: retry, noticeIds: live.map(\.id),
                        strandedSets: stranded, movementNames: names)
      }
      if sessions.contains(where: { $0.id == id }) {
        let missing = workout.sets.filter { set in !log.sets.contains { $0.id == set.id } }
        guard !missing.isEmpty else { return nil }
        guard let latest = live.last else { return reviewed(.unsent, nil, .restoreSets, missing) }
        return reviewed(Reason(latest.refusal), latest.refusal, .restoreSets, missing)
      }
      let retry: Retry = workout.session.isOpen ? .restartWorkout : .importWorkout
      if let latest = live.last, stands(latest.refusal, against: workout, on: log) { return reviewed(Reason(latest.refusal), latest.refusal, retry, []) }
      if let refusal = workout.retryRefusal(at: log.moment, among: sessions, catalogue: catalogue) { return reviewed(Reason(refusal), refusal, retry, []) }
      return reviewed(.unsent, nil, retry, [])
    }
  }

  // A notice names what held the copy back when the account answered. While the phone's log is complete it can tell
  // that the account's open workout has closed, or that the workout the copy crossed no longer crosses it; then the
  // notice no longer stands, and the copy's own state is its reason. A workout the log does not draw may be one the
  // phone has not pulled yet, so a crossing with it stands.
  static func stands(_ refusal: GymRefusal, against workout: SignedOutWorkout, on log: TrainingLog) -> Bool {
    guard log.firstPullComplete else { return true }
    let sessions = log.drawnSessions
    switch refusal {
    case .sessionOpen: return sessions.contains { $0.isOpen && $0.id != workout.session.id }
    case .sessionOverlap(let refused):
      guard let crossed = refused.detail?["sessionId"].flatMap({ try? RecordID(json: $0) }) else { return true }
      let action = workout.importAction
      guard let other = sessions.first(where: { $0.id.record == crossed }) else { return true }
      return SessionRules.crosses(action.startedAt, action.finishedAt, other: other)
    default: return true
    }
  }
}

// The editor over a saved workout the account refused: its times, its routine link and each set, or, once the workout
// is on the log, its stranded sets alone, since its times and routine are the log's. `workout` is the corrected copy a
// retry submits; a set is removed by taking it out of `sets`.
public struct WorkoutFix: Equatable, Sendable {
  public struct SetFix: Equatable, Sendable, Identifiable {
    public let id: ID<TrainingSet>
    public var exerciseId: ID<Exercise>
    public var weightKg: Double
    public var reps: Int
    public var rpe: Double?
    public var note: String
    public var completedAt: Instant

    public init(_ set: TrainingSet) {
      id = set.id; exerciseId = set.exerciseId; weightKg = set.weightKg; reps = set.reps
      rpe = set.rpe; note = set.note; completedAt = set.completedAt
    }
    public func set(in session: ID<Session>) -> TrainingSet {
      TrainingSet(id: id, sessionId: session, exerciseId: exerciseId, weightKg: weightKg, reps: reps, rpe: rpe,
                  note: note, completedAt: completedAt)
    }
  }

  public let original: SignedOutWorkout
  public let landed: Bool
  public var startedAt: Instant
  public var finishedAt: Instant?
  public var keepsRoutine: Bool
  public var sets: [SetFix]
  let edited: Set<ID<TrainingSet>>

  public init(_ workout: SignedOutWorkout) {
    self.init(workout, editing: workout.sets, landed: false)
  }
  public init(_ recovery: WorkoutRecovery) {
    self.init(recovery.workout, editing: recovery.retry == .restoreSets ? recovery.strandedSets : recovery.workout.sets,
              landed: recovery.retry == .restoreSets)
  }
  init(_ workout: SignedOutWorkout, editing: [TrainingSet], landed: Bool) {
    original = workout; self.landed = landed
    startedAt = workout.session.startedAt; finishedAt = workout.session.finishedAt
    keepsRoutine = workout.session.routineId != nil
    sets = editing.map(SetFix.init); edited = Set(editing.map(\.id))
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
    return SignedOutWorkout(session: session, sets: original.sets.filter { !edited.contains($0.id) } + sets.map { $0.set(in: session.id) })
  }

  // The editor's live line: what this phone would refuse before asking the account. A landed workout's sets must be
  // valid and on known movements; a whole copy passes what its retry would meet (`SignedOutWorkout.retryRefusal`).
  public func refusal(at moment: Moment, among sessions: [Session], catalogue: Catalogue) -> GymRefusal? {
    if landed {
      for set in sets {
        do throws(Violation) { _ = try Valid(set.set(in: original.session.id), at: moment) } catch { return .invalid(error) }
        guard catalogue.find(set.exerciseId) != nil else { return .unknownExercise(Refused(Gym.Codes.unknownExercise, subject: set.id.ref, path: .predicted)) }
      }
      return nil
    }
    return workout.retryRefusal(at: moment, among: sessions, catalogue: catalogue)
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
    var plan = Plan()
    plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(saved, replacing: [], dropping: [id]))
    return .write(plan)
  }
}

// A set the account refused after its workout had landed lives only in its notice; the saved copy still holds it.
// `intoWorkout` puts the sets inside the workout's window back into it: appended while it is open, else corrected in,
// numbered after the ones it kept, its times left alone. `separately` makes the sets outside the window a saved copy of
// their own, from the first to the last, and queues its import, so a refusal of it is that copy's to fix. Either takes a
// revised copy, which replaces the saved one only when the retry is queued.
public struct RecoverStrandedSets: Action {
  public enum Placement: Sendable { case intoWorkout, separately }
  public struct Loaded {
    let backup: [SignedOutWorkout]
    let workout: SignedOutWorkout?
    let session: Session?
    let stranded: [TrainingSet]
    let state: TrainingState
  }
  public let id: ID<Session>
  public let placement: Placement
  public let revised: SignedOutWorkout?
  public init(_ id: ID<Session>, _ placement: Placement, revised: SignedOutWorkout? = nil) {
    precondition(revised == nil || revised?.session.id == id, "a revision keeps the saved workout's identity")
    self.id = id; self.placement = placement; self.revised = revised
  }
  public var scope: ScopeRef { Gym.scope }
  public func load(_ read: Reader) throws -> Loaded {
    let state = try TrainingState(read)
    let backup = try SignedOutWorkout.read(read)
    let workout = backup.first { $0.session.id == id }.map { revised ?? $0 }
    var stranded: [TrainingSet] = []
    for set in workout?.sets ?? [] where try read.confirmed(TrainingSet.self, set.id) == nil && !state.drawnSets.contains(where: { $0.id == set.id }) {
      stranded.append(set)
    }
    return Loaded(backup: backup, workout: workout, session: try read.repository(Session.self).find(id, in: .stored), stranded: stranded, state: state)
  }
  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard let workout = loaded.workout, !loaded.stranded.isEmpty else { return .unchanged(()) }
    guard let session = loaded.session else { return .refuse(.gone(id.ref, .predicted)) }
    let inside = loaded.stranded.filter { set in
      set.completedAt >= session.startedAt && (session.finishedAt.map { set.completedAt <= $0 } ?? true)
    }
    switch placement {
    case .intoWorkout:
      guard !inside.isEmpty else { return .unchanged(()) }
      var plan: Plan
      switch try placed(inside, in: session, state: loaded.state, ids: ids) {
      case .write(let placing, _): plan = placing
      case .refuse(let refusal): return .refuse(refusal)
      case .unchanged: return .unchanged(())
      }
      plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded.backup, replacing: [workout]))
      return .write(plan)
    case .separately:
      let outside = loaded.stranded.filter { set in !inside.contains { $0.id == set.id } }
      guard let first = outside.first, let last = outside.last else { return .unchanged(()) }
      let separate = Session(id: ids.mint(Session.self), startedAt: first.completedAt, finishedAt: last.completedAt, closedBy: "finish")
      let copy = SignedOutWorkout(session: separate, sets: outside.map { set in
        TrainingSet(id: set.id, sessionId: separate.id, exerciseId: set.exerciseId, weightKg: set.weightKg, reps: set.reps,
                    rpe: set.rpe, note: set.note, completedAt: set.completedAt)
      })
      if let refusal = copy.importRefusal(at: loaded.state.moment, among: loaded.state.stored, catalogue: loaded.state.catalogue) { return .refuse(refusal) }
      var plan: Plan
      switch copy.importAction.decision((state: loaded.state, routine: nil), ids: ids) {
      case .write(let imported, _): plan = imported
      case .refuse(let refusal): return .refuse(refusal)
      case .unchanged: return .unchanged(())
      }
      let kept = SignedOutWorkout(session: workout.session, sets: workout.sets.filter { set in !outside.contains { $0.id == set.id } })
      plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded.backup, replacing: [kept, copy]))
      return .write(plan)
    }
  }

  func placed(_ sets: [TrainingSet], in session: Session, state: TrainingState, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard let finish = session.finishedAt else {
      var plan = Plan(), planned: [TrainingSet] = []
      for set in sets {
        let valid = try Valid(set, at: state.moment)
        if let refusal = try AppendSet.refusal(appending: valid, to: session, state: state, planned: planned) { return .refuse(refusal) }
        plan.create(valid); planned.append(valid.value)
      }
      return .write(plan)
    }
    var numbers: [ID<Exercise>: Int] = [:]
    var corrected: [CorrectedSet] = []
    for set in sets {
      let next = numbers[set.exerciseId] ?? SetRules.nextNumber(state.sets, sessionId: id, exerciseId: set.exerciseId)
      guard let next, next <= SetRules.maxNumber else { throw Violation(rule: "set.setNumber", path: "setNumber", reason: .above(max: Double(SetRules.maxNumber))) }
      numbers[set.exerciseId] = next + 1
      corrected.append(CorrectedSet(id: set.id, exerciseId: set.exerciseId, setNumber: next, weightKg: set.weightKg, reps: set.reps,
                                    completedAt: set.completedAt, rpe: set.rpe, note: set.note, rpeNamed: true))
    }
    let correction = CorrectSession(id: id, requestId: ids.opaqueID(), startedAt: session.startedAt, finishedAt: finish,
                                    routineName: session.displayName, sets: corrected, preserveOtherSets: true)
    return correction.decision(state, ids: ids)
  }
}
