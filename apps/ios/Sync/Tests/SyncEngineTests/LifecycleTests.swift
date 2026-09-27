import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Synchronization
import Testing

// The replica lifecycle through the engine's own calls (design §11 M8): engine start and the fork guard, every row of
// §8.2, the corpus's lineage vectors, the sign-in session and its decisions, the sign-out session with its bounded flush
// and the sender's hold, dormant replicas, two devices meeting at a sign-in, and a kill at every step of each.

struct LifecycleTests {
  // MARK: Engine start (§7.3, §7.11)

  @Test func aRelaunchReleasesEveryHoldWithNoUndo() throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], hold: true, gestureId: "g1"))
    let relaunched = try rig.relaunch()
    #expect(try rig.outbox() == ["g1/0 ready"])
    #expect(try relaunched.undo("g1") == false)
  }

  // A first launch mints the guard and re-identifies nothing; a copy that differs re-identifies every replica, and the
  // instance's new actor stamps what it commits next.
  @Test func theForkGuardIsKeptAtFirstStartAndACopyThatDiffersReidentifies() throws {
    let rig = try Rig(account: "A")
    let replica = try rig.meta().replica
    let kept = try rig.store.read { try $0.deviceMeta()?.meta.forkGuard }
    #expect(kept != nil)
    #expect(rig.forkGuard.load() == kept)
    let first = try rig.commit(Gesture(changes: [Rig.card("card0001", "One")])).stamp.actor
    _ = try rig.relaunch()
    #expect(try rig.meta().replica == replica)
    rig.forkGuard.save("fg_of-the-device-this-was-cloned-from")
    let relaunched = try rig.relaunch()
    #expect(try rig.meta().replica != replica)
    #expect(rig.forkGuard.load() == (try rig.store.read { try $0.deviceMeta()?.meta.forkGuard }))
    #expect(rig.forkGuard.load() != kept)
    guard case .committed(let receipt) = try relaunched.commit(Rig.scope, Gesture(changes: [Rig.card("card0002", "Two")])) else {
      throw RigError("the commit was refused")
    }
    #expect(receipt.stamp.actor != first)
  }

  @Test func aBoundReplicaWithNoTokenStartsPaused() throws {
    let rig = try Rig(account: "A", token: nil)
    #expect(try rig.meta().authPaused)
  }

  // Engine start keeps a token only for the account signed in or signing in.
  @Test func engineStartDeletesTheTokensNoSignInNeeds() throws {
    let rig = try Rig(account: "A")
    rig.tokens.save(SessionToken("token-left"), for: "Z")
    _ = try rig.relaunch()
    #expect(rig.tokens.accounts() == ["A"])
  }

  // MARK: §8.2, row by row

  @Test(arguments: ReplicaRow.all)
  func aReplicaMovesAsItsRowSays(_ row: ReplicaRow) async throws {
    let replicas = try await row.run()
    #expect(replicas == row.to, "\(row.from) | \(row.event)")
  }

  // MARK: The corpus's lineage vectors through the engine

  // lineage/signin.json and lineage/signout.json by the engine's own calls: a sign-in over a hello answering the step's
  // `holdsRecords`, completed with its decisions when it names any; a sign-out, offline so its flush sends nothing,
  // finished with its choice, or kept when nothing is unsent, as a product with no confirmation to show does; the discard
  // of the dormant replica the step names. The engine's hello takes an offset sample (§10.4), which the corpus's step does
  // not, so each replica's offset fields are compared apart; the rest of the store is compared whole. The anonCount vector
  // reads a planner the engine only answers through a sign-in, so it runs on the planners and the store alone.
  @Test(arguments: try Self.lineageVectors())
  func aLineageVectorThroughTheEngine(_ vector: CorpusVector) async throws {
    let forkGuard = "fg_00000000000000000000000000000000"
    let given = try LoadedDevice(json: vector.input.member("device"), registry: Rig.probe)
    let store = try Store.inMemory(
      holding: LoadedDevice(meta: DeviceMeta(forkGuard: forkGuard, pendingSignIn: given.meta.pendingSignIn), active: given.active,
                            replicas: given.replicas), registry: Rig.probe)
    let signedIn = given.replicas.filter { $0.meta.state == .bound }.compactMap(\.meta.account)
    let transport = ScriptedTransport()
    let clock = SimClock(wallMs: 0)
    let ended = EventLog()
    let engine = try SyncEngine(
      config: EngineConfig(appVersion: "1", surface: .ios, drivesLoops: false), bindings: [], store: store, transport: transport,
      tokens: InMemoryTokenStore(Dictionary(uniqueKeysWithValues: signedIn.map { ($0, SessionToken("token-\($0)")) })),
      forkGuard: InMemoryForkGuardStore(forkGuard), clock: clock.engineClock, random: SeededRandomSource(seed: 1),
      identities: try QueuedIdentities(["ids": vector.input["ids"] ?? [], "actors": [.string(ClientSteps.actor)]]),
      connectivity: SwitchedConnectivity(online: false), tap: { ended.append($0) })

    var returns: [JSON] = []
    for step in try vector.input.member("steps").asArray() {
      clock.advance(ms: (try step["deviceNow"]?.asInteger() ?? clock.nowMs()) - clock.nowMs())
      switch try step.member("op").asString() {
      case "signIn":
        let account = try step.member("account").asString()
        transport.willAnswerHello(200, Self.hello(holds: try JSON.map(step["holdsRecords"]) { try $0.asBool() }))
        let pending = try store.read { try $0.deviceMeta()?.meta.pendingSignIn }
        let session = try await pending == account ? engine.resumeSignIn()! : engine.signIn(account: account, token: SessionToken("t"))
        let answers = try JSON.map(step["decisions"]) { LineageAnswer(rawValue: try $0.asString())! }
        if !answers.isEmpty { try await session.complete(answers) }
        returns.append(ClientSteps.json(SignIn(complete: session.isComplete, due: session.decisions, localIds: [])))
      case "signOut":
        let session = try await engine.signOut()
        let choice = try step["choice"].map { SignOutChoice(rawValue: try $0.asString())! } ?? (session.unsent == 0 ? .keep : nil)
        if let choice { try await session.finish(choice) }
        returns.append(ClientSteps.json(SignOut(complete: choice != nil, ready: session.ready, sent: session.sent, localIds: [])))
      case "discardUnsent":
        let replica = try step.member("replica").asString()
        #expect(try engine.discardDormant(account: #require(try store.read { try $0.replica(replica)?.meta.account })))
        returns.append(.null)
      case let op:
        throw RigError("the engine runner does not drive \(op)")
      }
    }
    let expect = vector.expect
    #expect(JSON.array(returns) == (try expect.member("returns")), "\(vector)")
    let held = try Self.withoutOffsets(store.read { try $0.device(rows: true).json }, forkGuard: forkGuard)
    #expect(held == (try Self.withoutOffsets(expect.member("device"), forkGuard: forkGuard)), "\(vector)")
    #expect(JSON.array(ended.events.filter { !$0.isTelemetry }.map(\.json)) == (try expect.member("ended")), "\(vector)")
  }

  static func lineageVectors() throws -> [CorpusVector] {
    try Corpus.files().filter { ["lineage/signin.json", "lineage/signout.json"].contains($0.path) }.flatMap(Corpus.vectors(in:))
      .filter { vector in try vector.input.member("steps").asArray().allSatisfy { $0["op"] != "anonCount" } }
  }

  // A device as the corpus writes it, with the fork guard it was given and every replica's offset fields left out.
  static func withoutOffsets(_ device: JSON, forkGuard: String) throws -> JSON {
    var object = try device.asObject()
    var meta = try object["meta"]?.asObject() ?? [:]
    if meta["forkGuard"] == .string(forkGuard) { meta["forkGuard"] = nil }
    object["meta"] = meta.members.isEmpty ? nil : .object(meta)
    object["replicas"] = .array(try object.member("replicas").asArray().map { replica in
      var replica = try replica.asObject()
      var meta = try replica.member("meta").asObject()
      meta["serverOffsetMs"] = nil
      meta["offsetSamples"] = nil
      meta["clockReading"] = nil
      replica["meta"] = .object(meta)
      return .object(replica)
    })
    return .object(object)
  }

  // MARK: Sign-in (§7.10)

  // A signed-out decision is due while the account holds records and work made signed out waits: nothing is sent and no
  // replica changes until it is answered. A cancelled sign-in stays pending, and the next engine start resumes it with a
  // new hello; when the account holds no records by then, the work joins it without asking.
  @Test func anUnansweredSignInWaitsSendsNothingAndResumesAtTheNextStart() async throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "Offline")]))
    let session = try await rig.signIn("A", holds: ["probe": true])
    #expect(session.decisions == [SignedOutDecision(product: "probe", counts: ["card": 1])])
    #expect(!session.isComplete)
    #expect(await rig.engine.sender.step() == .idle)
    session.cancel()
    await #expect(throws: EngineError.signInEnded) { try await session.complete(["probe": .add]) }
    #expect(try rig.replicas() == ["anon active entries: 1 new id"])
    #expect(try rig.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == "A")

    let relaunched = try rig.relaunch()
    rig.transport.willAnswerHello(200, Self.hello(holds: ["probe": true]))
    await relaunched.start()
    #expect(try rig.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == "A")
    rig.transport.willAnswerHello(200, Self.hello(holds: ["probe": false]))
    let resumed = try #require(try await relaunched.resumeSignIn())
    #expect(resumed.isComplete)
    #expect(resumed.decisions == [])
    #expect(try rig.replicas() == ["bound(A) active entries: 1 new id"])
    #expect(try rig.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == nil)
    #expect(try await relaunched.resumeSignIn() == nil)
    #expect(rig.transport.calls.filter { if case .hello = $0 { true } else { false } }.count == 3)
  }

  // Answers count for the work the person was shown: a decision left unanswered throws, and work made signed out while
  // the question was up changes it, so the answer changes nothing and the question is asked again. The count alone does
  // not say so: an edit of the card shown leaves it as it was.
  @Test func anAnswerCountsOnlyForTheWorkThePersonWasShown() async throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "Shown")]))
    let session = try await rig.signIn("A", holds: ["probe": true])
    await #expect(throws: EngineError.decisionMissing(product: "probe")) { try await session.complete([:]) }
    try rig.commit(Gesture(changes: [.update("card", "card0001", ["title": "Edited, never shown"])]))
    await #expect(throws: EngineError.signInChanged) { try await session.complete(["probe": .discard]) }
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Also new")]))
    await #expect(throws: EngineError.signInChanged) { try await session.complete(["probe": .discard]) }
    #expect(try rig.replicas() == ["anon active entries: 3 new id"])
    #expect(try rig.store.read { try $0.deviceMeta()?.meta.pendingSignIn } == "A")

    rig.transport.willAnswerHello(200, Self.hello(holds: ["probe": true]))
    let asked = try #require(try await rig.engine.resumeSignIn())
    #expect(asked.decisions == [SignedOutDecision(product: "probe", counts: ["card": 2])])
    try await asked.complete(["probe": .discard])
    #expect(asked.isComplete)
    try await asked.complete(["probe": .add])
    #expect(try rig.replicas() == ["anon entries: 0 new id", "bound(A) active entries: 0 new id"])
  }

  // A sign-in replaced by another ends: the first one's answers change nothing.
  @Test func aSignInAnotherReplacedEnds() async throws {
    let rig = try Rig()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "Offline")]))
    let first = try await rig.signIn("A", holds: ["probe": true])
    let second = try await rig.signIn("B", holds: ["probe": true])
    await #expect(throws: EngineError.signInEnded) { try await first.complete(["probe": .add]) }
    try await second.complete(["probe": .add])
    #expect(try rig.replicas() == ["bound(B) active entries: 1 new id"])
  }

  // §7.10 account change: another account signs in only once the one signed in has signed out. The same account signing
  // in again is re-authentication, with no hello and no question.
  @Test func anotherAccountSignsInOnlyAfterTheFirstSignsOut() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
    rig.transport.willAnswerPush(401, Rig.failure("unauthenticated"))
    #expect(await rig.engine.sender.step() == .paused)
    await #expect(throws: EngineError.signedIn(account: "A")) { try await rig.signIn("B", holds: ["probe": false]) }

    let again = try await rig.engine.signIn(account: "A", token: SessionToken("token-2"))
    #expect(again.isComplete)
    #expect(try rig.meta().authPaused == false)
    #expect(rig.tokens.token(for: "A") == SessionToken("token-2"))

    rig.connectivity.set(online: false)
    try await rig.engine.signOut().finish(.keep)
    rig.connectivity.set(online: true)
    let other = try await rig.signIn("B", holds: ["probe": false])
    #expect(other.isComplete)
    #expect(try rig.replicas().map { $0.replacingOccurrences(of: " new id", with: "") } == [
      "anon entries: 0", "bound(B) active entries: 0", "dormant(A) entries: 1",
    ])
    #expect(rig.transport.calls.filter { if case .hello = $0 { true } else { false } }.count == 1)
  }

  // MARK: Sign-out (§7.10)

  // The flush runs for at most SIGNOUT_FLUSH_MS; then the sender holds the replica, so nothing more is numbered and the
  // count stays true. The push still in flight is abandoned: its answer, when it comes, is recorded. Keep leaves the
  // unsent dormant, and the account's token leaves the device.
  @Test func signOutFlushesForItsWindowThenHoldsTheReplica() async throws {
    let rig = try Rig(account: "A")
    let before = try rig.replicaIDs()
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1"))
    let gate = Gate()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]), after: gate)
    async let signingOut = rig.engine.signOut()
    await gate.arrival()
    await rig.clock.asleep(until: Constants.signoutFlushMs)
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], gestureId: "g2"))
    rig.clock.advance(ms: Constants.signoutFlushMs)
    let session = try await signingOut
    #expect((session.ready, session.sent) == (1, 1))

    gate.open()
    #expect(await rig.engine.sender.step() == .idle)
    #expect(rig.transport.pushes.count == 1)
    #expect(try rig.outbox() == ["g1/0 acked 1", "g2/0 ready"])

    try await session.finish(.keep)
    #expect(try rig.replicas(since: before) == ["anon active entries: 0", "dormant(A) entries: 1"])
    #expect(try rig.engine.dormantReplicas() == [DormantReplica(account: "A", ready: 1, sent: 0)])
    #expect(rig.tokens.token(for: "A") == nil)
    #expect(try rig.engine.discardDormant(account: "Z") == false)
  }

  // Cancel keeps the account signed in, and the sender sends again. An acked entry stays until the pull that brings its
  // row, so its record stays in view.
  @Test func aCancelledSignOutSendsAgain() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Gesture(changes: [Rig.card("card0000", "Zero")], gestureId: "g0"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
    #expect(await rig.engine.sender.step() == .again)
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1"))
    let session = try await rig.engine.signOut()
    #expect((session.ready, session.sent) == (0, 1))
    #expect(await rig.engine.sender.step() == .idle)
    await session.cancel()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 2, [Rig.admitted(2, seq: 2)]))
    #expect(await rig.engine.sender.step() == .again)
    #expect(try rig.outbox() == ["g0/0 acked 1", "g1/0 acked 2"])
    #expect(try rig.engine.read(Rig.scope) { try $0.drawn("card") }.map(\.values) == [["title": "Zero"], ["title": "One"]])
    #expect(try rig.replicas() == ["anon entries: 0 new id", "bound(A) active entries: 2 new id"])
    #expect(rig.tokens.token(for: "A") != nil)
  }

  // Discard deletes none but the entries the confirmation stated, whatever the count: here the push in flight lands and
  // new work is committed while the confirmation is up, so the count is as it was and the work is not. Keep, which
  // loses nothing, still goes.
  @Test func discardDeletesNoneButTheEntriesTheConfirmationStated() async throws {
    let rig = try Rig(account: "A")
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1"))
    let gate = Gate()
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]), after: gate)
    async let signingOut = rig.engine.signOut()
    await gate.arrival()
    await rig.clock.asleep(until: Constants.signoutFlushMs)
    rig.clock.advance(ms: Constants.signoutFlushMs)
    let session = try await signingOut
    #expect((session.ready, session.sent) == (0, 1))
    gate.open()
    #expect(await rig.engine.sender.step() == .idle)
    try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")], gestureId: "g2"))

    await #expect(throws: EngineError.signOutChanged(ready: 1, sent: 0)) { try await session.finish(.discard) }
    #expect(try rig.outbox() == ["g1/0 acked 1", "g2/0 ready"])
    #expect(try rig.replicas() == ["anon entries: 0 new id", "bound(A) active entries: 2 new id"])
    #expect(rig.tokens.token(for: "A") != nil)
    try await session.finish(.keep)
    #expect(try rig.engine.dormantReplicas() == [DormantReplica(account: "A", ready: 1, sent: 0)])
  }

  // A sign-out is answered once: a finished one ends, and so does one another sign-out replaced, whose cancel then
  // leaves the newer one's hold alone. None of them acts on the account once it has signed in again.
  @Test func aSignOutIsAnsweredOnce() async throws {
    let rig = try Rig(account: "A")
    rig.connectivity.set(online: false)
    try rig.commit(Gesture(changes: [Rig.card("card0001", "One")], gestureId: "g1"))
    let replaced = try await rig.engine.signOut()
    let current = try await rig.engine.signOut()
    await replaced.cancel()
    #expect(await rig.engine.sender.isHolding(current.hold))
    await #expect(throws: EngineError.signOutEnded) { try await replaced.finish(.discard) }
    try await current.finish(.keep)
    await #expect(throws: EngineError.signOutEnded) { try await current.finish(.discard) }

    rig.connectivity.set(online: true)
    #expect(try await rig.signIn("A", holds: ["probe": true]).isComplete)
    await #expect(throws: EngineError.signOutEnded) { try await current.finish(.discard) }
    await current.cancel()
    #expect(try rig.replicas() == ["anon entries: 0 new id", "bound(A) active entries: 1 new id"])
    #expect(try rig.outbox() == ["g1/0 ready"])
  }

  // Each lifecycle step that can change the replica the products write to asks the bindings first (Coach D-10): here the
  // question, its answer, a sign-in resumed after a cancel, and a sign-out's start and its end.
  @Test func everySeatChangeIsAnnouncedToTheProducts() async throws {
    let seats = SeatChanges()
    let rig = try Rig(bindings: [seats])
    try rig.commit(Gesture(changes: [Rig.card("card0001", "Offline")]))
    let session = try await rig.signIn("A", holds: ["probe": true])
    #expect(seats.count == 1)
    session.cancel()
    rig.transport.willAnswerHello(200, Self.hello(holds: ["probe": true]))
    let resumed = try #require(try await rig.engine.resumeSignIn())
    #expect(seats.count == 2)
    try await resumed.complete(["probe": .add])
    #expect(seats.count == 3)
    rig.connectivity.set(online: false)
    let signingOut = try await rig.engine.signOut()
    #expect(seats.count == 4)
    try await signingOut.finish(.keep)
    #expect(seats.count == 5)
    #expect(try rig.replicas() == ["anon active entries: 0 new id", "dormant(A) entries: 1 new id"])
  }

  // Accounts are the same only byte for byte (§9.1).
  @Test func lookAlikeAccountsAreTwoAccounts() {
    #expect(DormantReplica(account: "caf\u{E9}", ready: 1, sent: 0) != DormantReplica(account: "cafe\u{301}", ready: 1, sent: 0))
    #expect(Set([DormantReplica(account: "caf\u{E9}", ready: 1, sent: 0), DormantReplica(account: "cafe\u{301}", ready: 1, sent: 0)]).count == 2)
    #expect(EngineError.signedIn(account: "caf\u{E9}") != EngineError.signedIn(account: "cafe\u{301}"))
    #expect(EngineError.decisionMissing(product: "caf\u{E9}") != EngineError.decisionMissing(product: "cafe\u{301}"))
  }

  // MARK: Two devices meet at a sign-in

  // A phone works signed out and signs in to an account whose other device already holds records: the decision is
  // surfaced and nothing is sent until it is answered. Add lands the phone's work on the other device; Discard leaves the
  // other device and the server as they were.
  @Test(arguments: [LineageAnswer.add, .discard])
  func workMadeSignedOutMeetsAnAccountThatHoldsRecords(_ answer: LineageAnswer) async throws {
    let clock = SimClock(wallMs: Rig.startMs)
    let network = SyncEngineTests.network(clock)
    let other = try SyncEngineTests.device(on: network, clock: clock, seed: 2)
    _ = try other.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card000b", "From other")]))
    await Self.settle([other.engine])
    let phone = try SyncEngine(
      config: EngineConfig(appVersion: "1.0", surface: .ios, drivesLoops: false), store: Store.inMemory(registry: Rig.probe),
      transport: network, tokens: InMemoryTokenStore(), forkGuard: InMemoryForkGuardStore(), clock: clock.engineClock,
      random: SeededRandomSource(seed: 1), connectivity: SwitchedConnectivity())
    _ = try phone.commit(Rig.scope, Gesture(changes: [Rig.card("card000p", "From phone")]))
    let before = (other: try Self.withoutOffsets(other.store.read { try $0.device(rows: true).json }, forkGuard: ""),
                  server: Self.rows(of: "A", on: network))

    let session = try await phone.signIn(account: "A", token: network.token(for: "A"))
    #expect(session.decisions == [SignedOutDecision(product: "probe", counts: ["card": 1])])
    await Self.settle([phone, other.engine])
    #expect(Self.rows(of: "A", on: network) == before.server)
    try await session.complete(["probe": answer])
    await Self.settle([phone, other.engine])

    let server = Self.rows(of: "A", on: network)
    let titles = server.map { $0.lattice.fields["title"]?.value }
    #expect(titles == (answer == .add ? ["From other", "From phone"] : ["From other"]))
    for engine in [phone, other.engine] {
      #expect(try engine.read(Rig.scope) { try $0.stored("card") }.map(\.values) == titles.map { ["title": $0!] })
    }
    if answer == .discard {
      #expect(server == before.server)
      #expect(try Self.withoutOffsets(other.store.read { try $0.device(rows: true).json }, forkGuard: "") == before.other)
    }
  }

  // MARK: A kill at every step

  // Each scenario is run once to learn its crash points and the store after each commit; then once per point, killed
  // there: the store reopens holding exactly what committed, and the app's resumption reaches the unkilled ending.
  @Test(arguments: KillScenario.allCases)
  func aKillAtAnyStepReopensToWhatCommittedAndResumes(_ scenario: KillScenario) async throws {
    let world = try await World(scenario)
    try world.phone.killer.begin(killingAt: nil, store: world.phone.store)
    try await scenario.act(world)
    let recorded = world.phone.killer.recorded
    world.phone.killer.end()
    #expect(recorded.points.count >= 4, "\(scenario)")
    #expect(recorded.states.count == recorded.points.count / 2 + 1, "\(scenario): every commit is its own transaction")
    try await scenario.resume(world)
    try scenario.check(world)

    for point in recorded.points.indices {
      let world = try await World(scenario)
      try world.phone.killer.begin(killingAt: point, store: world.phone.store)
      do {
        try await scenario.act(world)
      } catch {}
      #expect(world.phone.killer.isDead, "\(scenario): killed at \(recorded.points[point])")
      #expect(try world.phone.dump() == recorded.states[(point + 1) / 2], "\(scenario): killed at \(recorded.points[point])")
      world.phone.killer.end()
      try await scenario.resume(world)
      try scenario.check(world)
    }
  }

  // MARK: Helpers

  static func hello(holds: [String: Bool]?) -> JSON {
    var body: JSON.Object = ["serverTime": JSON(Rig.startMs), "epoch": "ep-1", "schema": 1, "minSchema": 1]
    body["holdsRecords"] = holds.map { .object(JSON.Object(uniqueKeysWithValues: $0.map { ($0.key, .bool($0.value)) })) }
    return .object(body)
  }

  // Each engine's sender, then its puller for every scope, until neither has anything left to do; twice round, so each
  // device sees what the others sent.
  static func settle(_ engines: [SyncEngine]) async {
    for _ in 0..<2 {
      for engine in engines {
        while await engine.sender.step() == .again {}
        engine.puller.wants.all()
        pulling: while true {
          switch await engine.puller.step() {
          case .pulled, .again, .frame: continue
          default: break pulling
          }
        }
      }
    }
  }

  // The server's rows of `account`'s probe scope, in record order.
  static func rows(of account: String, on network: SimNetwork) -> [Row] {
    (network.server.state.rows[ScopeKey(.product(account: account, name: "probe"))] ?? [:]).values.sorted { $0.key < $1.key }
  }
}

