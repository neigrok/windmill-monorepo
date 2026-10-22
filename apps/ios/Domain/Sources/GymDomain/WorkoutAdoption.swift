import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct SignedOutWorkout: Equatable, Sendable {
  public static let key = "rack:adoption"
  public let session: Session
  public let sets: [TrainingSet]

  public init(session: Session, sets: [TrainingSet]) {
    self.session = session; self.sets = sets.filter { $0.sessionId == session.id }.sorted { $0.completedAt == $1.completedAt ? $0.id < $1.id : $0.completedAt < $1.completedAt }
  }
  public init(_ value: JSON) throws {
    let fields = try Fields(value)
    guard let sessionJSON = fields.json("session") else { throw DecodeError(type: Session.type, field: "adoption", reason: "missing session") }
    let sessionFields = try Fields(sessionJSON)
    let id = try sessionFields.ref("id", Session.self)
    guard case .object(let values) = fields.json("session"), case .array(let rows) = fields.json("sets") else {
      throw DecodeError(type: Session.type, field: "adoption", reason: "invalid saved workout")
    }
    session = try Session(Fields(type: Session.type, id: id.record, values: Dictionary(uniqueKeysWithValues: values.members.map { ($0.key, $0.value) })))
    sets = try rows.map { row in
      let fields = try Fields(row), id = try fields.ref("id", TrainingSet.self)
      guard case .object(let values) = row else { throw DecodeError(type: TrainingSet.type, field: "adoption", reason: "invalid saved set") }
      return try TrainingSet(Fields(type: TrainingSet.type, id: id.record, values: Dictionary(uniqueKeysWithValues: values.members.map { ($0.key, $0.value) })))
    }
  }
  public var json: JSON {
    var sessionFields = session.fields; sessionFields["id"] = session.id.json
    let rows = sets.map { set -> JSON in
      var fields = set.fields; fields["id"] = set.id.json
      return .object(JSON.Object(uniqueKeysWithValues: fields.map { ($0.key, $0.value) }))
    }
    return ["session": .object(JSON.Object(uniqueKeysWithValues: sessionFields.map { ($0.key, $0.value) })), "sets": .array(rows)]
  }
  public var importAction: ImportSession {
    ImportSession(id: session.id, startedAt: session.startedAt,
      finishedAt: session.finishedAt ?? SessionRules.lastActivity(session, sets: sets),
      sets: sets.map { ImportedSet(id: $0.id, exerciseId: $0.exerciseId, weightKg: $0.weightKg, reps: $0.reps,
        completedAt: $0.completedAt, rpe: $0.rpe, note: $0.note, rpeNamed: true) }, routineId: session.routineId)
  }
  // What this phone refuses before asking the account: the import's own checks, a window reaching past now, a movement
  // the catalogue lacks, then a crossing with a finished workout on the log.
  public func importRefusal(at moment: Moment, among sessions: [Session], catalogue: Catalogue) -> GymRefusal? {
    let action = importAction
    if case .failure(let refusal) = action.checked(at: moment) { return refusal }
    if action.finishedAt > moment.now { return .badInstant(Refused(Gym.Codes.badInstant, subject: session.id.ref, path: .predicted)) }
    if let missing = sets.first(where: { catalogue.find($0.exerciseId) == nil }) {
      return .unknownExercise(Refused(Gym.Codes.unknownExercise, subject: missing.id.ref, path: .predicted))
    }
    let crossed = sessions.filter { $0.id != session.id && SessionRules.crosses(action.startedAt, action.finishedAt, other: $0) }
      .min { $0.startedAt == $1.startedAt ? $0.id < $1.id : $0.startedAt < $1.startedAt }
    guard let crossed else { return nil }
    return .sessionOverlap(Refused(Gym.Codes.sessionOverlap, subject: session.id.ref, detail: ["sessionId": crossed.id.json], path: .predicted))
  }
  // What this phone refuses before a retry asks the account. A finished copy is an import, with the import's checks.
  // An open copy restarts as a start that does not join, with its sets appended: the log refuses that while it holds an
  // open workout of its own, and never for crossing a finished one.
  public func retryRefusal(at moment: Moment, among sessions: [Session], catalogue: Catalogue) -> GymRefusal? {
    guard session.isOpen else { return importRefusal(at: moment, among: sessions, catalogue: catalogue) }
    if sessions.contains(where: { $0.isOpen && $0.id != session.id }) {
      return .sessionOpen(Refused(Gym.Codes.sessionOpen, subject: session.id.ref, path: .predicted))
    }
    do throws(Violation) { try SessionRules.instant(session.startedAt, rule: "session.startedAt", at: "startedAt") } catch { return .invalid(error) }
    guard session.startedAt <= moment.now else { return .badInstant(Refused(Gym.Codes.badInstant, subject: session.id.ref, path: .predicted)) }
    for set in sets {
      do throws(Violation) { _ = try Valid(set, at: moment) } catch { return .invalid(error) }
      guard catalogue.find(set.exerciseId) != nil else { return .unknownExercise(Refused(Gym.Codes.unknownExercise, subject: set.id.ref, path: .predicted)) }
    }
    return nil
  }
  // A notice this copy owns: a refusal of the gestures recovery queues for it, its import, its start with its sets, a
  // correction of its session or the creation of one of its sets. A later edit of a set that landed is the room's.
  public func owns(_ notice: DomainNotice<GymRefusal>) -> Bool {
    let content = notice.notice.content
    if let command = content.command {
      switch command.name {
      case Gym.Commands.importSession, Gym.Commands.start: if command.args["id"] == session.id.json { return true }
      case Gym.Commands.correctSession: if command.args["sessionId"] == session.id.json { return true }
      default: break
      }
    }
    return content.deltas.contains { delta in
      delta.creates && delta.key.type == TrainingSet.type && sets.contains { $0.id.record == delta.key.id }
    }
  }
  public static func read(_ read: Reader) throws -> [SignedOutWorkout] {
    guard case .object(let rows)? = try read.device(key) else { return [] }
    return try rows.members.map { try SignedOutWorkout($0.value) }.sorted { $0.session.id < $1.session.id }
  }
  // The device key's rows with these copies replacing their own, or nil when none is left.
  static func saved(_ backup: [SignedOutWorkout], replacing copies: [SignedOutWorkout], dropping removed: [ID<Session>] = []) -> JSON? {
    var rows = JSON.Object(uniqueKeysWithValues: backup.map { ($0.session.id.description, $0.json) })
    for id in removed { rows[id.description] = nil }
    for copy in copies { rows[copy.session.id.description] = copy.json }
    return rows.isEmpty ? nil : .object(rows)
  }
}

