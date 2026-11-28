import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// Roadmap Coach's records (roadmap-coach.md §9), kept in the person's `self/roadmap`: a conversation, its messages, the
// proposals and write fates they carry; the read of one conversation and of a roadmap's pending proposal; what a turn writes
// as it opens, ends, or is withdrawn before it began (§8); and a proposal minted (§7). A removal of any of them is held, as
// a roadmap's is, so one held delete can carry both.

// The states of a Coach message, in the registry's rank: a terminal state beats running, and a writer's terminal state
// beats another device's interrupted.
public enum CoachMessageState: String, Sendable, CaseIterable, Equatable {
  case running, interrupted, completed, declined, failed, stopped

  public var isTerminal: Bool { self != .running }
  public var isWritersTerminal: Bool { self != .running && self != .interrupted }
}

// One conversation: what it is about, a roadmap or every roadmap (`treeId` nil), the step it started from, and its title.
public struct CoachThread: ProductEntity, Writable, Removable, Equatable {
  public static let type = Roadmap.Types.coachThread
  public static let scope = Roadmap.scope
  public static let heldRemoval = true

  public let id: ID<CoachThread>
  public let treeId: String?
  public var stepId: String?
  public var title: String

  public init(id: ID<CoachThread>, treeId: String?, stepId: String? = nil, title: String) {
    self.id = id
    self.treeId = treeId
    self.stepId = stepId
    self.title = title
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), treeId: try r.optionalString("treeId"), stepId: try r.optionalString("stepId"), title: try r.string("title", default: ""))
  }

  public var fields: [String: JSON] {
    ["treeId": treeId.map { .string($0) } ?? .null, "stepId": stepId.map { .string($0) } ?? .null, "title": .string(title)]
  }

  public static let checks: [Check<CoachThread>] = [
    Check("treeId") { t, _ in
      guard let treeId = try RoadmapSpecs.coachTreeId.apply(t.treeId, at: "treeId") else { return }
      if !CoachThread.isTreeId(treeId) { throw Violation(rule: RoadmapSpecs.coachTreeId.path, path: "treeId", reason: .custom("notATreeId")) }
    },
    Check("stepId") { t, _ in t.stepId = try RoadmapSpecs.coachStep.apply(t.stepId, at: "stepId") },
    Check("title") { t, _ in t.title = try RoadmapSpecs.coachTitle.apply(t.title, at: "title") },
  ]

  // The registry's pattern for a roadmap's id, `^t_[0-9a-f]{16}$`, once its length is checked.
  static func isTreeId(_ id: String) -> Bool {
    let bytes = Array(id.utf8)
    return bytes.count == 18 && bytes[0] == 0x74 && bytes[1] == 0x5F
      && bytes.dropFirst(2).allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
  }
}

// A picture on a message: its id on the device that sent it while `localOnly`.
public struct CoachPicture: ValueObject, Equatable {
  public let id: String
  public let mediaType: String
  public let localOnly: Bool

  public init(id: String, mediaType: String, localOnly: Bool = false) {
    self.id = id
    self.mediaType = mediaType
    self.localOnly = localOnly
  }

  public init(_ f: Fields) throws(DecodeError) {
    self.init(id: try f.string("id"), mediaType: try f.string("mediaType"), localOnly: try f.bool("localOnly", default: false))
  }

  // The device row that keeps a picture's original on the device that sent it.
  public static func rowKey(_ id: String) -> String { "picture:" + id }

  public var json: JSON {
    .object(omittingNil: ["id": .string(id), "mediaType": .string(mediaType), "localOnly": localOnly ? true : nil])
  }

  public func validated(at path: Path) throws(Violation) -> CoachPicture {
    let id = try RoadmapSpecs.coachPictureId.apply(id, at: path + "id")
    guard id.utf8.allSatisfy(CoachPicture.idCharacter) else {
      throw Violation(rule: RoadmapSpecs.coachPictureId.path, path: path + "id", reason: .custom("notAnId"))
    }
    return CoachPicture(id: id, mediaType: try RoadmapSpecs.coachMediaType.apply(mediaType, at: path + "mediaType"), localOnly: localOnly)
  }

  // The registry's pattern for a minted id, `[A-Za-z0-9_-]`, a picture's and a proposal's among them, which a picture's device
  // row's key repeats.
  static func idCharacter(_ byte: UInt8) -> Bool {
    (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte) || byte == 0x5F || byte == 0x2D
  }
}

