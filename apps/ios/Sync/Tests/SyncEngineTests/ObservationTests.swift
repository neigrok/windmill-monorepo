import Dispatch
import Foundation
import Observation
import SyncAPI
import SyncCore
@testable import SyncEngine
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Synchronization
import Testing

// The observation pipeline (design §4.5): views refreshed from the store in commit order, whole or narrowed to a ref
// (ER-12), each loaded off the main actor; notices, Undo offers, the status, and the event stream. Each test lets the
// views settle the engine's start before it acts, so what it sees after acting comes from the change it made.

@MainActor
struct ObservationTests {
  static func loaded(_ view: RecordsView) -> RecordsView.Snapshot? {
    guard case .loaded(let snapshot) = view.state else { return nil }
    return snapshot
  }

  static func titles(_ view: RecordsView) -> [String: String] {
    (loaded(view)?.records ?? []).reduce(into: [:]) { titles, record in
      titles[record.id.description] = try? record.values["title"]?.asString()
    }
  }

  static func ids(_ view: RecordsView) -> [String]? {
    loaded(view)?.records.map(\.id.description)
  }

  // What the one-shot read of a view's list returns, beside the scope's first pull, as a loaded view shows them.
  static func read(_ view: RecordsView, on engine: SyncEngine) throws -> RecordsView.Snapshot {
    try engine.read(view.scope) { reader in
      let listing = view.key.listing
      let records = switch (listing.narrowing, listing.mode) {
      case (let narrowing?, .drawn): try reader.drawn(listing.type, where: narrowing.field, is: narrowing.id)
      case (let narrowing?, .stored): try reader.stored(listing.type, where: narrowing.field, is: narrowing.id)
      case (nil, .drawn): try reader.drawn(listing.type)
      case (nil, .stored): try reader.stored(listing.type)
      }
      return RecordsView.Snapshot(records: records, firstPullComplete: try reader.firstPullComplete())
    }
  }

  @Test func aRecordsViewShowsEachCommitOnceTheViewsSettle() async throws {
    let rig = try Rig()
    let drawn = try rig.engine.records(Rig.scope, "card")
    let stored = try rig.engine.records(Rig.scope, "card", .stored)
    await rig.engine.settle()
    #expect(drawn.state == .loaded(RecordsView.Snapshot(records: [], firstPullComplete: true)))
    #expect(try rig.engine.records(Rig.scope, "card") === drawn)
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One"), Rig.card("card0002", "Two")]))
    await rig.engine.settle()
    #expect(Self.titles(drawn) == ["card0001": "One", "card0002": "Two"])
    try rig.commit(Gesture(changes: [.update("card", "card0001", ["title": "Uno"])]))
    try rig.commit(Gesture(changes: [.delete("card", "card0002")], hold: true))
    await rig.engine.settle()
    #expect(Self.titles(drawn) == ["card0001": "Uno"])
    #expect(Self.titles(stored) == ["card0001": "Uno", "card0002": "Two"])
    #expect(Self.loaded(stored)?.record("card0002")?.isHeld == true)
    #expect(drawn.state == .loaded(try Self.read(drawn, on: rig.engine)))
    #expect(stored.state == .loaded(try Self.read(stored, on: rig.engine)))
  }

