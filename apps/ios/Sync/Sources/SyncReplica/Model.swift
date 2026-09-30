import SyncAPI
import SyncCore

// §2.5 the client's local store table by table, each record in the JSON form the stored blobs and the corpus share, and
// equal only when that form is, byte for byte.

// MARK: - Device and replica meta

public struct DeviceMeta: Sendable, Hashable {
  public var forkGuard: String?
  public var pendingSignIn: String?

  // `pendingSignIn`: the account of an incomplete sign-in, resumed at the next engine start (§7.10).
  public init(forkGuard: String? = nil, pendingSignIn: String? = nil) {
    self.forkGuard = forkGuard
    self.pendingSignIn = pendingSignIn
  }

  public init(json: JSON?) throws {
    forkGuard = try json?["forkGuard"]?.asString()
    pendingSignIn = try json?["pendingSignIn"]?.member("account").asString()
  }

  public var json: JSON {
    var object = JSON.Object()
    object["forkGuard"] = forkGuard.map { .string($0) }
    object["pendingSignIn"] = pendingSignIn.map { ["account": .string($0)] }
    return .object(object)
  }

  public static func == (lhs: DeviceMeta, rhs: DeviceMeta) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

public struct ReplicaMeta: Sendable, Hashable {
  public enum State: String, Sendable, Hashable {
    case anon, bound, dormant
  }

  public var replica: String
  public var state: State
  public var account: String?
  public var nextN: Int64
  public var hlc: HLC
  public var hlcHigh: Stamp
  public var admittedHigh: Stamp
  public var serverOffsetMs: Int64
  public var offset: ServerOffset
  public var serverEpoch: String?
  public var ackThrough: Int64
  public var authPaused: Bool

  // A new replica: numbered from 1, its clock and offset unset (corpus/README.md "Client steps").
  public init(replica: String, state: State, account: String? = nil) {
    self.replica = replica
    self.state = state
    self.account = account
    nextN = 1
    hlc = HLC()
    hlcHigh = .unset
    admittedHigh = .unset
    serverOffsetMs = 0
    offset = ServerOffset()
    serverEpoch = nil
    ackThrough = 0
    authPaused = false
  }

  // D-27: the account entries are committed under, or `anon`.
  public var lineage: String { state == .anon ? "anon" : account ?? "anon" }

  public var node: ReplicaNode { ReplicaNode(rawValue: state.rawValue)! }

  // §10.2 physNow() at a device time.
  public func physNow(deviceNow: Int64) -> Int64 { deviceNow + serverOffsetMs }

  // §10.2 observe() over stamps the replica receives: the clock and hlcHigh rise to the greatest.
  public mutating func observe(_ stamps: [Stamp]) {
    for stamp in stamps {
      hlc.observe(stamp)
      hlcHigh = max(hlcHigh, stamp)
    }
  }

  // §2.5 admittedHigh: the greatest stamp in any row the server sent or in an acked entry.
  public mutating func admit(_ stamps: [Stamp]) {
    for stamp in stamps { admittedHigh = max(admittedHigh, stamp) }
  }

  // §10.4 one response's offset sample; a request that straddles a clock jump takes none.
  public mutating func sample(serverTime: Int64, send: ClockReading, recv: ClockReading) {
    if offset.take(serverTime: serverTime, send: send, recv: recv) { serverOffsetMs = offset.ms }
  }

  public init(json: JSON) throws {
    let object = try json.asObject()
    replica = try object.member("replica").asString()
    guard let state = State(rawValue: try object.member("state").asString()) else { throw JSONError.shape("not a replica state") }
    self.state = state
    account = try object["account"]?.asString()
    nextN = try object.member("nextN").asInteger()
    hlc = try HLC(json: object.member("hlc"))
    hlcHigh = try Stamp(json: object.member("hlcHigh"))
    admittedHigh = try Stamp(json: object.member("admittedHigh"))
    serverOffsetMs = try object.member("serverOffsetMs").asInteger()
    offset = ServerOffset(
      samples: try object.member("offsetSamples").asArray().map { try ServerOffset.Sample(json: $0) },
      clockReading: try object["clockReading"].map { try ClockReading(json: $0) })
    let epoch = try object.member("serverEpoch")
    serverEpoch = epoch.isNull ? nil : try epoch.asString()
    ackThrough = try object.member("ackThrough").asInteger()
    authPaused = try object.member("authPaused").asBool()
  }

