import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// The read abilities over the replica (Coach INV-4, INV-5): each a decider that loads what its projection needs and
// answers the server's result bytes, with the rows it served. The documents every ability prints are here too.

// What one ability call answers: the result the model reads, the log rows it served, the records it created.
public struct AbilityAnswer: Sendable, Equatable {
  public var payload: JSON
  public var served: ReadServed
  public var created: [RecordRef]

  public init(_ payload: JSON, served: ReadServed = .none, created: [RecordRef] = []) {
    self.payload = payload
    self.served = served
    self.created = created
  }
}

public enum CoachDocuments {
  public static func session(_ value: Session) -> JSON {
    .object(omittingNil: ["id": value.id.json, "startedAt": .of(value.startedAt), "finishedAt": value.finishedAt.map(JSON.of),
                         "routineId": value.routineId?.json, "plan": value.plan?.json, "routineName": value.displayName.map(JSON.string)])
  }

  // A set as the model reads it; its number only once the log confirmed it (INV-3).
  public static func set(_ value: TrainingSet) -> JSON {
    .object(omittingNil: ["id": value.id.json, "exerciseId": value.exerciseId.json, "setNumber": value.setNumber.map(JSON.init),
                         "weightKg": .of(value.weightKg), "reps": JSON(value.reps), "rpe": value.rpe.map(JSON.of),
                         "note": .string(value.note), "completedAt": .of(value.completedAt)])
  }

  public static func exercise(_ value: Exercise) -> JSON {
    .object(omittingNil: ["id": value.id.json, "name": .string(value.name), "pattern": .string(value.pattern),
                         "equipment": .string(value.equipment), "stepKg": .of(value.stepKg), "custom": .bool(!SeedExercises.contains(value.id)),
                         "loadCount": value.equipment == "dumbbell" ? JSON(value.loadCount) : nil,
                         "aliases": value.aliases.isEmpty ? nil : .array(value.aliases.map(JSON.string))])
  }

  public static func entries(_ entries: [RoutineEntry]) -> JSON {
    .array(entries.enumerated().map { index, entry in
      .object(omittingNil: ["position": JSON(index + 1), "exerciseId": entry.exerciseId.json, "sets": entry.sets.map { .array($0.map(\.json)) },
                           "restSeconds": entry.restSeconds.map(JSON.init)])
    })
  }

  // A routine as the program lists it; a revision the log has not numbered yet reads as the first.
  public static func routine(_ value: Routine, lastTrainedAt: Instant? = nil, pending: Proposal? = nil, routines: [Routine] = []) -> JSON {
    .object(omittingNil: ["id": value.id.json, "name": .string(value.name), "position": JSON(value.position), "revision": JSON(value.revision ?? 1),
                         "lastTrainedAt": lastTrainedAt.map(JSON.of), "entries": entries(value.entries),
                         "pendingProposal": pending.map { proposalHead($0, routine: value) }])
  }

  public static func proposalHead(_ value: Proposal, routine: Routine?) -> JSON {
    .object(head(value, routine: routine))
  }

  static func head(_ value: Proposal, routine: Routine?) -> JSON.Object {
    let pairs: [(String, JSON?)] = [
      ("id", value.id.json), ("routineId", value.routineId.json), ("intent", .string(value.intent)), ("state", .string(value.state)),
      ("summary", .string(value.summary)), ("changeCount", routine.map { JSON(value.countChanges(comparedTo: $0)) }),
      ("settledAt", value.settledAt.map(JSON.of)),
      ("source", .object(omittingNil: ["door": .string(value.door), "connection": value.connection.isEmpty ? nil : .string(value.connection),
                                       "agent": value.agent.isEmpty ? nil : .string(value.agent), "thread": value.threadId.map(JSON.string)])),
    ]
    return JSON.Object(uniqueKeysWithValues: pairs.compactMap { key, value in value.map { (key, $0) } })
  }

