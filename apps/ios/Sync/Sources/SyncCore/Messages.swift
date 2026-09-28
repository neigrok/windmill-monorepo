// §9.2–§9.6 the exchanges, the same only byte for byte: hello, push and pull, live requests and frames, HTTP failures and
// refusal codes.

// MARK: - Refusal codes

// §9.6 the engine's closed list, and the `codes` each product's registry declares (§2.4); compared by bytes. A code no
// registry declares, a product's newer than this version, is a refusal like any other.
public struct RefusalCode: Sendable, Hashable, CustomStringConvertible, ExpressibleByStringLiteral {
  public let text: String

  public init(_ text: String) {
    self.text = text
  }

  public init(stringLiteral value: String) {
    self.init(value)
  }

  public var description: String { text }
  public var json: JSON { .string(text) }

  public static func == (lhs: RefusalCode, rhs: RefusalCode) -> Bool { lhs.text.utf8.elementsEqual(rhs.text.utf8) }
  public func hash(into hasher: inout Hasher) { hasher.combine(Array(text.utf8)) }

  public static let notFound: RefusalCode = "not-found"
  public static let scopeDead: RefusalCode = "scope-dead"
  public static let forbidden: RefusalCode = "forbidden"
  public static let invalid: RefusalCode = "invalid"
  public static let tooLarge: RefusalCode = "too-large"
  public static let clockSkew: RefusalCode = "clock-skew"
  public static let idTaken: RefusalCode = "id-taken"
  public static let idSpent: RefusalCode = "id-spent"
  public static let unknownRecord: RefusalCode = "unknown-record"
  public static let recordDead: RefusalCode = "record-dead"
  public static let parentDead: RefusalCode = "parent-dead"
  public static let stale: RefusalCode = "stale"
  public static let cap: RefusalCode = "cap"
  public static let baseUnknown: RefusalCode = "base-unknown"
  public static let requestConflict: RefusalCode = "request-conflict"
  public static let requestRunning: RefusalCode = "request-running"
  public static let `internal`: RefusalCode = "internal"
  public static let targetMerged: RefusalCode = "target-merged"

  // §9.6's table, which no product's `codes` declares again.
  public static let engine: [RefusalCode] = [
    .notFound, .scopeDead, .forbidden, .invalid, .tooLarge, .clockSkew, .idTaken, .idSpent, .unknownRecord, .recordDead,
    .parentDead, .stale, .cap, .baseUnknown, .requestConflict, .requestRunning, .internal, .targetMerged,
  ]
}

// MARK: - HTTP failures

// A response other than 200: its status, its `error`, and the `serverTime` and `epoch` every response carries (§9.1).
public struct HTTPFailure: Sendable, Hashable {
  public let status: Int
  public let error: String?
  public let serverTime: Int64?
  public let epoch: String?
  public let retryAfterMs: Int64?

  public init(status: Int, error: String? = nil, serverTime: Int64? = nil, epoch: String? = nil, retryAfterMs: Int64? = nil) {
    self.status = status
    self.error = error
    self.serverTime = serverTime
    self.epoch = epoch
    self.retryAfterMs = retryAfterMs
  }

  public init(status: Int, body: JSON?) throws(JSONError) {
    self.init(
      status: status,
      error: try body?["error"]?.asString(),
      serverTime: try body?["serverTime"]?.asInteger(),
      epoch: try body?["epoch"]?.asString(),
      retryAfterMs: try body?["retryAfterMs"]?.asInteger())
  }

  public static func == (lhs: HTTPFailure, rhs: HTTPFailure) -> Bool {
    lhs.status == rhs.status && lhs.error.map { Array($0.utf8) } == rhs.error.map { Array($0.utf8) }
      && lhs.serverTime == rhs.serverTime && lhs.epoch.map { Array($0.utf8) } == rhs.epoch.map { Array($0.utf8) }
      && lhs.retryAfterMs == rhs.retryAfterMs
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(status)
    hasher.combine(error.map { Array($0.utf8) })
    hasher.combine(serverTime)
    hasher.combine(epoch.map { Array($0.utf8) })
    hasher.combine(retryAfterMs)
  }
}

// One HTTP answer: a 200 body, or a failure.
public enum Answer<Body: Sendable>: Sendable {
  case ok(Body)
  case failed(HTTPFailure)
}