  public var json: JSON {
    var object: JSON.Object = [
      "replica": .string(replica), "state": .string(state.rawValue), "nextN": JSON(nextN), "hlc": hlc.json,
      "hlcHigh": hlcHigh.json, "admittedHigh": admittedHigh.json, "serverOffsetMs": JSON(serverOffsetMs),
      "offsetSamples": .array(offset.samples.map(\.json)), "serverEpoch": serverEpoch.map { .string($0) } ?? .null,
      "ackThrough": JSON(ackThrough), "authPaused": .bool(authPaused),
    ]
    object["account"] = account.map { .string($0) }
    object["clockReading"] = offset.clockReading?.json
    return .object(object)
  }

  public static func == (lhs: ReplicaMeta, rhs: ReplicaMeta) -> Bool { lhs.json == rhs.json && lhs.offset == rhs.offset }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// MARK: - Outbox

// A text field of one record: the key `baseTexts` stores the text it was edited from under, jcs([t, id, field]).
public struct TextRef: Sendable, Hashable, Comparable {
  public let key: RecordKey
  public let field: String

  public init(_ key: RecordKey, _ field: String) {
    self.key = key
    self.field = field
  }

  public init(text: String) throws {
    let parts = try JSON(parsing: text).asArray()
    guard parts.count == 3 else { throw JSONError.shape("a base text key is [t, id, field]") }
    self.init(RecordKey(try parts[0].asString(), try RecordID(json: parts[1])), try parts[2].asString())
  }

  public var text: String { JSON.array([.string(key.type), key.id.json, .string(field)]).jcsText }

  public static func == (lhs: TextRef, rhs: TextRef) -> Bool { lhs.key == rhs.key && lhs.field.utf8.elementsEqual(rhs.field.utf8) }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(key)
    hasher.combine(Array(field.utf8))
  }

  public static func < (lhs: TextRef, rhs: TextRef) -> Bool { lhs.text.utf8.lexicographicallyPrecedes(rhs.text.utf8) }
}

// §2.5 one intent in the outbox; `n` lives in the intent, set iff sent or acked.
public struct OutboxEntry: Sendable, Hashable {
  public var localId: String
  public var gestureId: String
  public var lineage: String
  public var scope: ScopeRef
  public var state: EntryState
  public var commitOrder: Int64
  public var releaseAt: Int64
  public var stamp: Stamp
  public var intent: Intent
  public var predict: [Delta]
  public var baseTexts: [TextRef: String]
  public var digest: String?
  public var resultSeq: Int64?
  public var resultEpoch: String?
  public var orphanOf: String?

  public init(localId: String, gestureId: String, lineage: String, scope: ScopeRef, state: EntryState, commitOrder: Int64,
              releaseAt: Int64, stamp: Stamp, intent: Intent, predict: [Delta] = [], baseTexts: [TextRef: String] = [:]) {
    self.localId = localId
    self.gestureId = gestureId
    self.lineage = lineage
    self.scope = scope
    self.state = state
    self.commitOrder = commitOrder
    self.releaseAt = releaseAt
    self.stamp = stamp
    self.intent = intent
    self.predict = predict
    self.baseTexts = baseTexts
  }

  public var n: Int64? { intent.n }

  // Held or ready: not yet on the wire, so every part of it is rewritable.
  public var isQueued: Bool { state == .held || state == .ready }