// A product that counts the seat changes the engine announces.
final class SeatChanges: ProductBinding {
  let product = "probe"
  let calls = Mutex(0)

  func seatWillChange() async {
    calls.withLock { $0 += 1 }
  }

  var count: Int { calls.withLock { $0 } }
}

extension Rig {
  // A sign-in as `account` over a hello saying in which products it holds records.
  func signIn(_ account: String, holds: [String: Bool]) async throws -> SignInSession {
    transport.willAnswerHello(200, LifecycleTests.hello(holds: holds))
    return try await engine.signIn(account: account, token: SessionToken("token-\(account)"))
  }

  // Every replica of the device, one line each: its state and account, its entries, and whether it is the active one,
  // is paused, or has an id outside `before`.
  func replicas(since before: Set<String> = []) throws -> [String] {
    let device = try store.read { try $0.device() }
    return device.replicas.map { replica in
      let meta = replica.meta
      var line = meta.account.map { "\(meta.state.rawValue)(\($0))" } ?? meta.state.rawValue
      if replica.id == device.active { line += " active" }
      line += " entries: \(replica.outbox.count)"
      if meta.authPaused { line += " paused" }
      if !before.contains(replica.id) { line += " new id" }
      return line
    }.sorted()
  }

  func replicaIDs() throws -> Set<String> {
    Set(try store.read { try $0.replicaIDs() })
  }
}

