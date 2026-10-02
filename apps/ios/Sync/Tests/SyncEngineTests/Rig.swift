import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import SyncStore
import SyncTesting
import Synchronization

// One device's engine over an in-memory store of the probe registry, every port a double the test drives. In step mode
// unless asked: no loop runs, and the test steps the sender and the release timer itself.
struct Rig {
  static let probe = try! Corpus.probeRegistry()
  static let scope = ScopeRef.product("probe")

  // A product whose items name their list by an lww ref, so a pending write can move a reference.
  static let shelf = try! Registry(json: JSON(parsing: """
    {"registry": "shelf", "version": 1, "minVersion": 1, "products": {"shelf": {"surfaces": ["ios"]}}, "commands": [],
     "types": [
       {"type": "list", "scope": "product:shelf", "identity": "minted", "idSpace": "global", "idPattern": "^l_[a-z]{4}$",
        "mint": {"prefix": "l_", "alphabet": "abcdefghijklmnopqrstuvwxyz", "length": 4}, "life": true, "revivable": false,
        "deadRows": "spent", "origins": ["replica"], "primary": true, "fields": {}},
       {"type": "item", "scope": "product:shelf", "identity": "minted", "idSpace": "global", "idPattern": "^i_[a-z]{4}$",
        "mint": {"prefix": "i_", "alphabet": "abcdefghijklmnopqrstuvwxyz", "length": 4}, "life": true, "revivable": false,
        "deadRows": "spent", "origins": ["replica"], "primary": true,
        "fields": {"listId": {"kind": "lww", "writer": "client", "ref": "list", "domain": {"type": "string"}},
                   "name": {"kind": "lww", "writer": "client", "unit": "chars", "max": 12, "domain": {"type": "string"}}}}
     ]}
    """))

  static let startMs: Int64 = 1_700_000_000_000

  let clock: SimClock
  let random: QueuedRandom
  let transport: ScriptedTransport
  let tokens: InMemoryTokenStore
  let forkGuard: InMemoryForkGuardStore
  let connectivity: SwitchedConnectivity
  let store: Store
  let engine: SyncEngine
  // Every event the engine publishes, in order.
  let events = EventLog()
  let slicing: WriterSlicing

  // `account`: a replica bound to it before the engine starts, whose token is `token`. `path`: a file store there, whose
  // reads run beside its writes, instead of one in memory.
  init(account: String? = nil, token: SessionToken? = SessionToken("token-1"), registry: Registry = Rig.probe,
       limits: Limits = Limits(), slicing: WriterSlicing = .measured, drivesLoops: Bool = false, bindings: [any ProductBinding] = [],
       crashPoints: CrashPoints = .none, path: String? = nil, pendingDeviceWork: @escaping PendingDeviceWork = { _, _ in [] }) throws {
    self.slicing = slicing
    clock = SimClock(wallMs: Self.startMs)
    random = QueuedRandom(seed: 7)
    transport = ScriptedTransport()
    tokens = InMemoryTokenStore(account.flatMap { account in token.map { [account: $0] } } ?? [:])
    forkGuard = InMemoryForkGuardStore()
    connectivity = SwitchedConnectivity()
    store = try path.map { try Store(path: $0, registry: registry, limits: limits, crashPoints: crashPoints, pendingDeviceWork: pendingDeviceWork) }
      ?? Store.inMemory(registry: registry, limits: limits, crashPoints: crashPoints, pendingDeviceWork: pendingDeviceWork)
    if let account {
      let identities = Identities(random: SeededRandomSource(seed: 11))
      _ = try store.firstLaunch(identities: identities)
      _ = try store.signIn(account: account, holdsRecords: [:], decisions: [:], counted: [:], identities: identities)
    }
    engine = try Rig.engine(over: store, clock: clock, random: random, transport: transport, tokens: tokens, forkGuard: forkGuard,
                            connectivity: connectivity, slicing: slicing, drivesLoops: drivesLoops, bindings: bindings, events: events)
  }