  // The intent's deltas, then the prediction's: everything the entry draws (§7.6).
  public var drawnDeltas: [Delta] { intent.deltas + predict }

  public func touches(_ key: RecordKey) -> Bool { drawnDeltas.contains { $0.key == key } }

  // What a notice holds of this entry: its deltas and its command.
  public var content: NoticeContent { NoticeContent(deltas: intent.deltas, command: intent.command) }

  public init(json: JSON) throws {
    let object = try json.asObject()
    guard let state = EntryState(rawValue: try object.member("state").asString()) else { throw JSONError.shape("not an entry state") }
    self.init(
      localId: try object.member("localId").asString(), gestureId: try object.member("gestureId").asString(),
      lineage: try object.member("lineage").asString(), scope: try ScopeRef(json: object.member("scope")), state: state,
      commitOrder: try object.member("commitOrder").asInteger(), releaseAt: try object.member("releaseAt").asInteger(),
      stamp: try Stamp(json: object.member("stamp")), intent: try Intent(json: object.member("intent")),
      predict: try object["predict"]?.asArray().map { try Delta(json: $0) } ?? [],
      baseTexts: Dictionary(uniqueKeysWithValues: try (object["baseTexts"]?.asObject().members ?? []).map {
        (try TextRef(text: $0.key), try $0.value.asString())
      }))
    digest = try object["digest"]?.asString()
    resultSeq = try object["resultSeq"].map { try $0.asInteger() }
    resultEpoch = try object["resultEpoch"]?.asString()
    orphanOf = try object["orphanOf"]?.asString()
  }

  public var json: JSON {
    var object: JSON.Object = [
      "localId": .string(localId), "gestureId": .string(gestureId), "lineage": .string(lineage), "scope": scope.json,
      "state": .string(state.rawValue), "commitOrder": JSON(commitOrder), "releaseAt": JSON(releaseAt), "stamp": stamp.json,
      "intent": intent.json,
    ]
    object["predict"] = predict.isEmpty ? nil : .array(predict.map(\.json))
    object["baseTexts"] = baseTexts.isEmpty ? nil : .object(JSON.Object(uniqueKeysWithValues: baseTexts.map { ($0.key.text, .string($0.value)) }))
    object["n"] = n.map { JSON($0) }
    object["digest"] = digest.map { .string($0) }
    object["resultSeq"] = resultSeq.map { JSON($0) }
    object["resultEpoch"] = resultEpoch.map { .string($0) }
    object["orphanOf"] = orphanOf.map { .string($0) }
    return .object(object)
  }

  public static func == (lhs: OutboxEntry, rhs: OutboxEntry) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// MARK: - Scopes: cursors, staging, spent ids, known scopes

public struct CursorRecord: Sendable, Hashable {
  public var cursor: String?
  public var digest: ScopeDigest
  public var booted: Bool
  public var behind: Bool
  public var mismatchReset: Bool
  public var digestStop: String?

  // `cursor` nil boots at the next pull; `digest` is the §6.12 sum of the scope's confirmed rows; `behind` is §2.5's.
  public init(cursor: String? = nil, digest: ScopeDigest = .zero, booted: Bool = false, behind: Bool = false,
              mismatchReset: Bool = false, digestStop: String? = nil) {
    self.cursor = cursor
    self.digest = digest
    self.booted = booted
    self.behind = behind
    self.mismatchReset = mismatchReset
    self.digestStop = digestStop
  }

  public init(json: JSON) throws {
    let cursor = try json.member("cursor")
    self.init(
      cursor: cursor.isNull ? nil : try cursor.asString(), digest: try ScopeDigest(hex: json.member("digest").asString()),
      booted: try json.member("booted").asBool(), behind: try json["behind"]?.asBool() ?? false,
      mismatchReset: try json["mismatchReset"]?.asBool() ?? false, digestStop: try json["digestStop"]?.asString())
  }

