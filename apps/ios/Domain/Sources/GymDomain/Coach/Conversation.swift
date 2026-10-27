import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A Coach conversation as the engine holds it (Coach §9.1): a thread and its messages, the record of every ability call a
// turn ran on the Coach message, the receipt that derives from those calls (§9.2), and the two actions a turn's driver
// takes around the calls: opening the turn (§4.1 step 2) and ending it (§4.4, §4.5).

public struct CoachThread: Writable, Removable, Equatable {
  public static let type = Gym.Types.thread
  public static let scope = Gym.scope
  public static let heldRemoval = false

  public let id: ID<CoachThread>
  public var title: String

  public init(id: ID<CoachThread>, title: String) {
    self.id = id
    self.title = title
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), title: try r.string("title", default: ""))
  }

  public var fields: [String: JSON] { ["title": .string(title)] }

  public static let checks: [Check<CoachThread>] = [
    Check("title") { t, _ in t.title = try CoachRules.title.apply(t.title, at: "title") },
  ]
}

// The states of a Coach message, in the registry's rank: a terminal state beats running, and a writer's terminal state
// beats another device's interrupted.
public enum MessageState: String, Sendable, CaseIterable, Equatable {
  case running, interrupted, completed, declined, failed, stopped

  public var rank: Int {
    switch self {
    case .running: 0
    case .interrupted: 1
    case .completed, .declined, .failed, .stopped: 2
    }
  }

  public var isTerminal: Bool { self != .running }
  public var isWritersTerminal: Bool { rank == 2 }
}

// A picture on a message: its id in the store, or on the phone that sent it when `localOnly` (Coach §9.3).
public struct Picture: ValueObject, Equatable {
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

  public var json: JSON {
    .object(omittingNil: ["id": .string(id), "mediaType": .string(mediaType), "localOnly": localOnly ? true : nil])
  }

  public func validated(at path: Path) throws(Violation) -> Picture {
    Picture(id: try CoachRules.pictureId.apply(id, at: path + "id"), mediaType: try CoachRules.mediaType.apply(mediaType, at: path + "mediaType"),
            localOnly: localOnly)
  }
}

public struct CoachMessage: Writable, Removable, Equatable {
  public enum Role: String, Sendable, Equatable {
    case lifter, coach
  }

  public static let type = Gym.Types.message
  public static let scope = Gym.scope
  public static let heldRemoval = false

  public let id: ID<CoachMessage>
  public let threadId: ID<CoachThread>
  public let role: Role
  public let replica: String?
  public var text: String
  public var state: MessageState
  public var truncated: Bool
  public var receipt: JSON?
  public var calls: [AbilityCall]
  public let pictures: [Picture]
  public let at: Instant

  public init(id: ID<CoachMessage>, threadId: ID<CoachThread>, role: Role, replica: String? = nil, text: String = "",
              state: MessageState = .running, truncated: Bool = false, receipt: JSON? = nil, calls: [AbilityCall] = [],
              pictures: [Picture] = [], at: Instant) {
    self.id = id
    self.threadId = threadId
    self.role = role
    self.replica = replica
    self.text = text
    self.state = state
    self.truncated = truncated
    self.receipt = receipt
    self.calls = calls
    self.pictures = pictures
    self.at = at
  }

  public init(_ r: Fields) throws(DecodeError) {
    guard let role = Role(rawValue: try r.string("role")) else { throw DecodeError(type: Self.type, field: "role", reason: "not a role") }
    let state = MessageState(rawValue: try r.string("state", default: MessageState.running.rawValue)) ?? .running
    var calls: [AbilityCall] = []
    if let recorded = r.json("calls"), !recorded.isNull { calls = try AbilityCall.list(recorded) }
    self.init(id: ID(r.id), threadId: try r.ref("threadId", CoachThread.self), role: role, replica: try r.optionalString("replica"),
              text: try r.string("text", default: ""), state: state, truncated: try r.bool("truncated", default: false),
              receipt: r.json("receipt").flatMap { $0.isNull ? nil : $0 }, calls: calls,
              pictures: try r.optionalList("pictures", of: Picture.self) ?? [], at: try r.instant("at"))
  }

