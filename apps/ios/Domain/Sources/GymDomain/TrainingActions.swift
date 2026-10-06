import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct StartSessionCommand: ServerCommand {
  public static let name = Gym.Commands.start
  public static let specs: [any ValueSpec] = []
  public let args: [String: JSON]
  public init(id: ID<Session>, routineId: ID<Routine>?, startedAt: Instant) {
    var args: [String: JSON] = ["id": id.json, "startedAt": .of(startedAt), "joinOpenSession": true]
    if let routineId { args["routineId"] = routineId.json }
    self.args = args
  }
}

public struct FinishSessionCommand: ServerCommand {
  public static let name = Gym.Commands.finish
  public static let specs: [any ValueSpec] = []
  public let args: [String: JSON]
  public init(id: ID<Session>, finishedAt: Instant) { args = ["sessionId": id.json, "finishedAt": .of(finishedAt)] }
}

public struct ImportSessionCommand: ServerCommand {
  public static let name = Gym.Commands.importSession
  public static let specs: [any ValueSpec] = [
    TextSpec("gym.importSession.sets.id", unit: .chars, min: 8, max: 64, trim: false, nfc: false),
    TextSpec("gym.importSession.sets.exerciseId", unit: .chars, min: 1, max: 64, trim: false, nfc: false),
    ChoiceSpec("gym.importSession.sets.kind", values: ["warmup", "working", "drop", "failure"]),
    TextSpec("gym.importSession.sets.note", unit: .bytes, min: 0, max: 4000, trim: false, nfc: false),
  ]
  public let args: [String: JSON]
  public init(id: ID<Session>, routineId: ID<Routine>?, startedAt: Instant, finishedAt: Instant, sets: [ImportedSet]) {
    var args: [String: JSON] = ["id": id.json, "startedAt": .of(startedAt), "finishedAt": .of(finishedAt), "sets": .array(sets.map(\.json))]
    if let routineId { args["routineId"] = routineId.json }
    self.args = args
  }
}

public struct CorrectSessionCommand: ServerCommand {
  public static let name = Gym.Commands.correctSession
  public static let specs: [any ValueSpec] = [
    TextSpec("gym.correctSession.requestId", unit: .chars, min: 8, max: 64, trim: false, nfc: false),
    TextSpec("gym.correctSession.routineName", unit: .bytes, min: 0, max: 240, trim: false, nfc: false),
    TextSpec("gym.correctSession.sets.id", unit: .chars, min: 8, max: 64, trim: false, nfc: false),
    TextSpec("gym.correctSession.sets.exerciseId", unit: .chars, min: 1, max: 64, trim: false, nfc: false),
    TextSpec("gym.correctSession.sets.note", unit: .bytes, min: 0, max: 4000, trim: false, nfc: false),
  ]
  public let args: [String: JSON]
  public init(id: ID<Session>, requestId: String, startedAt: Instant, finishedAt: Instant, routineName: String?, sets: [CorrectedSet]) {
    args = ["sessionId": id.json, "requestId": .string(requestId), "startedAt": .of(startedAt), "finishedAt": .of(finishedAt),
            "routineName": .of(routineName), "sets": .array(sets.map(\.json))]
  }
}

public struct TrainingState: Sendable {
  public let drawn: [Session]
  public let stored: [Session]
  public let sets: [TrainingSet]
  public let drawnSets: [TrainingSet]
  public let catalogue: Catalogue
  public let moment: Moment
  public init(_ read: Reader) throws {
    drawn = try read.repository(Session.self).all(in: .drawn)
    stored = try read.repository(Session.self).all(in: .stored)
    sets = try read.repository(TrainingSet.self).all(in: .stored)
    drawnSets = try read.repository(TrainingSet.self).all(in: .drawn)
    catalogue = try Catalogue(read, in: .stored); moment = read.moment
  }
  public func session(_ id: ID<Session>) -> Session? { stored.first { $0.id == id } ?? drawn.first { $0.id == id } }
  public func overlap(start: Instant, finish: Instant, excluding id: ID<Session>) -> Session? {
    stored.filter { $0.id != id && SessionRules.crosses(start, finish, other: $0) }.sorted {
      $0.startedAt == $1.startedAt ? $0.id < $1.id : $0.startedAt < $1.startedAt
    }.first
  }
}

