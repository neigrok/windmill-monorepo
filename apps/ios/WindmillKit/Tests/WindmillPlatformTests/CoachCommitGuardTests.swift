import Testing
import Agent
import SyncAPI
import SyncCore
import SyncModelServer
import SyncTesting
@testable import WindmillPlatform

@Suite @MainActor struct CoachCommitGuardTests {
  @Test func aDeletedRecordCannotBeResurrectedByALateCoachWrite() throws {
    let device = SteppedEngine(registry: try Corpus.probeRegistry(), startMs: 1_800_000_000_000, rules: ProbeServerRules())
    let scope = ScopeRef.product("probe")
    let seat = Seat(kind: .bound, key: "account")
    let guardHost = CoachCommitGuard(replica: device.replica, scope: scope, recordType: "card", seat: { seat })
    let lease = try guardHost.open(TurnInput(turnId: "card0001", seat: seat, question: "")) { _, lease in
      (Gesture(changes: [.create("card", id: .given("card0001"), ["title": "A"])]), lease)
    }
    device.sync()
    _ = try device.replica.commit(scope, Gesture(changes: [.delete("card", "card0001")]))
    #expect(throws: HostFailure.self) {
      try guardHost.commit(lease, id: "card0001") { _, _ in
        (Gesture(changes: [.update("card", "card0001", ["title": "Late"])]), ())
      }
    }
    #expect(try device.replica.read(scope) { try $0.drawn("card") } == [])
  }

  @Test func aSeatGenerationAndActualReplicaBothFenceACommit() throws {
    let device = SteppedEngine(registry: try Corpus.probeRegistry(), startMs: 1_800_000_000_000, rules: ProbeServerRules())
    let scope = ScopeRef.product("probe")
    let seat = Seat(kind: .bound, key: "account")
    let guardHost = CoachCommitGuard(replica: device.replica, scope: scope, recordType: "card", seat: { seat })
    let lease = try guardHost.open(TurnInput(turnId: "card0001", seat: seat, question: "")) { _, lease in
      (Gesture(changes: [.create("card", id: .given("card0001"), ["title": "A"])]), lease)
    }
    let before = try device.replica.read(scope) { try $0.drawn("card") }
    guardHost.seatDidChange()
    #expect(throws: HostFailure.self) {
      try guardHost.commit(lease, id: "card0001") { _, _ in (Gesture(changes: [.update("card", "card0001", ["title": "Late"])]), ()) }
    }
    let wrongReplica = HostLease(turnId: lease.turnId, seat: seat, generation: 1, replica: "another-replica")
    #expect(throws: HostFailure.self) {
      try guardHost.commit(wrongReplica, id: "card0001") { _, _ in (Gesture(changes: [.update("card", "card0001", ["title": "Late"])]), ()) }
    }
    #expect(try device.replica.read(scope) { try $0.drawn("card") } == before)
  }
}