  // A proposal's receipt: the proposal with its diff, where a human decides, and the words that keep the model honest.
  public static func proposal(_ value: Proposal, routine: Routine?, loggedSets: (ID<Exercise>) -> Int, appBaseUrl: String) -> JSON {
    var proposal = head(value, routine: routine)
    let baseName = value.baseName ?? routine?.name
    proposal["baseRevision"] = (value.baseRevision ?? routine?.revision).map(JSON.init)
    proposal["baseName"] = baseName.map(JSON.string)
    proposal["name"] = .string(value.proposedName)
    proposal["changes"] = .array(value.changes.enumerated().map { index, change in
      .object(omittingNil: ["position": JSON(index + 1), "kind": .string(change.kind), "exerciseId": change.exerciseId.json,
                           "before": change.before?.json, "after": change.after?.json,
                           "loggedSets": change.kind == "removed" ? JSON(loggedSets(change.exerciseId)) : nil])
    })
    let note = switch value.state {
    case "applied": "This proposal was already applied by the lifter — this is the record of it, not a second change."
    case "dismissed":
      "The lifter rejected this proposal. Nothing changed. It stays in the routine's history. Do not resend the same id; propose again "
        + "only if you have something different to say."
    case "superseded":
      "This proposal was superseded — the routine moved after it was minted, so it can no longer be applied. Read the routine again "
        + "with list_routines before you propose anything else."
    default:
      "Nothing has changed. \(baseName ?? "") still reads exactly as it did, and this proposal is waiting in the lifter's app until "
        + "they open it and tap Apply — no tool on this connection can apply it. Say so when you answer: the routine is unchanged and "
        + "something is waiting for them."
    }
    return ["proposal": .object(proposal), "reviewUrl": .string("\(appBaseUrl)/#/gym/proposals/\(value.id)"), "note": .string(note)]
  }

  // A workout proposal's receipt: the proposal with its diff against the plan it read, and the words that keep the model
  // honest. The lifter decides it on the workout's card, which has no address.
  public static func workoutProposal(_ value: WorkoutProposal, base: [RoutineEntry], planRevision: Int?) -> JSON {
    let pairs: [(String, JSON?)] = [
      ("id", value.id.json), ("sessionId", value.sessionId.json), ("state", .string(value.state)), ("summary", .string(value.summary)),
      ("changeCount", JSON(value.changeCount ?? RoutineChange.count(value.changes, against: base))),
      ("settledAt", value.settledAt.map(JSON.of)),
      ("source", .object(omittingNil: ["door": .string(value.door), "connection": value.connection.isEmpty ? nil : .string(value.connection),
                                       "agent": value.agent.isEmpty ? nil : .string(value.agent), "thread": value.threadId.map(JSON.string)])),
      ("baseRevision", JSON(value.baseRevision ?? planRevision ?? 1)),
      ("changes", .array(value.changes.enumerated().map { index, change in
        .object(omittingNil: ["position": JSON(index + 1), "kind": .string(change.kind), "exerciseId": change.exerciseId.json,
                             "before": change.before?.json, "after": change.after?.json])
      })),
    ]
    let note = switch value.state {
    case "applied": "This change was already applied by the lifter — this is the record of it, not a second change."
    case "dismissed":
      "The lifter dismissed this change, and the workout kept its plan. Do not resend the same id; propose again only if you have "
        + "something different to say."
    case "superseded":
      "This change was superseded — the workout's plan moved, or a newer change replaced it, so it can no longer be applied. Read the "
        + "workout again with get_session before you propose anything else."
    default:
      "Nothing has changed. This workout keeps its plan, and this change is waiting on its card in the lifter's app until they tap "
        + "Apply — no tool on this connection can apply it. Say so when you answer: the workout is unchanged and a change is waiting for them."
    }
    return ["proposal": .object(JSON.Object(uniqueKeysWithValues: pairs.compactMap { key, value in value.map { (key, $0) } })), "note": .string(note)]
  }

  public static func note(_ value: Note, position: Int) -> JSON {
    ["id": value.id.json, "position": JSON(position), "title": .string(value.title), "body": .string(value.body)]
  }