  // A view is made loading and returns at once: its first load reads the store off the main actor. A commit on another
  // thread holds the store while the view is made, so a read on the main actor would wait for it.
  @Test(.timeLimit(.minutes(3))) func aViewIsLoadingUntilItsFirstLoadLandsOffTheMainActor() async throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
    let engine = rig.engine
    let release = DispatchSemaphore(value: 0)
    await withCheckedContinuation { (entered: CheckedContinuation<Void, Never>) in
      Thread {
        _ = try? engine.commit(Rig.scope) { _ -> (Gesture?, Void) in
          entered.resume()
          release.wait()
          return (Gesture(changes: [Rig.card("card0002", "Two")]), ())
        }
      }.start()
    }
    let view = try engine.records(Rig.scope, "card")
    #expect(view.state == .loading)
    release.signal()
    await engine.settle()
    #expect(Self.titles(view) == ["card0001": "One", "card0002": "Two"])
    #expect(view.state == .loaded(try Self.read(view, on: engine)))
  }

  // ER-12: a view narrowed to one list lists its items, in id-byte order, as the narrowed read does. An item moved into
  // the list arrives and one moved out leaves; a held move shows in drawn, and in stored once it is released. A change to
  // an item of another list tells the view's observers nothing.
  @Test func aNarrowedViewFollowsTheReferenceOfEachRecord() async throws {
    let rig = try Rig(registry: Rig.shelf)
    let drawn = try rig.engine.records(Shelves.scope, "item", where: "listId", is: "l_one")
    let stored = try rig.engine.records(Shelves.scope, "item", where: "listId", is: "l_one", .stored)
    try rig.commit(Gesture(changes: [
      .create("item", id: .given("i_bbbb"), ["listId": "l_one", "name": "bread"]),
      .create("item", id: .given("i_aaaa"), ["listId": "l_one", "name": "apples"]),
      .create("item", id: .given("i_cccc"), ["listId": "l_two", "name": "cheese"]),
    ]), in: Shelves.scope)
    await rig.engine.settle()
    #expect(Self.ids(drawn) == ["i_aaaa", "i_bbbb"])
    let told = Atomic(false)
    withObservationTracking { _ = drawn.state } onChange: { told.store(true, ordering: .relaxed) }
    try rig.commit(Gesture(changes: [.update("item", "i_cccc", ["name": "brie"])]), in: Shelves.scope)
    await rig.engine.settle()
    let toldOfAnotherList = told.load(ordering: .relaxed)
    #expect(toldOfAnotherList == false)
    try rig.commit(Gesture(changes: [.update("item", "i_cccc", ["listId": "l_one"])], hold: true), in: Shelves.scope)
    try rig.commit(Gesture(changes: [.update("item", "i_aaaa", ["listId": "l_two"])]), in: Shelves.scope)
    await rig.engine.settle()
    let toldOfItsOwn = told.load(ordering: .relaxed)
    #expect(toldOfItsOwn)
    #expect(Self.ids(drawn) == ["i_bbbb", "i_cccc"])
    #expect(Self.ids(stored) == ["i_bbbb"])
    #expect(Self.loaded(drawn)?.record("i_cccc")?.isHeld == true)
    rig.clock.advance(ms: Constants.holdMs)
    #expect(rig.engine.releaser.step() == .again)
    await rig.engine.settle()
    #expect(Self.ids(stored) == ["i_bbbb", "i_cccc"])
    #expect(drawn.state == .loaded(try Self.read(drawn, on: rig.engine)))
    #expect(stored.state == .loaded(try Self.read(stored, on: rig.engine)))
  }

  // A view of a type of another scope, whole or narrowed, and one narrowed by a field that is no top-level ref, are
  // malformed, as the one-shot reads of the same lists are: the type is checked first.
  @Test func aViewOfAnotherScopesTypeOrByAFieldThatIsNoRefIsMalformed() throws {
    let rig = try Rig(registry: Rig.shelf)
    let card = CommitFailure(.malformed, "card is no type of self/shelf")
    #expect(throws: card) { try rig.engine.records(Shelves.scope, "card") }
    #expect(throws: card) { try rig.engine.records(Shelves.scope, "card", where: "listId", is: "l_one") }
    #expect(throws: CommitFailure(.malformed, "item.name is not a top-level ref field")) {
      try rig.engine.records(Shelves.scope, "item", where: "name", is: "l_one")
    }
    #expect(rig.engine.hub.liveRecords.isEmpty)
  }

  // A first load runs in a lane of its own: while one is held after its read, a view already loaded learns of a commit,
  // the same list asked for again answers the loading view, and another list waits in the lane. The held load lands
  // what it read, and the commit it missed is read in the turn after, so no first load ever shows less than a refresh
  // that came before it. The store is a file, whose writes run beside its reads.
  @Test(.timeLimit(.minutes(3))) func aFirstLoadHoldsNoRefreshAndMissesNoChange() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "views-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let reads = ReadPoint()
    let rig = try Rig(registry: Rig.shelf, crashPoints: reads.crashPoints, path: directory.appending(path: "store.sqlite").path)
    try rig.commit(Gesture(changes: [
      .create("item", id: .given("i_aaaa"), ["listId": "l_one", "name": "apples"]),
      .create("item", id: .given("i_zzzz"), ["listId": "l_two", "name": "zest"]),
    ]), in: Shelves.scope)
    let loaded = try rig.engine.records(Shelves.scope, "item", where: "listId", is: "l_two")
    await rig.engine.settle()
    reads.holdNext()
    let first = try rig.engine.records(Shelves.scope, "item", where: "listId", is: "l_one")
    await reads.held()
    try rig.commit(Gesture(changes: [
      .create("item", id: .given("i_bbbb"), ["listId": "l_one", "name": "bread"]),
      .create("item", id: .given("i_yyyy"), ["listId": "l_two", "name": "yam"]),
    ]), in: Shelves.scope)
    await rig.engine.hub.applied(through: rig.engine.core.publisher.published)
    #expect(Self.ids(loaded) == ["i_yyyy", "i_zzzz"])
    #expect(try rig.engine.records(Shelves.scope, "item", where: "listId", is: "l_one") === first)
    let waiting = try rig.engine.records(Shelves.scope, "item", .stored)
    #expect(first.state == .loading)
    #expect(waiting.state == .loading)
    reads.release()
    await rig.engine.settle()
    #expect(Self.ids(first) == ["i_aaaa", "i_bbbb"])
    for view in [first, waiting, loaded] { #expect(view.state == .loaded(try Self.read(view, on: rig.engine))) }
  }

  // Thirty views made at once on a file store, whose readers are five: the lane of first loads reads for one view at a
  // time, and each view lands what its read lists.
  @Test(.timeLimit(.minutes(3))) func manyFirstLoadsAtOnceTakeOneReaderAtATime() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "views-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let reads = ReadPoint(lingerMs: 2)
    let rig = try Rig(registry: Rig.shelf, crashPoints: reads.crashPoints, path: directory.appending(path: "store.sqlite").path)
    let letters = Array("abcdefghijklmnopqrstuvwxyz")
    let lists = (0..<30).map { RecordID("l_aa\(letters[$0 / 26])\(letters[$0 % 26])") }
    try rig.commit(Gesture(changes: lists.enumerated().map { index, list in
      .create("item", id: .minted, ["listId": list.json, "name": .string("item \(index)")])
    }), in: Shelves.scope)
    await rig.engine.settle()
    reads.restart()
    let views = try lists.map { try rig.engine.records(Shelves.scope, "item", where: "listId", is: $0) }
    await rig.engine.settle()
    #expect(reads.counted == ReadPoint.Counted(reads: 30, mostAtOnce: 1))
    for view in views { #expect(view.state == .loaded(try Self.read(view, on: rig.engine))) }
    #expect(views.map { Self.loaded($0)?.records.count } == Array(repeating: 1, count: 30))
  }

  // A change reads only for the views it reaches: none for a commit of a type no view lists, nor for a status the views
  // do not show; one, the membership check, for a record of a narrowed view's type it does not list; and one for the
  // first pull of a scope, however many views of the scope show it.
  @Test func aChangeReadsOnlyForTheViewsItReaches() async throws {
    let reads = ReadPoint()
    let rig = try Rig(crashPoints: reads.crashPoints)
    try rig.commit(Gesture(changes: [.create("run", id: .given("run00000001"), ["startedAt": 1])]))
    var views: [RecordsView] = []
    for type in ["card", "board", "day"] {
      for mode in [ViewMode.drawn, .stored] { views.append(try rig.engine.records(Rig.scope, type, mode)) }
    }
    await rig.engine.settle()
    var before = reads.counted.reads
    try rig.commit(Gesture(changes: [.create("lap", id: .minted, ["runId": "run00000001", "weight": 1])]))
    rig.connectivity.set(online: false)
    await rig.engine.settle()
    #expect(reads.counted.reads - before == 0)
    views.append(try rig.engine.records(Rig.scope, "lap", where: "runId", is: "run00000002"))
    await rig.engine.settle()
    before = reads.counted.reads
    try rig.commit(Gesture(changes: [.create("lap", id: .minted, ["runId": "run00000001", "weight": 2])]))
    await rig.engine.settle()
    #expect(reads.counted.reads - before == 1)
    before = reads.counted.reads
    try rig.engine.subscribe(.tree("b_00000001"))
    await rig.engine.settle()
    #expect(reads.counted.reads - before == 1)
    for view in views { #expect(view.state == .loaded(try Self.read(view, on: rig.engine))) }
  }

  // A view the UI does not keep, as a SwiftUI body that only reads its state: the hub holds it, so it loads and tells
  // its observers, and asking again finds it loaded. The hub holds only the views asked for last.
  @Test func aViewTheUIDoesNotKeepLoadsAndIsFoundAgain() async throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
    let told = Atomic(false)
    let seen = withObservationTracking { try? rig.engine.records(Rig.scope, "card").state } onChange: { told.store(true, ordering: .relaxed) }
    await rig.engine.settle()
    let wasTold = told.load(ordering: .relaxed)
    #expect(seen == .loading)
    #expect(wasTold)
    weak let asked = try rig.engine.records(Rig.scope, "card")
    #expect(asked?.state == .loaded(try Self.read(try #require(asked), on: rig.engine)))
    for type in ["board", "run", "lap", "day"] {
      for mode in [ViewMode.drawn, .stored] { _ = try rig.engine.records(Rig.scope, type, mode) }
    }
    await rig.engine.settle()
    #expect(asked == nil)
  }

  // A first load whose read fails leaves the view loading, and so does the views' settling; the retry, due after the
  // first backoff, loads it with no change to prompt it.
  @Test(.timeLimit(.minutes(3))) func aFailedFirstLoadIsRetriedAfterTheBackoff() async throws {
    let reads = ReadPoint()
    let rig = try Rig(crashPoints: reads.crashPoints)
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
    reads.failNext()
    let view = try rig.engine.records(Rig.scope, "card")
    await rig.engine.settle()
    #expect(view.state == .loading)
    let retry = try #require(rig.engine.hub.retry)
    await rig.clock.asleep(until: ViewHub.retryMs[0])
    rig.clock.advance(ms: ViewHub.retryMs[0])
    await retry.value
    await rig.engine.settle()
    #expect(view.state == .loaded(try Self.read(view, on: rig.engine)))
  }

  // A refresh whose read fails leaves the view behind its read, and so does the views' settling; the retry reads what
  // the view missed, with no change to prompt it.
  @Test(.timeLimit(.minutes(3))) func aFailedRefreshIsRetriedAfterTheBackoff() async throws {
    let reads = ReadPoint()
    let rig = try Rig(crashPoints: reads.crashPoints)
    let view = try rig.engine.records(Rig.scope, "card")
    await rig.engine.settle()
    reads.failNext()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
    await rig.engine.settle()
    #expect(view.state == .loaded(RecordsView.Snapshot(records: [], firstPullComplete: true)))
    #expect(view.state != .loaded(try Self.read(view, on: rig.engine)))
    let retry = try #require(rig.engine.hub.retry)
    await rig.clock.asleep(until: ViewHub.retryMs[0])
    rig.clock.advance(ms: ViewHub.retryMs[0])
    await retry.value
    await rig.engine.settle()
    #expect(Self.titles(view) == ["card0001": "One"])
    #expect(view.state == .loaded(try Self.read(view, on: rig.engine)))
  }

  // A refresh reads only the records a change touched: one arrives between two, one leaves, one changes, and the rest
  // stay as they were, in id-byte order; when nothing shown changes, there is nothing to show.
  @Test func aSnapshotTakesTheTouchedRecordsInIdOrder() {
    let record = { (id: String, name: String) in
      Record(type: "item", id: RecordID(id), life: nil, born: nil, values: ["name": .string(name)], texts: [:], serials: [:], rc: nil,
             ru: nil, isVisible: true, isPending: false, isHeld: false)
    }
    let shown = RecordsView.Snapshot(records: [record("i_a", "a"), record("i_c", "c"), record("i_e", "e"), record("i_g", "g")],
                                     firstPullComplete: true)
    let touched: Set<RecordKey> = [RecordKey("item", "i_b"), RecordKey("item", "i_c"), RecordKey("item", "i_e"), RecordKey("item", "i_h")]
    let next = shown.updating(touched, to: [RecordKey("item", "i_b"): record("i_b", "b"), RecordKey("item", "i_e"): record("i_e", "E")],
                              firstPullComplete: true)
    #expect(next == RecordsView.Snapshot(records: [record("i_a", "a"), record("i_b", "b"), record("i_e", "E"), record("i_g", "g")],
                                         firstPullComplete: true))
    #expect(shown.updating(touched, to: [RecordKey("item", "i_c"): record("i_c", "c"), RecordKey("item", "i_e"): record("i_e", "e")],
                           firstPullComplete: true) == nil)
    #expect(shown.updating([], to: [:], firstPullComplete: false) == RecordsView.Snapshot(records: shown.records, firstPullComplete: false))
  }

  // ER-12 and design §4.5: after every step of a random history, each view lists what the one-shot read of its list
  // returns, whole or narrowed, drawn or stored, made at the start or midway, and each narrowed read lists what the
  // whole read lists of the narrowing. The phone creates, moves, renames and deletes items, some held, undoes and
  // releases holds, pushes, pulls, applies live frames, sweeps, goes offline, and signs out and in again; another device
  // of the account writes too; the server changes its epoch or is restored from a backup; and every 25th step the
  // server is restored to its state after setup, so the phone's boot swaps every item out. The phone's store applies a
  // pull page two rows a chunk, settles one entry a slice and applies a push answer one result a batch. Its hundred steps
  // take seconds alone; it runs at high priority, so the CPU-bound suites beside it in a whole run do not starve its
  // many awaits past its limit.
  @Test(.timeLimit(.minutes(5))) func everyViewListsWhatItsReadListsAfterEveryStep() async throws {
    try await Task(priority: .high) {
      var random = SeededRandom.fromEnvironment()
      let shelves = try await Shelves()
      var steps: [String] = []
      for index in 1...100 {
        steps.append(index % 25 == 0 ? try await shelves.bootAgain(&random) : try await shelves.step(&random))
        await shelves.phone.settle()
        for view in shelves.views {
          let read = try Self.read(view, on: shelves.phone)
          guard view.state == .loaded(read) else {
            Issue.record("seed \(random.seed): \(view.key) shows \(view.state), its read \(read), after \(steps.suffix(8))")
            return
          }
        }
        if let differing = try shelves.narrowedReadDiffering() {
          Issue.record("seed \(random.seed): \(differing), after \(steps.suffix(8))")
          return
        }
      }
    }.value
  }

  // Commits land from another thread while the main actor looks between them: the view only ever moves forward.
  @Test func aViewNeverShowsAStateOlderThanOneItShowed() async throws {
    let rig = try Rig()
    let view = try rig.engine.records(Rig.scope, "card")
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
  // refreshing. The released view is the first of ten asked for, so the hub no longer holds it either. A commit on
  // another thread holds the store, so once the hub has begun applying a change that may move the first pulls its read
  // waits, and the view is made again meanwhile.
  @Test(.timeLimit(.minutes(1))) func aViewMadeAgainWhileTheHubLoadsKeepsRefreshing() async throws {
    let rig = try Rig()
    let engine = rig.engine
    var views: [RecordsView] = []
    for type in ["board", "card", "run", "lap", "day"] {
      for mode in [ViewMode.drawn, .stored] { views.append(try engine.records(Rig.scope, type, mode)) }
    }
    await engine.settle()
    let last = views.removeFirst().key
    #expect(engine.hub.liveRecords[last]?.view == nil)
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
    engine.core.publish(\.firstPulls)
    await engine.hub.begins(engine.core.publisher.published)
    release.signal()
    let again = try engine.records(last.scope, last.listing.type, last.listing.mode)
    await engine.settle()
    let type = last.listing.type
    let change: Change = type == "day"
      ? .put("day", "2026-09-27", present: true, ["score": 1])
      : .create(type, id: .minted, type == "card" ? ["title": "x"] : type == "run" ? ["startedAt": 1] : [:])
    try rig.commit(Gesture(changes: [change]))
    await engine.settle()
    #expect(engine.hub.liveRecords[last]?.view === again)
    #expect(Self.loaded(again)?.records.count == (type == "card" ? 2 : 1))
    withExtendedLifetime(views) {}
  }

  // A boot page with no rows changes only the scope's cursor, and the views still learn the first pull is complete.
  @Test func anEmptyBootPageCompletesTheFirstPullInTheViews() async throws {
    let rig = try Rig(account: "A")
    let engine = rig.engine
    let view = try engine.records(Rig.scope, "card")
    await engine.settle()
    #expect(view.state == .loaded(RecordsView.Snapshot(records: [], firstPullComplete: false)))
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows(seq: 0)]))
    #expect(await engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    await engine.settle()
    #expect(view.state == .loaded(RecordsView.Snapshot(records: [], firstPullComplete: true)))
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