// One message: the person's question, or Coach's answer with the state of its turn, `truncated`, the code a turn that could
// not answer ended with, the proposal it minted (§7; a message about all roadmaps may mint more than one, and names the
// last, so a message's proposals are read by their `messageId`), and the calls and receipts its turn recorded as it ended
// (`TurnRecords.swift`), as facts, nil until then, each receipt in its place even where this build does not read it.
public struct CoachMessage: ProductEntity, Writable, Removable, Equatable {
  public static let type = Roadmap.Types.coachMessage
  public static let scope = Roadmap.scope
  public static let heldRemoval = true

  public let id: ID<CoachMessage>
  public let threadId: ID<CoachThread>
  public let role: String
  public let replica: String?
  public var text: String
  public var state: CoachMessageState
  public var truncated: Bool
  public var refusal: String?
  public var proposalId: ID<CoachProposal>?
  public var pictures: [CoachPicture]
  public let at: Instant
  public var calls: [CoachCall]?
  public var receipts: [HeldReceipt]?

  public init(id: ID<CoachMessage>, threadId: ID<CoachThread>, role: String, replica: String? = nil, text: String = "",
              state: CoachMessageState = .running, truncated: Bool = false, refusal: String? = nil, proposalId: ID<CoachProposal>? = nil,
              pictures: [CoachPicture] = [], at: Instant, calls: [CoachCall]? = nil, receipts: [HeldReceipt]? = nil) {
    self.id = id
    self.threadId = threadId
    self.role = role
    self.replica = replica
    self.text = text
    self.state = state
    self.truncated = truncated
    self.refusal = refusal
    self.proposalId = proposalId
    self.pictures = pictures
    self.at = at
    self.calls = calls
    self.receipts = receipts
  }

  public init(_ r: Fields) throws(DecodeError) {
    let state = CoachMessageState(rawValue: try r.string("state", default: CoachMessageState.running.rawValue)) ?? .running
    let listed = { (field: String) -> [JSON]? in if case .array(let items)? = r.json(field) { items } else { nil } }
    self.init(id: ID(r.id), threadId: try r.ref("threadId", CoachThread.self), role: try r.string("role"), replica: try r.optionalString("replica"),
              text: try r.string("text", default: ""), state: state, truncated: try r.bool("truncated", default: false),
              refusal: try r.optionalString("refusal"), proposalId: try r.optionalRef("proposalId", CoachProposal.self),
              pictures: try r.optionalList("pictures", of: CoachPicture.self) ?? [], at: try r.instant("at"),
              calls: listed("calls")?.compactMap { try? CoachCall(json: $0) }, receipts: listed("receipts")?.map(HeldReceipt.init(json:)))
  }

  public var isCoach: Bool { role == "coach" }

  // A person's message carries its conversation, role, text, pictures and moment only; Coach's names a proposal once it has
  // minted one.
  public var fields: [String: JSON] {
    var fields: [String: JSON?] = ["threadId": threadId.json, "role": .string(role), "at": .of(at), "text": .string(text),
                                   "pictures": pictures.isEmpty ? nil : .array(pictures.map(\.json))]
    if isCoach {
      fields["replica"] = replica.map { .string($0) }
      fields["state"] = .string(state.rawValue)
      fields["truncated"] = .bool(truncated)
      fields["refusal"] = .some(refusal.map { .string($0) } ?? .null)
      fields["proposalId"] = proposalId.map(\.json)
      fields["calls"] = calls.map { .array($0.map(\.json)) }
      fields["receipts"] = receipts.map { .array($0.map(\.json)) }
    }
    return fields.compactMapValues { $0 }
  }

  public static let checks: [Check<CoachMessage>] = [
    Check("role") { m, _ in _ = try RoadmapSpecs.coachRole.apply(m.role, at: "role") },
    Check("replica") { m, _ in _ = try RoadmapSpecs.coachReplica.apply(m.replica, at: "replica") },
    Check("text") { m, _ in m.text = try RoadmapSpecs.coachText.apply(m.text, at: "text") },
    Check("refusal") { m, _ in
      guard let refusal = try RoadmapSpecs.coachRefusal.apply(m.refusal, at: "refusal") else { return }
      if !CoachMessage.isCode(refusal) { throw Violation(rule: RoadmapSpecs.coachRefusal.path, path: "refusal", reason: .custom("notACode")) }
    },
    Check("proposalId") { m, _ in
      guard let id = try RoadmapSpecs.coachProposalId.apply(m.proposalId?.record.description, at: "proposalId") else { return }
      if !id.utf8.allSatisfy(CoachPicture.idCharacter) { throw Violation(rule: RoadmapSpecs.coachProposalId.path, path: "proposalId", reason: .custom("notAnId")) }
    },
    Check("pictures") { m, _ in m.pictures = try RoadmapSpecs.coachPictures.apply(m.pictures, at: "pictures") },
  ]