// MARK: - §8.2 as a table

// One row of §8.2: its from, event and to as the spec writes them, and a run through the engine whose replicas, one line
// each (`Rig.replicas`), are the row's `to`. "new id" marks a replica whose id the event minted.
struct ReplicaRow: Sendable, CustomTestStringConvertible {
  let from: String
  let event: String
  let to: [String]
  let run: @Sendable () async throws -> [String]

  var testDescription: String { "\(from) | \(event)" }

  // A device bound to `account` that signed out keeping one unsent entry, the anon replica now active.
  static func dormant(_ account: String) async throws -> Rig {
    let rig = try Rig(account: account)
    rig.connectivity.set(online: false)
    try rig.commit(Gesture(changes: [Rig.card("card000\(account.lowercased())", "Kept")]))
    try await rig.engine.signOut().finish(.keep)
    rig.connectivity.set(online: true)
    return rig
  }

  // A bound replica of A whose push the server answers with `error` at 409.
  static func conflict(_ error: String) -> ReplicaRow {
    ReplicaRow(from: "any", event: error, to: ["anon entries: 0", "bound(A) active entries: 1 new id"]) {
      let rig = try Rig(account: "A")
      try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
      let before = try rig.replicaIDs()
      rig.transport.willAnswerPush(409, Rig.failure(error))
      _ = await rig.engine.sender.step()
      return try rig.replicas(since: before)
    }
  }

