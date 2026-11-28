import Foundation
import Agent
import DomainKit
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncEngine
import WindmillPlatform

// Roadmap Coach §8 on the phone: what roadmap gives the Coach engine's turn. The turn's records are written as roadmap's
// acts on the room's runner, each run in the same synchronous span as the check of the turn's lease, so a write that comes
// after the seat changed or the record went lands nowhere (engine §5, The seat changes). The context and the history open
// the turn, the abilities run through the tool host over the phone's copy, the text is written at most once a second, and
// the end keeps the facts of the turn's calls and receipts (§9).
@MainActor final class RoadmapTurnHost: Agent.ToolHost {
  // What a send opened, which the engine's open takes: the turn's records, what the conversation is about, the step it
  // started from, the seat it runs under, and the tool host of its abilities.
  struct Opened {
    let turn: RoadmapDomain.OpenTurn.Turn
    let about: String?
    let step: String?
    let seat: Agent.Seat
    let tools: RoadmapToolHost
  }

  // The turn being written, with what it has recorded of its calls and direct writes and the text its message last took.
  final class Writing {
    let opened: Opened
    var calls: [CoachCall] = []
    var receipts: [CoachReceipt] = []
    var committedText = ""
    var committedAt: ContinuousClock.Instant?
    // The words the engine last handed over, which a commit waiting for its second writes.
    var latest = ""
    var trailing: Task<Void, Never>?

    init(_ opened: Opened) { self.opened = opened }
  }

  // What the room hears of the turn as it runs: the words so far, ahead of what its record holds, and each direct write.
  @MainActor protocol Listener: AnyObject {
    func answering(_ message: ID<CoachMessage>, text: String)
    func wrote(_ write: CoachWrite)
  }

  let runner: ActionRunner
  let profile: CoachProfile
  let seat: @MainActor () throws -> Agent.Seat
  let textEvery: Duration
  var generation: UInt64 = 0
  var next: Opened?
  var writing: Writing?
  // How the turn the engine runs now ended, for its `roadmap_coach_turn` event; none while it has not, or where it never
  // reached its end.
  private(set) var lastEnd: TurnEnd?
  weak var listener: (any Listener)?

  init(runner: ActionRunner, profile: CoachProfile, seat: @escaping @MainActor () throws -> Agent.Seat, textEvery: Duration = .seconds(1)) {
    self.runner = runner; self.profile = profile; self.seat = seat; self.textEvery = textEvery
  }

  // The seat is changing: a write under a lease the host gave out before lands nowhere.
  func seatDidChange() { generation &+= 1 }

  // MARK: - Open and recover

  func open(_ input: TurnInput) async throws -> Agent.OpenTurn {
    lastEnd = nil
    guard let opened = next, opened.turn.coach.description == input.turnId else { throw HostFailure.recordGone }
    next = nil
    let lease = try leased(input)
    let started = Writing(opened)
    writing = started
    let standing = try StandingRoadmaps(reading: runner)
    let context = RoadmapContext.read(standing, about: opened.about, step: opened.step)
    started.calls.append(Self.contextCall(context, about: opened.about))
    let history = try runner.read(CoachThread.scope) { try Conversation.read($0, thread: opened.turn.thread) }?.messages ?? []
    let earlier = history.filter { $0.id != opened.turn.person && $0.id != opened.turn.coach }
    guard case .success(let told) = context else { return Agent.OpenTurn(lease: lease, history: profile.history(earlier)) }
    return Agent.OpenTurn(lease: lease, history: profile.history(earlier), context: [profile.context(told, about: opened.about)])
  }

