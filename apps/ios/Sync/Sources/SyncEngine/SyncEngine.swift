import Foundation
import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import Synchronization

// The engine (design §5.3): the `Replica` products commit and read through, the loops that send and release, and the
// views UI modules observe. Construction runs the start work that must precede the first frame; `start()` starts the
// loops.

public final class SyncEngine: Replica {
  struct Loops {
    var tasks: [Task<Void, Never>] = []
    var started = false
  }

  let core: EngineCore
  let tokens: any TokenStore
  let hub: ViewHub
  package let sender: Sender
  package let releaser: Releaser
  let loops = Mutex(Loops())

  // Engine start (§7.3, §7.11, §7.4): the store first launched; every held entry released, with no Undo shown; a fresh
  // actor; the fork guard checked against its backup-excluded copy (a copy that differs or is missing re-identifies every
  // replica), and the copy rewritten once the store has committed; a bound replica with no token paused.
  public init(config: EngineConfig, bindings: [any ProductBinding] = [], store: Store, transport: any SyncTransport,
              tokens: any TokenStore, forkGuard: any ForkGuardStore, clock: EngineClock, random: any RandomSource,
              connectivity: any Connectivity) throws {
    let identities = Identities(random: random)
    let core = try EngineCore(config: config, store: store, clock: clock, identities: identities, connectivity: connectivity)
    _ = try core.write { store, _ in try store.firstLaunch(identities: identities) }
    let copy = forkGuard.load()
    _ = try core.write { store, instance in
      try store.start(backup: copy.map(BackupCopy.held) ?? .missing, instance: &instance, identities: identities)
    }
    if let kept = try store.read({ try $0.deviceMeta()?.meta.forkGuard }), kept != copy { try forkGuard.save(kept) }
    if let seat = try core.seat(), seat.state == .bound, let account = seat.account, tokens.token(for: account) == nil {
      try core.pauseAuth(seat.replica)
    }

    self.core = core
    self.tokens = tokens
    hub = ViewHub(core: core)
    sender = Sender(core: core, transport: transport, tokens: tokens, random: random, bindings: bindings)
    releaser = Releaser(core: core, senderWake: sender.wake)
    let (hub, changes) = (hub, core.publisher.changes)
    loops.withLock { $0.tasks.append(Task { @MainActor in await hub.run(changes) }) }
    connectivity.onChange { [weak core, wake = sender.wake] _ in
      wake.kick()
      core?.publishStatus()
    }
  }

  deinit {
    loops.withLock { loops in
      for task in loops.tasks { task.cancel() }
    }
    core.publisher.finish()
  }

  // Starts the sender and the release timer, once; in step mode (`drivesLoops` false) they stay for the caller to step.
  public func start() async {
    guard core.config.drivesLoops else { return }
    let (sender, releaser) = (sender, releaser)
    loops.withLock { loops in
      guard !loops.started else { return }
      loops.started = true
      loops.tasks += [Task { await sender.run() }, Task { await releaser.run() }]
    }
  }

  // MARK: Replica

  // §7.1 in one transaction: the body reads through a context over it, then the decided gesture commits; a nil gesture
  // writes nothing and ticks no clock. A committed gesture kicks the sender, and a held one the release timer.
  public func commit<T>(_ scope: ScopeRef, _ body: (any CommitContext) throws -> (Gesture?, T)) throws
    -> (outcome: CommitOutcome?, value: T) {
    let committed = try core.write { store, instance in
      try store.commit(in: scope, instance: instance, identities: core.identities) { [core, deviceNow = instance.deviceNow] tx in
        let context = try TransactionReader(tx, core: core, scope: scope, deviceNow: deviceNow)
        defer { context.end() }
        let decided = try body(context)
        try context.finish()
        return decided
      }
    }
    if case .committed(let receipt)? = committed.outcome {
      sender.wake.kick()
      if receipt.releaseAt != nil { releaser.wake.kick() }
    }
    return committed
  }

  public func undo(_ gestureId: String) throws -> Bool {
    try core.write { store, _ in try store.undo(gestureId) }
  }

  public func read<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T {
    try core.read(scope, body)
  }

  public func mintID(_ type: String) -> RecordID {
    guard let def = core.registry.type(type), let id = core.identities.mint(def) else { preconditionFailure("\(type) mints no ids") }
    return id
  }

  public func physNow() throws -> Int64 {
    try core.physNow()
  }

  // MARK: Observing (UI modules)

  @MainActor public func records(_ scope: ScopeRef, _ type: String, _ mode: ViewMode = .drawn) -> RecordsView {
    precondition(core.registry.lives(type, in: scope), "\(type) is no type of \(scope)")
    return hub.records(RecordsView.Key(scope: scope, type: type, mode: mode))
  }

  @MainActor public func notices(_ product: String) -> NoticesView {
    hub.notices(product)
  }

  @MainActor public var undoOffers: UndoOffers { hub.undoOffers }
  @MainActor public var status: SyncStatus { hub.status }

  // Every event from now on, one stream per subscriber: terminal outcomes and telemetry.
  public func events() -> AsyncStream<EngineEvent> {
    core.publisher.events()
  }

  public func dismissNotice(_ id: String) throws {
    try core.write { store, _ in try store.dismissNotice(id) }
  }

  // Returns once the views have applied every change committed before the call.
  package func settle() async {
    await hub.settle(through: core.publisher.published)
  }

  // MARK: App lifecycle (§7.3)

  // Leaving the app: every held entry is released into the durable queue at once, so Undo is not offered again.
  public func leave() throws {
    try core.write { store, _ in try store.releaseAll() }
    sender.wake.kick()
  }

  // The leave flush: one drain, joined with the sender's loop.
  public func flushOnLeave() async {
    await sender.flushOnce()
  }

