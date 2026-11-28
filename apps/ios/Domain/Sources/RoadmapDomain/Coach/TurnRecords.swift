import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// What a Coach turn writes and reads in the person's `self/roadmap` beyond its opening, end and withdrawal (roadmap-coach.md
// §8, §9; Coach engine §5): the facts a turn records of its calls and direct writes, a round's mark, the answer's text as it
// streams, the marks read back and let go of, a turn nobody ends, what became of a receipt's write, a conversation's delete
// and History, the one list of every conversation.

// Engine §11: a running Coach message no write has reached for this long, by the server's clock, is ended by any device.
public let turnStaleMs: Int64 = 1_800_000

// One call a turn made, as its Coach message records it (§9, INV-5): the ability, or `context` for what the turn was told
// before it asked anything; the roadmap it read or wrote; `ok` or the refusal code; and of a read, how many steps it
// answered and how many of them were done, the steps it named by id (at most 50) and the fields it asked for. Nothing of
// what it answered.
public struct CoachCall: Sendable, Equatable {
  public static let context = "context"
  public static let nodeIdCap = 50

  public let ability: String
  public let treeId: String?
  public let outcome: String
  public let steps: Int?
  public let done: Int?
  public let nodeIds: [String]?
  public let fields: [String]?

  public init(ability: String, treeId: String?, outcome: String = "ok", steps: Int? = nil, done: Int? = nil, nodeIds: [String]? = nil,
              fields: [String]? = nil) {
    precondition((nodeIds?.count ?? 0) <= Self.nodeIdCap, "a call records at most 50 steps by id")
    self.ability = ability
    self.treeId = treeId
    self.outcome = outcome
    self.steps = steps
    self.done = done
    self.nodeIds = nodeIds
    self.fields = fields
  }

  public init(json: JSON) throws {
    let given = { (key: String) -> JSON? in json[key].flatMap { $0.isNull ? nil : $0 } }
    self.init(ability: try json.member("ability").asString(), treeId: try given("treeId")?.asString(), outcome: try given("outcome")?.asString() ?? "ok",
              steps: try given("steps").map { Int(try $0.asInteger()) }, done: try given("done").map { Int(try $0.asInteger()) },
              nodeIds: try given("nodeIds").map { try $0.asArray().map { try $0.asString() } },
              fields: try given("fields").map { try $0.asArray().map { try $0.asString() } })
  }

  public var json: JSON {
    var object: [String: JSON?] = ["ability": .string(ability), "treeId": .some(treeId.map(JSON.string) ?? .null), "outcome": .string(outcome)]
    object["steps"] = steps.map { JSON($0) }
    object["done"] = done.map { JSON($0) }
    object["nodeIds"] = nodeIds.map { .array($0.map(JSON.string)) }
    object["fields"] = fields.map { .array($0.map(JSON.string)) }
    return .object(JSON.Object(uniqueKeysWithValues: object.compactMapValues { $0 }.map { ($0.key, $0.value) }))
  }
}

// D-4: one direct write as its Coach message records it, a fact and never a sentence: the ability, the roadmap and step it
// wrote, the step's label as it stood after the write, and what changed: a mark set or reset; the fields of the step changed
// (`label`, `description`, `links`) with the words of each item added to its checklist; a new step with the labels of the
// steps it follows; or a link, with the label of the step now followed.
public struct CoachReceipt: Sendable, Equatable {
  public enum Change: String, Sendable {
    case completed, reset, changed, created, linked
  }

  public let ability: String
  public let treeId: String
  public let nodeId: String
  public let label: String
  public let change: Change
  public let fields: [String]
  public let items: [String]
  public let prerequisites: [String]

  public init(ability: String, treeId: String, nodeId: String, label: String, change: Change, fields: [String] = [], items: [String] = [],
              prerequisites: [String] = []) {
    self.ability = ability
    self.treeId = treeId
    self.nodeId = nodeId
    self.label = label
    self.change = change
    self.fields = fields
    self.items = items
    self.prerequisites = prerequisites
  }