  // A lifter message carries its thread, role, text, pictures and moment only (Coach §9.1); the Coach message carries
  // its writer's replica, state, text, calls and truncation, and its receipt once the turn ended.
  public var fields: [String: JSON] {
    var fields: [String: JSON?] = ["threadId": threadId.json, "role": .string(role.rawValue), "at": .of(at), "text": .string(text),
                                   "pictures": pictures.isEmpty ? nil : .array(pictures.map(\.json))]
    if role == .coach {
      fields["replica"] = replica.map { .string($0) }
      fields["state"] = .string(state.rawValue)
      fields["truncated"] = .bool(truncated)
      fields["receipt"] = receipt
      fields["calls"] = .array(calls.map(\.json))
    }
    return fields.compactMapValues { $0 }
  }

  public static let checks: [Check<CoachMessage>] = [
    Check("role") { m, _ in _ = try CoachRules.role.apply(m.role.rawValue, at: "role") },
    Check("replica") { m, _ in _ = try CoachRules.replica.apply(m.replica, at: "replica") },
    Check("text") { m, _ in m.text = try CoachRules.text.apply(m.text, at: "text") },
    Check("pictures") { m, _ in _ = try CoachRules.pictures.apply(m.pictures, at: "pictures") },
    Check("receipt") { m, _ in try CoachRules.within(m.receipt ?? .null, bytes: CoachRules.maxReceiptBytes, rule: "message.receipt", at: "receipt") },
    Check("calls") { m, _ in
      try CoachRules.within(.array(m.calls.map(\.json)), bytes: CoachRules.maxCallsBytes, rule: "message.calls", at: "calls")
    },
  ]

  public var callsBytes: Int { JSON.array(calls.map(\.json)).jcs.count }
}

public enum CoachRules {
  public static let maxQuestionBytes = 8_000
  public static let maxReceiptBytes = 16_384
  public static let maxCallsBytes = 32_768
  public static let title = TextSpec("thread.title", unit: .bytes, min: 1, max: 8_000, trim: false, nfc: false)
  public static let role = ChoiceSpec("message.role", values: ["lifter", "coach"])
  public static let replica = TextSpec("message.replica", unit: .chars, min: 35, max: 35, trim: false, nfc: false)
  public static let text = TextSpec("message.text", unit: .bytes, min: 0, max: 131_072, trim: false, nfc: false)
  public static let pictures = CountSpec("message.pictures", min: 0, max: 1)
  public static let pictureId = TextSpec("message.pictures.id", unit: .chars, min: 8, max: 64, trim: false, nfc: false)
  public static let mediaType = TextSpec("message.pictures.mediaType", unit: .bytes, min: 1, max: 255, trim: false, nfc: false)
  public static let question = "message.question"

  // The Coach entities and rules, a book of their own beside GymRules.book until every gym implementation carries them:
  // packages/api-contract/gym/domain/rules.json pins the shared book for Android too.
  public static let book = RuleBook(registry: SyncSchema.registry, entities: [CoachThread.self, CoachMessage.self], rules: [
    .local(title), .local(role), .local(replica), .local(text), .local(pictures), .local(pictureId), .local(mediaType),
    .local("message.receipt", subject: CoachMessage.type), .local("message.calls", subject: CoachMessage.type),
    .local(question, subject: CoachMessage.type),
  ])

  static func within(_ json: JSON, bytes: Int, rule: String, at path: Path) throws(Violation) {
    let measured = json.jcs.count
    if measured > bytes { throw Violation(rule: rule, path: path, reason: .tooLong(max: bytes, unit: .bytes, measured: measured)) }
  }
}

// MARK: - The calls a turn ran

// The codes a call the phone refused carries back (Coach §5, §6.4): the gate's for an ability not offered or not open
// to the seat, the executor's for a malformed input or a rule's refusal, and the turn's own volume bound.
public enum AbilityRefusal: String, Sendable, Equatable {
  case notOffered = "not-offered"
  case seatRequired = "seat-required"
  case invalidArguments = "invalid-arguments"
  case refused
  case volume = "coach-turn-volume"
}

// The log rows a read handed to the model, by identity, and the weeks they fall in (Monday 00:00 UTC): what the read
// receipt counts, and what the result's `read` tally states for one call.
public struct ReadServed: Equatable, Sendable {
  public static let none = ReadServed()
  static let weekMs: Int64 = 604_800_000
  static let epochToMonday: Int64 = 259_200_000