  // Coach §3.3: an estimate in a result is stated to one decimal, rounding last — every `e1rm` and `topE1rm`, and the
  // number a new best in e1RM is about.
  public static func stated(_ document: JSON) -> JSON {
    switch document {
    case .array(let items): return .array(items.map(stated))
    case .object(let members):
      let estimate = members["kind"] == "e1rm"
      return .object(JSON.Object(uniqueKeysWithValues: members.members.map { key, value -> (String, JSON) in
        guard case .number(let number) = value, ["e1rm", "topE1rm"].contains(key) || (estimate && ["value", "previous"].contains(key)) else {
          return (key, stated(value))
        }
        return (key, .of(GymEstimate.stated(number.value)))
      }))
    default: return document
    }
  }

  // The order a workout's sets are read in: as performed, then by their number, then by id.
  public static func performed(_ sets: [TrainingSet]) -> [TrainingSet] {
    sets.sorted { a, b in
      if a.completedAt != b.completedAt { return a.completedAt < b.completedAt }
      if a.setNumber != b.setNumber { return (a.setNumber ?? 0) < (b.setNumber ?? 0) }
      return a.id < b.id
    }
  }

  // A movement's sets of one workout, by their number.
  public static func numbered(_ sets: [TrainingSet]) -> [TrainingSet] {
    sets.sorted { a, b in a.setNumber == b.setNumber ? a.id < b.id : (a.setNumber ?? 0) < (b.setNumber ?? 0) }
  }
}

// MARK: - The log

// `list_sessions`, `get_session`, `get_sessions`, `last_time`, `get_last_times` and `get_stats` over the whole history.
public struct LogRead: Decider {
  public enum Query: Sendable, Equatable {
    case sessions(before: Instant, beforeId: String, limit: Int)
    case session(ID<Session>, review: Bool)
    case workouts([ID<Session>], review: Bool)
    case lastTime(ID<Exercise>)
    case lastTimes([ID<Exercise>])
    case stats(ID<Exercise>?)
  }

  public static let defaultPage = 20
  public static let maxPage = 200

  public let query: Query