// MARK: - Hello

public struct HelloResponse: Sendable, Hashable {
  public let serverTime: Int64
  public let epoch: String
  public let schema: Int
  public let minSchema: Int
  public let holdsRecords: [String: Bool]?

  public init(json: JSON) throws {
    serverTime = try json.member("serverTime").asInteger()
    epoch = try json.member("epoch").asString()
    schema = Int(try json.member("schema").asInteger())
    minSchema = Int(try json.member("minSchema").asInteger())
    holdsRecords = try json["holdsRecords"].map { try JSON.map($0) { try $0.asBool() } }
  }

  public static func == (lhs: HelloResponse, rhs: HelloResponse) -> Bool {
    lhs.serverTime == rhs.serverTime && lhs.epoch.utf8.elementsEqual(rhs.epoch.utf8) && lhs.schema == rhs.schema
      && lhs.minSchema == rhs.minSchema && lhs.holdsRecords == rhs.holdsRecords
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(serverTime)
    hasher.combine(Array(epoch.utf8))
    hasher.combine(schema)
    hasher.combine(minSchema)
    hasher.combine(holdsRecords)
  }
}

// MARK: - Request bodies

// §9.1 a request on the wire: a client sends its JCS bytes (§7.4), which is the body a server measures as received.
public protocol RequestBody {
  var json: JSON { get }
}

extension RequestBody {
  public var body: [UInt8] { json.jcs }
}

// MARK: - Push

public struct PushRequest: Sendable, Hashable, RequestBody {
  public let replica: String
  public let ackThrough: Int64
  public let intents: [Intent]

  public init(replica: String, ackThrough: Int64, intents: [Intent]) {
    self.replica = replica
    self.ackThrough = ackThrough
    self.intents = intents
  }

  // §7.1 step 8: the widest request `intent` goes in alone, its `n` and `ackThrough` at their widest, 2^53 − 1.
  public init(widestFor intent: Intent, of replica: String) {
    var numbered = intent
    numbered.n = JSON.maxSafeInteger
    self.init(replica: replica, ackThrough: JSON.maxSafeInteger, intents: [numbered])
  }

  public var json: JSON {
    ["replica": .string(replica), "ackThrough": JSON(ackThrough), "intents": .array(intents.map(\.json))]
  }

  public static func == (lhs: PushRequest, rhs: PushRequest) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// D-20 one record a command wrote or resolved to: the id it was called with, its born, and each field's stamp.
public struct WriteMapEntry: Sendable, Hashable {
  public let key: RecordKey
  public let from: RecordID?
  public let born: Stamp?
  public let fields: [String: Stamp]

  public init(json: JSON) throws {
    let object = try json.asObject()
    key = RecordKey(try object.member("t").asString(), try RecordID(json: object.member("id")))
    from = try object["from"].map { try RecordID(json: $0) }
    born = try object["born"].map { try Stamp(json: $0) }
    fields = try JSON.map(object["f"]) { try Stamp(json: $0) }
  }

  // Every stamp the map gives: the born, then each field's.
  public var stamps: [Stamp] { [born].compactMap { $0 } + fields.values }
}

// D-16 the server's one final answer for an intent.
public struct PushResult: Sendable, Hashable {
  public enum Verdict: Sendable, Hashable {
    case ok(seq: Int64, write: [WriteMapEntry]?)
    case refused(RefusalCode)
  }

  public let n: Int64
  public let verdict: Verdict
  public let detail: JSON?

  public init(json: JSON) throws {
    let object = try json.asObject()
    n = try object.member("n").asInteger()
    detail = object["detail"]
    switch try object.member("s").asString() {
    case "ok":
      verdict = .ok(seq: try object.member("seq").asInteger(), write: try object["write"]?.asArray().map { try WriteMapEntry(json: $0) })
    case "refused":
      verdict = .refused(RefusalCode(try object.member("code").asString()))
    case let other:
      throw JSONError.shape("\(other) is not a result")
    }
  }
}

public struct PushResponse: Sendable, Hashable {
  public let serverTime: Int64
  public let epoch: String
  public let lastN: Int64
  public let results: [PushResult]
  public let retry: Retry?

