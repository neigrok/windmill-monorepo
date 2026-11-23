import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// What a turn writes around a conversation's records (Coach §4, gym Coach on the AI service §4.4): the mark that names the
// turn this phone is running, the open, the text as it streams, the round in flight, the end, the forget of a turn whose
// message is gone, the withdraw of a turn that never happened, and the delete of a conversation.

// MARK: - The mark

// The mark (Coach engine D-6): `runningTurn`, the Coach message this phone's turn writes, and `runningRound`,
// `{message, callId, bytesBefore}`, the round in flight. The engine checks a device row's key alone, so the mark reads each
// row only in the shape the registry declares it. A round counts only while it names the running turn's message; any
// other round row is stale.
public struct Mark: Sendable, Equatable {
  public static let turnKey = "runningTurn"
  public static let roundKey = "runningRound"
  static let turnShape = declared(turnKey)
  static let roundShape = declared(roundKey)

  public let turnId: ID<CoachMessage>?
  public let callId: String?
  public let textBytesBeforeRound: Int
  // A round row the device holds that names no round of the running turn: a reader that meets one clears it.
  public internal(set) var roundIsStale: Bool

  public init(_ read: Reader) throws {
    let turn = try read.device(Self.turnKey).flatMap { Self.turnShape.admits($0) ? $0 : nil }
    let round = try read.device(Self.roundKey)
    turnId = try turn.map { ID(try RecordID(json: $0)) }
    guard let turn, let round, Self.roundShape.admits(round), round["message"] == turn else {
      callId = nil
      textBytesBeforeRound = 0
      roundIsStale = round != nil
      return
    }
    callId = try round.member("callId").asString()
    textBytesBeforeRound = Int(try round.member("bytesBefore").asInteger())
    roundIsStale = false
  }

  public func names(_ message: ID<CoachMessage>) -> Bool { turnId == message }

  // Every write that clears `runningTurn` clears `runningRound` in the same write.
  static func clear(_ plan: inout Plan) {
    plan.device(turnKey, nil)
    plan.device(roundKey, nil)
  }

  static func declared(_ key: String) -> Domain {
    guard let value = SyncSchema.registry.product("gym")?.device.first(where: { $0.name == key })?.value else {
      preconditionFailure("the gym registry declares the value of its \(key) row")
    }
    return value
  }
}

// The mark as a turn host recovers from it (Coach engine §5): read, with a stale or malformed round row cleared.
public struct RecoverMark: Action {
  public init() {}

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Mark { try Mark(read) }

  public func decide(_ mark: Mark, ids: IDSource) throws(Violation) -> Decision<Mark, GymRefusal> {
    guard mark.roundIsStale else { return .unchanged(mark) }
    var plan = Plan()
    plan.device(Mark.roundKey, nil)
    var recovered = mark
    recovered.roundIsStale = false
    return .write(plan, recovered)
  }
}

// MARK: - A running turn

// This replica's Coach message while its writer has not ended it (gym Coach on the AI service §4.2): running, or
// `interrupted` by another device while this phone's mark names it. The writer's own end, `interrupted` included, lets go
// of the mark.
extension CoachMessage {
  public func writersOwn(replica: String, mark: Mark) -> Bool {
    guard role == .coach, self.replica == replica else { return false }
    switch state {
    case .running: return true
    case .interrupted: return mark.names(id)
    case .completed, .declined, .failed, .stopped: return false
    }
  }
}

// Coach §4.1 step 2: in one transaction, the lifter's message and the running Coach message, a new conversation when
// none is named, and the device's `runningTurn` row.
public struct OpenTurn: Action {
  public struct Turn: Sendable, Equatable {
    public let thread: ID<CoachThread>
    public let lifter: ID<CoachMessage>
    public let coach: ID<CoachMessage>

    public init(thread: ID<CoachThread>, lifter: ID<CoachMessage>, coach: ID<CoachMessage>) {
      self.thread = thread
      self.lifter = lifter
      self.coach = coach
    }
  }

  public typealias Loaded = (thread: CoachThread?, replica: String, moment: Moment)

  public let thread: ID<CoachThread>?
  public let question: String
  public let pictures: [Picture]

