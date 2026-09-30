import Foundation
import SyncAPI
import SyncCore
import SyncReplica
@testable import SyncStore
import SyncTesting
import Testing

// The batch writer keeps the ref index (ER-12) a function of the rows, after any sequence of batches and after a
// registry-version change, and the outbox's touch index one of the entries, after any sequence of batches: each equals
// its recomputation. A re-identify and an epoch change do work that grows with no row, and rows taken out of every view
// are swept a slice a transaction, never read again (§2.5, §7.11).

struct BatchWriterTests {
  static let probe = try! Corpus.probeRegistry()
  static let scope = ScopeRef.product("probe")

  // A lap naming one of three runs, or none; a run; each at a seq.
  static func row(_ random: inout SeededRandom, seq: Int64) -> Row {
    let stamp = try! Stamp("\(seq):0:r_aaaaaaaaaaaa")
    let id = RecordID("lap0000\(Int.random(in: 1...6, using: &random))")
    var fields = ["weight": Register(.number(JSON.Number(10)!), stamp)]
    if random.chance(0.8) { fields["runId"] = Register(.string("run0000\(Int.random(in: 1...3, using: &random))"), stamp) }
    if random.chance(0.2) {
      return Row(key: RecordKey("run", RecordID("run0000\(Int.random(in: 1...3, using: &random))")),
                 lattice: Lattice(life: Life(.alive, stamp), born: stamp), seq: seq, rc: seq, ru: seq)
    }
    return Row(key: RecordKey("lap", id), lattice: Lattice(life: Life(.alive, stamp), born: stamp, fields: fields), seq: seq, rc: seq, ru: seq)
  }

  // Row puts and deletes, confirmed and staged, a staging begun, swapped or dropped, a scope forgotten, a purge and a
  // rename: every write that touches rows.
  static func batch(_ random: inout SeededRandom, replica: inout String, seq: inout Int64) -> [StoreWrite] {
    (0..<Int.random(in: 1...6, using: &random)).map { _ -> StoreWrite in
      seq += 1
      let write: ReplicaWrite = switch Int.random(in: 0..<10, using: &random) {
      case 0, 1, 2: .putRow(scope, row(&random, seq: seq))
      case 3: .deleteRow(scope, row(&random, seq: seq).key)
      case 4: .beginStaging(scope)
      case 5: .putStagedRow(scope, row(&random, seq: seq))
      case 6: .swapStaging(scope)
      case 7: random.chance(0.5) ? .dropStaging(scope) : .deleteStagedRow(scope, row(&random, seq: seq).key)
      case 8: random.chance(0.5) ? .forgetScope(scope) : .purgeCaches
      default: .rename(to: "rp_\(seq)")
      }
      defer { if case .rename(let id) = write { replica = id } }
      return .replica(replica, write)
    }
  }