  public init(json: JSON) throws {
    let strings = { (key: String) throws -> [String] in try json[key].map { try $0.asArray().map { try $0.asString() } } ?? [] }
    guard let change = Change(rawValue: try json.member("change").asString()) else { throw JSONError.shape("a receipt's change") }
    self.init(ability: try json.member("ability").asString(), treeId: try json.member("treeId").asString(), nodeId: try json.member("nodeId").asString(),
              label: try json.member("label").asString(), change: change, fields: try strings("fields"), items: try strings("items"),
              prerequisites: try strings("prerequisites"))
  }

  public var json: JSON {
    var object: [String: JSON] = ["ability": .string(ability), "treeId": .string(treeId), "nodeId": .string(nodeId), "label": .string(label),
                                  "change": .string(change.rawValue)]
    if !fields.isEmpty { object["fields"] = .array(fields.map(JSON.string)) }
    if !items.isEmpty { object["items"] = .array(items.map(JSON.string)) }
    if !prerequisites.isEmpty { object["prerequisites"] = .array(prerequisites.map(JSON.string)) }
    return .object(JSON.Object(uniqueKeysWithValues: object.map { ($0.key, $0.value) }))
  }
}

// A receipt as Coach's message holds it: read, or written in a shape this build does not read, kept as it was written so
// it keeps its place among the message's receipts, the index a write fate names; a receipt not read is drawn as nothing.
public enum HeldReceipt: Sendable, Equatable {
  case read(CoachReceipt)
  case unreadable(JSON)

  public init(json: JSON) {
    self = (try? CoachReceipt(json: json)).map(HeldReceipt.read) ?? .unreadable(json)
  }

  public var receipt: CoachReceipt? {
    guard case .read(let receipt) = self else { return nil }
    return receipt
  }

  public var json: JSON {
    switch self {
    case .read(let receipt): receipt.json
    case .unreadable(let json): json
    }
  }
}

// A turn's mark as this device holds it: the Coach message the turn writes and the round in flight, `callId` nil before the
// first. A row in any other shape is no mark.
public struct RunningMark: Sendable, Equatable {
  public let message: ID<CoachMessage>
  public let callId: String?
  public let bytesBefore: Int

  public init(message: ID<CoachMessage>, callId: String?, bytesBefore: Int) {
    self.message = message
    self.callId = callId
    self.bytesBefore = bytesBefore
  }

  public var json: JSON {
    ["message": message.json, "callId": callId.map(JSON.string) ?? .null, "bytesBefore": JSON(bytesBefore)]
  }

  // The mark a `runningTurn:` row holds, or nil for a row that is no mark.
  init?(key: String, value: JSON) {
    guard case .object(let row) = value, Set(row.keys) == ["callId", "bytesBefore"],
          let bytes = try? row.member("bytesBefore").asInteger(), bytes >= 0 else { return nil }
    let call = row["callId"]
    if call?.isNull == true { callId = nil }
    else if let text = try? call?.asString(), Self.isCallID(text) { callId = text }
    else { return nil }
    message = ID(RecordID(String(key.dropFirst(TurnMark.prefix.count))))
    bytesBefore = Int(bytes)
  }

  // A round's call id: 22 characters of unpadded base64url (Coach engine §4.2).
  public static func isCallID(_ id: String) -> Bool {
    id.utf8.count == 22 && id.utf8.allSatisfy(CoachPicture.idCharacter)
  }
}

extension TurnMark {
  static let prefix = "runningTurn:"
}

extension CoachMessage {
  // Coach's message while its writer has not ended it: this replica's, and running, or `interrupted` by another device while
  // this device's mark names it.
  func writersOwn(replica: String, marked: Bool) -> Bool {
    guard isCoach, self.replica == replica else { return false }
    return state == .running || (state == .interrupted && marked)
  }
}

// A write to a turn its writer can no longer make: another replica's, or ended.
func turnFinal<Result>(_ message: ID<CoachMessage>) -> ActDecision<Result, RoadmapRefusal> {
  .refuse(.other(Refused("turn-final", subject: message.ref, path: .predicted)))
}

// Coach engine §5 step 3.2: a round begins, in one write: the text so far on Coach's message and the round's call and the bytes
// of text before it on the turn's mark.
public struct BeginRound: ActAction {
  public let message: ID<CoachMessage>
  public let callId: String
  public let text: String