  static let all: [ReplicaRow] = [
    ReplicaRow(from: "—", event: "first launch", to: ["anon active entries: 0 new id"]) {
      try Rig().replicas()
    },
    ReplicaRow(from: "—", event: "sign-in as A, no dormant(A) and no rebound anon",
               to: ["anon entries: 0", "bound(A) active entries: 0 new id"]) {
      let rig = try Rig()
      let before = try rig.replicaIDs()
      _ = try await rig.signIn("A", holds: ["probe": true])
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "dormant(A)", event: "sign-in as A", to: ["anon entries: 0", "bound(A) active entries: 1"]) {
      let rig = try await dormant("A")
      let before = try rig.replicaIDs()
      _ = try await rig.signIn("A", holds: ["probe": true])
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "dormant(B)", event: "sign-in as A",
               to: ["anon entries: 0", "bound(A) active entries: 0 new id", "dormant(B) entries: 1"]) {
      let rig = try await dormant("B")
      let before = try rig.replicaIDs()
      _ = try await rig.signIn("A", holds: ["probe": false])
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "anon, entries left after discards", event: "sign-in as A, no dormant(A)",
               to: ["bound(A) active entries: 1"]) {
      let rig = try Rig()
      try rig.commit(Gesture(changes: [Rig.card("card0001", "Offline")]))
      let before = try rig.replicaIDs()
      _ = try await rig.signIn("A", holds: ["probe": false])
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "anon, entries left after discards", event: "sign-in as A with a dormant(A)",
               to: ["bound(A) active entries: 2"]) {
      let rig = try await dormant("A")
      try rig.commit(Gesture(changes: [Rig.card("card0002", "Offline")]))
      let before = try rig.replicaIDs()
      try await rig.signIn("A", holds: ["probe": true]).complete(["probe": .add])
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "anon, no entries left", event: "sign-in", to: ["anon entries: 0", "bound(A) active entries: 0 new id"]) {
      let rig = try Rig()
      try rig.commit(Gesture(changes: [Rig.card("card0001", "Offline")]))
      let before = try rig.replicaIDs()
      try await rig.signIn("A", holds: ["probe": true]).complete(["probe": .discard])
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "anon", event: "sign-in as A with a decision still due, or cancelled", to: ["anon active entries: 1"]) {
      let rig = try Rig()
      try rig.commit(Gesture(changes: [Rig.card("card0001", "Offline")]))
      let before = try rig.replicaIDs()
      try await rig.signIn("A", holds: ["probe": true]).cancel()
      #expect(await rig.engine.sender.step() == .idle)
      #expect(rig.transport.pushes.isEmpty)
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "bound(A)", event: "sign-out, empty outbox", to: ["anon active entries: 0", "dormant(A) entries: 0"]) {
      let rig = try Rig(account: "A")
      let before = try rig.replicaIDs()
      let session = try await rig.engine.signOut()
      #expect(session.unsent == 0)
      try await session.finish(.discard)
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "bound(A)", event: "sign-out, Keep", to: ["anon active entries: 0", "dormant(A) entries: 1"]) {
      let rig = try Rig(account: "A")
      rig.connectivity.set(online: false)
      try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
      let before = try rig.replicaIDs()
      try await rig.engine.signOut().finish(.keep)
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "bound(A)", event: "sign-out, Discard", to: ["anon active entries: 0"]) {
      let rig = try Rig(account: "A")
      rig.connectivity.set(online: false)
      try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
      let before = try rig.replicaIDs()
      try await rig.engine.signOut().finish(.discard)
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "bound(A)", event: "401 / re-authentication as A",
               to: ["anon entries: 0", "bound(A) active entries: 1 paused", "anon entries: 0", "bound(A) active entries: 1"]) {
      let rig = try Rig(account: "A")
      try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
      let before = try rig.replicaIDs()
      rig.transport.willAnswerPush(401, Rig.failure("unauthenticated"))
      _ = await rig.engine.sender.step()
      let paused = try rig.replicas(since: before)
      try rig.engine.reauthenticate(token: SessionToken("token-2"))
      return try paused + rig.replicas(since: before)
    },
    ReplicaRow(from: "dormant", event: "explicit discard", to: ["anon active entries: 0"]) {
      let rig = try await dormant("A")
      let before = try rig.replicaIDs()
      try rig.engine.discardDormant(account: "A")
      return try rig.replicas(since: before)
    },
    ReplicaRow(from: "any", event: "fork guard",
               to: ["anon entries: 0 new id", "bound(A) active entries: 0 new id", "dormant(B) entries: 1 new id"]) {
      let rig = try await dormant("B")
      _ = try await rig.signIn("A", holds: ["probe": false])
      let before = try rig.replicaIDs()
      rig.forkGuard.save("fg_of-the-device-this-was-cloned-from")
      _ = try rig.relaunch()
      return try rig.replicas(since: before)
    },
    conflict("replica-forked"),
    conflict("replica-foreign"),
    conflict("gap"),
    ReplicaRow(from: "any", event: "epoch change", to: ["anon entries: 0", "bound(A) active entries: 2 new id"]) {
      let rig = try Rig(account: "A")
      try rig.commit(Gesture(changes: [Rig.card("card0001", "One")]))
      rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 1)]))
      _ = await rig.engine.sender.step()
      try rig.commit(Gesture(changes: [Rig.card("card0002", "Two")]))
      let before = try rig.replicaIDs()
      rig.transport.willAnswerPush(200, Rig.ok(lastN: 2, [Rig.admitted(2, seq: 2)], epoch: "ep-2"))
      _ = await rig.engine.sender.step()
      return try rig.replicas(since: before)
    },
  ]
}