  public func foreground() {
    sender.wake.kick()
  }

  // §8.2: the account's new token clears the pause a 401 set, and sending resumes.
  public func reauthenticate(token: SessionToken) throws {
    guard let seat = try core.seat(), seat.state == .bound, let account = seat.account else { throw EngineError.notSignedIn }
    try tokens.save(token, for: account)
    try core.write { store, _ in try store.reauthenticate() }
    sender.wake.kick()
  }
}

// MARK: - The core

// What every part of the engine shares: the store, this instance's actor (D-2), the clocks and ids, connectivity, and
// the pipe to the views. Every write runs as this instance and is published in commit order.
final class EngineCore: Sendable {
  let config: EngineConfig
  let store: Store
  let clock: EngineClock
  let identities: Identities
  let connectivity: any Connectivity
  let publisher = Publisher()
  let actor: Mutex<Stamp.Actor>
  let upgrade = Atomic(false)
  // The thread inside a write, 0 when none: a write nested in one on the same thread (an engine call from a commit's
  // body) stops with a message instead of waiting on itself.
  let writingThread = Atomic<UInt64>(0)

  // The actor is provisional until the start transaction mints the instance's own.
  init(config: EngineConfig, store: Store, clock: EngineClock, identities: Identities, connectivity: any Connectivity) throws {
    self.config = config
    self.store = store
    self.clock = clock
    self.identities = identities
    self.connectivity = connectivity
    actor = Mutex(try identities.actor())
  }

  var registry: Registry { store.registry }

  // One of the store's Actions, as this instance: its actor and the device clock now. The actor is held for the whole
  // transaction, so an actor a re-identify mints serves every later write, and changes and events go out in commit order.
  func write<Value>(_ action: (Store, inout Instance) throws -> Written<Value>) throws -> Value {
    var thread: UInt64 = 0
    pthread_threadid_np(nil, &thread)
    precondition(writingThread.load(ordering: .acquiring) != thread,
                 "an engine write inside another: a commit's body reads through its context and writes nothing")
    return try actor.withLock { actor in
      writingThread.store(thread, ordering: .releasing)
      defer { writingThread.store(0, ordering: .releasing) }
      var instance = Instance(actor: actor, deviceNow: clock.wall.nowMs(), appVersion: config.appVersion)
      let written = try action(store, &instance)
      actor = instance.actor
      publisher.publish(written.change, written.events)
      return written.value
    }
  }

  func read<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T {
    try store.read { tx in
      let reader = try TransactionReader(tx, core: self, scope: scope, deviceNow: clock.wall.nowMs())
      defer { reader.end() }
      return try body(reader)
    }
  }

  // The active replica's meta.
  func seat() throws -> ReplicaMeta? {
    try store.read { tx in try tx.replica(tx.activeReplica())?.meta }
  }

  // §10.2: the device wall clock plus the active replica's offset.
  func physNow() throws -> Int64 {
    guard let meta = try seat() else { throw StoreError.noDevice }
    return meta.physNow(deviceNow: clock.wall.nowMs())
  }

  // A bound replica with no token to send under pauses, as a 401 pauses it (§7.4).
  func pauseAuth(_ replica: String) throws {
    try write { store, _ in
      try store.write(.authPause) { tx in
        guard var loaded = try tx.replica(replica) else { return Planned((), ReplicaBatch()) }
        loaded.update { $0.authPaused = true }
        return Planned((), loaded.batch)
      }
    }
  }

  // §7.9: a bound replica subscribes the product scopes of the products its surface carries.
  func subscriptions(of meta: ReplicaMeta) -> Set<ScopeRef> {
    guard meta.state == .bound else { return [] }
    return Set(registry.products.filter { $0.surfaces.contains(config.surface) }.map { ScopeRef.product($0.name) })
  }

  // 426: nothing more is sent or pulled until the app is upgraded; the status says so.
  var upgradeRequired: Bool { upgrade.load(ordering: .relaxed) }

  func requireUpgrade() {
    upgrade.store(true, ordering: .relaxed)
    publishStatus()
  }

  // What the store does not hold changed the status: connectivity, or an upgrade required.
  func publishStatus() {
    var change = StoreChange()
    change.status = true
    publisher.publish(change, [])
  }
}

// MARK: - The release timer

package enum ReleaserStep: Sendable, Hashable {
  case again
  case idle
  case wait(ms: Int64)
}

// §7.3: sleeps until the earliest held `releaseAt`, reading the device clock again on waking, so a wall-clock jump
// neither loses a release nor fires one early. Each release kicks the sender.
package final class Releaser: Sendable {
  let core: EngineCore
  let senderWake: Wake
  package let wake = Wake()

  init(core: EngineCore, senderWake: Wake) {
    self.core = core
    self.senderWake = senderWake
  }

  func run() async {
    while !Task.isCancelled {
      let seen = wake.kicks
      switch step() {
      case .again: continue
      case .idle: await wake.wait(past: seen)
      case .wait(let ms): await wake.wait(past: seen, atMost: .milliseconds(ms), clock: core.clock.sleeper)
      }
    }
  }

  // Releases every held entry that is due, or answers how long until the next one; a store that fails is tried again in
  // a second.
  package func step() -> ReleaserStep {
    do {
      let deviceNow = core.clock.wall.nowMs()
      let due = try core.store.read { tx in
        try tx.replica(tx.activeReplica())?.outbox.filter { $0.state == .held }.map(\.releaseAt).min()
      }
      guard let due else { return .idle }
      guard due <= deviceNow else { return .wait(ms: due - deviceNow) }
      try core.write { store, instance in try store.releaseDue(at: instance.deviceNow) }
      senderWake.kick()
      return .again
    } catch {
      return .wait(ms: Constants.backoffBaseMs)
    }
  }
}
