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
    try (path.text.hasSuffix(".before") ? ProposalRules.lines.before : ProposalRules.lines.after).validate(self, at: path)
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
    try ProposalRules.lines.validate(self, at: path)
  }

  // The shared diff rule: each proposed entry in its order, kept or retargeted against the first unmatched base entry of
  // its movement and added when none is left, then every base entry no proposed one matched, removed.
  public static func lines(from base: [RoutineEntry], to proposed: [RoutineEntry]) -> [RoutineChange] {
    var matched = Set<Int>()
    var result: [RoutineChange] = []
    for entry in proposed {
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

  // R118's count of what a diff changes: every line not kept, and one more when the movements it keeps moved.
  public static func count(_ changes: [RoutineChange], against base: [RoutineEntry]) -> Int {
    var unmatched = Array(base.indices)
    let retained = changes.filter { $0.kind == "kept" || $0.kind == "retargeted" }.compactMap { change -> Int? in
      guard let at = unmatched.firstIndex(where: { base[$0].exerciseId == change.exerciseId }) else { return nil }
      return unmatched.remove(at: at)
    }
    return changes.filter { $0.kind != "kept" }.count + (retained != retained.sorted() ? 1 : 0)
  }
}

// The rules of a proposal's change lines at `<type>.changes`: a routine proposal's and a workout proposal's.
public struct ChangeRules: Sendable {
  public struct Targets: Sendable {
    public let sets: CountSpec
    public let reps: NumberSpec
    public let weight: NumberSpec
    public let rest: NumberSpec
    let zeroTarget: String

    init(_ path: String, zeroTarget: String) {
      sets = CountSpec("\(path).sets", min: 1, max: 20)
      reps = NumberSpec("\(path).sets.reps", min: 1, max: 100, integer: true)
      weight = NumberSpec("\(path).sets.weightKg", quantum: 0.01)
      rest = NumberSpec("\(path).restSeconds", min: 15, max: 900, integer: true)
      self.zeroTarget = zeroTarget
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
          if item.reps == 0 { throw Violation(rule: zeroTarget, path: at + "reps", reason: .custom("zeroTarget")) }
          let checkedReps = try reps.apply(item.reps, at: at + "reps")
          let checkedWeight = try weight.apply(item.weightKg, at: at + "weightKg")
          if checkedWeight == 0 && item.weightKg != 0 { throw Violation(rule: zeroTarget, path: at + "weightKg", reason: .custom("zeroTarget")) }
          result.append(SetTarget(reps: checkedReps, weightKg: checkedWeight))
        }
        validated = result
      }
      return EntryTargets(sets: validated, restSeconds: try rest.apply(value.restSeconds, at: path + "restSeconds"))
    }
  }

  public let changes: CountSpec
  public let kind: ChoiceSpec
  public let exercise: TextSpec
  public let before: Targets
  public let after: Targets
  let type: String
  let zeroTarget: String

  init(_ type: String) {
    self.type = type
    zeroTarget = "\(type).zeroTarget"
    changes = CountSpec("\(type).changes", min: 0, max: 100)
    kind = ChoiceSpec("\(type).changes.kind", values: ["kept", "added", "removed", "retargeted"])
    exercise = TextSpec("\(type).changes.exerciseId", unit: .chars, min: 1, max: 64, trim: false, nfc: false)
    before = Targets("\(type).changes.before", zeroTarget: zeroTarget)
    after = Targets("\(type).changes.after", zeroTarget: zeroTarget)
  }

  var rules: [Rule] {
    [.local(changes), .local(kind), .local(exercise)] + before.rules + after.rules + [.local(zeroTarget, subject: type)]
  }

  // Every line, then the removals last, where the diff writes them.
  public func validate(_ lines: [RoutineChange], at path: Path) throws(Violation) -> [RoutineChange] {
    if lines.count > 100 { throw Violation(rule: changes.path, path: path, reason: .tooMany(max: 100)) }
    var validated: [RoutineChange] = []
    for (index, line) in lines.enumerated() { validated.append(try validate(line, at: path + index)) }
    if validated.drop(while: { $0.kind != "removed" }).contains(where: { $0.kind != "removed" }) {
      throw Violation(rule: changes.path, path: path, reason: .custom("removalsLast"))
    }
    return validated
  }

  public func validate(_ line: RoutineChange, at path: Path) throws(Violation) -> RoutineChange {
    let kind = try kind.apply(line.kind, at: path + "kind")
    _ = try exercise.apply(line.exerciseId.record.string ?? "", at: path + "exerciseId")
    if (kind == "added") != (line.before == nil) || (kind == "removed") != (line.after == nil) {
      throw Violation(rule: changes.path, path: path, reason: .custom("side"))
    }
    var validated = RoutineChange(kind: kind, exerciseId: line.exerciseId)
    if let targets = line.before { validated.before = try before.validate(targets, at: path + "before") }
    if let targets = line.after { validated.after = try after.validate(targets, at: path + "after") }
    return validated
  }
}

