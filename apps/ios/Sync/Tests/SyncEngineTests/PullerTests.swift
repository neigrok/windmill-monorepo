import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import SyncStore
import SyncTesting
import Synchronization
import Testing

// §7.5 the puller over a scripted transport: boot, staging and its swap, reset, epoch change, the digest check's reset
// and stop, the request's scopes, each failure row of design §6.3, the triggers, re-pulls after an ignored not-found, live
// frame admission, and the revalidation of what moved while a request was in flight.

struct PullerTests {
  static let tree = ScopeRef.tree("b_00000001")
  static let overlay = ScopeRef.overlay("b_00000001")

  static func live(_ seq: Int64, epoch: String = "ep-1") -> String { Cursor(epoch: epoch, mode: .live, seq: seq).text }

  static func pulled(_ scope: ScopeRef, _ cursor: String?) -> PullRequest.Pulled { PullRequest.Pulled(scope: scope, cursor: cursor) }

  static func applied(_ scopes: ScopeRef...) -> PullerStep { .pulled(scopes.map { PageReport(scope: $0, outcome: .applied) }) }

  // The active replica with every row loaded.
  static func whole(_ rig: Rig) throws -> LoadedReplica { try rig.store.read { try $0.device(rows: true).activeReplica } }

  // The replica's rows of `scope`, each as its JSON.
  static func rows(_ rig: Rig, _ scope: ScopeRef = Rig.scope) throws -> [JSON] {
    try whole(rig).confirmed[scope]?.all.map(\.json) ?? []
  }

  static func cursor(_ rig: Rig, _ scope: ScopeRef = Rig.scope) throws -> CursorRecord? { try rig.active().cursors[scope] }

