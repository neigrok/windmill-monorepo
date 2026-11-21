import SyncAPI
import SyncCore
import SyncEngine
import SyncTesting
import Testing

struct FreshnessTests {
  @Test func twoSkewedReplicasUseTheServersClockOnlyWhileTheirScopeIsLive() async throws {
    let serverClock = SimClock(wallMs: 1_800_000_000_000)
    let network = SyncEngineTests.network(serverClock)
    let fastClock = SimClock(wallMs: serverClock.nowMs() + 86_400_000)
    let slowClock = SimClock(wallMs: serverClock.nowMs() - 86_400_000)
    let fast = try SyncEngineTests.device(on: network, clock: fastClock, seed: 700)
    let slow = try SyncEngineTests.device(on: network, clock: slowClock, seed: 701)
    let scope = ScopeRef.product("probe")
    #expect(try fast.engine.read(scope) { try $0.freshness() } == SyncFreshness())
    #expect(try slow.engine.read(scope) { try $0.freshness() } == SyncFreshness())
    for device in [fast, slow] {
      await device.engine.start()
      while case .pulled = await device.engine.puller.step() {}
      #expect(try device.engine.read(scope) { try $0.freshness() } == SyncFreshness())
      _ = await device.engine.live.step()
      #expect(try device.engine.read(scope) { try $0.freshness() } == SyncFreshness(serverNow: serverClock.nowMs(), live: true))
    }
    _ = try fast.engine.commit(scope, Gesture(changes: [Rig.card("card0001", "A")]))
    _ = await fast.engine.sender.step()
    slow.engine.puller.wants.all()
    while case .pulled = await slow.engine.puller.step() {}
    #expect(try slow.engine.read(scope) { try $0.confirmed("card", "card0001")?.ru } == serverClock.nowMs())
    fast.connectivity.set(online: false)
    #expect(try fast.engine.read(scope) { try $0.freshness() } == SyncFreshness())
    #expect(try slow.engine.read(scope) { try $0.freshness() } == SyncFreshness(serverNow: serverClock.nowMs(), live: true))
    fast.connectivity.set(online: true)
    #expect(try fast.engine.read(scope) { try $0.freshness() } == SyncFreshness())
    slowClock.jump(ms: 3_600_000)
    #expect(try slow.engine.read(scope) { try $0.freshness() } == SyncFreshness())
    try slow.engine.leave()
    #expect(try slow.engine.read(scope) { try $0.freshness() } == SyncFreshness())
  }

  @Test func aReaderCannotUseFreshnessOutsideItsTransaction() throws {
    let rig = try Rig(account: "A")
    let reader = try rig.engine.read(Rig.scope) { $0 }
    #expect(throws: CommitFailure.self) { try reader.freshness() }
  }
}