  public init(_ query: Query) {
    self.query = query
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> TrainingHistory { try TrainingHistory(read) }

  public func decide(_ history: TrainingHistory, ids: IDSource) throws(Violation) -> Decision<AbilityAnswer, GymRefusal> {
    let log = history.log
    var served = ReadServed()
    switch query {
    case .sessions(let before, let beforeId, let limit):
      let page = log.drawnSessions.sorted { a, b in a.startedAt == b.startedAt ? b.id < a.id : a.startedAt > b.startedAt }
        .filter { $0.startedAt < before || ($0.startedAt == before && $0.id.record < RecordID(beforeId)) }.prefix(limit)
      for session in page { served.saw(session: session) }
      return .unchanged(AbilityAnswer(["sessions": CoachDocuments.stated(.array(page.map(history.summary)))], served: served))
    case .session(let id, let review):
      guard let session = log.drawnSessions.first(where: { $0.id == id }) else { return .refuse(gone(id.ref)) }
      return .unchanged(AbilityAnswer(.object(workout(session, review: review, in: history, served: &served)), served: served))
    case .workouts(let ids, let review):
      var workouts: [JSON] = []
      var missing: [JSON] = []
      for id in ids {
        guard let session = log.drawnSessions.first(where: { $0.id == id }) else { missing.append(id.json); continue }
        workouts.append(.object(workout(session, review: review, in: history, served: &served)))
      }
      return .unchanged(AbilityAnswer(["sessions": .array(workouts), "missingSessionIds": .array(missing)], served: served))
    case .lastTime(let id):
      let last = LastTime.of(id, among: newestFirst(log), log: log)
      if last.session == nil && log.catalogue.find(id) == nil { return .refuse(gone(id.ref)) }
      return .unchanged(AbilityAnswer(.object(lastTime(last, in: log, served: &served)), served: served))
    case .lastTimes(let ids):
      var movements: [JSON] = []
      var missing: [JSON] = []
      for id in ids {
        let last = LastTime.of(id, among: newestFirst(log), log: log)
        if last.session == nil && log.catalogue.find(id) == nil { missing.append(id.json); continue }
        var line = lastTime(last, in: log, served: &served)
        line["trained"] = .bool(last.session != nil)
        line["routine"] = nil
        movements.append(.object(line))
      }
      return .unchanged(AbilityAnswer(["exercises": .array(movements), "missingExerciseIds": .array(missing)], served: served))
    case .stats(let only):
      guard case .object(var stats) = history.stats(), case .array(let weeks)? = stats["weeks"], case .array(let movements)? = stats["movements"] else {
        preconditionFailure("the statistics name their weeks and movements")
      }
      for week in weeks {
        if case .number(let start)? = week["startedAt"] { served.saw(week: Int64(start.value)) }
      }
      if let only { stats["movements"] = .array(movements.filter { $0["exerciseId"] == only.json }) }
      return .unchanged(AbilityAnswer(CoachDocuments.stated(.object(stats)), served: served))
    }
  }

  // The server's `ORDER BY started_at DESC, id DESC` (INV-1): a same-millisecond tie goes to the higher id, where the
  // UI's `drawnSessions` lists the lower first and the training-reads vectors pin it so.
  func newestFirst(_ log: TrainingLog) -> [Session] {
    log.drawnSessions.sorted { a, b in a.startedAt == b.startedAt ? a.id > b.id : a.startedAt > b.startedAt }
  }

  func workout(_ session: Session, review: Bool, in history: TrainingHistory, served: inout ReadServed) -> JSON.Object {
    let sets = CoachDocuments.performed(history.log.sets(session: session.id))
    served.saw(session: session)
    for set in sets { served.saw(set: set) }
    var document: JSON.Object = ["session": CoachDocuments.session(session), "sets": .array(sets.map(CoachDocuments.set))]
    if review { document["review"] = CoachDocuments.stated(history.review(session.id)) }
    return document
  }

  func lastTime(_ last: LastTime, in log: TrainingLog, served: inout ReadServed) -> JSON.Object {
    var line: JSON.Object = ["exerciseId": last.exerciseId.json]
    guard let session = last.session else { return line }
    let sets = CoachDocuments.numbered(last.sets)
    served.saw(session: session)
    for set in sets { served.saw(set: set) }
    line["session"] = CoachDocuments.session(session)
    if let routine = session.name, !routine.isEmpty { line["routine"] = .string(routine) }
    line["sets"] = .array(sets.map(CoachDocuments.set))
    return line
  }

  func gone(_ subject: RecordRef) -> GymRefusal {
    GymRefusal(Refused(.unknownRecord, subject: subject, path: .predicted))
  }
}

// MARK: - The program

// `list_routines`: the routines most recently trained first, each with the proposal waiting on it.
public struct ProgramRead: Decider {
  public struct Loaded {
    let routines: [Routine]
    let proposals: [Proposal]
    let log: TrainingLog
  }

  public let routineId: ID<Routine>?

