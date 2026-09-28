import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// The engine offline (design §11 M5): commits and their receipts, the read-and-commit body, holds on the release timer,
// Undo and retire, leaving, and the commit contract of §7.1 (it throws only before its transaction commits). Then two
// devices of one account over one in-memory server, stepped and with their loops running.

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
      let run = try context.mintID("run")
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

  // §7.1 step 4, §2.4: a field recording each save's moment is an lww field the body writes from the commit's own `now`,
  // the reading the gesture's stamp takes; a record saved whole carries every field and a fresh life at that stamp, so a
  // later save of an equal value writes it again.
  @Test func aSaveWholeStampsItsMomentFromTheCommitsOwnNow() throws {
    let rig = try Rig()
    let save = { (value: JSON) throws -> CommitReceipt in
      let (outcome, _) = try rig.engine.commit(Rig.scope) { context -> (Gesture?, Void) in
        (Gesture(changes: [.put("fact", "2027-01-15", present: true, ["value": value, "at": JSON(context.now)])]), ())
      }
      guard case .committed(let receipt)? = outcome else { throw RigError("the save was refused") }
      return receipt
    }
    let first = try save(80.04)
    rig.clock.advance(ms: 60_000)
    let second = try save(80)
    #expect(try rig.active().outbox.map(\.intent.deltas) == [first, second].map { receipt in
      [Delta(key: RecordKey("fact", "2027-01-15"), lattice: Lattice(
        life: Life(.alive, receipt.stamp),
        fields: ["value": Register(80, receipt.stamp), "at": Register(JSON(receipt.stamp.ms), receipt.stamp)]))]
    })
    #expect(second.stamp.ms == Rig.startMs + 60_000)
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
    #expect(outcome == .refused(.tooLarge, detail: nil, notice: "notice:g1/0"))
    #expect(try rig.outbox() == [])
    #expect(try rig.meta().hlc == hlc)
    #expect(try rig.active().notices.map { "\($0.id) \($0.code) \($0.content.deltas.map(\.key))" } == ["notice:g1/0 too-large [card card0001]"])
  }

  // §7.1 step 8: the `anon` replica, with no account yet, measures each intent with the widest account a push can name,
  // ACCOUNT_ID_BYTES long, so an entry it commits still fits a request alone once a sign-in names the account; a replica
  // bound to A measures with A. A gesture whose widest body fits only with the shorter account is refused signed out and
  // committed signed in.
  @Test func anAnonReplicaMeasuresItsIntentsWithTheWidestAccount() throws {
    let gesture = Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1")
    let measured = try Rig()
    try measured.commit(gesture)
    var intent = try #require(try measured.active().outbox.first?.intent)
    intent.n = JSON.maxSafeInteger
    let widest = PushRequest(
      replica: try measured.meta().replica, account: String(repeating: "a", count: Constants.accountIdBytes),
      ackThrough: JSON.maxSafeInteger, intents: [intent]).body.count
    let anon = try Rig(limits: Limits(pushMaxBytes: widest - 1))
    #expect(try anon.engine.commit(Rig.scope, gesture) == .refused(.tooLarge, detail: nil, notice: "notice:g1/0"))
    let bound = try Rig(account: "A", limits: Limits(pushMaxBytes: widest - 1))
    guard case .committed = try bound.engine.commit(Rig.scope, gesture) else { throw RigError("the bound replica refused the gesture") }
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

  // An Undo's silent fold frees the part of an atomic entry that did not depend on the held create, which nothing holds
  // back any more: the Undo wakes the sender, whose next round sends it.
  @Test func anUndoThatFreesAHeldBackEntryWakesTheSender() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Gesture(changes: [Rig.card("card0001", "Held")], hold: true, gestureId: "g1"))
    try rig.commit(Gesture(
      changes: [.update("card", "card0001", ["title": "Edited"]), Rig.card("card0002", "Mine")], atomic: true, gestureId: "g2"))
    #expect(await rig.engine.sender.step() == .idle)
    let kicks = rig.engine.sender.wake.kicks
    #expect(try rig.engine.undo("g1"))
    #expect(rig.engine.sender.wake.kicks == kicks + 1)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(rig.transport.pushes.map { $0.intents.map { $0.deltas.map(\.key) } } == [[[RecordKey("card", "card0002")]]])
  }

  @Test func aRetireUndoesTheHeldRemovalOfTheRecordItRewrites() throws {
    let rig = try Rig()
    let day = RecordID("2026-09-27")
    try rig.commit(Gesture(changes: [.put("day", day, present: true, ["score": 4])], gestureId: "g1"))
    try rig.commit(Gesture(changes: [.delete("day", day)], hold: true, gestureId: "g2"))
    let rewrite = try rig.commit(Gesture(
      changes: [.put("day", day, present: true, ["score": 6])], retire: [RecordRef(type: "day", id: day)], gestureId: "g3"))
    #expect(rewrite.retired == ["g2"])
    #expect(try rig.outbox() == ["g1/0 ready", "g3/0 ready"])
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

  // MARK: Ids and time

  @Test func mintIDDrawsByTheTypesMint() throws {
    let rig = try Rig()
    let board = try rig.engine.mintID("board")
    #expect(Rig.probe.type("board")!.idPattern!.matches(board.string!))
    #expect(throws: CommitFailure(.malformed, "day mints no ids")) { try rig.engine.mintID("day") }
    #expect(try rig.engine.physNow() == Rig.startMs)
  }

  // MARK: Two devices over one server

  struct Device {
    let store: Store
    let engine: SyncEngine
    let connectivity: SwitchedConnectivity
  }

  // A device of `account` (A unless said) on `network`, its replica bound before the engine starts.
  static func device(of account: String = "A", on network: SimNetwork, clock: SimClock, seed: UInt64,
                     drivesLoops: Bool = false) throws -> Device {
    let store = try Store.inMemory(registry: Rig.probe)
    let identities = Identities(random: SeededRandomSource(seed: seed))
    _ = try store.firstLaunch(identities: identities)
    _ = try store.signIn(account: account, holdsRecords: [:], decisions: [:], counted: [:], identities: identities)
    let connectivity = SwitchedConnectivity()
    let engine = try SyncEngine(
      config: EngineConfig(appVersion: "1.0", surface: .ios, drivesLoops: drivesLoops), store: store, transport: network,
      tokens: InMemoryTokenStore([account: network.server.token(for: account)]), forkGuard: InMemoryForkGuardStore(),
      clock: clock.engineClock, random: SeededRandomSource(seed: seed + 100), connectivity: connectivity)
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

  // §6.8: revoking a session closes the socket opened under it before it sends another frame. B follows A's cards under a
  // session of its own; once it is revoked, A's next card reaches B as no frame but the socket's end, and B's reconnect
  // pulls under the revoked session, is answered 401 and pauses, holding the card it had and forgetting nothing.
  @Test func aRevokedSessionsSocketEndsBeforeAnotherFrame() async throws {
    let clock = SimClock(wallMs: Rig.startMs)
    let network = Self.network(clock)
    let (a, b) = (try Self.device(on: network, clock: clock, seed: 1), try Self.device(on: network, clock: clock, seed: 2))
    let session = network.server.issueToken(for: "A")
    try b.engine.reauthenticate(token: session)
    #expect(await b.engine.live.step() == .open(ms: 25_000))
    #expect(await b.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    _ = try a.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card0001", "One")]))
    #expect(await a.engine.sender.step() == .again)
    #expect(await b.engine.live.receiveNext())
    #expect(await b.engine.puller.step() == .frame(Rig.scope, .applied))
    let held = try Self.cards(b)

    network.server.revoke(session)
    _ = try a.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card0002", "Two")]))
    #expect(await a.engine.sender.step() == .again)
    let socket = try #require(network.connections.last)
    #expect(socket.waitingFrames == 0)
    #expect(await b.engine.live.receiveNext() == false)
    #expect(await b.engine.puller.step() == .paused)
    let replica = try b.store.read { try $0.device(rows: true).activeReplica }
    #expect(replica.meta.authPaused)
    #expect(replica.known == [:])
    #expect(try Self.cards(b) == held)
    #expect(held.map(\.id.string) == ["card0001"])
  }

  // §6.2 step 3, §9.1: a phone of A whose stored session is B's pushes naming A. The server answers `account-mismatch`
  // as B before it reads the binding, so nothing lands in B and the fresh replica stays unbound; the phone pauses and
  // pulls nothing, and once A re-authenticates the entry lands in A, its replica bound to A.
  @Test func aPhoneHoldingAnotherAccountsSessionPushesNothingIntoIt() async throws {
    let clock = SimClock(wallMs: Rig.startMs)
    let network = Self.network(clock)
    let phone = try Self.device(on: network, clock: clock, seed: 1)
    try phone.engine.reauthenticate(token: network.server.issueToken(for: "B"))
    _ = try phone.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card0001", "Mine")]))
    let replica = try phone.store.read { try $0.activeReplica() }
    #expect(await phone.engine.sender.step() == .paused)
    #expect(network.server.state.replicas[replica] == nil)
    #expect(network.server.rows(Rig.scope, of: "B") == [])
    #expect(await phone.engine.puller.step() == .paused)
    try phone.engine.reauthenticate(token: network.server.issueToken(for: "A"))
    #expect(await phone.engine.sender.step() == .again)
    #expect(network.server.state.replicas[replica]?.account == "A")
    #expect(network.server.rows(Rig.scope, of: "A").map(\.key) == [RecordKey("card", "card0001")])
    #expect(network.server.rows(Rig.scope, of: "B") == [])
  }

  // §9.1, §7.5: a socket opened under a session of B's is served as B. Its first frame, B's own card, closes it and pauses
  // the phone of A, and nothing of B's reaches A's replica.
  @Test func aSocketServedAsAnotherAccountAppliesNothingOfIt() async throws {
    let clock = SimClock(wallMs: Rig.startMs)
    let network = Self.network(clock)
    let phone = try Self.device(on: network, clock: clock, seed: 1)
    #expect(await phone.engine.puller.step() == .pulled([PageReport(scope: Rig.scope, outcome: .applied)]))
    try phone.engine.reauthenticate(token: network.server.issueToken(for: "B"))
    #expect(await phone.engine.live.step() == .open(ms: 25_000))
    let other = try Self.device(of: "B", on: network, clock: clock, seed: 2)
    _ = try other.engine.commit(Rig.scope, Gesture(changes: [Rig.card("cardB001", "Theirs")]))
    #expect(await other.engine.sender.step() == .again)
    #expect(await phone.engine.live.receiveNext())
    #expect(network.connections.map(\.isClosed) == [true])
    #expect(try phone.store.read { try $0.replica($0.activeReplica())!.meta.authPaused })
    #expect(await phone.engine.puller.step() == .paused)
    #expect(try Self.cards(phone) == [])
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
