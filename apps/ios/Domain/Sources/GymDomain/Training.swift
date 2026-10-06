import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public enum SetKind: String, CaseIterable, Sendable {
  case warmup, working, drop, failure
  public static let work = SetKind.working
}

public struct Session: Entity, Removable, Equatable {
  public static let type = Gym.Types.session
  public static let scope = Gym.scope
  public static let heldRemoval = true
  public let id: ID<Session>
  public var startedAt: Instant
  public var finishedAt: Instant?
  public var closedBy: String?
  public var routineId: ID<Routine>?
  public var historyRoutineId: ID<Routine>?
  public var plan: SessionPlan?
  public var displayName: String?

  public init(id: ID<Session>, startedAt: Instant, finishedAt: Instant? = nil, closedBy: String? = nil,
              routineId: ID<Routine>? = nil, historyRoutineId: ID<Routine>? = nil,
              plan: SessionPlan? = nil, displayName: String? = nil) {
    self.id = id; self.startedAt = startedAt; self.finishedAt = finishedAt; self.closedBy = closedBy
    self.routineId = routineId; self.historyRoutineId = historyRoutineId ?? routineId
    self.plan = plan; self.displayName = displayName
  }

  public init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id); startedAt = try r.instant("startedAt"); finishedAt = try r.optionalInstant("finishedAt")
    closedBy = try r.optionalString("closedBy"); routineId = try r.optionalRef("routineId", Routine.self)
    historyRoutineId = try r.optionalRef("historyRoutineId", Routine.self)
    plan = try SessionPlan.decode(r.json("plan")); displayName = try r.optionalString("displayName")
  }

  public var isOpen: Bool { finishedAt == nil }
  public var name: String? { displayName ?? plan?.routine }
  public var fields: [String: JSON] {
    ["startedAt": .of(startedAt), "finishedAt": .of(finishedAt), "closedBy": .of(closedBy),
     "routineId": routineId?.json ?? .null, "historyRoutineId": historyRoutineId?.json ?? .null,
     "plan": plan?.json ?? .null, "displayName": .of(displayName)]
  }
}

public struct TrainingSet: Writable, Removable, Equatable {
  public static let type = Gym.Types.set
  public static let scope = Gym.scope
  public static let heldRemoval = true
  public let id: ID<TrainingSet>
  public let sessionId: ID<Session>
  public let exerciseId: ID<Exercise>
  public var weightKg: Double
  public var reps: Int
  public var kind: String
  public var rpe: Double?
  public var note: String
  public let completedAt: Instant
  public let setNumber: Int?

  public init(id: ID<TrainingSet>, sessionId: ID<Session>, exerciseId: ID<Exercise>, weightKg: Double,
              reps: Int, kind: String = "working", rpe: Double? = nil, note: String = "",
              completedAt: Instant, setNumber: Int? = nil) {
    self.id = id; self.sessionId = sessionId; self.exerciseId = exerciseId; self.weightKg = weightKg
    self.reps = reps; self.kind = kind; self.rpe = rpe; self.note = note
    self.completedAt = completedAt; self.setNumber = setNumber
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), sessionId: try r.ref("sessionId", Session.self), exerciseId: try r.ref("exerciseId", Exercise.self),
              weightKg: try r.double("weightKg"), reps: try r.int("reps"), kind: try r.string("kind", default: "working"),
              rpe: try r.optionalDouble("rpe"), note: try r.string("note", default: ""), completedAt: try r.instant("completedAt"),
              setNumber: r.serial("setNumber"))
  }

  public var fields: [String: JSON] {
    ["sessionId": sessionId.json, "exerciseId": exerciseId.json, "weightKg": .of(weightKg), "reps": JSON(reps),
     "kind": .string(kind), "rpe": .of(rpe), "note": .string(note), "completedAt": .of(completedAt)]
  }
  public var volumeKg: Double { kind == "working" ? max(0, weightKg) * Double(reps) : 0 }
  public var e1rm: Double? { GymEstimate.value(weightKg: weightKg, reps: reps, kind: kind, rpe: rpe) }

  public static let checks: [Check<TrainingSet>] = [
    Check("weightKg") { s, _ in s.weightKg = try SetRules.weightKg.apply(s.weightKg, at: "weightKg") },
    Check("reps") { s, _ in s.reps = try SetRules.reps.apply(s.reps, at: "reps") },
    Check("kind") { s, _ in s.kind = try SetRules.kind.apply(s.kind, at: "kind") },
    Check("rpe") { s, _ in s.rpe = try SetRules.rpe.apply(s.rpe, at: "rpe") },
    Check("note") { s, _ in s.note = try SetRules.note.apply(s.note, at: "note") },
    Check("completedAt") { s, _ in try SessionRules.instant(s.completedAt, rule: "set.completedAt", at: "completedAt") },
  ]
}

public enum SetRules {
  public static let weightKg = NumberSpec("set.weightKg", min: -500, max: 500, quantum: 0.01)
  public static let reps = NumberSpec("set.reps", min: 1, max: 500, integer: true)
  public static let kind = ChoiceSpec("set.kind", values: ["warmup", "working", "drop", "failure"])
  public static let rpe = NumberSpec("set.rpe", min: 1, max: 10, quantum: 0.1)
  public static let note = TextSpec("set.note", unit: .bytes, min: 0, max: 4000, trim: false, nfc: false)
  public static let maxNumber = 2_147_483_647
  static let rules: [Rule] = [.local(weightKg), .local(reps), .local(kind), .local(rpe), .local(note),
                              .local("set.completedAt", subject: TrainingSet.type),
                              .local("set.identity", subject: TrainingSet.type), .local("set.setNumber", subject: TrainingSet.type)]

