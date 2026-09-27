import Dispatch
import Foundation
import SyncAPI
import SyncCore
@testable import SyncEngine
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// The observation pipeline (design §4.5): views refreshed from the store in commit order, notices, Undo offers, the
// status, and the event stream. Each test lets the views settle the engine's start before it acts, so what it sees
// after acting comes from the change it made.

@MainActor
struct ObservationTests {
  static func titles(_ view: RecordsView) -> [String: String] {
    view.records.reduce(into: [:]) { titles, entry in titles[entry.key.description] = try? entry.value.values["title"]?.asString() }
  }

  @Test func aRecordsViewShowsEachCommitOnceTheViewsSettle() async throws {
    let rig = try Rig()
    let drawn = rig.engine.records(Rig.scope, "card")
    let stored = rig.engine.records(Rig.scope, "card", .stored)
    await rig.engine.settle()
    #expect(drawn.records.isEmpty)
    #expect(rig.engine.records(Rig.scope, "card") === drawn)
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One"), Rig.card("card0002", "Two")]))
    await rig.engine.settle()
    #expect(Self.titles(drawn) == ["card0001": "One", "card0002": "Two"])
    try rig.commit(Gesture(changes: [.update("card", "card0001", ["title": "Uno"])]))
    try rig.commit(Gesture(changes: [.delete("card", "card0002")], hold: true))
    await rig.engine.settle()
    #expect(Self.titles(drawn) == ["card0001": "Uno"])
    #expect(Self.titles(stored) == ["card0001": "Uno", "card0002": "Two"])
    #expect(stored.records["card0002"]?.isHeld == true)
    #expect(drawn.firstPullComplete)
  }

