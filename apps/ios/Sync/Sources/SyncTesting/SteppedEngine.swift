import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import protocol SyncModelServer.ServerRules
import struct SyncModelServer.ModelServer
import struct SyncModelServer.ServerState
import SyncReplica
import SyncStore
import Synchronization

// The step-mode harness core (design §9.4, kit ER-9): a device of a test is a real `SyncEngine` whose loops never
// start, over an in-memory store, on a `SimClock` and a random source seeded for it, into the one `ModelServer` its
// devices share. The kit's `Harness` wraps it; the simulator drives it one step at a time.

// The model server's product plug-in, as the kit names it: a product's double of its server rules. One with no rules of
// its own conforms with an empty body.
public typealias ServerRules = SyncModelServer.ServerRules

// MARK: - A device

// Each public call runs the engine's step functions on the calling thread, to their end, so a test is one thread of
// control and one schedule per seed: `sync()` pushes and pulls on every device of the server until nothing moves,
// `advance(ms:)` moves the clock and releases the holds come due, `leave()` leaves the app. `device()` is another
// device, on the same server and clock, signed in as the same account.
public final class SteppedEngine: Sendable {
  struct Process {
    var store: Store
    var forkGuard: InMemoryForkGuardStore
    var engine: SyncEngine
  }

  let fleet: Fleet
  package let name: String
  let account: String?
  let ports: DevicePorts
  let faults: CommitFaults
  let killer: Killer?
  // What a simulation reads of the store after each of its transactions commits.
  let commits = CommitWatch()
  let process: Mutex<Process>

  // A server of `registry`'s products holding nothing, with `rules`, and its first device, the clock at `startMs`,
  // signed in as `account` or signed out when nil. Every id, actor and backoff its devices draw follows `seed`.
  public convenience init(registry: Registry, startMs: Int64, seed: UInt64 = 1, account: String? = "acct-1", rules: any ServerRules, commandResultWrites: @escaping CommandResultDeviceWrites = { _, _, _, _ in [] }, pendingDeviceWork: @escaping PendingDeviceWork = { _, _ in [] }) {
    let clock = SimClock(wallMs: startMs)
    let server = ModelServerHandle(ModelServer(registry: registry, rules: rules, state: ServerState(epoch: "ep-1")), clock: clock)
    self.init(joining: Fleet(registry: registry, network: SimNetwork(server: server), seed: seed, commandResultWrites: commandResultWrites, pendingDeviceWork: pendingDeviceWork), name: "device-1", clock: clock,
              account: account)
    CallerThread.run { [self] in await startSignedIn() }
  }

  // A device of `fleet`, its engine built and not yet started; `copy` is a store another device's was copied into.
  init(joining fleet: Fleet, name: String, clock: SimClock, account: String?, killer: Killer? = nil, holding copy: LoadedDevice? = nil) {
    let (faults, commits) = (CommitFaults(), commits)
    let (seed, holdMs) = (fleet.nextSeed(), UInt64(fleet.slicedHoldMs))
    let holds = SeededRandomSource(seed: seed ^ 0x5EED_0F_1177E2)
    let ports = DevicePorts(
      clock: clock, random: SeededRandomSource(seed: seed), tokens: InMemoryTokenStore(), connectivity: SwitchedConnectivity(),
      events: EventLog(), network: fleet.network, crashPoints: CrashPoints { point in
        if holdMs > 0, case .beforeCommit(let tx) = point, [.pullPage, .settle, .results].contains(tx) {
          clock.advance(ms: Int64(holds.next() % (holdMs + 1)))
        }
        try faults.hit(point)
        try killer?.hit(point)
        if case .afterCommit = point { commits.committed() }
      })
    let store = Self.surely("open its store") {
      try copy.map { try Store.inMemory(holding: $0, registry: fleet.registry, crashPoints: ports.crashPoints, commandResultWrites: fleet.commandResultWrites, pendingDeviceWork: fleet.pendingDeviceWork) }
        ?? Store.inMemory(registry: fleet.registry, crashPoints: ports.crashPoints, commandResultWrites: fleet.commandResultWrites, pendingDeviceWork: fleet.pendingDeviceWork)
    }
    let forkGuard = InMemoryForkGuardStore()
    let engine = Self.surely("launch its engine") { try ports.launch(over: store, forkGuard: forkGuard) }
    self.fleet = fleet
    self.name = name
    self.account = account
    self.ports = ports
    self.faults = faults
    self.killer = killer
    process = Mutex(Process(store: store, forkGuard: forkGuard, engine: engine))
    fleet.join(self)
  }