  // The registry's pattern for a refusal code, `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`: lower-case words of letters and digits,
  // the first starting with a letter, joined by single hyphens.
  static func isCode(_ code: String) -> Bool {
    let words = code.split(separator: "-", omittingEmptySubsequences: false)
    let lowerOrDigit = { (byte: UInt8) in (0x61...0x7A).contains(byte) || (0x30...0x39).contains(byte) }
    guard let first = words.first?.utf8.first, (0x61...0x7A).contains(first) else { return false }
    return words.allSatisfy { !$0.isEmpty && $0.utf8.allSatisfy(lowerOrDigit) }
  }
}

// The states of a proposal (§7), in the registry's rank: each of the four outranks `pending`, and `applied` the other three.
public enum CoachProposalState: String, Sendable, CaseIterable, Equatable {
  case pending, applied, rejected, stale, replaced
}

// A proposal (§7): the roadmap it changes, none where its record names none; the conversation and Coach's message that
// minted it; its changes, each new step and kind under its id; its base, the copy's stamp of every register they touch; its
// state, `pending` and then one of the four it never leaves; and whether the person undid it once applied. `undone` is the
// registry's first writer's, so only its Undo writes it, and nothing writes it while it is false.
public struct CoachProposal: ProductEntity, Writable, Removable, Equatable {
  public static let type = Roadmap.Types.coachProposal
  public static let scope = Roadmap.scope
  public static let heldRemoval = true

  public let id: ID<CoachProposal>
  public let treeId: String?
  public let threadId: ID<CoachThread>
  public let messageId: ID<CoachMessage>
  public let changes: [JSON]
  public let base: [JSON]
  public var state: CoachProposalState
  public var undone: Bool

  public init(id: ID<CoachProposal>, treeId: String?, threadId: ID<CoachThread>, messageId: ID<CoachMessage>, changes: [JSON] = [], base: [JSON] = [],
              state: CoachProposalState = .pending, undone: Bool = false) {
    self.id = id
    self.treeId = treeId
    self.threadId = threadId
    self.messageId = messageId
    self.changes = changes
    self.base = base
    self.state = state
    self.undone = undone
  }

  public init(_ r: Fields) throws(DecodeError) {
    let listed = { (value: JSON?) -> [JSON] in if case .array(let items)? = value { items } else { [] } }
    self.init(id: ID(r.id), treeId: try r.optionalString("treeId"), threadId: try r.ref("threadId", CoachThread.self),
              messageId: try r.ref("messageId", CoachMessage.self), changes: listed(r.json("changes")), base: listed(r.json("base")),
              state: CoachProposalState(rawValue: try r.string("state", default: CoachProposalState.pending.rawValue)) ?? .pending,
              undone: try r.bool("undone", default: false))
  }

  public var fields: [String: JSON] {
    var fields: [String: JSON] = ["treeId": treeId.map { .string($0) } ?? .null, "threadId": threadId.json, "messageId": messageId.json,
                                  "changes": .array(changes), "base": .array(base), "state": .string(state.rawValue)]
    if undone { fields["undone"] = .bool(true) }
    return fields
  }

  public static let checks: [Check<CoachProposal>] = [
    Check("changes") { p, _ in _ = try RoadmapSpecs.coachProposalChanges.apply(p.changes, at: "changes") },
  ]

  // §7 The pending proposal about a roadmap, as the device draws its proposals: the latest born of those pending, by birth
  // and then id, so where two devices each minted one before they synced the later stands; none where none is pending. An
  // earlier pending one reads as replaced, which the next proposal minted about the roadmap writes, or an Apply or a Reject of it.
  public static func pending(about treeId: String, in read: Reader) throws -> CoachProposal? {
    let proposals = read.repository(CoachProposal.self)
    var latest: (proposal: CoachProposal, born: Stamp)?
    for proposal in try proposals.all(in: .drawn) where proposal.state == .pending && proposal.treeId.map({ $0.utf8.elementsEqual(treeId.utf8) }) == true {
      let born = try proposals.record(proposal.id, in: .drawn)?.born ?? .unset
      guard let held = latest else { latest = (proposal, born); continue }
      if born > held.born || (born == held.born && held.proposal.id < proposal.id) { latest = (proposal, born) }
    }
    return latest?.proposal
  }
}