// The phone and another device of account A on one model server of the shelf product, whose items name their list by an
// lww ref; the lists exist on both before the phone's views are made. The phone's views list items whole and by each
// list, drawn and stored.
@MainActor
final class Shelves {
  struct NoShelfRules: ServerRules {}

  static let scope = ScopeRef.product("shelf")
  static let lists: [RecordID] = ["l_aaaa", "l_bbbb", "l_cccc"]
  static let names = ["milk", "eggs", "rice", "tea"]

  let clock = SimClock(wallMs: Rig.startMs)
  let network: SimNetwork
  let connectivity = SwitchedConnectivity()
  let phone: SyncEngine
  let other: SyncEngine
  var views: [RecordsView] = []
  var signedIn = true
  var epochs = 1
  var backup: ServerState?
  var afterSetup: ServerState

  init() async throws {
    network = SimNetwork(
      server: ModelServer(registry: Rig.shelf, rules: NoShelfRules(), state: ServerState(epoch: "ep-1", accounts: ["A": "Ann"])),
      clock: clock)
    phone = try Self.device(on: network, clock: clock, connectivity: connectivity, seed: 1)
    other = try Self.device(on: network, clock: clock, connectivity: SwitchedConnectivity(), seed: 2)
    _ = try other.commit(Self.scope, Gesture(changes: Self.lists.map { .create("list", id: .given($0)) }))
    for device in [other, phone] {
      while await device.sender.step() == .again {}
      device.puller.wants.all()
      while case .pulled = await device.puller.step() {}
    }
    afterSetup = network.server.state
    for listing in Self.listings { views.append(try view(listing)) }
  }

