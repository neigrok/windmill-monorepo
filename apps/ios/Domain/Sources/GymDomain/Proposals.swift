import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct EntryTargets: ValueObject, Equatable {
  public var sets: [SetTarget]?
  public var restSeconds: Int?

  public init(sets: [SetTarget]? = nil, restSeconds: Int? = nil) {
    self.sets = sets
    self.restSeconds = restSeconds
  }

  public init(_ entry: RoutineEntry) { self.init(sets: entry.sets, restSeconds: entry.restSeconds) }

  public init(_ fields: Fields) throws(DecodeError) {
    self.init(sets: try fields.optionalList("sets", of: SetTarget.self), restSeconds: try fields.optionalInt("restSeconds"))
  }

  public var json: JSON {
    .object(omittingNil: ["sets": sets.map { .array($0.map(\.json)) }, "restSeconds": restSeconds.map(JSON.init)])
  }

  public func validated(at path: Path) throws(Violation) -> EntryTargets {
    try (path.text.hasSuffix(".before") ? ProposalRules.before : ProposalRules.after).validate(self, at: path)
  }
}

public struct RoutineChange: ValueObject, Equatable {
  public var kind: String
  public let exerciseId: ID<Exercise>
  public var before: EntryTargets?
  public var after: EntryTargets?

  public init(kind: String, exerciseId: ID<Exercise>, before: EntryTargets? = nil, after: EntryTargets? = nil) {
    self.kind = kind
    self.exerciseId = exerciseId
    self.before = before
    self.after = after
  }

  public init(_ fields: Fields) throws(DecodeError) {
    self.init(kind: try fields.string("kind"), exerciseId: try fields.ref("exerciseId", Exercise.self),
              before: try fields.optionalValue("before", of: EntryTargets.self), after: try fields.optionalValue("after", of: EntryTargets.self))
  }

  public var json: JSON {
    .object(omittingNil: ["kind": .string(kind), "exerciseId": exerciseId.json, "before": before?.json, "after": after?.json])
  }

  public func validated(at path: Path) throws(Violation) -> RoutineChange {
    let kind = try ProposalRules.kind.apply(kind, at: path + "kind")
    _ = try ProposalRules.exercise.apply(exerciseId.record.string ?? "", at: path + "exerciseId")
    if (kind == "added") != (before == nil) || (kind == "removed") != (after == nil) {
      throw Violation(rule: "proposal.changes", path: path, reason: .custom("side"))
    }
    return RoutineChange(kind: kind, exerciseId: exerciseId, before: try before?.validated(at: path + "before"),
                         after: try after?.validated(at: path + "after"))
  }
}

public enum ProposalProvenance: Equatable, Sendable {
  case ask(threadId: String?)
  case mcp(connection: String, agent: String)
  case other(door: String, connection: String, agent: String)
}

public struct Proposal: Writable {
  public static let type = Gym.Types.proposal
  public static let scope = Gym.scope

  public let id: ID<Proposal>
  public let routineId: ID<Routine>
  public var intent: String
  public var proposedName: String
  public var summary: String
  public var changes: [RoutineChange]
  public var door: String
  public var connection: String
  public var agent: String
  public let state: String
  public let supersededBy: ID<Proposal>?
  public let settledAt: Instant?
  public let baseRevision: Int?
  public let baseName: String?
  public let changeCount: Int?
  public let threadId: String?

  public init(id: ID<Proposal>, routineId: ID<Routine>, intent: String, proposedName: String, summary: String,
              changes: [RoutineChange], door: String = "ask", connection: String = "", agent: String = "",
              state: String = "pending", supersededBy: ID<Proposal>? = nil, settledAt: Instant? = nil,
              baseRevision: Int? = nil, baseName: String? = nil, changeCount: Int? = nil, threadId: String? = nil) {
    self.id = id
    self.routineId = routineId
    self.intent = intent
    self.proposedName = proposedName
    self.summary = summary
    self.changes = changes
    self.door = door
    self.connection = connection
    self.agent = agent
    self.state = state
    self.supersededBy = supersededBy
    self.settledAt = settledAt
    self.baseRevision = baseRevision
    self.baseName = baseName
    self.changeCount = changeCount
    self.threadId = threadId
  }

  public init(_ fields: Fields) throws(DecodeError) {
    self.init(id: ID(fields.id), routineId: try fields.ref("routineId", Routine.self), intent: try fields.string("intent"),
              proposedName: try fields.string("proposedName", default: ""), summary: try fields.string("summary", default: ""),
              changes: try fields.list("changes", of: RoutineChange.self), door: try fields.string("door", default: "ask"),
              connection: try fields.string("connection", default: ""), agent: try fields.string("agent", default: ""),
              state: try fields.string("state", default: "pending"), supersededBy: try fields.optionalRef("supersededBy", Proposal.self),
              settledAt: try fields.optionalInstant("settledAt"), baseRevision: try fields.optionalInt("baseRevision"),
              baseName: try fields.optionalString("baseName"), changeCount: try fields.optionalInt("changeCount"), threadId: try fields.optionalString("threadId"))
  }

