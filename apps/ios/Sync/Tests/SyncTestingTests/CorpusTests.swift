import Foundation
import SyncAPI
import SyncCore
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Testing

struct CorpusTests {
  // The registers R118 has the server author, which a v4 registry does not declare, beside its `routineCreation` type.
  static let serverAuthored: [String: Set<String>] = ["routine": ["revision", "createdEntries"],
    "proposal": ["baseRevision", "baseName", "changeCount"], "note": ["updatedAt"]]
  // gym/admit.json's R118 admissions that write: each serves its input state, then the state it admitted.
  static let metadata = try! Corpus.files().filter { $0.path == "gym/admit.json" }.flatMap { try Corpus.vectors(in: $0) }
    .filter { $0.name.hasPrefix("R118") && $0.expect["result"]?["s"] == "ok" && $0.expect["state"] != $0.input["state"] }

  // Once no entry touches a record, its confirmed row reads as the engine's own reader hands the record over.
  @Test func aConfirmedRowReadsAsTheEngineReaderHandsItOver() throws {
    let registry = try Corpus.probeRegistry()
    let scope = ScopeRef.product("probe")
    let phone = SteppedEngine(registry: registry, startMs: 1_800_000_000_000, account: "A", rules: ProbeServerRules())
    let tablet = phone.device()
    _ = try phone.replica.commit(scope, Gesture(changes: [.create("board", id: .given("b_0000000a"))]))
    _ = try phone.replica.commit(scope, Gesture(changes: [.create("card", id: .given("card0001"), ["title": "One", "tier": "draft"])]))
    phone.sync()
    let rows = try tablet.store.read { try $0.device(rows: true) }.activeReplica.confirmed[scope]?.all ?? []
    let read = try rows.map { row in try tablet.replica.read(scope) { try $0.stored(row.key.type, row.key.id) } }
    #expect(rows.map { Record(confirmed: $0, registry: registry) } == read)
    #expect(read.map { $0.map { "\($0.type) \($0.id) \($0.isVisible)" } } == ["board b_0000000a true", "card card0001 true"])
  }
  @Test func metadataFixturesWriteEveryServerAuthoredRegister() throws {
    var written: Set<String> = []
    for vector in Self.metadata {
      let account = try vector.input.member("origin").member("account").asString()
      let key = ScopeKey(ScopeRef.product("gym"), account: account)!
      let initial = try ServerState(json: vector.input.member("state"))
      for (record, row) in try ServerState(json: vector.expect.member("state")).rows[key] ?? [:] where initial.rows[key]?[record] != row {
        if record.type == "routineCreation" { written.insert("routineCreation") }
        for field in Self.serverAuthored[record.type] ?? [] where row.lattice.fields[field] != nil { written.insert("\(record.type).\(field)") }
      }
    }
    #expect(written == ["routine.revision", "routine.createdEntries", "proposal.baseRevision", "proposal.baseName",
      "proposal.changeCount", "note.updatedAt", "routineCreation"])
  }
  @Test(arguments: metadata, [4, 5])
  func metadataArrivesThroughOrdinaryPullsAndSurvivesSQLiteRestart(_ vector: CorpusVector, _ version: Int) throws {
    let v5 = try Registry(json: Corpus.registryFile("gym"))
    var json = try Corpus.registryFile("gym").asObject()
    json["version"] = JSON(version)
    if version == 4 {
      json["types"] = .array(try json.member("types").asArray().filter { $0["type"] != "routineCreation" }.map { value in
        var type = try value.asObject()
        var declared = try type.member("fields").asObject()
        for field in Self.serverAuthored[try type.member("type").asString()] ?? [] { declared[field] = nil }
        type["fields"] = .object(declared)
        return .object(type)
      })
    }
    let registry = try Registry(json: .object(json))
    let account = try vector.input.member("origin").member("account").asString(), scope = ScopeRef.product("gym")
    let key = ScopeKey(scope, account: account)!, replica = "rp_00000000000000000000000000000001"
    let initial = try ServerState(json: vector.input.member("state"))
    let admitted = try ServerState(json: vector.expect.member("state"))
    var server = ModelServer(registry: v5, rules: MetadataFeedRules(), state: initial)
    var instance = Instance(actor: try Stamp.Actor(ClientSteps.actor), deviceNow: try vector.input.member("serverNow").asInteger(),
      appVersion: "\(version)")
    let identities = try QueuedIdentities([:])
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sync-metadata-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("store.sqlite").path
    var store = try Store(path: path, registry: registry)
    let device = LoadedDevice(meta: DeviceMeta(), active: replica,
      replicas: [.fresh(ReplicaMeta(replica: replica, state: .bound, account: account))])
    _ = try store.write(.firstLaunch) { _ in Planned((), ReplicaBatch(building: device)) }
    func pull() throws {
      let request = try #require(try store.pullPlan([scope], replica: replica)?.request)
      let reply = server.pull(request.json, credential: .account(account), at: instance.deviceNow)
      #expect(reply.status == 200)
      var steps = PageApplier(registry: registry).steps(for: .ok(try PullResponse(json: reply.body)), to: request, account: account)
      while let step = steps.next(sizes: WriterSlices(.fixed(.init(chunkRows: 1))), settles: .max) {
        _ = try store.apply(step, replica: replica, account: account, subscribed: .given([scope]), instance: &instance,
          timing: .steady(send: instance.deviceNow, recv: instance.deviceNow), identities: identities)
      }
    }
    try pull()
    let before = try store.read { try $0.device(rows: true).json }
    store = try Store(path: path, registry: registry)
    #expect(try store.read { try $0.device(rows: true).json } == before)
    server.restore(admitted)
    let request = try #require(try store.pullPlan([scope], replica: replica)?.request)
    let cursor = try #require(request.json.member("scopes").asArray()[0]["cursor"])
    #expect(try Cursor(decoding: cursor.asString())?.mode == .live)
    try pull()
    let confirmed = try store.read { try $0.device(rows: true).json }
    store = try Store(path: path, registry: registry)
    #expect(try store.read { try $0.device(rows: true).json } == confirmed)
    let loaded = try store.read { try $0.device(rows: true).activeReplica }
    #expect(loaded.id == replica)
    #expect(loaded.meta.serverEpoch == initial.epoch)
    #expect(admitted.epoch == initial.epoch)
    #expect(loaded.rows(scope).all == (admitted.rows[key] ?? [:]).values.sorted { $0.key < $1.key })
    #expect(loaded.spentIDs(scope) == [:])
    #expect(loaded.cursor(scope)?.digest == (admitted.scopes[key]?.digest ?? .zero))
    #expect(loaded.outbox == [])
    if version == 5 {
      for row in loaded.rows(scope).all {
        let fields: Set<String> = row.key.type == "routineCreation" ? ["snapshot"] : Self.serverAuthored[row.key.type] ?? []
        for field in fields {
          #expect(Record(confirmed: row, registry: registry).values[field] == admitted.rows[key]?[row.key]?.lattice.fields[field]?.value)
        }
      }
    }
  }
}

// Serve each fixture state as it stands, without gym's time-dependent beforePull command.
struct MetadataFeedRules: ServerRules {}
