import SyncAPI
import SyncCore
import SyncReplica
import Testing

// A partially loaded replica answers only for what its Action loaded: a planner reading any other row, or notices it
// did not load, is a loader bug, and the process traps instead of deciding from what it never saw.

struct ModelTests {
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
