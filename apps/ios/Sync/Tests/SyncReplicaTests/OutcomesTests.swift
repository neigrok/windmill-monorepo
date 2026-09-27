import SyncAPI
import SyncCore
import SyncModelServer
import SyncReplica
import SyncTesting
import Testing

// §7.7 write map step 1 beyond the corpus: a join rewrites the called id in device rows through the product's hook
// (the probe's device rows name no ids), and in the guards and base texts of records keyed by it. §11.2 property 8
// against the model server: clock-skew recovery terminates.

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
    _ = try CommitPlanner(registry: Self.probe).commit(start, in: .product("probe"), to: &replica, as: instance, identities: identities,
                                                        gestureIdTaken: false)
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

  // §7.7 step 3: card0009's create is refused, so the atomic g3/0 that edits it is an orphan whose held-back dependent,
  // g4/0's edit of the card g3/0 creates, waits. g2/0's refusal writes its notice; then the orphan's refusal folds g4/0
  // into g1/0's notice, which keeps its place before g2/0's.
  @Test func anOrphansRefusalFoldsIntoItsOriginsNoticeWhereItStands() throws {
    let input = try JSON(parsing: """
      {"device": {"active": "rp_1", "replicas": [{"meta": {"replica": "rp_1", "state": "bound", "account": "A", "nextN": 1,
        "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:", "serverOffsetMs": 0, "offsetSamples": [],
        "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false}}]},
       "steps": [
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0009", "f": {"title": "Thirteen char"}}], "deviceNow": 5000},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "card", "id": "card0011", "f": {"title": "Thirteen chaR"}}], "deviceNow": 5000},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "update", "t": "card", "id": "card0009", "f": {"title": "Fixed"}},
        {"op": "create", "t": "card", "id": "card0010", "f": {"title": "Fourth"}}], "opts": {"atomic": true}, "deviceNow": 5001},
      {"op": "push", "deviceNow": 5002},
      {"op": "commit", "scope": "self/probe", "changes": [{"op": "update", "t": "card", "id": "card0010", "f": {"title": "Edited"}}], "deviceNow": 5003},
      {"op": "pushResponse", "response": {"status": 200, "body": {"serverTime": 5004, "epoch": "ep-1", "lastN": 3, "results": [
        {"n": 1, "s": "refused", "code": "invalid"}, {"n": 2, "s": "refused", "code": "invalid"}, {"n": 3, "s": "refused", "code": "unknown-record"}]}},
       "deviceNow": 5004}
       ]}
      """)
    let device = try ClientSteps.run(input, registry: Self.probe) { PlannedDevice($0, registry: Self.probe, limits: $1) }.member("device")
    let card = { (id: String, born: String, title: String, stamp: String, creates: Bool) -> JSON in
      var delta: JSON.Object = ["t": "card", "id": .string(id), "born": .string("\(born):r_aaaaaaaaaaaa"),
                                "f": ["title": [.string(title), .string("\(stamp):r_aaaaaaaaaaaa")]]]
      delta["life"] = creates ? ["alive", .string("\(born):r_aaaaaaaaaaaa")] : nil
      return .object(delta)
    }
    #expect(try device.member("replicas").asArray()[0].member("notices") == [
      ["id": "notice:g1/0", "scope": "self/probe", "code": "invalid", "at": 5004, "content": [
        "d": [card("card0009", "5000:0", "Thirteen char", "5000:0", true)],
        "dependents": [
          ["d": [card("card0009", "5000:0", "Fixed", "5001:0", false), card("card0010", "5001:0", "Fourth", "5001:0", true)]],
          ["d": [card("card0010", "5001:0", "Edited", "5003:0", false)]],
        ],
      ]],
      ["id": "notice:g2/0", "scope": "self/probe", "code": "invalid", "at": 5004, "content": [
        "d": [card("card0011", "5000:1", "Thirteen chaR", "5000:1", true)],
      ]],
    ])
  }

  // §11.2 property 8 (INV-14): a device an hour or more ahead of the model server creates, edits and deletes records,
  // holds creates and keyed puts, undoes and retires them, sends creates the server refuses `invalid` and atomic entries
  // that depend on them in part, while 409s and restores under a new epoch return its numbered entries to ready. With
  // the server clock held still, every entry is acked or ends, and none is refused clock-skew twice.
  @Test func clockSkewRecoveryTerminates() throws {
    var random = SeededRandom.fromEnvironment()
    let serverNow: Int64 = 1_000_000
    let product = ScopeRef.product("probe")
    let days: [RecordID] = ["2026-09-01", "2026-09-02", "2026-09-03"]
    let commits = CommitPlanner(registry: Self.probe)
    let hold = Hold(registry: Self.probe)
    let pushes = PushPlanner(registry: Self.probe)
    var tally = (deletesAfterReturn: 0, undone: 0, retired: 0, folded: 0, orphans: 0, orphansAdmitted: 0, recovered: 0)
    for run in 0..<500 {
      let context = "seed \(random.seed), run \(run)"
      var server = ModelServer(registry: Self.probe, rules: ProbeServerRules(), state: ServerState(epoch: "ep-0"))
      var replica = LoadedReplica.fresh(ReplicaMeta(replica: "rp_00000000000000000000000000000001", state: .bound, account: "A"))
      let deviceNow = serverNow + 3_600_000 + Int64.random(in: 0..<3_600_000, using: &random)
      var instance = Instance(actor: try Stamp.Actor("r_aaaaaaaaaaaa"), deviceNow: deviceNow, appVersion: "1")
      let identities = SeededIdentities(random)
      var epochs = 0
      var skews: [String: Int] = [:]
      let serve = { (server: inout ModelServer, request: PushRequest) throws -> Answer<PushResponse> in
        let reply = server.push(request.json, account: "A", at: serverNow)
        return reply.status == 200 ? .ok(try PushResponse(json: reply.body)) : .failed(try HTTPFailure(status: reply.status, body: reply.body))
      }
      let answer = { (replica: inout LoadedReplica, instance: inout Instance, request: PushRequest, answer: Answer<PushResponse>) throws in
        if case .ok(let response) = answer {
          for result in response.results where result.verdict == .refused(.clockSkew) {
            guard let entry = replica.outbox.first(where: { $0.state == .sent && $0.n == result.n }) else { continue }
            skews[entry.localId, default: 0] += 1
          }
        }
        _ = try pushes.receive(answer, to: request, in: &replica, instance: &instance, timing: .steady(send: deviceNow, recv: deviceNow),
                               identities: identities)
      }
      let commit = { (replica: inout LoadedReplica, gesture: Gesture) throws -> CommitReceipt? in
        guard case .committed(let receipt) = try commits.commit(gesture, in: product, to: &replica, as: instance, identities: identities, gestureIdTaken: false)
        else { return nil }
        return receipt
      }

      for _ in 0..<30 {
        let view = try ScopeView(replica, product, .drawn, registry: Self.probe)
        let stored = try ScopeView(replica, product, .stored, registry: Self.probe)
        let alive = view.all.filter { $0.lattice.life?.isAlive == true }
        let cards = alive.filter { $0.key.type == "card" }
        let storedCards = stored.records(ofType: "card").filter { $0.lattice.life?.isAlive == true }
        let held = replica.outbox.filter { $0.state == .held }
        let heldDays = held.filter { $0.intent.deltas.count == 1 && $0.intent.deltas[0].key.type == "day" && $0.intent.deltas[0].removes }
        switch Int.random(in: 0..<12, using: &random) {
        case 0 where storedCards.count < 3:
          let title = random.chance(0.3) ? "Thirteen char" : "card \(replica.nextCommitOrder)"
          _ = try commit(&replica, Gesture(changes: [.create("card", ["title": .string(title)])], hold: random.chance(0.4)))
        case 1:
          _ = try commit(&replica, Gesture(changes: [.create("board")], hold: random.chance(0.3)))
        case 2 where alive.contains { $0.key.type != "day" }:
          let record = random.pick(alive.filter { $0.key.type != "day" })
          if replica.outbox.contains(where: { entry in
            entry.state == .ready && entry.numbered && entry.intent.deltas.contains { $0.key == record.key && $0.creates }
          }) { tally.deletesAfterReturn += 1 }
          _ = try commit(&replica, Gesture(changes: [.delete(record.key.type, record.key.id)], hold: random.chance(0.5)))
        case 3 where !cards.isEmpty:
          _ = try commit(&replica, Gesture(changes: [.update("card", random.pick(cards).key.id, ["title": "renamed"])]))
        case 4:
          let day = random.pick(days)
          let removes = alive.contains { $0.key == RecordKey("day", day) } && random.chance(0.5)
          let values: [String: JSON] = random.chance(0.7) ? ["score": JSON(Int.random(in: 0...10, using: &random))] : [:]
          _ = try commit(&replica, Gesture(changes: [.put("day", day, present: !removes, values)], hold: removes || random.chance(0.4)))
        case 5 where !heldDays.isEmpty:
          let day = random.pick(heldDays).intent.deltas[0].key.id
          let retiring = Gesture(
            changes: [.put("day", day, present: true, ["score": JSON(Int.random(in: 0...10, using: &random))])],
            retire: [RecordRef(type: "day", id: day)])
          tally.retired += try commit(&replica, retiring)?.retired.count ?? 0
        case 6 where !held.isEmpty:
          if try hold.undo(random.pick(held).gestureId, in: &replica) { tally.undone += 1 }
        case 7:
          try hold.releaseAll(in: &replica)
        case 8 where !cards.isEmpty && storedCards.count < 3:
          let card = random.pick(cards).key.id
          let touch: Change = random.chance(0.5) ? .delete("card", card) : .update("card", card, ["body": "edited"])
          _ = try commit(&replica, Gesture(changes: [touch, .create("card", ["title": "new"])], atomic: true, hold: random.chance(0.2)))
        default:
          guard let request = try pushes.number(&replica) else { continue }
          switch Int.random(in: 0..<4, using: &random) {
          case 0:
            try answer(&replica, &instance, request, .failed(HTTPFailure(status: 409, error: "gap", serverTime: serverNow, epoch: server.state.epoch)))
          case 1:
            _ = try serve(&server, request)
          case 2:
            epochs += 1
            var restored = server.state
            restored.epoch = "ep-\(epochs)"
            server.restore(restored)
            try answer(&replica, &instance, request, try serve(&server, request))
          default:
            try answer(&replica, &instance, request, try serve(&server, request))
          }
        }
      }

      try hold.releaseAll(in: &replica)
      for _ in 0..<40 {
        guard let request = try pushes.number(&replica) else { break }
        try answer(&replica, &instance, request, try serve(&server, request))
      }
      #expect(replica.outbox.filter { $0.state != .acked }.map { "\($0.localId) \($0.state)" } == [],
              "\(context): every entry is acked or ends with the server clock held still")
      #expect(skews.filter { $0.value > 1 }.map(\.key).sorted() == [], "\(context): no entry is refused clock-skew twice")
      tally.recovered += skews.count
      for case .ended(_, _, let event, let orphanOf) in replica.events {
        if event == .cancel { tally.folded += 1 }
        if event == .refuse && orphanOf != nil { tally.orphans += 1 }
      }
      tally.orphansAdmitted += replica.outbox.filter { $0.orphanOf != nil && $0.state == .acked }.count
    }
    let seed = "seed \(random.seed)"
    #expect(tally.deletesAfterReturn > 40, "\(seed): only \(tally.deletesAfterReturn) deletes followed a returned numbered create")
    #expect(tally.undone > 150, "\(seed): only \(tally.undone) held gestures were undone")
    #expect(tally.retired > 20, "\(seed): only \(tally.retired) held gestures were retired")
    #expect(tally.folded > 25, "\(seed): only \(tally.folded) entries folded silently")
    #expect(tally.recovered > 300, "\(seed): only \(tally.recovered) entries recovered from clock-skew")
    #expect(tally.orphans > 30, "\(seed): only \(tally.orphans) orphans were refused")
    #expect(tally.orphansAdmitted > 15, "\(seed): only \(tally.orphansAdmitted) orphans were admitted")
  }
}

// Every new identity a property run mints, drawn from its seeded stream: record ids, and counted gesture ids, replica
// ids and actors.
final class SeededIdentities: IdentitySource {
  var random: SeededRandom
  var counts = (gestures: 0, replicas: 1, actors: 0)

  init(_ random: SeededRandom) {
    self.random = random
  }

  func draw(below bound: Int) throws -> Int { Int.random(in: 0..<bound, using: &random) }

  func gestureID() throws -> String {
    counts.gestures += 1
    return "g\(counts.gestures)"
  }

  func replicaID() throws -> String {
    counts.replicas += 1
    return "rp_" + String(repeating: "0", count: 32 - String(counts.replicas).count) + String(counts.replicas)
  }

  func actor() throws -> Stamp.Actor {
    counts.actors += 1
    return try Stamp.Actor("r_" + String(repeating: "c", count: 12 - String(counts.actors).count) + String(counts.actors))
  }

  func forkGuard() throws -> String { "fg_\(counts.replicas)" }
}
