import SyncAPI
import SyncCore
import SyncReplica
import SyncTesting
import Testing

// Pages and frames: look-alike cursors and epochs are other ones, a rows page applied in chunks ends as the page applied
// whole, a scope `behind` takes no frame inline, a scope outside the subscription set takes nothing, and what each page
// or frame leaves to pull (§7.5, §7.9).

struct PullTests {
  enum Carrier: CaseIterable {
    case page, frame
  }

  static let probe = try! Corpus.probeRegistry()
  static let instance = Instance(actor: try! Stamp.Actor("r_aaaaaaaaaaaa"), deviceNow: 1_000, appVersion: "1")
  static let tree = ScopeRef.tree("b_00000001")
  static let product = ScopeRef.product("probe")
  static let everyScope: Set<ScopeRef> = [product, tree, .overlay("b_00000001")]

  @Test func aPageAskedUnderALookAlikeCursorIsStale() throws {
    var replica = LoadedReplica(
      meta: ReplicaMeta(replica: "rp_1", state: .bound, account: "A"), cursors: [Self.product: CursorRecord(cursor: "c\u{E9}")],
      wholeScopes: true)
    let page = PullPage(scope: Self.product, body: .reset)
    let outcome = try PageApplier(registry: Self.probe).apply(
      page, requestedUnder: "ce\u{301}", chunk: .whole(page), to: &replica, subscribed: Self.everyScope, instance: Self.instance)
    #expect(outcome == .stale)
    #expect(replica.writes == [])
  }

  // A live frame of epoch "ep-e\u{301}" is not the replica's "ep-\u{E9}": the scope pulls instead of applying it.
  @Test func aFrameOfALookAlikeEpochIsPulled() throws {
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.serverEpoch = "ep-\u{E9}"
    let cursor = Cursor(epoch: "ep-\u{E9}", mode: .live, seq: 1).text
    var replica = LoadedReplica(meta: meta, cursors: [Self.product: CursorRecord(cursor: cursor, booted: true)], wholeScopes: true)
    let frame = try LiveFrame(json: [
      "op": "change", "as": "A", "scope": "self/probe", "epoch": "ep-e\u{301}", "seq": 2,
      "digest": .string(String(repeating: "0", count: 64)), "rows": [],
    ])
    #expect(try PageApplier(registry: Self.probe).apply(frame, to: &replica, subscribed: Self.everyScope, instance: Self.instance) == .pull)
    #expect(replica.writes == [])
  }

  // MARK: Chunks (§7.5 step 2)