  @Test func theRefIndexEqualsItsRecomputationAfterAnyBatches() throws {
    var random = SeededRandom.fromEnvironment()
    let store = try Store.inMemory(registry: Self.probe)
    var replica = try store.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]])).value
    var seq: Int64 = 0
    for round in 0..<300 {
      let writes = [.replica(replica, .putCursor(Self.scope, CursorRecord()))] + Self.batch(&random, replica: &replica, seq: &seq)
      _ = try? store.write(.pullPage) { _ in Planned((), ReplicaBatch(writes: writes)) }
      let index = try store.read { try $0.refIndex() }
      #expect(index.stored == index.expected, "seed \(random.seed), round \(round)")
    }
  }

  // Rows written under one registry name a field it does not know; a registry that makes it a ref field indexes them
  // when the store opens.
  @Test func aRegistryVersionChangeRebuildsTheIndexAtOpen() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("sync.sqlite").path
    let stamp = try Stamp("5:0:r_aaaaaaaaaaaa")
    let card = Row(key: RecordKey("card", "card0001"),
                   lattice: Lattice(life: Life(.alive, stamp), born: stamp, fields: ["owner": Register("run00001", stamp)]), seq: 5, rc: 5, ru: 5)

    let before = try Store(path: path, registry: Self.probe)
    let replica = try before.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]])).value
    _ = try before.write(.pullPage) { _ in Planned((), ReplicaBatch(writes: [.replica(replica, .putRow(Self.scope, card))])) }
    #expect(try before.read { try $0.referencing(replica, in: Self.scope, type: "lap", field: "runId", target: "run00001") } == [])

    var file = try Corpus.registryFile("probe").asObject()
    file["version"] = JSON(Self.probe.version + 1)
    var types = try file.member("types").asArray()
    let index = try #require(types.firstIndex { $0["type"] == "card" })
    var cardType = try types[index].asObject()
    var fields = try cardType.member("fields").asObject()
    fields["owner"] = ["kind": "lww", "writer": "client", "ref": "run"]
    cardType["fields"] = .object(fields)
    types[index] = .object(cardType)
    file["types"] = .array(types)
    let after = try Store(path: path, registry: try Registry(json: .object(file)))
    #expect(try after.read { try $0.referencing(replica, in: Self.scope, type: "card", field: "owner", target: "run00001") }
      == [RecordKey("card", "card0001")])
    let rebuilt = try after.read { try $0.refIndex() }
    #expect(rebuilt.stored == rebuilt.expected)
  }

  // The touch index is a function of the entries too: after puts of new and rewritten entries, deletes and renames, it
  // equals its recomputation.
  @Test func theTouchIndexEqualsItsRecomputationAfterAnyBatches() throws {
    var random = SeededRandom.fromEnvironment()
    let store = try Store.inMemory(registry: Self.probe)
    var replica = try store.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]])).value
    let stamp = try Stamp("1000:0:r_aaaaaaaaaaaa")
    let overlay = ScopeRef.overlay("b_00000001")
    let deltas = { (random: inout SeededRandom, scope: ScopeRef) -> [Delta] in
      (0..<Int.random(in: 0...3, using: &random)).map { _ in
        scope == overlay ? Delta(key: RecordKey("mark", RecordID("m\(random.below(3))")))
          : Delta(key: RecordKey(random.pick(["card", "lap"]), RecordID("r\(random.below(4))")))
      }
    }
    for round in 0..<300 {
      let outbox = try store.read { try $0.replica(replica)!.outbox }
      var writes: [StoreWrite] = []
      for k in 0..<Int.random(in: 1...4, using: &random) {
        switch random.below(5) {
        case 0, 1:
          let scope = random.chance(0.7) ? Self.scope : overlay
          writes.append(.replica(replica, .putEntry(OutboxEntry(
            localId: "e\(round)/\(k)", gestureId: "e\(round)", lineage: "anon", scope: scope, state: .ready,
            commitOrder: Int64(round * 10 + k + 1), releaseAt: 0, stamp: stamp,
            intent: Intent(scope: scope, deltas: deltas(&random, scope)), predict: deltas(&random, scope)))))
        case 2 where !outbox.isEmpty:
          var entry = random.pick(outbox)
          entry.intent.deltas = deltas(&random, entry.scope)
          writes.append(.replica(replica, .putEntry(entry)))
        case 3 where !outbox.isEmpty:
          writes.append(.replica(replica, .deleteEntry(random.pick(outbox).localId)))
        default:
          writes.append(.replica(replica, .rename(to: "rp_\(round)_\(k)")))
          replica = "rp_\(round)_\(k)"
        }
      }
      _ = try store.write(.commit) { _ in Planned((), ReplicaBatch(writes: writes)) }
      let index = try store.read { try $0.touchIndex() }
      #expect(index.stored == index.expected, "seed \(random.seed), round \(round)")
    }
  }

  // A local id names one entry, which keeps its commit order: a put of another entry under a local id the replica holds
  // is refused, and its transaction leaves the store as it was.
  @Test func aPutOfAnotherEntryUnderATakenLocalIdIsRefused() throws {
    let store = try Store.inMemory(registry: Self.probe)
    let replica = try store.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]])).value
    let stamp = try Stamp("1000:0:r_aaaaaaaaaaaa")
    let entry = { (order: Int64) in
      StoreWrite.replica(replica, .putEntry(OutboxEntry(
        localId: "g/0", gestureId: "g", lineage: "anon", scope: Self.scope, state: .ready, commitOrder: order, releaseAt: 0, stamp: stamp,
        intent: Intent(scope: Self.scope, deltas: [Delta(key: RecordKey("card", "card0001"))]))))
    }
    _ = try store.write(.commit) { _ in Planned((), ReplicaBatch(writes: [entry(1)])) }
    let before = try store.read { try $0.device(rows: true).json }
    #expect(throws: StoreError.localIdTaken("g/0")) {
      try store.write(.commit) { _ in Planned((), ReplicaBatch(writes: [entry(2)])) }
    }
    #expect(try store.read { try $0.device(rows: true).json } == before)
  }

  // §7.11: a re-identify changes the one row that holds the replica's id, whatever the replica holds; so does an epoch
  // change, which also drops a staging of any size (§7.5 step 1).
  @Test func aReidentifyAndAnEpochChangeChangeNoRowOfTheScopes() throws {
    let counts = try [2, 200].map { size -> [Int] in
      let store = try Self.holding(confirmed: size, staged: size)
      let reidentify = try Self.changes(in: store) {
        var instance = Instance(actor: try Stamp.Actor("r_aaaaaaaaaaaa"), deviceNow: 1, appVersion: "1")
        _ = try store.reidentify(instance: &instance, identities: try QueuedIdentities(["ids": ["rp_2"], "actors": ["r_bbbbbbbbbbbb"]]))
      }
      let epoch = try Self.changes(in: store) {
        var instance = Instance(actor: try Stamp.Actor("r_aaaaaaaaaaaa"), deviceNow: 1, appVersion: "1")
        _ = try store.changeEpoch(to: "ep-2", instance: &instance, identities: try QueuedIdentities(["ids": ["rp_3"], "actors": ["r_cccccccccccc"]]))
      }
      #expect(try store.read { try $0.releasedRows() } == size)
      return [reidentify, epoch]
    }
    #expect(counts == [[1, 4], [1, 4]])
  }

  // A swap, a drop, a forgotten scope and a purge take rows out of every view at once and delete none; the sweep deletes
  // them afterwards, a slice a transaction, and no view, digest or index sees the difference.
  @Test func rowsTakenOutOfEveryViewAreSweptASliceATransaction() throws {
    let store = try Self.holding(confirmed: 3, staged: 2)
    _ = try store.write(.pullPage) { _ in Planned((), ReplicaBatch(writes: [.replica("rp_1", .swapStaging(Self.scope))])) }
    let swapped = try store.read { try $0.device(rows: true).json }
    #expect(try store.read { try $0.device(rows: true).activeReplica.confirmed[Self.scope]?.all.map(\.key.id) }
      == [RecordID("lap1000"), RecordID("lap1001")])
    var sweeps: [(more: Bool, released: Int)] = []
    for _ in 0..<2 {
      let more = try store.sweep(limit: 2).value
      sweeps.append((more, try store.read { try $0.releasedRows() }))
      #expect(try store.read { try $0.device(rows: true).json } == swapped)
    }
    #expect(sweeps.map(\.more) == [true, false] && sweeps.map(\.released) == [1, 0])
    for write in [ReplicaWrite.forgetScope(Self.scope), .purgeCaches] {
      let store = try Self.holding(confirmed: 3, staged: 2)
      _ = try store.write(.subscriptions) { _ in Planned((), ReplicaBatch(writes: [.replica("rp_1", write)])) }
      #expect(try store.read { try $0.releasedRows() } == 5)
      #expect(try store.read { try $0.device(rows: true).activeReplica.confirmed[Self.scope]?.all ?? [] } == [])
      while try store.sweep(limit: 2).value {}
      #expect(try store.read { try $0.releasedRows() } == 0)
      let index = try store.read { try $0.refIndex() }
      #expect(index.stored == [] && index.expected == [])
    }
  }

  // A boot's staging pending between two pages, or across a death, holds a role, so the sweep leaves every row of it.
  @Test func theSweepLeavesAPendingStaging() throws {
    let store = try Self.holding(confirmed: 3, staged: 2)
    let before = try store.read { try $0.device(rows: true).json }
    while try store.sweep(limit: 1).value {}
    #expect(try store.read { try $0.device(rows: true).json } == before)
    let replica = try store.read { try $0.device(rows: true).activeReplica }
    #expect(replica.staging[Self.scope]?.rows.all.map(\.key.id) == [RecordID("lap1000"), RecordID("lap1001")])
    #expect(replica.confirmed[Self.scope]?.all.map(\.key.id) == [RecordID("lap1002"), RecordID("lap1003"), RecordID("lap1004")])
  }

  // A replica deleted with its rows (a sign-out's Discard, a dormant replica discarded) leaves them to the sweep, which
  // deletes every one, and every row set that held them.
  @Test func aDeletedReplicasRowsAreSwept() throws {
    let store = try Self.holding(confirmed: 3, staged: 2)
    _ = try store.write(.signOutFinish) { _ in
      Planned((), ReplicaBatch(writes: [
        .createReplica(ReplicaMeta(replica: "rp_0", state: .anon)), .device(DeviceMeta(), active: "rp_0"), .deleteReplica("rp_1"),
      ]))
    }
    #expect(try store.read { try $0.releasedRows() } == 5)
    while try store.sweep(limit: 2).value {}
    let left = try store.writer.read { db in
      [try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM set_row")!, try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM row_set")!]
    }
    #expect(left == [0, 0])
  }

  // A bound replica rp_1 whose probe scope holds `confirmed` laps confirmed and `staged` more in a boot's staging.
  static func holding(confirmed: Int, staged: Int) throws -> Store {
    let stamp = try Stamp("5:0:r_aaaaaaaaaaaa")
    let lap = { (index: Int) in
      Row(key: RecordKey("lap", RecordID("lap\(1000 + index)")),
          lattice: Lattice(life: Life(.alive, stamp), born: stamp, fields: ["runId": Register("run00001", stamp)]), seq: 5, rc: 5, ru: 5)
    }
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.serverEpoch = "ep-1"
    let stagedRows = (0..<staged).map(lap)
    let replica = LoadedReplica(
      meta: meta, confirmed: [Self.scope: Rows((staged..<(staged + confirmed)).map(lap))],
      staging: [Self.scope: Staging(digest: ScopeDigest(rows: stagedRows.map(\.json)), rows: Rows(stagedRows))],
      cursors: [Self.scope: CursorRecord()], wholeScopes: true)
    return try Store.inMemory(holding: LoadedDevice(meta: DeviceMeta(), active: "rp_1", replicas: [replica]), registry: Self.probe)
  }

  // The rows SQLite changed while `body` ran.
  static func changes(in store: Store, _ body: () throws -> Void) throws -> Int {
    let before = try store.writer.read { $0.totalChangesCount }
    try body()
    return try store.writer.read { $0.totalChangesCount } - before
  }

  @Test func anIndexedReadOfAFieldThatIsNotARefThrows() throws {
    let store = try Store.inMemory(registry: Self.probe)
    let replica = try store.firstLaunch(identities: try QueuedIdentities(["ids": ["rp_1"]])).value
    #expect(throws: StoreError.notARefField(type: "lap", field: "weight")) {
      try store.read { try $0.referencing(replica, in: Self.scope, type: "lap", field: "weight", target: "run00001") }
    }
  }
}