  // Commits land from another thread while the main actor looks between them: the view only ever moves forward.
  @Test func aViewNeverShowsAStateOlderThanOneItShowed() async throws {
    let rig = try Rig()
    let view = rig.engine.records(Rig.scope, "card")
    await rig.engine.settle()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "0")]))
    let engine = rig.engine
    let writer = Task.detached {
      for step in 1...40 { _ = try engine.commit(Rig.scope, Gesture(changes: [.update("card", "card0001", ["title": .string("\(step)")])])) }
    }
    var seen: [Int] = []
    let look = {
      guard let title = Self.titles(view)["card0001"], let step = Int(title), step != seen.last else { return }
      seen.append(step)
    }
    for _ in 0..<10_000 where seen.last != 40 {
      look()
      await Task.yield()
    }
    try await writer.value
    await rig.engine.settle()
    look()
    #expect(seen == seen.sorted())
    #expect(seen.last == 40)
  }

  @Test func aNoticeIsListedUntilItIsDismissed() async throws {
    let rig = try Rig(limits: Limits(pushMaxBytes: 100))
    let notices = rig.engine.notices("probe")
    await rig.engine.settle()
    _ = try rig.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1"))
    await rig.engine.settle()
    #expect(notices.notices.map { "\($0.id) \($0.product) \($0.scope) \($0.code)" } == ["notice:g1/0 probe self/probe too-large"])
    try rig.engine.dismissNotice("notice:g1/0")
    await rig.engine.settle()
    #expect(notices.notices.isEmpty)
  }

  @Test func undoIsOfferedForAHeldGestureUntilItIsUndoneOrReleased() async throws {
    let rig = try Rig()
    let offers = rig.engine.undoOffers
    await rig.engine.settle()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], hold: true, gestureId: "g2"))
    await rig.engine.settle()
    let deadline = Rig.startMs + Constants.holdMs
    #expect(offers.offers == [
      UndoOffer(id: "g1", scope: Rig.scope, releaseAt: deadline), UndoOffer(id: "g2", scope: Rig.scope, releaseAt: deadline),
    ])
    _ = try rig.engine.undo("g1")
    await rig.engine.settle()
    #expect(offers.offers == [UndoOffer(id: "g2", scope: Rig.scope, releaseAt: deadline)])
    rig.clock.advance(ms: Constants.holdMs)
    #expect(rig.engine.releaser.step() == .again)
    await rig.engine.settle()
    #expect(offers.offers == [])
  }

  @Test func theStatusFollowsTheAccountTheUnsentAndThePause() async throws {
    let rig = try Rig(account: "A")
    let status = rig.engine.status
    await rig.engine.settle()
    #expect((status.account, status.authPaused, status.ready, status.sent, status.online) == ("A", false, 0, 0, true))
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
    await rig.engine.settle()
    #expect((status.ready, status.sent) == (1, 0))
    rig.transport.willAnswerPush(401, Rig.failure("unauthenticated"))
    #expect(await rig.engine.sender.step() == .paused)
    await rig.engine.settle()
    #expect((status.authPaused, status.ready, status.sent) == (true, 0, 1))
    rig.connectivity.set(online: false)
    await rig.engine.settle()
    #expect(status.online == false)
  }

  // A view released and asked for again while the hub awaits a load for an earlier change stays registered, and keeps
  // refreshing. A commit on another thread holds the store, so once the hub has begun applying the status change its
  // first load waits, and the view is made again meanwhile.
  @Test(.timeLimit(.minutes(1))) func aViewMadeAgainWhileTheHubLoadsKeepsRefreshing() async throws {
    let rig = try Rig()
    let engine = rig.engine
    var views: [RecordsView] = []
    for type in ["board", "card", "run", "lap", "day"] {
      for mode in [ViewMode.drawn, .stored] { views.append(engine.records(Rig.scope, type, mode)) }
    }
    await engine.settle()
    let last = try #require(Array(engine.hub.liveRecords.keys).last)
    views.removeAll { RecordsView.Key(scope: $0.scope, type: $0.type, mode: $0.mode) == last }
    let release = DispatchSemaphore(value: 0)
    await withCheckedContinuation { (entered: CheckedContinuation<Void, Never>) in
      Thread {
        _ = try? engine.commit(Rig.scope) { _ -> (Gesture?, Void) in
          entered.resume()
          release.wait()
          return (Gesture(changes: [Rig.card("card0009", "Blocker")]), ())
        }
      }.start()
    }
    rig.connectivity.set(online: false)
    await engine.hub.begins(engine.core.publisher.published)
    release.signal()
    let again = engine.records(last.scope, last.type, last.mode)
    await engine.settle()
    let change: Change = last.type == "day"
      ? .put("day", "2026-09-27", present: true, ["score": 1])
      : .create(last.type, id: .minted, last.type == "card" ? ["title": "x"] : last.type == "run" ? ["startedAt": 1] : [:])
    try rig.commit(Gesture(changes: [change]))
    await engine.settle()
    #expect(engine.hub.liveRecords[last]?.view === again)
    #expect(again.records.count == (last.type == "card" ? 2 : 1))
    withExtendedLifetime(views) {}
  }

  // A boot page with no rows changes only the scope's cursor, and the views still learn the first pull is complete.
  @Test func anEmptyBootPageCompletesTheFirstPullInTheViews() async throws {
    let rig = try Rig(account: "A")
    let engine = rig.engine
    let view = engine.records(Rig.scope, "card")
    await engine.settle()
    #expect(view.firstPullComplete == false)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    await engine.settle()
    #expect(view.firstPullComplete)
  }

  @Test func everySubscriberGetsTheEventsInCommitOrder() async throws {
    let rig = try Rig()
    var first = rig.engine.events().makeAsyncIterator()
    var second = rig.engine.events().makeAsyncIterator()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], hold: true, gestureId: "g2"))
    _ = try rig.engine.undo("g2")
    _ = try rig.engine.undo("g1")
    let expected: [EngineEvent] = [
      .ended(localId: "g2/0", outcome: .undone, event: .undo, orphanOf: nil),
      .ended(localId: "g1/0", outcome: .undone, event: .undo, orphanOf: nil),
    ]
    #expect([await first.next(), await first.next()] == expected)
    #expect([await second.next(), await second.next()] == expected)
  }

  // §9.1: identifiers are the same only byte for byte, so look-alikes ("\u{E9}" and "e\u{301}") are never one view,
  // one offer or one account.
  @Test func lookAlikeProductsNeverShareANoticesView() throws {
    let rig = try Rig()
    let views = ["\u{E9}", "e\u{301}"].map { rig.engine.notices($0) }
    #expect(views.map { JSON.string($0.product) } == ["\u{E9}", "e\u{301}"])
  }

  @Test func lookAlikeHeldGesturesAreOfferedApart() throws {
    let rig = try Rig()
    let replica = try rig.meta().replica
    let stamp = try Stamp("1:0:r_aaaaaaaaaaaa")
    let held = ["g\u{E9}", "ge\u{301}"].enumerated().map { order, gesture in
      StoreWrite.replica(replica, .putEntry(OutboxEntry(
        localId: "\(gesture)/0", gestureId: gesture, lineage: "anon", scope: Rig.scope, state: .held, commitOrder: Int64(order + 1),
        releaseAt: Rig.startMs + Constants.holdMs, stamp: stamp, intent: Intent(scope: Rig.scope, gestureId: gesture))))
    }
    _ = try rig.store.write(.commit) { _ in Planned((), ReplicaBatch(writes: held)) }
    #expect(rig.engine.undoOffers.offers.map { JSON.string($0.id) } == ["g\u{E9}", "ge\u{301}"])
  }

  @Test func theStatusShowsALookAlikeAccountAsAnother() {
    let status = SyncStatus(SyncStatus.Snapshot(account: "\u{E9}"))
    status.apply(SyncStatus.Snapshot(account: "e\u{301}"))
    #expect(status.account.map(JSON.string) == "e\u{301}")
  }
}