  // Another process over the same store: the engine as a relaunch builds it.
  func relaunch() throws -> SyncEngine {
    try Rig.engine(over: store, clock: clock, random: random, transport: transport, tokens: tokens, forkGuard: forkGuard,
                   connectivity: connectivity, slicing: slicing, drivesLoops: false, bindings: [], events: events)
  }

  static func engine(over store: Store, clock: SimClock, random: QueuedRandom, transport: ScriptedTransport,
                     tokens: InMemoryTokenStore, forkGuard: InMemoryForkGuardStore, connectivity: SwitchedConnectivity,
                     slicing: WriterSlicing, drivesLoops: Bool, bindings: [any ProductBinding], events: EventLog) throws -> SyncEngine {
    try SyncEngine(
      config: EngineConfig(appVersion: "1.0", surface: .ios, drivesLoops: drivesLoops, slicing: slicing), bindings: bindings, store: store,
      transport: transport, tokens: tokens, forkGuard: forkGuard, clock: clock.engineClock, random: random,
      identities: Identities(random: random), connectivity: connectivity, tap: { events.append($0) })
  }

  // The changes of the active replica announced so far (§7.12), each as "previous -> replica".
  var announced: [String] {
    events.events.compactMap { event in
      guard case .activeReplicaChanged(let previous, let replica) = event else { return nil }
      return "\(previous) -> \(replica)"
    }
  }

  // MARK: The store as it stands

  func active() throws -> LoadedReplica {
    try store.read { tx in try tx.replica(tx.activeReplica(), notices: true)! }
  }

  func meta() throws -> ReplicaMeta { try active().meta }

  // The active replica's outbox, one line per entry: local id, state and number.
  func outbox() throws -> [String] {
    try active().outbox.map { "\($0.localId) \($0.state.rawValue)\($0.n.map { " \($0)" } ?? "")" }
  }

  // MARK: Gestures

  static func card(_ id: String, _ title: String) -> Change {
    .create("card", id: .given(RecordID(id)), ["title": .string(title)])
  }

  // `count` puts of days from 2026-01-01, 28 days a month, each scored 1.
  static func days(_ count: Int) -> [Change] {
    (0..<count).map { index in
      let (month, day) = (1 + index / 28, 1 + index % 28)
      return .put("day", RecordID("2026-\(month < 10 ? "0" : "")\(month)-\(day < 10 ? "0" : "")\(day)"), present: true, ["score": 1])
    }
  }

  @discardableResult
  func commit(_ gesture: Gesture, in scope: ScopeRef = Rig.scope) throws -> CommitReceipt {
    guard case .committed(let receipt) = try engine.commit(scope, gesture) else { throw RigError("the commit was refused") }
    return receipt
  }

  // MARK: Push answers (§9.3)

  // Every answer and frame says whom it was served as (§9.1): the rig's account A, unless a test says otherwise; nil
  // writes `as: null`, anonymous.
  static func ok(lastN: Int64, _ results: [JSON], serverTime: Int64 = startMs, epoch: String = "ep-1", retry: JSON? = nil,
                 as served: String? = "A") -> JSON {
    var body: JSON.Object = [
      "serverTime": JSON(serverTime), "epoch": .string(epoch), "as": served.map(JSON.string) ?? .null, "lastN": JSON(lastN),
      "results": .array(results),
    ]
    body["retry"] = retry
    return .object(body)
  }

  static func admitted(_ n: Int64, seq: Int64) -> JSON { ["n": JSON(n), "s": "ok", "seq": JSON(seq)] }
  static func refused(_ n: Int64, _ code: String) -> JSON { ["n": JSON(n), "s": "refused", "code": .string(code)] }
  static func failure(_ error: String, serverTime: Int64 = startMs, as served: String? = "A") -> JSON {
    ["error": .string(error), "serverTime": JSON(serverTime), "epoch": "ep-1", "as": served.map(JSON.string) ?? .null]
  }

  // MARK: Pull answers (§9.4)

