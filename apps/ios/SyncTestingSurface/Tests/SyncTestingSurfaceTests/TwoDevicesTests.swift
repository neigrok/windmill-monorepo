import SyncAPI
import SyncCore
import SyncEngine
import SyncTesting
import Testing

// Two devices of one account on one model server, driven from another package through `SyncTesting`'s public surface
// alone, as the domain kit's `Harness` drives them (kit §14.2, ER-9): commits and reads through each device's replica,
// `sync()`, holds on the harness clock, `leave()`, a failed commit, a refusal scripted on the server, and the views a UI
// module observes, narrowed reads and views included (ER-12).

// A product with no server rules of its own, as the kit declares one.
struct NoServerRules: ServerRules {}

struct TwoDevicesTests {
  static let probe = ScopeRef.product("probe")
  static let startMs: Int64 = 1_800_000_000_000

  static func phone() throws -> SteppedEngine {
    SteppedEngine(registry: try Corpus.probeRegistry(), startMs: startMs, seed: 42, account: "acct-1", rules: NoServerRules())
  }

  static func card(_ id: String, _ title: String) -> Change {
    .create("card", id: .given(RecordID(id)), ["title": .string(title), "tier": "draft"])
  }

  @discardableResult
  static func commit(_ gesture: Gesture, on device: SteppedEngine) throws -> CommitReceipt {
    guard case .committed(let receipt) = try device.replica.commit(probe, gesture) else { throw SurfaceError.refused }
    return receipt
  }

  static func titles(_ device: SteppedEngine) throws -> [JSON?] {
    try device.drawn(probe, "card").map { $0.values["title"] }
  }

  @Test func eachDeviceSeesTheOthersWorkAfterSync() throws {
    let phone = try Self.phone()
    let tablet = phone.device()
    try Self.commit(Gesture(changes: [Self.card("card0001", "Push")]), on: phone)
    phone.sync()
    #expect(try Self.titles(tablet) == ["Push"])
    try Self.commit(Gesture(changes: [.update("card", "card0001", ["title": "Pull"])]), on: tablet)
    tablet.sync()
    #expect(try Self.titles(phone) == ["Pull"])
    #expect(try phone.stored(Self.probe, "card").map { $0.values["title"] } == ["Pull"])
    #expect(phone.server.rows(Self.probe, of: "acct-1").map(\.key) == [RecordKey("card", "card0001")])
  }

  // ER-12: the laps of one run, narrowed by their `runId`, as a read and as a view, which is loading until its views
  // settle, and holds the tablet's laps of that run once the phone has pulled them; a field that is no ref, and a type
  // of another scope, are malformed.
  @MainActor @Test func aNarrowedViewListsTheOtherDevicesWorkOnceTheViewsSettle() async throws {
    let phone = try Self.phone()
    let tablet = phone.device()
    let laps = try phone.records(Self.probe, "lap", where: "runId", is: "run00000001")
    #expect(laps.state == .loading)
    await phone.settleViews()
    #expect(laps.state == .loaded(RecordsView.Snapshot(records: [], firstPullComplete: false)))
    try Self.commit(Gesture(changes: [
      .create("run", id: .given("run00000001"), ["startedAt": 1]), .create("run", id: .given("run00000002"), ["startedAt": 1]),
      .create("lap", id: .given("lap0000000b"), ["runId": "run00000001", "weight": 2]),
      .create("lap", id: .given("lap0000000a"), ["runId": "run00000001", "weight": 1]),
      .create("lap", id: .given("lap0000000c"), ["runId": "run00000002", "weight": 3]),
    ]), on: tablet)
    tablet.sync()
    await phone.settleViews()
    let listed = try phone.drawn(Self.probe, "lap", where: "runId", is: "run00000001")
    #expect(listed.map(\.id) == ["lap0000000a", "lap0000000b"])
    #expect(try phone.stored(Self.probe, "lap", where: "runId", is: "run00000001") == listed)
    #expect(laps.state == .loaded(RecordsView.Snapshot(records: listed, firstPullComplete: true)))
    #expect(throws: CommitFailure.malformed("lap.weight is not a top-level ref field")) {
      try phone.records(Self.probe, "lap", where: "weight", is: "run00000001")
    }
    #expect(throws: CommitFailure.malformed("tag is no type of self/probe")) { try phone.records(Self.probe, "tag") }
  }

  @Test func aHoldIsOfferedForUndoUntilTheClockPassesIt() throws {
    let phone = try Self.phone()
    let tablet = phone.device()
    let held = try Self.commit(Gesture(changes: [Self.card("card0001", "Held")], hold: true), on: phone)
    #expect(phone.undoOffers() == [UndoOffer(id: held.gestureId, scope: Self.probe, releaseAt: Self.startMs + Constants.holdMs)])
    phone.sync()
    #expect(try Self.titles(tablet) == [])
    phone.advance(ms: Constants.holdMs)
    #expect(phone.clock.nowMs() == Self.startMs + Constants.holdMs)
    #expect(phone.undoOffers() == [])
    phone.sync()
    #expect(try Self.titles(tablet) == ["Held"])
  }

  @Test func leavingTheAppSendsTheHolds() throws {
    let phone = try Self.phone()
    try Self.commit(Gesture(changes: [Self.card("card0001", "Left")], hold: true), on: phone)
    phone.leave()
    #expect(phone.server.rows(Self.probe, of: "acct-1").map(\.key) == [RecordKey("card", "card0001")])
  }

  @Test func aFailedCommitWritesNothingWhetherOrNotItDecides() throws {
    let phone = try Self.phone()
    phone.failNextCommit()
    #expect(throws: CommitFailure.self) { try phone.replica.commit(Self.probe) { _ in (nil as Gesture?, ()) } }
    phone.failNextCommit()
    #expect(throws: CommitFailure.self) { try Self.commit(Gesture(changes: [Self.card("card0001", "Lost")]), on: phone) }
    #expect(try Self.titles(phone) == [])
  }

  @Test func aRefusalScriptedOnTheServerReturnsAsANotice() throws {
    let phone = try Self.phone()
    let tablet = phone.device()
    phone.server.refuse(code: .stale)
    try Self.commit(Gesture(changes: [Self.card("card0001", "Refused")], gestureId: "g_refused"), on: phone)
    phone.sync()
    #expect(try phone.notices("probe").map(\.id) == ["notice:g_refused/0"])
    #expect(try phone.notices("probe").map(\.code) == [.stale])
    #expect(try Self.titles(phone) == [])
    #expect(try Self.titles(tablet) == [])
  }
}

enum SurfaceError: Error {
  case refused
}