  // A bound device whose product scope booted to live at seq 1 holding card0001.
  static func booted() throws -> (rig: Rig, card: Row) {
    let rig = try Rig(account: "A")
    let card = try Rig.cardRow("card0001", "One", seq: 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([card], seq: 1)]))
    return (rig, card)
  }

  // MARK: Boot

  @Test func aBootFromANullCursorGoesStraightInAndTurnsLive() async throws {
    let (rig, card) = try Self.booted()
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.calls == [.pull(PullRequest(scopes: [Self.pulled(Rig.scope, nil)]), token: SessionToken("token-1"))])
    #expect(try Self.rows(rig) == [card.json])
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(1), digest: card.digest, booted: true))
    #expect(try rig.meta().serverEpoch == "ep-1")
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
    #expect(rig.transport.pulls.count == 1)
  }

  // A boot page with more rows keeps pulling from its cursor until the cursor turns live.
  @Test func aBootInPagesPullsAgainUntilItsCursorTurnsLive() async throws {
    let rig = try Rig(account: "A")
    let cards = [try Rig.cardRow("card0001", "One", seq: 1), try Rig.cardRow("card0002", "Two", seq: 2)]
    let midway = Cursor(epoch: "ep-1", mode: .boot, seq: 1, key: cards[0].key, asOf: 2).text
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([cards[0]], seq: 2, cursor: midway, more: true, digestOf: cards)]))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([cards[1]], seq: 2, digestOf: cards)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(try Self.cursor(rig) == CursorRecord(cursor: midway, digest: cards[0].digest, behind: true))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.pulls == [
      PullRequest(scopes: [Self.pulled(Rig.scope, nil)]), PullRequest(scopes: [Self.pulled(Rig.scope, midway)]),
    ])
    #expect(try Self.rows(rig) == cards.map(\.json))
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(2), digest: ScopeDigest(rows: cards.map(\.json)), booted: true))
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
  }

  // A reset page nulls the cursor, and the scope boots again: into staging, since confirmed rows exist, and staging
  // replaces them on the page whose cursor turns live.
  @Test func aResetBootsTheScopeAgainIntoStagingSwappedInWhenItTurnsLive() async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    let fresh = [try Rig.cardRow("card0002", "Two", seq: 4), try Rig.cardRow("card0003", "Three", seq: 5)]
    let midway = Cursor(epoch: "ep-1", mode: .boot, seq: 4, key: fresh[0].key, asOf: 5).text
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "reset")]))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([fresh[0]], seq: 5, cursor: midway, more: true, digestOf: fresh)]))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([fresh[1]], seq: 5, digestOf: fresh)]))
    rig.engine.foreground()
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .reset)]))
    #expect(try Self.cursor(rig) == CursorRecord(digest: card.digest, booted: true))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(try Self.rows(rig) == [card.json])
    #expect(try Self.whole(rig).staging[Rig.scope] == Staging(digest: fresh[0].digest, rows: Rows([fresh[0]])))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(try Self.rows(rig) == fresh.map(\.json))
    #expect(try Self.whole(rig).staging[Rig.scope] == nil)
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(5), digest: ScopeDigest(rows: fresh.map(\.json)), booted: true))
    #expect(rig.transport.pulls.map(\.scopes) == [
      [Self.pulled(Rig.scope, nil)], [Self.pulled(Rig.scope, Self.live(1))], [Self.pulled(Rig.scope, nil)], [Self.pulled(Rig.scope, midway)],
    ])
  }

  // §7.5 step 1: another epoch nulls every cursor and drops every staging, returns acked entries of the old epoch to
  // ready, and re-identifies; the page asked under the old cursor is stale, and every scope boots again.
  @Test func anEpochChangeNullsEveryCursorReidentifiesAndBootsEveryScopeAgain() async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    try rig.commit(Gesture(changes: [Rig.card("card0009", "Nine")], gestureId: "g1"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 2)]))
    #expect(await rig.engine.sender.step() == .again)
    let before = try rig.meta().replica
    rig.random.queue(symbol: 1, of: 16, count: 32)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 2, cursor: Self.live(2))], epoch: "ep-2"))
    rig.engine.foreground()
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .stale)]))
    let meta = try rig.meta()
    #expect(meta.replica == "rp_" + String(repeating: "1", count: 32) && meta.replica != before)
    #expect(meta.serverEpoch == "ep-2")
    #expect(try rig.outbox() == ["g1/0 ready"])
    #expect(try Self.cursor(rig) == CursorRecord(digest: card.digest, booted: true))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([card], seq: 1, epoch: "ep-2")], epoch: "ep-2"))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Rig.scope, nil)]))
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(1, epoch: "ep-2"), digest: card.digest, booted: true))
  }

  // MARK: Chunks (§7.5 step 2) and the writer (§2.5)

  // Five cards the server holds at seqs 1 to 5.
  static func cards() throws -> [Row] {
    try (1...5).map { try Rig.cardRow("card000\($0)", "C\($0)", seq: Int64($0)) }
  }

  // A page applies in chunks of whole rows, each its own transaction, and a commit that waits for the writer while a chunk
  // holds it takes it before the page's next chunk.
  @Test(.timeLimit(.minutes(1))) func aPageAppliesInChunksAndACommitWaitingForTheWriterGoesBetweenThem() async throws {
    let order = Mutex<[TxName]>([])
    let inLine = Mutex(0)
    let engine = Mutex<SyncEngine?>(nil)
    let rig = try Rig(account: "A", slicing: .fixed(.init(chunkRows: 2)), crashPoints: CrashPoints { point in
      guard case .afterCommit(let tx) = point, tx == .pullPage || tx == .commit else { return }
      let chunks = order.withLock { order in
        order.append(tx)
        return order.filter { $0 == .pullPage }.count
      }
      guard tx == .pullPage, chunks == 1, let running = engine.withLock({ $0 }) else { return }
      Thread { _ = try? running.commit(Rig.scope, Gesture(changes: [.put("day", "2026-09-01", present: true, ["score": 1])])) }.start()
      let giveUp = ContinuousClock.now + .seconds(5)
      while running.writers.waiting == 0, ContinuousClock.now < giveUp {}
      inLine.withLock { $0 = running.writers.waiting }
    })
    engine.withLock { $0 = rig.engine }
    let cards = try Self.cards()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(cards, seq: 5)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(inLine.withLock { $0 } == 1)
    #expect(order.withLock { $0 } == [.pullPage, .commit, .pullPage, .pullPage])
    #expect(try Self.rows(rig) == cards.map(\.json))
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(5), digest: ScopeDigest(rows: cards.map(\.json)), booted: true))
  }

  // A process death between two chunks keeps the chunks committed: their rows and digest, the cursor where it was and the
  // scope `behind`. The next process pulls the page again under the unmoved cursor, and ends as the page applied whole.
  @Test func aDeathBetweenChunksLeavesTheScopeBehindAndThePagePulledAgainEndsAsWhole() async throws {
    let dead = Mutex(false)
    let rig = try Rig(account: "A", slicing: .fixed(.init(chunkRows: 2)), crashPoints: CrashPoints { point in
      guard point == .afterCommit(.pullPage), !dead.withLock({ $0 }) else { return }
      dead.withLock { $0 = true }
      throw RigError("the process died")
    })
    rig.random.queue(raw: .max, count: 1)
    let cards = try Self.cards()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(cards, seq: 5)]))
    #expect(await rig.engine.puller.step() == .backoff(ms: 1_000))
    #expect(try Self.rows(rig) == cards.prefix(2).map(\.json))
    #expect(try Self.cursor(rig) == CursorRecord(digest: ScopeDigest(rows: cards.prefix(2).map(\.json)), behind: true))
    let relaunched = try rig.relaunch()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(cards, seq: 5)]))
    relaunched.puller.wants.all()
    #expect(await relaunched.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.pulls.map(\.scopes) == [[Self.pulled(Rig.scope, nil)], [Self.pulled(Rig.scope, nil)]])
    #expect(try Self.rows(rig) == cards.map(\.json))
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(5), digest: ScopeDigest(rows: cards.map(\.json)), booted: true))
    #expect(try Self.whole(rig).staging[Rig.scope] == nil)
  }

  // A page ends at the chunk that finds its scope outside the set: a tree closed after the page's first chunk and opened
  // again after its second takes none of the rest, which would land beside rows the close forgot.
  @Test(.timeLimit(.minutes(1))) func aTreeClosedAndOpenedAgainBetweenChunksTakesNoLaterChunk() async throws {
    let chunks = Mutex(0)
    let engine = Mutex<SyncEngine?>(nil)
    let rig = try Rig(account: "A", slicing: .fixed(.init(chunkRows: 2)), crashPoints: CrashPoints { point in
      guard point == .afterCommit(.pullPage), let running = engine.withLock({ $0 }) else { return }
      let chunk = chunks.withLock { chunks in
        chunks += 1
        return chunks
      }
      guard chunk <= 2 else { return }
      Thread {
        if chunk == 1 { try? running.unsubscribe(Self.tree) } else { _ = try? running.subscribe(Self.tree) }
      }.start()
      let giveUp = ContinuousClock.now + .seconds(5)
      while running.writers.waiting == 0, ContinuousClock.now < giveUp {}
    })
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    try rig.engine.subscribe(Self.tree)
    engine.withLock { $0 = rig.engine }
    let tags = try (1...6).map { index in
      try Row(json: [
        "t": "tag", "id": .string("tag-\(index)"), "life": ["alive", "1000:0:r_server00001"], "born": "1000:0:r_server00001",
        "seq": JSON(index), "rc": 1_000, "ru": 1_000,
      ])
    }
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(tags, in: Self.tree, seq: 6)]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Self.tree, outcome: .outside)]))
    #expect(chunks.withLock { $0 } == 2)
    #expect(try Self.rows(rig, Self.tree) == [])
    #expect(try Self.cursor(rig, Self.tree) == nil)
  }

  // Each chunk is sized by how long its scope's last held the writer on the engine's clock (§2.5): two hold 50 ms, the rest nothing.
  @Test func eachChunkIsSizedByHowLongTheLastHeldTheWriterOnTheEnginesClock() async throws {
    let clock = Mutex<SimClock?>(nil)
    let store = Mutex<Store?>(nil)
    let applied = Mutex<[Int]>([])
    let rig = try Rig(account: "A", crashPoints: CrashPoints { point in
      guard let clock = clock.withLock({ $0 }), let store = store.withLock({ $0 }) else { return }
      switch point {
      case .beforeCommit(.pullPage): if applied.withLock({ $0.count }) < 2 { clock.advance(ms: 50) }
      case .afterCommit(.pullPage):
        let rows = try store.read { tx in try tx.replica(tx.activeReplica(), reads: [Rig.scope: RowSelection(all: true)])! }.rows(Rig.scope).all
        applied.withLock { $0.append(rows.count) }
      default: break
      }
    })
    clock.withLock { $0 = rig.clock }
    store.withLock { $0 = rig.store }
    let cards = try (1...100).map { try Rig.cardRow("card\(1_000 + $0)", "C\($0)", seq: Int64($0)) }
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(cards, seq: 100)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(applied.withLock { $0 } == [64, 79, 82, 88, 100])
    #expect(rig.engine.slices.size(.chunk(Rig.scope)) == 24)
    #expect(rig.engine.slices.size(.chunk(Self.tree)) == 64)
  }

  // A chunk outside the set applies nothing and leaves its scope's size: a tree's pages hold 1 ms and 1 ms more per 64 rows offered.
  @Test func chunksThatApplyNothingLeaveTheirScopesSizeAsItWas() async throws {
    let engine = Mutex<(engine: SyncEngine, clock: SimClock)?>(nil)
    let phase = Mutex<(outside: Int, log: [String]?)>((0, nil))
    let rig = try Rig(account: "A", crashPoints: CrashPoints { point in
      guard case .beforeCommit(.pullPage) = point, let (engine, clock) = engine.withLock({ $0 }) else { return }
      let size = engine.slices.size(.chunk(Self.tree))
      let hold = phase.withLock { phase -> Int64 in
        let outside = phase.outside > 0
        let hold = outside ? 1 : 1 + Int64(size) / 64
        phase.outside -= outside ? 1 : 0
        phase.log?.append("\(outside ? "outside" : "applied") offered \(size) held \(hold)")
        return hold
      }
      clock.advance(ms: hold)
    })
    let tags = try (1...3000).map { index in
      try Row(json: [
        "t": "tag", "id": .string("tag-\(index)"), "life": ["alive", "1000:0:r_server00001"], "born": "1000:0:r_server00001",
        "seq": JSON(index), "rc": 1_000, "ru": 1_000,
      ])
    }
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    engine.withLock { $0 = (rig.engine, rig.clock) }
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(tags, in: Self.tree, seq: 3000)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree))
    try rig.engine.unsubscribe(Self.tree)
    phase.withLock { $0 = (3, []) }
    rig.engine.puller.wants.add([Rig.scope])
    rig.transport.willAnswerPull(200, Rig.pulled(Array(repeating: Rig.rows(tags, in: Self.tree, seq: 3000), count: 3)))
    #expect(await rig.engine.puller.step() == .pulled(Array(repeating: PageReport(scope: Self.tree, outcome: .outside), count: 3)))
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(tags, in: Self.tree, seq: 3000)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree))
    #expect(phase.withLock { $0.log } == Array(repeating: "outside offered 744 held 1", count: 3)
      + Array(repeating: "applied offered 744 held 12", count: 5))
  }

  // Each settling slice is sized by how long the last held the writer (§2.5): 60 entries a page covers, the first slice holding 50 ms.
  @Test func eachSettlingSliceIsSizedByHowLongTheLastHeldTheWriterOnTheEnginesClock() async throws {
    let store = Mutex<(store: Store, clock: SimClock)?>(nil)
    let left = Mutex<[Int]>([])
    let rig = try Rig(account: "A", crashPoints: CrashPoints { point in
      guard let (store, clock) = store.withLock({ $0 }) else { return }
      switch point {
      case .beforeCommit(.settle): if left.withLock({ $0.isEmpty }) { clock.advance(ms: 50) }
      case .afterCommit(.settle):
        let count = try store.read { tx in try tx.replica(tx.activeReplica())!.outbox.count }
        left.withLock { $0.append(count) }
      default: break
      }
    })
    try rig.commit(Gesture(changes: Rig.days(60), gestureId: "g1"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 60, (1...60).map { Rig.admitted($0, seq: $0) }))
    #expect(await rig.engine.sender.step() == .again)
    store.withLock { $0 = (rig.store, rig.clock) }
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 60)]))
    rig.engine.puller.wants.all()
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(left.withLock { $0 } == [27, 20, 6, 0])
    #expect(rig.engine.slices.size(.settle) == 56)
  }

  // Five days put in one gesture, pushed and acked at seqs 1 to 5: acked entries a page at seq 5 covers.
  static func ackedDays(_ rig: Rig) async throws {
    try rig.commit(Gesture(changes: (1...5).map { .put("day", RecordID("2026-09-0\($0)"), present: true, ["score": JSON($0)]) }, gestureId: "g1"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 5, (1...5).map { Rig.admitted($0, seq: $0) }))
    #expect(await rig.engine.sender.step() == .again)
  }

  // §7.5 step 2: a page's last chunk settles the first entry its cursor covers, and slices the rest in commit order before the next page.
  @Test func aPagesCoveredEntriesSettleInSlicesAfterItsLastChunk() async throws {
    let settled = Mutex<[String]>([])
    let store = Mutex<Store?>(nil)
    let rig = try Rig(account: "A", slicing: .fixed(.init(settleEntries: 2)), crashPoints: CrashPoints { point in
      guard case .afterCommit(let tx) = point, tx == .pullPage || tx == .settle, let store = store.withLock({ $0 }) else { return }
      let left = try store.read { tx in try tx.replica(tx.activeReplica())!.outbox.map(\.localId) }
      settled.withLock { $0.append("\(tx.rawValue) \(left)") }
    })
    try await Self.ackedDays(rig)
    store.withLock { $0 = rig.store }
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 5), Rig.rows(in: Self.tree, seq: 0)]))
    try rig.engine.subscribe(Self.tree)
    rig.engine.puller.wants.all()
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope, Self.tree))
    #expect(settled.withLock { $0 } == [
      "pullPage [\"g1/1\", \"g1/2\", \"g1/3\", \"g1/4\"]", "settle [\"g1/3\", \"g1/4\"]", "settle []", "pullPage []",
    ])
  }

  // A death between two settling slices keeps what the slices resolved; the entries left stay acked, and the scope's
  // next page, empty at its head, settles them.
  @Test func aDeathBetweenSlicesLeavesTheRestAckedUntilTheNextPage() async throws {
    let dead = Mutex(false)
    let rig = try Rig(account: "A", slicing: .fixed(.init(settleEntries: 2)), crashPoints: CrashPoints { point in
      guard point == .afterCommit(.settle), !dead.withLock({ $0 }) else { return }
      dead.withLock { $0 = true }
      throw RigError("the process died")
    })
    try await Self.ackedDays(rig)
    rig.random.queue(raw: .max, count: 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 5)]))
    rig.engine.puller.wants.all()
    #expect(await rig.engine.puller.step() == .backoff(ms: 1_000))
    #expect(try rig.outbox() == ["g1/3 acked 4", "g1/4 acked 5"])
    let relaunched = try rig.relaunch()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 5, digestOf: [])]))
    relaunched.puller.wants.all()
    #expect(await relaunched.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.pulls.last?.scopes == [Self.pulled(Rig.scope, Self.live(5))])
    #expect(try rig.outbox() == [])
  }

  // A frame applied inline settles its first covered entries in its own transaction, and slices the rest.
  @Test func aFrameAppliedInlineSettlesInSlices() async throws {
    let order = Mutex<[TxName]>([])
    let rig = try Rig(account: "A", slicing: .fixed(.init(settleEntries: 1)), crashPoints: CrashPoints { point in
      guard case .afterCommit(let tx) = point, tx == .liveFrame || tx == .settle else { return }
      order.withLock { $0.append(tx) }
    })
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    try rig.commit(Gesture(changes: (1...3).map { .put("day", RecordID("2026-09-0\($0)"), present: true, ["score": JSON($0)]) }, gestureId: "g1"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 3, (1...3).map { Rig.admitted($0, seq: 1) }))
    #expect(await rig.engine.sender.step() == .again)
    await rig.engine.puller.enqueue(try Rig.change(rows: [], seq: 1, digestOf: []), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .applied))
    #expect(order.withLock { $0 } == [.liveFrame, .settle, .settle])
    #expect(try rig.outbox() == [])
  }

  // §2.5: the confirmed rows a staging swap replaced leave every view at once; the swap wakes the sweep, which deletes
  // them afterwards.
  @Test func aSwapLeavesTheRowsItReplacedToTheSweep() async throws {
    let (rig, _) = try Self.booted()
    _ = await rig.engine.puller.step()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "reset")]))
    rig.engine.puller.wants.all()
    _ = await rig.engine.puller.step()
    let fresh = try Rig.cardRow("card0002", "Two", seq: 2)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([fresh], seq: 2)]))
    let kicks = rig.engine.sweeper.wake.kicks
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.engine.sweeper.wake.kicks > kicks)
    #expect(try rig.store.read { try $0.releasedRows() } == 1)
    #expect(try Self.rows(rig) == [fresh.json])
    #expect(rig.engine.sweeper.step() == .idle)
    #expect(try rig.store.read { try $0.releasedRows() } == 0)
    #expect(try Self.rows(rig) == [fresh.json])
  }

  // MARK: The digest check (§7.5 step 4)

  // A first mismatch emits the event and resets the scope, which boots again into staging; a second, the flag still
  // set, emits it once more, clears the flag, and stops checking the scope at this app version.
  @Test func aDigestMismatchResetsTheScopeAndASecondStopsItsChecks() async throws {
    let rig = try Rig(account: "A")
    var events = rig.engine.events().makeAsyncIterator()
    let card = try Rig.cardRow("card0001", "One", seq: 1)
    let wrong = [try Rig.cardRow("card0001", "Other", seq: 1)]
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([card], seq: 1, digestOf: wrong)]))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([card], seq: 1, digestOf: wrong)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(await events.next() == .digestMismatch(kind: "product", seq: 1))
    #expect(try Self.cursor(rig) == CursorRecord(digest: card.digest, booted: true, mismatchReset: true))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(await events.next() == .digestMismatch(kind: "product", seq: 1))
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(1), digest: card.digest, booted: true, digestStop: "1.0"))
    #expect(rig.transport.pulls.map(\.scopes) == [[Self.pulled(Rig.scope, nil)], [Self.pulled(Rig.scope, nil)]])
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
  }

  @Test func aMatchingCheckClearsTheMismatchReset() async throws {
    let rig = try Rig(account: "A")
    let card = try Rig.cardRow("card0001", "One", seq: 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([card], seq: 1, digestOf: [])]))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([card], seq: 1)]))
    _ = await rig.engine.puller.step()
    #expect(try Self.cursor(rig)?.mismatchReset == true)
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(1), digest: card.digest, booted: true))
  }

  // MARK: The request

  // At most PULL_MAX_SCOPES scopes go in one request, in subscription order; the rest go in the next.
  @Test func aRequestNamesAtMostPullMaxScopesAndTheRestGoNext() async throws {
    let rig = try Rig(account: "A")
    let trees = (1...Constants.pullMaxScopes).map { ScopeRef.tree("b_\(String(format: "%08x", $0))") }
    for tree in trees { try rig.engine.subscribe(tree) }
    rig.transport.willAnswerPull(200, Rig.pulled([]))
    rig.transport.willAnswerPull(200, Rig.pulled([]))
    #expect(await rig.engine.puller.step() == .pulled([]))
    #expect(await rig.engine.puller.step() == .pulled([]))
    #expect(rig.transport.pulls.map { $0.scopes.map(\.scope) } == [[Rig.scope] + trees.dropLast(), [trees.last!]])
  }

  // A scope the replica knows gone or not found is left out of every request; subscribed again, one known gone answers
  // `.gone` and stays gone, since its death is final, while one known not found is pulled again from a boot.
  @Test func aScopeKnownGoneIsLeftOutAndStaysGone() async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    try rig.engine.subscribe(Self.overlay)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.page(Self.tree, "gone"), Rig.page(Self.overlay, "not-found")]))
    #expect(await rig.engine.puller.step() == .pulled([
      PageReport(scope: Rig.scope, outcome: .applied), PageReport(scope: Self.tree, outcome: .gone),
      PageReport(scope: Self.overlay, outcome: .notFound),
    ]))
    #expect(try rig.active().known == [Self.tree: .gone, Self.overlay: .notFound])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    rig.engine.foreground()
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Rig.scope, Self.live(0))]))
    #expect(try rig.engine.subscribe(Self.tree) == .gone)
    #expect(try rig.engine.subscribe(Self.overlay) == .subscribed)
    #expect(try rig.active().known == [Self.tree: .gone])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(in: Self.overlay, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.overlay))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Self.overlay, nil)]))
  }

  // §9.1: a pull served as anyone but the replica's account (anonymous, `as` null, or another account) is handled as a
  // 401, whatever its pages say: nothing past its offset sample is applied or forgotten, sync pauses, and the scope is
  // pulled again from where it stood once the account re-authenticates.
  @Test(arguments: [nil, "B"] as [String?])
  func aPullServedAsAnotherPrincipalForgetsNothingAndPauses(_ served: String?) async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "not-found")], as: served))
    rig.engine.foreground()
    #expect(await rig.engine.puller.step() == .paused)
    #expect(try Self.rows(rig) == [card.json])
    #expect(try rig.active().known == [:])
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(1), digest: card.digest, booted: true))
    #expect(try rig.meta().authPaused)
    #expect(await rig.engine.puller.step() == .paused)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 1, digestOf: [card])]))
    try rig.engine.reauthenticate(token: SessionToken("token-2"))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Rig.scope, Self.live(1))]))
  }

  // An answer served as anonymous says nothing of the account's scopes: a tree asked alone is not forgotten, though its
  // page says not-found, and it is pulled again once the account re-authenticates.
  @Test func aTreePulledAloneAndServedAsAnonymousIsNotForgotten() async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.rows([try Rig.metaRow(seq: 1)], in: Self.tree, seq: 1)]))
    _ = await rig.engine.puller.step()
    rig.engine.puller.wants.add([Self.tree])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found")], as: nil))
    #expect(await rig.engine.puller.step() == .paused)
    #expect(try rig.active().known == [:])
    #expect(try Self.rows(rig, Self.tree) == [try Rig.metaRow(seq: 1).json])
    #expect(try rig.meta().authPaused)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.rows(in: Self.tree, seq: 1, digestOf: [try Rig.metaRow(seq: 1)])]))
    try rig.engine.reauthenticate(token: SessionToken("token-2"))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope, Self.tree))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Rig.scope, Self.live(0)), Self.pulled(Self.tree, Self.live(1))]))
  }

  // A pull the `anon` replica sent, answered as anonymous after a sign-in bound that replica to A in place, says nothing
  // of A's replica: none of it is applied, A is not paused (its own token was never refused), and the round looks again,
  // pulling the tree as A from where it stood.
  @Test(.timeLimit(.minutes(1))) func anAnonymousAnswerLandingAfterASignInIsDropped() async throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "Offline")], gestureId: "g1"))
    try rig.engine.subscribe(Self.tree)
    let meta = try Rig.metaRow(seq: 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([meta], in: Self.tree, seq: 1)], as: nil))
    _ = await rig.engine.puller.step()
    let replica = try rig.meta().replica
    let gate = Gate()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found")], as: nil), after: gate)
    rig.engine.foreground()
    async let asked = rig.engine.puller.step()
    await gate.arrival()
    #expect(try await rig.signIn("A", holds: ["probe": false]).isComplete)
    #expect(try rig.meta().replica == replica && rig.meta().account == "A")
    gate.open()
    #expect(await asked == .again)
    #expect(try rig.active().known == [:])
    #expect(try Self.rows(rig, Self.tree) == [meta.json])
    #expect(try Self.cursor(rig, Self.tree) == CursorRecord(cursor: Self.live(1), digest: meta.digest, booted: true))
    #expect(try !rig.meta().authPaused)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.rows(in: Self.tree, seq: 1, digestOf: [meta])]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope, Self.tree))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Rig.scope, nil), Self.pulled(Self.tree, Self.live(1))]))
  }

  // §7.12: an answer for a replica no longer active applies nothing, though that replica is still in the store: here a
  // sign-out left it dormant while its pull was in flight, and the round looks again, for the replica now active.
  @Test(.timeLimit(.minutes(1))) func aPullAnsweredAfterASignOutAppliesNothingToTheDormantReplica() async throws {
    let rig = try Rig(account: "A")
    let replica = try rig.meta().replica
    let gate = Gate()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([try Rig.cardRow("card0001", "One", seq: 1)], seq: 1)]), after: gate)
    async let asked = rig.engine.puller.step()
    await gate.arrival()
    try await rig.engine.signOut().finish(.keep)
    #expect(try rig.store.read { try $0.device().replica(replica)?.meta.state } == .dormant)
    let held = try rig.store.read { try $0.device(rows: true).json }
    gate.open()
    #expect(await asked == .again)
    #expect(try rig.store.read { try $0.device(rows: true).json } == held)
  }

  // §7.12: a frame for a replica no longer active applies nothing, though that replica is still in the store: here a
  // sign-out left it dormant between the frame's arrival and its turn.
  @Test func aFrameQueuedBeforeASignOutAppliesNothingToTheDormantReplica() async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.rows([try Rig.metaRow(seq: 1)], in: Self.tree, seq: 1)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope, Self.tree))
    await rig.engine.puller.enqueue(.gone(Self.tree, servedAs: "A"), for: try rig.meta().replica)
    try await rig.engine.signOut().finish(.keep)
    let held = try rig.store.read { try $0.device(rows: true).json }
    #expect(await rig.engine.puller.step() == .frame(Self.tree, nil))
    #expect(try rig.store.read { try $0.device(rows: true).json } == held)
  }

  // §9.1: an `as` that is not a string is still not the account's, so the answer pauses sync as a 401 does, rather than
  // reading as no answer and backing off for ever.
  @Test func aPullServedAsANonStringPauses() async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    rig.transport.willAnswerPull(200, ["serverTime": JSON(Rig.startMs), "epoch": "ep-1", "as": 42, "pages": [Rig.page(Rig.scope, "not-found")]])
    rig.engine.foreground()
    #expect(await rig.engine.puller.step() == .paused)
    #expect(try Self.rows(rig) == [card.json])
    #expect(try rig.active().known == [:])
    #expect(try rig.meta().authPaused)
  }

  // §7.5 step 2: a product scope never dies, so its gone or not-found, served as the account, is ignored: nothing is
  // forgotten or recorded, sync goes on, and the scope is in doubt, pulled again as its re-pull draws (§7.9); the frame's
  // end, while the doubt lasts, draws nothing more.
  @Test(arguments: ["not-found", "gone"])
  func aProductScopesEndIsIgnored(_ kind: String) async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    rig.random.queue(raw: .max, count: 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, kind)]))
    rig.engine.foreground()
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .ignored)]))
    #expect(try Self.rows(rig) == [card.json])
    #expect(try rig.active().known == [:])
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(1), digest: card.digest, booted: true))
    #expect(try !rig.meta().authPaused)
    #expect(await rig.engine.puller.step() == .repull(ms: 1_000))
    let frame: LiveFrame = kind == "gone" ? .gone(Rig.scope, servedAs: "A") : .notFound(Rig.scope, servedAs: "A")
    await rig.engine.puller.enqueue(frame, for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .ignored))
    #expect(try Self.rows(rig) == [card.json])
    #expect(try rig.active().known == [:])
    #expect(await rig.engine.puller.step() == .repull(ms: 1_000))
    #expect(rig.transport.pulls.count == 2)
  }

  // A frame served as anyone but the replica's account is handled as a 401: nothing is applied or forgotten, and sync
  // pauses.
  @Test(arguments: [nil, "B"] as [String?])
  func aFrameServedAsAnotherPrincipalPausesAndAppliesNothing(_ served: String?) async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    let next = try Rig.cardRow("card0002", "Two", seq: 2)
    await rig.engine.puller.enqueue(try Rig.change(rows: [next], seq: 2, digestOf: [card, next], as: served), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .paused))
    await rig.engine.puller.enqueue(.gone(Rig.scope, servedAs: served), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .paused))
    #expect(try Self.rows(rig) == [card.json])
    #expect(try rig.active().known == [:])
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(1), digest: card.digest, booted: true))
    #expect(try rig.meta().authPaused)
  }

  // §7.9: a board arriving alive clears a stale not-found of its tree and overlay (a restore, then a create re-sent after
  // it), so the tree, and the overlay that joins the set with the board, are pulled at once, booting from nothing.
  @Test func anAliveBoardInAFrameBringsItsTreeBack() async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.page(Self.tree, "not-found")]))
    _ = await rig.engine.puller.step()
    #expect(try rig.active().known == [Self.tree: .notFound])
    let board = try Self.board(seq: 1)
    await rig.engine.puller.enqueue(try Rig.change(rows: [board], seq: 1, digestOf: [board]), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .applied))
    #expect(try rig.active().known == [:])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(in: Self.tree, seq: 0), Rig.rows(in: Self.overlay, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree, Self.overlay))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Self.tree, nil), Self.pulled(Self.overlay, nil)]))
  }

  // §7.9: the rule holds for a pull page as for a frame: an alive board in a rows page clears its tree's not-found, and
  // the tree and its overlay are pulled by the next run.
  @Test func anAliveBoardInAPageBringsItsTreeBack() async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.page(Self.tree, "not-found")]))
    _ = await rig.engine.puller.step()
    #expect(try rig.active().known == [Self.tree: .notFound])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([try Self.board(seq: 1)], seq: 1)]))
    rig.engine.puller.wants.add([Rig.scope])
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(try rig.active().known == [:])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(in: Self.tree, seq: 0), Rig.rows(in: Self.overlay, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree, Self.overlay))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Self.tree, nil), Self.pulled(Self.overlay, nil)]))
  }

  // §7.9: an alive board clears only a not-found record; a gone one stays, since a scope's death is final (INV-13).
  @Test func anAliveBoardLeavesItsGoneTreeGone() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([try Self.board(seq: 2, life: "dead", ms: 2_000)], seq: 2, digestOf: [])]))
    _ = await rig.engine.puller.step()
    #expect(try rig.active().known == [Self.tree: .gone, Self.overlay: .gone])
    let alive = try Self.board(seq: 3, ms: 3_000)
    await rig.engine.puller.enqueue(try Rig.change(rows: [alive], seq: 3, digestOf: [alive]), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .applied))
    #expect(try rig.active().known == [Self.tree: .gone, Self.overlay: .gone])
  }

  // A board row of the server's, alive or dead at `ms`.
  static func board(seq: Int64, life: String = "alive", ms: Int64 = 1_000) throws -> Row {
    try Row(json: [
      "t": "board", "id": "b_00000001", "life": [.string(life), .string("\(ms):0:r_server00001")], "born": "1000:0:r_server00001",
      "seq": JSON(seq), "rc": 1_000, "ru": JSON(ms),
    ])
  }

  // §7.9: a signed-out replica pulls only the trees it opens, and without a token.
  @Test func aSignedOutReplicaPullsOnlyTheTreesItOpensWithoutAToken() async throws {
    let rig = try Rig()
    #expect(await rig.engine.puller.step() == .idle)
    try rig.engine.subscribe(Self.tree)
    try rig.engine.subscribe(Self.overlay)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(in: Self.tree, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree))
    #expect(rig.transport.calls == [.pull(PullRequest(scopes: [Self.pulled(Self.tree, nil)]), token: nil)])
  }

  // MARK: Triggers

  // Subscribing pulls the new scope alone; unsubscribing forgets it.
  @Test func aNewSubscriptionIsPulledAloneAndAnEndedOneIsForgotten() async throws {
    let (rig, _) = try Self.booted()
    _ = await rig.engine.puller.step()
    let meta = try Rig.metaRow(seq: 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([meta], in: Self.tree, seq: 1)]))
    try rig.engine.subscribe(Self.tree)
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Self.tree, nil)]))
    #expect(try Self.rows(rig, Self.tree) == [meta.json])
    try rig.engine.unsubscribe(Self.tree)
    #expect(try Self.cursor(rig, Self.tree) == nil)
    #expect(try Self.rows(rig, Self.tree) == [])
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
  }

  // §7.9: a scope subscribed again boots, known not found no more. Here a board's tree was opened before the board,
  // created on another device, reached the server, and answered not-found; opened again once the board exists, it is
  // pulled, and written.
  @Test func aScopeKnownNotFoundIsPulledOnceSubscribedAgain() async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.page(Self.tree, "not-found")]))
    _ = await rig.engine.puller.step()
    #expect(try rig.active().known == [Self.tree: .notFound])
    #expect(try rig.engine.subscribe(Self.tree) == .subscribed)
    #expect(try rig.active().known == [:])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(in: Self.tree, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Self.tree, nil)]))
    let outcome = try rig.engine.commit(Self.tree, Gesture(changes: [.write("meta", "meta", ["title": "Plan"])]))
    guard case .committed = outcome else { throw RigError("the tree's commit was \(outcome)") }
  }

  // §7.9: an entry acked in a scope no longer followed resolves at the next pull round, since no pull of its scope brings
  // its row. Here the tree closes while its entry is in flight.
  @Test(.timeLimit(.minutes(1))) func anEntryAckedInATreeClosedWhileItWasInFlightResolvesAtTheNextPullRound() async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    try rig.commit(Gesture(changes: [.write("meta", "meta", ["title": "Plan"])], gestureId: "g1"), in: Self.tree)
    let gate = Gate()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]), after: gate)
    async let pushed = rig.engine.sender.step()
    await gate.arrival()
    try rig.engine.unsubscribe(Self.tree)
    gate.open()
    #expect(await pushed == .again)
    #expect(try rig.outbox() == ["g1/0 acked 1"])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(try rig.outbox() == [])
  }

  // §7.9: no scope is open in a new process, so the trees the last one held open have left the set, and their acked
  // entries resolve at its first pull round.
  @Test func theTreesTheLastProcessHeldOpenResolveTheirAckedEntries() async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    try rig.commit(Gesture(changes: [.write("meta", "meta", ["title": "Plan"])], gestureId: "g1"), in: Self.tree)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    let relaunched = try rig.relaunch()
    #expect(try rig.outbox() == ["g1/0 acked 1"])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await relaunched.puller.step() == Self.applied(Rig.scope))
    #expect(try rig.outbox() == [])
  }

  // §7.5, §7.9: a tree known not found is followed no more, whoever holds it open, so an entry acked in it resolves at the
  // next pull round; here the tree answered not-found before its board, created on another device, reached the server,
  // and the write into it was admitted after.
  @Test func anEntryAckedInATreeKnownNotFoundResolvesAtTheNextPullRound() async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    try rig.commit(Gesture(changes: [.write("meta", "meta", ["title": "Plan"])], gestureId: "g1"), in: Self.tree)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.page(Self.tree, "not-found")]))
    _ = await rig.engine.puller.step()
    #expect(try rig.active().known == [Self.tree: .notFound])
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(try rig.outbox() == ["g1/0 acked 1"])
    rig.engine.puller.wants.all()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(try rig.outbox() == [])
  }

  // §7.9: a tree whose board's create is in the outbox waits, with its overlay, both in the subscription set: neither is
  // pulled, and a round with nothing else to pull sends nothing. A not-found for the tree, from a request made before the
  // board was committed, is ignored and records nothing, so writes into the tree are taken, and the tree is in doubt. Once
  // the create has its result the puller is woken, and both boot, which ends the doubt.
  @Test(.timeLimit(.minutes(1))) func aTreeWaitsForItsBoardsCreateThenBoots() async throws {
    let (rig, _) = try Self.booted()
    _ = await rig.engine.puller.step()
    try rig.engine.subscribe(Self.tree)
    rig.random.queue(raw: .max, count: 1)
    let gate = Gate()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found")]), after: gate)
    async let asked = rig.engine.puller.step()
    await gate.arrival()
    try rig.commit(Gesture(changes: [.create("board", id: .given("b_00000001"))], gestureId: "g1"))
    gate.open()
    #expect(await asked == .pulled([PageReport(scope: Self.tree, outcome: .ignored)]))
    #expect(try rig.active().known == [:])
    try rig.commit(Gesture(changes: [.write("meta", "meta", ["title": "Plan"])], gestureId: "g2"), in: Self.tree)
    #expect(await rig.engine.puller.step() == .repull(ms: 1_000))
    #expect(rig.transport.pulls.count == 2)

    let kicks = rig.engine.puller.wake.kicks
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 2, [Rig.admitted(1, seq: 2), Rig.admitted(2, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(rig.engine.puller.wake.kicks > kicks)
    let meta = try Rig.metaRow(seq: 1, ms: Rig.startMs)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([meta], in: Self.tree, seq: 1), Rig.rows(in: Self.overlay, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree, Self.overlay))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Self.tree, nil), Self.pulled(Self.overlay, nil)]))
    #expect(try Self.cursor(rig, Self.tree)?.booted == true)
    #expect(!rig.engine.doubts.inDoubt(Self.tree))
  }

  // §7.9: the tree's pull left before its board was committed, and the server answered not-found; the board's create is
  // pushed and acked while that answer is on its way, and only then does it land. The replica holds the board alive, so
  // the answer is stale: ignored, nothing recorded, and the tree in doubt. The overlay, which joined the set with the
  // board, is pulled at once; the tree when its first re-pull comes, drawn below 1 s, and it boots and takes a write.
  @Test(.timeLimit(.minutes(1))) func aNotFoundWrittenBeforeTheBoardsCreateLandingAfterItsAckIsIgnored() async throws {
    let (rig, _) = try Self.booted()
    _ = await rig.engine.puller.step()
    try rig.engine.subscribe(Self.tree)
    rig.random.queue(raw: .max, count: 1)
    let gate = Gate()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found")]), after: gate)
    async let asked = rig.engine.puller.step()
    await gate.arrival()
    try rig.commit(Gesture(changes: [.create("board", id: .given("b_00000001"))], gestureId: "g1"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 2)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(try rig.outbox() == ["g1/0 acked 1"])
    gate.open()
    #expect(await asked == .pulled([PageReport(scope: Self.tree, outcome: .ignored)]))
    #expect(try rig.active().known == [:])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(in: Self.overlay, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.overlay))
    #expect(await rig.engine.puller.step() == .repull(ms: 1_000))
    rig.clock.advance(ms: 1_000)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(in: Self.tree, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree))
    #expect(rig.transport.pulls.suffix(2) == [PullRequest(scopes: [Self.pulled(Self.overlay, nil)]), PullRequest(scopes: [Self.pulled(Self.tree, nil)])])
    #expect(try Self.cursor(rig, Self.tree)?.booted == true)
    let outcome = try rig.engine.commit(Self.tree, Gesture(changes: [.write("meta", "meta", ["title": "Plan"])], gestureId: "g2"))
    guard case .committed = outcome else { throw RigError("the tree's commit was \(outcome)") }
  }

  // §7.9: the same through the live socket: the not-found frame the server wrote for the `sub`, applied after the board's
  // create was answered ok, is ignored for the tree and its overlay alike.
  @Test func aNotFoundFrameQueuedBeforeTheBoardsAckIsIgnored() async throws {
    let (rig, _) = try Self.booted()
    _ = await rig.engine.puller.step()
    try rig.engine.subscribe(Self.tree)
    try rig.engine.subscribe(Self.overlay)
    try rig.commit(Gesture(changes: [.create("board", id: .given("b_00000001"))], gestureId: "g1"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 2)]))
    let replica = try rig.meta().replica
    await rig.engine.puller.enqueue(.notFound(Self.tree, servedAs: "A"), for: replica)
    await rig.engine.puller.enqueue(.notFound(Self.overlay, servedAs: "A"), for: replica)
    #expect(await rig.engine.sender.step() == .again)
    #expect(try rig.outbox() == ["g1/0 acked 1"])
    #expect(await rig.engine.puller.step() == .frame(Self.tree, .ignored))
    #expect(await rig.engine.puller.step() == .frame(Self.overlay, .ignored))
    #expect(try rig.active().known == [:])
  }

  // §7.9: a board whose delete is on its way is dead in `drawn` and in `stored`: the replica holds it alive nowhere, so a
  // not-found for its tree is an end, and recorded.
  @Test func aNotFoundForATreeWhoseBoardsDeleteIsSentIsRecorded() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([try Self.board(seq: 1)], seq: 1)]))
    _ = await rig.engine.puller.step()
    try rig.engine.subscribe(Self.tree)
    try rig.commit(Gesture(changes: [.delete("board", "b_00000001")], gestureId: "g1"))
    await rig.engine.puller.enqueue(.notFound(Self.tree, servedAs: "A"), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Self.tree, .notFound))
    #expect(try rig.active().known == [Self.tree: .notFound])
  }

  // MARK: Doubt (§7.9, INV-16)

  // A bound replica whose board b_00000001 is confirmed, so its tree and overlay are in the subscription set; a first
  // round pulled the product scope, a second the tree and overlay, the tree answered by `tree` and the overlay booted.
  static func governed(tree: JSON) async throws -> Rig {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([try Self.board(seq: 1)], seq: 1)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    rig.transport.willAnswerPull(200, Rig.pulled([tree, Rig.rows(in: Self.overlay, seq: 0)]))
    _ = await rig.engine.puller.step()
    return rig
  }

  // An ignored end puts its scope in doubt: its first re-pull is drawn, not taken at once, and each re-pull answered by
  // another ignored end draws the next on the scope's own k, 1 s to 30 s; a rows page ends the doubt and its re-pulls.
  @Test func anIgnoredEndPutsItsScopeInDoubtWhoseRePullsBackOffUntilARowsPage() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([try Self.board(seq: 1)], seq: 1)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    rig.random.queue(raw: .max, count: 7)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found"), Rig.rows(in: Self.overlay, seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([
      PageReport(scope: Self.tree, outcome: .ignored), PageReport(scope: Self.overlay, outcome: .applied),
    ]))
    var waits: [Int64] = []
    for _ in 0..<6 {
      guard case .repull(let ms) = await rig.engine.puller.step() else { throw RigError("no re-pull is ahead") }
      waits.append(ms)
      rig.clock.advance(ms: ms)
      rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found")]))
      #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Self.tree, outcome: .ignored)]))
    }
    #expect(waits == [1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
    #expect(await rig.engine.puller.step() == .repull(ms: 30_000))
    rig.clock.advance(ms: 30_000)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(in: Self.tree, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree))
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs - 91_000))
    #expect(rig.transport.pulls == [
      PullRequest(scopes: [Self.pulled(Rig.scope, nil)]), PullRequest(scopes: [Self.pulled(Self.tree, nil), Self.pulled(Self.overlay, nil)]),
    ] + Array(repeating: PullRequest(scopes: [Self.pulled(Self.tree, nil)]), count: 7))
  }

  // Every other trigger pulls a scope in doubt as it pulls any subscribed scope, and leaves its scheduled re-pull and its
  // k as they were: here the app returns to the foreground, and a frame's end is ignored once more.
  @Test func otherTriggersPullAScopeInDoubtAndLeaveItsRePullAndItsKAlone() async throws {
    let rig = try Rig(account: "A")
    rig.random.queue(raw: .max, count: 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([try Self.board(seq: 1)], seq: 1)]))
    _ = await rig.engine.puller.step()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found"), Rig.rows(in: Self.overlay, seq: 0)]))
    _ = await rig.engine.puller.step()
    #expect(await rig.engine.puller.step() == .repull(ms: 1_000))
    rig.clock.advance(ms: 400)
    rig.engine.foreground()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 1, cursor: Self.live(1), digestOf: [try Self.board(seq: 1)]),
                                                  Rig.page(Self.tree, "not-found"), Rig.rows(in: Self.overlay, seq: 0)]))
    #expect(await rig.engine.puller.step() == .pulled([
      PageReport(scope: Rig.scope, outcome: .applied), PageReport(scope: Self.tree, outcome: .ignored),
      PageReport(scope: Self.overlay, outcome: .applied),
    ]))
    await rig.engine.puller.enqueue(.notFound(Self.tree, servedAs: "A"), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Self.tree, .ignored))
    #expect(await rig.engine.puller.step() == .repull(ms: 600))
    #expect(rig.engine.doubts.k(Self.tree) == 1)
  }

  // A sign-in, a sign-out or a re-identify of the active replica ends every doubt and returns every k to 0: here an epoch
  // change's re-identify, after which the same answer's ignored end puts the tree in doubt afresh, and every scope is
  // wanted.
  @Test func aNewSeatEndsEveryDoubt() async throws {
    let rig = try await Self.governed(tree: Rig.page(Self.tree, "not-found"))
    rig.clock.advance(ms: try #require(rig.engine.doubts.nextDue))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found")]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Self.tree, outcome: .ignored)]))
    #expect(rig.engine.doubts.k(Self.tree) == 2)
    let replica = try rig.meta().replica
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found")], epoch: "ep-2"))
    rig.engine.puller.wants.add([Self.tree])
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Self.tree, outcome: .ignored)]))
    #expect(try rig.meta().replica != replica)
    #expect((rig.engine.doubts.inDoubt(Self.tree), rig.engine.doubts.k(Self.tree)) == (true, 1))
    rig.transport.willAnswerPull(200, Rig.pulled([
      Rig.rows([try Self.board(seq: 1)], seq: 1, epoch: "ep-2"), Rig.page(Self.tree, "not-found"),
      Rig.rows(in: Self.overlay, seq: 0, epoch: "ep-2"),
    ], epoch: "ep-2"))
    #expect(await rig.engine.puller.step() == .pulled([
      PageReport(scope: Rig.scope, outcome: .applied), PageReport(scope: Self.tree, outcome: .ignored),
      PageReport(scope: Self.overlay, outcome: .applied),
    ]))
    #expect(rig.transport.pulls.last?.scopes.map(\.scope) == [Rig.scope, Self.tree, Self.overlay])
  }

  // §7.12: a sign-out, then a sign-in that binds the same replica to the same account again, ends every doubt, though
  // the replica, its id and its account are as they were when the last round ran.
  @Test func aSignOutAndASignInBackToTheSameReplicaEndEveryDoubt() async throws {
    let rig = try Rig(account: "A")
    rig.random.queue(raw: .max, count: 4)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "not-found")]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .ignored)]))
    for ms in [1_000, 2_000] as [Int64] {
      #expect(await rig.engine.puller.step() == .repull(ms: ms))
      rig.clock.advance(ms: ms)
      rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "not-found")]))
      #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .ignored)]))
    }
    #expect(rig.engine.doubts.k(Rig.scope) == 3)
    let replica = try rig.meta().replica
    try await rig.engine.signOut().finish(.keep)
    #expect(try await rig.signIn("A", holds: ["probe": false]).isComplete)
    #expect(try rig.meta().replica == replica && rig.meta().account == "A")
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "not-found")]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .ignored)]))
    #expect((rig.engine.doubts.k(Rig.scope), rig.engine.doubts.nextDue) == (1, 4_000))
  }

  // A sign-out that discards the replica ends every doubt at once, before the puller's next round.
  @Test func aSignOutThatDiscardsTheReplicaEndsEveryDoubtAtOnce() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "not-found")]))
    #expect(await rig.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .ignored)]))
    #expect(rig.engine.doubts.inDoubt(Rig.scope))
    try await rig.engine.signOut().finish(.discard)
    #expect((rig.engine.doubts.inDoubt(Rig.scope), rig.engine.doubts.k(Rig.scope), rig.engine.doubts.nextDue) == (false, 0, nil))
  }

  // §7.9: the set holds a tree per board alive in drawn or in stored, so a board's held delete, alive in stored alone,
  // keeps its tree's rows and cursor through the undo window; once the delete is released the tree leaves the set, and
  // the next round forgets it.
  @Test func aBoardsHeldDeleteKeepsItsTreeInTheSetThroughTheUndoWindow() async throws {
    let meta = try Rig.metaRow(seq: 1)
    let rig = try await Self.governed(tree: Rig.rows([meta], in: Self.tree, seq: 1))
    try rig.commit(Gesture(changes: [.delete("board", "b_00000001")], hold: true))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 1, cursor: Self.live(1), digestOf: [try Self.board(seq: 1)])]))
    rig.engine.puller.wants.add([Rig.scope])
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(try Self.rows(rig, Self.tree) == [meta.json])
    #expect(try Self.cursor(rig, Self.tree)?.booted == true)
    rig.clock.advance(ms: Constants.holdMs)
    #expect(rig.engine.releaser.step() == .again)
    rig.engine.puller.wants.add([Rig.scope])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 1, cursor: Self.live(1), digestOf: [try Self.board(seq: 1)])]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(try Self.cursor(rig, Self.tree) == nil)
    #expect(try Self.rows(rig, Self.tree) == [])
  }

  // A scope that leaves the subscription set loses its doubt: here the board dies, so its tree is known gone.
  @Test func aScopeThatLeavesTheSetLosesItsDoubt() async throws {
    let rig = try await Self.governed(tree: Rig.page(Self.tree, "not-found"))
    let dead = try Self.board(seq: 2, life: "dead", ms: 2_000)
    await rig.engine.puller.enqueue(try Rig.change(rows: [dead], seq: 2, digestOf: []), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .applied))
    #expect(try rig.active().known == [Self.tree: .gone, Self.overlay: .gone])
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
    #expect(rig.engine.doubts.nextDue == nil)
    #expect(rig.transport.pulls.count == 2)
  }

  // The re-pull timer waits only in the foreground; in the background a round run for another trigger takes the re-pulls
  // already due, and k keeps its value.
  @Test func aRePullWaitsOnlyInTheForegroundAndABackgroundRoundTakesTheDueOnes() async throws {
    let rig = try Rig(account: "A")
    rig.random.queue(raw: .max, count: 2)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([try Self.board(seq: 1)], seq: 1)]))
    _ = await rig.engine.puller.step()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found"), Rig.rows(in: Self.overlay, seq: 0)]))
    _ = await rig.engine.puller.step()
    try rig.engine.leave()
    #expect(await rig.engine.puller.step() == .idle)
    rig.clock.advance(ms: 5_000)
    rig.engine.puller.wants.add([Rig.scope])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 1, cursor: Self.live(1), digestOf: [try Self.board(seq: 1)]),
                                                  Rig.page(Self.tree, "not-found")]))
    #expect(await rig.engine.puller.step() == .pulled([
      PageReport(scope: Rig.scope, outcome: .applied), PageReport(scope: Self.tree, outcome: .ignored),
    ]))
    #expect(rig.transport.pulls.last?.scopes.map(\.scope) == [Rig.scope, Self.tree])
    #expect(await rig.engine.puller.step() == .idle)
    #expect((rig.engine.doubts.k(Self.tree), rig.engine.doubts.nextDue) == (2, 7_000))
  }

  // One pull is in flight at a time: the frames that come while it is want their scope, marked once, so the answer is
  // followed by one pull of it, not one per frame (§7.5 N-2).
  @Test(.timeLimit(.minutes(1))) func framesThatComeWhileAPullIsInFlightMarkItsScopeForOneMorePull() async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    let gate = Gate()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 2, cursor: Self.live(1), more: true, digestOf: [card])]), after: gate)
    rig.engine.foreground()
    let puller = rig.engine.puller
    let stepping = Task { await puller.step() }
    await gate.arrival()
    for seq in 2...4 as ClosedRange<Int64> {
      await puller.enqueue(try Rig.change(rows: [try Rig.cardRow("card000\(seq)", "N", seq: seq)], seq: seq, digestOf: []), for: try rig.meta().replica)
    }
    gate.open()
    #expect(await stepping.value == Self.applied(Rig.scope))
    for _ in 2...4 { #expect(await puller.step() == .frame(Rig.scope, .pull)) }
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 2, cursor: Self.live(2), digestOf: [card])]))
    #expect(await puller.step() == Self.applied(Rig.scope))
    #expect(await puller.step() == .fallback(ms: Constants.pullFallbackMs))
    #expect(rig.transport.pulls.map(\.scopes) == [
      [Self.pulled(Rig.scope, nil)], [Self.pulled(Rig.scope, Self.live(1))], [Self.pulled(Rig.scope, Self.live(1))],
    ])
  }

  // REQUEST_TIMEOUT_MS bounds a pull: one the server never answers is a transport error once it passes, its scopes
  // wanted again, and a re-pull in flight ends, drawing the next.
  @Test(.timeLimit(.minutes(1))) func aPullUnansweredForTheRequestTimeoutIsATransportError() async throws {
    let rig = try Rig(account: "A")
    rig.random.queue(raw: .max, count: 3)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([try Self.board(seq: 1)], seq: 1)]))
    _ = await rig.engine.puller.step()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Self.tree, "not-found"), Rig.rows(in: Self.overlay, seq: 0)]))
    _ = await rig.engine.puller.step()
    rig.clock.advance(ms: 1_000)
    rig.transport.willNotAnswerPull()
    async let stepping = rig.engine.puller.step()
    await rig.clock.asleep(until: 1_000 + Constants.requestTimeoutMs)
    rig.clock.advance(ms: Constants.requestTimeoutMs)
    #expect(await stepping == .backoff(ms: 1_000))
    #expect((rig.engine.doubts.k(Self.tree), rig.engine.doubts.nextDue) == (2, 61_000 + 2_000))
    #expect(rig.transport.pulls.last?.scopes.map(\.scope) == [Self.tree])
  }

  // An unsubscribe removes only its own scopes: a subscribe landing while its transaction runs is kept, and pulled.
  @Test func aSubscribeDuringAnUnsubscribeIsKept() async throws {
    let kept = ScopeRef.tree("b_00000002")
    let engine = Mutex<SyncEngine?>(nil)
    let subscribing = Mutex<Task<Void, Never>?>(nil)
    let rig = try Rig(account: "A", crashPoints: CrashPoints { point in
      guard point == .beforeCommit(.subscriptions), let running = engine.withLock({ $0 }) else { return }
      subscribing.withLock { task in
        if task == nil { task = Task.detached { _ = try? running.subscribe(kept) } }
      }
    })
    engine.withLock { $0 = rig.engine }
    try rig.engine.subscribe(Self.tree)
    try rig.engine.unsubscribe(Self.tree)
    await subscribing.withLock { $0 }?.value
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.rows(in: kept, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope, kept))
    #expect(rig.transport.pulls.last?.scopes.map(\.scope) == [Rig.scope, kept])
  }

  // In the foreground, PULL_FALLBACK_MS after the last full pull every scope is pulled again, and a round with nothing to
  // pull waits for it; in the background, never.
  @Test func theFallbackPullsEveryScopeInTheForegroundOnly() async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    rig.clock.advance(ms: Constants.pullFallbackMs - 1)
    #expect(await rig.engine.puller.step() == .fallback(ms: 1))
    rig.clock.advance(ms: 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 1, digestOf: [card])]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    try rig.engine.leave()
    rig.clock.advance(ms: Constants.pullFallbackMs)
    #expect(await rig.engine.puller.step() == .idle)
    #expect(rig.transport.pulls.count == 2)
  }

  // Offline once the fallback is due, the round takes the fallback and asks for no timer, so the loop sleeps until the
  // network's kick; every scope is pulled when the device is back online.
  @Test func offlineARoundTakesTheDueFallbackAndWaitsForTheNetwork() async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    rig.connectivity.set(online: false)
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
    rig.clock.advance(ms: Constants.pullFallbackMs)
    #expect(await rig.engine.puller.step() == .idle)
    #expect(await rig.engine.puller.step() == .idle)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 1, digestOf: [card])]))
    rig.connectivity.set(online: true)
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.pulls.map(\.scopes) == [[Self.pulled(Rig.scope, nil)], [Self.pulled(Rig.scope, Self.live(1))]])
  }

  // MARK: Failures (design §6.3)

  @Test func aPullFindingNoNetworkBacksOffAndPullsItsScopesAgain() async throws {
    let rig = try Rig(account: "A")
    rig.random.queue(raw: .max, count: 2)
    rig.transport.willDropPull()
    #expect(await rig.engine.puller.step() == .backoff(ms: 1_000))
    rig.transport.willDropPull()
    #expect(await rig.engine.puller.step() == .backoff(ms: 2_000))
    #expect(rig.transport.pulls == Array(repeating: PullRequest(scopes: [Self.pulled(Rig.scope, nil)]), count: 2))
  }

  // A round marks its tree scopes before it reads whether they wait, so a create's result that lands while it reads, and
  // so after the read found the tree waiting, still wakes the puller, which then pulls the tree.
  @Test func aResultLandingWhileARoundReadsStillWakesThePuller() async throws {
    let (rig, _) = try Self.booted()
    _ = await rig.engine.puller.step()
    try rig.commit(Gesture(changes: [.create("board", id: .given("b_00000001"))], gestureId: "g1"))
    try rig.engine.subscribe(Self.tree)
    let wants = rig.engine.puller.wants
    let taken = wants.take()
    wants.reading(taken.scopes)
    let kicks = rig.engine.puller.wake.kicks
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 2)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(rig.engine.puller.wake.kicks > kicks)
    wants.read(taken.scopes, waiting: [Self.tree])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(in: Self.tree, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Self.tree))
  }

  // §7.5: a re-authentication that clears the pause is a trigger of its own, and pulls every subscribed scope, not only
  // those the paused request asked for.
  @Test func aReauthenticationThatClearsThePausePullsEverySubscribedScope() async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(401, Rig.failure("unauthenticated"))
    #expect(await rig.engine.puller.step() == .paused)
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Self.tree, nil)]))
    try rig.engine.reauthenticate(token: SessionToken("token-2"))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 1, digestOf: [card]), Rig.rows(in: Self.tree, seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope, Self.tree))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Rig.scope, Self.live(1)), Self.pulled(Self.tree, nil)]))
  }

  @Test func a401PausesTheReplicaUntilReauthentication() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(401, Rig.failure("unauthenticated", serverTime: Rig.startMs + 3_000))
    #expect(await rig.engine.puller.step() == .paused)
    #expect(try rig.meta().authPaused)
    #expect(try rig.meta().serverOffsetMs == 3_000)
    #expect(await rig.engine.puller.step() == .paused)
    try rig.engine.reauthenticate(token: SessionToken("token-2"))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.calls.last == .pull(PullRequest(scopes: [Self.pulled(Rig.scope, nil)]), token: SessionToken("token-2")))
  }

  // A 401 to a pull sent under a token the account replaced while it was in flight pauses nothing, and the pull goes
  // again under the new token (design §4.4 rule 2).
  @Test(.timeLimit(.minutes(1))) func a401ToATokenReplacedInFlightPausesNothing() async throws {
    let rig = try Rig(account: "A")
    let gate = Gate()
    rig.transport.willAnswerPull(401, Rig.failure("unauthenticated"), after: gate)
    let puller = rig.engine.puller
    let stepping = Task { await puller.step() }
    await gate.arrival()
    try rig.engine.reauthenticate(token: SessionToken("token-2"))
    gate.open()
    #expect(await stepping.value == .again)
    #expect(try rig.meta().authPaused == false)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.calls.last == .pull(PullRequest(scopes: [Self.pulled(Rig.scope, nil)]), token: SessionToken("token-2")))
  }

  // A 401 to a signed-out pull of a tree pauses nothing, and backs off.
  @Test func a401ToASignedOutPullBacksOff() async throws {
    let rig = try Rig()
    rig.random.queue(raw: .max, count: 1)
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(401, Rig.failure("unauthenticated"))
    #expect(await rig.engine.puller.step() == .backoff(ms: 1_000))
    #expect(try rig.meta().authPaused == false)
  }

  // A pause from the puller closes the live socket at once.
  @Test func a401WakesTheLiveChannel() async throws {
    let rig = try Rig(account: "A")
    let kicks = rig.engine.live.wake.kicks
    rig.transport.willAnswerPull(401, Rig.failure("unauthenticated"))
    #expect(await rig.engine.puller.step() == .paused)
    #expect(rig.engine.live.wake.kicks > kicks)
  }

  @MainActor @Test func a426StopsPullingForTheProcess() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(426, Rig.failure("upgrade-required"))
    #expect(await rig.engine.puller.step() == .stopped)
    #expect(await rig.engine.puller.step() == .stopped)
    #expect(rig.transport.pulls.count == 1)
    await rig.engine.settle()
    #expect(rig.engine.status.upgradeRequired)
  }

  // A 503 holds every pull for its `retryAfterMs`, through a kick.
  @Test func a503HoldsEveryPullForTheServersPause() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(503, ["error": "unavailable", "retryAfterMs": 5_000, "serverTime": JSON(Rig.startMs), "epoch": "ep-1"])
    #expect(await rig.engine.puller.step() == .backoff(ms: 5_000))
    rig.clock.advance(ms: 4_000)
    rig.engine.foreground()
    #expect(await rig.engine.puller.step() == .backoff(ms: 1_000))
    rig.clock.advance(ms: 1_000)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.pulls.count == 2)
  }

  // MARK: Live frames (§7.5 step 3)

  @Test func aChangeFrameAtTheNextSeqIsAppliedInline() async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    let next = try Rig.cardRow("card0002", "Two", seq: 2)
    let replica = try rig.meta().replica
    await rig.engine.puller.enqueue(try Rig.change(rows: [next], seq: 2, digestOf: [card, next]), for: replica)
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .applied))
    #expect(try Self.rows(rig) == [card.json, next.json])
    #expect(try Self.cursor(rig) == CursorRecord(cursor: Self.live(2), digest: ScopeDigest(rows: [card.json, next.json]), booted: true))
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
    #expect(rig.transport.pulls.count == 1)
  }

  // §7.5: an `ok` whose seq its scope's cursor already covers (its own frame came before its push's answer) resolves in
  // the result's own transaction, and nothing is pulled for it.
  @Test(.timeLimit(.minutes(1))) func anEntryAckedAfterItsOwnFrameResolvesAtOnce() async throws {
    let rig = try Rig(account: "A")
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    _ = await rig.engine.puller.step()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1"))
    let gate = Gate()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]), after: gate)
    let sender = rig.engine.sender
    let pushing = Task { await sender.step() }
    await gate.arrival()
    let row = try Rig.cardRow("card0001", "One", seq: 1)
    await rig.engine.puller.enqueue(try Rig.change(rows: [row], seq: 1, digestOf: [row]), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .applied))
    gate.open()
    #expect(await pushing.value == .again)
    #expect(try rig.outbox() == [])
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
    #expect(rig.transport.pulls.count == 1)
  }

  // A frame past a gap, without its rows, or of another epoch is not admitted: the scope is pulled from its cursor.
  @Test(arguments: ["gap", "no rows", "epoch"])
  func aFrameThatIsNotAdmittedWantsItsScopePulled(_ kind: String) async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    let next = try Rig.cardRow("card0002", "Two", seq: kind == "gap" ? 3 : 2)
    let frame = switch kind {
    case "gap": try Rig.change(rows: [next], seq: 3, digestOf: [card, next])
    case "no rows": try Rig.change(rows: nil, seq: 2, digestOf: [card, next])
    default: try Rig.change(rows: [next], seq: 2, digestOf: [card, next], epoch: "ep-2")
    }
    await rig.engine.puller.enqueue(frame, for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, .pull))
    #expect(try Self.rows(rig) == [card.json])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([next], seq: next.seq, digestOf: [card, next])]))
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Rig.scope, Self.live(1))]))
  }

  // A gone or not-found frame forgets its scope as that page would, and the scope is not pulled again.
  @Test(arguments: [KnownKind.gone, .notFound])
  func aGoneOrNotFoundFrameForgetsItsScope(_ kind: KnownKind) async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.rows([try Rig.metaRow(seq: 1)], in: Self.tree, seq: 1)]))
    _ = await rig.engine.puller.step()
    let frame: LiveFrame = kind == .gone ? .gone(Self.tree, servedAs: "A") : .notFound(Self.tree, servedAs: "A")
    await rig.engine.puller.enqueue(frame, for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Self.tree, kind == .gone ? .gone : .notFound))
    #expect(try rig.active().known == [Self.tree: kind])
    #expect(try Self.cursor(rig, Self.tree) == nil)
    #expect(try Self.rows(rig, Self.tree) == [])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    rig.engine.foreground()
    #expect(await rig.engine.puller.step() == Self.applied(Rig.scope))
    #expect(rig.transport.pulls.last == PullRequest(scopes: [Self.pulled(Rig.scope, Self.live(0))]))
  }

  // MARK: Revalidation (design §4.4 rule 2)

  // A frame received for a replica no longer active is dropped (§7.12); one for a scope outside the subscription set
  // applies nothing (§7.5 step 3).
  @Test func aFrameForAReplicaLeftSinceIsDroppedAndOneOutsideTheSetAppliesNothing() async throws {
    let (rig, card) = try Self.booted()
    _ = await rig.engine.puller.step()
    let next = try Rig.cardRow("card0002", "Two", seq: 2)
    await rig.engine.puller.enqueue(try Rig.change(rows: [next], seq: 2, digestOf: [card, next]), for: "rp_" + String(repeating: "f", count: 32))
    #expect(await rig.engine.puller.step() == .frame(Rig.scope, nil))
    await rig.engine.puller.enqueue(.gone(Self.tree, servedAs: "A"), for: try rig.meta().replica)
    #expect(await rig.engine.puller.step() == .frame(Self.tree, .outside))
    #expect(try rig.active().known == [:])
    #expect(try Self.rows(rig) == [card.json])
  }

  // A tree unsubscribed while its boot is in flight: its page is outside the set, applies nothing, and pulls nothing again.
  @Test(.timeLimit(.minutes(1))) func aPageOfAScopeUnsubscribedWhileInFlightIsOutside() async throws {
    let rig = try Rig(account: "A")
    try rig.engine.subscribe(Self.tree)
    let gate = Gate()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0), Rig.rows([try Rig.metaRow(seq: 1)], in: Self.tree, seq: 1)]), after: gate)
    let puller = rig.engine.puller
    let stepping = Task { await puller.step() }
    await gate.arrival()
    try rig.engine.unsubscribe(Self.tree)
    gate.open()
    #expect(await stepping.value == .pulled([PageReport(scope: Rig.scope, outcome: .applied), PageReport(scope: Self.tree, outcome: .outside)]))
    #expect(try Self.cursor(rig, Self.tree) == nil)
    #expect(try Self.rows(rig, Self.tree) == [])
    #expect(await rig.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))
  }

  // Steps are single-flight: a step taken while a pull is in flight waits for it, then finds nothing left to pull.
  @Test(.timeLimit(.minutes(1))) func aStepWaitsForThePullInFlight() async throws {
    let rig = try Rig(account: "A")
    let gate = Gate()
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]), after: gate)
    let puller = rig.engine.puller
    let first = Task { await puller.step() }
    await gate.arrival()
    let second = Task { await puller.step() }
    await puller.turns.queued(1)
    #expect(rig.transport.pulls.count == 1)
    gate.open()
    #expect(await first.value == Self.applied(Rig.scope))
    #expect(await second.value == .fallback(ms: Constants.pullFallbackMs))
    #expect(rig.transport.pulls.count == 1)
  }
}