  static func device(on network: SimNetwork, clock: SimClock, connectivity: SwitchedConnectivity, seed: UInt64) throws -> SyncEngine {
    let store = try Store.inMemory(registry: Rig.shelf, limits: Limits(chunkRows: 2, settleEntries: 1, resultsPerBatch: 1))
    let identities = Identities(random: SeededRandomSource(seed: seed))
    _ = try store.firstLaunch(identities: identities)
    _ = try store.signIn(account: "A", holdsRecords: [:], decisions: [:], counted: [:], identities: identities)
    return try SyncEngine(
      config: EngineConfig(appVersion: "1.0", surface: .ios, drivesLoops: false), store: store, transport: network,
      tokens: InMemoryTokenStore(["A": network.server.token(for: "A")]), forkGuard: InMemoryForkGuardStore(),
      clock: clock.engineClock, random: SeededRandomSource(seed: seed + 100), connectivity: connectivity)
  }

  static var listings: [(list: RecordID?, mode: ViewMode)] {
    ([nil] + lists).flatMap { list in [ViewMode.drawn, .stored].map { (list, $0) } }
  }

  func view(_ listing: (list: RecordID?, mode: ViewMode)) throws -> RecordsView {
    guard let list = listing.list else { return try phone.records(Self.scope, "item", listing.mode) }
    return try phone.records(Self.scope, "item", where: "listId", is: list, listing.mode)
  }