  // The context as the turn's first call records it: of one roadmap the steps it was told of and how many are done, of all
  // roadmaps how many it was told of.
  static func contextCall(_ context: Result<JSON, CoachRefusal>, about: String?) -> CoachCall {
    switch context {
    case .failure(let refusal): return CoachCall(ability: CoachCall.context, treeId: about, outcome: refusal.code.rawValue)
    case .success(let told):
      if about == nil { return CoachCall(ability: CoachCall.context, treeId: nil, steps: (try? told.member("trees").asArray().count) ?? 0) }
      let counts = told["counts"]
      let total = counts.flatMap { try? Int($0.member("total").asInteger()) } ?? ((try? told.member("steps").asArray().count) ?? 0)
      let done = counts.flatMap { try? Int($0.member("done").asInteger()) } ?? ((try? told.member("completed").asArray().count) ?? 0)
      return CoachCall(ability: CoachCall.context, treeId: about, steps: total, done: done)
    }
  }

  // Engine §5, the process ends: the turn its mark names, while this replica writes it, with the round the mark holds.
  func recover(_ input: TurnInput) async throws -> Recovery? {
    lastEnd = nil
    let marks = try runner.runAct(RecoverMark())
    let found: [RunningMark] = switch marks {
    case .committed(let marks, _), .unchanged(let marks): marks
    case .refused: []
    }
    guard let mark = found.first(where: { $0.message.description == input.turnId }) else { return nil }
    let replica = try runner.read(CoachMessage.scope) { $0.replica }
    guard let message = try runner.read(CoachMessage.scope, { try $0.repository(CoachMessage.self).find(mark.message, in: .drawn) }),
          message.isCoach, message.replica == replica, message.state == .running || message.state == .interrupted else { return nil }
    let lease = try leased(input)
    return Recovery(lease: lease, mark: Agent.Mark(turnId: input.turnId, callId: mark.callId, textBytesBeforeRound: mark.bytesBefore), text: message.text)
  }

  func leased(_ input: TurnInput) throws -> HostLease {
    let replica = try runner.read(CoachMessage.scope) { $0.replica }
    let lease = HostLease(turnId: input.turnId, seat: input.seat, generation: generation, replica: replica)
    try check(lease)
    return lease
  }

  // The engine's fence: a lease from before the seat changed, or under another seat or replica, writes nothing.
  func check(_ lease: HostLease) throws {
    guard lease.generation == generation, lease.seat == (try? seat()), lease.replica == (try runner.read(CoachMessage.scope) { $0.replica }) else {
      throw HostFailure.staleSeat
    }
  }

  // MARK: - The record

  func text(_ text: String, lease: HostLease) async throws {
    try check(lease)
    guard let writing else { return }
    let message = writing.opened.turn.coach
    writing.latest = text
    listener?.answering(message, text: text)
    if let at = writing.committedAt, at.duration(to: .now) < textEvery {
      guard writing.trailing == nil else { return }
      writing.trailing = Task { [weak self, textEvery] in
        try? await Task.sleep(for: textEvery - at.duration(to: .now))
        guard let self, !Task.isCancelled, let writing = self.writing, writing.opened.turn.coach == message else { return }
        writing.trailing = nil
        try? self.commit(text: writing.latest, of: writing, lease: lease)
      }
      return
    }
    try commit(text: text, of: writing, lease: lease)
  }

  func commit(text: String, of writing: Writing, lease: HostLease) throws {
    try check(lease)
    writing.committedAt = .now
    guard text != writing.committedText else { return }
    try run(StreamTurnText(writing.opened.turn.coach, text: text), lease: lease)
    writing.committedText = text
  }

  func beginRound(_ mark: Agent.Mark, text: String, lease: HostLease) async throws {
    try check(lease)
    guard let writing, let callId = mark.callId else { return }
    writing.trailing?.cancel(); writing.trailing = nil
    try run(BeginRound(writing.opened.turn.coach, callId: callId, text: text), lease: lease)
    writing.committedText = text
    writing.committedAt = .now
  }

  func end(_ end: TurnEnd, lease: HostLease) async throws {
    lastEnd = end
    let ended = writing
    writing?.trailing?.cancel()
    writing = nil
    try check(lease)
    let message = ended?.opened.turn.coach ?? ID(RecordID(lease.turnId))
    try run(RoadmapDomain.EndTurn(message, state: Self.state(end.state), text: end.text, truncated: end.truncated, refusal: end.code.map(Self.recorded),
                                  calls: ended?.calls, receipts: ended?.receipts), lease: lease)
  }

