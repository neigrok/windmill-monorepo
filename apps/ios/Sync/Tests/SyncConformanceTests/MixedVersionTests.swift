import SyncAPI
import SyncCore
import SyncModelServer
import SyncReplica
import SyncTesting
import Testing

struct MixedVersionTests {
  static let scope = ScopeRef.product("journal")
  static let current = try! Registry(name: "windmill", composing: [ServerHandlers.gym, ServerHandlers.journal])
  static let v4: Registry = {
    var json = try! ServerHandlers.journal.json.asObject()
    json["version"] = 4
    return try! Registry(json: .object(json))
  }()
  static let sample = try! Corpus.vectors(in: Corpus.files().first { $0.path == "journal/claim-edit.json" }!)
    .first { $0.input["occupied"] == true && $0.input["strategy"] == nil && $0.input["signOut"] == nil }!.input

  static func gymDoorWrites(_ server: inout ModelServer, at now: Int64) throws {
    let scope = ScopeKey(.product("journal"), account: "A")!
    let before = server.state
    var state = before
    state.product["seeds"] = ["dip": ["name": "Dip"]]
    server.restore(state)
    for (index, door) in ["mcp", "ask"].enumerated() {
      let id = "routine000\(index + 1)"
      let intent: JSON = ["scope": "self/gym", "d": [["t": "routine", "id": .string(id), "born": .null,
        "life": ["alive", .null], "f": ["name": ["Dips", .null], "entries": [[ ["exerciseId": "dip"] ], .null],
        "createdDoor": [.string(door), .null]]]]]
      let response = server.call(ServerCall(account: "A", requestId: nil, tool: "gym.createRoutine", args: [:],
        intents: [intent]), at: now + Int64(index))
      let result = try #require(response)
      #expect(result["s"] == "ok")
      #expect(server.state.rows[ScopeKey(.product("gym"), account: "A")!]?[RecordKey("routine", RecordID(id))]?.lattice.fields["revision"]?.value == 1)
      #expect(result["write"] == nil)
    }
    let snapshot = server.state.rows[ScopeKey(.product("gym"), account: "A")!]?[RecordKey("routineCreation", "routine0002")]?.lattice.fields["snapshot"]?.value
    #expect(snapshot == ["id": "routine0002", "name": "Dips", "position": 0, "revision": 1,
      "entries": [["position": 1, "exerciseId": "dip"]]])
    #expect(server.state.scopes[scope] == before.scopes[scope])
    #expect(server.state.rows[scope] == before.rows[scope])
    #expect(server.state.revisions[scope] == before.revisions[scope])
    #expect(server.state.product["journalClaims"] == before.product["journalClaims"])
    #expect(server.state.epoch == before.epoch)
  }

  @Test(arguments: ["ready", "sent", "acked"])
  func pendingV4SavesSurviveV6GymWritesPullsAndRelaunch(_ phase: String) throws {
    let now = try Self.sample.member("now").asInteger(), day = try Self.sample.member("day").asString()
    let replica = try Self.sample.member("replica").asString()
    var instance = Instance(actor: try Stamp.Actor(ClientSteps.actor), deviceNow: now + 1, appVersion: "v4")
    let identities = try QueuedIdentities([:])
    var device = PlannedDevice(LoadedDevice(meta: DeviceMeta(), active: replica,
      replicas: [.fresh(ReplicaMeta(replica: replica, state: .bound, account: "A"))]), registry: Self.v4, limits: Limits())
    let stamp: JSON = ["ms": JSON(now + 1), "counter": 0, "actor": .string(ClientSteps.actor)]
    let args: JSON = ["day": .string(day), "body": "Pending v4 save.", "mood": 0, "energy": .null, "source": "typed", "stamp": stamp]
    let outcome = try device.commit(Gesture(changes: [], command: Command(name: "journal.savePage", args: args),
      local: [DeviceWrite(key: "contentClock", value: ContentClock.pair(stamp))], gestureId: "save-v4"),
      in: Self.scope, instance: instance, identities: identities)
    #expect(outcome != nil)
    var oldServer = ModelServer(registry: Self.v4, rules: JournalServerRules(), state: try ServerState(json: Self.sample.member("server")))
    var request: PushRequest?
    if phase != "ready" { request = try #require(try device.push(limit: nil, at: now + 2)) }
    if phase == "acked" {
      let reply = oldServer.push(request!.json, credential: .account("A"), at: now + 3)
      var steps = PushPlanner(registry: Self.v4).steps(for: .ok(try PushResponse(json: reply.body)), to: request!)
      while let step = steps.next(sizes: WriterSlices(.fixed(.init(chunkRows: .max)))) {
        try device.apply(step, instance: &instance, timing: .steady(send: now + 3, recv: now + 3), identities: identities)
      }
    }
    #expect(try device.activeReplica().outbox.map { $0.state.rawValue } == [phase])
    let pending = try device.dump()
    var server = ModelServer(registry: Self.current, rules: ComposedServerRules.windmill(registry: Self.current), state: oldServer.state)
    try Self.gymDoorWrites(&server, at: now + 4)
    device = PlannedDevice(try LoadedDevice(json: pending, registry: Self.v4), registry: Self.v4, limits: Limits())
    #expect(try device.dump() == pending)
    let greeting = server.hello(credential: .account("A"), at: now + 6)
    #expect(greeting.status == 200)
    #expect(greeting.body["schema"] == 6)
    #expect(greeting.body["minSchema"] == JSON(Self.v4.version))
    try device.hello(.ok(try HelloResponse(json: greeting.body)), timing: .steady(send: now + 6, recv: now + 6))
    if phase != "acked" {
      request = try #require(try device.push(limit: nil, at: now + 7))
      #expect(try request!.json.member("intents").asArray()[0]["cmd"]?["args"] == args)
      let reply = server.push(request!.json, credential: .account("A"), at: now + 7)
      #expect(reply.status == 200)
      #expect(try reply.body.member("results").asArray()[0]["s"] == "ok")
      var steps = PushPlanner(registry: Self.v4).steps(for: .ok(try PushResponse(json: reply.body)), to: request!)
      while let step = steps.next(sizes: WriterSlices(.fixed(.init(chunkRows: .max)))) {
        try device.apply(step, instance: &instance, timing: .steady(send: now + 7, recv: now + 7), identities: identities)
      }
    }
    let pull = try #require(try device.pullRequest([Self.scope]))
    let reply = server.pull(pull.json, credential: .account("A"), at: now + 8)
    #expect(reply.status == 200)
    var steps = PageApplier(registry: Self.v4).steps(for: .ok(try PullResponse(json: reply.body)), to: pull, account: "A")
    while let step = steps.next(sizes: WriterSlices(.fixed(.init(chunkRows: 1))), settles: .max) {
      let result = try device.apply(step, subscribed: [Self.scope], instance: &instance,
        timing: .steady(send: now + 8, recv: now + 8), identities: identities)
      if result.unsettled { while try device.settle(Self.scope, count: .max) {} }
    }
    device = PlannedDevice(try LoadedDevice(json: device.dump(), registry: Self.v4), registry: Self.v4, limits: Limits())
    let loaded = try device.activeReplica()
    let expected = server.state.rows[ScopeKey(Self.scope, account: "A")!]!.values.sorted { $0.key < $1.key }
    #expect(loaded.meta.replica == replica)
    #expect(loaded.meta.serverEpoch == oldServer.state.epoch)
    #expect(server.state.epoch == oldServer.state.epoch)
    #expect(loaded.outbox == [])
    #expect(loaded.rows(Self.scope).all == expected)
    #expect(loaded.rows(Self.scope).row(RecordKey("page", RecordID(day)))?.lattice.fields["documentStamp"]?.value == stamp)
    #expect(loaded.deviceRows["journal"]?["contentClock"] == ContentClock.pair(stamp))
    #expect(Set(loaded.cursors.keys) == [Self.scope])
  }

  @Test func aV4ClaimRetainsTypingAcrossV6GymWritesLostReplyAndRelaunch() throws {
    let now = try Self.sample.member("now").asInteger()
    let answer = try JournalHandlers.claimEdit(Self.sample, clientRegistry: Self.v4, serverRegistry: Self.current,
      beforeAdmission: { try Self.gymDoorWrites(&$0, at: now + 4) }, loseClaimReply: true)
    let trace = try answer.member("trace").asArray()
    let lost = try #require(trace.first { $0["op"] == "claimReplyLost" })
    let retry = try #require(trace.first { $0["op"] == "claimRetry" })
    #expect(lost["value"]?["request"] == retry["value"]?["request"])
    #expect(lost["value"]?["server"] == retry["value"]?["server"])
    #expect(lost["device"] == retry["device"])
    #expect(answer["pending"] == .null)
    #expect(try answer.member("claimResponse").member("body").member("results").asArray()[0]["s"] == "ok")
    #expect(try answer.member("saveResponse").member("body").member("results").asArray()[0]["s"] == "ok")
    let device = try LoadedDevice(json: answer.member("device"), registry: Self.v4)
    let state = try ServerState(json: answer.member("server"))
    let day = RecordID(try Self.sample.member("day").asString())
    let page = try #require(state.rows[ScopeKey(Self.scope, account: "A")!]?[RecordKey("page", day)])
    #expect(page.texts["body"]?.text == "Account words.\n\n\(try Self.sample.member("edit").member("body").asString())")
    #expect(page.lattice.fields["mood"]?.value == 0)
    #expect(device.activeReplica.rows(Self.scope).row(page.key) == page)
    #expect(device.activeReplica.outbox == [])
    #expect(device.activeReplica.meta.serverEpoch == state.epoch)
    #expect(state.epoch == (try Self.sample.member("server").member("epoch").asString()))
    #expect(Set(device.activeReplica.cursors.keys) == [Self.scope])
  }
}
