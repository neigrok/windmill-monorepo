import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A change to the open workout's plan that Coach proposes and the lifter applies or turns down: the whole plan's diff
// against the plan as it stood, a routine proposal's change lines. The server stamps the plan revision it read.
public struct WorkoutProposal: Writable, Equatable {
  public static let type = Gym.Types.workoutProposal
  public static let scope = Gym.scope

  public let id: ID<WorkoutProposal>
  public let sessionId: ID<Session>
  public var summary: String
  public var changes: [RoutineChange]
  public var door: String
  public var connection: String
  public var agent: String
  public let state: String
  public let supersededBy: ID<WorkoutProposal>?
  public let settledAt: Instant?
  public let baseRevision: Int?
  public let changeCount: Int?
  public let threadId: String?

  public init(id: ID<WorkoutProposal>, sessionId: ID<Session>, summary: String, changes: [RoutineChange], door: String = "ask",
              connection: String = "", agent: String = "", state: String = "pending", supersededBy: ID<WorkoutProposal>? = nil,
              settledAt: Instant? = nil, baseRevision: Int? = nil, changeCount: Int? = nil, threadId: String? = nil) {
    self.id = id
    self.sessionId = sessionId
    self.summary = summary
    self.changes = changes
    self.door = door
    self.connection = connection
    self.agent = agent
    self.state = state
    self.supersededBy = supersededBy
    self.settledAt = settledAt
    self.baseRevision = baseRevision
    self.changeCount = changeCount
    self.threadId = threadId
  }

  public init(_ fields: Fields) throws(DecodeError) {
    self.init(id: ID(fields.id), sessionId: try fields.ref("sessionId", Session.self), summary: try fields.string("summary", default: ""),
              changes: try fields.list("changes", of: RoutineChange.self), door: try fields.string("door", default: "ask"),
              connection: try fields.string("connection", default: ""), agent: try fields.string("agent", default: ""),
              state: try fields.string("state", default: "pending"), supersededBy: try fields.optionalRef("supersededBy", WorkoutProposal.self),
              settledAt: try fields.optionalInstant("settledAt"), baseRevision: try fields.optionalInt("baseRevision"),
              changeCount: try fields.optionalInt("changeCount"), threadId: try fields.optionalString("threadId"))
  }

  public var fields: [String: JSON] {
    ["sessionId": sessionId.json, "summary": .string(summary), "changes": .array(changes.map(\.json)), "door": .string(door),
     "connection": .string(connection), "agent": .string(agent)]
  }

  // The plan's entries once applied: every line but the removed, as proposed.
  public var document: [RoutineEntry] {
    changes.filter { $0.kind != "removed" }.map { RoutineEntry(exerciseId: $0.exerciseId, sets: $0.after?.sets, restSeconds: $0.after?.restSeconds) }
  }

  public var provenance: ProposalProvenance {
    switch door {
    case "ask": .ask(threadId: threadId)
    case "mcp": .mcp(connection: connection, agent: agent)
    default: .other(door: door, connection: connection, agent: agent)
    }
  }

  public static let checks: [Check<WorkoutProposal>] = [
    Check("summary") { p, _ in p.summary = try WorkoutProposalRules.summary.apply(p.summary, at: "summary") },
    Check("changes") { p, _ in p.changes = try WorkoutProposalRules.lines.validate(p.changes, at: "changes") },
    Check("door") { p, _ in p.door = try WorkoutProposalRules.door.apply(p.door, at: "door") },
    Check("connection") { p, _ in p.connection = try WorkoutProposalRules.connection.apply(p.connection, at: "connection") },
    Check("agent") { p, _ in p.agent = try WorkoutProposalRules.agent.apply(p.agent, at: "agent") },
  ]
}

public enum WorkoutProposalRules {
  public static let lines = ChangeRules("workoutProposal")
  public static let summary = TextSpec("workoutProposal.summary", unit: .bytes, min: 0, max: 400, trim: true, nfc: true)
  public static let door = ChoiceSpec("workoutProposal.door", values: ["ask"])
  public static let connection = TextSpec("workoutProposal.connection", unit: .bytes, min: 0, max: 0, trim: false, nfc: false)
  public static let agent = TextSpec("workoutProposal.agent", unit: .chars, min: 0, max: 0, trim: false, nfc: false)
  static let rules: [Rule] = [.local(summary), .local(door), .local(connection), .local(agent)] + lines.rules + [
    .serverDecided("workoutProposal.exercise", codes: [Gym.Codes.unknownExercise], subject: WorkoutProposal.type),
    .serverDecided("workoutProposal.plan", codes: [Gym.Codes.planLogged], subject: WorkoutProposal.type),
    .serverDecided("workoutProposal.session", codes: [Gym.Codes.sessionFinished], subject: WorkoutProposal.type),
    .serverDecided("workoutProposal.settled", codes: [Gym.Codes.proposalSettled], subject: WorkoutProposal.type),
    .serverDecided("workoutProposal.superseded", codes: [Gym.Codes.proposalSuperseded], subject: WorkoutProposal.type),
  ]
}