  func withdraw(lease: HostLease) async throws {
    let withdrawn = writing
    writing?.trailing?.cancel()
    writing = nil
    try check(lease)
    guard let turn = withdrawn?.opened.turn else { return }
    _ = try runner.runAct(WithdrawTurn(turn: turn))
  }

  // One act of the turn's records under its lease. A refusal of the turn's own record is no outcome of any call: gone, a
  // conversation deleted elsewhere took it, and its mark is let go of; final, its writer ended it already; anything else is
  // this phone's fault, which the engine reports once as `agent-host`.
  func run<A: ActAction>(_ act: A, lease: HostLease) throws where A.Refusal == RoadmapRefusal {
    try check(lease)
    switch try runner.runAct(act) {
    case .committed, .unchanged: return
    case .refused(.gone):
      _ = try runner.runAct(ForgetRunningTurn(ID(RecordID(lease.turnId))))
      throw HostFailure.recordGone
    case .refused(.other(let refused)) where refused.code.text == "turn-final": throw HostFailure.recordGone
    case .refused(let refusal): throw TurnRecordRefused(refusal: refusal)
    }
  }

  // The record's state of an engine's end, and a code in the registry's pattern of one: its underscores as hyphens.
  static func state(_ state: TurnEnd.State) -> CoachMessageState {
    switch state {
    case .completed: .completed
    case .declined: .declined
    case .failed: .failed
    case .stopped: .stopped
    case .interrupted: .interrupted
    }
  }

  static func recorded(_ code: String) -> String { code.replacingOccurrences(of: "_", with: "-") }

  // MARK: - The gate and the abilities

  func check(_ check: GateCheck, call: ToolCall, lease: HostLease) async throws -> String? {
    try self.check(lease)
    guard let ability = Catalog.roadmap.ability(named: call.name) else { return "not-offered" }
    switch check {
    case .seat: return nil
    case .shape: return JSONSchema(ability.input).fault(in: call.input) == nil ? nil : CoachRefusal.Code.invalidInput.rawValue
    case .product:
      guard ability.kind != .read, let about = writing?.opened.about, let named = try? call.input.member("treeId").asString() else { return nil }
      return named.utf8.elementsEqual(about.utf8) ? nil : CoachRefusal.Code.outOfScope.rawValue
    }
  }

  func execute(_ call: ToolCall, callId: String, lease: HostLease) async throws -> ToolOutcome {
    try check(lease)
    guard let writing else { throw HostFailure.recordGone }
    let (answer, receipt) = try writing.opened.tools.run(call.name, call.input)
    switch answer {
    case .failure(let refusal):
      writing.calls.append(Self.call(call, outcome: refusal.code.rawValue, answer: nil))
      return .refusal(refusal.code.rawValue)
    case .success(let result):
      writing.calls.append(Self.call(call, outcome: "ok", answer: result))
      if let receipt, writing.receipts.count < CoachWrite.cap {
        let facts = try CoachWrite.facts(of: call, receipt: receipt, over: runner)
        writing.receipts.append(facts)
        listener?.wrote(CoachWrite(message: writing.opened.turn.coach, index: writing.receipts.count - 1, receipt: receipt, facts: facts))
      }
      return .success(result.jcsText)
    }
  }

  // One call as the turn records it (§9): of a read, how many steps or rows it answered, of a roadmap's read that answered
  // each step's state how many are done, the steps it named and the fields it asked for; nothing of what it answered.
  static func call(_ call: ToolCall, outcome: String, answer: JSON?) -> CoachCall {
    let treeId = try? call.input.member("treeId").asString()
    let names = { (key: String) -> [String]? in try? call.input.member(key).asArray().map { try $0.asString() } }
    let answered = ["steps", "completed", "trees"].lazy.compactMap { answer?[$0].flatMap { try? $0.asArray().count } }.first
    let states = call.name == "get_tree" ? answer?["steps"].flatMap { try? $0.asArray().map { $0["state"].flatMap { try? $0.asString() } } } : nil
    let done = states.flatMap { $0.contains(nil) ? nil : $0.filter { $0 == StepState.complete.rawValue }.count }
    let nodeIds = names("nodeIds").map { Array($0.prefix(CoachCall.nodeIdCap)) }
    return CoachCall(ability: call.name, treeId: treeId, outcome: outcome, steps: answered, done: done, nodeIds: nodeIds, fields: names("fields"))
  }
}