  // One step, named for the log. A phone signed out signs in again within a few steps.
  func step(_ random: inout SeededRandom) async throws -> String {
    if !signedIn && random.chance(0.3) { return try await signIn(&random) }
    switch random.below(20) {
    case 0, 1, 2, 3, 4:
      return try write(on: phone, &random)
    case 5:
      guard let offer = try phone.currentUndoOffers().randomElement(using: &random) else { return "undo: nothing held" }
      return "undo \(offer.id): \(try phone.undo(offer.id))"
    case 6:
      clock.advance(ms: Constants.holdMs)
      var released = 0
      while phone.releaser.step() == .again { released += 1 }
      return "release \(released)"
    case 7, 8:
      return "push \(await phone.sender.step())"
    case 9, 10:
      phone.puller.wants.all()
      return "pull \(await phone.puller.step())"
    case 11, 12:
      let written = try write(on: other, &random)
      while await other.sender.step() == .again {}
      return "\(written), pushed; \(await frames())"
    case 13, 14:
      return "live \(await phone.live.step()); \(await frames())"
    case 15:
      while phone.sweeper.step() == .again {}
      return "sweep"
    case 16:
      return try toggleView(&random)
    case 17:
      connectivity.set(online: !connectivity.isOnline)
      return connectivity.isOnline ? "online" : "offline"
    case 18 where signedIn:
      return try await signOut(&random)
    case 19:
      return newEpoch(&random)
    default:
      phone.puller.wants.all()
      return "pull \(await phone.puller.step())"
    }
  }