  // `retry {n, retryAfterMs}`: the server stopped before `n` (§6.2 step 5, §6.6).
  public struct Retry: Sendable, Hashable {
    public let n: Int64
    public let retryAfterMs: Int64
  }

  public init(json: JSON) throws {
    serverTime = try json.member("serverTime").asInteger()
    epoch = try json.member("epoch").asString()
    lastN = try json.member("lastN").asInteger()
    results = try json.member("results").asArray().map { try PushResult(json: $0) }.sorted { $0.n < $1.n }
    retry = try json["retry"].map { Retry(n: try $0.member("n").asInteger(), retryAfterMs: try $0.member("retryAfterMs").asInteger()) }
  }

  public static func == (lhs: PushResponse, rhs: PushResponse) -> Bool {
    lhs.serverTime == rhs.serverTime && lhs.epoch.utf8.elementsEqual(rhs.epoch.utf8) && lhs.lastN == rhs.lastN
      && lhs.results == rhs.results && lhs.retry == rhs.retry
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(serverTime)
    hasher.combine(Array(epoch.utf8))
    hasher.combine(lastN)
    hasher.combine(results)
    hasher.combine(retry)
  }
}

// MARK: - Pull

public struct PullRequest: Sendable, Hashable, RequestBody {
  // One scope and the cursor it is pulled from; nil boots it.
  public struct Pulled: Sendable, Hashable {
    public let scope: ScopeRef
    public let cursor: String?

    public init(scope: ScopeRef, cursor: String?) {
      self.scope = scope
      self.cursor = cursor
    }

    public static func == (lhs: Pulled, rhs: Pulled) -> Bool {
      lhs.scope == rhs.scope && lhs.cursor.map { Array($0.utf8) } == rhs.cursor.map { Array($0.utf8) }
    }

    public func hash(into hasher: inout Hasher) {
      hasher.combine(scope)
      hasher.combine(cursor.map { Array($0.utf8) })
    }
  }

  public let scopes: [Pulled]

  public init(scopes: [Pulled]) {
    self.scopes = scopes
  }

  public var json: JSON {
    ["scopes": .array(scopes.map { ["scope": $0.scope.json, "cursor": $0.cursor.map { .string($0) } ?? .null] })]
  }
}

// §9.4 one scope's page: rows under a cursor, or a reset, gone or not-found answer.
public struct PullPage: Sendable, Hashable {
  public enum Body: Sendable, Hashable {
    case rows(RowsPage)
    case reset
    case gone
    case notFound
  }

  public let scope: ScopeRef
  public let body: Body

  public init(scope: ScopeRef, body: Body) {
    self.scope = scope
    self.body = body
  }

  public init(json: JSON) throws {
    scope = try ScopeRef(json: json.member("scope"))
    switch try json.member("kind").asString() {
    case "rows": body = .rows(try RowsPage(json: json))
    case "reset": body = .reset
    case "gone": body = .gone
    case "not-found": body = .notFound
    case let other: throw JSONError.shape("\(other) is not a page kind")
    }
  }
}

public struct RowsPage: Sendable, Hashable {
  public let rows: [Row]
  public let cursor: String
  public let more: Bool
  public let seq: Int64
  public let digest: ScopeDigest

  public init(rows: [Row], cursor: String, more: Bool, seq: Int64, digest: ScopeDigest) {
    self.rows = rows
    self.cursor = cursor
    self.more = more
    self.seq = seq
    self.digest = digest
  }

  public init(json: JSON) throws {
    self.init(
      rows: try json.member("rows").asArray().map { try Row(json: $0) },
      cursor: try json.member("cursor").asString(),
      more: try json.member("more").asBool(),
      seq: try json.member("seq").asInteger(),
      digest: try ScopeDigest(hex: json.member("digest").asString()))
  }

  public static func == (lhs: RowsPage, rhs: RowsPage) -> Bool {
    lhs.rows == rhs.rows && lhs.cursor.utf8.elementsEqual(rhs.cursor.utf8) && lhs.more == rhs.more && lhs.seq == rhs.seq
      && lhs.digest == rhs.digest
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(rows)
    hasher.combine(Array(cursor.utf8))
    hasher.combine(more)
    hasher.combine(seq)
    hasher.combine(digest)
  }
}

public struct PullResponse: Sendable, Hashable {
  public let serverTime: Int64
  public let epoch: String
  public let pages: [PullPage]

