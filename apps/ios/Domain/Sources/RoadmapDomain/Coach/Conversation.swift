import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// Roadmap Coach's records (roadmap-coach.md §9), kept in the person's `self/roadmap`: a conversation, its messages, the
// proposals and write fates they carry; the read of one conversation; and what a turn writes as it opens, ends, or is
// withdrawn before it began (§8). A removal of any of them is held, as a roadmap's is, so one held delete can carry both.

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
    Check("treeId") { t, _ in _ = try RoadmapSpecs.coachTreeId.apply(t.treeId, at: "treeId") },
    Check("stepId") { t, _ in t.stepId = try RoadmapSpecs.coachStep.apply(t.stepId, at: "stepId") },
    Check("title") { t, _ in t.title = try RoadmapSpecs.coachTitle.apply(t.title, at: "title") },
  ]
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

  // The registry's pattern for a picture's id, `[A-Za-z0-9_-]`, which its device row's key repeats.
  static func idCharacter(_ byte: UInt8) -> Bool {
    (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte) || byte == 0x5F || byte == 0x2D
  }
}

// One message: the person's question, or Coach's answer with the state of its turn, `truncated` and the code a turn that
// could not answer ended with. The calls, receipts and proposal a turn records are m3's and m4's to write.
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
  public var pictures: [CoachPicture]
  public let at: Instant

  public init(id: ID<CoachMessage>, threadId: ID<CoachThread>, role: String, replica: String? = nil, text: String = "",
              state: CoachMessageState = .running, truncated: Bool = false, refusal: String? = nil, pictures: [CoachPicture] = [], at: Instant) {
    self.id = id
    self.threadId = threadId
    self.role = role
    self.replica = replica
    self.text = text
    self.state = state
    self.truncated = truncated
    self.refusal = refusal
    self.pictures = pictures
    self.at = at
  }

  public init(_ r: Fields) throws(DecodeError) {
    let state = CoachMessageState(rawValue: try r.string("state", default: CoachMessageState.running.rawValue)) ?? .running
    self.init(id: ID(r.id), threadId: try r.ref("threadId", CoachThread.self), role: try r.string("role"), replica: try r.optionalString("replica"),
              text: try r.string("text", default: ""), state: state, truncated: try r.bool("truncated", default: false),
              refusal: try r.optionalString("refusal"), pictures: try r.optionalList("pictures", of: CoachPicture.self) ?? [], at: try r.instant("at"))
  }

  public var isCoach: Bool { role == "coach" }

  // A person's message carries its conversation, role, text, pictures and moment only.
  public var fields: [String: JSON] {
    var fields: [String: JSON?] = ["threadId": threadId.json, "role": .string(role), "at": .of(at), "text": .string(text),
                                   "pictures": pictures.isEmpty ? nil : .array(pictures.map(\.json))]
    if isCoach {
      fields["replica"] = replica.map { .string($0) }
      fields["state"] = .string(state.rawValue)
      fields["truncated"] = .bool(truncated)
      fields["refusal"] = .some(refusal.map { .string($0) } ?? .null)
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

// A proposal (§7) as far as a roadmap's delete reads it: the roadmap it changes and where it was made. Minting one, with
// its base and changes, is m4's.
public struct CoachProposal: ProductEntity, Removable, Equatable {
  public static let type = Roadmap.Types.coachProposal
  public static let scope = Roadmap.scope
  public static let heldRemoval = true

  public let id: ID<CoachProposal>
  public let treeId: String
  public let threadId: ID<CoachThread>
  public let messageId: ID<CoachMessage>

  public init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    treeId = try r.string("treeId")
    threadId = try r.ref("threadId", CoachThread.self)
    messageId = try r.ref("messageId", CoachMessage.self)
  }
}

// What became of one receipt's write after its turn ended (§6): undone, or refused by the server with its code. Writing
// one is m3's.
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

// §8 and §9: Coach's message takes its terminal state, its whole text, `truncated` and the code a turn that could not
// answer ended with, in one write that lets go of the turn's mark. A turn its writer already ended is final.
public struct EndTurn: ActAction {
  public let message: ID<CoachMessage>
  public let state: CoachMessageState
  public let text: String?
  public let truncated: Bool
  public let refusal: String?

  public init(_ message: ID<CoachMessage>, state: CoachMessageState, text: String? = nil, truncated: Bool = false, refusal: String? = nil) {
    precondition(state.isTerminal, "a turn ends in a terminal state")
    self.message = message
    self.state = state
    self.text = text
    self.truncated = truncated
    self.refusal = refusal
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
    let written = ["state", "text", "truncated", "refusal"]
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