  // An item created in a list, moved to one, renamed or deleted, as the device draws them; the phone holds some.
  func write(on device: SyncEngine, _ random: inout SeededRandom) throws -> String {
    let who = device === phone ? "phone" : "other"
    let items = try device.read(Self.scope) { try $0.drawn("item") }.map(\.id)
    let list = random.pick(Self.lists)
    let hold = device === phone && random.chance(0.3)
    let (change, label): (Change, String) = if items.isEmpty || random.chance(0.3) {
      (.create("item", id: .minted, ["listId": list.json, "name": .string(random.pick(Self.names))]), "create in \(list)")
    } else {
      switch (random.pick(items), random.below(3)) {
      case (let item, 0): (.update("item", item, ["listId": list.json]), "move \(item) to \(list)")
      case (let item, 1): (.update("item", item, ["name": .string(random.pick(Self.names))]), "rename \(item)")
      case (let item, _): (.delete("item", item), "delete \(item)")
      }
    }
    let outcome = try device.commit(Self.scope, Gesture(changes: [change], hold: hold))
    return "\(who) \(label)\(hold ? " held" : ""): \(outcome)"
  }

  // Each frame the phone's socket holds, handed to the puller and applied, or found a gap the puller pulls.
  func frames() async -> String {
    var outcomes: [String] = []
    while let connection = await phone.live.connection as? FakeLiveConnection, connection.canReceive, await phone.live.receiveNext() {
      outcomes.append("\(await phone.puller.step())")
    }
    return outcomes.isEmpty ? "no frame" : "frames \(outcomes)"
  }

