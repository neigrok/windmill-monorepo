import SyncAPI
import SyncCore
import SyncReplica
import SyncTesting
import Testing

// Pages and frames: look-alike cursors and epochs are other ones, and what each leaves to pull (§7.5, §7.9).

struct PullTests {
  enum Carrier: CaseIterable {
    case page, frame
  }

  static let probe = try! Corpus.probeRegistry()
  static let instance = Instance(actor: try! Stamp.Actor("r_aaaaaaaaaaaa"), deviceNow: 1_000, appVersion: "1")
  static let tree = ScopeRef.tree("b_00000001")

  @Test func aPageAskedUnderALookAlikeCursorIsStale() throws {
    var replica = LoadedReplica(
      meta: ReplicaMeta(replica: "rp_1", state: .bound, account: "A"), cursors: [.product("probe"): CursorRecord(cursor: "c\u{E9}")],
      wholeScopes: true)
    let outcome = try PageApplier(registry: Self.probe).apply(
      PullPage(scope: .product("probe"), body: .reset), requestedUnder: "ce\u{301}", to: &replica, instance: Self.instance)
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
      "op": "change", "as": "A", "scope": "self/probe", "epoch": "ep-e\u{301}", "seq": 2,
      "digest": .string(String(repeating: "0", count: 64)), "rows": [],
    ])
    #expect(try PageApplier(registry: Self.probe).apply(frame, to: &replica, instance: Self.instance) == .pull)
    #expect(replica.writes == [])
  }

  // MARK: What a page or frame leaves to pull

  @Test(arguments: Carrier.allCases)
  func anIgnoredNotFoundRePullsATreeOnlyUntilItBoots(_ carrier: Carrier) throws {
    let midway = Cursor(epoch: "ep-1", mode: .boot, seq: 1, key: try Self.meta(seq: 1).key, asOf: 1).text
    #expect(try Self.end(.notFound, of: Self.tree, by: carrier, on: Self.replica()) == ("ignored", PullNext(pullsAgain: true)))
    #expect(try Self.end(.notFound, of: Self.tree, by: carrier, on: Self.replica(tree: CursorRecord(cursor: midway)))
      == ("ignored", PullNext(pullsAgain: true)))
    #expect(try Self.end(.notFound, of: Self.tree, by: carrier, on: Self.replica(tree: Self.booted(seq: 0)))
      == ("ignored", PullNext()))
  }

  @Test(arguments: Carrier.allCases)
  func anIgnoredNotFoundWantsATreeWaitingForItsBoardsCreateAtOnce(_ carrier: Carrier) throws {
    let born = "10:0:r_aaaaaaaaaaaa"
    let create = try Delta(json: ["t": "board", "id": "b_00000001", "life": ["alive", .string(born)], "born": .string(born)])
    let entry = OutboxEntry(
      localId: "g1/0", gestureId: "g1", lineage: "A", scope: .product("probe"), state: .ready, commitOrder: 1, releaseAt: 0,
      stamp: try Stamp(born), intent: Intent(scope: .product("probe"), deltas: [create]))
    #expect(try Self.end(.notFound, of: Self.tree, by: carrier, on: Self.replica(board: false, outbox: [entry]))
      == ("ignored", PullNext(scopes: [Self.tree])))
  }

  @Test(arguments: Carrier.allCases)
  func anIgnoredEndOfAProductScopeLeavesNothingToPull(_ carrier: Carrier) throws {
    #expect(try Self.end(.gone, of: .product("probe"), by: carrier, on: Self.replica()) == ("ignored", PullNext()))
    #expect(try Self.end(.notFound, of: .product("probe"), by: carrier, on: Self.replica()) == ("ignored", PullNext()))
  }

  @Test(arguments: Carrier.allCases, [KnownKind.gone, .notFound])
  func anAppliedEndLeavesNothingToPull(_ carrier: Carrier, _ kind: KnownKind) throws {
    #expect(try Self.end(kind, of: Self.tree, by: carrier, on: Self.replica(board: false)) == (kind.rawValue, PullNext()))
  }

  // Only the page that ends a boot's scan boots its scope; one short of it wants the scope again, and a frame boots none.
  @Test func onlyThePageThatEndsABootsScanBootsItsScope() throws {
    let meta = try Self.meta(seq: 1)
    let digest = ScopeDigest(rows: [meta.json])
    let live = Cursor(epoch: "ep-1", mode: .live, seq: 1).text
    let midway = Cursor(epoch: "ep-1", mode: .boot, seq: 1, key: meta.key, asOf: 1).text
    let page = { (cursor: String, more: Bool) in
      PullPage(scope: Self.tree, body: .rows(RowsPage(rows: [meta], cursor: cursor, more: more, seq: 1, digest: digest)))
    }
    #expect(try Self.land(page(live, false), on: Self.replica()) == ("applied", PullNext(boots: true)))
    #expect(try Self.land(page(midway, true), on: Self.replica()) == ("applied", PullNext(scopes: [Self.tree])))
    #expect(try Self.land(page(live, false), on: Self.replica(tree: Self.booted(seq: 0))) == ("applied", PullNext()))
    let change = { (seq: Int64) in
      try LiveFrame(json: [
        "op": "change", "as": "A", "scope": Self.tree.json, "epoch": "ep-1", "seq": JSON(seq), "digest": .string(digest.hex),
        "rows": [meta.json],
      ])
    }
    #expect(try Self.land(try change(1), on: Self.replica(tree: Self.booted(seq: 0))) == ("applied", PullNext()))
    #expect(try Self.land(try change(3), on: Self.replica(tree: Self.booted(seq: 0))) == ("pull", PullNext(scopes: [Self.tree])))
  }

  // A bound replica in epoch ep-1: the tree's board alive unless `board` is false, the tree's cursor `record`, `outbox`.
  static func replica(board: Bool = true, tree record: CursorRecord? = nil, outbox: [OutboxEntry] = []) throws -> LoadedReplica {
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.serverEpoch = "ep-1"
    let stamp = "1000:0:r_server00001"
    let alive = try Row(json: [
      "t": "board", "id": "b_00000001", "life": ["alive", .string(stamp)], "born": .string(stamp), "seq": 1, "rc": 1_000, "ru": 1_000,
    ])
    return LoadedReplica(
      meta: meta, outbox: outbox, confirmed: [.product("probe"): Rows(board ? [alive] : [])], cursors: record.map { [Self.tree: $0] } ?? [:],
      wholeScopes: true)
  }

  static func booted(seq: Int64) -> CursorRecord {
    CursorRecord(cursor: Cursor(epoch: "ep-1", mode: .live, seq: seq).text, booted: true)
  }

  static func meta(seq: Int64) throws -> Row {
    try Row(json: ["t": "meta", "id": "meta", "f": ["title": ["Plan", "1000:0:r_server00001"]], "seq": JSON(seq), "rc": 1_000, "ru": 1_000])
  }

  // A gone or not-found of `scope`, as a page asked under its stored cursor or as a frame.
  static func end(_ kind: KnownKind, of scope: ScopeRef, by carrier: Carrier, on replica: LoadedReplica) throws -> (String, PullNext) {
    switch carrier {
    case .page: try land(PullPage(scope: scope, body: kind == .gone ? .gone : .notFound), on: replica)
    case .frame: try land(kind == .gone ? LiveFrame.gone(scope, servedAs: "A") : .notFound(scope, servedAs: "A"), on: replica)
    }
  }

  // A page asked under its scope's stored cursor: its outcome, and what it leaves to pull.
  static func land(_ page: PullPage, on replica: LoadedReplica) throws -> (String, PullNext) {
    let applier = PageApplier(registry: probe)
    var after = replica
    let outcome = try applier.apply(page, requestedUnder: replica.cursors[page.scope]?.cursor, to: &after, instance: instance)
    return (outcome.rawValue, applier.next(after: page, outcome, from: replica, in: after))
  }

  static func land(_ frame: LiveFrame, on replica: LoadedReplica) throws -> (String, PullNext) {
    let applier = PageApplier(registry: probe)
    var after = replica
    let outcome = try applier.apply(frame, to: &after, instance: instance)
    return (outcome.rawValue, applier.next(after: frame, outcome, from: replica, in: after))
  }
}
