import SyncAPI
import SyncCore
import SyncReplica
import Testing

// A partially loaded replica answers only for what its Action loaded: a planner reading any other row is a loader
// bug, and the process traps instead of deciding from a row it never saw.

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