// A refusal of a turn's own record that is neither its record gone nor its turn ended: a fault of this phone's turn.
struct TurnRecordRefused: Error {
  let refusal: RoadmapRefusal
}

// One direct write of a turn, as the room offers its Undo and its conversation shows its receipt: Coach's message, the
// receipt's place among the message's receipts, the tool host's receipt that undoes it, and its facts.
struct CoachWrite: Equatable {
  // A message keeps at most `MAX_WRITES` receipts, the indexes a write fate can name.
  static let cap = 6

  let message: ID<CoachMessage>
  let index: Int
  let receipt: WriteReceipt
  let facts: CoachReceipt

  // D-4: the facts of a write that landed, read over the copy as the write left it: the step's label, and what changed.
  static func facts(of call: ToolCall, receipt: WriteReceipt, over runner: ActionRunner) throws -> CoachReceipt {
    let tree = ID<RoadmapEntry>(RecordID(receipt.treeId)).tree
    let labels = try runner.read(tree) { read -> [String: String] in
      Dictionary(try read.repository(RoadmapStep.self).all(in: .drawn).map { ($0.id.description, $0.label) }) { first, _ in first }
    }
    let label = { (id: String) in labels[id] ?? "" }
    let input = call.input
    let texts = { (key: String) -> [String] in (try? input.member(key).asArray().map { try $0.asString() }) ?? [] }
    let at = { (change: CoachReceipt.Change, fields: [String], items: [String], prerequisites: [String]) in
      CoachReceipt(ability: receipt.ability, treeId: receipt.treeId, nodeId: receipt.nodeId, label: label(receipt.nodeId), change: change,
                   fields: fields, items: items, prerequisites: prerequisites)
    }
    switch receipt.ability {
    case "set_progress":
      return at((try? input.member("status").asString()) == "complete" ? .completed : .reset, [], [], [])
    case "create_node": return at(.created, [], [], texts("prerequisites").map(label))
    case "connect": return at(.linked, [], [], [(try? input.member("prerequisiteId").asString()).map(label) ?? ""])
    default:
      let fields = ["description", "label", "links"].filter { input[$0] != nil }
      return at(.changed, fields, texts("subtasks"), [])
    }
  }
}

// The engine's telemetry port and the AI client's diagnostics on the room's telemetry (§13): an event for each call and each
// turn, with no word of the person's or the model's, and each failure under its static name.
@MainActor final class CoachTelemetry: Agent.Telemetry, AiDiagnostics {
  let telemetry: any EventTelemetry
  let truncated: @MainActor () -> Bool

  init(telemetry: any EventTelemetry, truncated: @escaping @MainActor () -> Bool) {
    self.telemetry = telemetry; self.truncated = truncated
  }

  func hostFailure() { telemetry.failure("agent-host", kind: "host") }

  func failure(operation: String, kind: String) { telemetry.failure(operation, kind: kind) }

  func ability(name: String, code: String?) {
    telemetry.event("roadmap_coach_ability", properties: ["name": name, "outcome": code ?? "ok"])
  }

  func turn(state: TurnEnd.State, seat: Agent.Seat.Kind, code: String?, rounds: Int, abilityCalls: Int, refusals: Int, answerBytes: Int, durationMs: Int64) {
    var properties = ["state": state.rawValue, "seat": seat.rawValue, "truncated": String(truncated()), "ability_calls": String(abilityCalls),
                      "refusals": String(refusals), "answer_bytes": String(answerBytes)]
    if let code { properties["code"] = code }
    telemetry.event("roadmap_coach_turn", properties: properties, durationMs: durationMs)
  }
}