// MARK: - Kill at every step

// The kill-at-every-step hook (design §9.5) over one store. Once begun, the crash points the store reaches are counted
// from 0; the one armed kills the process, and so does every later one, since a dead process commits nothing more.
// Begun unarmed, it records the store after every commit.
final class Killer: Sendable {
  struct Killed: Error {}

  struct State {
    var store: Store?
    var armed: Int?
    var dead = false
    var points: [CrashPoint] = []
    var states: [JSON] = []
  }

  let state = Mutex(State())

  var crashPoints: CrashPoints { CrashPoints { [self] point in try hit(point) } }

  func begin(killingAt point: Int?, store: Store) throws {
    let now = try store.read { try $0.device(rows: true).json }
    state.withLock { $0 = State(store: store, armed: point, states: [now]) }
  }

  func end() {
    state.withLock { $0 = State() }
  }

  var isDead: Bool { state.withLock(\.dead) }
  var recorded: (points: [CrashPoint], states: [JSON]) { state.withLock { ($0.points, $0.states) } }

  func hit(_ point: CrashPoint) throws {
    let (kill, recording) = state.withLock { state -> (Bool, Store?) in
      guard let store = state.store else { return (false, nil) }
      if state.dead { return (true, nil) }
      state.points.append(point)
      if state.armed == state.points.count - 1 {
        state.dead = true
        return (true, nil)
      }
      guard state.armed == nil, case .afterCommit = point else { return (false, nil) }
      return (false, store)
    }
    if kill { throw Killed() }
    if let recording {
      let now = try recording.read { try $0.device(rows: true).json }
      state.withLock { $0.states.append(now) }
    }
  }
}

