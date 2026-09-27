import SyncAPI
import SyncCore
import SyncModelServer
import SyncTesting
import Testing

// The step-mode harness the domain kit's `Harness` wraps (kit §14.2, ER-9): devices of one account on one model server,
// each call running the engine's steps on the calling thread to their end.

struct SteppedEngineTests {
  static let probe = ScopeRef.product("probe")
  static let startMs: Int64 = 1_800_000_000_000

  static func harness(seed: UInt64 = 1, account: String? = "A") throws -> SteppedEngine {
    SteppedEngine(registry: try Corpus.probeRegistry(), startMs: startMs, seed: seed, account: account, rules: ProbeServerRules())
  }

  static func card(_ id: String, _ title: String) -> Change {
    .create("card", id: .given(RecordID(id)), ["title": .string(title), "tier": "draft"])
  }

  static func titles(_ records: [Record]) -> [JSON?] { records.map { $0.values["title"] } }

  // The receipt of a gesture the device committed; a refusal fails the test.
  @discardableResult
  static func commit(_ gesture: Gesture, on device: SteppedEngine) throws -> CommitReceipt {
    guard case .committed(let receipt) = try device.replica.commit(probe, gesture) else { throw HarnessError("the gesture was refused") }
    return receipt
  }

  // A commit on one device reaches the other by `sync()`, which pushes and pulls on every device of the server.
  @Test func aCommitOnOneDeviceReachesTheOtherBySync() throws {
    let phone = try Self.harness()
    let tablet = phone.device()
    try Self.commit(Gesture(changes: [Self.card("card0001", "One")]), on: phone)
    #expect(try tablet.stored(Self.probe, "card") == [])
    phone.sync()
    #expect(Self.titles(try tablet.stored(Self.probe, "card")) == ["One"])
    #expect(Self.titles(try tablet.drawn(Self.probe, "card")) == ["One"])
    #expect(phone.server.rows(Self.probe, of: "A").map(\.key) == [RecordKey("card", "card0001")])
  }

  // A held gesture is offered for Undo until the clock passes HOLD_MS; `advance` releases it, and `sync` sends it.
  @Test func aHoldIsOfferedUntilTheClockReleasesIt() throws {
    let phone = try Self.harness()
    let tablet = phone.device()
    try Self.commit(Gesture(changes: [Self.card("card0001", "One")]), on: phone)
    phone.sync()
    let held = try Self.commit(Gesture(changes: [.delete("card", "card0001")], hold: true), on: phone)
    #expect(phone.undoOffers() == [UndoOffer(id: held.gestureId, scope: Self.probe, releaseAt: Self.startMs + Constants.holdMs)])
    phone.sync()
    #expect(Self.titles(try tablet.stored(Self.probe, "card")) == ["One"])
    phone.advance(ms: Constants.holdMs)
    #expect(phone.undoOffers() == [])
    #expect(try phone.replica.undo(held.gestureId) == false)
    phone.sync()
    #expect(try tablet.stored(Self.probe, "card") == [])
  }

  @Test func anUndoInsideTheWindowRemovesTheGesture() throws {
    let phone = try Self.harness()
    let held = try Self.commit(Gesture(changes: [Self.card("card0001", "One")], hold: true), on: phone)
    phone.advance(ms: Constants.holdMs - 1)
    #expect(try phone.replica.undo(held.gestureId))
    phone.sync()
    #expect(phone.server.rows(Self.probe, of: "A") == [])
  }

  // Leaving the app releases every hold and the leave flush sends it, with no sync.
  @Test func leavingReleasesAndFlushesTheHolds() throws {
    let phone = try Self.harness()
    try Self.commit(Gesture(changes: [Self.card("card0001", "One")], hold: true), on: phone)
    phone.leave()
    #expect(phone.undoOffers() == [])
    #expect(phone.server.rows(Self.probe, of: "A").map(\.key) == [RecordKey("card", "card0001")])
  }