  public static func nextNumber(_ sets: [TrainingSet], sessionId: ID<Session>, exerciseId: ID<Exercise>) -> Int? {
    let last = sets.filter { $0.sessionId == sessionId && $0.exerciseId == exerciseId }.compactMap(\.setNumber).max() ?? 0
    return last >= maxNumber ? nil : last + 1
  }
}

public enum SessionRules {
  public static let staleAfterMs: Int64 = 4 * 60 * 60 * 1000
  public static let maxClockAheadMs: Int64 = 5 * 60 * 1000
  public static let maxInstantMs: Int64 = 253_402_300_799_000
  static let rules: [Rule] = ["session.startedAt", "session.finishedAt", "session.sets", "session.requestId"].map {
    .local($0, subject: Session.type)
  }

  public static func instant(_ value: Instant, rule: String, at path: Path) throws(Violation) {
    guard value.ms > 0 else { throw Violation(rule: rule, path: path, reason: .below(min: 1)) }
    guard value.ms <= maxInstantMs else { throw Violation(rule: rule, path: path, reason: .above(max: Double(maxInstantMs))) }
  }

  public static func lastActivity(_ session: Session, sets: [TrainingSet]) -> Instant {
    sets.filter { $0.sessionId == session.id }.map(\.completedAt).max() ?? session.startedAt
  }

  public static func autoCloseAt(_ session: Session, sets: [TrainingSet], now: Instant) -> Instant? {
    guard session.isOpen else { return nil }
    let last = lastActivity(session, sets: sets)
    guard now.ms >= last.ms, now.ms.subtractingReportingOverflow(last.ms).partialValue >= staleAfterMs else { return nil }
    return last
  }

  public static func drawn(_ session: Session, sets: [TrainingSet], now: Instant) -> Session {
    guard let finish = autoCloseAt(session, sets: sets, now: now) else { return session }
    var drawn = session; drawn.finishedAt = finish; drawn.closedBy = "stale"; return drawn
  }

  public static func canFinishAt(_ session: Session, at: Instant) -> Bool {
    at.ms > 0 && at.ms >= session.startedAt.ms && at.ms <= maxInstantMs
  }
  public static func canStartAt(_ at: Instant, now: Instant) -> Bool {
    at.ms > 0 && at.ms <= maxInstantMs && (at.ms <= now.ms || at.ms.subtractingReportingOverflow(now.ms).partialValue <= maxClockAheadMs)
  }
  public static func lateSetLands(_ session: Session, completedAt: Instant) -> Bool {
    guard let finish = session.finishedAt else { return true }
    return session.closedBy == "stale" && completedAt.ms <= finish.ms + staleAfterMs
  }
  public static func finish(_ session: Session, at: Instant) throws(Violation) -> Session {
    guard canFinishAt(session, at: at) else { throw Violation(rule: "session.finishedAt", path: "finishedAt", reason: .custom("badInstant")) }
    if session.finishedAt != nil && session.closedBy != "stale" { return session }
    var result = session
    if let finish = session.finishedAt {
      result.finishedAt = at.ms > finish.ms + staleAfterMs ? finish : max(finish, at)
    } else { result.finishedAt = at }
    result.closedBy = "finish"
    return result
  }
  public static func crosses(_ start: Instant, _ finish: Instant, other: Session) -> Bool {
    guard let otherFinish = other.finishedAt else { return false }
    return start.ms < max(otherFinish.ms, other.startedAt.ms + 1) && other.startedAt.ms < max(finish.ms, start.ms + 1)
  }
}

public struct TrainingLog: Sendable {
  public let sessions: [Session]
  public let sets: [TrainingSet]
  public let moment: Moment
  public let firstPullComplete: Bool

  public init(sessions: [Session], sets: [TrainingSet], moment: Moment, firstPullComplete: Bool = true) {
    self.sessions = sessions; self.sets = sets; self.moment = moment; self.firstPullComplete = firstPullComplete
  }
  public init(_ read: Reader) throws {
    self.init(sessions: try read.repository(Session.self).all(in: .drawn), sets: try read.repository(TrainingSet.self).all(in: .drawn),
              moment: read.moment, firstPullComplete: try read.firstPullComplete())
  }
  public var drawnSessions: [Session] {
    sessions.map { SessionRules.drawn($0, sets: sets, now: moment.now) }.sorted {
      $0.startedAt == $1.startedAt ? $0.id < $1.id : $0.startedAt > $1.startedAt
    }
  }
  public var open: Session? { drawnSessions.first { $0.isOpen } }
  public var liveHint: Bool { open != nil }
  public func sets(session: ID<Session>) -> [TrainingSet] {
    guard sessions.contains(where: { $0.id == session }) else { return [] }
    return sets.filter { $0.sessionId == session }.sorted { $0.completedAt == $1.completedAt ? $0.id < $1.id : $0.completedAt < $1.completedAt }
  }
  public func volumeKg(session: ID<Session>) -> Double { sets(session: session).reduce(0) { $0 + $1.volumeKg } }
  public func topE1rm(session: ID<Session>) -> Double? { sets(session: session).compactMap(\.e1rm).max() }
}

public typealias DeleteSet = Remove<TrainingSet, GymRefusal>