// A phone whose store outlives its engines, as its files would, beside its keychain and the fork guard's copy.
final class Phone {
  let killer = Killer()
  let store: Store
  let network: SimNetwork
  let clock: SimClock
  let tokens = InMemoryTokenStore()
  let connectivity = SwitchedConnectivity()
  var forkGuard = InMemoryForkGuardStore()
  var launches: UInt64 = 0
  var engine: SyncEngine

  // `account`: a replica bound to it before the first launch.
  init(on network: SimNetwork, clock: SimClock, account: String?) throws {
    self.network = network
    self.clock = clock
    store = try Store.inMemory(registry: Rig.probe, crashPoints: killer.crashPoints)
    if let account {
      let identities = Identities(random: SeededRandomSource(seed: 11))
      _ = try store.firstLaunch(identities: identities)
      _ = try store.signIn(account: account, holdsRecords: [:], decisions: [:], identities: identities)
      tokens.save(network.token(for: account), for: account)
    }
    engine = try Phone.engine(store: store, network: network, clock: clock, tokens: tokens, forkGuard: forkGuard,
                              connectivity: connectivity, seed: 1)
  }

  static func engine(store: Store, network: SimNetwork, clock: SimClock, tokens: InMemoryTokenStore, forkGuard: InMemoryForkGuardStore,
                     connectivity: SwitchedConnectivity, seed: UInt64) throws -> SyncEngine {
    try SyncEngine(
      config: EngineConfig(appVersion: "1.0", surface: .ios, drivesLoops: false), store: store, transport: network, tokens: tokens,
      forkGuard: forkGuard, clock: clock.engineClock, random: SeededRandomSource(seed: seed), connectivity: connectivity)
  }

