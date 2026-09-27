import SyncAPI
import SyncCore
import SyncReplica
import SyncTesting
import Testing

// Pages and frames over cursors and epochs that differ only by Unicode canonical equivalence: they are other ones.

struct PullTests {
  static let probe = try! Corpus.probeRegistry()
  static let instance = Instance(actor: try! Stamp.Actor("r_aaaaaaaaaaaa"), deviceNow: 1_000, appVersion: "1")

  @Test func aPageAskedUnderALookAlikeCursorIsStale() throws {
    var replica = LoadedReplica(
      meta: ReplicaMeta(replica: "rp_1", state: .bound, account: "A"), cursors: [.product("probe"): CursorRecord(cursor: "c\u{E9}")],
      wholeScopes: true)
    let outcome = try PageApplier(registry: Self.probe).apply(
      Page(scope: .product("probe"), body: .reset), requestedUnder: "ce\u{301}", to: &replica, instance: Self.instance)
    #expect(outcome == .stale)
    #expect(replica.writes == [])
  }

  // A live frame of epoch "ep-e\u{301}" is not the replica's "ep-\u{E9}": the scope pulls instead of applying it.
  @Test func aFrameOfALookAlikeEpochIsPulled() throws {
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.serverEpoch = "ep-\u{E9}"
    let cursor = Cursor(epoch: "ep-\u{E9}", mode: .live, seq: 1).text
    var replica = LoadedReplica(meta: meta, cursors: [.product("probe"): CursorRecord(cursor: cursor, booted: true)], wholeScopes: true)
    let frame = try LiveFrame(json: [
      "op": "change", "scope": "self/probe", "epoch": "ep-e\u{301}", "seq": 2,
      "digest": .string(String(repeating: "0", count: 64)), "rows": [],
    ])
    #expect(try PageApplier(registry: Self.probe).apply(frame, to: &replica, instance: Self.instance) == .pull)
    #expect(replica.writes == [])
  }
}