public enum ProposalProvenance: Equatable, Sendable {
  case ask(threadId: String?)
  case mcp(connection: String, agent: String)
  case other(door: String, connection: String, agent: String)
}

public struct Proposal: Writable, Equatable {
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
    return RoutineChange.count(changes, against: base.entries) + (base.name.utf8.elementsEqual(proposedName.utf8) ? 0 : 1)
  }

  public static let checks: [Check<Proposal>] = [
    Check("intent") { p, _ in p.intent = try ProposalRules.intent.apply(p.intent, at: "intent") },
    Check("proposedName") { p, _ in p.proposedName = try ProposalRules.name.apply(p.proposedName, at: "proposedName") },
    Check("summary") { p, _ in p.summary = try ProposalRules.summary.apply(p.summary, at: "summary") },
    Check("changes") { p, _ in p.changes = try ProposalRules.lines.validate(p.changes, at: "changes") },
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
  public static let lines = ChangeRules("proposal")
  public static let intent = ChoiceSpec("proposal.intent", values: ["revise", "remove"])
  public static let name = TextSpec("proposal.proposedName", unit: .bytes, min: 0, max: 240, trim: true, nfc: true)
  public static let summary = TextSpec("proposal.summary", unit: .bytes, min: 0, max: 400, trim: true, nfc: true)
  public static let door = ChoiceSpec("proposal.door", values: ["ask"])
  public static let connection = TextSpec("proposal.connection", unit: .bytes, min: 0, max: 0, trim: false, nfc: false)
  public static let agent = TextSpec("proposal.agent", unit: .chars, min: 0, max: 0, trim: false, nfc: false)
  static let rules: [Rule] = [.local(intent), .local(name), .local(summary), .local(door), .local(connection), .local(agent)] + lines.rules

  public static func changesBetween(base: [RoutineEntry], proposed: [RoutineEntry]) throws(Violation) -> [RoutineChange] {
    var validated: [RoutineEntry] = []
    for entry in proposed { validated.append(try entry.validated(at: "entries")) }
    return RoutineChange.lines(from: base, to: validated)
  }
}

public struct ProposeRoutine: Action {
  public struct Loaded {
    public let routine: Routine?
    public let routineVisible: Bool
    public let catalogue: Catalogue
    public let moment: Moment
  }

  // What a proposal comes to before it is planned: refused, nothing to propose, or the validated proposal with the plan
  // that mints it, so an executor composing this action answers with the proposal it wrote.
  public enum Proposed {
    case refuse(GymRefusal)
    case unchanged
    case proposal(Valid<Proposal>, Plan)
  }

  public let id: ID<Proposal>
  public let routineId: ID<Routine>
  // Nil keeps the routine's own name.
  public let name: String?
  public let entries: [RoutineEntry]
  public let summary: String
  public let removing: Bool
  public var scope: ScopeRef { Proposal.scope }

  public init(id: ID<Proposal>, routineId: ID<Routine>, name: String?, entries: [RoutineEntry], summary: String, removing: Bool = false) {
    self.id = id; self.routineId = routineId; self.name = name; self.entries = entries; self.summary = summary; self.removing = removing
  }