  // Another process over the same files.
  func relaunch() throws {
    launches += 1
    engine = try Phone.engine(store: store, network: network, clock: clock, tokens: tokens, forkGuard: forkGuard,
                              connectivity: connectivity, seed: 1 + 100 * launches)
  }

  func dump() throws -> JSON {
    try store.read { try $0.device(rows: true).json }
  }

  func active() throws -> LoadedReplica {
    try store.read { try $0.device(rows: true).activeReplica }
  }

  func signIn(_ answer: LineageAnswer) async throws {
    let session = try await engine.signIn(account: "A", token: network.token(for: "A"))
    if !session.isComplete { try await session.complete(["probe": answer]) }
  }
}

// One kill scenario's world: a server holding account A, another device of A, and the phone the kills land on.
final class World {
  let clock = SimClock(wallMs: Rig.startMs)
  let network: SimNetwork
  let other: SyncEngineTests.Device
  let phone: Phone
  var original = ""

  init(_ scenario: KillScenario) async throws {
    network = SyncEngineTests.network(clock)
    other = try SyncEngineTests.device(on: network, clock: clock, seed: 2)
    _ = try other.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card000b", "From other")]))
    await LifecycleTests.settle([other.engine])
    phone = try Phone(on: network, clock: clock, account: scenario.signsIn ? nil : "A")
    if scenario.signsIn {
      _ = try phone.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card000p", "From phone")]))
      return
    }
    _ = try phone.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card000s", "Sent before")]))
    await LifecycleTests.settle([phone.engine])
    phone.connectivity.set(online: false)
    _ = try phone.engine.commit(Rig.scope, Gesture(changes: [Rig.card("card000u", "Unsent")]))
    original = try phone.active().id
  }
}

