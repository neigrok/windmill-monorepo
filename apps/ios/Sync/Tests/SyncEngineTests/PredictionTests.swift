import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Testing

@MainActor
struct PredictionTests {
  @Test(arguments: [false, true])
  func applyProposalHidesItsRemovedRoutineAndRestoresItOnRefusal(_ refuse: Bool) async throws {
    let fixture = try await GymPredictionFixture("apply of a removal kills the routine and its proposals, and writes routineId null on its sessions")
    let replica: any Replica = fixture.engine
    let before = try #require(try replica.read(GymRemovalActions.scope) { try $0.drawn("routine", "routine0001") })
    let view = try fixture.engine.records(GymRemovalActions.scope, "routine")
    await fixture.engine.settle()
    #expect(Self.ids(view) == ["routine0001"])

    if refuse {
      let other = try fixture.device(seed: 2)
      other.puller.wants.all()
      while case .pulled = await other.puller.step() {}
      _ = try other.commit(GymRemovalActions.scope, Gesture(changes: [.update("routine", "routine0001", ["name": "Changed elsewhere"])]))
      #expect(await other.sender.step() == .again)
    }
    let receipt = try GymRemovalActions.applyProposal("proposal001", on: replica)
    let removed = try #require(try replica.read(GymRemovalActions.scope) { try $0.drawn("routine", "routine0001") })
    #expect(removed.life == Life(.dead, receipt.stamp))
    #expect(removed.born == before.born)
    #expect(removed.values == before.values)
    #expect(removed.isVisible == false)
    #expect(removed.isPending)
    #expect(try replica.read(GymRemovalActions.scope) { try $0.drawn("routine") } == [])
    #expect(try replica.read(GymRemovalActions.scope) { try $0.confirmed("routine", "routine0001") } == before)
    await fixture.engine.settle()
    #expect(Self.ids(view) == [])

    #expect(await fixture.engine.sender.step() == .again)
    await fixture.engine.settle()
    if refuse {
      #expect(try replica.read(GymRemovalActions.scope) { try $0.drawn("routine", "routine0001") } == before)
      #expect(Self.ids(view) == ["routine0001"])
      let notices = try fixture.engine.currentNotices("gym")
      #expect(notices.map(\.code) == [RefusalCode("proposal-superseded")])
      #expect(notices.map(\.detail) == [["reason": "routine-changed"]])
      #expect(notices.map(\.content.command?.name) == ["gym.applyProposal"])
      return
    }
    #expect(try fixture.engine.currentNotices("gym") == [])
    #expect(try replica.read(GymRemovalActions.scope) { try $0.drawn("routine", "routine0001") } == removed)
    #expect(Self.ids(view) == [])
    #expect(try replica.read(GymRemovalActions.scope) { try $0.confirmed("routine", "routine0001") } == before)
    await fixture.pull()
    await fixture.engine.settle()
    #expect(try replica.read(GymRemovalActions.scope) { try $0.drawn("routine") } == [])
    #expect(Self.ids(view) == [])
    #expect(try fixture.outbox() == [])
    #expect(fixture.network.server.rows(GymRemovalActions.scope, of: "A").filter { $0.key.type == "routine" } == [])
  }