  public var fields: [String: JSON] {
    ["routineId": routineId.json, "intent": .string(intent), "proposedName": .string(proposedName), "summary": .string(summary),
     "changes": .array(changes.map(\.json)), "door": .string(door), "connection": .string(connection), "agent": .string(agent)]
  }

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

  public func countChanges(comparedTo base: Routine) -> Int {
    if let changeCount { return changeCount }
    var unmatched = Array(base.entries.indices)
    let retained = changes.filter { $0.kind == "kept" || $0.kind == "retargeted" }.compactMap { change -> Int? in
      guard let at = unmatched.firstIndex(where: { base.entries[$0].exerciseId == change.exerciseId }) else { return nil }
      return unmatched.remove(at: at)
    }
    let reordered = retained != retained.sorted()
    return changes.filter { $0.kind != "kept" }.count + (!base.name.utf8.elementsEqual(proposedName.utf8) ? 1 : 0) + (reordered ? 1 : 0)
  }

  public static let checks: [Check<Proposal>] = [
    Check("intent") { p, _ in p.intent = try ProposalRules.intent.apply(p.intent, at: "intent") },
    Check("proposedName") { p, _ in p.proposedName = try ProposalRules.name.apply(p.proposedName, at: "proposedName") },
    Check("summary") { p, _ in p.summary = try ProposalRules.summary.apply(p.summary, at: "summary") },
    Check("changes") { p, _ in
      p.changes = try ProposalRules.changes.apply(p.changes, at: "changes")
      if p.changes.drop(while: { $0.kind != "removed" }).contains(where: { $0.kind != "removed" }) {
        throw Violation(rule: "proposal.changes", path: "changes", reason: .custom("removalsLast"))
      }
    },
    Check("door") { p, _ in p.door = try ProposalRules.door.apply(p.door, at: "door") },
    Check("connection") { p, _ in p.connection = try ProposalRules.connection.apply(p.connection, at: "connection") },
    Check("agent") { p, _ in p.agent = try ProposalRules.agent.apply(p.agent, at: "agent") },
  ]
}

public struct RoutineCreation: Entity {
  public static let type = "routineCreation"
  public static let scope = Gym.scope
  public let id: ID<RoutineCreation>
  public let snapshot: JSON?

  public init(id: ID<RoutineCreation>, snapshot: JSON? = nil) { self.id = id; self.snapshot = snapshot }
  public init(_ fields: Fields) throws(DecodeError) { self.init(id: ID(fields.id), snapshot: fields.json("snapshot").flatMap { $0.isNull ? nil : $0 }) }
}

public enum ProposalRules {
  public struct Targets: Sendable {
    public let sets: CountSpec
    public let reps: NumberSpec
    public let weight: NumberSpec
    public let rest: NumberSpec

    init(_ path: String) {
      sets = CountSpec("\(path).sets", min: 1, max: 20)
      reps = NumberSpec("\(path).sets.reps", min: 1, max: 100, integer: true)
      weight = NumberSpec("\(path).sets.weightKg", min: -500, max: 500, quantum: 0.01)
      rest = NumberSpec("\(path).restSeconds", min: 15, max: 900, integer: true)
    }

    var rules: [Rule] { [.local(sets), .local(reps), .local(weight), .local(rest)] }

    func validate(_ value: EntryTargets, at path: Path) throws(Violation) -> EntryTargets {
      var validated: [SetTarget]?
      if let items = value.sets {
        if items.isEmpty { throw Violation(rule: sets.path, path: path + "sets", reason: .tooFew(min: 1)) }
        if items.count > 20 { throw Violation(rule: sets.path, path: path + "sets", reason: .tooMany(max: 20)) }
        var result: [SetTarget] = []
        for (index, item) in items.enumerated() {
          let at = path + "sets" + index
          if item.reps == 0 { throw Violation(rule: "proposal.zeroTarget", path: at + "reps", reason: .custom("zeroTarget")) }
          let checkedReps = try reps.apply(item.reps, at: at + "reps")
          let checkedWeight = try weight.apply(item.weightKg, at: at + "weightKg")
          if checkedWeight == 0 { throw Violation(rule: "proposal.zeroTarget", path: at + "weightKg", reason: .custom("zeroTarget")) }
          result.append(SetTarget(reps: checkedReps, weightKg: checkedWeight))
        }
        validated = result
      }
      return EntryTargets(sets: validated, restSeconds: try rest.apply(value.restSeconds, at: path + "restSeconds"))
    }
  }