// What became of one receipt's write after its turn ended (§6): undone, or refused by the server with its code, written by
// `RecordWriteFate` (`TurnRecords.swift`).
public struct CoachWriteFate: ProductEntity, Removable, Equatable {
  public static let type = Roadmap.Types.coachWriteFate
  public static let scope = Roadmap.scope
  public static let heldRemoval = true

  public let id: ID<CoachWriteFate>
  public let messageId: ID<CoachMessage>
  public let receipt: Int
  public let fate: String
  public let code: String?

  public init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    messageId = try r.ref("messageId", CoachMessage.self)
    receipt = try r.int("receipt")
    fate = try r.string("fate")
    code = try r.optionalString("code")
  }
}

// One conversation as the device draws it: none once the conversation is gone, its own delete still held included, so a
// removed conversation shows no message and no write fate before the server's consequences arrive.
public struct Conversation: Sendable, Equatable {
  public let thread: CoachThread
  // The messages in the order they were said: by moment, the person's before Coach's, then by id.
  public let messages: [CoachMessage]
  // Each message's write fates, in the messages' order, then by receipt and id.
  public let fates: [CoachWriteFate]

  public init(thread: CoachThread, messages: [CoachMessage], fates: [CoachWriteFate]) {
    self.thread = thread
    self.messages = messages.sorted { a, b in
      if a.at != b.at { return a.at < b.at }
      if a.isCoach != b.isCoach { return !a.isCoach }
      return a.id < b.id
    }
    self.fates = self.messages.flatMap { message in
      fates.filter { $0.messageId == message.id }.sorted { $0.receipt != $1.receipt ? $0.receipt < $1.receipt : $0.id < $1.id }
    }
  }

  public static func read(_ read: Reader, thread: ID<CoachThread>) throws -> Conversation? {
    guard let found = try read.repository(CoachThread.self).find(thread, in: .drawn) else { return nil }
    let messages = try read.repository(CoachMessage.self).children(of: thread, via: "threadId", in: .drawn)
    let fates = try messages.flatMap { try read.repository(CoachWriteFate.self).children(of: $0.id, via: "messageId", in: .drawn) }
    return Conversation(thread: found, messages: messages, fates: fates)
  }
}

// The mark of one turn (Coach engine D-6, roadmap-coach.md §8): the device row `runningTurn:<turnId>`, keyed by the Coach
// message the turn writes, holding the round in flight, `{callId, bytesBefore}`. Before the first round `callId` is null.
public enum TurnMark {
  public static func key(_ message: ID<CoachMessage>) -> String { "runningTurn:" + message.record.description }
  public static let opening: JSON = ["callId": .null, "bytesBefore": 0]
}

// §8 and Coach engine §5 step 1: in one write, the person's message, Coach's running message, a new conversation when none
// is named, about the roadmap `about` names or every roadmap, and the turn's mark. A question keeps gym's bounds.
public struct OpenTurn: ActAction {
  // The conversation and the two messages a turn writes.
  public struct Turn: Sendable, Equatable {
    public let thread: ID<CoachThread>
    public let person: ID<CoachMessage>
    public let coach: ID<CoachMessage>

    public init(thread: ID<CoachThread>, person: ID<CoachMessage>, coach: ID<CoachMessage>) {
      self.thread = thread
      self.person = person
      self.coach = coach
    }
  }

  // What a new conversation is about: a roadmap or every roadmap (`treeId` nil), and the step it started from.
  public struct About: Sendable, Equatable {
    public let treeId: String?
    public let stepId: String?

    public init(treeId: String?, stepId: String? = nil) {
      self.treeId = treeId
      self.stepId = stepId
    }
  }

  public let thread: ID<CoachThread>?
  public let about: About?
  public let question: String
  public let pictures: [CoachPicture]

  public init(thread: ID<CoachThread>, question: String, pictures: [CoachPicture] = []) {
    self.thread = thread
    about = nil
    self.question = question
    self.pictures = pictures
  }

