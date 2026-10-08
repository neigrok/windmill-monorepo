import Foundation
import SyncAPI
import SyncCore
import SyncReplica
@testable import SyncStore
import SyncTesting
import Testing

// The schema makes impossible states unrepresentable: a batch that would store one is refused, and its transaction
// leaves the store as it was.

struct SchemaTests {
  static let probe = try! Corpus.probeRegistry()

  static func bound(_ id: String, _ account: String) -> ReplicaMeta { ReplicaMeta(replica: id, state: .bound, account: account) }

  static func entry(_ localId: String, order: Int64, state: EntryState, n: Int64? = nil, resultSeq: Int64? = nil) -> OutboxEntry {
    let stamp = try! Stamp("1000:0:r_aaaaaaaaaaaa")
    var entry = OutboxEntry(
      localId: localId, gestureId: localId, lineage: "A", scope: .product("probe"), state: state, commitOrder: order, releaseAt: 0,
      stamp: stamp, intent: Intent(n: n, scope: .product("probe"), deltas: [Delta(key: RecordKey("card", "card0001"))]))
    entry.resultSeq = resultSeq
    entry.resultEpoch = resultSeq.map { _ in "ep-1" }
    return entry
  }

  @Test(arguments: [
    ("two anon replicas", [StoreWrite.createReplica(ReplicaMeta(replica: "rp_2", state: .anon))]),
    ("two bound replicas", [.createReplica(bound("rp_2", "A")), .createReplica(bound("rp_3", "B"))]),
    ("a dormant replica beside a bound one of the same account",
     [.createReplica(bound("rp_2", "A")), .createReplica(ReplicaMeta(replica: "rp_3", state: .dormant, account: "A"))]),
    ("an anon replica with an account", [.replica("rp_1", .meta(ReplicaMeta(replica: "rp_1", state: .anon, account: "A")))]),
    ("a bound replica without an account", [.createReplica(ReplicaMeta(replica: "rp_2", state: .bound))]),
    ("a sent entry without n", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .sent)))]),
    ("a ready entry with n", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .ready, n: 1)))]),
    ("an acked entry without its result seq", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .acked, n: 1)))]),
    ("a sent entry with a result seq", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .sent, n: 1, resultSeq: 4)))]),
    ("two entries of one commit order", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .ready))),
                                         .replica("rp_1", .putEntry(entry("g2/0", order: 1, state: .ready)))]),
    ("two entries numbered alike", [.replica("rp_1", .putEntry(entry("g1/0", order: 1, state: .sent, n: 1))),
                                    .replica("rp_1", .putEntry(entry("g2/0", order: 2, state: .sent, n: 1)))]),
    ("a row of a replica the store does not hold", [.replica("rp_9", .putKnown(.tree("b_00000001"), .gone))]),
  ])
  func anImpossibleStateIsRefusedAndRolledBack(_ name: String, _ writes: [StoreWrite]) throws {
    let store = try Store.inMemory(registry: Self.probe)
    _ = try store.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]]))
    let before = try store.read { try $0.device(rows: true).json }
    #expect(throws: (any Error).self, "\(name)") {
      try store.write(.commit) { _ in Planned((), ReplicaBatch(writes: writes)) }
    }
    #expect(try store.read { try $0.device(rows: true).json } == before)
  }

  @Test func aFileStoreRunsWALWithFullSynchronousWritesAndForeignKeys() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try Store(path: directory.appendingPathComponent("sync.sqlite").path, registry: Self.probe)
    #expect(try ["journal_mode", "synchronous", "foreign_keys"].map(store.pragma) == ["wal", "2", "1"])
  }

  @Test(arguments: [false, true], [false, true])
  func aLegacyJoinedCommandMigratesAndRecoversAcrossDiskFailures(predicted: Bool, committed: Bool) throws {
    let file = try #require(try Corpus.files().first { $0.path == "refusal/transport.json" })
    let vector = try #require(try Corpus.vectors(in: file).first { $0.name == "legacy joined commands share their replay target before its delete after a pull restore" })
    var device = try LoadedDevice(json: vector.input.member("device"), registry: Self.probe)
    let command = try #require(device.activeReplica.outbox.first { $0.intent.command != nil })
    let deletion = try #require(device.activeReplica.outbox.first { $0.intent.deltas.contains(where: \.removes) })
    if !predicted { device.modify(device.active) { $0.update(entry: command.localId) { $0.predict = [] } } }
    let before = device.json
    let identities = { try QueuedIdentities(["ids": ["rp_new"], "actors": ["r_bbbbbbbbbbbb"]]) }
    try StoreTests.inFreshDirectory { path in
      do {
        let store = try Store(path: path, registry: Self.probe)
        _ = try store.write(.firstLaunch) { _ in Planned((), ReplicaBatch(building: device)) }
        try store.writer.write { db in
          try db.execute(sql: "ALTER TABLE outbox DROP COLUMN write_targets")
          try db.execute(sql: "DELETE FROM grdb_migrations WHERE identifier = 'v2'")
        }
      }
      let point: CrashPoint = committed ? .afterCommit(.epochChange) : .beforeCommit(.epochChange)
      let migrating = try Store(path: path, registry: Self.probe, crashPoints: CrashPoints { if $0 == point { throw StoreTests.Killed() } })
      #expect(try migrating.read { try $0.device(rows: true).json } == before)
      var instance = StoreTests.at(6000)
      #expect(throws: StoreTests.Killed.self) {
        try migrating.changeEpoch(to: "ep-2", instance: &instance, identities: identities())
      }
      let recovered = try Store(path: path, registry: Self.probe)
      if !committed {
        #expect(try recovered.read { try $0.device(rows: true).json } == before)
        _ = try recovered.changeEpoch(to: "ep-2", instance: &instance, identities: identities())
      }
      let inferred = try recovered.read { try $0.device(rows: true).activeReplica.entry(command.localId)?.writeTargets }
      let expected = predicted ? [WriteTarget(key: RecordKey("run", "run00001"), from: "run00002", born: command.predict[0].lattice.born)] : []
      #expect(inferred == expected)
      let request = try #require(try recovered.number(at: 7000).value)
      let mapped = try PushResult(json: ["n": JSON(request.intents[0].n!), "s": "ok", "seq": 1,
        "write": [["t": "run", "id": "run00002", "born": "7000:0:srv"]]])
      _ = try recovered.apply(.results(ResultBatch(replica: "rp_new", results: [mapped], lastN: 1, epoch: "ep-2", isLast: true)),
        replica: "rp_new", instance: &instance, timing: .steady(send: 7000, recv: 7000), identities: try StoreTests.none())
      let reopened = try Store(path: path, registry: Self.probe)
      let replica = try reopened.read { try $0.device(rows: true).activeReplica }
      #expect(replica.entry(command.localId)?.writeTargets == [WriteTarget(key: RecordKey("run", "run00002"), from: "run00002", born: try Stamp("7000:0:srv"))])
      if predicted {
        let delta = try #require(replica.entry(deletion.localId)?.intent.deltas.first)
        #expect(delta.key == RecordKey("run", "run00002"))
        let alias = try #require(replica.outbox.first { $0.intent.command != nil && $0.localId != command.localId })
        #expect(alias.intent.command?.args["id"] == "run00002")
        #expect(alias.writeTargets?.map(\.from) == [RecordID("run00002")])
        #expect(delta.lattice.born == alias.predict.first?.lattice.born)
        let aliasRequest = try #require(try reopened.number(at: 7010).value)
        let aliasResult = try PushResult(json: ["n": JSON(aliasRequest.intents[0].n!), "s": "ok", "seq": 1,
          "write": [["t": "run", "id": "run00002", "born": "7000:0:srv"]]])
        _ = try reopened.apply(.results(ResultBatch(replica: "rp_new", results: [aliasResult], lastN: 2, epoch: "ep-2", isLast: true)),
          replica: "rp_new", instance: &instance, timing: .steady(send: 7010, recv: 7010), identities: try StoreTests.none())
        #expect(try reopened.read { try $0.device(rows: true).activeReplica.entry(deletion.localId)?.intent.deltas.first?.lattice.born }
          == Stamp("7000:0:srv"))
        #expect(replica.notices.isEmpty)
      } else {
        #expect(replica.entry(deletion.localId) == nil)
        #expect(replica.notices.map(\.code) == [.targetMerged])
        #expect(replica.notices.first?.content == deletion.content)
      }
      _ = try reopened.changeEpoch(to: "ep-3", instance: &instance,
        identities: try QueuedIdentities(["ids": ["rp_again"], "actors": ["r_cccccccccccc"]]))
      let replay = try #require(try reopened.number(at: 8000).value)
      let empty = try PushResult(json: ["n": JSON(replay.intents[0].n!), "s": "ok", "seq": 1, "write": []])
      _ = try reopened.apply(.results(ResultBatch(replica: "rp_again", results: [empty], lastN: 1, epoch: "ep-3", isLast: true)),
        replica: "rp_again", instance: &instance, timing: .steady(send: 8000, recv: 8000), identities: try StoreTests.none())
      let final = try Store(path: path, registry: Self.probe)
      #expect(try final.read { try $0.device(rows: true).activeReplica.entry(command.localId)?.writeTargets }
        == replica.entry(command.localId)?.writeTargets)
    }
  }
}
