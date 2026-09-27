import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// §7.4 the sender over a scripted transport: one test per outcome row of design §6.3, backoff and kicks, the
// revalidation of an answer against what moved while it was in flight, and the loop with the leave flush.

struct SenderTests {
  static let card1 = Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1")
  static let three = Gesture(changes: [Rig.card("card0001", "A"), Rig.card("card0002", "B"), Rig.card("card0003", "C")], gestureId: "g1")

  static func numbers(_ transport: ScriptedTransport) -> [[Int64]] {
    transport.pushes.map { $0.intents.compactMap(\.n) }
  }

  // MARK: 200

  @Test func anOkAnswerAcksTheEntryAndRecordsTheOffsetTheAckAndTheEpoch() async throws {
    let rig = try Rig(account: "A")
    let receipt = try rig.commit(Self.card1)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 7)], serverTime: Rig.startMs + 5_000))
    #expect(await rig.engine.sender.step() == .again)
    let replica = try rig.active()
    #expect(rig.transport.calls == [
      .push(PushRequest(replica: replica.meta.replica, ackThrough: 0, intents: replica.outbox.map(\.intent)), token: SessionToken("token-1")),
    ])
    #expect(try rig.outbox() == ["g1/0 acked 1"])
    #expect(replica.outbox.map { "\($0.resultSeq!) \($0.resultEpoch!)" } == ["7 ep-1"])
    #expect(replica.meta.ackThrough == 1)
    #expect(replica.meta.serverEpoch == "ep-1")
    #expect(replica.meta.serverOffsetMs == 5_000)
    #expect(replica.meta.admittedHigh == receipt.stamp)
    #expect(try rig.engine.physNow() == Rig.startMs + 5_000)
    #expect(await rig.engine.sender.step() == .idle)
    #expect(rig.transport.calls.count == 1)
  }

  @Test func aRetryAnswerRecordsWhatWasAdmittedAndWaitsAsAsked() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.three)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)], retry: ["n": 2, "retryAfterMs": 4_000]))
    #expect(await rig.engine.sender.step() == .wait(ms: 4_000))
    #expect(try rig.outbox() == ["g1/0 acked 1", "g1/1 sent 2", "g1/2 sent 3"])
    rig.clock.advance(ms: 3_000)
    rig.engine.foreground()
    #expect(await rig.engine.sender.step() == .wait(ms: 1_000))
    #expect(rig.transport.pushes.count == 1)
    rig.clock.advance(ms: 1_000)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 3, [Rig.admitted(2, seq: 2), Rig.admitted(3, seq: 3)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(Self.numbers(rig.transport) == [[1, 2, 3], [2, 3]])
    #expect(rig.transport.pushes[1].ackThrough == 1)
    #expect(try rig.outbox() == ["g1/0 acked 1", "g1/1 acked 2", "g1/2 acked 3"])
  }

  // §7.7 step 1: the sample says the device runs 10 minutes ahead; the entry takes a fresh stamp on the server's time
  // and goes again under the next number, with no notice.
  @Test func aClockSkewRefusalRestampsTheEntryAndSendsItAgain() async throws {
    let rig = try Rig(account: "A")
    rig.clock.skew(ms: 600_000)
    let receipt = try rig.commit(Self.card1)
    #expect(receipt.stamp.ms == Rig.startMs + 600_000)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.refused(1, "clock-skew")], serverTime: Rig.startMs))
    #expect(await rig.engine.sender.step() == .again)
    #expect(try rig.outbox() == ["g1/0 ready"])
    #expect(try rig.meta().serverOffsetMs == -600_000)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 2, [Rig.admitted(2, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    let restamped = try Stamp("\(Rig.startMs):1:\(receipt.stamp.actor)")
    #expect(Self.numbers(rig.transport) == [[1], [2]])
    #expect(Set(rig.transport.pushes[0].intents[0].deltas.flatMap(\.lattice.stamps)) == [receipt.stamp])
    #expect(Set(rig.transport.pushes[1].intents[0].deltas.flatMap(\.lattice.stamps)) == [restamped])
    #expect(try rig.active().notices.isEmpty)
  }

  @Test func anEpochChangeInAnAnswerReturnsOtherEpochsAcksAndReidentifies() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    let before = try rig.meta().replica
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], gestureId: "g2"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 2, [Rig.admitted(2, seq: 1)], epoch: "ep-2"))
    #expect(await rig.engine.sender.step() == .again)
    let meta = try rig.meta()
    #expect(meta.replica != before)
    #expect((meta.serverEpoch, meta.nextN, meta.ackThrough) == ("ep-2", 1, 0))
    #expect(try rig.outbox() == ["g1/0 ready", "g2/0 acked 2"])
  }

  // A server that answers none of the request's intents and asks for no retry would bring the same push straight
  // back: it backs off like a failure, and the backoff keeps growing.
  @Test func anAnswerThatAnswersNothingBacksOff() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    rig.random.queue(raw: .max, count: 2)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 0, []))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 0, [Rig.admitted(9, seq: 1)]))
    #expect(await rig.engine.sender.step() == .backoff(ms: 1_000))
    #expect(await rig.engine.sender.step() == .backoff(ms: 2_000))
    #expect(try rig.outbox() == ["g1/0 sent 1"])
  }

  // MARK: Failures

  @Test func aDroppedPushBacksOffAndGoesAgainWithTheSameNumberAndDigest() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    rig.random.queue(raw: .max, count: 2)
    rig.transport.willDropPush()
    rig.transport.willDropPush()
    #expect(await rig.engine.sender.step() == .backoff(ms: 1_000))
    #expect(await rig.engine.sender.step() == .backoff(ms: 2_000))
    #expect(try rig.outbox() == ["g1/0 sent 1"])
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(Set(rig.transport.pushes).count == 1)
    #expect(rig.transport.pushes.count == 3)
  }

  @Test func aKickResetsTheBackoff() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    rig.random.queue(raw: .max, count: 4)
    for _ in 0..<4 { rig.transport.willDropPush() }
    var sleeps: [SenderStep] = []
    for _ in 0..<3 { sleeps.append(await rig.engine.sender.step()) }
    rig.engine.foreground()
    sleeps.append(await rig.engine.sender.step())
    #expect(sleeps == [.backoff(ms: 1_000), .backoff(ms: 2_000), .backoff(ms: 4_000), .backoff(ms: 1_000)])
  }

  // Appendix B: 300 s, or 30 s while a product's live hint holds; here the hint is an unended run.
  @Test func theLiveHintLowersTheBackoffCeiling() async throws {
    struct Running: ProductBinding {
      let product = "probe"

      func liveHint(_ reader: any ScopeReader, physNow: Int64) throws -> Bool { try !reader.drawn("run").isEmpty }
    }
    var ceilings: [[SenderStep]] = []
    for live in [false, true] {
      let rig = try Rig(account: "A", bindings: [Running()])
      let changes: [Change] = live ? [.create("run", id: .given("run00001"), ["startedAt": 1])] : [Rig.card("card0001", "One")]
      try rig.commit(Gesture(changes: changes))
      rig.random.queue(raw: .max, count: 11)
      var sleeps: [SenderStep] = []
      for _ in 0..<11 {
        rig.transport.willDropPush()
        sleeps.append(await rig.engine.sender.step())
      }
      ceilings.append(sleeps)
    }
    let doubling: [Int64] = [1_000, 2_000, 4_000, 8_000, 16_000]
    #expect(ceilings[0] == (doubling + [32_000, 64_000, 128_000, 256_000, 300_000, 300_000]).map { .backoff(ms: $0) })
    #expect(ceilings[1] == (doubling + Array(repeating: 30_000, count: 6)).map { .backoff(ms: $0) })
  }

  @Test func aServiceUnavailableWaitsNoLessThanItsRetryAfter() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    rig.transport.willAnswerPush(503, ["error": "unavailable", "retryAfterMs": 7_000, "serverTime": JSON(Rig.startMs), "epoch": "ep-1"])
    #expect(await rig.engine.sender.step() == .wait(ms: 7_000))
    #expect(try rig.outbox() == ["g1/0 sent 1"])
    #expect(await rig.engine.sender.step() == .wait(ms: 7_000))
    #expect(rig.transport.pushes.count == 1)
  }

  // A conflict run is broken by any other answer: after a dropped push, a conflict is the first of a new run.
  @Test func aConflictAfterAnyOtherAnswerIsAFirstConflict() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    rig.transport.willAnswerPush(409, Rig.failure("replica-forked"))
    rig.transport.willDropPush()
    rig.transport.willAnswerPush(409, Rig.failure("replica-forked"))
    #expect(await rig.engine.sender.step() == .again)
    rig.random.queue(raw: .max, count: 1)
    #expect(await rig.engine.sender.step() == .backoff(ms: 1_000))
    #expect(await rig.engine.sender.step() == .again)
  }

  @Test func a401PausesTheReplicaUntilItsAccountSignsInAgain() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    rig.transport.willAnswerPush(401, Rig.failure("unauthenticated"))
    #expect(await rig.engine.sender.step() == .paused)
    #expect(try rig.meta().authPaused)
    #expect(try rig.outbox() == ["g1/0 sent 1"])
    #expect(await rig.engine.sender.step() == .idle)
    #expect(rig.transport.pushes.count == 1)
    let kicks = rig.engine.sender.wake.kicks
    try rig.engine.reauthenticate(token: SessionToken("token-2"))
    #expect(rig.engine.sender.wake.kicks == kicks + 1)
    #expect(try rig.meta().authPaused == false)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(rig.transport.calls.last == .push(rig.transport.pushes[0], token: SessionToken("token-2")))
    #expect(try rig.outbox() == ["g1/0 acked 1"])
  }

  @Test func aTokenThatIsGonePausesWithoutPushing() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    rig.tokens.delete(for: "A")
    #expect(await rig.engine.sender.step() == .paused)
    #expect(rig.transport.calls == [])
    #expect(try rig.meta().authPaused)
    #expect(try rig.outbox() == ["g1/0 ready"])
    #expect(throws: EngineError.notSignedIn) { try Rig().engine.reauthenticate(token: SessionToken("token-2")) }
  }

  @Test func a426StopsSendingForTheProcess() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    rig.transport.willAnswerPush(426, Rig.failure("upgrade-required"))
    #expect(await rig.engine.sender.step() == .stopped)
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")]))
    #expect(await rig.engine.sender.step() == .stopped)
    #expect(rig.transport.pushes.count == 1)
    let engine = rig.engine
    await engine.settle()
    #expect(await MainActor.run { engine.status.upgradeRequired })
  }

  @Test func a400OnSeveralIntentsHalvesTheBatchAndReportsItself() async throws {
    let rig = try Rig(account: "A")
    var events = rig.engine.events().makeAsyncIterator()
    try rig.commit(Self.three)
    rig.transport.willAnswerPush(400, Rig.failure("malformed"))
    #expect(await rig.engine.sender.step() == .again)
    #expect(await events.next() == .pushMalformed)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 2, [Rig.admitted(1, seq: 1), Rig.admitted(2, seq: 2)]))
    #expect(await rig.engine.sender.step() == .again)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 3, [Rig.admitted(3, seq: 3)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(Self.numbers(rig.transport) == [[1, 2, 3], [1, 2], [3]])
    #expect(try rig.outbox() == ["g1/0 acked 1", "g1/1 acked 2", "g1/2 acked 3"])
  }

  @Test func a400OnOneIntentRefusesItInvalidIntoItsNotice() async throws {
    let rig = try Rig(account: "A")
    var events = rig.engine.events().makeAsyncIterator()
    try rig.commit(Self.card1)
    rig.transport.willAnswerPush(400, Rig.failure("malformed"))
    #expect(await rig.engine.sender.step() == .again)
    #expect(try rig.outbox() == [])
    #expect(try rig.active().notices.map { "\($0.id) \($0.code)" } == ["notice:g1/0 invalid"])
    #expect(try rig.meta().nextN == 1)
    #expect([await events.next(), await events.next()] == [
      .pushMalformed, .ended(localId: "g1/0", outcome: .refused, event: .refuse, orphanOf: nil),
    ])
  }

  // A 413 halves a batch down to one intent, which is refused too-large; the later sent entry is rewound and goes
  // again under the refused one's number.
  @Test func a413OnTheLastIntentLeftRefusesItAndRewindsTheRest() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One"), Rig.card("card0002", "Two")], gestureId: "g1"))
    rig.transport.willAnswerPush(413, Rig.failure("request-too-large"))
    rig.transport.willAnswerPush(413, Rig.failure("request-too-large"))
    #expect(await rig.engine.sender.step() == .again)
    #expect(await rig.engine.sender.step() == .again)
    #expect(try rig.outbox() == ["g1/1 ready"])
    #expect(try rig.active().notices.map { "\($0.id) \($0.code)" } == ["notice:g1/0 too-large"])
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(Self.numbers(rig.transport) == [[1, 2], [1], [1]])
    #expect(rig.transport.pushes[2].intents[0].deltas.map(\.key) == [RecordKey("card", "card0002")])
    #expect(try rig.outbox() == ["g1/1 acked 1"])
  }

  // §7.11: a new replica id numbering from 1, and a new actor for this instance; a second conflict in a row backs off.
  @Test func aConflictReidentifiesUnderANewActorAndSendsFromOne() async throws {
    let rig = try Rig(account: "A")
    let first = try rig.commit(Self.card1)
    let before = try rig.meta().replica
    rig.transport.willAnswerPush(409, Rig.failure("replica-forked"))
    #expect(await rig.engine.sender.step() == .again)
    let renamed = try rig.meta()
    #expect(renamed.replica != before)
    #expect((renamed.nextN, renamed.ackThrough) == (1, 0))
    #expect(try rig.outbox() == ["g1/0 ready"])
    let second = try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], gestureId: "g2"))
    #expect(second.stamp.actor != first.stamp.actor)
    rig.transport.willAnswerPush(409, Rig.failure("replica-forked"))
    guard case .backoff = await rig.engine.sender.step() else { throw RigError("a second conflict in a row backs off") }
    #expect(rig.transport.pushes.map(\.replica) == [before, renamed.replica])
    #expect(Self.numbers(rig.transport) == [[1], [1, 2]])
  }

  // MARK: Where the sender does not push

  @Test func offlineTheSenderIdlesAndComingOnlineKicksIt() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    rig.connectivity.set(online: false)
    #expect(await rig.engine.sender.step() == .idle)
    let kicks = rig.engine.sender.wake.kicks
    rig.connectivity.set(online: true)
    #expect(rig.engine.sender.wake.kicks == kicks + 1)
    #expect(rig.transport.calls == [])
  }

  @Test func aSignedOutReplicaIsNeverSent() async throws {
    let rig = try Rig()
    try rig.commit(Self.card1)
    #expect(await rig.engine.sender.step() == .idle)
    #expect(rig.transport.calls == [])
  }

  // MARK: Revalidation (design §4.4 rule 2)

  // A re-identify lands while the push is in flight: the answer names the old replica, so none of it is recorded.
  @Test func anAnswerForAReplicaThatMovedOnMeanwhileIsDropped() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Self.card1)
    let gate = Gate()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]), after: gate)
    let sender = rig.engine.sender
    let stepping = Task { await sender.step() }
    try await eventually("the push to be in flight") { gate.reached }
    var instance = Instance(actor: try Stamp.Actor("r_elsewhere00"), deviceNow: Rig.startMs, appVersion: "1.0")
    _ = try rig.store.reidentify(instance: &instance, identities: Identities(random: SeededRandomSource(seed: 3)))
    gate.open()
    #expect(await stepping.value == .again)
    #expect(try rig.outbox() == ["g1/0 ready"])
    let meta = try rig.meta()
    #expect((meta.ackThrough, meta.serverEpoch, meta.serverOffsetMs) == (0, nil, 0))
  }

  // MARK: The loop

  @Test func theLoopSendsWhatACommitKicks() async throws {
    let rig = try Rig(account: "A", drivesLoops: true)
    await rig.engine.start()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    try rig.commit(Self.card1)
    try await eventually("the commit to be acked") { try rig.outbox() == ["g1/0 acked 1"] }
  }

  // The leave flush takes its turns beside the running loop: one push in flight at a time, and it returns once the
  // outbox is drained.
  @Test func theLeaveFlushTakesItsTurnsBesideTheLoop() async throws {
    let rig = try Rig(account: "A", drivesLoops: true)
    await rig.engine.start()
    let gate = Gate()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]), after: gate)
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 2, [Rig.admitted(2, seq: 2)]))
    try rig.commit(Self.card1)
    try await eventually("the first push to be in flight") { gate.reached }
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], hold: true, gestureId: "g2"))
    try rig.engine.leave()
    let engine = rig.engine
    let flushing = Task { await engine.flushOnLeave() }
    gate.open()
    await flushing.value
    #expect(try rig.outbox() == ["g1/0 acked 1", "g2/0 acked 2"])
    #expect(rig.transport.mostPushesInFlight == 1)
    #expect(Self.numbers(rig.transport) == [[1], [2]])
  }

  // A flush drains inline before the loop starts, and the loop starts while that push is in flight: the loop's first
  // push waits for it, so one push is ever in flight.
  @Test func aLoopStartedDuringAnInlineFlushWaitsForItsPush() async throws {
    let rig = try Rig(account: "A", drivesLoops: true)
    try rig.commit(Self.card1)
    let gate = Gate()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]), after: gate)
    let engine = rig.engine
    let flushing = Task { await engine.flushOnLeave() }
    try await eventually("the flush's push to be in flight") { gate.reached }
    await engine.start()
    try await Task.sleep(for: .milliseconds(50))
    gate.open()
    await flushing.value
    try await eventually("the outbox to drain") { try rig.outbox() == ["g1/0 acked 1"] }
    #expect(rig.transport.mostPushesInFlight == 1)
    #expect(Self.numbers(rig.transport) == [[1]])
  }

  // Two flushes before the loop runs (the leave flush and a second caller) take turns: one push in flight.
  @Test func twoFlushesAtOnceSendOnePushAtATime() async throws {
    let rig = try Rig(account: "A", drivesLoops: true)
    try rig.commit(Self.card1)
    let gate = Gate()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]), after: gate)
    let engine = rig.engine
    let first = Task { await engine.flushOnLeave() }
    try await eventually("the first push to be in flight") { gate.reached }
    let second = Task { await engine.flushOnLeave() }
    try await Task.sleep(for: .milliseconds(50))
    gate.open()
    await first.value
    await second.value
    #expect(rig.transport.mostPushesInFlight == 1)
    #expect(Self.numbers(rig.transport) == [[1]])
  }

  // While the server's pause runs the flush pushes nothing and returns at once, sleeping through none of it.
  @Test func theLeaveFlushInsideTheServersPauseReturnsAtOnce() async throws {
    let rig = try Rig(account: "A", drivesLoops: true)
    await rig.engine.start()
    rig.transport.willAnswerPush(503, ["error": "unavailable", "retryAfterMs": 60_000, "serverTime": JSON(Rig.startMs), "epoch": "ep-1"])
    try rig.commit(Self.card1)
    try await eventually("the loop to sleep out the server's pause") { rig.transport.pushes.count == 1 && rig.clock.sleepers == 1 }
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], gestureId: "g2"))
    await rig.engine.flushOnLeave()
    #expect(rig.transport.pushes.count == 1)
    #expect(try rig.outbox() == ["g1/0 sent 1", "g2/0 ready"])
  }

  // The background time runs out while the loop's push is in flight: the flush waiting its turn returns at once.
  @Test func aCancelledLeaveFlushReturnsWithoutWaitingForItsTurn() async throws {
    let rig = try Rig(account: "A", drivesLoops: true)
    await rig.engine.start()
    let gate = Gate()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]), after: gate)
    try rig.commit(Self.card1)
    try await eventually("the loop's push to be in flight") { gate.reached }
    let engine = rig.engine
    let flushing = Task { await engine.flushOnLeave() }
    try await Task.sleep(for: .milliseconds(20))
    flushing.cancel()
    await flushing.value
    #expect(rig.transport.pushes.count == 1)
    gate.open()
    try await eventually("the loop's push to be recorded") { try rig.outbox() == ["g1/0 acked 1"] }
  }

  // With no loop running, the flush drains inline.
  @Test func inStepModeTheLeaveFlushDrainsItself() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    try rig.engine.leave()
    await rig.engine.flushOnLeave()
    #expect(try rig.outbox() == ["g1/0 acked 1"])
  }
}