  public var json: JSON {
    var object: JSON.Object = ["cursor": cursor.map { .string($0) } ?? .null, "digest": .string(digest.hex), "booted": .bool(booted)]
    object["behind"] = behind ? true : nil
    object["mismatchReset"] = mismatchReset ? true : nil
    object["digestStop"] = digestStop.map { .string($0) }
    return .object(object)
  }

  public static func == (lhs: CursorRecord, rhs: CursorRecord) -> Bool { lhs.json == rhs.json }
  public func hash(into hasher: inout Hasher) { hasher.combine(json) }
}

// A boot filling rows beside the confirmed ones, with its own digest, until the swap (§7.5).
public struct Staging: Sendable, Hashable {
  public var digest: ScopeDigest
  public var rows: Rows

  public init(digest: ScopeDigest = .zero, rows: Rows = Rows()) {
    self.digest = digest
    self.rows = rows
  }
}

// §2.5 a spent id of a derived type, with the born its dead row carried.
public struct SpentID: Sendable, Hashable {
  public let key: RecordKey
  public let born: Stamp

  public init(key: RecordKey, born: Stamp) {
    self.key = key
    self.born = born
  }

  public init(json: JSON) throws {
    self.init(key: RecordKey(try json.member("t").asString(), try RecordID(json: json.member("id"))), born: try Stamp(json: json.member("born")))
  }

  public var json: JSON { ["t": .string(key.type), "id": key.id.json, "born": born.json] }
}

// One record of one scope, the same only byte for byte: what dependents, held-back numbering and anon counts key by.
struct ScopedKey: Hashable {
  let scope: ScopeRef
  let key: RecordKey
}

// A tree or overlay scope the replica learned is gone or not found (§7.5), which §7.1 step 2 refuses.
public enum KnownKind: String, Sendable, Hashable {
  case gone
  case notFound = "not-found"
}

// One scope's rows as an Action loaded them: every row, or the rows of some keys and some whole types. Reading a row
// the load did not cover is a loader bug, and traps.
public struct Rows: Sendable, Hashable {
  public enum Coverage: Sendable, Hashable {
    case all
    case some(keys: Set<RecordKey>, types: Set<String>, empty: Bool)
  }

  public private(set) var loaded: [RecordKey: Row]
  public private(set) var coverage: Coverage

  // Every row of the scope.
  public init(_ rows: [Row] = []) {
    loaded = Dictionary(uniqueKeysWithValues: rows.map { ($0.key, $0) })
    coverage = .all
  }

  // The rows of `keys` and of `types`; `empty` says whether the scope holds no row at all.
  public init(loaded rows: [Row], keys: Set<RecordKey>, types: Set<String>, empty: Bool) {
    loaded = Dictionary(uniqueKeysWithValues: rows.map { ($0.key, $0) })
    coverage = .some(keys: keys, types: types, empty: empty)
  }

  public func covers(_ key: RecordKey) -> Bool {
    switch coverage {
    case .all: true
    case .some(let keys, let types, _): keys.contains(key) || types.contains(key.type)
    }
  }

  public func covers(type: String) -> Bool {
    switch coverage {
    case .all: true
    case .some(_, let types, _): types.contains(type)
    }
  }

  public func row(_ key: RecordKey) -> Row? {
    precondition(covers(key), "\(key) was read but not loaded")
    return loaded[key]
  }

  public func rows(ofType type: String) -> [Row] {
    precondition(covers(type: type), "the rows of \(type) were read but not loaded")
    return loaded.values.filter { $0.key.type.utf8.elementsEqual(type.utf8) }.sorted { $0.key < $1.key }
  }

  // Every row of the scope, in record order.
  public var all: [Row] {
    precondition(coverage == .all, "every row was read but not every row was loaded")
    return loaded.values.sorted { $0.key < $1.key }
  }

  public var isEmpty: Bool {
    switch coverage {
    case .all: loaded.isEmpty
    case .some(_, _, let empty): empty && loaded.isEmpty
    }
  }