public struct StartSession: Action {
  public typealias Loaded = (state: TrainingState, routine: Routine?, prior: Bool)
  public let id: ID<Session>
  public let routineId: ID<Routine>?
  public let startedAt: Instant?
  public init(id: ID<Session>, routineId: ID<Routine>? = nil, startedAt: Instant? = nil) {
    self.id = id; self.routineId = routineId; self.startedAt = startedAt
  }
  public var scope: ScopeRef { Session.scope }
  public func load(_ read: Reader) throws -> Loaded {
    (try TrainingState(read), try routineId.flatMap { try read.repository(Routine.self).find($0, in: .drawn) },
     try read.repository(Session.self).record(id, in: .stored) != nil)
  }
  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<ID<Session>, GymRefusal> {
    if loaded.prior { return .unchanged(id) }
    let at = startedAt ?? loaded.state.moment.now
    let command = StartSessionCommand(id: id, routineId: routineId, startedAt: at)
    if let open = loaded.state.stored.first(where: { SessionRules.drawn($0, sets: loaded.state.sets, now: loaded.state.moment.now).isOpen }) {
      return .write(try Plan(running: command), open.id)
    }
    try SessionRules.instant(at, rule: "session.startedAt", at: "startedAt")
    let routine = loaded.routine
    let predicted = Session(id: id, startedAt: at, routineId: routine?.id, plan: routine.map(SessionPlan.init))
    return .write(try Plan(running: command, predicting: [.create(Session.self, id, predicted.fields)]), id)
  }
}

public struct FinishSession: Action {
  public let id: ID<Session>
  public let finishedAt: Instant?
  public init(id: ID<Session>, finishedAt: Instant? = nil) { self.id = id; self.finishedAt = finishedAt }
  public var scope: ScopeRef { Session.scope }
  public func load(_ read: Reader) throws -> TrainingState { try TrainingState(read) }
  public func decide(_ loaded: TrainingState, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard let session = loaded.session(id), loaded.drawn.contains(where: { $0.id == id }) else { return .refuse(.gone(id.ref, .predicted)) }
    let at = finishedAt ?? loaded.moment.now
    guard SessionRules.canFinishAt(session, at: at) else { return .refuse(.badInstant(Refused(Gym.Codes.badInstant, subject: id.ref, path: .predicted))) }
    let finished = try SessionRules.finish(session, at: at)
    if finished.fields == session.fields { return .unchanged(()) }
    return .write(try Plan(running: FinishSessionCommand(id: id, finishedAt: at), predicting: [
      .update(Session.self, id, ["finishedAt": .of(finished.finishedAt), "closedBy": "finish"])]))
  }
}

public struct AppendSet: Action {
  public let value: TrainingSet
  public init(_ value: TrainingSet) { self.value = value }
  public var scope: ScopeRef { TrainingSet.scope }
  public func load(_ read: Reader) throws -> TrainingState { try TrainingState(read) }
  public func decide(_ loaded: TrainingState, ids: IDSource) throws(Violation) -> Decision<ID<TrainingSet>, GymRefusal> {
    let valid = try Valid(value, at: loaded.moment)
    guard let session = loaded.session(value.sessionId), loaded.drawn.contains(where: { $0.id == session.id }) else { return .refuse(.gone(value.sessionId.ref, .predicted)) }
    guard SessionRules.lateSetLands(session, completedAt: value.completedAt) else { return .refuse(.sessionFinished(Refused(Gym.Codes.sessionFinished, subject: value.id.ref, path: .predicted))) }
    guard loaded.catalogue.find(value.exerciseId) != nil else { return .refuse(.unknownExercise(Refused(Gym.Codes.unknownExercise, subject: value.id.ref, path: .predicted))) }
    guard !loaded.sets.contains(where: { $0.id == value.id }) else { return .refuse(.taken(value.id.ref, .predicted)) }
    guard SetRules.nextNumber(loaded.sets, sessionId: value.sessionId, exerciseId: value.exerciseId) != nil else {
      throw Violation(rule: "set.setNumber", path: "setNumber", reason: .above(max: Double(SetRules.maxNumber)))
    }
    var plan = Plan(); plan.create(valid); return .write(plan, value.id)
  }
}

