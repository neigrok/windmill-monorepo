import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
@testable import SyncTesting
import Testing

struct TranscriptReadinessTests {
  static let response: JSON = ["status": 200, "body": [
    "serverTime": 100, "epoch": "ep-1", "as": "A", "schema": 2, "minSchema": 2,
  ]]

  @Test func readinessMustBeExpectedConsumedOnceAndUseTheExpectedCredential() async {
    let token = SessionToken("token-A")
    let missing = TranscriptTransport()
    _ = await missing.hello(token: token)
    #expect(missing.settle() == ["the engine made a hello the transcript does not: {}"])
    let extra = TranscriptTransport()
    extra.expect(.init(call: "hello", request: nil, response: Self.response, lost: false, place: "readiness", credential: token))
    _ = await extra.hello(token: token)
    _ = await extra.hello(token: token)
    #expect(extra.settle() == ["the engine made a hello the transcript does not: {}"])
    let wrong = TranscriptTransport()
    wrong.expect(.init(call: "hello", request: nil, response: Self.response, lost: false, place: "readiness", credential: token))
    _ = await wrong.hello(token: SessionToken("token-B"))
    #expect(wrong.settle() == ["readiness: the engine used the wrong credential"])
    let unused = TranscriptTransport()
    unused.expect(.init(call: "hello", request: nil, response: Self.response, lost: false, place: "readiness", credential: token))
    #expect(unused.settle() == ["readiness: the engine made no hello"])
  }

  @Test func offsetAccountingRejectsMissingExtraAndWrongSamples() throws {
    let replica = "rp_00000000000000000000000000000001"
    let initial = ReplicaMeta(replica: replica, state: .bound, account: "A")
    let reading = ClockReading(wall: 100, mono: 100, boot: "boot")
    func device(_ meta: ReplicaMeta) -> LoadedDevice {
      LoadedDevice(meta: DeviceMeta(), active: replica, replicas: [.fresh(meta)])
    }
    var expected = initial
    expected.sample(serverTime: 101, send: reading, recv: reading)
    expected.sample(serverTime: 102, send: reading, recv: reading)
    var valid = TranscriptOffsets(device(initial))
    #expect(valid.record(device(expected), before: initial, readiness: 101, ordinary: 102, reading: reading).isEmpty)
    var ordinary = initial
    ordinary.sample(serverTime: 102, send: reading, recv: reading)
    let augmented = try valid.augment(device(ordinary).json)
    #expect(augmented.differences.isEmpty)
    #expect(try augmented.device?["replicas"]?.asArray().first?["meta"]?["offsetSamples"] == expected.json["offsetSamples"])
    for times in [[102], [101, 101, 102], [100, 102]] {
      var changed = initial
      for time in times { changed.sample(serverTime: Int64(time), send: reading, recv: reading) }
      var ledger = TranscriptOffsets(device(initial))
      #expect(ledger.record(device(changed), before: initial, readiness: 101, ordinary: 102, reading: reading)
        == ["\(replica) offset samples differ from the exact modeled exchanges"])
    }
  }
}
