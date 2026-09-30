import SyncAPI
import SyncCore
import SyncModelServer
import SyncReplica
import SyncStore
import SyncTesting
import Testing

// Kill at every step (design §9.5), across every transaction of design §3.5. Each scenario runs once with the kill
// hook counting to learn its crash points and the store after each commit; then once per point, the phone killed
// there: its store holds exactly what committed before the point, and after a new process launches over it and the
// simulation reaches quiescence, every invariant of §11.3 holds. The events of a transaction killed after its commit
// die with the process, so the entries it ended are credited as ended; the store check proves they ended as the
// unkilled run's did.

struct KillEveryStepTests {
  @Test(arguments: KillScenario.allCases)
  func aKillAtAnyStepLeavesWhatCommittedAndLosesNothing(_ scenario: KillScenario) async throws {
    let counted = try await scenario.world()
    counted.killer.begin(killingAt: nil, store: counted.simulator.device(0).store)
    await scenario.act(counted.simulator)
    let recorded = counted.killer.recorded
    counted.killer.end()
    await counted.simulator.quiesce()
    #expect(counted.simulator.check() == [], "\(scenario) with no kill")
    #expect(recorded.points.count >= 4, "\(scenario)")

    for point in recorded.points.indices {
      let world = try await scenario.world()
      world.killer.begin(killingAt: point, store: world.simulator.device(0).store)
      await scenario.act(world.simulator)
      #expect(world.killer.isDead, "\(scenario): killed at \(recorded.points[point])")
      #expect(Killer.dump(world.simulator.device(0).store) == recorded.states[(point + 1) / 2],
              "\(scenario): killed at \(recorded.points[point]), the store holds what committed")
      world.simulator.processDied(on: 0)
      world.killer.end()
      await world.simulator.quiesce()
      #expect(world.simulator.check() == [], "\(scenario): killed at point \(point), \(recorded.points[point])")
    }
  }

  // A commit killed just after its transaction committed is durable though its caller never learned of it: once the
  // process has died it joins the ledger, so its loss would be seen.
  @Test func aCommitKilledAfterItsCommitJoinsTheLedger() async throws {
    let create = Simulator.Action.commit(KillScenario.probe, Gesture(changes: [
      .create("card", id: .given("card0001"), ["title": "Durable", "tier": "draft"]),
    ]))
    let world = try await KillScenario.launch.world()
    world.killer.begin(killingAt: 1, store: world.simulator.device(0).store)
    await world.simulator.perform(create, on: 0)
    #expect(world.killer.recorded.points == [.beforeCommit(.commit), .afterCommit(.commit)])
    let store = world.simulator.device(0).store
    let held = try store.read { tx in try tx.replica(tx.activeReplica())?.outbox.map(\.localId) ?? [] }
    #expect(held.count == 1)
    world.simulator.processDied(on: 0)
    world.killer.end()
    _ = try store.write(.pullPage) { tx in Planned((), ReplicaBatch(writes: [.replica(try tx.activeReplica(), .deleteEntry(held[0]))])) }
    await world.simulator.quiesce()
    #expect(world.simulator.check() == ["INV-3 phone: \(held[0]) never ended"])
  }

  // Between them the scenarios reach every transaction of design §3.5, before its commit and after it.
  @Test func theScenariosReachEveryTransactionOnBothSidesOfItsCommit() async throws {
    var reached: Set<CrashPoint> = []
    for scenario in KillScenario.allCases {
      let world = try await scenario.world()
      world.killer.begin(killingAt: nil, store: world.simulator.device(0).store)
      await scenario.act(world.simulator)
      reached.formUnion(world.killer.recorded.points)
    }
    let every = TxName.allCases.flatMap { [CrashPoint.beforeCommit($0), .afterCommit($0)] }
    #expect(every.filter { !reached.contains($0) } == [])
  }
}

// A phone of account A, which the kills land on, beside another phone of A; what is set up before the kill hook
// begins, and the steps it counts.
enum KillScenario: String, CaseIterable, CustomTestStringConvertible {
  case holdUndoRelease, leaveFlush, refusalFold, joiningWriteMap, clockSkew, epochChange, digestMismatch, signInAdd
  case signInDiscard, signOutKeep, signOutDiscard, dormantDiscard, forkGuard, replicaForked, localRefusals, authPause
  case liveFrame, subscriptions, launch, settling