  public init(json: JSON) throws {
    serverTime = try json.member("serverTime").asInteger()
    epoch = try json.member("epoch").asString()
    pages = try json.member("pages").asArray().map { try PullPage(json: $0) }
  }

  public static func == (lhs: PullResponse, rhs: PullResponse) -> Bool {
    lhs.serverTime == rhs.serverTime && lhs.epoch.utf8.elementsEqual(rhs.epoch.utf8) && lhs.pages == rhs.pages
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(serverTime)
    hasher.combine(Array(epoch.utf8))
    hasher.combine(pages)
  }
}

// MARK: - Live

// §9.5 a message to the server: follow scopes, stop following them, or ask for a `pong`.
public enum LiveRequest: Sendable, Hashable {
  case sub([ScopeRef])
  case unsub([ScopeRef])
  case ping

  public init(json: JSON) throws {
    switch try json.member("op").asString() {
    case "sub": self = .sub(try json.member("scopes").asArray().map { try ScopeRef(json: $0) })
    case "unsub": self = .unsub(try json.member("scopes").asArray().map { try ScopeRef(json: $0) })
    case "ping": self = .ping
    case let other: throw JSONError.shape("\(other) is not a live request")
    }
  }

  public var json: JSON {
    switch self {
    case .sub(let scopes): ["op": "sub", "scopes": .array(scopes.map(\.json))]
    case .unsub(let scopes): ["op": "unsub", "scopes": .array(scopes.map(\.json))]
    case .ping: ["op": "ping"]
    }
  }
}

// §9.5 a frame from the server; an op the engine does not know (presence) is `other` and ignored.
public enum LiveFrame: Sendable, Hashable {
  case change(ChangeFrame)
  case gone(ScopeRef)
  case notFound(ScopeRef)
  case pong
  case other(String)

  public init(json: JSON) throws {
    switch try json.member("op").asString() {
    case "change": self = .change(try ChangeFrame(json: json))
    case "gone": self = .gone(try ScopeRef(json: json.member("scope")))
    case "not-found": self = .notFound(try ScopeRef(json: json.member("scope")))
    case "pong": self = .pong
    case let other: self = .other(other)
    }
  }

  // The scope a change, gone or not-found frame names.
  public var scope: ScopeRef? {
    switch self {
    case .change(let change): change.scope
    case .gone(let scope), .notFound(let scope): scope
    case .pong, .other: nil
    }
  }

  public static func == (lhs: LiveFrame, rhs: LiveFrame) -> Bool {
    switch (lhs, rhs) {
    case (.change(let a), .change(let b)): a == b
    case (.gone(let a), .gone(let b)), (.notFound(let a), .notFound(let b)): a == b
    case (.pong, .pong): true
    case (.other(let a), .other(let b)): a.utf8.elementsEqual(b.utf8)
    default: false
    }
  }

  public func hash(into hasher: inout Hasher) {
    switch self {
    case .change(let frame): hasher.combine(frame)
    case .gone(let scope), .notFound(let scope): hasher.combine(scope)
    case .pong: hasher.combine(0)
    case .other(let op): hasher.combine(Array(op.utf8))
    }
  }
}

public struct ChangeFrame: Sendable, Hashable {
  public let scope: ScopeRef
  public let epoch: String
  public let seq: Int64
  public let digest: ScopeDigest
  public let rows: [Row]?

  public init(json: JSON) throws {
    scope = try ScopeRef(json: json.member("scope"))
    epoch = try json.member("epoch").asString()
    seq = try json.member("seq").asInteger()
    digest = try ScopeDigest(hex: json.member("digest").asString())
    rows = try json["rows"]?.asArray().map { try Row(json: $0) }
  }

  public static func == (lhs: ChangeFrame, rhs: ChangeFrame) -> Bool {
    lhs.scope == rhs.scope && lhs.epoch.utf8.elementsEqual(rhs.epoch.utf8) && lhs.seq == rhs.seq && lhs.digest == rhs.digest
      && lhs.rows == rhs.rows
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(scope)
    hasher.combine(Array(epoch.utf8))
    hasher.combine(seq)
    hasher.combine(digest)
    hasher.combine(rows)
  }
}