public struct CorrectSet: Action {
  public let value: TrainingSet
  public let original: TrainingSet?
  public init(_ value: TrainingSet, original: TrainingSet? = nil) { self.value = value; self.original = original }
  public var scope: ScopeRef { TrainingSet.scope }
  public func load(_ read: Reader) throws -> TrainingState { try TrainingState(read) }
  public func decide(_ loaded: TrainingState, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard let old = loaded.sets.first(where: { $0.id == value.id }), loaded.drawnSets.contains(where: { $0.id == value.id }) else { return .refuse(.gone(value.id.ref, .predicted)) }
    let fields = ["weightKg", "reps", "kind", "rpe", "note"]
    var correction = value
    if let original {
      guard original.id == value.id && original.sessionId == value.sessionId && original.exerciseId == value.exerciseId
              && original.completedAt == value.completedAt && original.setNumber == value.setNumber else {
        throw Violation(rule: "set.identity", path: "id", reason: .custom("immutable"))
      }
      guard old.sessionId == original.sessionId && old.exerciseId == original.exerciseId,
            fields.allSatisfy({ old.fields[$0] == original.fields[$0] }) else { return .refuse(.stale(value.id.ref, .predicted)) }
      // Admission can assign a serial or normalize the clock while this editor is open.
      correction = TrainingSet(id: old.id, sessionId: old.sessionId, exerciseId: old.exerciseId,
                               weightKg: value.weightKg, reps: value.reps, kind: value.kind, rpe: value.rpe, note: value.note,
                               completedAt: old.completedAt, setNumber: old.setNumber)
    }
    guard old.sessionId == correction.sessionId && old.exerciseId == correction.exerciseId && old.completedAt == correction.completedAt && old.setNumber == correction.setNumber else {
      throw Violation(rule: "set.identity", path: "id", reason: .custom("immutable"))
    }
    let valid = try Valid(correction, fields: fields, at: loaded.moment)
    let changed = fields.filter { valid.value.fields[$0] != old.fields[$0] }
    guard !changed.isEmpty else { return .unchanged(()) }
    var plan = Plan(); plan.update(valid, fields: changed); return .write(plan)
  }
}

public struct DiscardSession: Action {
  public let id: ID<Session>
  public init(_ id: ID<Session>) { self.id = id }
  public var scope: ScopeRef { Session.scope }
  public func load(_ read: Reader) throws -> TrainingState { try TrainingState(read) }
  public func decide(_ loaded: TrainingState, ids: IDSource) -> Decision<Void, GymRefusal> {
    guard let session = loaded.session(id), loaded.drawn.contains(where: { $0.id == id }) else { return .unchanged(()) }
    if session.isOpen && SessionRules.autoCloseAt(session, sets: loaded.sets, now: loaded.moment.now) == nil {
      return .refuse(.sessionOpen(Refused(Gym.Codes.sessionOpen, subject: id.ref, path: .predicted)))
    }
    var plan = Plan(); plan.remove(id); return .write(plan)
  }
}

