import Foundation
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
  static let startMs: Int64 = 1_700_000_000_000

  let clock: SimClock
  let random: QueuedRandom
  let transport: ScriptedTransport
  let tokens: InMemoryTokenStore
  let forkGuard: InMemoryForkGuardStore
  let connectivity: SwitchedConnectivity
  let store: Store
  let engine: SyncEngine

  // `account`: a replica bound to it before the engine starts, whose token is `token`.
  init(account: String? = nil, token: SessionToken? = SessionToken("token-1"), registry: Registry = Rig.probe,
       limits: Limits = Limits(), drivesLoops: Bool = false, bindings: [any ProductBinding] = [],
       crashPoints: CrashPoints = .none) throws {
    clock = SimClock(wallMs: Self.startMs)
    random = QueuedRandom(seed: 7)
    transport = ScriptedTransport()
    tokens = InMemoryTokenStore(account.flatMap { account in token.map { [account: $0] } } ?? [:])
    forkGuard = InMemoryForkGuardStore()
    connectivity = SwitchedConnectivity()
    store = try Store.inMemory(registry: registry, limits: limits, crashPoints: crashPoints)
    if let account {
      let identities = Identities(random: SeededRandomSource(seed: 11))
      _ = try store.firstLaunch(identities: identities)
      _ = try store.signIn(account: account, holdsRecords: [:], decisions: [:], identities: identities)
    }
    engine = try Rig.engine(over: store, clock: clock, random: random, transport: transport, tokens: tokens,
                            forkGuard: forkGuard, connectivity: connectivity, drivesLoops: drivesLoops, bindings: bindings)
  }

  // Another process over the same store: the engine as a relaunch builds it.
  func relaunch() throws -> SyncEngine {
    try Rig.engine(over: store, clock: clock, random: random, transport: transport, tokens: tokens, forkGuard: forkGuard,
                   connectivity: connectivity, drivesLoops: false, bindings: [])
  }

  static func engine(over store: Store, clock: SimClock, random: QueuedRandom, transport: ScriptedTransport,
                     tokens: InMemoryTokenStore, forkGuard: InMemoryForkGuardStore, connectivity: SwitchedConnectivity,
                     drivesLoops: Bool, bindings: [any ProductBinding]) throws -> SyncEngine {
    try SyncEngine(
      config: EngineConfig(appVersion: "1.0", surface: .ios, drivesLoops: drivesLoops), bindings: bindings, store: store,
      transport: transport, tokens: tokens, forkGuard: forkGuard, clock: clock.engineClock, random: random,
      connectivity: connectivity)
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

  @discardableResult
  func commit(_ gesture: Gesture, in scope: ScopeRef = Rig.scope) throws -> CommitReceipt {
    guard case .committed(let receipt) = try engine.commit(scope, gesture) else { throw RigError("the commit was refused") }
    return receipt
  }

  // MARK: Push answers (§9.3)

  static func ok(lastN: Int64, _ results: [JSON], serverTime: Int64 = startMs, epoch: String = "ep-1", retry: JSON? = nil) -> JSON {
    var body: JSON.Object = ["serverTime": JSON(serverTime), "epoch": .string(epoch), "lastN": JSON(lastN), "results": .array(results)]
    body["retry"] = retry
    return .object(body)
  }

  static func admitted(_ n: Int64, seq: Int64) -> JSON { ["n": JSON(n), "s": "ok", "seq": JSON(seq)] }
  static func refused(_ n: Int64, _ code: String) -> JSON { ["n": JSON(n), "s": "refused", "code": .string(code)] }
  static func failure(_ error: String, serverTime: Int64 = startMs) -> JSON {
    ["error": .string(error), "serverTime": JSON(serverTime), "epoch": "ep-1"]
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

// Polls until `condition` holds, for the tests that run the real loops; it runs on the caller's actor.
func eventually(_ what: String, within seconds: Double = 5, isolation: isolated (any Actor)? = #isolation,
                _ condition: () throws -> Bool) async throws {
  let deadline = Date().addingTimeInterval(seconds)
  while try !condition() {
    guard Date() < deadline else { throw RigError("timed out waiting for \(what)") }
    try await Task.sleep(for: .milliseconds(2))
  }
}