  public var clock: SimClock { ports.clock }
  public var server: ModelServerHandle { fleet.network.server }

  // What products commit and read through.
  public var replica: any Replica { engine }

  public func device() -> SteppedEngine {
    let device = SteppedEngine(joining: fleet, name: "device-\(fleet.joined + 1)", clock: clock, account: account)
    CallerThread.run { await device.startSignedIn() }
    return device
  }

  // Every device's sender and puller, round after round, until a round in which no device pushed and the server's rows
  // stood still: each then holds what the server holds. What a device cannot send until the clock moves past a pause
  // the server asked for stays unsent until `advance(ms:)`.
  public func sync() {
    let settled = CallerThread.run { [fleet] in await fleet.settle() }
    precondition(settled, "sync() found no quiescence: a sender or puller never stopped")
  }

  // The clock, and on every device on it, the release timer: each hold due by now is released (§7.3).
  public func advance(ms: Int64) {
    clock.advance(ms: ms)
    for device in fleet.devices where device.clock === clock { device.releaseDue() }
  }

  // Leaving the app (§7.3): every held entry is released, and the leave flush pushes what it can.
  public func leave() {
    let engine = engine
    Self.surely("leave the app") { try engine.leave() }
    CallerThread.run { await engine.flushOnLeave() }
  }

  // The next commit throws before its transaction commits, as a full disk would, whether or not its body decides a
  // gesture.
  public func failNextCommit() {
    faults.failNextCommit()
  }

  // MARK: Reading what the person sees

  public func drawn(_ scope: ScopeRef, _ type: String) throws -> [Record] {
    try engine.read(scope) { try $0.drawn(type) }
  }

  public func stored(_ scope: ScopeRef, _ type: String) throws -> [Record] {
    try engine.read(scope) { try $0.stored(type) }
  }

  // ER-12: the records of `type` whose top-level ref `field` names `id`.
  public func drawn(_ scope: ScopeRef, _ type: String, where field: String, is id: RecordID) throws -> [Record] {
    try engine.read(scope) { try $0.drawn(type, where: field, is: id) }
  }

  public func stored(_ scope: ScopeRef, _ type: String, where field: String, is id: RecordID) throws -> [Record] {
    try engine.read(scope) { try $0.stored(type, where: field, is: id) }
  }

  // The refusals of `product` not dismissed, in the order they were written (D-17).
  public func notices(_ product: String) throws -> [Notice] {
    try engine.currentNotices(product)
  }

  // The held gestures Undo can still remove, by the device clock (§7.3).
  public func undoOffers() -> [UndoOffer] {
    Self.surely("read its undo offers") { try engine.currentUndoOffers() }
  }

  // MARK: Observing what the person sees

  // The views a UI module observes (design §4.5), over the engine the device runs now. Each is `.loading` until the views
  // settle.
  @MainActor public func records(_ scope: ScopeRef, _ type: String, _ mode: ViewMode = .drawn) throws -> RecordsView {
    try engine.records(scope, type, mode)
  }

  @MainActor public func records(_ scope: ScopeRef, _ type: String, where field: String, is id: RecordID,
                                 _ mode: ViewMode = .drawn) throws -> RecordsView {
    try engine.records(scope, type, where: field, is: id, mode)
  }

  // Returns once every view shows each change committed before the call, and each view made before it has loaded.
  @MainActor public func settleViews() async {
    await engine.settle()
  }

  // MARK: A simulation's device

  package var engine: SyncEngine { process.withLock(\.engine) }
  package var store: Store { process.withLock(\.store) }
  package var events: EventLog { ports.events }
  package var tokens: InMemoryTokenStore { ports.tokens }
  package var connectivity: SwitchedConnectivity { ports.connectivity }

  // Engine start's network half: the hello, and a pending sign-in resumed.
  package func start() async {
    await engine.start()
  }

  // Engine start, then the sign-in as `account`, which a device with nothing written signed out completes at once.
  func startSignedIn() async {
    await start()
    guard let account else { return }
    let engine = engine
    let session = await Self.surely("sign in") { try await engine.signIn(account: account, token: server.token(for: account)) }
    precondition(session.isComplete, "a device with nothing written signs in with no decision due")
  }

  // The process dies between transactions and another launches over the same store (design §9.3): its fork guard
  // checked against the copy, its holds released, a new actor. Throws when the store's hook kills the launch itself.
  package func relaunch() async throws {
    let (store, forkGuard) = process.withLock { ($0.store, $0.forkGuard) }
    let engine = try ports.launch(over: store, forkGuard: forkGuard)
    process.withLock { $0.engine = engine }
    await engine.start()
  }