  public init(_ message: ID<CoachMessage>, callId: String, text: String) {
    precondition(RunningMark.isCallID(callId), "a round is named by a call id of 22 characters")
    self.message = message
    self.callId = callId
    self.text = text
  }

  public func load(_ read: ActReader) throws -> (message: CoachMessage?, mark: JSON?, replica: String, moment: Moment) {
    try read.inScope(Roadmap.scope) { account in
      (try account.repository(CoachMessage.self).find(message, in: .drawn), try account.device(TurnMark.key(message)), account.replica, account.moment)
    }
  }

  public func decide(_ loaded: (message: CoachMessage?, mark: JSON?, replica: String, moment: Moment), ids: ActIDSource) throws(Violation)
    -> ActDecision<Void, RoadmapRefusal> {
    guard var running = loaded.message, running.isCoach else { return .refuse(.gone(message.ref, .predicted)) }
    guard let mark = loaded.mark, running.writersOwn(replica: loaded.replica, marked: true) else { return turnFinal(message) }
    let row: JSON = ["callId": .string(callId), "bytesBefore": JSON(text.utf8.count)]
    let sameRow = mark == row
    if sameRow && running.text == text { return .unchanged(()) }
    var plan = Plan()
    if running.text != text {
      running.text = text
      plan.update(try Valid(running, fields: ["text"], at: loaded.moment), fields: ["text"])
    }
    if !sameRow { plan.device(TurnMark.key(message), row) }
    return .write(plan, in: Roadmap.scope, ())
  }
}

// §8: the answer's text so far on Coach's message, while its writer has not ended the turn; a turn ended, or another
// replica's, takes nothing.
public struct StreamTurnText: ActAction {
  public let message: ID<CoachMessage>
  public let text: String

  public init(_ message: ID<CoachMessage>, text: String) {
    self.message = message
    self.text = text
  }

  public func load(_ read: ActReader) throws -> (message: CoachMessage?, marked: Bool, replica: String, moment: Moment) {
    try read.inScope(Roadmap.scope) { account in
      (try account.repository(CoachMessage.self).find(message, in: .drawn), try account.device(TurnMark.key(message)) != nil, account.replica, account.moment)
    }
  }

  public func decide(_ loaded: (message: CoachMessage?, marked: Bool, replica: String, moment: Moment), ids: ActIDSource) throws(Violation)
    -> ActDecision<Void, RoadmapRefusal> {
    guard var streaming = loaded.message, streaming.isCoach else { return .refuse(.gone(message.ref, .predicted)) }
    guard streaming.writersOwn(replica: loaded.replica, marked: loaded.marked), streaming.text != text else { return .unchanged(()) }
    streaming.text = text
    var plan = Plan()
    plan.update(try Valid(streaming, fields: ["text"], at: loaded.moment), fields: ["text"])
    return .write(plan, in: Roadmap.scope, ())
  }
}

// Coach engine §5, the process ends: every turn this device marks, in message id order, read back as its writer resumes it;
// a row that is no mark is let go of in the same write.
public struct RecoverMark: ActAction {
  public init() {}

  public func load(_ read: ActReader) throws -> JSON.Object {
    try read.inScope(Roadmap.scope) { account in try account.devices(prefix: TurnMark.prefix) }
  }

  public func decide(_ rows: JSON.Object, ids: ActIDSource) -> ActDecision<[RunningMark], RoadmapRefusal> {
    let keys = rows.members.map(\.key).sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
    var marks: [RunningMark] = []
    var plan = Plan()
    var malformed = false
    for key in keys {
      if let mark = rows[key].flatMap({ RunningMark(key: key, value: $0) }) { marks.append(mark); continue }
      plan.device(key, nil)
      malformed = true
    }
    return malformed ? .write(plan, in: Roadmap.scope, marks) : .unchanged(marks)
  }
}

// A turn whose message is gone, as a conversation deleted on another device takes it: its mark is let go of.
public struct ForgetRunningTurn: ActAction {
  public let message: ID<CoachMessage>

  public init(_ message: ID<CoachMessage>) {
    self.message = message
  }