enum KillScenario: String, CaseIterable, CustomTestStringConvertible {
  case signInAdd, signInDiscard, signOutKeep, signOutDiscard, forkGuard

  var testDescription: String { rawValue }

  var signsIn: Bool { self == .signInAdd || self == .signInDiscard }

  // The steps the kills land on.
  func act(_ world: World) async throws {
    let phone = world.phone
    switch self {
    case .signInAdd, .signInDiscard:
      try await phone.signIn(self == .signInAdd ? .add : .discard)
      _ = await phone.engine.sender.step()
      phone.engine.puller.wants.all()
      _ = await phone.engine.puller.step()
    case .signOutKeep, .signOutDiscard:
      try await phone.engine.signOut().finish(self == .signOutKeep ? .keep : .discard)
    case .forkGuard:
      phone.forkGuard = InMemoryForkGuardStore()
      try phone.relaunch()
    }
  }

  // What the app does in the process after: the engine starts, a sign-in still pending is answered as before, and one or a
  // sign-out that never began is made again; the phone signed out signs in again as A; then everything syncs.
  func resume(_ world: World) async throws {
    let phone = world.phone
    try phone.relaunch()
    await phone.engine.start()
    switch self {
    case .signInAdd, .signInDiscard:
      if let pending = try await phone.engine.resumeSignIn() {
        try await pending.complete(["probe": self == .signInAdd ? .add : .discard])
      } else if try phone.active().meta.state == .anon {
        try await phone.signIn(self == .signInAdd ? .add : .discard)
      }
    case .signOutKeep, .signOutDiscard:
      if try phone.active().meta.state == .bound {
        try await phone.engine.signOut().finish(self == .signOutKeep ? .keep : .discard)
      }
      #expect(phone.tokens.accounts() == [], "\(self): the token leaves with the account")
      #expect(try phone.engine.dormantReplicas().map(\.account) == (self == .signOutKeep ? ["A"] : []), "\(self)")
      phone.connectivity.set(online: true)
      try await phone.signIn(.add)
    case .forkGuard:
      phone.connectivity.set(online: true)
    }
    await LifecycleTests.settle([phone.engine, world.other.engine])
  }

  // The ending every kill must reach: the server holds A's records, each once, and both devices hold exactly them, the
  // phone bound to A with nothing left to send.
  func check(_ world: World) throws {
    let expected: [JSON?] = switch self {
    case .signInAdd: ["From other", "From phone"]
    case .signInDiscard: ["From other"]
    case .signOutKeep, .forkGuard: ["From other", "Sent before", "Unsent"]
    case .signOutDiscard: ["From other", "Sent before"]
    }
    let server = LifecycleTests.rows(of: "A", on: world.network)
    #expect(server.map { $0.lattice.fields["title"]?.value } == expected, "\(self)")
    let phone = try world.phone.active()
    #expect(phone.meta.state == .bound && phone.meta.account == "A", "\(self)")
    #expect(phone.outbox.isEmpty, "\(self)")
    #expect(phone.confirmed[Rig.scope]?.all == server, "\(self)")
    let other = try world.other.store.read { try $0.device(rows: true).activeReplica }
    #expect(other.confirmed[Rig.scope]?.all == server, "\(self)")
    if self == .forkGuard {
      #expect(phone.id != world.original, "\(self)")
      #expect(world.phone.forkGuard.load() == (try world.phone.store.read { try $0.deviceMeta()?.meta.forkGuard }), "\(self)")
    }
  }
}