  // The device restored from `backup`: the store as it held it, launched anew. iOS keeps the fork guard's copy and the
  // session in the keychain out of backups, so a restore onto a wiped phone finds neither; a store rolled back in place
  // finds both.
  package func restore(_ backup: LoadedDevice, keepingForkGuardCopy kept: Bool) async throws {
    let store = try Store.inMemory(holding: backup, registry: fleet.registry, crashPoints: ports.crashPoints, commandResultWrites: fleet.commandResultWrites, pendingDeviceWork: fleet.pendingDeviceWork)
    let forkGuard = kept ? process.withLock(\.forkGuard) : InMemoryForkGuardStore()
    if !kept {
      for account in tokens.accounts() { tokens.delete(for: account) }
    }
    let engine = try ports.launch(over: store, forkGuard: forkGuard)
    process.withLock { $0 = Process(store: store, forkGuard: forkGuard, engine: engine) }
    await engine.start()
  }

  // The fork guard's copy is gone, as after a restore onto the same phone: the next launch re-identifies (§7.11).
  package func loseForkGuardCopy() {
    process.withLock { $0.forkGuard = InMemoryForkGuardStore() }
  }

  // Another device holding a copy of this store, on `clock`: neither the fork guard's copy nor the session migrates, so
  // it re-identifies at its start and signs in again (§7.11).
  package func clone(named name: String, on clock: SimClock) async throws -> SteppedEngine {
    let copy = try store.read { try $0.device(rows: true) }
    let clone = SteppedEngine(joining: fleet, name: name, clock: clock, account: account, killer: nil, holding: copy)
    await clone.start()
    return clone
  }

  // The sender's rounds until one does not push again: true when any pushed; nil when none stopped within `bound`.
  package func send(bound: Int = 1_000) async -> Bool? {
    let sender = engine.sender
    var pushed = false
    for _ in 0..<bound {
      guard await sender.step() == .again else { return pushed }
      pushed = true
    }
    return nil
  }

  // Every subscribed scope pulled to the head, and every frame the puller holds applied; false when the puller never
  // stopped within `bound`.
  package func pull(bound: Int = 1_000) async -> Bool {
    let puller = engine.puller
    puller.wants.all()
    for _ in 0..<bound {
      switch await puller.step() {
      case .pulled, .frame, .again: continue
      case .idle, .fallback, .repull, .paused, .stopped, .backoff: return true
      }
    }
    return false
  }

  // The release timer, until nothing held is due.
  package func releaseDue() {
    let releaser = engine.releaser
    while releaser.step() == .again {}
  }

  // The sweep, until no row is left that no view reads (§2.5).
  package func sweep() {
    let sweeper = engine.sweeper
    while sweeper.step() == .again {}
  }

  // A harness call's own store and engine work, which only a broken build fails: the test stops, saying what failed.
  static func surely<Value>(_ doing: String, _ work: () throws -> Value) -> Value {
    do {
      return try work()
    } catch {
      preconditionFailure("the step-mode harness could not \(doing): \(error)")
    }
  }

  static func surely<Value>(_ doing: String, _ work: () async throws -> Value) async -> Value {
    do {
      return try await work()
    } catch {
      preconditionFailure("the step-mode harness could not \(doing): \(error)")
    }
  }
}

// A hook the store calls after each transaction commits and its process lives on, which a simulation sets to read what
// the store holds then.
final class CommitWatch: Sendable {
  let observer = Mutex<(@Sendable () -> Void)?>(nil)

  func observe(_ observer: @escaping @Sendable () -> Void) {
    self.observer.withLock { $0 = observer }
  }

  func committed() {
    observer.withLock { $0 }?()
  }
}

// What each process of a device builds its engine over, which outlives the process: the device's clock, random
// source, keychain, network path, the network, the log of every event its engines publish, and its store's crash-point
// hook.
struct DevicePorts: Sendable {
  let clock: SimClock
  let random: SeededRandomSource
  let tokens: InMemoryTokenStore
  let connectivity: SwitchedConnectivity
  let events: EventLog
  let network: SimNetwork
  let crashPoints: CrashPoints