  public func load(_ read: Reader) throws -> Loaded {
    Loaded(routine: try read.repository(Routine.self).find(routineId, in: .stored),
           routineVisible: try read.repository(Routine.self).find(routineId, in: .drawn) != nil, catalogue: try Catalogue(read, in: .stored), moment: read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<ID<Proposal>, GymRefusal> {
    switch try proposed(over: loaded) {
    case .refuse(let refusal): .refuse(refusal)
    case .unchanged: .unchanged(id)
    case .proposal(_, let plan): .write(plan, id)
    }
  }

  public func proposed(over loaded: Loaded) throws(Violation) -> Proposed {
    guard let base = loaded.routine, loaded.routineVisible else { return .refuse(GymRefusal(Refused(.unknownRecord, subject: routineId.ref, path: .predicted))) }
    let proposed = removing ? [] : try RoutineRules.entries.apply(entries, at: "entries")
    let proposedName = removing ? "" : try RoutineRules.name.apply(name ?? base.name, at: "name")
    if proposed.contains(where: { loaded.catalogue.find($0.exerciseId) == nil }) {
      return .refuse(GymRefusal(Refused(Gym.Codes.unknownExercise, subject: id.ref, path: .predicted)))
    }
    let changes = RoutineChange.lines(from: base.entries, to: proposed)
    try RoutineRules.floored(changes, catalogue: loaded.catalogue)
    if !removing && base.name.utf8.elementsEqual(proposedName.utf8) && JSON.array(base.entries.map(\.json)) == JSON.array(proposed.map(\.json)) { return .unchanged }
    let proposal = try Valid(Proposal(id: id, routineId: base.id, intent: removing ? "remove" : "revise", proposedName: proposedName,
                                      summary: summary, changes: changes), at: loaded.moment)
    var plan = Plan()
    plan.create(proposal)
    plan.guardRead(base.id, fields: ["entries", "name"])
    return .proposal(proposal, plan)
  }
}

// A proposal with its routine three ways: as this phone stores it, whether it is in sight, and as the log last confirmed it.
public struct ProposalState {
  public let proposal: Proposal?
  public let routine: Routine?
  public let routineVisible: Bool
  public let confirmedRoutine: Routine?
  public let moment: Moment

  public init(proposal: Proposal?, routine: Routine?, moment: Moment, routineVisible: Bool = true, confirmedRoutine: Routine? = nil) {
    self.proposal = proposal; self.routine = routine; self.moment = moment; self.routineVisible = routineVisible
    self.confirmedRoutine = confirmedRoutine
  }

  public init(_ read: Reader, id: ID<Proposal>) throws {
    let proposal = try read.repository(Proposal.self).find(id, in: .stored)
    let routines = read.repository(Routine.self)
    self.init(proposal: proposal, routine: try proposal.flatMap { try routines.find($0.routineId, in: .stored) }, moment: read.moment,
              routineVisible: try proposal.flatMap { try routines.find($0.routineId, in: .drawn) } != nil,
              confirmedRoutine: try proposal.flatMap { try read.confirmed(Routine.self, $0.routineId) }.map { try Routine(Fields($0)) })
  }

  // What the log would answer the decision, said before it is sent. Applying asks more than turning down: the routine must
  // stand as the proposal found it, on the log and on this phone, and in sight.
  public func refusal(for id: ID<Proposal>, applying: Bool) -> GymRefusal? {
    guard let proposal else { return GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted)) }
    if proposal.state == "superseded" {
      if proposal.supersededBy != nil { return superseded(id, reason: "replaced") }
      guard let revision = routine?.revision, let base = proposal.baseRevision else { return nil }
      return superseded(id, reason: revision == base ? "superseded" : "routine-changed")
    }
    if proposal.state == "pending" {
      guard applying else { return nil }
      if routineMoved(under: proposal) { return superseded(id, reason: "routine-changed") }
      guard routine != nil, routineVisible else { return GymRefusal(Refused(.unknownRecord, subject: proposal.routineId.ref, path: .predicted)) }
      return nil
    }
    if proposal.state == (applying ? "applied" : "dismissed") { return nil }
    return GymRefusal(Refused(Gym.Codes.proposalSettled, subject: id.ref, detail: ["state": .string(proposal.state)], path: .predicted))
  }

  // Out of date, a proposal can no longer be applied: a newer one replaced it, the log set it aside, or its routine moved
  // while it waited — on the log, in an edit the log has not confirmed, or out of sight.
  public var outOfDate: Bool {
    guard let proposal else { return false }
    if proposal.state == "superseded" || proposal.supersededBy != nil { return true }
    return proposal.state == "pending" && refusal(for: proposal.id, applying: true) != nil
  }