  public init(about: About, question: String, pictures: [CoachPicture] = []) {
    thread = nil
    self.about = about
    self.question = question
    self.pictures = pictures
  }

  public func load(_ read: ActReader) throws -> (thread: CoachThread?, replica: String, moment: Moment) {
    try read.inScope(Roadmap.scope) { account in
      (try thread.flatMap { try account.repository(CoachThread.self).find($0, in: .drawn) }, account.replica, account.moment)
    }
  }

  public func decide(_ loaded: (thread: CoachThread?, replica: String, moment: Moment), ids: ActIDSource) throws(Violation)
    -> ActDecision<Turn, RoadmapRefusal> {
    if let thread, loaded.thread == nil { return .refuse(.gone(thread.ref, .predicted)) }
    let bytes = question.utf8.count
    if bytes > RoadmapLimits.questionBytes {
      throw Violation(rule: RoadmapChecks.question, path: "text", reason: .tooLong(max: RoadmapLimits.questionBytes, unit: .bytes, measured: bytes))
    }
    let blank = TextSpec.isBlank(question)
    if blank && pictures.isEmpty { throw Violation(rule: RoadmapChecks.question, path: "text", reason: .blank) }
    var plan = Plan()
    let threadId = thread ?? ids.mint(CoachThread.self)
    if let about {
      plan.create(try Valid(CoachThread(id: threadId, treeId: about.treeId, stepId: about.stepId, title: blank ? "Photo" : question), at: loaded.moment))
    }
    let turn = Turn(thread: threadId, person: ids.mint(CoachMessage.self), coach: ids.mint(CoachMessage.self))
    let at = loaded.moment.now
    plan.create(try Valid(CoachMessage(id: turn.person, threadId: threadId, role: "person", text: question, pictures: pictures, at: at), at: loaded.moment))
    plan.create(try Valid(CoachMessage(id: turn.coach, threadId: threadId, role: "coach", replica: loaded.replica, at: at), at: loaded.moment))
    plan.device(TurnMark.key(turn.coach), TurnMark.opening)
    return .write(plan, in: Roadmap.scope, turn)
  }
}

// §8 and §9: Coach's message takes its terminal state, its whole text, `truncated`, the code a turn that could not answer
// ended with, and, where the turn kept them, the facts of its calls and receipts (`TurnRecords.swift`), in one write that
// lets go of the turn's mark. A turn its writer already ended is final.
public struct EndTurn: ActAction {
  public let message: ID<CoachMessage>
  public let state: CoachMessageState
  public let text: String?
  public let truncated: Bool
  public let refusal: String?
  public let calls: [CoachCall]?
  public let receipts: [CoachReceipt]?

  public init(_ message: ID<CoachMessage>, state: CoachMessageState, text: String? = nil, truncated: Bool = false, refusal: String? = nil,
              calls: [CoachCall]? = nil, receipts: [CoachReceipt]? = nil) {
    precondition(state.isTerminal, "a turn ends in a terminal state")
    self.message = message
    self.state = state
    self.text = text
    self.truncated = truncated
    self.refusal = refusal
    self.calls = calls
    self.receipts = receipts
  }

  public func load(_ read: ActReader) throws -> (message: CoachMessage?, marked: Bool, moment: Moment) {
    try read.inScope(Roadmap.scope) { account in
      (try account.repository(CoachMessage.self).find(message, in: .drawn), try account.device(TurnMark.key(message)) != nil, account.moment)
    }
  }

  public func decide(_ loaded: (message: CoachMessage?, marked: Bool, moment: Moment), ids: ActIDSource) throws(Violation)
    -> ActDecision<Void, RoadmapRefusal> {
    guard var ended = loaded.message, ended.isCoach else { return .refuse(.gone(message.ref, .predicted)) }
    if ended.state.isWritersTerminal { return .unchanged(()) }
    ended.state = state
    if let text { ended.text = text }
    ended.truncated = truncated
    ended.refusal = refusal
    var written = ["state", "text", "truncated", "refusal"]
    if let calls {
      ended.calls = calls
      written.append("calls")
    }
    if let receipts {
      ended.receipts = receipts.map(HeldReceipt.read)
      written.append("receipts")
    }
    var plan = Plan()
    plan.update(try Valid(ended, fields: written, at: loaded.moment), fields: written)
    if loaded.marked { plan.device(TurnMark.key(message), nil) }
    return .write(plan, in: Roadmap.scope, ())
  }
}