  // A written row is known, present or absent, whatever the load covered.
  mutating func put(_ row: Row) {
    loaded[row.key] = row
    learn(row.key)
  }

  mutating func remove(_ key: RecordKey) {
    loaded[key] = nil
    learn(key)
  }

  mutating func learn(_ key: RecordKey) {
    guard case .some(var keys, let types, let empty) = coverage else { return }
    keys.insert(key)
    coverage = .some(keys: keys, types: types, empty: empty && loaded.isEmpty)
  }
}

// What a planner reads of one scope's rows, so its Action loads exactly that: some records and some whole types, or
// every row. The outbox entries that touch the records it covers load with them (`EntrySelection`).
public struct RowSelection: Sendable, Hashable {
  public var keys: Set<RecordKey>
  public var types: Set<String>
  public var all: Bool

  public init(keys: Set<RecordKey> = [], types: Set<String> = [], all: Bool = false) {
    self.keys = keys
    self.types = types
    self.all = all
  }

  // What either selection reads.
  public func union(_ other: RowSelection) -> RowSelection {
    RowSelection(keys: keys.union(other.keys), types: types.union(other.types), all: all || other.all)
  }
}

// What a planner reads of one replica's outbox, so its Action loads exactly that: every entry, or the entries that touch
// a record its row reads cover, with every entry of the held gestures and the sent entries of some numbers.
public struct EntrySelection: Sendable, Hashable {
  public var all: Bool
  public var heldGestures: Bool
  public var numbered: Set<Int64>

  public init(all: Bool = false, heldGestures: Bool = false, numbered: Set<Int64> = []) {
    self.all = all
    self.heldGestures = heldGestures
    self.numbered = numbered
  }

  public static let every = EntrySelection(all: true)
}

// MARK: - Events

// What a planner reports beside its writes: intents that ended, telemetry, and §7.12's change of the active replica.
public enum EngineEvent: Sendable, Hashable {
  // `orphanOf`: the refused entry whose notice holds this entry's content.
  case ended(localId: String, outcome: Outcome, event: IntentEvent, orphanOf: String?)
  // `kind`: product, tree or overlay; no row content.
  case digestMismatch(kind: String, seq: Int64)
  case pushMalformed
  // `activeReplica()` answers `replica` where it answered `previous`; not durable.
  case activeReplicaChanged(previous: String, replica: String)

  public var json: JSON {
    switch self {
    case .ended(let localId, let outcome, let event, let orphanOf):
      var object: JSON.Object = ["localId": .string(localId), "outcome": .string(outcome.rawValue), "event": .string(event.rawValue)]
      object["orphanOf"] = orphanOf.map { .string($0) }
      return .object(object)
    case .digestMismatch(let kind, let seq): return ["event": "sync-digest-mismatch", "kind": .string(kind), "seq": JSON(seq)]
    case .pushMalformed: return ["event": "sync-push-malformed"]
    case .activeReplicaChanged(let previous, let replica):
      return ["event": "activeReplicaChanged", "previous": .string(previous), "replica": .string(replica)]
    }
  }

  public var isEnded: Bool {
    if case .ended = self { return true }
    return false
  }

  public var isTelemetry: Bool {
    switch self {
    case .digestMismatch, .pushMalformed: true
    case .ended, .activeReplicaChanged: false
    }
  }
}

// MARK: - Notices as stored

extension NoticeContent {
  public init(json: JSON) throws {
    self.init(
      deltas: try json["d"]?.asArray().map { try Delta(json: $0) } ?? [],
      command: try json["cmd"].map { try Command(json: $0) },
      dependents: try json["dependents"]?.asArray().map { try NoticeContent(json: $0) } ?? [])
  }

  public var json: JSON {
    var object = JSON.Object()
    object["d"] = deltas.isEmpty ? nil : .array(deltas.map(\.json))
    object["cmd"] = command?.json
    object["dependents"] = dependents.isEmpty ? nil : .array(dependents.map(\.json))
    return .object(object)
  }