  // The routine moved under a pending proposal: the log counted a new revision, or this phone holds a new name or new
  // movements the log has not confirmed yet, which the log will count before it reads the decision.
  func routineMoved(under proposal: Proposal) -> Bool {
    if let revision = routine?.revision, let base = proposal.baseRevision, revision != base { return true }
    guard let routine, let confirmedRoutine else { return false }
    return !routine.name.utf8.elementsEqual(confirmedRoutine.name.utf8) || routine.entries != confirmedRoutine.entries
  }

  func superseded(_ id: ID<Proposal>, reason: String) -> GymRefusal {
    GymRefusal(Refused(Gym.Codes.proposalSuperseded, subject: id.ref, detail: ["reason": .string(reason)], path: .predicted))
  }
}

public struct ApplyProposal: Action {
  public struct Command: ServerCommand {
    public static let name = Gym.Commands.applyProposal
    public static let specs: [any ValueSpec] = []
    public let proposalId: ID<Proposal>
    public var args: [String: JSON] { ["proposalId": proposalId.json] }
  }

  public typealias Loaded = (state: ProposalState, catalogue: Catalogue)
  public let id: ID<Proposal>
  public var scope: ScopeRef { Proposal.scope }
  public init(_ id: ID<Proposal>) { self.id = id }
  public func load(_ read: Reader) throws -> Loaded { (try ProposalState(read, id: id), try Catalogue(read, in: .stored)) }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    if let refusal = loaded.state.refusal(for: id, applying: true) { return .refuse(refusal) }
    guard let proposal = loaded.state.proposal else { return .refuse(GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted))) }
    if proposal.state == "applied" { return .unchanged(()) }
    if proposal.state == "superseded" { return .write(try Plan(running: Command(proposalId: id))) }
    try RoutineRules.floored(proposal.changes, catalogue: loaded.catalogue)
    var predictions: [Prediction] = [.update(Proposal.self, id, ["state": "applied", "settledAt": JSON(loaded.state.moment.now.ms)])]
    if proposal.intent == "remove" {
      predictions.append(.remove(Routine.self, proposal.routineId))
    } else {
      predictions.append(.update(Routine.self, proposal.routineId, ["name": .string(proposal.proposedName), "entries": .array(proposal.document.map(\.json))]))
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

public struct RoutineRemovalReceipt: Equatable, Sendable {
  public enum Outcome: String, Sendable { case pending, applied, refused }
  public static let key = "rack:removalReceipts"
  public let proposal: Proposal
  public let outcome: Outcome
  // Whether the phone has recorded the log's answer, so a relaunch before the lifter sees it records it no more.
  public let recorded: Bool
  let json: JSON

  init(_ proposal: Proposal) {
    self.proposal = proposal; outcome = .pending; recorded = false
    var snapshot = proposal.fields
    snapshot["state"] = .string(proposal.state)
    snapshot["supersededBy"] = proposal.supersededBy?.json
    snapshot["baseRevision"] = proposal.baseRevision.map(JSON.init)
    snapshot["baseName"] = proposal.baseName.map(JSON.string)
    snapshot["changeCount"] = proposal.changeCount.map(JSON.init)
    snapshot["threadId"] = proposal.threadId.map(JSON.string)
    json = ["snapshot": .object(JSON.Object(uniqueKeysWithValues: snapshot.map { ($0.key, $0.value) })), "status": "pending"]
  }

  init(id: String, json: JSON, commands: [QueuedCommand]) throws {
    let stored = try json.member("status").asString()
    guard let status = Outcome(rawValue: stored) else { throw DecodeError(type: Proposal.type, field: "receipt", reason: "unknown outcome") }
    outcome = status == .applied && commands.contains(where: { $0.command.name == Gym.Commands.applyProposal && $0.command.args["proposalId"] == .string(id) }) ? .pending : status
    var values = try json.member("snapshot").asObject()
    if outcome == .applied { values["state"] = "applied" }
    proposal = try Proposal(Fields(type: Proposal.type, id: RecordID(id), values: Dictionary(uniqueKeysWithValues: values.members)))
    recorded = json["recorded"] == .bool(true)
    self.json = json
  }

  public static func read(_ read: Reader) throws -> [RoutineRemovalReceipt] {
    guard !read.isAnonymous else { return [] }
    let commands = try read.commands()
    return try (read.device(key)?.asObject().members ?? []).map { try RoutineRemovalReceipt(id: $0.key, json: $0.value, commands: commands) }
      .sorted { $0.proposal.id < $1.proposal.id }
  }

  public static let resultWrites: CommandResultDeviceWrites = { command, result, epoch, rows in
    guard command.name == Gym.Commands.applyProposal, let id = try? command.args.member("proposalId").asString(),
          var receipts = try? rows[key]?.asObject(), var receipt = try? receipts[id]?.asObject() else { return [] }
    switch result.verdict {
    case .ok(let seq, _):
      receipt["status"] = "applied"; receipt["seq"] = JSON(seq); receipt["epoch"] = .string(epoch)
    case .refused(let code) where code != .clockSkew && code != .baseUnknown:
      receipt["status"] = "refused"; receipt["code"] = code.json
    case .refused: return []
    }
    receipts[id] = .object(receipt)
    return [DeviceWrite(key: key, value: .object(receipts))]
  }
}

public struct ApplyProposalKeepingReceipt: Action {
  public let id: ID<Proposal>
  public var scope: ScopeRef { Gym.scope }
  public init(_ id: ID<Proposal>) { self.id = id }
  public func load(_ read: Reader) throws -> (ApplyProposal.Loaded, JSON.Object) {
    (try ApplyProposal(id).load(read), try read.device(RoutineRemovalReceipt.key)?.asObject() ?? [:])
  }
  public func decide(_ loaded: (ApplyProposal.Loaded, JSON.Object), ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    if let receipt = loaded.1[id.description], receipt["status"] != "refused" { return .unchanged(()) }
    let decision = try ApplyProposal(id).decide(loaded.0, ids: ids)
    guard let proposal = loaded.0.state.proposal, proposal.intent == "remove", case .write(var plan, _) = decision else { return decision }
    var receipts = loaded.1; receipts[id.description] = RoutineRemovalReceipt(proposal).json
    plan.device(RoutineRemovalReceipt.key, .object(receipts))
    return .write(plan)
  }
}

// The settled removals the phone has not recorded yet, each marked recorded in one write: the result is what to record now.
public struct RecordRoutineRemovalOutcomes: Action {
  public let replica: String
  public var scope: ScopeRef { Gym.scope }
  public init(replica: String) { self.replica = replica }
  public func load(_ read: Reader) throws -> (String, JSON.Object, [RoutineRemovalReceipt]) {
    (read.replica, try read.device(RoutineRemovalReceipt.key)?.asObject() ?? [:], try RoutineRemovalReceipt.read(read))
  }
  public func decide(_ loaded: (String, JSON.Object, [RoutineRemovalReceipt]), ids: IDSource) -> Decision<[RoutineRemovalReceipt], GymRefusal> {
    let unrecorded = loaded.2.filter { $0.outcome != .pending && !$0.recorded }
    guard loaded.0 == replica, !unrecorded.isEmpty else { return .unchanged([]) }
    var receipts = loaded.1
    for receipt in unrecorded {
      guard var row = try? receipts[receipt.proposal.id.description]?.asObject() else { continue }
      row["recorded"] = true
      receipts[receipt.proposal.id.description] = .object(row)
    }
    var plan = Plan(); plan.device(RoutineRemovalReceipt.key, .object(receipts))
    return .write(plan, unrecorded)
  }
}

public struct AcknowledgeRoutineRemoval: Action {
  public let id: ID<Proposal>
  public let replica: String
  public var scope: ScopeRef { Gym.scope }
  public init(_ id: ID<Proposal>, replica: String) { self.id = id; self.replica = replica }
  public func load(_ read: Reader) throws -> (String, JSON.Object, [RoutineRemovalReceipt]) {
    (read.replica, try read.device(RoutineRemovalReceipt.key)?.asObject() ?? [:], try RoutineRemovalReceipt.read(read))
  }
  public func decide(_ loaded: (String, JSON.Object, [RoutineRemovalReceipt]), ids: IDSource) -> Decision<Void, GymRefusal> {
    guard loaded.0 == replica, loaded.2.contains(where: { $0.proposal.id == id && $0.outcome != .pending }) else { return .unchanged(()) }
    var receipts = loaded.1; receipts[id.description] = nil
    var plan = Plan(); plan.device(RoutineRemovalReceipt.key, receipts.isEmpty ? nil : .object(receipts))
    return .write(plan)
  }
}