  typealias Step = (action: Simulator.Action, phone: Int)

  static let probe = ScopeRef.product("probe")
  static let tree = ScopeRef.tree("b_0000000a")
  static let phone = 0
  static let other = 1

  var testDescription: String { rawValue }

  static func card(_ id: String, _ title: String) -> Simulator.Action {
    .commit(probe, Gesture(changes: [.create("card", id: .given(RecordID(id)), ["title": .string(title), "tier": "draft"])]))
  }

  static func edit(_ id: String, _ title: String) -> Simulator.Action {
    .commit(probe, Gesture(changes: [.update("card", RecordID(id), ["title": .string(title)])]))
  }

  static let send = Simulator.Action.send(.deliver, PushFaults())
  static let pull = Simulator.Action.pull(.deliver)

  var signsIn: Bool { self == .signInAdd || self == .signInDiscard }

  func world() async throws -> (simulator: Simulator, killer: Killer) {
    let killer = Killer()
    let simulator = await Simulator(seed: 1, registry: try Corpus.probeRegistry(), phones: [
      .init("phone", account: "A", signedIn: !signsIn, killer: killer),
      .init("other", account: "A", signedIn: true),
    ], faults: false)
    for step in setUp { await simulator.perform(step.action, on: step.phone) }
    return (simulator, killer)
  }

  func act(_ simulator: Simulator) async {
    for step in steps { await simulator.perform(step.action, on: step.phone) }
  }

  // Before the kill hook begins: the other phone's card on the server, and the phone synced with it.
  var setUp: [Step] {
    let shared: [Step] = [(Self.card("card000b", "Other"), Self.other), (Self.send, Self.other), (Self.pull, Self.phone)]
    switch self {
    case .signInAdd, .signInDiscard:
      return shared + [(Self.card("card000p", "Signed out"), Self.phone)]
    case .signOutKeep, .signOutDiscard, .dormantDiscard:
      return shared + [(Self.card("card000s", "Sent"), Self.phone), (Self.send, Self.phone), (.online(false), Self.phone),
                       (Self.card("card000u", "Unsent"), Self.phone)]
    case .joiningWriteMap:
      let start = Gesture(changes: [], command: Command(name: "probe.start", args: ["id": "run000000000000o", "startedAt": 1, "join": true]),
                          predict: [.create("run", id: .given("run000000000000o"), ["startedAt": 1])])
      return shared + [(.commit(Self.probe, start), Self.other), (Self.send, Self.other)]
    case .replicaForked:
      return shared + [(.backupPhone, Self.phone), (Self.card("card000f", "Forgotten"), Self.phone), (Self.send, Self.phone),
                       (.restorePhone(keepingForkGuardCopy: true), Self.phone)]
    case .digestMismatch:
      return shared + [(.corruptDigest, Self.phone)]
    default:
      return shared
    }
  }