// Coach's whole plan for the open workout, minted as a proposal of its diff against the plan as stored, guarding that
// plan. It may move a logged movement but never change its entries, and it adds no second entry of a movement.
public struct ProposeWorkout: Action {
  // What a proposal comes to before it is planned, so an executor composing this action answers with the proposal it wrote.
  public enum Proposed {
    case refuse(GymRefusal)
    case unchanged
    case proposal(Valid<WorkoutProposal>, Plan)
  }

  public let id: ID<WorkoutProposal>
  public let sessionId: ID<Session>
  public let entries: [RoutineEntry]
  public let summary: String
  public var scope: ScopeRef { WorkoutProposal.scope }

  public init(id: ID<WorkoutProposal>, sessionId: ID<Session>, entries: [RoutineEntry], summary: String) {
    self.id = id
    self.sessionId = sessionId
    self.entries = entries
    self.summary = summary
  }

  public func load(_ read: Reader) throws -> OpenWorkout { try OpenWorkout(read, id: sessionId) }

  public func decide(_ loaded: OpenWorkout, ids: IDSource) throws(Violation) -> Decision<ID<WorkoutProposal>, GymRefusal> {
    switch try proposed(over: loaded) {
    case .refuse(let refusal): .refuse(refusal)
    case .unchanged: .unchanged(id)
    case .proposal(_, let plan): .write(plan, id)
    }
  }

  public func proposed(over loaded: OpenWorkout) throws(Violation) -> Proposed {
    let workout: WorkoutPlan
    do throws(GymRefusal) { workout = try loaded.plan(refusing: id.ref) } catch { return .refuse(error) }
    if entries == workout.plan.entries { return .unchanged }
    let proposal = try Valid(WorkoutProposal(id: id, sessionId: sessionId, summary: summary,
                                             changes: RoutineChange.lines(from: workout.plan.entries, to: entries)), at: loaded.moment)
    if entries.contains(where: { loaded.catalogue.find($0.exerciseId) == nil }) {
      return .refuse(GymRefusal(Refused(Gym.Codes.unknownExercise, subject: id.ref, path: .predicted)))
    }
    // A movement appears once, or as often as the routine gave the plan it.
    var named: [ID<Exercise>: Int] = [:]
    for (index, entry) in entries.enumerated() {
      named[entry.exerciseId, default: 0] += 1
      if named[entry.exerciseId, default: 0] > max(1, workout.plan.entries.filter({ $0.exerciseId == entry.exerciseId }).count) {
        throw Violation(rule: WorkoutPlanRules.duplicate, path: Path("entries") + index + "exerciseId", reason: .custom("duplicate"))
      }
    }
    if let movement = workout.loggedChange(to: entries) {
      return .refuse(GymRefusal(Refused(Gym.Codes.planLogged, subject: id.ref, detail: ["exerciseId": movement.json], path: .predicted)))
    }
    var plan = Plan()
    plan.create(proposal)
    plan.guardRead(sessionId, fields: ["plan"])
    return .proposal(proposal, plan)
  }
}

// A workout proposal with its workout: why it can no longer be applied, and what the log would answer a decision on it.
public struct WorkoutProposalState: Sendable {
  public enum Reason: String, Sendable {
    case replaced
    case workoutFinished = "workout-finished"
    case workoutChanged = "workout-changed"
    case workoutMoved = "workout-moved"
  }

  public struct OutOfDate: Equatable, Sendable {
    public let reason: Reason
    // The logged movement a `workout-moved` proposal changes.
    public let exerciseId: ID<Exercise>?

    public init(_ reason: Reason, exerciseId: ID<Exercise>? = nil) {
      self.reason = reason
      self.exerciseId = exerciseId
    }
  }

  public let proposal: WorkoutProposal?
  public let workout: OpenWorkout?
  public let moment: Moment

  public init(proposal: WorkoutProposal?, workout: OpenWorkout?, moment: Moment) {
    self.proposal = proposal
    self.workout = workout
    self.moment = moment
  }

