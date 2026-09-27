import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// The engine offline (design §11 M5): commits and their receipts, the read-and-commit body, holds on the release timer,
// Undo and retire, leaving, engine start, and the commit contract of §7.1 (it throws only before its transaction
// commits). Then two devices of one account over one in-memory server, stepped and with their loops running.

struct SyncEngineTests {
  // MARK: Commit

  @Test func aCommitIsInTheStoreAndItsViewsWhenItReturns() throws {
    let rig = try Rig()
    let receipt = try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1"))
    #expect(receipt.localIds == ["g1/0"])
    #expect(receipt.ids == ["card0001"])
    #expect(receipt.releaseAt == nil)
    #expect(receipt.retired == [])
    #expect((receipt.stamp.ms, receipt.stamp.counter) == (Rig.startMs, 0))
    #expect(receipt.stamp.actor.hasPrefix("r_"))
    #expect(try rig.outbox() == ["g1/0 ready"])
    #expect(try rig.engine.read(Rig.scope) { try $0.drawn("card", "card0001") } == Record(
      type: "card", id: "card0001", life: Life(.alive, receipt.stamp), born: receipt.stamp,
      values: ["title": "One"], texts: [:], serials: [:], rc: nil, ru: nil, isVisible: true, isPending: true, isHeld: false))
  }

  @Test func aNilGestureWritesNothingAndTicksNoClock() throws {
    let rig = try Rig()
    let before = try rig.store.read { try $0.device(rows: true).json }
    let (outcome, value) = try rig.engine.commit(Rig.scope) { context -> (Gesture?, Int) in (nil, try context.drawn("card").count) }
    #expect(outcome == nil)
    #expect(value == 0)
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
  }

  // The body decides from the views and the commit's own `now`, and its value comes back beside the receipt.
  @Test func theBodyDecidesACommandAndItsPredictionInsideTheTransaction() throws {
    let rig = try Rig()
    let (outcome, run) = try rig.engine.commit(Rig.scope) { context -> (Gesture?, RecordID) in
      let run = context.mintID("run")
      let start = Command(name: "probe.start", args: ["id": run.json, "startedAt": JSON(context.now), "join": false])
      let predicted = Change.create("run", id: .given(run), ["startedAt": JSON(context.now)])
      return (Gesture(changes: [], command: start, predict: [predicted], gestureId: "g1"), run)
    }
    guard case .committed(let receipt)? = outcome else { throw RigError("the start was refused") }
    #expect(receipt.localIds == ["g1/0"])
    #expect(try rig.active().outbox.map(\.intent.command) == [
      Command(name: "probe.start", args: ["id": run.json, "startedAt": JSON(Rig.startMs), "join": false]),
    ])
    #expect(try rig.engine.read(Rig.scope) { try $0.drawn("run", run)?.values } == ["startedAt": JSON(Rig.startMs)])
  }

  @Test func aMultiChangeGestureIsAnIntentPerRecordOrOneWhenAtomic() throws {
    let rig = try Rig()
    let each = try rig.commit(Gesture(changes: [Rig.card("card0001", "One"), Rig.card("card0002", "Two")], gestureId: "g1"))
    let atomic = try rig.commit(Gesture(
      changes: [.update("card", "card0001", ["title": "Uno"]), .update("card", "card0002", ["title": "Dos"])], atomic: true,
      gestureId: "g2"))
    #expect(each.localIds == ["g1/0", "g1/1"])
    #expect(each.ids == ["card0001", "card0002"])
    #expect(atomic.localIds == ["g2/0"])
    #expect(try rig.outbox() == ["g1/0 ready", "g1/1 ready", "g2/0 ready"])
    #expect(try rig.engine.read(Rig.scope) { try $0.drawn("card").map { $0.values["title"] } } == ["Uno", "Dos"])
  }

  @Test func aCapRefusalWritesNothingAndNamesTheCap() throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "A"), Rig.card("card0002", "B"), Rig.card("card0003", "C")]))
    let before = try rig.store.read { try $0.device(rows: true).json }
    let outcome = try rig.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card0004", "D")]))
    #expect(outcome == .refused(.cap, detail: ["type": "card", "cap": 3]))
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
  }

  @Test func aGestureTooLargeToPushIsRefusedWholeIntoItsNotice() throws {
    let rig = try Rig(limits: Limits(pushMaxBytes: 100))
    let hlc = try rig.meta().hlc
    let outcome = try rig.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1"))
    #expect(outcome == .refused(.tooLarge, detail: nil))
    #expect(try rig.outbox() == [])
    #expect(try rig.meta().hlc == hlc)
    #expect(try rig.active().notices.map { "\($0.id) \($0.code) \($0.content.deltas.map(\.key))" } == ["notice:g1/0 too-large [card card0001]"])
  }

  // MARK: The commit contract (§7.1)

  @Test func aCommitThatFailsBeforeItsTransactionCommitsLeavesNothing() throws {
    let faults = CommitFaults()
    let rig = try Rig(crashPoints: faults.crashPoints)
    let before = try rig.store.read { try $0.device(rows: true).json }
    faults.failNextCommit()
    #expect(throws: CommitFailure(.storeFailure, "Injected()")) {
      try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1"))
    }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g2"))
    #expect(try rig.outbox() == ["g2/0 ready"])
  }

  // A commit that throws names one of three failures by where it arose: a replica that does not write, a malformed
  // gesture or a misuse of the body's context, or a store that could not commit. The body's own error comes back as the
  // body threw it, and none of them writes anything.
  @Test func aCommitFailsNotWritableMalformedOrInTheStoreAndPassesTheBodysOwnError() throws {
    struct Declined: Error, Equatable {}
    let faults = CommitFaults()
    let rig = try Rig(account: "A", crashPoints: faults.crashPoints)
    let before = try rig.store.read { try $0.device(rows: true).json }
    #expect(throws: CommitFailure(.malformed, "card card0404 is absent from drawn")) {
      try rig.engine.commit(Rig.scope, Gesture(changes: [.update("card", "card0404", ["title": "Absent"])]))
    }
    #expect(throws: CommitFailure(.malformed, "mark is no type of self/probe")) {
      try rig.engine.commit(Rig.scope) { context -> (Gesture?, Int) in (nil, try context.drawn("mark").count) }
    }
    #expect(throws: CommitFailure(.malformed, "mark is no type of self/probe")) {
      try rig.engine.commit(Rig.scope) { context -> (Gesture?, Int) in (nil, (try? context.drawn("mark").count) ?? 0) }
    }
    #expect(throws: Declined()) { try rig.engine.commit(Rig.scope) { _ -> (Gesture?, Int) in throw Declined() } }
    faults.failNextCommit()
    #expect(throws: CommitFailure(.storeFailure, "Injected()")) { try rig.commit(Gesture(changes: [Rig.card("card0001", "One")])) }
    #expect(try rig.store.read { try $0.device(rows: true).json } == before)
    var dormant = try rig.meta()
    dormant.state = .dormant
    _ = try rig.store.write(.commit) { _ in Planned((), ReplicaBatch(writes: [.replica(dormant.replica, .meta(dormant))])) }
    #expect(throws: CommitFailure(.notWritable, "a dormant replica does not commit")) {
      try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
    }
  }

  // Once the transaction has committed, the receipt comes back. The steps after it (publishing to the views and the
  // subscribers, kicking the sender and the release timer) are non-throwing by type, so none can fail it; here they
  // run against a subscriber already gone and no running loop, and each still happens.
  @Test func theStepsAfterACommitRunAndCannotFailIt() async throws {
    let rig = try Rig()
    _ = rig.engine.events()
    let kicks = (sender: rig.engine.sender.wake.kicks, releaser: rig.engine.releaser.wake.kicks)
    let receipt = try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    #expect(receipt.localIds == ["g1/0"])
    #expect(try rig.outbox() == ["g1/0 held"])
    #expect(rig.engine.sender.wake.kicks == kicks.sender + 1)
    #expect(rig.engine.releaser.wake.kicks == kicks.releaser + 1)
  }

  // A commit's body reads through its context; an engine write inside it would wait on the commit's own turn forever,
  // so it stops the process with a message instead.
  @Test func anEngineWriteInsideACommitsBodyStopsInsteadOfHanging() async {
    await #expect(processExitsWith: .failure) {
      let rig = try Rig()
      _ = try rig.engine.commit(Rig.scope) { _ -> (Gesture?, Bool) in (nil, try rig.engine.undo("g1")) }
    }
  }

  // MARK: Hold, release, undo, retire (§7.3, §7.1 step 4)

  @Test func aHeldGestureIsReleasedAtItsDeadlineAndNotBefore() throws {
    let rig = try Rig()
    let receipt = try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    #expect(receipt.releaseAt == Rig.startMs + Constants.holdMs)
    #expect(rig.engine.releaser.step() == .wait(ms: 9_000))
    rig.clock.advance(ms: 8_999)
    #expect(rig.engine.releaser.step() == .wait(ms: 1))
    #expect(try rig.outbox() == ["g1/0 held"])
    let kicks = rig.engine.sender.wake.kicks
    rig.clock.advance(ms: 1)
    #expect(rig.engine.releaser.step() == .again)
    #expect(try rig.outbox() == ["g1/0 ready"])
    #expect(rig.engine.sender.wake.kicks == kicks + 1)
    #expect(rig.engine.releaser.step() == .idle)
  }

  // The timer sleeps on the monotonic clock and reads the wall clock again on waking.
  @Test func aWallClockJumpNeitherFiresAReleaseEarlyNorLosesIt() throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    #expect(rig.engine.releaser.step() == .wait(ms: 9_000))
    rig.clock.jump(ms: -5_000)
    rig.clock.advance(ms: 9_000)
    #expect(rig.engine.releaser.step() == .wait(ms: 5_000))
    #expect(try rig.outbox() == ["g1/0 held"])
    rig.clock.advance(ms: 5_000)
    #expect(rig.engine.releaser.step() == .again)
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], hold: true, gestureId: "g2"))
    rig.clock.jump(ms: 60_000)
    #expect(rig.engine.releaser.step() == .again)
    #expect(try rig.outbox() == ["g1/0 ready", "g2/0 ready"])
  }

  // The running timer sleeps on the monotonic clock: a wall clock set back while it sleeps holds the release until the
  // wall clock reaches `releaseAt`. The timer sleeps until 9 s on the monotonic clock; woken there with the wall clock
  // 5 s behind, it sleeps until 14 s; the release it then makes kicks the sender.
  @Test(.timeLimit(.minutes(1))) func theRunningTimerSleepsOnTheMonotonicClock() async throws {
    let rig = try Rig(drivesLoops: true)
    await rig.engine.start()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    await rig.clock.asleep(until: 9_000)
    rig.clock.jump(ms: -5_000)
    rig.clock.advance(ms: 9_000)
    await rig.clock.asleep(until: 14_000)
    #expect(try rig.outbox() == ["g1/0 held"])
    let kicks = rig.engine.sender.wake.kicks
    rig.clock.advance(ms: 5_000)
    await rig.engine.sender.wake.asleep(seen: kicks + 1)
    #expect(try rig.outbox() == ["g1/0 ready"])
  }

  @Test func undoRemovesAHeldGestureUntilItIsReleased() async throws {
    let rig = try Rig()
    var events = rig.engine.events().makeAsyncIterator()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    #expect(try rig.engine.undo("g1"))
    #expect(try rig.outbox() == [])
    #expect(await events.next() == .ended(localId: "g1/0", outcome: .undone, event: .undo, orphanOf: nil))
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], hold: true, gestureId: "g2"))
    rig.clock.advance(ms: Constants.holdMs)
    #expect(rig.engine.releaser.step() == .again)
    #expect(try rig.engine.undo("g2") == false)
    #expect(try rig.engine.undo("g3") == false)
    #expect(try rig.outbox() == ["g2/0 ready"])
  }

  @Test func aRetireUndoesTheHeldRemovalOfTheRecordItRewrites() throws {
    let rig = try Rig()
    let day = RecordID("2026-09-27")
    try rig.commit(Gesture(changes: [.put("day", day, present: true, ["score": 4])], gestureId: "g1"))
    try rig.commit(Gesture(changes: [.delete("day", day)], hold: true, gestureId: "g2"))
    let rewrite = try rig.commit(Gesture(
      changes: [.put("day", day, present: true, ["score": 6])], retire: [RecordRef(type: "day", id: day)], gestureId: "g3"))
    #expect(rewrite.retired == ["g2"])
    #expect(try rig.outbox() == ["g1/0 ready"])
    #expect(try rig.engine.read(Rig.scope) { try $0.drawn("day", day)?.values } == ["score": 6])
  }

  @Test func leavingReleasesEveryHeldEntryAndKicksTheSender() throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], hold: true, gestureId: "g2"))
    let kicks = rig.engine.sender.wake.kicks
    try rig.engine.leave()
    #expect(try rig.outbox() == ["g1/0 ready", "g2/0 ready"])
    #expect(rig.engine.sender.wake.kicks == kicks + 1)
    #expect(try rig.engine.undo("g1") == false)
  }

  // MARK: Engine start (§7.3, §7.11)

  @Test func aRelaunchReleasesEveryHoldWithNoUndo() throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    let relaunched = try rig.relaunch()
    #expect(try rig.outbox() == ["g1/0 ready"])
    #expect(try relaunched.undo("g1") == false)
  }

  @Test func theForkGuardIsKeptAtFirstStartAndACopyThatDiffersReidentifies() throws {
    let rig = try Rig(account: "A")
    let replica = try rig.meta().replica
    let kept = try rig.store.read { try $0.deviceMeta()?.meta.forkGuard }
    #expect(kept != nil)
    #expect(rig.forkGuard.load() == kept)
    _ = try rig.relaunch()
    #expect(try rig.meta().replica == replica)
    rig.forkGuard.save("fg_of-the-device-this-was-cloned-from")
    _ = try rig.relaunch()
    #expect(try rig.meta().replica != replica)
    #expect(rig.forkGuard.load() == (try rig.store.read { try $0.deviceMeta()?.meta.forkGuard }))
    #expect(rig.forkGuard.load() != kept)
  }

  @Test func aBoundReplicaWithNoTokenStartsPaused() throws {
    let rig = try Rig(account: "A", token: nil)
    #expect(try rig.meta().authPaused)
  }

  // MARK: Ids and time

  @Test func mintIDDrawsByTheTypesMint() throws {
    let rig = try Rig()
    let board = rig.engine.mintID("board")
    #expect(Rig.probe.type("board")!.idPattern!.matches(board.string!))
    #expect(try rig.engine.physNow() == Rig.startMs)
  }

  // MARK: Two devices over one server

  struct Device {
    let store: Store
    let engine: SyncEngine
    let connectivity: SwitchedConnectivity
  }

  // A device of account A on `network`, its replica bound before the engine starts.
  static func device(on network: SimNetwork, clock: SimClock, seed: UInt64, drivesLoops: Bool = false) throws -> Device {
    let store = try Store.inMemory(registry: Rig.probe)
    let identities = Identities(random: SeededRandomSource(seed: seed))
    _ = try store.firstLaunch(identities: identities)
    _ = try store.signIn(account: "A", holdsRecords: [:], decisions: [:], identities: identities)
    let connectivity = SwitchedConnectivity()
    let engine = try SyncEngine(
      config: EngineConfig(appVersion: "1.0", surface: .ios, drivesLoops: drivesLoops), store: store, transport: network,
      tokens: InMemoryTokenStore(["A": network.token(for: "A")]), forkGuard: InMemoryForkGuardStore(), clock: clock.engineClock,
      random: SeededRandomSource(seed: seed + 100), connectivity: connectivity)
    return Device(store: store, engine: engine, connectivity: connectivity)
  }

  static func network(_ clock: SimClock) -> SimNetwork {
    SimNetwork(server: ModelServer(registry: Rig.probe, rules: ProbeServerRules(), state: ServerState(epoch: "ep-1", accounts: ["A": "Ann"])),
               clock: clock)
  }

  // Every card a device's stored view holds.
  static func cards(_ device: Device) throws -> [Record] {
    try device.engine.read(Rig.scope) { try $0.stored("card") }
  }

  // Returns once no loop of `devices` has anything left to do: each waits on its wake having seen every kick, and each
  // socket of `network` has handed every frame to its engine, with no kick since. Nothing else wakes a loop while the
  // clock stands still: a round's timers wait on it, and only a loop's round calls the network.
  static func quiescent(_ devices: [Device], on network: SimNetwork) async {
    let wakes = devices.flatMap { [$0.engine.sender.wake, $0.engine.releaser.wake, $0.engine.puller.wake, $0.engine.live.wake] }
    while true {
      let kicks = wakes.map(\.kicks)
      for socket in network.connections { await socket.drained() }
      for (wake, seen) in zip(wakes, kicks) { await wake.asleep(seen: seen) }
      for socket in network.connections { await socket.drained() }
      if wakes.map(\.kicks) == kicks { return }
    }
  }

  // A's cards reach B: the first by a frame applied inline; the second while B is offline, so B's first frame after it
  // reconnects is past a gap and B pulls, which brings the second and the third. Both end holding the server's rows,
  // their digests checked.
  @Test func aWriteOnOneDeviceReachesAnotherByPushLiveFrameAndPull() async throws {
    let clock = SimClock(wallMs: Rig.startMs)
    let network = Self.network(clock)
    let (a, b) = (try Self.device(on: network, clock: clock, seed: 1), try Self.device(on: network, clock: clock, seed: 2))
    #expect(await b.engine.live.step() == .open(ms: 25_000))
    #expect(await b.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))

    _ = try a.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card0001", "One")]))
    #expect(await a.engine.sender.step() == .again)
    #expect(await b.engine.live.receiveNext())
    #expect(await b.engine.puller.step() == .frame(Rig.scope, .applied))
    #expect(try Self.cards(b).count == 1)

    b.connectivity.set(online: false)
    #expect(await b.engine.live.step() == .idle)
    _ = try a.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card0002", "Two")]))
    #expect(await a.engine.sender.step() == .again)
    b.connectivity.set(online: true)
    #expect(await b.engine.live.step() == .open(ms: 25_000))
    _ = try a.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card0003", "Three")]))
    #expect(await a.engine.sender.step() == .again)
    #expect(await b.engine.live.receiveNext())
    #expect(await b.engine.puller.step() == .frame(Rig.scope, .pull))
    #expect(await b.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    #expect(await b.engine.puller.step() == .fallback(ms: Constants.pullFallbackMs))

    #expect(await a.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    let server = network.server.state.rows[ScopeKey(.product(account: "A", name: "probe"))] ?? [:]
    #expect(server.count == 3)
    for device in [a, b] {
      let replica = try device.store.read { try $0.device(rows: true).activeReplica }
      #expect(replica.confirmed[Rig.scope]?.all.map(\.json) == server.values.sorted { $0.key < $1.key }.map(\.json))
      #expect(replica.cursors[Rig.scope] == CursorRecord(cursor: Cursor(epoch: "ep-1", mode: .live, seq: 3).text,
                                                         digest: ScopeDigest(rows: server.values.map(\.json)), booted: true))
      #expect(replica.outbox.isEmpty)
    }
    #expect(try Self.cards(a) == Self.cards(b))
  }

  // The same with every loop running: sockets open and scopes boot from `start()`, and A's commit reaches B, and
  // resolves on A, with no step taken by hand, whether A's own frame or its push's answer comes first. Each check waits
  // for both devices' loops to have nothing left to do.
  @Test(.timeLimit(.minutes(1))) func twoDevicesWithTheirLoopsRunningConverge() async throws {
    let clock = SimClock(wallMs: Rig.startMs)
    let network = Self.network(clock)
    let a = try Self.device(on: network, clock: clock, seed: 1, drivesLoops: true)
    let b = try Self.device(on: network, clock: clock, seed: 2, drivesLoops: true)
    await a.engine.start()
    await b.engine.start()
    await Self.quiescent([a, b], on: network)
    #expect(try b.engine.read(Rig.scope) { try $0.firstPullComplete() })
    _ = try a.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card0001", "One")]))
    await Self.quiescent([a, b], on: network)
    #expect(try Self.cards(b).map(\.values) == [["title": "One"]])
    #expect(try Self.cards(a) == Self.cards(b))
    #expect(try a.store.read { try $0.device(rows: true).activeReplica }.outbox.isEmpty)
  }
}
