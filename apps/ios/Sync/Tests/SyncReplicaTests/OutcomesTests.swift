import SyncAPI
import SyncCore
import SyncReplica
import SyncTesting
import Testing

// §7.7 write map step 1 beyond the corpus: a join rewrites the called id in device rows through the product's hook
// (the probe's device rows name no ids), and in the guards and base texts of records keyed by it.

struct OutcomesTests {
  static let probe = try! Corpus.probeRegistry()

  @Test func aJoinRewritesTheCalledIdInDeviceRowsThroughTheProductHook() throws {
    let rewrite: DeviceValueRewrite = { product, key, value, type, from, to in
      guard product == "probe", key == "rack", type == "run", value["run"] == from.json else { return value }
      return ["run": to.json]
    }
    let instance = Instance(actor: try Stamp.Actor("r_aaaaaaaaaaaa"), deviceNow: 5000, appVersion: "1")
    let identities = try QueuedIdentities([:])
    var replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .bound, account: "A"), wholeScopes: true)
    let start = Gesture(
      changes: [], command: Command(name: "probe.start", args: ["id": "runmine1", "startedAt": 5000, "join": true]),
      predict: [.create("run", id: .given("runmine1"), ["startedAt": 5000])], local: [DeviceWrite(key: "rack", value: ["run": "runmine1"])],
      gestureId: "start")
    _ = try CommitPlanner(registry: Self.probe).commit(start, in: .product("probe"), to: &replica, as: instance, identities: identities)
    let planner = PushPlanner(registry: Self.probe, rewriteDeviceValue: rewrite)
    let request = try #require(try planner.number(&replica))
    let joined = try PushResponse(json: [
      "serverTime": 5010, "epoch": "ep-1", "lastN": 1,
      "results": [["n": 1, "s": "ok", "seq": 3, "write": [["t": "run", "id": "runtheir", "from": "runmine1", "born": "4000:0:srv"]]]],
    ])
    var receiving = instance
    _ = try planner.receive(.ok(joined), to: request, in: &replica, instance: &receiving, timing: .steady(send: 5000, recv: 5010),
                            identities: identities)
    #expect(replica.deviceRows["probe"]?["rack"] == ["run": "runtheir"])
    #expect(replica.outbox.first?.predict.first?.key == RecordKey("run", "runtheir"))
  }

  // A join of tagA into tagB: the queued link keyed [tagA, tagX] resends with its guard on [tagB, tagX], and the mark keyed
  // by tagA, refused base-unknown after the join, falls back to the text it was edited from.
  @Test func aJoinRekeysGuardsAndBaseTextsOfRecordsKeyedByTheCalledId() throws {
    let zero = String(repeating: "0", count: 64)
    let input = try JSON(parsing: """
      {"device": {"active": "rp_1", "replicas": [{"meta": {"replica": "rp_1", "state": "bound", "account": "A", "nextN": 1,
        "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:", "serverOffsetMs": 0, "offsetSamples": [],
        "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false}, "confirmed": {
          "tree/b_00000001": [{"t": "link", "id": ["tagA", "tagX"], "seq": 1, "rc": 1, "ru": 1, "life": ["alive", "1:0:srv"], "f": {"strength": [1, "1:0:srv"]}}],
          "self/overlay/b_00000001": [{"t": "mark", "id": "tagA", "seq": 1, "rc": 1, "ru": 1, "x": {"memo": {"text": "old", "rev": 1, "merged": false}}}]},
        "cursors": {"tree/b_00000001": {"cursor": null, "digest": "\(zero)", "booted": false},
                    "self/overlay/b_00000001": {"cursor": null, "digest": "\(zero)", "booted": false}}}]},
       "steps": [
         {"op": "commit", "scope": "self/probe", "changes": [], "opts": {"cmd": {"name": "probe.start", "args": {"id": "run00009", "startedAt": 5000, "join": true}},
            "predict": [{"op": "create", "t": "run", "id": "run00009", "f": {"startedAt": 5000}}]}, "deviceNow": 5000},
         {"op": "push", "deviceNow": 5000},
         {"op": "commit", "scope": "tree/b_00000001", "changes": [{"op": "put", "t": "link", "id": ["tagA", "tagX"], "f": {"strength": 2}}],
            "opts": {"guard": [{"t": "link", "id": ["tagA", "tagX"], "field": "strength"}]}, "deviceNow": 5001},
         {"op": "commit", "scope": "self/overlay/b_00000001", "changes": [{"op": "write", "t": "mark", "id": "tagA", "x": {"memo": "old!"}}], "deviceNow": 5002},
         {"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 5010, "epoch": "ep-1", "lastN": 1,
            "results": [{"n": 1, "s": "ok", "seq": 1, "write": [{"t": "tag", "id": "tagB", "from": "tagA"}]}]}}, "deviceNow": 5010},
         {"op": "push", "deviceNow": 5011},
         {"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 5012, "epoch": "ep-1", "lastN": 3,
            "results": [{"n": 2, "s": "ok", "seq": 2}, {"n": 3, "s": "refused", "code": "base-unknown"}]}}, "deviceNow": 5012},
         {"op": "push", "deviceNow": 5013}
       ]}
      """)
    let returns = try ClientSteps.run(input, registry: Self.probe) { PlannedDevice($0, registry: Self.probe, limits: $1) }
      .member("returns").asArray()
    let link = try returns[5].member("intents").asArray()[0]
    #expect(try link.member("guard") == [["t": "link", "id": ["tagB", "tagX"], "field": "strength", "stamp": "1:0:srv"]])
    #expect(try link.member("d").asArray()[0].member("id") == ["tagB", "tagX"])
    let mark = try returns[7].member("intents").asArray()[0].member("d").asArray()[0]
    let expected: JSON = ["t": "mark", "id": "tagB", "x": ["memo": ["text": "old!", "base": ["text": "old"]]]]
    #expect(mark == expected)
  }
}
