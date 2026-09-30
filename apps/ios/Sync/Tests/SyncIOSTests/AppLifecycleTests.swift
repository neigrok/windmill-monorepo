import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncIOS
import SyncStore
import SyncTesting
import Testing

// Leaving the app through the lifecycle's notifications, on a device whose loops do not run: the flush is the only
// thing that pushes, inside background time the test lends and takes back.
@MainActor
struct AppLifecycleTests {
  static let leaving = Notification.Name("test.leaving")
  static let returning = Notification.Name("test.returning")

  let center = NotificationCenter()
  let time = LentTime()
  let transport = ScriptedTransport()
  let store: Store
  let engine: SyncEngine
  let lifecycle: AppLifecycle

  init() throws {
    store = try Store.inMemory(registry: try Corpus.probeRegistry())
    let identities = Identities(random: SeededRandomSource(seed: 11))
    _ = try store.firstLaunch(identities: identities)
    _ = try store.signIn(account: "acct-1", holdsRecords: [:], decisions: [:], counted: [:], identities: identities)
    engine = try SyncEngine(
      config: EngineConfig(appVersion: "1.0", surface: .ios, drivesLoops: false), store: store, transport: transport,
      tokens: InMemoryTokenStore(["acct-1": SessionToken("token-1")]), forkGuard: InMemoryForkGuardStore(),
      clock: SimClock(wallMs: 1_700_000_000_000).engineClock, random: SeededRandomSource(seed: 7), connectivity: SwitchedConnectivity())
    lifecycle = AppLifecycle(
      engine: engine, signals: AppLifecycle.Signals(leaving: Self.leaving, returning: Self.returning), time: time, center: center)
  }

  @Test func leavingReleasesEveryHoldAndPushesItInsideBackgroundTime() async throws {
    try holdCard()
    transport.willAnswerPush(200, Self.admitted)

    center.post(name: Self.leaving, object: nil)
    await lifecycle.leaveFlush?.value

    #expect(try outbox() == ["acked 1"])
    #expect(transport.pushes.map { $0.intents.map(\.n) } == [[1]])
    #expect(time.begun == ["windmill.sync.leave"])
    #expect(time.ended == [1])
  }

  @Test(.timeLimit(.minutes(1))) func timeRunningOutCancelsTheFlushAndIsHandedBackOnce() async throws {
    try holdCard()
    let gate = Gate()
    transport.willAnswerPush(200, Self.admitted, after: gate)

    center.post(name: Self.leaving, object: nil)
    await gate.arrival()
    time.expire?()
    #expect(time.ended == [1])
    gate.open()
    await lifecycle.leaveFlush?.value

    #expect(time.ended == [1])
    #expect(transport.pushes.count == 1)
  }

  @Test func withNoTimeLentTheFlushStillRuns() async throws {
    time.lends = false
    try holdCard()
    transport.willAnswerPush(200, Self.admitted)

    center.post(name: Self.leaving, object: nil)
    await lifecycle.leaveFlush?.value

    #expect(try outbox() == ["acked 1"])
    #expect(time.begun == ["windmill.sync.leave"])
    #expect(time.ended == [])
  }

  // Coming back while the flush pushes: the foreground app opens its live socket again, and the flush's end leaves it
  // open. Found in review, where the flush closed it and no socket opened until the next heartbeat look.
  @Test(.timeLimit(.minutes(1))) func comingBackWhileTheFlushPushesKeepsTheSocketTheAppOpened() async throws {
    try holdCard()
    let gate = Gate()
    transport.willAnswerPush(200, Self.admitted, after: gate)
    center.post(name: Self.leaving, object: nil)
    await gate.arrival()

    center.post(name: Self.returning, object: nil)
    let socket = FakeLiveConnection()
    transport.willOpenLive(socket)
    #expect(await engine.live.step() == .open(ms: 25_000))
    gate.open()
    await lifecycle.leaveFlush?.value

    #expect(await engine.live.isOpen)
    #expect(!socket.isClosed)
    #expect(try outbox() == ["acked 1"])
  }

  @Test func returningIsNotLeaving() async throws {
    try holdCard()

    center.post(name: Self.returning, object: nil)

    #expect(lifecycle.leaveFlush == nil)
    #expect(try outbox() == ["held"])
    #expect(time.begun == [])
  }

  static let admitted: JSON = [
    "serverTime": 1_700_000_000_000, "epoch": "ep-1", "as": "acct-1", "lastN": 1, "results": [["n": 1, "s": "ok", "seq": 1]],
  ]

  func holdCard() throws {
    let gesture = Gesture(changes: [.create("card", id: .given(RecordID("cardAAAA0001")), ["title": "One"])], hold: true)
    guard case .committed = try engine.commit(.product("probe"), gesture) else { throw Refused() }
  }

  // The active replica's outbox, one line per entry: its state, and its number once it has one.
  func outbox() throws -> [String] {
    try store.read { tx in try tx.replica(tx.activeReplica())!.outbox }.map { "\($0.state.rawValue)\($0.n.map { " \($0)" } ?? "")" }
  }

  struct Refused: Error {}
}

// Background time a test lends: each grant numbered from 1, its expiry fired by hand.
@MainActor
final class LentTime: BackgroundTime {
  var lends = true
  var begun: [String] = []
  var ended: [Int] = []
  var expire: (@MainActor @Sendable () -> Void)?

  func begin(named name: String, expired: @escaping @MainActor @Sendable () -> Void) -> Int? {
    begun.append(name)
    expire = expired
    return lends ? begun.count : nil
  }

  func end(_ identifier: Int) {
    ended.append(identifier)
  }
}