public struct ImportedSet: Sendable {
  public let id: ID<TrainingSet>
  public let exerciseId: ID<Exercise>
  public let weightKg: Double
  public let reps: Int
  public let completedAt: Instant
  public let kind: String?
  public let rpe: Double?
  public let note: String?
  public let rpeNamed: Bool
  public init(id: ID<TrainingSet>, exerciseId: ID<Exercise>, weightKg: Double, reps: Int, completedAt: Instant,
              kind: String? = nil, rpe: Double? = nil, note: String? = nil, rpeNamed: Bool? = nil) {
    self.id = id; self.exerciseId = exerciseId; self.weightKg = weightKg; self.reps = reps; self.completedAt = completedAt
    self.kind = kind; self.rpe = rpe; self.note = note; self.rpeNamed = rpeNamed ?? (rpe != nil)
  }
  public func value(session: ID<Session>) -> TrainingSet {
    TrainingSet(id: id, sessionId: session, exerciseId: exerciseId, weightKg: weightKg, reps: reps, kind: kind ?? "working",
                rpe: rpe, note: note ?? "", completedAt: completedAt)
  }
  public var json: JSON {
    var members: JSON.Object = ["id": id.json, "exerciseId": exerciseId.json, "weightKg": .of(weightKg), "reps": JSON(reps), "completedAt": .of(completedAt)]
    if let kind { members["kind"] = .string(kind) }; if let note { members["note"] = .string(note) }
    if rpeNamed { members["rpe"] = .of(rpe) }; return .object(members)
  }
}

public struct ImportSession: Action {
  public typealias Loaded = (state: TrainingState, routine: Routine?)
  public let id: ID<Session>
  public let startedAt: Instant
  public let finishedAt: Instant
  public let sets: [ImportedSet]
  public let routineId: ID<Routine>?
  public init(id: ID<Session>, startedAt: Instant, finishedAt: Instant, sets: [ImportedSet], routineId: ID<Routine>? = nil) {
    self.id = id; self.startedAt = startedAt; self.finishedAt = finishedAt; self.sets = sets; self.routineId = routineId
  }
  public var scope: ScopeRef { Session.scope }
  public func load(_ read: Reader) throws -> Loaded {
    (try TrainingState(read), try routineId.flatMap { try read.repository(Routine.self).find($0, in: .drawn) })
  }
  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<ID<Session>, GymRefusal> {
    try SessionRules.instant(startedAt, rule: "session.startedAt", at: "startedAt")
    try SessionRules.instant(finishedAt, rule: "session.finishedAt", at: "finishedAt")
    guard sets.count <= 200 && Set(sets.map(\.id)).count == sets.count else { throw Violation(rule: "session.sets", path: "sets", reason: .custom("invalid")) }
    guard finishedAt >= startedAt && sets.allSatisfy({ $0.completedAt >= startedAt && $0.completedAt <= finishedAt }) else {
      return .refuse(.badInstant(Refused(Gym.Codes.badInstant, subject: id.ref, path: .predicted)))
    }
    var checked: [TrainingSet] = []
    for set in sets {
      checked.append(try Valid(set.value(session: id), at: loaded.state.moment).value)
    }
    let routine = loaded.routine
    let predicted = Session(id: id, startedAt: startedAt, finishedAt: finishedAt, closedBy: "finish", routineId: routine?.id, plan: routine.map(SessionPlan.init))
    let command = ImportSessionCommand(id: id, routineId: routineId, startedAt: startedAt, finishedAt: finishedAt, sets: sets)
    let predictions = [Prediction.create(Session.self, id, predicted.fields)] + checked.map { .create(TrainingSet.self, $0.id, $0.fields) }
    return .write(try Plan(running: command, predicting: predictions), id)
  }
}

public struct CorrectedSet: Sendable {
  public let id: ID<TrainingSet>
  public let exerciseId: ID<Exercise>
  public let setNumber: Int
  public let weightKg: Double
  public let reps: Int
  public let completedAt: Instant
  public let rpe: Double?
  public let note: String?
  public let rpeNamed: Bool
  public init(id: ID<TrainingSet>, exerciseId: ID<Exercise>, setNumber: Int, weightKg: Double, reps: Int, completedAt: Instant,
              rpe: Double? = nil, note: String? = nil, rpeNamed: Bool? = nil) {
    self.id = id; self.exerciseId = exerciseId; self.setNumber = setNumber; self.weightKg = weightKg; self.reps = reps
    self.completedAt = completedAt; self.rpe = rpe; self.note = note; self.rpeNamed = rpeNamed ?? (rpe != nil)
  }
  public var json: JSON {
    var members: JSON.Object = ["id": id.json, "exerciseId": exerciseId.json, "setNumber": JSON(setNumber), "weightKg": .of(weightKg), "reps": JSON(reps), "completedAt": .of(completedAt)]
    if let note { members["note"] = .string(note) }; if rpeNamed { members["rpe"] = .of(rpe) }; return .object(members)
  }
}

