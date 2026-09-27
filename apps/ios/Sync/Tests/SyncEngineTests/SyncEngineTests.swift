import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// The engine offline (design §11 M5): commits and their receipts, the read-and-commit body, holds on the release timer,
// Undo and retire, leaving, engine start, and the commit contract of §7.1 (it throws only before its transaction
// commits).

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
  // wall clock reaches `releaseAt`.
  @Test func theRunningTimerSleepsOnTheMonotonicClock() async throws {
    let rig = try Rig(drivesLoops: true)
    await rig.engine.start()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    try await eventually("the timer to sleep") { rig.clock.sleepers == 1 }
    rig.clock.jump(ms: -5_000)
    rig.clock.advance(ms: 9_000)
    try await eventually("the timer to sleep again") { rig.clock.sleepers == 1 }
    #expect(try rig.outbox() == ["g1/0 held"])
    rig.clock.advance(ms: 5_000)
    try await eventually("the release") { try rig.outbox() == ["g1/0 ready"] }
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
}