  public init(_ read: Reader, id: ID<WorkoutProposal>) throws {
    let proposal = try read.repository(WorkoutProposal.self).find(id, in: .stored)
    self.init(proposal: proposal, workout: try proposal.map { try OpenWorkout(read, id: $0.sessionId) }, moment: read.moment)
  }

  // Null for a pending proposal that still applies and for one the lifter decided; otherwise the first reason of a newer
  // proposal replacing it, its workout closing, its plan changing past the revision it read, or a movement it changes
  // gaining a logged set.
  public var outOfDate: OutOfDate? {
    guard let proposal else { return nil }
    if proposal.state == "superseded" { return OutOfDate(proposal.supersededBy == nil ? .workoutChanged : .replaced) }
    guard proposal.state == "pending", let workout, let session = workout.session else { return nil }
    if workout.isClosed { return OutOfDate(.workoutFinished) }
    if let base = proposal.baseRevision, base != session.planRevision ?? 1 { return OutOfDate(.workoutChanged) }
    guard let moved = proposal.changes.first(where: { $0.kind != "kept" && workout.logged.contains($0.exerciseId) }) else { return nil }
    return OutOfDate(.workoutMoved, exerciseId: moved.exerciseId)
  }

  public func refusal(for id: ID<WorkoutProposal>, applying: Bool) -> GymRefusal? {
    guard let proposal else { return GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted)) }
    if let outOfDate, proposal.state == "superseded" || applying {
      return GymRefusal(Refused(Gym.Codes.proposalSuperseded, subject: id.ref, detail: ["reason": .string(outOfDate.reason.rawValue)], path: .predicted))
    }
    if proposal.state == "pending" {
      if !applying { return nil }
      let inSight = workout.map { $0.session != nil && $0.visible } ?? false
      return inSight ? nil : GymRefusal(Refused(.unknownRecord, subject: proposal.sessionId.ref, path: .predicted))
    }
    if proposal.state == (applying ? "applied" : "dismissed") { return nil }
    return GymRefusal(Refused(Gym.Codes.proposalSettled, subject: id.ref, detail: ["state": .string(proposal.state)], path: .predicted))
  }
}

public struct ApplyWorkoutProposal: Action {
  public struct Command: ServerCommand {
    public static let name = Gym.Commands.applyWorkoutProposal
    public static let specs: [any ValueSpec] = []
    public let proposalId: ID<WorkoutProposal>
    public var args: [String: JSON] { ["proposalId": proposalId.json] }
  }

  public let id: ID<WorkoutProposal>
  public var scope: ScopeRef { WorkoutProposal.scope }
  public init(_ id: ID<WorkoutProposal>) { self.id = id }
  public func load(_ read: Reader) throws -> WorkoutProposalState { try WorkoutProposalState(read, id: id) }

  public func decide(_ loaded: WorkoutProposalState, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    if let refusal = loaded.refusal(for: id, applying: true) { return .refuse(refusal) }
    guard let proposal = loaded.proposal, let session = loaded.workout?.session else {
      return .refuse(GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted)))
    }
    if proposal.state == "applied" { return .unchanged(()) }
    let applied = SessionPlan(routine: try WorkoutPlanRules.plan(of: session).routine, entries: proposal.document)
    return .write(try Plan(running: Command(proposalId: id), predicting: [
      .update(WorkoutProposal.self, id, ["state": "applied", "settledAt": JSON(loaded.moment.now.ms)]),
      .update(Session.self, session.id, ["plan": applied.json]),
    ]))
  }
}

public struct DismissWorkoutProposal: Action {
  public struct Command: ServerCommand {
    public static let name = Gym.Commands.dismissWorkoutProposal
    public static let specs: [any ValueSpec] = []
    public let proposalId: ID<WorkoutProposal>
    public var args: [String: JSON] { ["proposalId": proposalId.json] }
  }

  public let id: ID<WorkoutProposal>
  public var scope: ScopeRef { WorkoutProposal.scope }
  public init(_ id: ID<WorkoutProposal>) { self.id = id }
  public func load(_ read: Reader) throws -> WorkoutProposalState { try WorkoutProposalState(read, id: id) }

  public func decide(_ loaded: WorkoutProposalState, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    if let refusal = loaded.refusal(for: id, applying: false) { return .refuse(refusal) }
    if loaded.proposal?.state == "dismissed" { return .unchanged(()) }
    let settled = Prediction.update(WorkoutProposal.self, id, ["state": "dismissed", "settledAt": JSON(loaded.moment.now.ms)])
    return .write(try Plan(running: Command(proposalId: id), predicting: [settled]))
  }
}