public struct CorrectSession: Action {
  public let id: ID<Session>
  public let requestId: String
  public let startedAt: Instant
  public let finishedAt: Instant
  public let routineName: String?
  public let sets: [CorrectedSet]
  public init(id: ID<Session>, requestId: String, startedAt: Instant, finishedAt: Instant, routineName: String?, sets: [CorrectedSet]) {
    self.id = id; self.requestId = requestId; self.startedAt = startedAt; self.finishedAt = finishedAt; self.routineName = routineName; self.sets = sets
  }
  public var scope: ScopeRef { Session.scope }
  public func load(_ read: Reader) throws -> TrainingState { try TrainingState(read) }
  public func decide(_ loaded: TrainingState, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard (8...64).contains(requestId.utf8.count) && requestId.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
      throw Violation(rule: "session.requestId", path: "requestId", reason: .custom("invalid"))
    }
    try SessionRules.instant(startedAt, rule: "session.startedAt", at: "startedAt")
    try SessionRules.instant(finishedAt, rule: "session.finishedAt", at: "finishedAt")
    guard (1...200).contains(sets.count) && Set(sets.map(\.id)).count == sets.count && sets.allSatisfy({ (1...SetRules.maxNumber).contains($0.setNumber) }) else {
      throw Violation(rule: "session.sets", path: "sets", reason: .custom("invalid"))
    }
    for (index, set) in sets.enumerated() where sets[..<index].contains(where: { $0.exerciseId == set.exerciseId && $0.setNumber == set.setNumber }) {
      throw Violation(rule: "session.sets", path: "sets", reason: .custom("invalid"))
    }
    guard finishedAt >= startedAt && sets.allSatisfy({ $0.completedAt >= startedAt && $0.completedAt <= finishedAt }) else {
      return .refuse(.badInstant(Refused(Gym.Codes.badInstant, subject: id.ref, path: .predicted)))
    }
    let old = loaded.sets.filter { $0.sessionId == id }
    var checked: [TrainingSet] = []
    for set in sets {
      let previous = loaded.sets.first { $0.id == set.id }
      let value = TrainingSet(id: set.id, sessionId: id, exerciseId: set.exerciseId, weightKg: set.weightKg, reps: set.reps,
        kind: previous?.kind ?? "working", rpe: set.rpeNamed ? set.rpe : previous?.rpe,
        note: set.note ?? previous?.note ?? "", completedAt: set.completedAt, setNumber: set.setNumber)
      checked.append(try Valid(value, at: loaded.moment).value)
    }
    let predicted = loaded.session(id).map { session in
      var predicted = session; predicted.startedAt = startedAt; predicted.finishedAt = finishedAt
      predicted.closedBy = "finish"; predicted.displayName = routineName
      return Prediction.update(Session.self, id, predicted.fields)
    }
    let command = CorrectSessionCommand(id: id, requestId: requestId, startedAt: startedAt, finishedAt: finishedAt, routineName: routineName, sets: sets)
    let predictions = (predicted.map { [$0] } ?? []) + checked.map { set in
      old.contains(where: { $0.id == set.id }) ? .update(TrainingSet.self, set.id, set.fields) : .create(TrainingSet.self, set.id, set.fields)
    } + old.filter { prior in !checked.contains(where: { $0.id == prior.id }) }.map { .remove(TrainingSet.self, $0.id) }
    return .write(try Plan(running: command, predicting: predictions))
  }
}