  public private(set) var sessions: [ID<Session>] = []
  public private(set) var sets: [ID<TrainingSet>] = []
  public private(set) var weeks: [Int64] = []

  public init() {}

  public mutating func saw(session: Session) {
    insert(session.id, into: &sessions)
    saw(week: Self.week(of: session.startedAt))
  }

  public mutating func saw(set: TrainingSet) {
    insert(set.id, into: &sets)
    saw(week: Self.week(of: set.completedAt))
  }

  public mutating func saw(week: Int64) {
    if let at = weeks.firstIndex(where: { $0 >= week }) {
      if weeks[at] != week { weeks.insert(week, at: at) }
    } else {
      weeks.append(week)
    }
  }

  // Everything another read served, by identity.
  public mutating func saw(_ other: ReadServed) {
    for id in other.sessions { insert(id, into: &sessions) }
    for id in other.sets { insert(id, into: &sets) }
    for week in other.weeks { saw(week: week) }
  }

  public var isEmpty: Bool { sessions.isEmpty && sets.isEmpty && weeks.isEmpty }

  // `{sets, sessions, weeks}`, the tally a result carries when the call served anything.
  public var tally: JSON { ["sets": JSON(sets.count), "sessions": JSON(sessions.count), "weeks": JSON(weeks.count)] }

  public var json: JSON {
    ["sessions": .array(sessions.map(\.json)), "sets": .array(sets.map(\.json)), "weeks": .array(weeks.map { JSON($0) })]
  }

  init(json: JSON) throws(DecodeError) {
    let f = try Fields(json)
    sessions = try Self.ids(f, "sessions").map { ID<Session>($0) }
    sets = try Self.ids(f, "sets").map { ID<TrainingSet>($0) }
    guard case .array(let weeks)? = f.json("weeks") else { throw DecodeError(type: CoachMessage.type, field: "calls.read.weeks", reason: "absent") }
    for week in weeks {
      guard case .number(let number) = week, let ms = Int64(exactly: number.value) else {
        throw DecodeError(type: CoachMessage.type, field: "calls.read.weeks", reason: "not an integer")
      }
      self.weeks.append(ms)
    }
  }

  static func ids(_ f: Fields, _ field: String) throws(DecodeError) -> [RecordID] {
    guard case .array(let items)? = f.json(field) else { throw DecodeError(type: CoachMessage.type, field: "calls.read.\(field)", reason: "absent") }
    var ids: [RecordID] = []
    for item in items {
      guard let id = try? RecordID(json: item) else { throw DecodeError(type: CoachMessage.type, field: "calls.read.\(field)", reason: "not an id") }
      ids.append(id)
    }
    return ids
  }

  // The epoch was a Thursday: the instant moves three days forward, floors to a week, and moves back.
  public static func week(of instant: Instant) -> Int64 {
    let shifted = instant.ms + epochToMonday
    let floored = shifted >= 0 ? shifted / weekMs : (shifted - weekMs + 1) / weekMs
    return max(1, floored * weekMs - epochToMonday)
  }

  func insert<E: Entity>(_ id: ID<E>, into ids: inout [ID<E>]) {
    if let at = ids.firstIndex(where: { $0 >= id }) {
      if ids[at] != id { ids.insert(id, at: at) }
    } else {
      ids.append(id)
    }
  }
}

// One ability call as the Coach message records it (Coach §4.3 step 2): the call's id and name, its input while the
// message's calls have room for it, what it created, what it served, and how it ended.
public struct AbilityCall: Equatable, Sendable {
  public enum Outcome: Equatable, Sendable {
    case ok
    case refused(AbilityRefusal)
  }

  public let callId: String
  public let name: String
  public let input: JSON?
  public let outcome: Outcome
  public let created: [RecordRef]
  public let read: ReadServed

  public init(callId: String, name: String, input: JSON?, outcome: Outcome, created: [RecordRef] = [], read: ReadServed = .none) {
    self.callId = callId
    self.name = name
    self.input = input
    self.outcome = outcome
    self.created = created
    self.read = read
  }