  // The other device creates an item and the phone, signed in and online, pulls it; then the server is restored to its
  // state after setup, its lists and no item, under a new epoch, and the phone pulls until its boot swaps the scope, so
  // every item it confirmed, that one at least, leaves every view.
  func bootAgain(_ random: inout SeededRandom) async throws -> String {
    let signingIn = signedIn ? "" : "\(try await signIn(&random)); "
    connectivity.set(online: true)
    let list = random.pick(Self.lists)
    _ = try other.commit(Self.scope, Gesture(changes: [.create("item", id: .minted, ["listId": list.json, "name": "boot"])]))
    while await other.sender.step() == .again {}
    let pulled = await pullAll()
    epochs += 1
    network.server.restore(afterSetup, epoch: "ep-\(epochs)")
    return "\(signingIn)other created in \(list), pulls \(pulled); server restored to its state after setup, epoch ep-\(epochs), "
      + "pulls \(await pullAll())"
  }

  // The phone's pulls until one does not pull.
  func pullAll() async -> [PullerStep] {
    var pulls: [PullerStep] = []
    for _ in 0..<50 {
      phone.puller.wants.all()
      let pulled = await phone.puller.step()
      pulls.append(pulled)
      guard case .pulled = pulled else { break }
    }
    return pulls
  }

  // The first list and mode whose narrowed read is not the whole read of the items naming that list, as one read holds
  // them; nil when every one is.
  func narrowedReadDiffering() throws -> String? {
    try phone.read(Self.scope) { reader in
      for list in Self.lists {
        for mode in [ViewMode.drawn, .stored] {
          let narrowed = mode == .drawn ? try reader.drawn("item", where: "listId", is: list) : try reader.stored("item", where: "listId", is: list)
          let whole = (mode == .drawn ? try reader.drawn("item") : try reader.stored("item")).filter { $0.values["listId"] == list.json }
          if narrowed != whole { return "the \(mode) read of \(list) lists \(narrowed.map(\.id)), the whole read \(whole.map(\.id))" }
        }
      }
      return nil
    }
  }