  public static let before = Targets("proposal.changes.before")
  public static let after = Targets("proposal.changes.after")
  public static let intent = ChoiceSpec("proposal.intent", values: ["revise", "remove"])
  public static let name = TextSpec("proposal.proposedName", unit: .bytes, min: 0, max: 240, trim: true, nfc: true)
  public static let summary = TextSpec("proposal.summary", unit: .bytes, min: 0, max: 400, trim: true, nfc: true)
  public static let changes = CountSpec("proposal.changes", min: 0, max: 100)
  public static let kind = ChoiceSpec("proposal.changes.kind", values: ["kept", "added", "removed", "retargeted"])
  public static let door = ChoiceSpec("proposal.door", values: ["ask"])
  public static let connection = TextSpec("proposal.connection", unit: .bytes, min: 0, max: 0, trim: false, nfc: false)
  public static let agent = TextSpec("proposal.agent", unit: .chars, min: 0, max: 0, trim: false, nfc: false)
  public static let exercise = TextSpec("proposal.changes.exerciseId", unit: .chars, min: 1, max: 64, trim: false, nfc: false)
  static let rules: [Rule] = [.local(intent), .local(name), .local(summary), .local(changes), .local(kind), .local(door),
                             .local(connection), .local(agent), .local(exercise)] + before.rules + after.rules + [.local("proposal.zeroTarget", subject: Proposal.type)]

  public static func changesBetween(base: [RoutineEntry], proposed: [RoutineEntry]) throws(Violation) -> [RoutineChange] {
    var matched = Set<Int>()
    var result: [RoutineChange] = []
    for raw in proposed {
      let entry = try raw.validated(at: "entries")
      guard let index = base.indices.first(where: { !matched.contains($0) && base[$0].exerciseId == entry.exerciseId }) else {
        result.append(RoutineChange(kind: "added", exerciseId: entry.exerciseId, after: EntryTargets(entry)))
        continue
      }
      matched.insert(index)
      let previous = EntryTargets(base[index])
      let next = EntryTargets(entry)
      result.append(RoutineChange(kind: previous == next ? "kept" : "retargeted", exerciseId: entry.exerciseId, before: previous, after: next))
    }
    for index in base.indices where !matched.contains(index) {
      result.append(RoutineChange(kind: "removed", exerciseId: base[index].exerciseId, before: EntryTargets(base[index])))
    }
    return result
  }
}

public struct ProposeRoutine: Action {
  public struct Loaded {
    public let routine: Routine?
    public let routineVisible: Bool
    public let catalogue: Catalogue
    public let moment: Moment
  }

  public let id: ID<Proposal>
  public let routineId: ID<Routine>
  public let name: String
  public let entries: [RoutineEntry]
  public let summary: String
  public let removing: Bool
  public var scope: ScopeRef { Proposal.scope }

  public init(id: ID<Proposal>, routineId: ID<Routine>, name: String, entries: [RoutineEntry], summary: String, removing: Bool = false) {
    self.id = id; self.routineId = routineId; self.name = name; self.entries = entries; self.summary = summary; self.removing = removing
  }

