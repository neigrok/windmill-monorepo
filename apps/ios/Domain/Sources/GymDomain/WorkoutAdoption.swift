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
        completedAt: $0.completedAt, kind: $0.kind, rpe: $0.rpe, note: $0.note, rpeNamed: true) }, routineId: session.routineId)
  }
  public static func read(_ read: Reader) throws -> [SignedOutWorkout] {
    guard case .object(let rows)? = try read.device(key) else { return [] }
    return try rows.members.map { try SignedOutWorkout($0.value) }.sorted { $0.session.id < $1.session.id }
  }
}

public struct AdoptWorkout: Action {
  public enum Mode: Sendable { case prepare, keep }
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
  public init(_ id: ID<Session>, mode: Mode) { self.id = id; self.mode = mode }
  public var scope: ScopeRef { Gym.scope }
  public func load(_ read: Reader) throws -> Loaded {
    let backup = try SignedOutWorkout.read(read)
    let session = try read.repository(Session.self).find(id, in: .drawn)
    var sets = try read.repository(TrainingSet.self).children(of: id, via: "sessionId", in: .drawn)
    if case .prepare = mode, let previous = backup.first(where: { $0.session.id == id }) {
      for set in previous.sets where !sets.contains(where: { $0.id == set.id }) {
        if try read.repository(TrainingSet.self).record(set.id, in: .stored) == nil { sets.append(set) }
      }
    }
    let workout: SignedOutWorkout?
    if case .prepare = mode, let session {
      workout = SignedOutWorkout(session: SessionRules.drawn(session, sets: sets, now: read.moment.now), sets: sets)
    } else { workout = backup.first { $0.session.id == id } }
    return Loaded(anonymous: read.isAnonymous, commands: try read.commands(), backup: backup, workout: workout,
      imported: try workout?.importAction.load(read), confirmed: try read.confirmed(Session.self, id) != nil,
      firstPullComplete: try read.firstPullComplete())
  }
  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard let workout = loaded.workout else { return .unchanged(()) }
    let commands = loaded.commands.filter { $0.command.args["id"] == id.json }
    if commands.contains(where: { $0.command.name == Gym.Commands.importSession }) { return .unchanged(()) }
    var backups = JSON.Object(uniqueKeysWithValues: loaded.backup.map { ($0.session.id.description, $0.json) })
    var plan = Plan()
    switch mode {
    case .prepare:
      guard loaded.anonymous, let start = commands.first(where: { $0.command.name == Gym.Commands.start && $0.canSupersede }) else { return .unchanged(()) }
      backups[id.description] = workout.json
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
    case .keep:
      guard !loaded.anonymous, loaded.firstPullComplete, !loaded.confirmed,
            !commands.contains(where: { $0.command.name == Gym.Commands.start }), let imported = loaded.imported else {
        return .refuse(.sessionOpen(Refused(Gym.Codes.sessionOpen, subject: id.ref, path: .predicted)))
      }
      switch workout.importAction.decision(imported, ids: ids) {
      case .write(let imported, _): plan = imported
      case .refuse(let refusal): return .refuse(refusal)
      case .unchanged: return .unchanged(())
      }
    }
    plan.device(SignedOutWorkout.key, .object(backups))
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
    let rows = JSON.Object(uniqueKeysWithValues: loaded.1.map { ($0.session.id.description, $0.json) })
    plan.device(SignedOutWorkout.key, rows.isEmpty ? nil : .object(rows))
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