  // The next commit throws before its transaction commits, whether or not its body decides a gesture, and writes nothing.
  @Test(arguments: [true, false])
  func failNextCommitFailsTheNextCommitWrittenOrNot(_ decides: Bool) throws {
    let phone = try Self.harness()
    phone.failNextCommit()
    #expect {
      _ = try phone.replica.commit(Self.probe) { _ in (decides ? Gesture(changes: [Self.card("card0001", "One")]) : nil, ()) }
    } throws: { ($0 as? CommitFailure)?.kind == .storeFailure }
    #expect(try phone.drawn(Self.probe, "card") == [])
    try Self.commit(Gesture(changes: [Self.card("card0002", "Two")]), on: phone)
    #expect(Self.titles(try phone.drawn(Self.probe, "card")) == ["Two"])
  }

  // A refusal the rules double does not model, scripted on the server, comes back as a notice holding the gesture, and
  // the record is on no device.
  @Test func aScriptedRefusalReturnsAsANotice() throws {
    let phone = try Self.harness()
    let tablet = phone.device()
    phone.server.refuse(code: .invalid, detail: ["field": "title"])
    try Self.commit(Gesture(changes: [Self.card("card0001", "One")], gestureId: "g_refused"), on: phone)
    phone.sync()
    let notices = try phone.notices("probe")
    #expect(notices.map(\.id) == ["notice:g_refused/0"])
    #expect(notices.map(\.code) == [.invalid])
    #expect(notices.map(\.detail) == [["field": "title"]])
    #expect(try phone.drawn(Self.probe, "card") == [])
    #expect(try tablet.drawn(Self.probe, "card") == [])
  }

  // A race: both devices edit the title under a guard; the one that syncs second finds the register moved on the server,
  // and its edit returns as a `stale` notice while the first one's stands everywhere.
  @Test func theSecondGuardedEditOfARaceReturnsStale() throws {
    let phone = try Self.harness()
    let tablet = phone.device()
    try Self.commit(Gesture(changes: [Self.card("card0001", "One")]), on: phone)
    phone.sync()
    let guarded = [RegisterRef(type: "card", id: "card0001", field: "title")]
    try Self.commit(Gesture(changes: [.update("card", "card0001", ["title": "Phone"])], guards: guarded), on: phone)
    try Self.commit(Gesture(changes: [.update("card", "card0001", ["title": "Tablet"])], guards: guarded, gestureId: "g_tablet"), on: tablet)
    phone.sync()
    #expect(try tablet.notices("probe").map(\.code) == [.stale])
    #expect(Self.titles(try tablet.drawn(Self.probe, "card")) == ["Phone"])
    #expect(Self.titles(try phone.drawn(Self.probe, "card")) == ["Phone"])
  }

  // Signed out, a device commits locally and sends nothing.
  @Test func aSignedOutDeviceSendsNothing() throws {
    let phone = try Self.harness(account: nil)
    try Self.commit(Gesture(changes: [Self.card("card0001", "One")]), on: phone)
    phone.sync()
    #expect(Self.titles(try phone.drawn(Self.probe, "card")) == ["One"])
    #expect(phone.server.state.scopes.isEmpty)
  }

  // Every id a device mints follows the harness's seed.
  @Test func mintedIdsFollowTheSeed() throws {
    let first = try Self.harness(seed: 5)
    let second = try Self.harness(seed: 5)
    let other = try Self.harness(seed: 6)
    #expect(try first.replica.mintID("card") == second.replica.mintID("card"))
    #expect(try first.device().replica.mintID("card") == second.device().replica.mintID("card"))
    #expect(try first.replica.mintID("card") != other.replica.mintID("card"))
  }

  // A UI module's test calls the harness on the main actor: the steps still run to their end on its thread.
  @MainActor @Test func theHarnessRunsFromTheMainActor() throws {
    let phone = try Self.harness()
    let tablet = phone.device()
    try Self.commit(Gesture(changes: [Self.card("card0001", "One")]), on: phone)
    phone.sync()
    #expect(Self.titles(try tablet.drawn(Self.probe, "card")) == ["One"])
  }
}

struct HarnessError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}