  @Test(arguments: [false, true])
  func correctSessionHidesDroppedSetsAndRestoresTheWorkoutOnRefusal(_ refuse: Bool) async throws {
    let fixture = try await GymPredictionFixture("a correction replaces the workout: interval, name, kept sets rewritten, new sets working, the rest dead")
    let replica: any Replica = fixture.engine
    let before = try replica.read(GymRemovalActions.scope) { try $0.drawn("set", where: "sessionId", is: "session0001") }
    let sessionBefore = try replica.read(GymRemovalActions.scope) { try $0.drawn("session", "session0001") }
    let droppedBefore = try #require(before.first { $0.id == "set00000002" })
    let view = try fixture.engine.records(GymRemovalActions.scope, "set", where: "sessionId", is: "session0001")
    await fixture.engine.settle()
    #expect(Self.ids(view) == ["set00000001", "set00000002"])
    var args = try fixture.vector.input.member("intent").member("cmd").member("args").asObject()
    if refuse {
      var sets = try args.member("sets").asArray()
      var kept = try sets[0].asObject()
      kept["exerciseId"] = "dip"
      sets[0] = .object(kept)
      args["sets"] = .array(sets)
    }
    let receipt = try GymRemovalActions.correctSession(args, on: replica)
    let dropped = try #require(try replica.read(GymRemovalActions.scope) { try $0.drawn("set", "set00000002") })
    #expect(dropped.life == Life(.dead, receipt.stamp))
    #expect(dropped.born == droppedBefore.born)
    #expect(dropped.values == droppedBefore.values)
    #expect(dropped.isVisible == false)
    #expect(dropped.isPending)
    #expect(try replica.read(GymRemovalActions.scope) { try $0.drawn("set", where: "sessionId", is: "session0001").map(\.id) } == ["set00000001", "set00000009"])
    #expect(try replica.read(GymRemovalActions.scope) { try $0.confirmed("set", "set00000002") } == droppedBefore)
    await fixture.engine.settle()
    #expect(Self.ids(view) == ["set00000001", "set00000009"])

    #expect(await fixture.engine.sender.step() == .again)
    await fixture.engine.settle()
    if refuse {
      #expect(try replica.read(GymRemovalActions.scope) { try $0.drawn("set", where: "sessionId", is: "session0001") } == before)
      #expect(try replica.read(GymRemovalActions.scope) { try $0.drawn("session", "session0001") } == sessionBefore)
      #expect(try replica.read(GymRemovalActions.scope) { try $0.drawn("set", "set00000009") } == nil)
      #expect(Self.ids(view) == ["set00000001", "set00000002"])
      let notices = try fixture.engine.currentNotices("gym")
      #expect(notices.map(\.code) == [.invalid])
      #expect(notices.map(\.content.command?.name) == ["gym.correctSession"])
      return
    }
    #expect(try fixture.engine.currentNotices("gym") == [])
    #expect(try replica.read(GymRemovalActions.scope) { try $0.drawn("set", "set00000002") } == dropped)
    #expect(try replica.read(GymRemovalActions.scope) { try $0.confirmed("set", "set00000002") } == droppedBefore)
    #expect(Self.ids(view) == ["set00000001", "set00000009"])
    await fixture.pull()
    await fixture.engine.settle()
    let accepted = try replica.read(GymRemovalActions.scope) { try $0.drawn("set", where: "sessionId", is: "session0001") }
    #expect(accepted.map(\.id) == ["set00000001", "set00000009"])
    #expect(accepted.allSatisfy { !$0.isPending && $0.isVisible })
    #expect(Self.ids(view) == ["set00000001", "set00000009"])
    #expect(try fixture.outbox() == [])
    #expect(fixture.network.server.rows(GymRemovalActions.scope, of: "A").filter { $0.key.type == "set" }.map(\.key.id) == ["set00000001", "set00000009"])
  }

