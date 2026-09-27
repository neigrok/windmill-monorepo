import SyncAPI
import SyncCore
import SyncReplica
import SyncTesting
import Testing

// §7.2 cancel: a join cancels only an entry that made its record alive, one without which drawn holds the record not
// alive. A delete that absorbed a revive of a live record did not, so a later delete joining it is still sent.

struct OutboxTests {
  static let probe = try! Corpus.probeRegistry()

  // A tag the server holds alive, in a board's tree.
  static let device = """
    {"active": "rp_00000000000000000000000000000001", "replicas": [{"meta": {"replica": "rp_00000000000000000000000000000001",
      "state": "bound", "account": "A", "nextN": 1, "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:",
      "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false},
     "confirmed": {
       "self/probe": [{"t": "board", "id": "b_00000001", "life": ["alive", "900:0:r_bbbbbbbbbbbb"], "born": "900:0:r_bbbbbbbbbbbb", "seq": 1, "rc": 900, "ru": 900}],
       "tree/b_00000001": [{"t": "tag", "id": "tone", "life": ["alive", "901:0:r_bbbbbbbbbbbb"], "born": "901:0:r_bbbbbbbbbbbb",
         "f": {"label": ["one", "901:0:r_bbbbbbbbbbbb"]}, "seq": 1, "rc": 901, "ru": 901}]}}]}
    """

  // Deleted, revived (roadmap: the Undo of a released delete) and deleted again before the first delete is numbered,
  // plainly or with the first delete held and released: the person's last act is a delete, so it is drawn and sent.
  @Test(arguments: [false, true])
  func aDeleteThatAbsorbedAReviveOfALiveRecordIsStillSent(_ held: Bool) throws {
    let release = held ? #"{"op": "release", "localId": "g1/0", "deviceNow": 1000},"# : ""
    let input = try JSON(parsing: """
      {"device": \(Self.device), "steps": [
        {"op": "commit", "scope": "tree/b_00000001", "changes": [{"op": "delete", "t": "tag", "id": "tone"}], "opts": {"hold": \(held)}, "deviceNow": 1000},
        \(release)
        {"op": "commit", "scope": "tree/b_00000001", "changes": [{"op": "revive", "t": "tag", "id": "tone"}], "deviceNow": 1001},
        {"op": "commit", "scope": "tree/b_00000001", "changes": [{"op": "delete", "t": "tag", "id": "tone"}], "deviceNow": 1002},
        {"op": "push", "deviceNow": 1003}]}
      """)
    let answer = try ClientSteps.run(input, registry: Self.probe) { PlannedDevice($0, registry: Self.probe, limits: $1) }
    let push = try answer.member("returns").asArray().last
    #expect(push == ["replica": "rp_00000000000000000000000000000001", "ackThrough": 0, "intents": [
      ["n": 1, "scope": "tree/b_00000001", "gestureId": "g1",
       "d": [["t": "tag", "id": "tone", "born": "901:0:r_bbbbbbbbbbbb", "life": ["dead", "1002:0:r_aaaaaaaaaaaa"]]]],
    ]])
    #expect(try answer.member("ended") == [
      ["localId": "g2/0", "outcome": "coalesced", "event": "coalesce"], ["localId": "g3/0", "outcome": "coalesced", "event": "coalesce"],
    ])
  }
}