  public var isEmpty: Bool { deltas.isEmpty && command == nil }
}

extension Notice {
  // The stored form names no product; the registry gives it from the scope. `dismissed` appears only when true.
  public init(json: JSON, registry: Registry) throws {
    let scope = try ScopeRef(json: json.member("scope"))
    guard let product = registry.product(of: scope) else { throw JSONError.shape("\(scope) belongs to no product") }
    self.init(
      id: try json.member("id").asString(), product: product, scope: scope, code: RefusalCode(try json.member("code").asString()),
      detail: json["detail"], content: try NoticeContent(json: json.member("content")), at: try json.member("at").asInteger(),
      isDismissed: try json["dismissed"]?.asBool() ?? false)
  }

  public var storedJSON: JSON {
    var object: JSON.Object = ["id": .string(id), "scope": scope.json, "code": code.json, "content": content.json, "at": JSON(at)]
    object["detail"] = detail
    object["dismissed"] = isDismissed ? true : nil
    return .object(object)
  }

  // The gesture of the entry a notice holds: its id is `notice:<gestureId>/<k>`.
  public static func gestureId(ofNotice id: String) -> String? {
    let bytes = id.utf8
    guard bytes.starts(with: "notice:".utf8), let slash = bytes.lastIndex(of: UInt8(ascii: "/")) else { return nil }
    return String(decoding: bytes[bytes.index(bytes.startIndex, offsetBy: "notice:".utf8.count)..<slash], as: UTF8.self)
  }

  // D-17: the same notice, hidden from its product's list.
  public var dismissed: Notice {
    Notice(id: id, product: product, scope: scope, code: code, detail: detail, content: content, at: at, isDismissed: true)
  }
}

// MARK: - What planners are given

// A planner's bounds; `chunkRows` and `resultsPerBatch` size a page's chunks and a push answer's batches (§2.5 the writer).
public struct Limits: Sendable, Hashable {
  public var holdMs: Int64
  public var pushMaxIntents: Int
  public var pushMaxBytes: Int
  public var chunkRows: Int
  public var resultsPerBatch: Int

  public init(holdMs: Int64 = Constants.holdMs, pushMaxIntents: Int = Constants.pushMaxIntents,
              pushMaxBytes: Int = Constants.pushMaxBytes, chunkRows: Int = 100, resultsPerBatch: Int = 16) {
    self.holdMs = holdMs
    self.pushMaxIntents = pushMaxIntents
    self.pushMaxBytes = pushMaxBytes
    self.chunkRows = chunkRows
    self.resultsPerBatch = resultsPerBatch
  }
}

// The engine instance a planner acts for: its actor (D-2), the device's wall clock now, and the app version.
public struct Instance: Sendable, Hashable {
  public var actor: Stamp.Actor
  public var deviceNow: Int64
  public var appVersion: String

  public init(actor: Stamp.Actor, deviceNow: Int64, appVersion: String) {
    self.actor = actor
    self.deviceNow = deviceNow
    self.appVersion = appVersion
  }
}

public protocol RandomSource: Sendable {
  // 64 uniformly random bits; the engine's only randomness.
  func next() -> UInt64
}

// A source as the standard library's generator, for uniform draws in a range.
package struct Draws: RandomNumberGenerator {
  let source: any RandomSource

  package init(source: any RandomSource) {
    self.source = source
  }

  package mutating func next() -> UInt64 { source.next() }
}

// Every new identity a planner mints: CSPRNG draws for ids (D-8), gesture and replica ids, actors and fork guards.
public protocol IdentitySource: AnyObject {
  // A uniform integer below `bound`.
  func draw(below bound: Int) throws -> Int
  func gestureID() throws -> String
  func replicaID() throws -> String
  func actor() throws -> Stamp.Actor
  func forkGuard() throws -> String
}