  public init(thread: ID<CoachThread>? = nil, question: String, pictures: [Picture] = []) {
    self.thread = thread
    self.question = question
    self.pictures = pictures
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    (try thread.flatMap { try read.repository(CoachThread.self).find($0, in: .drawn) }, read.replica, read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Turn, GymRefusal> {
    if let thread, loaded.thread == nil { return .refuse(.gone(thread.ref, .predicted)) }
    let bytes = question.utf8.count
    if bytes > CoachRules.maxQuestionBytes {
      throw Violation(rule: CoachRules.question, path: "text", reason: .tooLong(max: CoachRules.maxQuestionBytes, unit: .bytes, measured: bytes))
    }
    if TextSpec.isBlank(question) && pictures.isEmpty { throw Violation(rule: CoachRules.question, path: "text", reason: .blank) }
    var plan = Plan()
    let threadId = thread ?? ids.mint(CoachThread.self)
    if thread == nil {
      plan.create(try Valid(CoachThread(id: threadId, title: TextSpec.isBlank(question) ? "Photo" : question), at: loaded.moment))
    }
    let turn = Turn(thread: threadId, lifter: ids.mint(CoachMessage.self), coach: ids.mint(CoachMessage.self))
    plan.create(try Valid(CoachMessage(id: turn.lifter, threadId: threadId, role: .lifter, text: question, pictures: pictures, at: loaded.moment.now),
                          at: loaded.moment))
    plan.create(try Valid(CoachMessage(id: turn.coach, threadId: threadId, role: .coach, replica: loaded.replica, at: loaded.moment.now),
                          at: loaded.moment))
    plan.device(Mark.turnKey, turn.coach.json)
    return .write(plan, turn)
  }
}

// The answer's text as it streams (Coach §4.3): the Coach message takes the text so far while it is this replica's to
// write; a message its writer ended, or another replica's, takes nothing.
public struct StreamTurnText: Action {
  public typealias Loaded = (message: CoachMessage?, replica: String, moment: Moment, mark: Mark)

  public let message: ID<CoachMessage>
  public let text: String

  public init(message: ID<CoachMessage>, text: String) {
    self.message = message
    self.text = text
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    (try read.repository(CoachMessage.self).find(message, in: .drawn), read.replica, read.moment, try Mark(read))
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard var streaming = loaded.message, streaming.role == .coach else { return .refuse(.gone(message.ref, .predicted)) }
    guard streaming.writersOwn(replica: loaded.replica, mark: loaded.mark), streaming.text != text else { return .unchanged(()) }
    streaming.text = text
    var plan = Plan()
    plan.update(try Valid(streaming, fields: ["text"], at: loaded.moment), fields: ["text"])
    return .write(plan)
  }
}

// A round begins (Coach engine D-6): `runningRound` names the running turn's message, the round's call and the bytes of
// text before it.
public struct BeginRound: Action {
  public typealias Loaded = (message: CoachMessage?, replica: String, mark: Mark)

  public let message: ID<CoachMessage>
  public let callId: String
  public let bytesBefore: Int

  public init(message: ID<CoachMessage>, callId: String, bytesBefore: Int) {
    self.message = message
    self.callId = callId
    self.bytesBefore = bytesBefore
    precondition(Mark.roundShape.admits(row), "a round is named by a call id of 22 characters and starts within the text bound")
  }

  var row: JSON { ["message": message.json, "callId": .string(callId), "bytesBefore": JSON(bytesBefore)] }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    (try read.repository(CoachMessage.self).find(message, in: .drawn), read.replica, try Mark(read))
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard let running = loaded.message, running.role == .coach else { return .refuse(.gone(message.ref, .predicted)) }
    guard running.writersOwn(replica: loaded.replica, mark: loaded.mark), loaded.mark.names(message) else {
      return .refuse(.other(Refused(Gym.Codes.messageFinal, subject: message.ref, path: .predicted)))
    }
    if loaded.mark.callId == callId && loaded.mark.textBytesBeforeRound == bytesBefore { return .unchanged(()) }
    var plan = Plan()
    plan.device(Mark.roundKey, row)
    return .write(plan)
  }
}

// MARK: - A turn's end

// Coach §4.4 and §4.5: the Coach message's terminal state, its answer and the receipt its calls derive, in one
// transaction, with the mark cleared unless it names another turn. A turn a writer already ended is final.
public struct EndTurn: Action {
  public typealias Loaded = (message: CoachMessage?, moment: Moment, mark: Mark)