  // The server changes its epoch, as it is restored from its backup or from its state now; the backup is taken first when
  // there is none.
  func newEpoch(_ random: inout SeededRandom) -> String {
    epochs += 1
    guard let backup, random.chance(0.5) else {
      backup = backup ?? network.server.state
      network.server.restore(network.server.state, epoch: "ep-\(epochs)")
      return "epoch ep-\(epochs)"
    }
    network.server.restore(backup, epoch: "ep-\(epochs)")
    self.backup = nil
    return "server restored, epoch ep-\(epochs)"
  }

  // A view of a list the phone holds is released, or one it does not hold is made, loading midway through the history.
  // The views of every item stay held throughout.
  func toggleView(_ random: inout SeededRandom) throws -> String {
    let listing = random.pick(Self.listings.filter { $0.list != nil })
    let made = try view(listing)
    let held = views.firstIndex { $0 === made }
    guard let held, random.chance(0.5) else {
      if held == nil { views.append(made) }
      return "view of \(listing.list?.description ?? "every item") \(listing.mode) made"
    }
    views.remove(at: held)
    return "view of \(listing.list?.description ?? "every item") \(listing.mode) released"
  }

  // §7.10: what is unsent is kept or discarded.
  func signOut(_ random: inout SeededRandom) async throws -> String {
    let session = try await phone.signOut()
    let choice: SignOutChoice = session.unsent == 0 || random.chance(0.5) ? .keep : .discard
    _ = try await session.finish(choice)
    signedIn = false
    return "sign-out, \(choice), \(session.unsent) unsent"
  }

  // §7.10: what the phone wrote signed out is added to the account or discarded.
  func signIn(_ random: inout SeededRandom) async throws -> String {
    connectivity.set(online: true)
    let session = try await phone.signIn(account: "A", token: network.server.token(for: "A"))
    let answer: LineageAnswer = random.chance(0.5) ? .add : .discard
    if !session.isComplete { try await session.complete(["shelf": answer]) }
    signedIn = true
    return session.decisions.isEmpty ? "sign-in" : "sign-in, \(answer)"
  }
}

// The store's read point, as a test watches and faults it: every read counted with the most held there at once, each
// lingering `lingerMs`; the next read failed, or held until released.
final class ReadPoint: Sendable {
  struct Injected: Error {}

  struct Counted: Equatable {
    let reads: Int
    let mostAtOnce: Int
  }

  struct State {
    var reads = 0
    var inside = 0
    var mostAtOnce = 0
    var failing = false
    var holding = false
    var isHeld = false
    var awaitingHold: CheckedContinuation<Void, Never>?
  }

  let state = Mutex(State())
  let released = DispatchSemaphore(value: 0)
  let lingerMs: UInt32

  init(lingerMs: UInt32 = 0) {
    self.lingerMs = lingerMs
  }

  var crashPoints: CrashPoints {
    CrashPoints { [self] point in
      guard point == .read else { return }
      try read()
    }
  }

  var counted: Counted { state.withLock { Counted(reads: $0.reads, mostAtOnce: $0.mostAtOnce) } }

  // Counts from now on.
  func restart() {
    state.withLock { ($0.reads, $0.mostAtOnce) = (0, 0) }
  }

  func failNext() {
    state.withLock { $0.failing = true }
  }

  func holdNext() {
    state.withLock { $0.holding = true }
  }

  // Returns once the read `holdNext()` armed is held.
  func held() async {
    await withCheckedContinuation { continuation in
      let now = state.withLock { state -> Bool in
        if state.isHeld { return true }
        state.awaitingHold = continuation
        return false
      }
      if now { continuation.resume() }
    }
  }

  func release() {
    released.signal()
  }

  func read() throws {
    let (fail, hold, awaiting) = state.withLock { state -> (Bool, Bool, CheckedContinuation<Void, Never>?) in
      state.reads += 1
      state.inside += 1
      state.mostAtOnce = max(state.mostAtOnce, state.inside)
      let (fail, hold) = (state.failing, state.holding)
      (state.failing, state.holding) = (false, false)
      guard hold else { return (fail, false, nil) }
      state.isHeld = true
      defer { state.awaitingHold = nil }
      return (fail, true, state.awaitingHold)
    }
    defer { state.withLock { $0.inside -= 1 } }
    if lingerMs > 0 { usleep(lingerMs * 1_000) }
    if hold {
      awaiting?.resume()
      released.wait()
    }
    if fail { throw Injected() }
  }
}