  public var json: JSON {
    let outcome: JSON = switch self.outcome {
    case .ok: "ok"
    case .refused(let code): .string(code.rawValue)
    }
    return .object(omittingNil: ["callId": .string(callId), "name": .string(name), "input": input, "outcome": outcome,
                                 "created": .array(created.map { ["t": .string($0.type), "id": $0.id.json] }), "read": read.json])
  }

  public init(json: JSON) throws(DecodeError) {
    let f = try Fields(json)
    let outcome = try f.string("outcome")
    guard let ended = outcome == "ok" ? Outcome.ok : AbilityRefusal(rawValue: outcome).map(Outcome.refused) else {
      throw DecodeError(type: CoachMessage.type, field: "calls.outcome", reason: "not an outcome")
    }
    guard case .array(let created)? = f.json("created") else { throw DecodeError(type: CoachMessage.type, field: "calls.created", reason: "absent") }
    var refs: [RecordRef] = []
    for item in created {
      let ref = try Fields(item)
      guard let id = try? RecordID(json: ref.json("id") ?? .null) else { throw DecodeError(type: CoachMessage.type, field: "calls.created", reason: "not an id") }
      refs.append(RecordRef(type: try ref.string("t"), id: id))
    }
    guard let read = f.json("read") else { throw DecodeError(type: CoachMessage.type, field: "calls.read", reason: "absent") }
    self.init(callId: try f.string("callId"), name: try f.string("name"), input: f.json("input"), outcome: ended, created: refs,
              read: try ReadServed(json: read))
  }

  static func list(_ json: JSON) throws(DecodeError) -> [AbilityCall] {
    guard case .array(let items) = json else { throw DecodeError(type: CoachMessage.type, field: "calls", reason: "not an array") }
    var calls: [AbilityCall] = []
    for item in items { calls.append(try AbilityCall(json: item)) }
    return calls
  }

  // Coach §9.2: what the turn read, counted by identity across its calls, and the ids of what it created; a refused
  // call counts nothing. Ids only: the room reads names and serials from the records when it draws.
  public static func receipt(of calls: [AbilityCall]) -> JSON {
    var served = ReadServed()
    var created: [RecordRef] = []
    for call in calls where call.outcome == .ok {
      served.saw(call.read)
      created += call.created.filter { !created.contains($0) }
    }
    return ["read": served.tally, "results": .array(created.map { ["t": .string($0.type), "id": $0.id.json] })]
  }
}

// MARK: - A turn's bookends

// Coach §4.1 step 2: in one transaction, the lifter's message and the running Coach message, a new conversation when
// none is named, and the device's `runningTurn` row.
public struct OpenTurn: Action {
  public struct Turn: Sendable, Equatable {
    public let thread: ID<CoachThread>
    public let lifter: ID<CoachMessage>
    public let coach: ID<CoachMessage>
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
    if let thread, loaded.thread == nil { return .refuse(GymRefusal(Refused(.unknownRecord, subject: thread.ref, path: .predicted))) }
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
    plan.device(EndTurn.runningTurnKey, turn.coach.json)
    return .write(plan, turn)
  }
}

// Coach §4.4 and §4.5: the Coach message's terminal state, its answer and the receipt its calls derive, in one
// transaction, and the device's `runningTurn` row cleared. A turn a writer already ended is final.
public struct EndTurn: Action {
  public static let runningTurnKey = "runningTurn"

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

  public func load(_ read: Reader) throws -> (message: CoachMessage?, moment: Moment) {
    (try read.repository(CoachMessage.self).find(message, in: .drawn), read.moment)
  }

  public func decide(_ loaded: (message: CoachMessage?, moment: Moment), ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard var ended = loaded.message, ended.role == .coach else {
      return .refuse(GymRefusal(Refused(.unknownRecord, subject: message.ref, path: .predicted)))
    }
    if ended.state.isWritersTerminal { return .unchanged(()) }
    ended.state = state
    if let text { ended.text = text }
    ended.truncated = truncated
    ended.receipt = AbilityCall.receipt(of: ended.calls)
    var plan = Plan()
    plan.update(try Valid(ended, fields: ["state", "text", "receipt", "truncated"], at: loaded.moment), fields: ["state", "text", "receipt", "truncated"])
    plan.device(Self.runningTurnKey, nil)
    return .write(plan)
  }
}