  func launch(over store: Store, forkGuard: InMemoryForkGuardStore) throws -> SyncEngine {
    try SyncEngine(
      config: EngineConfig(appVersion: "1", surface: .ios, drivesLoops: false), bindings: [], store: store, transport: network,
      tokens: tokens, forkGuard: forkGuard, clock: clock.engineClock, random: random, identities: Identities(random: random),
      connectivity: connectivity, tap: { [events] in events.append($0) })
  }
}

// MARK: - The devices of one server

// What `sync()` drives and `device()` joins. It holds its devices weakly: a device lives as long as its test holds it.
final class Fleet: Sendable {
  struct Member {
    weak var device: SteppedEngine?
  }

  struct Members {
    var list: [Member] = []
    var seeds = 0
  }

  let registry: Registry
  let network: SimNetwork
  let seed: UInt64
  let commandResultWrites: CommandResultDeviceWrites
  let pendingDeviceWork: PendingDeviceWork
  // The most a sliced step holds a device's writer on its clock, each drawing a seeded 0 to this many ms; 0 leaves the clock alone.
  let slicedHoldMs: Int64
  let members = Mutex(Members())

  init(registry: Registry, network: SimNetwork, seed: UInt64, slicedHoldMs: Int64 = 0, commandResultWrites: @escaping CommandResultDeviceWrites = { _, _, _, _ in [] }, pendingDeviceWork: @escaping PendingDeviceWork = { _, _ in [] }) {
    self.registry = registry
    self.network = network
    self.seed = seed
    self.commandResultWrites = commandResultWrites
    self.pendingDeviceWork = pendingDeviceWork
    self.slicedHoldMs = slicedHoldMs
  }

  var devices: [SteppedEngine] { members.withLock { $0.list.compactMap(\.device) } }

  // How many devices ever joined, those released since included.
  var joined: Int { members.withLock(\.list.count) }

  func join(_ device: SteppedEngine) {
    members.withLock { $0.list.append(Member(device: device)) }
  }

  // The seed of the next device's random source, a pure function of the fleet's seed and how many devices came before.
  func nextSeed() -> UInt64 {
    let index = members.withLock { members in
      members.seeds += 1
      return UInt64(members.seeds)
    }
    return (seed &* 0x9E37_79B9_7F4A_7C15) ^ (index &* 0xBF58_476D_1CE4_E5B9)
  }

  // Every device's sender, then every device's puller and sweep, round after round, until a round in which no device
  // pushed and the server's rows stood still: each device then holds what the server holds, and nothing it can send
  // before the clock moves or the person acts. False when `rounds` rounds were not enough, or a sender or puller never
  // stopped.
  func settle(rounds: Int = 32) async -> Bool {
    for _ in 0..<rounds {
      let before = network.server.rowsVersion
      var pushed = false
      for device in devices {
        guard let sent = await device.send() else { return false }
        pushed = pushed || sent
      }
      for device in devices {
        guard await device.pull() else { return false }
        device.sweep()
      }
      if !pushed, network.server.rowsVersion == before { return true }
    }
    return false
  }
}

// MARK: - One thread of control

// An async body run to its end on the calling thread (design §9.3): its task prefers this executor, whose jobs the
// calling thread runs in the order they come. Default actors run on a task's preferred executor, so the engine's sender,
// puller and live channel run here too, and the request tasks inherit the engine's task-local preference.
final class CallerThread: TaskExecutor {
  let jobs = Mutex<[UnownedJob]>([])
  let arrivals = DispatchSemaphore(value: 0)
  let finished = Atomic(false)

  static func run<Value: Sendable>(_ body: @escaping @Sendable () async -> Value) -> Value {
    let thread = CallerThread()
    let answer = Mutex<Value?>(nil)
    Task(executorPreference: thread) {
      await SyncEngine.$taskExecutor.withValue(thread) {
        let value = await body()
        answer.withLock { $0 = value }
        thread.finished.store(true, ordering: .releasing)
        thread.arrivals.signal()
      }
    }
    thread.runJobs()
    return answer.withLock { $0! }
  }

  func enqueue(_ job: consuming ExecutorJob) {
    let job = UnownedJob(job)
    jobs.withLock { $0.append(job) }
    arrivals.signal()
  }

  func runJobs() {
    while true {
      guard arrivals.wait(timeout: .now() + .seconds(60)) == .success else {
        preconditionFailure("a step-mode call waited a minute for work that never came back to its thread")
      }
      if let job = jobs.withLock({ $0.isEmpty ? nil : $0.removeFirst() }) {
        job.runSynchronously(on: asUnownedTaskExecutor())
      } else if finished.load(ordering: .acquiring) {
        return
      }
    }
  }
}
