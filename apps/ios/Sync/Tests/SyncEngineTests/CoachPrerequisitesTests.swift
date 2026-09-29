import SyncAPI
import SyncCore
import SyncEngine
import SyncSchema
import SyncStore
import SyncTesting
import Synchronization
import Testing

// Coach §11 and design §11 M11: what a phone Coach needs of the engine, each as the Coach uses it, over the gym registry
// where the Coach runs. The fifth prerequisite, an event telling a turn that its writer replica re-identified (Coach
// §4.5), has no engine surface yet.

struct CoachPrerequisitesTests {
  static let startMs: Int64 = 1_700_000_000_000

  // Gym's server rules are not what these prove: plain creates only.
  struct NoGymRules: ServerRules {}

  // Coach §4.1 step 1: the Coach refuses `coach-replica-syncing` until the phone's first pull of gym is complete.
  @Test func aNewPhoneReadsGymAsSyncingUntilItsFirstPullBringsTheHistory() throws {
    let first = SteppedEngine(registry: SyncSchema.registry, startMs: Self.startMs, rules: NoGymRules())
    _ = try first.replica.commit(Gym.scope, Gesture(changes: [.create(Gym.Types.session, id: .given("session0001"))]))
    first.sync()
    let phone = first.device()
    #expect(try phone.replica.read(Gym.scope) { try $0.firstPullComplete() } == false)
    #expect(try phone.drawn(Gym.scope, Gym.Types.session).isEmpty)
    phone.sync()
    #expect(try phone.replica.read(Gym.scope) { try $0.firstPullComplete() })
    #expect(try phone.drawn(Gym.scope, Gym.Types.session).map(\.id) == ["session0001"])
  }

  // Coach §4.3 step 2: one ability call is one transaction that reads the views, mints its ids, writes, and answers the
  // call's result beside the receipt.
  @Test func oneCommitReadsMintsWritesAndAnswersTheCallsResult() throws {
    let phone = SteppedEngine(registry: SyncSchema.registry, startMs: Self.startMs, rules: NoGymRules())
    let (outcome, minted) = try phone.replica.commit(Gym.scope) { context -> (Gesture?, [RecordID]) in
      guard try context.drawn(Gym.Types.thread).isEmpty else { return (nil, []) }
      let thread = try context.mintID(Gym.Types.thread), message = try context.mintID(Gym.Types.message)
      return (Gesture(changes: [
        .create(Gym.Types.thread, id: .given(thread), ["title": "Deload week?"]),
        .create(Gym.Types.message, id: .given(message), ["threadId": thread.json, "role": "lifter", "text": "Should I deload?"]),
      ]), [thread, message])
    }
    guard case .committed(let receipt)? = outcome else { throw RigError("the call's writes were refused") }
    #expect(receipt.ids == minted.map { Optional($0) })
    #expect(try phone.drawn(Gym.scope, Gym.Types.thread).map(\.id) == [minted[0]])
    #expect(try phone.drawn(Gym.scope, Gym.Types.message).map(\.id) == [minted[1]])
  }

  // Design §4.5: a batch's later call sees the earlier call's writes at once through `read`, before any view refreshes
  // and before anything is sent.
  @Test func aReadAfterACommitSeesItsWritesAtOnce() throws {
    let phone = SteppedEngine(registry: SyncSchema.registry, startMs: Self.startMs, rules: NoGymRules())
    let note = Gesture(changes: [.create(Gym.Types.note, id: .given("note00000001"), ["title": "Grip", "body": "Chalk"])])
    guard case .committed(let receipt) = try phone.replica.commit(Gym.scope, note) else { throw RigError("the note was refused") }
    let read = try phone.replica.read(Gym.scope) { try $0.drawn(Gym.Types.note, "note00000001") }
    #expect(read?.values == ["title": "Grip", "body": "Chalk"])
    #expect(read?.born == receipt.stamp)
    #expect(read?.isPending == true)
  }

  // Coach D-10: every sign-in and sign-out asks the products before the seat changes, so a running turn ends while its
  // writer is still the seat: here a sign-in that completes at once, then a sign-out's start and its finish.
  @Test func everySeatChangeIsAnnouncedWhileTheOldSeatStands() async throws {
    let watcher = SeatWatcher()
    let rig = try Rig(bindings: [watcher])
    watcher.watch(rig.store)
    let session = try await rig.signIn("A", holds: ["probe": false])
    #expect(session.isComplete)
    rig.connectivity.set(online: false)
    let signingOut = try await rig.engine.signOut()
    try await signingOut.finish(.keep)
    #expect(watcher.seats == ["anon", "bound A", "bound A"])
    #expect(try rig.meta().state == .anon)
  }
}

// A product that notes, at each seat change the engine announces, the seat as the store holds it then.
final class SeatWatcher: ProductBinding {
  let product = "probe"
  let store = Mutex<Store?>(nil)
  let seen = Mutex<[String]>([])

  func watch(_ store: Store) {
    self.store.withLock { $0 = store }
  }

  func seatWillChange() async {
    let meta = try? store.withLock { $0 }?.read { tx in try tx.replica(tx.activeReplica())?.meta }
    seen.withLock { $0.append(meta.map { [$0.state.rawValue, $0.account].compactMap { $0 }.joined(separator: " ") } ?? "none") }
  }

  var seats: [String] { seen.withLock { $0 } }
}