// A turn refused before its answer began never happened: its two messages go, with the pictures they kept on this device,
// the conversation too when it held nothing else, and the turn's mark. It answers the picture ids forgotten.
public struct WithdrawTurn: ActAction {
  public let turn: OpenTurn.Turn

  public init(turn: OpenTurn.Turn) {
    self.turn = turn
  }

  public func load(_ read: ActReader) throws -> (thread: CoachThread?, messages: [CoachMessage], marked: Bool) {
    try read.inScope(Roadmap.scope) { account in
      (try account.repository(CoachThread.self).find(turn.thread, in: .drawn),
       try account.repository(CoachMessage.self).children(of: turn.thread, via: "threadId", in: .stored),
       try account.device(TurnMark.key(turn.coach)) != nil)
    }
  }

  public func decide(_ loaded: (thread: CoachThread?, messages: [CoachMessage], marked: Bool), ids: ActIDSource) -> ActDecision<[String], RoadmapRefusal> {
    let withdrawn = loaded.messages.filter { $0.id == turn.person || $0.id == turn.coach }
    if withdrawn.isEmpty && !loaded.marked { return .unchanged([]) }
    var plan = Plan()
    for message in withdrawn { plan.remove(message.id) }
    let pictures = withdrawn.flatMap(\.pictures).filter(\.localOnly).map(\.id)
    for id in pictures { plan.device(CoachPicture.rowKey(id), nil) }
    if loaded.thread != nil && withdrawn.count == loaded.messages.count { plan.remove(turn.thread) }
    if loaded.marked { plan.device(TurnMark.key(turn.coach), nil) }
    return .write(plan, in: Roadmap.scope, pictures)
  }
}

// §7: a proposal minted, in one write of the person's records: its record, pending, about the roadmap it changes, from the
// conversation and Coach's message that made it; that message naming it; and every other proposal pending about the roadmap
// replaced, in id order, so the roadmap holds one pending proposal. The proposal comes under the id the tool host drew; one
// the device holds is taken. It answers the proposal's id.
public struct MintProposal: ActAction {
  public let proposal: ID<CoachProposal>
  public let treeId: String
  public let thread: ID<CoachThread>
  public let message: ID<CoachMessage>
  public let changes: [JSON]
  public let base: [JSON]

  public init(proposal: ID<CoachProposal>, treeId: String, thread: ID<CoachThread>, message: ID<CoachMessage>, changes: [JSON], base: [JSON]) {
    self.proposal = proposal
    self.treeId = treeId
    self.thread = thread
    self.message = message
    self.changes = changes
    self.base = base
  }

  public func load(_ read: ActReader) throws -> (message: CoachMessage?, taken: Bool, pending: [CoachProposal], moment: Moment) {
    try read.inScope(Roadmap.scope) { account in
      let proposals = account.repository(CoachProposal.self)
      let taken = try proposals.record(proposal, in: .stored) != nil || proposals.spentBorn(proposal) != nil
      let pending = try proposals.all(in: .drawn).filter { $0.state == .pending && $0.treeId.map { $0.utf8.elementsEqual(treeId.utf8) } == true }
      return (try account.repository(CoachMessage.self).find(message, in: .drawn), taken, pending, account.moment)
    }
  }

  public func decide(_ loaded: (message: CoachMessage?, taken: Bool, pending: [CoachProposal], moment: Moment), ids: ActIDSource) throws(Violation)
    -> ActDecision<ID<CoachProposal>, RoadmapRefusal> {
    guard var naming = loaded.message, naming.isCoach, naming.threadId == thread else { return .refuse(.gone(message.ref, .predicted)) }
    if loaded.taken { return .refuse(.taken(proposal.ref, .predicted)) }
    var plan = Plan()
    plan.create(try Valid(CoachProposal(id: proposal, treeId: treeId, threadId: thread, messageId: message, changes: changes, base: base), at: loaded.moment))
    naming.proposalId = proposal
    plan.update(try Valid(naming, fields: ["proposalId"], at: loaded.moment), fields: ["proposalId"])
    for var earlier in loaded.pending.sorted(by: { $0.id < $1.id }) {
      earlier.state = .replaced
      plan.update(try Valid(earlier, fields: ["state"], at: loaded.moment), fields: ["state"])
    }
    return .write(plan, in: Roadmap.scope, proposal)
  }
}