  // The steps the kills land on.
  var steps: [Step] {
    switch self {
    case .holdUndoRelease:
      let held = Gesture(changes: [.delete("card", "card000b")], hold: true)
      return [(.commit(Self.probe, held), Self.phone), (.undo, Self.phone), (.commit(Self.probe, held), Self.phone),
              (.advance(ms: Constants.holdMs), Self.phone), (.release, Self.phone), (Self.send, Self.phone), (Self.pull, Self.phone)]
    case .leaveFlush:
      return [(.commit(Self.probe, Gesture(changes: [.delete("card", "card000b")], hold: true)), Self.phone),
              (.leave(flushing: true), Self.phone), (Self.pull, Self.phone)]
    case .refusalFold:
      return [(.refuse(.invalid), Self.phone), (Self.card("card0001", "Refused"), Self.phone), (Self.edit("card0001", "Folded"), Self.phone),
              (Self.card("card0002", "Kept"), Self.phone), (Self.send, Self.phone), (.dismissNotice, Self.phone), (Self.pull, Self.phone)]
    case .joiningWriteMap:
      let start = Gesture(changes: [], command: Command(name: "probe.start", args: ["id": "run000000000000p", "startedAt": 2, "join": true]),
                          predict: [.create("run", id: .given("run000000000000p"), ["startedAt": 2])])
      return [(.commit(Self.probe, start), Self.phone), (Self.send, Self.phone), (Self.pull, Self.phone)]
    case .clockSkew:
      return [(.skew(ms: 1_200_000), Self.phone), (Self.card("card0001", "Ahead"), Self.phone), (Self.send, Self.phone),
              (.advance(ms: Constants.backoffBaseMs * 2), Self.phone), (Self.send, Self.phone), (Self.pull, Self.phone)]
    case .epochChange:
      return [(.changeEpoch, Self.phone), (Self.card("card0001", "After"), Self.phone), (Self.pull, Self.phone), (Self.send, Self.phone),
              (Self.pull, Self.phone)]
    case .digestMismatch:
      return [(Self.pull, Self.phone), (Self.pull, Self.phone), (.sweep, Self.phone)]
    case .signInAdd:
      return [(.signIn(.add), Self.phone), (Self.send, Self.phone), (Self.pull, Self.phone)]
    case .signInDiscard:
      return [(.signIn(.discard), Self.phone), (Self.send, Self.phone), (Self.pull, Self.phone)]
    case .signOutKeep:
      return [(.signOut(.keep), Self.phone), (.sweep, Self.phone)]
    case .signOutDiscard:
      return [(.signOut(.discard), Self.phone)]
    case .dormantDiscard:
      return [(.signOut(.keep), Self.phone), (.discardDormant, Self.phone)]
    case .forkGuard:
      return [(.loseForkGuardCopy, Self.phone), (.relaunch(reboot: false), Self.phone), (Self.card("card0001", "New id"), Self.phone),
              (Self.send, Self.phone), (Self.pull, Self.phone)]
    case .replicaForked:
      return [(Self.card("card0001", "Again"), Self.phone), (Self.send, Self.phone), (Self.send, Self.phone), (Self.pull, Self.phone)]
    case .localRefusals:
      return [(Self.card("card0001", "One"), Self.phone), (Self.edit("card0001", "Two"), Self.phone),
              (.send(.answer(status: 400), PushFaults()), Self.phone), (Self.card("card0002", "Three"), Self.phone),
              (.send(.answer(status: 413), PushFaults()), Self.phone), (.dismissNotice, Self.phone), (Self.send, Self.phone),
              (Self.pull, Self.phone)]
    case .authPause:
      return [(.revokeSession, Self.phone), (Self.card("card0001", "Paused"), Self.phone), (Self.send, Self.phone),
              (.reauthenticate, Self.phone), (Self.send, Self.phone), (Self.pull, Self.phone)]
    case .liveFrame:
      return [(.follow, Self.phone), (Self.edit("card000b", "Live"), Self.other), (Self.send, Self.other), (.receiveFrame, Self.phone),
              (Self.edit("card000b", "Answered"), Self.phone), (Self.send, Self.phone), (.follow, Self.phone)]
    case .subscriptions:
      return [(.commit(Self.probe, Gesture(changes: [.create("board", id: .given("b_0000000a"))])), Self.phone), (Self.send, Self.phone),
              (.subscribe, Self.phone), (Self.pull, Self.phone),
              (.commit(Self.tree, Gesture(changes: [.write("meta", "meta", ["title": "Plan"])])), Self.phone), (Self.send, Self.phone),
              (.unsubscribe, Self.phone), (Self.pull, Self.phone)]
    case .launch:
      return [(.relaunch(reboot: true), Self.phone), (Self.card("card0001", "Launched"), Self.phone), (Self.send, Self.phone),
              (Self.pull, Self.phone)]
    case .settling:
      return [(Self.card("card0001", "One"), Self.phone), (Self.card("card0002", "Two"), Self.phone), (Self.send, Self.phone),
              (.foreground, Self.phone), (Self.pull, Self.phone)]
    }
  }
}