  public func load(_ read: Reader) throws -> Loaded {
    Loaded(routine: try read.repository(Routine.self).find(routineId, in: .stored),
           routineVisible: try read.repository(Routine.self).find(routineId, in: .drawn) != nil, catalogue: try Catalogue(read, in: .stored), moment: read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<ID<Proposal>, GymRefusal> {
    guard let base = loaded.routine, loaded.routineVisible else { return .refuse(GymRefusal(Refused(.unknownRecord, subject: routineId.ref, path: .predicted))) }
    let proposed = removing ? [] : try RoutineRules.entries.apply(entries, at: "entries")
    let proposedName = removing ? "" : try RoutineRules.name.apply(name, at: "name")
    if proposed.contains(where: { loaded.catalogue.find($0.exerciseId) == nil }) {
      return .refuse(GymRefusal(Refused(Gym.Codes.unknownExercise, subject: id.ref, path: .predicted)))
    }
    if !removing && base.name.utf8.elementsEqual(proposedName.utf8) && JSON.array(base.entries.map(\.json)) == JSON.array(proposed.map(\.json)) { return .unchanged(id) }
    let proposal = Proposal(id: id, routineId: base.id, intent: removing ? "remove" : "revise", proposedName: proposedName,
                            summary: summary, changes: try ProposalRules.changesBetween(base: base.entries, proposed: proposed))
    var plan = Plan()
    plan.create(try Valid(proposal, at: loaded.moment))
    plan.guardRead(base.id, fields: ["entries", "name"])
    return .write(plan, id)
  }
}

public struct ProposalState {
  public let proposal: Proposal?
  public let routine: Routine?
  public let routineVisible: Bool
  public let moment: Moment

  public init(proposal: Proposal?, routine: Routine?, moment: Moment, routineVisible: Bool = true) {
    self.proposal = proposal; self.routine = routine; self.moment = moment; self.routineVisible = routineVisible
  }

  public init(_ read: Reader, id: ID<Proposal>) throws {
    let proposal = try read.repository(Proposal.self).find(id, in: .stored)
    self.init(proposal: proposal, routine: try proposal.flatMap { try read.repository(Routine.self).find($0.routineId, in: .stored) }, moment: read.moment,
              routineVisible: try proposal.flatMap { try read.repository(Routine.self).find($0.routineId, in: .drawn) } != nil)
  }

  public func refusal(for id: ID<Proposal>, applying: Bool) -> GymRefusal? {
    guard let proposal else { return GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted)) }
    let reason: String?
    if proposal.supersededBy != nil { reason = "replaced" }
    else if let revision = routine?.revision, let base = proposal.baseRevision, revision != base { reason = "routine-changed" }
    else if proposal.state == "superseded", routine?.revision != nil && proposal.baseRevision != nil { reason = "superseded" }
    else { reason = nil }
    if proposal.state == "superseded" || (applying && proposal.state == "pending" && reason == "routine-changed") {
      guard let reason else { return nil }
      return GymRefusal(Refused(Gym.Codes.proposalSuperseded, subject: id.ref, detail: ["reason": .string(reason)], path: .predicted))
    }
    if proposal.state != "pending" && proposal.state != (applying ? "applied" : "dismissed") {
      return GymRefusal(Refused(Gym.Codes.proposalSettled, subject: id.ref, detail: ["state": .string(proposal.state)], path: .predicted))
    }
    return nil
  }
}

public struct ApplyProposal: Action {
  public struct Command: ServerCommand {
    public static let name = Gym.Commands.applyProposal
    public static let specs: [any ValueSpec] = []
    public let proposalId: ID<Proposal>
    public var args: [String: JSON] { ["proposalId": proposalId.json] }
  }

  public let id: ID<Proposal>
  public var scope: ScopeRef { Proposal.scope }
  public init(_ id: ID<Proposal>) { self.id = id }
  public func load(_ read: Reader) throws -> ProposalState { try ProposalState(read, id: id) }

  public func decide(_ loaded: ProposalState, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    if let refusal = loaded.refusal(for: id, applying: true) { return .refuse(refusal) }
    guard let proposal = loaded.proposal else { return .refuse(GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted))) }
    if proposal.state == "applied" { return .unchanged(()) }
    if proposal.state == "superseded" { return .write(try Plan(running: Command(proposalId: id))) }
    guard let routine = loaded.routine, loaded.routineVisible else { return .refuse(GymRefusal(Refused(.unknownRecord, subject: proposal.routineId.ref, path: .predicted))) }
    var predictions: [Prediction] = [.update(Proposal.self, id, ["state": "applied", "settledAt": JSON(loaded.moment.now.ms)])]
    if proposal.intent == "remove" {
      predictions.append(.remove(Routine.self, routine.id))
    } else {
      predictions.append(.update(Routine.self, routine.id, ["name": .string(proposal.proposedName), "entries": .array(proposal.document.map(\.json))]))
    }
    return .write(try Plan(running: Command(proposalId: id), predicting: predictions))
  }
}

public struct DismissProposal: Action {
  public struct Command: ServerCommand {
    public static let name = Gym.Commands.dismissProposal
    public static let specs: [any ValueSpec] = []
    public let proposalId: ID<Proposal>
    public var args: [String: JSON] { ["proposalId": proposalId.json] }
  }

  public let id: ID<Proposal>
  public var scope: ScopeRef { Proposal.scope }
  public init(_ id: ID<Proposal>) { self.id = id }
  public func load(_ read: Reader) throws -> ProposalState { try ProposalState(read, id: id) }

  public func decide(_ loaded: ProposalState, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    if let refusal = loaded.refusal(for: id, applying: false) { return .refuse(refusal) }
    guard let proposal = loaded.proposal else { return .refuse(GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted))) }
    if proposal.state == "dismissed" { return .unchanged(()) }
    if proposal.state == "superseded" { return .write(try Plan(running: Command(proposalId: id))) }
    let settled = Prediction.update(Proposal.self, id, ["state": "dismissed", "settledAt": JSON(loaded.moment.now.ms)])
    return .write(try Plan(running: Command(proposalId: id), predicting: [settled]))
  }
}