  public let message: ID<CoachMessage>
  public let state: MessageState
  public let text: String?
  public let truncated: Bool

  public init(_ message: ID<CoachMessage>, state: MessageState, text: String? = nil, truncated: Bool = false) {
    precondition(state.isTerminal, "a turn ends in a terminal state")
    self.message = message
    self.state = state
    self.text = text
    self.truncated = truncated
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    (try read.repository(CoachMessage.self).find(message, in: .drawn), read.moment, try Mark(read))
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard var ended = loaded.message, ended.role == .coach else { return .refuse(.gone(message.ref, .predicted)) }
    if ended.state.isWritersTerminal { return .unchanged(()) }
    ended.state = state
    if let text { ended.text = text }
    ended.truncated = truncated
    ended.receipt = AbilityCall.receipt(of: ended.calls)
    let written = ["state", "text", "receipt", "truncated"]
    var plan = Plan()
    plan.update(try Valid(ended, fields: written, at: loaded.moment), fields: written)
    if loaded.mark.turnId == nil || loaded.mark.names(message) { Mark.clear(&plan) }
    return .write(plan)
  }
}

// A turn whose message is gone, as a conversation deleted on another phone takes it: the mark lets go of it, and of no
// other.
public struct ForgetRunningTurn: Action {
  public let message: ID<CoachMessage>

  public init(message: ID<CoachMessage>) {
    self.message = message
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Mark { try Mark(read) }

  public func decide(_ mark: Mark, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard mark.names(message) else { return .unchanged(()) }
    var plan = Plan()
    Mark.clear(&plan)
    return .write(plan)
  }
}

// A turn refused before its stream started never happened: its two messages go, with the pictures they kept on this
// phone, the conversation too when it stands and held nothing else, and the mark. It answers the ids of the pictures
// forgotten.
public struct WithdrawTurn: Action {
  public typealias Loaded = (thread: CoachThread?, messages: [CoachMessage], mark: Mark)

  public let turn: OpenTurn.Turn

  public init(turn: OpenTurn.Turn) {
    self.turn = turn
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    (try read.repository(CoachThread.self).find(turn.thread, in: .drawn),
     try read.repository(CoachMessage.self).children(of: turn.thread, via: "threadId", in: .stored), try Mark(read))
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<[String], GymRefusal> {
    let withdrawn = loaded.messages.filter { $0.id == turn.lifter || $0.id == turn.coach }
    var plan = Plan()
    for message in withdrawn { plan.remove(message.id) }
    let pictures = plan.forgetPictures(of: withdrawn)
    if loaded.thread != nil && withdrawn.count == loaded.messages.count { plan.remove(turn.thread) }
    Mark.clear(&plan)
    return .write(plan, pictures)
  }
}

// A conversation deleted from History: the thread, every message it holds, the pictures those messages kept on this
// phone, and the mark when it names one of them. It answers the ids of the pictures forgotten.
public struct DeleteConversation: Action {
  public typealias Loaded = (thread: CoachThread?, messages: [CoachMessage], mark: Mark)

  public let thread: ID<CoachThread>

  public init(thread: ID<CoachThread>) {
    self.thread = thread
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    (try read.repository(CoachThread.self).find(thread, in: .drawn),
     try read.repository(CoachMessage.self).children(of: thread, via: "threadId", in: .stored), try Mark(read))
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<[String], GymRefusal> {
    guard loaded.thread != nil else { return .unchanged([]) }
    var plan = Plan()
    plan.remove(thread)
    for message in loaded.messages { plan.remove(message.id) }
    let pictures = plan.forgetPictures(of: loaded.messages)
    if loaded.messages.contains(where: { loaded.mark.names($0.id) }) { Mark.clear(&plan) }
    return .write(plan, pictures)
  }
}

extension Plan {
  // The rows of the pictures these messages kept on this phone, forgotten; their ids.
  mutating func forgetPictures(of messages: [CoachMessage]) -> [String] {
    let kept = messages.flatMap(\.pictures).filter(\.localOnly).map(\.id)
    for id in kept { device(Picture.rowKey(id), nil) }
    return kept
  }
}
