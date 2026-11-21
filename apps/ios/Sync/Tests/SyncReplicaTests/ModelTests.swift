import SyncAPI
import SyncCore
import SyncReplica
import Testing

// A partially loaded replica answers only for what its Action loaded: a planner reading any other row, outbox entry or
// notice is a loader bug, and the process traps instead of deciding from what it never saw.

struct ModelTests {
  @Test func bulkEntryMetadataMatchesIndividualUpdatesExactly() throws {
    let states: [EntryState] = [.held, .ready, .sent, .acked]
    let scopes: [ScopeRef] = [.product("probe"), .product("probe"), .tree("b_00000001"), .overlay("b_00000001")]
    let ids = ["caf\u{E9}/0", "cafe\u{301}/0", "third/0", "fourth/0"]
    let account = "cafe\u{301}"
    let entries = try states.enumerated().map { index, state in
      var entry = OutboxEntry(localId: ids[index], gestureId: "g\(index)", lineage: index == 1 ? account : "caf\u{E9}",
        scope: scopes[index], state: state, commitOrder: Int64(index + 1) * 10, releaseAt: 7,
        stamp: try Stamp("10:\(index):r_aaaaaaaaaaaa"),
        intent: Intent(n: index > 1 ? Int64(index - 1) : nil, scope: scopes[index],
          deltas: [Delta(key: RecordKey("tag", RecordID("step\(index)")))]),
        predict: [Delta(key: RecordKey("tag", RecordID("next\(index)")))])
      if state == .acked { entry.resultEpoch = "ep-1"; entry.resultSeq = 4 }
      return entry
    }
    var individual = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), outbox: Array(entries.reversed()), wholeScopes: true)
    var bulk = individual
    for entry in individual.outbox { individual.update(entry: entry.localId) { $0.lineage = account } }
    bulk.updateEntries { $0.lineage = account }
    #expect(bulk.outbox == entries.map { entry in var changed = entry; changed.lineage = account; return changed })
    #expect(bulk.json == individual.json)
    #expect(bulk.batch.writes == individual.batch.writes)
    #expect(bulk.batch.events == individual.batch.events)
    #expect(bulk.batch.change == individual.batch.change)
    #expect(bulk.batch.writes.count == 3)
    bulk.updateEntries { $0.lineage = account }
    #expect(bulk.batch.writes == individual.batch.writes)
    #expect(bulk.batch.change == individual.batch.change)
  }

  @Test func aThrowingBulkTransformKeepsTheSameCompletedWritesAsIndividualUpdates() throws {
    enum Stop: Error { case now }
    let entries = try (1...2).map { index in
      OutboxEntry(localId: "g\(index)/0", gestureId: "g\(index)", lineage: "anon", scope: .product("probe"), state: .ready,
        commitOrder: Int64(index), releaseAt: 0, stamp: try Stamp("10:0:r_aaaaaaaaaaaa"), intent: Intent(scope: .product("probe")))
    }
    var individual = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), outbox: entries, wholeScopes: true)
    var bulk = individual
    let change: (inout OutboxEntry) throws -> Void = { entry in
      entry.lineage = "A"
      if entry.commitOrder == 2 { throw Stop.now }
    }
    #expect(throws: Stop.self) {
      for entry in individual.outbox { try individual.update(entry: entry.localId, change) }
    }
    #expect(throws: Stop.self) { try bulk.updateEntries(change) }
    #expect(bulk.json == individual.json)
    #expect(bulk.batch.writes == individual.batch.writes)
    #expect(bulk.batch.events == individual.batch.events)
    #expect(bulk.batch.change == individual.batch.change)
  }

  @Test func readingARowTheLoadDidNotCoverTraps() async {
    await #expect(processExitsWith: .failure) {
      let rows = Rows(loaded: [], keys: [RecordKey("card", "card0001")], types: [], empty: false)
      _ = rows.row(RecordKey("card", "card0002"))
    }
  }

  @Test func readingATypeTheLoadDidNotCoverTraps() async {
    await #expect(processExitsWith: .failure) {
      let rows = Rows(loaded: [], keys: [RecordKey("card", "card0001")], types: ["lap"], empty: false)
      _ = rows.rows(ofType: "card")
    }
  }

  @Test func readingAScopeTheLoadLeftOutTraps() async {
    await #expect(processExitsWith: .failure) {
      let replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), wholeScopes: false)
      _ = replica.rows(.product("probe"))
    }
  }

  @Test func readingNoticesTheLoadLeftOutTraps() async {
    await #expect(processExitsWith: .failure) {
      let replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), notices: nil, wholeScopes: false)
      _ = replica.notices
    }
  }

  @Test func readingTheWholeOutboxOfAPartialLoadTraps() async {
    await #expect(processExitsWith: .failure) {
      let replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), entries: EntrySelection(heldGestures: true),
                                  wholeScopes: false)
      _ = replica.outbox
    }
  }

  @Test func readingEveryEntryOfAScopeAfterALoadOfPartOfTheOutboxTraps() async {
    await #expect(processExitsWith: .failure) {
      let replica = LoadedReplica(
        meta: ReplicaMeta(replica: "rp_1", state: .anon), entries: EntrySelection(),
        confirmed: [.product("probe"): Rows(loaded: [], keys: [RecordKey("card", "card0001")], types: [], empty: true)], wholeScopes: false)
      _ = replica.entries(in: .product("probe"))
    }
    await #expect(processExitsWith: .failure) {
      let replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), entries: EntrySelection(scopes: [.tree("b_00000001")]),
                                  wholeScopes: false)
      _ = replica.entries(in: .tree("b_00000002"))
    }
  }

  // The entries touching a record load with its row: reading those of a record the load did not read traps, one written since included.
  @Test func readingTheEntriesTouchingARecordTheLoadDidNotReadTraps() async throws {
    await #expect(processExitsWith: .failure) {
      let replica = LoadedReplica(
        meta: ReplicaMeta(replica: "rp_1", state: .anon), entries: EntrySelection(),
        confirmed: [.product("probe"): Rows(loaded: [], keys: [RecordKey("card", "card0001")], types: [], empty: true)], wholeScopes: false)
      _ = replica.entries(touching: RecordKey("card", "card0002"), in: .product("probe"))
    }
    await #expect(processExitsWith: .failure) {
      let stamp = try! Stamp("1000:0:r_aaaaaaaaaaaa")
      let row = Row(key: RecordKey("card", "card0009"), lattice: Lattice(life: Life(.alive, stamp), born: stamp), seq: 1)
      var replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), entries: EntrySelection(),
                                  confirmed: [.product("probe"): Rows(loaded: [], keys: [], types: [], empty: false)], wholeScopes: false)
      replica.apply(.putRow(.product("probe"), row))
      _ = replica.entries(touching: row.key, in: .product("probe"))
    }
    let row = Row(key: RecordKey("card", "card0001"), seq: 1)
    var replica = LoadedReplica(
      meta: ReplicaMeta(replica: "rp_1", state: .anon), entries: EntrySelection(),
      confirmed: [.product("probe"): Rows(loaded: [], keys: [row.key], types: [], empty: true)], wholeScopes: false)
    replica.apply(.putRow(.product("probe"), row))
    #expect(replica.entries(touching: row.key, in: .product("probe")) == [])
  }

  // After a load of part of the outbox, the entries that touch what was read are those that touch a record the rows it
  // read cover: a held gesture loaded for a retire, touching another record, is not one of them.
  @Test func theEntriesTouchingReadsAreThoseOfTheRecordsTheRowsCover() throws {
    let entry = { (localId: String, order: Int64, state: EntryState, card: String) in
      OutboxEntry(localId: localId, gestureId: String(localId.dropLast(2)), lineage: "anon", scope: .product("probe"), state: state,
                  commitOrder: order, releaseAt: 0, stamp: try Stamp("10:0:r_aaaaaaaaaaaa"),
                  intent: Intent(scope: .product("probe"), deltas: [Delta(key: RecordKey("card", RecordID(card)))]))
    }
    let touching = try entry("a/0", 1, .ready, "card0001")
    let replica = LoadedReplica(
      meta: ReplicaMeta(replica: "rp_1", state: .anon), outbox: [touching, try entry("h/0", 2, .held, "card0002")],
      entries: EntrySelection(heldGestures: true),
      confirmed: [.product("probe"): Rows(loaded: [], keys: [RecordKey("card", "card0001")], types: [], empty: true)], wholeScopes: false)
    #expect(replica.entriesTouchingReads == [touching])
    #expect(replica.heldGestures.map(\.localId) == ["h/0"])
  }

  @Test func readingHeldGesturesOrANumberTheLoadLeftOutTraps() async {
    await #expect(processExitsWith: .failure) {
      let replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), entries: EntrySelection(numbered: [1]), wholeScopes: false)
      _ = replica.heldGestures
    }
    await #expect(processExitsWith: .failure) {
      let replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), entries: EntrySelection(heldGestures: true), wholeScopes: false)
      _ = replica.sentEntry(numbered: 1)
    }
  }

  // A local id names one entry, which keeps its commit order: a put of another entry under a local id the copy holds
  // is a planner bug.
  @Test func puttingAnotherEntryUnderALoadedLocalIdTraps() async {
    await #expect(processExitsWith: .failure) {
      let entry = { (order: Int64) in
        OutboxEntry(localId: "g1/0", gestureId: "g1", lineage: "anon", scope: .product("probe"), state: .ready, commitOrder: order,
                    releaseAt: 0, stamp: try! Stamp("10:0:r_aaaaaaaaaaaa"), intent: Intent(scope: .product("probe")))
      }
      var replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .anon), outbox: [entry(1)], wholeScopes: true)
      replica.apply(.putEntry(entry(2)))
    }
  }

  // Device-row keys, and every identifier a replica's meta and entries hold, are the same only byte for byte: two keys
  // that differ by canonical equivalence are two rows, and a change to a look-alike is a write.
  @Test func lookAlikeDeviceRowKeysAreTwoRows() throws {
    var replica = LoadedReplica.fresh(ReplicaMeta(replica: "rp_1", state: .anon))
    replica.apply(.putDeviceRow(product: "probe", key: "\u{E9}", 1))
    replica.apply(.putDeviceRow(product: "probe", key: "e\u{301}", 2))
    replica.apply(.deleteDeviceRow(product: "probe", key: "e\u{301}"))
    replica.apply(.putDeviceRow(product: "probe", key: "e\u{301}", 3))
    #expect(replica.json["device"] == ["probe": ["e\u{301}": 3, "\u{E9}": 1]])
  }

  @Test func aChangeToALookAlikeIsAWrite() throws {
    let entry = OutboxEntry(
      localId: "g1/0", gestureId: "g1", lineage: "caf\u{E9}", scope: .product("probe"), state: .ready, commitOrder: 1, releaseAt: 0,
      stamp: try Stamp("10:0:r_aaaaaaaaaaaa"), intent: Intent(scope: .product("probe")))
    var replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_1", state: .bound, account: "caf\u{E9}"), outbox: [entry], wholeScopes: true)
    replica.update { $0.account = "cafe\u{301}" }
    replica.update(entry: "g1/0") { $0.lineage = "cafe\u{301}" }
    #expect(replica.writes.count == 2)
    #expect(replica.meta.json == ReplicaMeta(replica: "rp_1", state: .bound, account: "cafe\u{301}").json)
    #expect(try replica.outbox.map { try $0.json.member("lineage") } == ["cafe\u{301}"])
  }

  // A row written or deleted is known afterwards, whatever the load covered.
  @Test func aWrittenRowIsKnownWhateverTheLoadCovered() throws {
    var replica = LoadedReplica(
      meta: ReplicaMeta(replica: "rp_1", state: .anon), confirmed: [.product("probe"): Rows(loaded: [], keys: [], types: [], empty: false)],
      wholeScopes: false)
    let row = Row(key: RecordKey("card", "card0001"), seq: 1, rc: 1, ru: 1)
    replica.apply(.putRow(.product("probe"), row))
    replica.apply(.deleteRow(.product("probe"), RecordKey("card", "card0002")))
    #expect(replica.rows(.product("probe")).row(row.key) == row)
    #expect(replica.rows(.product("probe")).row(RecordKey("card", "card0002")) == nil)
  }
}