  public init(routineId: ID<Routine>? = nil) {
    self.routineId = routineId
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    let proposals = read.repository(Proposal.self)
    let born = try Dictionary(uniqueKeysWithValues: try proposals.all(in: .drawn).map { ($0.id, try proposals.record($0.id, in: .drawn)?.rc ?? 0) })
    return Loaded(routines: try read.repository(Routine.self).all(in: .drawn).filter { !$0.entries.isEmpty },
                  proposals: try proposals.all(in: .drawn).sorted { a, b in born[a.id] == born[b.id] ? b.id < a.id : born[a.id]! > born[b.id]! },
                  log: try TrainingLog(read))
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<AbilityAnswer, GymRefusal> {
    let lastTrained = { (routine: Routine) in loaded.log.drawnSessions.first { $0.routineId == routine.id }?.startedAt }
    let document = { (routine: Routine) in
      CoachDocuments.routine(routine, lastTrainedAt: lastTrained(routine),
                             pending: loaded.proposals.first { $0.routineId == routine.id && $0.state == "pending" })
    }
    if let routineId {
      guard let routine = loaded.routines.first(where: { $0.id == routineId }) else {
        return .refuse(GymRefusal(Refused(.unknownRecord, subject: routineId.ref, path: .predicted)))
      }
      return .unchanged(AbilityAnswer(["routines": .array([document(routine)])]))
    }
    let routines = loaded.routines.sorted { a, b in
      let (left, right) = (lastTrained(a)?.ms ?? -1, lastTrained(b)?.ms ?? -1)
      if left != right { return left > right }
      return a.position == b.position ? a.id < b.id : a.position < b.position
    }
    return .unchanged(AbilityAnswer(["routines": .array(routines.map(document))]))
  }
}

// MARK: - The catalogue, the notes, the weigh-ins

// `list_exercises`: the catalogue by pattern, then the name the lifter sees, in the server's order (INV-1): its
// `ORDER BY pattern, name` runs under the database's `en_US.UTF-8` collation, so names compare by their letters without
// case or accents first, then by their accents, then lowercase before uppercase (`Collation`); patterns are lowercase
// ASCII words, the same order either way. What the collation leaves tied, the id breaks.
public struct CatalogueRead: Decider {
  public init() {}
  public var scope: ScopeRef { Gym.scope }
  public func load(_ read: Reader) throws -> Catalogue { try Catalogue(read) }

  public func decide(_ catalogue: Catalogue, ids: IDSource) throws(Violation) -> Decision<AbilityAnswer, GymRefusal> {
    let exercises = catalogue.exercises.sorted { a, b in
      if a.pattern != b.pattern { return a.pattern.utf8.lexicographicallyPrecedes(b.pattern.utf8) }
      if Collation.precedes(a.name, b.name) { return true }
      if Collation.precedes(b.name, a.name) { return false }
      return a.id < b.id
    }
    return .unchanged(AbilityAnswer(["exercises": .array(exercises.map(CoachDocuments.exercise))]))
  }
}

// `list_notes`: precedence order, without the id and the instant the model has no use for.
public struct NotesRead: Decider {
  public init() {}
  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> (drawn: [Note], stored: [Note]) {
    let notes = read.repository(Note.self)
    return (try notes.all(in: .drawn), try notes.all(in: .stored))
  }

  public func decide(_ loaded: (drawn: [Note], stored: [Note]), ids: IDSource) throws(Violation) -> Decision<AbilityAnswer, GymRefusal> {
    let rows = loaded.drawn.map { note -> JSON in
      ["position": JSON(Note.position(of: note.id, stored: loaded.stored) ?? 0), "title": .string(note.title), "body": .string(note.body)]
    }
    return .unchanged(AbilityAnswer(["notes": .array(rows)]))
  }
}

// `list_bodyweight`: day ascending between two inclusive days, either open.
public struct BodyweightRead: Decider {
  public let from: String?
  public let to: String?

  public init(from: String? = nil, to: String? = nil) {
    self.from = from
    self.to = to
  }

  public var scope: ScopeRef { Gym.scope }
  public func load(_ read: Reader) throws -> Bodyweight { try Bodyweight(read) }

  public func decide(_ bodyweight: Bodyweight, ids: IDSource) throws(Violation) -> Decision<AbilityAnswer, GymRefusal> {
    let bounds = try [("from", from), ("to", to)].map { label, text throws(Violation) -> LocalDay? in
      guard let text else { return nil }
      guard let day = LocalDay(text) else { throw Violation(rule: WeighInRules.dayRule, path: Path(label), reason: .custom("notADay")) }
      return day
    }
    let entries = bodyweight.entries(from: bounds[0], to: bounds[1]).map { entry -> JSON in
      ["dateLocal": .string(entry.day.text), "weightKg": .of(entry.kg)]
    }
    return .unchanged(AbilityAnswer(["entries": .array(entries)]))
  }
}