  static func pulled(_ pages: [JSON], serverTime: Int64 = startMs, epoch: String = "ep-1", as served: String? = "A") -> JSON {
    ["serverTime": JSON(serverTime), "epoch": .string(epoch), "as": served.map(JSON.string) ?? .null, "pages": .array(pages)]
  }

  // A rows page of `scope` ending live at `seq` (or at `cursor`), whose digest is the sum of `digestOf`.
  static func rows(_ rows: [Row] = [], in scope: ScopeRef = Rig.scope, seq: Int64, cursor: String? = nil, more: Bool = false,
                   digestOf alive: [Row]? = nil, epoch: String = "ep-1") -> JSON {
    [
      "scope": scope.json, "kind": "rows", "rows": .array(rows.map(\.json)),
      "cursor": .string(cursor ?? Cursor(epoch: epoch, mode: .live, seq: seq).text), "more": .bool(more), "seq": JSON(seq),
      "digest": .string(ScopeDigest(rows: (alive ?? rows).filter(\.isAlive).map(\.json)).hex),
    ]
  }

  static func page(_ scope: ScopeRef = Rig.scope, _ kind: String) -> JSON {
    ["scope": scope.json, "kind": .string(kind)]
  }

  // A tree's meta row as the server sends it, its title set at `ms`.
  static func metaRow(_ title: String = "Plan", seq: Int64, ms: Int64 = 1_000) throws -> Row {
    try Row(json: [
      "t": "meta", "id": "meta", "f": ["title": [.string(title), .string("\(ms):0:r_server00001")]], "seq": JSON(seq), "rc": JSON(ms),
      "ru": JSON(ms),
    ])
  }

  // §9.5 a change frame of `scope` at `seq`, whose digest is the sum of `digestOf`; `rows` nil leaves them out.
  static func change(_ scope: ScopeRef = Rig.scope, rows: [Row]?, seq: Int64, digestOf alive: [Row], epoch: String = "ep-1",
                     as served: String? = "A") throws -> LiveFrame {
    var frame: JSON.Object = [
      "op": "change", "as": served.map(JSON.string) ?? .null, "scope": scope.json, "epoch": .string(epoch), "seq": JSON(seq),
      "digest": .string(ScopeDigest(rows: alive.filter(\.isAlive).map(\.json)).hex),
    ]
    frame["rows"] = rows.map { .array($0.map(\.json)) }
    return try LiveFrame(json: .object(frame))
  }

  // A card row as the server sends it: born and alive at `ms`, its title set then.
  static func cardRow(_ id: String, _ title: String, seq: Int64, ms: Int64 = 1_000, life: String = "alive") throws -> Row {
    let stamp = "\(ms):0:r_server00001"
    return try Row(json: [
      "t": "card", "id": .string(id), "life": [.string(life), .string(stamp)], "born": .string(stamp),
      "f": ["title": [.string(title), .string(stamp)]], "seq": JSON(seq), "rc": JSON(ms), "ru": JSON(ms),
    ])
  }
}

struct RigError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

// A seeded source that answers queued draws first, so a test can choose the next ids exactly.
final class QueuedRandom: RandomSource {
  let queued = Mutex<[UInt64]>([])
  let seeded: SeededRandomSource

  init(seed: UInt64) {
    seeded = SeededRandomSource(seed: seed)
  }

  // The draws that pick `symbol` below `size`, `count` times over: (symbol + ½) · 2^64 / size, which a uniform draw
  // below `size` maps to `symbol`.
  func queue(symbol: Int, of size: Int, count: Int) {
    let draw = UInt64(size).dividingFullWidth((high: UInt64(symbol), low: 1 << 63)).quotient
    queued.withLock { $0 += Array(repeating: draw, count: count) }
  }

  func queue(raw draw: UInt64, count: Int) {
    queued.withLock { $0 += Array(repeating: draw, count: count) }
  }

  func next() -> UInt64 {
    queued.withLock { $0.isEmpty ? nil : $0.removeFirst() } ?? seeded.next()
  }
}