  @Test func keyedPredictionsKeepTheirLifeOrRemoveAndRestorePresenceWithoutBorn() throws {
    var registry = try Rig.probe.json.asObject()
    var commands = try registry.member("commands").asArray()
    commands.append(["name": "probe.predictDay", "scope": "product:probe", "origins": ["replica"],
      "serverInternal": false, "args": [:], "predicts": ["day"]])
    registry["commands"] = .array(commands)
    let rig = try Rig(registry: Registry(json: .object(registry)))
    let replica: any Replica = rig.engine
    try rig.commit(Gesture(changes: [.put("day", "2026-01-01", present: true, ["score": 1])]))
    let before = try #require(try replica.read(Rig.scope) { try $0.drawn("day", "2026-01-01") })
    let command = Command(name: "probe.predictDay", args: [:])
    try rig.commit(Gesture(changes: [], command: command, predict: [.put("day", "2026-01-01", present: nil, ["score": 2])]))
    let kept = try #require(try replica.read(Rig.scope) { try $0.drawn("day", "2026-01-01") })
    #expect(kept.life == before.life)
    #expect(kept.born == nil)
    #expect(kept.values == ["score": 2])
    let removal = try rig.commit(Gesture(changes: [], command: command, predict: [.put("day", "2026-01-01", present: false)]))
    let dead = try #require(try replica.read(Rig.scope) { try $0.drawn("day", "2026-01-01") })
    #expect(dead.life == Life(.dead, removal.stamp))
    #expect(dead.born == nil)
    #expect(dead.values == kept.values)
    #expect(dead.isVisible == false)
    #expect(try replica.read(Rig.scope) { try $0.drawn("day") } == [])
    try rig.commit(Gesture(changes: [], command: command, predict: [.put("day", "2026-01-01", present: nil, ["score": 3])]))
    let stillDead = try #require(try replica.read(Rig.scope) { try $0.drawn("day", "2026-01-01") })
    #expect(stillDead.life == dead.life)
    #expect(stillDead.born == nil)
    #expect(stillDead.isVisible == false)
    let revival = try rig.commit(Gesture(changes: [], command: command, predict: [.put("day", "2026-01-01", present: true)]))
    let alive = try #require(try replica.read(Rig.scope) { try $0.drawn("day", "2026-01-01") })
    #expect(alive.life == Life(.alive, revival.stamp))
    #expect(alive.born == nil)
    #expect(alive.values == ["score": 3])
    #expect(try replica.read(Rig.scope) { try $0.drawn("day") } == [alive])
    let outboxBefore = try rig.outbox()
    let clockBefore = try rig.meta().hlc
    #expect(throws: CommitFailure(.malformed, "a predicted put keeping the presence of day 2026-01-02 finds it absent from drawn")) {
      try replica.commit(Rig.scope, Gesture(changes: [], command: command, predict: [.put("day", "2026-01-02", present: nil)]))
    }
    #expect(try rig.outbox() == outboxBefore)
    #expect(try rig.meta().hlc == clockBefore)
    #expect(try replica.read(Rig.scope) { try $0.drawn("day") } == [alive])
  }

  @Test func aPredictedMintedDeletionAbsentFromDrawnFailsWithoutWriting() throws {
    let rig = try Rig(registry: Registry(json: Corpus.registryFile("gym")))
    let outboxBefore = try rig.outbox()
    let clockBefore = try rig.meta().hlc
    #expect(throws: CommitFailure(.malformed, "a predicted delete of routine routine0001 absent from drawn")) {
      try rig.engine.commit(GymRemovalActions.scope, Gesture(changes: [],
        command: Command(name: "gym.applyProposal", args: ["proposalId": "proposal001"]), predict: [.delete("routine", "routine0001")]))
    }
    #expect(try rig.outbox() == outboxBefore)
    #expect(try rig.meta().hlc == clockBefore)
    #expect(try rig.engine.read(GymRemovalActions.scope) { try $0.drawn("routine") } == [])
  }

  static func ids(_ view: RecordsView) -> [RecordID]? {
    guard case .loaded(let snapshot) = view.state else { return nil }
    return snapshot.records.map(\.id)
  }
}

// Test-local gym actions exercise the domain-facing read-and-commit port and the real gym server rules.
enum GymRemovalActions {
  static let scope = ScopeRef.product("gym")