// `prepare` turns a signed-out workout into one import, or a non-joining start, before the replica changes hands.
// `keep` imports the saved copy as finished at its last set; `restart` resubmits an open one's start with every set it
// holds, in one plan, or refuses the whole retry. Both take a revised copy, which replaces the saved one only when the
// retry is queued.
public struct AdoptWorkout: Action {
  public enum Mode: Sendable { case prepare, keep, restart }
  public struct Loaded {
    let anonymous: Bool
    let commands: [QueuedCommand]
    let backup: [SignedOutWorkout]
    let workout: SignedOutWorkout?
    let imported: ImportSession.Loaded?
    let confirmed: Bool
    let firstPullComplete: Bool
  }
  public let id: ID<Session>
  public let mode: Mode
  public let revised: SignedOutWorkout?
  public init(_ id: ID<Session>, mode: Mode, revised: SignedOutWorkout? = nil) {
    precondition(revised == nil || (mode != .prepare && revised?.session.id == id), "a revision keeps the saved workout's identity")
    self.id = id; self.mode = mode; self.revised = revised
  }
  public var scope: ScopeRef { Gym.scope }
  public func load(_ read: Reader) throws -> Loaded {
    let backup = try SignedOutWorkout.read(read), saved = backup.first { $0.session.id == id }
    let workout: SignedOutWorkout?
    if case .prepare = mode {
      let session = try read.repository(Session.self).find(id, in: .drawn)
      var sets = try read.repository(TrainingSet.self).children(of: id, via: "sessionId", in: .drawn)
      for set in saved?.sets ?? [] where !sets.contains(where: { $0.id == set.id }) {
        if try read.repository(TrainingSet.self).record(set.id, in: .stored) == nil { sets.append(set) }
      }
      workout = session.map { SignedOutWorkout(session: SessionRules.drawn($0, sets: sets, now: read.moment.now), sets: sets) }
    } else { workout = saved.map { revised ?? $0 } }
    return Loaded(anonymous: read.isAnonymous, commands: try read.commands(), backup: backup, workout: workout,
      imported: try workout?.importAction.load(read), confirmed: try read.confirmed(Session.self, id) != nil,
      firstPullComplete: try read.firstPullComplete())
  }
  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard let workout = loaded.workout else { return .unchanged(()) }
    let commands = loaded.commands.filter { $0.command.args["id"] == id.json }
    if commands.contains(where: { $0.command.name == Gym.Commands.importSession }) { return .unchanged(()) }
    var plan = Plan()
    switch mode {
    case .prepare:
      guard loaded.anonymous, let start = commands.first(where: { $0.command.name == Gym.Commands.start && $0.canSupersede }) else { return .unchanged(()) }
      if !workout.session.isOpen, let imported = loaded.imported {
        switch workout.importAction.decision(imported, ids: ids) {
        case .write(let imported, _): plan = imported; plan.supersede([start.gestureId])
        case .refuse(let refusal): return .refuse(refusal)
        case .unchanged: return .unchanged(())
        }
      } else if start.command.args["joinOpenSession"] != false {
        let command = NonJoiningWorkoutStart(session: workout.session)
        plan = try Plan(running: command, predicting: [.create(Session.self, id, workout.session.fields)])
        plan.supersede([start.gestureId])
      }
    case .keep, .restart:
      guard !loaded.anonymous, loaded.firstPullComplete, !commands.contains(where: { $0.command.name == Gym.Commands.start }) else {
        return .refuse(.sessionOpen(Refused(Gym.Codes.sessionOpen, subject: id.ref, path: .predicted)))
      }
      guard !loaded.confirmed else { return .refuse(.taken(id.ref, .predicted)) }
      guard let imported = loaded.imported else { return .unchanged(()) }
      if case .restart = mode {
        switch try restart(workout, state: imported.state) {
        case .write(let started, _): plan = started
        case .refuse(let refusal): return .refuse(refusal)
        case .unchanged: return .unchanged(())
        }
      } else {
        if let refusal = workout.importRefusal(at: imported.state.moment, among: imported.state.stored, catalogue: imported.state.catalogue) { return .refuse(refusal) }
        switch workout.importAction.decision(imported, ids: ids) {
        case .write(let imported, _): plan = imported
        case .refuse(let refusal): return .refuse(refusal)
        case .unchanged: return .unchanged(())
        }
      }
    }
    plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded.backup, replacing: [workout]))
    return .write(plan)
  }

  // An open copy's start, not joining, and every set it holds appended in the order performed: the account takes the
  // workout whole, or the phone refuses the retry whole, naming the first set it would refuse.
  func restart(_ workout: SignedOutWorkout, state: TrainingState) throws(Violation) -> Decision<Void, GymRefusal> {
    let session = workout.session
    guard session.isOpen else { return .refuse(.sessionFinished(Refused(Gym.Codes.sessionFinished, subject: id.ref, path: .predicted))) }
    guard !state.stored.contains(where: { SessionRules.drawn($0, sets: state.sets, now: state.moment.now).isOpen }) else {
      return .refuse(.sessionOpen(Refused(Gym.Codes.sessionOpen, subject: id.ref, path: .predicted)))
    }
    try SessionRules.instant(session.startedAt, rule: "session.startedAt", at: "startedAt")
    guard session.startedAt <= state.moment.now else { return .refuse(.badInstant(Refused(Gym.Codes.badInstant, subject: id.ref, path: .predicted))) }
    var plan = try Plan(running: NonJoiningWorkoutStart(session: session), predicting: [.create(Session.self, id, session.fields)])
    var planned: [TrainingSet] = []
    for set in workout.sets {
      let valid = try Valid(set, at: state.moment)
      if let refusal = try AppendSet.refusal(appending: valid, to: session, state: state, planned: planned) { return .refuse(refusal) }
      plan.create(valid); planned.append(valid.value)
    }
    return .write(plan)
  }
}