  public func load(_ read: ActReader) throws -> Bool {
    try read.inScope(Roadmap.scope) { account in try account.device(TurnMark.key(message)) != nil }
  }

  public func decide(_ marked: Bool, ids: ActIDSource) -> ActDecision<Void, RoadmapRefusal> {
    guard marked else { return .unchanged(()) }
    var plan = Plan()
    plan.device(TurnMark.key(message), nil)
    return .write(plan, in: Roadmap.scope, ())
  }
}

// Coach engine §5, a turn nobody ends (R-5): a running Coach message that no write has reached for `TURN_STALE`, by the
// server's time of its last change and `serverNow`, the server's clock as this device's live sync connection measures it,
// takes `interrupted` and nothing else. A turn this device marks is its own to end. It answers whether it ended the turn.
public struct InterruptStaleTurn: ActAction {
  public let message: ID<CoachMessage>
  public let serverNow: Int64

  public init(_ message: ID<CoachMessage>, serverNow: Int64) {
    self.message = message
    self.serverNow = serverNow
  }

  public func load(_ read: ActReader) throws -> (message: CoachMessage?, marked: Bool, changedAt: Int64?, moment: Moment) {
    try read.inScope(Roadmap.scope) { account in
      (try account.repository(CoachMessage.self).find(message, in: .drawn), try account.device(TurnMark.key(message)) != nil,
       try account.confirmed(CoachMessage.self, message)?.ru, account.moment)
    }
  }

  public func decide(_ loaded: (message: CoachMessage?, marked: Bool, changedAt: Int64?, moment: Moment), ids: ActIDSource) throws(Violation)
    -> ActDecision<Bool, RoadmapRefusal> {
    guard var running = loaded.message, running.isCoach, running.state == .running, !loaded.marked, let changedAt = loaded.changedAt,
          serverNow - changedAt >= turnStaleMs else { return .unchanged(false) }
    running.state = .interrupted
    var plan = Plan()
    plan.update(try Valid(running, fields: ["state"], at: loaded.moment), fields: ["state"])
    return .write(plan, in: Roadmap.scope, true)
  }
}

extension CoachWriteFate: Writable {
  public init(id: ID<CoachWriteFate>, messageId: ID<CoachMessage>, receipt: Int, fate: String, code: String?) {
    self.id = id
    self.messageId = messageId
    self.receipt = receipt
    self.fate = fate
    self.code = code
  }

  public var fields: [String: JSON] {
    ["messageId": messageId.json, "receipt": JSON(receipt), "fate": .string(fate), "code": code.map(JSON.string) ?? .null]
  }

  public static let checks: [Check<CoachWriteFate>] = []
}

// §6: what became of one receipt's write after its turn ended, so its receipt reads so on every device: undone, or refused by
// the server with its code. A receipt keeps one fate; the same one asked again is unchanged, and a message with no such
// receipt, past its receipts or outside the registry's 0…5, is gone. It answers the fate's id.
public struct RecordWriteFate: ActAction {
  public enum Fate: String, Sendable {
    case undone, refused
  }

  // The receipts a message can hold, one for each direct write a turn may make.
  public static let receipts = 0...5

  public let message: ID<CoachMessage>
  public let receipt: Int
  public let fate: Fate
  public let code: String?

  public init(_ message: ID<CoachMessage>, receipt: Int, fate: Fate, code: String? = nil) {
    self.message = message
    self.receipt = receipt
    self.fate = fate
    self.code = code
  }

  public func load(_ read: ActReader) throws -> (message: CoachMessage?, fates: [CoachWriteFate], moment: Moment) {
    try read.inScope(Roadmap.scope) { account in
      let found = try account.repository(CoachMessage.self).find(message, in: .drawn)
      return (found, found == nil ? [] : try account.repository(CoachWriteFate.self).children(of: message, via: "messageId", in: .drawn), account.moment)
    }
  }