  static func applyProposal(_ id: RecordID, on replica: any Replica) throws -> CommitReceipt {
    let result = try replica.commit(scope) { context in
      let proposal = try #require(try context.drawn("proposal", id))
      let routine = RecordID(try #require(proposal.values["routineId"]).asString())
      _ = try #require(try context.drawn("routine", routine))
      let predict: [Change] = [.update("proposal", id, ["state": "applied", "settledAt": JSON(context.now)]), .delete("routine", routine)]
      return (Gesture(changes: [], command: Command(name: "gym.applyProposal", args: ["proposalId": id.json]), predict: predict), ())
    }
    guard case .committed(let receipt) = try #require(result.outcome) else { throw RigError("the gym action was locally refused") }
    return receipt
  }

  static func correctSession(_ args: JSON.Object, on replica: any Replica) throws -> CommitReceipt {
    let result = try replica.commit(scope) { context in
      let session = RecordID(try args.member("sessionId").asString())
      _ = try #require(try context.drawn("session", session))
      let prior = try context.drawn("set", where: "sessionId", is: session)
      let sets = try args.member("sets").asArray()
      var predict: [Change] = [.update("session", session, ["startedAt": try args.member("startedAt"),
        "finishedAt": try args.member("finishedAt"), "closedBy": "finish", "displayName": try args.member("routineName")])]
      var named: Set<RecordID> = []
      for set in sets {
        let id = RecordID(try set.member("id").asString())
        named.insert(id)
        var values = Dictionary(uniqueKeysWithValues: try set.asObject().members.filter { $0.key != "id" && $0.key != "setNumber" })
        if prior.contains(where: { $0.id == id }) {
          predict.append(.update("set", id, values))
        } else {
          values["sessionId"] = session.json
          values["kind"] = "working"
          predict.append(.create("set", id: .given(id), values))
        }
      }
      predict += prior.filter { !named.contains($0.id) }.map { .delete("set", $0.id) }
      return (Gesture(changes: [], command: Command(name: "gym.correctSession", args: .object(args)), predict: predict), ())
    }
    guard case .committed(let receipt) = try #require(result.outcome) else { throw RigError("the gym action was locally refused") }
    return receipt
  }
}

@MainActor
struct GymPredictionFixture {
  let vector: CorpusVector
  let registry: Registry
  let clock: SimClock
  let network: SimNetwork
  let store: Store
  let engine: SyncEngine

  init(_ name: String) async throws {
    let file = try #require(try Corpus.files().first { $0.path == "gym/admit.json" })
    vector = try #require(try Corpus.vectors(in: file).first { $0.name == name })
    registry = try Registry(json: Corpus.registryFile("gym"))
    clock = SimClock(wallMs: try vector.input.member("serverNow").asInteger())
    network = SimNetwork(server: ModelServer(registry: registry, rules: GymServerRules(), state: try ServerState(json: vector.input.member("state"))), clock: clock)
    store = try Store.inMemory(registry: registry)
    engine = try Self.device(over: store, on: network, clock: clock, seed: 1)
    await pull()
  }

  func device(seed: UInt64) throws -> SyncEngine {
    try Self.device(over: Store.inMemory(registry: registry), on: network, clock: clock, seed: seed)
  }

  static func device(over store: Store, on network: SimNetwork, clock: SimClock, seed: UInt64) throws -> SyncEngine {
    let identities = Identities(random: SeededRandomSource(seed: seed))
    _ = try store.firstLaunch(identities: identities)
    _ = try store.signIn(account: "A", holdsRecords: [:], decisions: [:], counted: [:], identities: identities)
    return try SyncEngine(config: EngineConfig(appVersion: "1", surface: .ios, drivesLoops: false), store: store,
      transport: network, tokens: InMemoryTokenStore(["A": network.server.token(for: "A")]), forkGuard: InMemoryForkGuardStore(),
      clock: clock.engineClock, random: SeededRandomSource(seed: seed + 100), connectivity: SwitchedConnectivity())
  }

  func pull() async {
    engine.puller.wants.all()
    while case .pulled = await engine.puller.step() {}
  }

  func outbox() throws -> [OutboxEntry] {
    try store.read { try $0.device(rows: true).activeReplica.outbox }
  }
}