  // Every way of cutting a page into chunks of whole rows leaves the replica as the page applied whole; every chunk before
  // the last leaves the cursor where it was and the scope `behind`, with the rows so far and their digest.
  @Test(arguments: [1, 2, 3])
  func aPageAppliedInChunksEndsAsThePageAppliedWhole(_ size: Int) throws {
    let rows = try (1...4).map { try Self.card("card000\($0)", seq: Int64($0)) }
    let page = Self.rows(rows, at: 4)
    let whole = try Self.chunks(page, of: .max, on: try Self.replica(product: Self.booted(seq: 0)))
    let cut = try Self.chunks(page, of: size, on: try Self.replica(product: Self.booted(seq: 0)))
    #expect(cut.last?.replica.json == whole.last?.replica.json)
    #expect(cut.map(\.outcome) == Array(repeating: nil, count: cut.count - 1) + [PageOutcome.applied])
    for (index, taken) in cut.dropLast().enumerated() {
      let applied = Array(rows.prefix((index + 1) * size))
      #expect(taken.replica.cursors[Self.product] == CursorRecord(
        cursor: Cursor(epoch: "ep-1", mode: .live, seq: 0).text, digest: ScopeDigest(rows: applied.map(\.json)), booted: true, behind: true))
      #expect(taken.replica.rows(Self.product).all == applied)
    }
    #expect(whole.last?.replica.cursors[Self.product] == CursorRecord(
      cursor: Cursor(epoch: "ep-1", mode: .live, seq: 4).text, digest: ScopeDigest(rows: rows.map(\.json)), booted: true))
  }

  // The first chunk of the page asked under the null cursor starts a boot's staging afresh over confirmed rows, dropping a
  // staging a death cut short; a later boot page's chunks join it, and only the last chunk of the page that ends the scan
  // swaps it in.
  @Test func theFirstChunkOfABootStartsStagingAfreshAndALaterBootPageJoinsIt() throws {
    let stale = try Self.card("card0009", seq: 1)
    let kept = try Self.card("card0001", seq: 1)
    let later = try Self.card("card0002", seq: 2)
    let midway = Cursor(epoch: "ep-1", mode: .boot, seq: 2, key: kept.key, asOf: 2).text
    let replica = LoadedReplica(
      meta: try Self.bound(), confirmed: [Self.product: Rows([stale])],
      staging: [Self.product: Staging(digest: ScopeDigest(rows: [stale.json]), rows: Rows([stale]))],
      cursors: [Self.product: CursorRecord(digest: ScopeDigest(rows: [stale.json]))], wholeScopes: true)
    let first = try Self.chunks(Self.rows([kept], at: 2, cursor: midway, more: true), of: 1, requested: nil, on: replica)
    #expect(first.last?.replica.staging[Self.product] == Staging(digest: ScopeDigest(rows: [kept.json]), rows: Rows([kept])))
    #expect(first.last?.replica.rows(Self.product).all == [stale])
    let last = try Self.chunks(Self.rows([later], at: 2, digestOf: [kept, later]), of: 1, requested: midway, on: first.last!.replica)
    #expect(last.last?.replica.staging[Self.product] == nil)
    #expect(last.last?.replica.rows(Self.product).all == [kept, later])
    #expect(last.last?.replica.cursors[Self.product] == CursorRecord(
      cursor: Cursor(epoch: "ep-1", mode: .live, seq: 2).text, digest: ScopeDigest(rows: [kept.json, later.json]), booted: true))
  }

  // A page short of its head leaves its scope `behind`; the next page at the head clears it.
  @Test func aPageShortOfItsHeadLeavesTheScopeBehindAndOneAtTheHeadClearsIt() throws {
    let card = try Self.card("card0001", seq: 1)
    let short = try Self.chunks(Self.rows([card], at: 3, cursor: Cursor(epoch: "ep-1", mode: .live, seq: 1).text, more: true), of: .max,
                                on: try Self.replica(product: Self.booted(seq: 0)))
    #expect(short.last?.replica.cursors[Self.product]?.behind == true)
    let head = try Self.chunks(Self.rows([], at: 3, digestOf: [card]), of: .max, on: short.last!.replica)
    #expect(head.last?.replica.cursors[Self.product]?.behind == false)
  }

  // Each chunk checks the page anew: one that finds the cursor moved or the scope outside the set applies nothing.
  @Test func aChunkThatFindsItsPageStaleOrOutsideTheSetAppliesNothing() throws {
    let page = Self.rows([try Self.card("card0001", seq: 1), try Self.card("card0002", seq: 2)], at: 2)
    let applier = PageApplier(registry: Self.probe)
    var replica = try Self.replica(product: Self.booted(seq: 0))
    let requested = replica.cursors[Self.product]?.cursor
    let chunks = PageChunk.of(page, size: 1)
    #expect(try applier.apply(page, requestedUnder: requested, chunk: chunks[0], to: &replica, subscribed: Self.everyScope,
                              instance: Self.instance) == nil)
    let applied = replica
    #expect(try applier.apply(page, requestedUnder: requested, chunk: chunks[1], to: &replica, subscribed: [Self.tree],
                              instance: Self.instance) == .outside)
    replica.apply(.putCursor(Self.product, Self.booted(seq: 1)))
    let moved = replica
    #expect(try applier.apply(page, requestedUnder: requested, chunk: chunks[1], to: &replica, subscribed: Self.everyScope,
                              instance: Self.instance) == .stale)
    #expect(replica.json == moved.json)
    #expect(applied.rows(Self.product).all.map(\.key) == [RecordKey("card", "card0001")])
  }

  @Test(arguments: [(3, [0..<3]), (1, [0..<1, 1..<2, 2..<3]), (2, [0..<2, 2..<3]), (5, [0..<3])])
  func aPageIsCutIntoChunksOfWholeRowsInPageOrder(_ size: Int, _ ranges: [Range<Int>]) throws {
    let page = Self.rows(try (1...3).map { try Self.card("card000\($0)", seq: Int64($0)) }, at: 3)
    #expect(PageChunk.of(page, size: size) == ranges.enumerated().map { PageChunk(rows: $1, isLast: $0 == ranges.count - 1) })
    #expect(PageChunk.of(PullPage(scope: Self.product, body: .reset), size: 1) == [PageChunk(rows: 0..<0, isLast: true)])
  }

  // MARK: Frames and the subscription set

  // A scope `behind` may hold rows that are not the server's at its cursor's seq, so the next seq's frame is pulled.
  @Test func aChangeFrameForAScopeBehindIsPulled() throws {
    var record = Self.booted(seq: 1)
    record.behind = true
    var replica = try Self.replica(product: record)
    let frame = try Self.change(Self.product, seq: 2, rows: [try Self.card("card0001", seq: 2)])
    #expect(try PageApplier(registry: Self.probe).apply(frame, to: &replica, subscribed: Self.everyScope, instance: Self.instance) == .pull)
    #expect(replica.writes == [])
  }

  // A scope outside the subscription set, or known, takes nothing, whatever cursor its page was asked under.
  @Test(arguments: Carrier.allCases)
  func aScopeOutsideTheSetTakesNothing(_ carrier: Carrier) throws {
    let meta = try Self.meta(seq: 1)
    var replica = try Self.replica()
    replica.apply(.putKnown(.overlay("b_00000001"), .gone))
    let known = replica.json
    for (scope, set) in [(Self.tree, Set([Self.product])), (ScopeRef.overlay("b_00000001"), Self.everyScope)] {
      let outcome: String = switch carrier {
      case .page:
        try PageApplier(registry: Self.probe).apply(
          PullPage(scope: scope, body: .rows(RowsPage(rows: [meta], cursor: Cursor(epoch: "ep-1", mode: .live, seq: 1).text, more: false,
                                                      seq: 1, digest: ScopeDigest(rows: [meta.json])))),
          requestedUnder: nil, chunk: PageChunk(rows: 0..<1, isLast: true), to: &replica, subscribed: set, instance: Self.instance)?.rawValue ?? "nil"
      case .frame:
        try PageApplier(registry: Self.probe).apply(.gone(scope, servedAs: "A"), to: &replica, subscribed: set, instance: Self.instance).rawValue
      }
      #expect(outcome == "outside")
    }
    #expect(replica.json == known)
  }

  // §7.9 the set: a bound replica's products, a tree and overlay per board alive in drawn or in stored (a held create's,
  // and one inside its delete's window), then the scopes held open; less known scopes. A signed-out replica holds only
  // the trees it opened.
  @Test func theSubscriptionSetIsTheProductsTheTreesOfBoardsAliveInDrawnOrStoredAndTheScopesOpened() throws {
    let lifecycle = ReplicaLifecycle(registry: Self.probe)
    let stamp = "1000:0:r_server00001"
    let board = { (id: String) in
      try Row(json: ["t": "board", "id": .string(id), "life": ["alive", .string(stamp)], "born": .string(stamp), "seq": 1, "rc": 1_000, "ru": 1_000])
    }
    let born = try Stamp("2000:0:r_aaaaaaaaaaaa")
    let heldCreate = OutboxEntry(
      localId: "g1/0", gestureId: "g1", lineage: "A", scope: Self.product, state: .held, commitOrder: 1, releaseAt: 9_000, stamp: born,
      intent: Intent(scope: Self.product, deltas: [Delta(key: RecordKey("board", "b_00000003"), lattice: Lattice(life: Life(.alive, born), born: born))]))
    let heldDelete = OutboxEntry(
      localId: "g2/0", gestureId: "g2", lineage: "A", scope: Self.product, state: .held, commitOrder: 2, releaseAt: 9_000, stamp: born,
      intent: Intent(scope: Self.product, deltas: [Delta(key: RecordKey("board", "b_00000002"), lattice: Lattice(life: Life(.dead, born)))]))
    let replica = LoadedReplica(
      meta: try Self.bound(), outbox: [heldCreate, heldDelete],
      confirmed: [Self.product: Rows([try board("b_00000001"), try board("b_00000002")])],
      known: [.overlay("b_00000001"): .gone], wholeScopes: true)
    let own = SubscriptionSet.own(Subscriptions(products: ["probe"], opened: [.tree("b_0000000f"), Self.tree]))
    #expect(try lifecycle.subscriptionSet(of: replica, own) == [
      Self.product, Self.tree, .tree("b_00000002"), .overlay("b_00000002"), .tree("b_00000003"), .overlay("b_00000003"),
      .tree("b_0000000f"),
    ])
    let signedOut = LoadedReplica(meta: ReplicaMeta(replica: "rp_2", state: .anon), wholeScopes: true)
    #expect(try lifecycle.subscriptionSet(of: signedOut, .own(Subscriptions(products: ["probe"], opened: [Self.tree, .overlay("b_00000001")])))
      == [Self.tree])
    #expect(try lifecycle.subscriptionSet(of: replica, .given([.overlay("b_00000001"), Self.product])) == [Self.product])
  }

  // MARK: What a page or frame leaves to pull

  // An ignored end leaves its scope to its doubt's re-pull (§7.9), unless the scope waits for its board's create.
  @Test(arguments: Carrier.allCases)
  func anIgnoredNotFoundLeavesNothingToPullAtOnce(_ carrier: Carrier) throws {
    let midway = Cursor(epoch: "ep-1", mode: .boot, seq: 1, key: try Self.meta(seq: 1).key, asOf: 1).text
    #expect(try Self.end(.notFound, of: Self.tree, by: carrier, on: Self.replica()) == ("ignored", []))
    #expect(try Self.end(.notFound, of: Self.tree, by: carrier, on: Self.replica(tree: CursorRecord(cursor: midway))) == ("ignored", []))
    #expect(try Self.end(.notFound, of: Self.tree, by: carrier, on: Self.replica(tree: Self.booted(seq: 0))) == ("ignored", []))
  }

  @Test(arguments: Carrier.allCases)
  func anIgnoredNotFoundWantsATreeWaitingForItsBoardsCreateAtOnce(_ carrier: Carrier) throws {
    let born = "10:0:r_aaaaaaaaaaaa"
    let create = try Delta(json: ["t": "board", "id": "b_00000001", "life": ["alive", .string(born)], "born": .string(born)])
    let entry = OutboxEntry(
      localId: "g1/0", gestureId: "g1", lineage: "A", scope: Self.product, state: .ready, commitOrder: 1, releaseAt: 0,
      stamp: try Stamp(born), intent: Intent(scope: Self.product, deltas: [create]))
    #expect(try Self.end(.notFound, of: Self.tree, by: carrier, on: Self.replica(board: false, outbox: [entry])) == ("ignored", [Self.tree]))
  }

  @Test(arguments: Carrier.allCases)
  func anIgnoredEndOfAProductScopeLeavesNothingToPull(_ carrier: Carrier) throws {
    #expect(try Self.end(.gone, of: Self.product, by: carrier, on: Self.replica()) == ("ignored", []))
    #expect(try Self.end(.notFound, of: Self.product, by: carrier, on: Self.replica()) == ("ignored", []))
  }

  @Test(arguments: Carrier.allCases, [KnownKind.gone, .notFound])
  func anAppliedEndLeavesNothingToPull(_ carrier: Carrier, _ kind: KnownKind) throws {
    #expect(try Self.end(kind, of: Self.tree, by: carrier, on: Self.replica(board: false)) == (kind.rawValue, []))
  }

  // A page short of its head wants its scope again; one at the head, and a frame admitted, want nothing; one not admitted
  // wants its scope.
  @Test func aPageShortOfItsHeadWantsItsScopeAgain() throws {
    let meta = try Self.meta(seq: 1)
    let digest = ScopeDigest(rows: [meta.json])
    let live = Cursor(epoch: "ep-1", mode: .live, seq: 1).text
    let midway = Cursor(epoch: "ep-1", mode: .boot, seq: 1, key: meta.key, asOf: 1).text
    let page = { (cursor: String, more: Bool) in
      PullPage(scope: Self.tree, body: .rows(RowsPage(rows: [meta], cursor: cursor, more: more, seq: 1, digest: digest)))
    }
    #expect(try Self.land(page(live, false), on: Self.replica()) == ("applied", []))
    #expect(try Self.land(page(midway, true), on: Self.replica()) == ("applied", [Self.tree]))
    #expect(try Self.land(page(live, false), on: Self.replica(tree: Self.booted(seq: 0))) == ("applied", []))
    #expect(try Self.land(try Self.change(Self.tree, seq: 1, rows: [meta]), on: Self.replica(tree: Self.booted(seq: 0))) == ("applied", []))
    #expect(try Self.land(try Self.change(Self.tree, seq: 3, rows: [meta]), on: Self.replica(tree: Self.booted(seq: 0))) == ("pull", [Self.tree]))
  }

  // MARK: Fixtures

  static func bound() throws -> ReplicaMeta {
    var meta = ReplicaMeta(replica: "rp_1", state: .bound, account: "A")
    meta.serverEpoch = "ep-1"
    return meta
  }

  // A bound replica in epoch ep-1: the tree's board alive unless `board` is false, the cursors given, `outbox`.
  static func replica(board: Bool = true, product: CursorRecord? = nil, tree record: CursorRecord? = nil,
                      outbox: [OutboxEntry] = []) throws -> LoadedReplica {
    let stamp = "1000:0:r_server00001"
    let alive = try Row(json: [
      "t": "board", "id": "b_00000001", "life": ["alive", .string(stamp)], "born": .string(stamp), "seq": 1, "rc": 1_000, "ru": 1_000,
    ])
    var cursors: [ScopeRef: CursorRecord] = [:]
    cursors[Self.tree] = record
    cursors[Self.product] = product
    let rows = product == nil && board ? [alive] : []
    return LoadedReplica(meta: try bound(), outbox: outbox, confirmed: [Self.product: Rows(rows)], cursors: cursors, wholeScopes: true)
  }

  static func booted(seq: Int64) -> CursorRecord {
    CursorRecord(cursor: Cursor(epoch: "ep-1", mode: .live, seq: seq).text, booted: true)
  }

  static func meta(seq: Int64) throws -> Row {
    try Row(json: ["t": "meta", "id": "meta", "f": ["title": ["Plan", "1000:0:r_server00001"]], "seq": JSON(seq), "rc": 1_000, "ru": 1_000])
  }

  static func card(_ id: String, seq: Int64) throws -> Row {
    let stamp = "\(seq)000:0:r_server00001"
    return try Row(json: [
      "t": "card", "id": .string(id), "life": ["alive", .string(stamp)], "born": .string(stamp), "f": ["title": [.string(id), .string(stamp)]],
      "seq": JSON(seq), "rc": JSON(seq), "ru": JSON(seq),
    ])
  }

  // A rows page of the product scope ending at `cursor`, live at `seq` unless given; its digest is the sum of `alive`,
  // the page's rows unless given.
  static func rows(_ rows: [Row], at seq: Int64, cursor: String? = nil, more: Bool = false, digestOf alive: [Row]? = nil) -> PullPage {
    PullPage(scope: product, body: .rows(RowsPage(
      rows: rows, cursor: cursor ?? Cursor(epoch: "ep-1", mode: .live, seq: seq).text, more: more, seq: seq,
      digest: ScopeDigest(rows: (alive ?? rows).map(\.json)))))
  }

  static func change(_ scope: ScopeRef, seq: Int64, rows: [Row]) throws -> LiveFrame {
    try LiveFrame(json: [
      "op": "change", "as": "A", "scope": scope.json, "epoch": "ep-1", "seq": JSON(seq), "digest": .string(ScopeDigest(rows: rows.map(\.json)).hex),
      "rows": .array(rows.map(\.json)),
    ])
  }

  // Each transaction of `page` in chunks of `size` rows, asked under `requested` (the stored cursor by default): the
  // replica after it and its outcome.
  static func chunks(_ page: PullPage, of size: Int, requested: String?? = .none, on replica: LoadedReplica) throws
    -> [(replica: LoadedReplica, outcome: PageOutcome?)] {
    let applier = PageApplier(registry: probe)
    let asked = requested ?? replica.cursors[page.scope]?.cursor
    var after = replica
    return try PageChunk.of(page, size: size).map { chunk in
      let outcome = try applier.apply(page, requestedUnder: asked, chunk: chunk, to: &after, subscribed: everyScope, instance: instance)
      return (after, outcome)
    }
  }

  // A gone or not-found of `scope`, as a page asked under its stored cursor or as a frame.
  static func end(_ kind: KnownKind, of scope: ScopeRef, by carrier: Carrier, on replica: LoadedReplica) throws -> (String, [ScopeRef]) {
    switch carrier {
    case .page: try land(PullPage(scope: scope, body: kind == .gone ? .gone : .notFound), on: replica)
    case .frame: try land(kind == .gone ? LiveFrame.gone(scope, servedAs: "A") : .notFound(scope, servedAs: "A"), on: replica)
    }
  }

  // A page asked under its scope's stored cursor, whole: its outcome, and what it leaves to pull.
  static func land(_ page: PullPage, on replica: LoadedReplica) throws -> (String, [ScopeRef]) {
    let applier = PageApplier(registry: probe)
    var after = replica
    let outcome = try applier.apply(page, requestedUnder: replica.cursors[page.scope]?.cursor, chunk: .whole(page), to: &after,
                                    subscribed: everyScope, instance: instance)
    return (outcome?.rawValue ?? "nil", applier.next(after: page, chunk: .whole(page), outcome, from: replica, in: after))
  }

  static func land(_ frame: LiveFrame, on replica: LoadedReplica) throws -> (String, [ScopeRef]) {
    let applier = PageApplier(registry: probe)
    var after = replica
    let outcome = try applier.apply(frame, to: &after, subscribed: everyScope, instance: instance)
    return (outcome.rawValue, applier.next(after: frame, outcome, from: replica, in: after))
  }
}