public struct ReconcileAdoptedWorkouts: Action {
  public init() {}
  public var scope: ScopeRef { Gym.scope }
  public func load(_ read: Reader) throws -> ([SignedOutWorkout], [SignedOutWorkout]) {
    let all = try SignedOutWorkout.read(read)
    let remaining = try all.filter { workout in
      guard try read.confirmed(Session.self, workout.session.id) != nil else { return true }
      for set in workout.sets where try read.confirmed(TrainingSet.self, set.id) == nil { return true }
      return false
    }
    return (all, remaining)
  }
  public func decide(_ loaded: ([SignedOutWorkout], [SignedOutWorkout]), ids: IDSource) -> Decision<Void, GymRefusal> {
    guard loaded.0 != loaded.1 else { return .unchanged(()) }
    var plan = Plan()
    plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(loaded.1, replacing: []))
    return .write(plan)
  }
}

struct NonJoiningWorkoutStart: ServerCommand {
  static let name = Gym.Commands.start
  static let specs: [any ValueSpec] = []
  let args: [String: JSON]
  init(session: Session) {
    var args: [String: JSON] = ["id": session.id.json, "startedAt": .of(session.startedAt), "joinOpenSession": false]
    if let id = session.routineId { args["routineId"] = id.json }
    self.args = args
  }
}