  public func decide(_ loaded: (message: CoachMessage?, fates: [CoachWriteFate], moment: Moment), ids: ActIDSource) throws(Violation)
    -> ActDecision<ID<CoachWriteFate>, RoadmapRefusal> {
    guard let written = loaded.message, written.isCoach, RecordWriteFate.receipts.contains(receipt), receipt < (written.receipts?.count ?? 0) else {
      return .refuse(.gone(message.ref, .predicted))
    }
    if let kept = loaded.fates.filter({ $0.receipt == receipt }).min(by: { $0.id < $1.id }) { return .unchanged(kept.id) }
    let id = ids.mint(CoachWriteFate.self)
    var plan = Plan()
    plan.create(try Valid(CoachWriteFate(id: id, messageId: message, receipt: receipt, fate: fate.rawValue, code: code), at: loaded.moment))
    return .write(plan, in: Roadmap.scope, id)
  }
}

// History's delete (board 11.7): a conversation and the proposals it minted go in one held write; its messages and their write
// fates are the server's consequence of the conversation's removal (engine A.1).
public struct DeleteConversation: ActAction {
  public let thread: ID<CoachThread>

  public init(_ thread: ID<CoachThread>) {
    self.thread = thread
  }

  public func load(_ read: ActReader) throws -> (thread: CoachThread?, proposals: [CoachProposal]) {
    try read.inScope(Roadmap.scope) { account in
      (try account.repository(CoachThread.self).find(thread, in: .drawn),
       try account.repository(CoachProposal.self).all(in: .drawn).filter { $0.threadId == thread })
    }
  }

  public func decide(_ loaded: (thread: CoachThread?, proposals: [CoachProposal]), ids: ActIDSource) -> ActDecision<Void, RoadmapRefusal> {
    guard loaded.thread != nil else { return .refuse(.gone(thread.ref, .predicted)) }
    var plan = Plan()
    plan.remove(thread)
    for proposal in loaded.proposals.sorted(by: { $0.id < $1.id }) { plan.remove(proposal.id) }
    return .write(plan, in: Roadmap.scope, ())
  }
}

// §9, board 11.7: every conversation the device draws, those about `current` first and then the rest, each newest first by
// the moment of its latest message, then by id; a conversation with no message last. Each row carries what it is about, its
// title, that moment, and the proposal it minted last, by birth, with its count of changes and its state.
public struct CoachHistory: Sendable, Equatable {
  public struct Row: Sendable, Equatable, Identifiable {
    public struct Proposal: Sendable, Equatable {
      public let id: ID<CoachProposal>
      public let changes: Int
      public let state: CoachProposalState
      public let undone: Bool
    }

    public let thread: CoachThread
    public let at: Instant?
    public let proposal: Proposal?

    public var id: ID<CoachThread> { thread.id }
  }

  public let current: [Row]
  public let other: [Row]

  public static func read(_ read: Reader, current: String?) throws -> CoachHistory {
    let messages = try read.repository(CoachMessage.self).all(in: .drawn)
    let proposals = read.repository(CoachProposal.self)
    var latest: [ID<CoachThread>: Instant] = [:]
    for message in messages { latest[message.threadId] = max(latest[message.threadId] ?? message.at, message.at) }
    var minted: [ID<CoachThread>: (proposal: CoachProposal, born: Stamp)] = [:]
    for proposal in try proposals.all(in: .drawn) {
      let born = try proposals.record(proposal.id, in: .drawn)?.born ?? .unset
      guard let held = minted[proposal.threadId] else { minted[proposal.threadId] = (proposal, born); continue }
      if born > held.born || (born == held.born && held.proposal.id < proposal.id) { minted[proposal.threadId] = (proposal, born) }
    }
    let rows = try read.repository(CoachThread.self).all(in: .drawn).map { thread in
      Row(thread: thread, at: latest[thread.id], proposal: minted[thread.id].map {
        Row.Proposal(id: $0.proposal.id, changes: $0.proposal.changes.count, state: $0.proposal.state, undone: $0.proposal.undone)
      })
    }.sorted { a, b in
      switch (a.at, b.at) {
      case (let x?, let y?) where x != y: return x > y
      case (.some, nil): return true
      case (nil, .some): return false
      default: return a.thread.id.record.description.utf8.lexicographicallyPrecedes(b.thread.id.record.description.utf8)
      }
    }
    let about = { (row: Row) in current.map { row.thread.treeId == $0 } ?? false }
    return CoachHistory(current: rows.filter(about), other: rows.filter { !about($0) })
  }
}
