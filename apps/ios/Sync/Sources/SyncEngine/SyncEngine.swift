import Foundation
import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import Synchronization

// The engine (design §5.3): the `Replica` products commit and read through, the loops that send, release, pull and
// follow live, and the views UI modules observe. Construction runs the start work that must precede the first frame;
// `start()` says hello and starts the loops.

public final class SyncEngine: Replica {
  struct Loops {
    var tasks: [Task<Void, Never>] = []
    var started = false
  }

  let core: EngineCore
  let transport: any SyncTransport
  let hub: ViewHub
  package let sender: Sender
  package let releaser: Releaser
  package let puller: Puller
  package let live: LiveChannel
  let loops = Mutex(Loops())

  public convenience init(config: EngineConfig, bindings: [any ProductBinding] = [], store: Store, transport: any SyncTransport,
                          tokens: any TokenStore, forkGuard: any ForkGuardStore, clock: EngineClock, random: any RandomSource,
                          connectivity: any Connectivity) throws {
    try self.init(config: config, bindings: bindings, store: store, transport: transport, tokens: tokens, forkGuard: forkGuard,
                  clock: clock, random: random, identities: Identities(random: random), connectivity: connectivity)
  }

  // Construction runs engine start's first half (`EngineCore.launch`). `identities` mints every id and actor; the
  // transcript runner hands the corpus's queues. `tap` receives every event from the first transaction on, inside the
  // transaction's turn that published it.
  package init(config: EngineConfig, bindings: [any ProductBinding], store: Store, transport: any SyncTransport,
               tokens: any TokenStore, forkGuard: any ForkGuardStore, clock: EngineClock, random: any RandomSource,
               identities: any IdentitySource & Sendable, connectivity: any Connectivity,
               tap: (@Sendable (EngineEvent) -> Void)? = nil) throws {
    let core = EngineCore(config: config, bindings: bindings, store: store, tokens: tokens, clock: clock, random: random,
                          identities: identities, connectivity: connectivity)
    if let tap { core.publisher.tap(tap) }
    try core.launch(forkGuard: forkGuard)

    self.core = core
    self.transport = transport
    hub = ViewHub(core: core)
    sender = Sender(core: core, transport: transport)
    releaser = Releaser(core: core)
    puller = Puller(core: core, transport: transport)
    live = LiveChannel(core: core, transport: transport, puller: puller)
    let (hub, changes) = (hub, core.publisher.changes)
    loops.withLock { $0.tasks.append(Task { @MainActor in await hub.run(changes) }) }
    connectivity.onChange { [weak core] _ in
      core?.wakes.kickAll()
      core?.publishStatus()
    }
  }

  deinit {
    loops.withLock { loops in
      for task in loops.tasks { task.cancel() }
    }
    core.publisher.finish()
  }

  // Engine start's network half (design §5.1): the hello, whose sample sets the offset and whose `minSchema` may require
  // an upgrade; a pending sign-in resumes with it, completing when no decision is due any more, and otherwise waits for
  // `resumeSignIn()`. Then every subscribed scope is wanted, and the loops start, once. In step mode (`drivesLoops`
  // false) the loops stay for the caller to step.
  public func start() async {
    if let pending = try? core.store.read({ try $0.deviceMeta()?.meta.pendingSignIn }) {
      _ = try? await continueSignIn(as: pending)
    } else {
      let seat = try? core.seat()
      let account = seat?.state == .bound && seat?.authPaused == false ? seat?.account : nil
      _ = await hello(token: account.flatMap { core.tokens.token(for: $0) })
    }
    core.pullWants.all()
    guard core.config.drivesLoops else { return }
    let (sender, releaser, puller, live) = (sender, releaser, puller, live)
    loops.withLock { loops in
      guard !loops.started else { return }
      loops.started = true
      loops.tasks += [
        Task { await sender.run() }, Task { await releaser.run() }, Task { await puller.run() }, Task { await live.run() },
      ]
    }
  }

  // §9.2 under `token`, or none: the answer's offset sample is recorded for the active replica (§10.4), and a
  // `minSchema` above the registry's version, or a 426, requires an upgrade.
  package func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    let send = core.clock.wall.reading()
    let reply = await transport.hello(token: token)
    let timing = Timing(send: send, recv: core.clock.wall.reading())
    guard case .answered(let answer) = reply else { return reply }
    switch answer {
    case .ok(let hello):
      _ = try? core.write { store, _ in try store.sample(serverTime: hello.serverTime, timing: timing) }
      if hello.minSchema > core.registry.version { core.requireUpgrade() }
    case .failed(let failure):
      if let serverTime = failure.serverTime {
        _ = try? core.write { store, _ in try store.sample(serverTime: serverTime, timing: timing) }
      }
      if failure.status == 426 { core.requireUpgrade() }
    }
    return reply
  }

  // MARK: Replica

  // §7.1 in one transaction: the body reads through a context over it, then the decided gesture commits; a nil gesture
  // writes nothing and ticks no clock. A committed gesture kicks the sender, and a held one the release timer. It throws
  // a `CommitFailure` as the context, the planner or the store raised it, any other error of the transaction as a store
  // failure, or the body's own error as the body threw it.
  public func commit<T>(_ scope: ScopeRef, _ body: (any CommitContext) throws -> (Gesture?, T)) throws
    -> (outcome: CommitOutcome?, value: T) {
    let committed: (outcome: CommitOutcome?, value: T)
    do {
      committed = try core.write { store, instance in
        try store.commit(in: scope, instance: instance, identities: core.identities) { [core, deviceNow = instance.deviceNow] tx in
          let context = try TransactionReader(tx, core: core, scope: scope, deviceNow: deviceNow)
          defer { context.end() }
          let decided: (Gesture?, T)
          do {
            decided = try body(context)
          } catch {
            throw context.failure ?? BodyError(error: error)
          }
          try context.finish()
          return decided
        }
      }
    } catch let own as BodyError {
      throw own.error
    } catch let failure as CommitFailure {
      throw failure
    } catch {
      throw CommitFailure(.storeFailure, "\(error)")
    }
    if case .committed(let receipt)? = committed.outcome {
      core.wakes.sender.kick()
      if receipt.releaseAt != nil { core.wakes.releaser.kick() }
    }
    return committed
  }

  // An Undo's silent fold may leave sendable what the held gesture held back, so an Undo kicks the sender.
  public func undo(_ gestureId: String) throws -> Bool {
    let undone = try core.write { store, _ in try store.undo(gestureId) }
    if undone { core.wakes.sender.kick() }
    return undone
  }

  public func read<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T {
    try core.read(scope, body)
  }

  public func mintID(_ type: String) throws -> RecordID {
    try core.identities.mint(type, in: core.registry)
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

  // MARK: Subscriptions (§7.9)

  // A tree or overlay scope followed beyond the products' own while a product holds it open: a scope known not found is
  // known no more, so its first pull boots it, and it is pulled at once and followed live. A scope known gone stays
  // gone, since its death is final (INV-13): the subscribe answers `.gone`, and nothing is pulled. A signed-out replica
  // follows only trees.
  @discardableResult
  public func subscribe(_ scope: ScopeRef) throws -> SubscribeOutcome {
    precondition(scope.tree != nil, "only tree and overlay scopes are subscribed by hand")
    let outcome = try core.write { store, _ in try store.subscribe(scope) }
    guard outcome == .subscribed else { return outcome }
    core.opened.withLock { opened in
      if !opened.contains(scope) { opened.append(scope) }
    }
    core.pullWants.add([scope])
    core.wakes.puller.kick()
    core.wakes.live.kick()
    return outcome
  }

  // A scope no longer followed is forgotten, and its acked entries resolve. The set is read inside the write, after the
  // scope left it, so a scope subscribed meanwhile stays.
  public func unsubscribe(_ scope: ScopeRef) throws {
    core.opened.withLock { $0.removeAll { $0 == scope } }
    try core.write { store, _ in
      try store.reconcile(subscribed: Set(try core.seat().map { core.subscriptions(of: $0) } ?? []))
    }
    core.wakes.live.kick()
  }

  // MARK: App lifecycle (§7.3)

  // Leaving the app: every held entry is released into the durable queue at once, so Undo is not offered again, and a
  // release kicks the sender (§7.3); the live socket closes and the pull timer stops until the app is back.
  public func leave() throws {
    core.foreground.store(false, ordering: .relaxed)
    core.wakes.live.kick()
    if try core.write({ store, _ in try store.releaseAll() }) { core.wakes.sender.kick() }
  }

  // The leave flush: one drain, joined with the sender's loop; then the live socket is closed.
  public func flushOnLeave() async {
    await sender.flushOnce()
    await live.close()
  }

  // Back in the foreground: the sender goes again, every subscribed scope is pulled, and the live socket reopens.
  public func foreground() {
    core.foreground.store(true, ordering: .relaxed)
    core.pullWants.all()
    core.wakes.kickAll()
  }

  // MARK: The step-mode harness

  // One store Action as this instance, its changes and events published as the engine's own.
  package func write<Value>(_ action: (Store, inout Instance) throws -> Written<Value>) throws -> Value {
    try core.write(action)
  }

  package var identities: any IdentitySource & Sendable { core.identities }
}

// MARK: - The core

// What every part of the engine shares: the store, the session tokens, this instance's actor (D-2), the clocks, ids and
// randomness, connectivity, the app's foreground, the scopes opened by hand and those wanted pulled, the product
// bindings, every loop's wake-up, and the pipe to the views. Every write runs as this instance and is published in
// commit order.
final class EngineCore: Sendable {
  // The actor until the start transaction mints the instance's own; nothing is stamped with it.
  static let provisionalActor = try! Stamp.Actor("r_provisional")

  let config: EngineConfig
  let bindings: [any ProductBinding]
  let store: Store
  let tokens: any TokenStore
  let clock: EngineClock
  let random: any RandomSource
  let identities: any IdentitySource & Sendable
  let connectivity: any Connectivity
  let publisher = Publisher()
  let wakes = Wakes()
  let pullWants = PullWants()
  let actor = Mutex(EngineCore.provisionalActor)
  let upgrade = Atomic(false)
  let foreground = Atomic(true)
  let opened = Mutex<[ScopeRef]>([])
  // The thread inside a write, 0 when none: a write nested in one on the same thread (an engine call from a commit's
  // body) stops with a message instead of waiting on itself.
  let writingThread = Atomic<UInt64>(0)

  init(config: EngineConfig, bindings: [any ProductBinding], store: Store, tokens: any TokenStore, clock: EngineClock,
       random: any RandomSource, identities: any IdentitySource & Sendable, connectivity: any Connectivity) {
    self.config = config
    self.bindings = bindings
    self.store = store
    self.tokens = tokens
    self.clock = clock
    self.random = random
    self.identities = identities
    self.connectivity = connectivity
  }

  var registry: Registry { store.registry }

  // One of the store's Actions, as this instance: its actor and the device clock now. The actor is held for the whole
  // transaction, so an actor a re-identify mints serves every later write, and changes and events go out in commit order.
  // A write that renames or swaps the replicas (a re-identify, an epoch change, a sign-in or out) wakes the puller, which
  // then pulls every scope, and the live channel, which then reconnects for the replica now active.
  func write<Value>(_ action: (Store, inout Instance) throws -> Written<Value>) throws -> Value {
    var thread: UInt64 = 0
    pthread_threadid_np(nil, &thread)
    precondition(writingThread.load(ordering: .acquiring) != thread,
                 "an engine write inside another: a commit's body reads through its context and writes nothing")
    let (value, change) = try actor.withLock { actor in
      writingThread.store(thread, ordering: .releasing)
      defer { writingThread.store(0, ordering: .releasing) }
      var instance = Instance(actor: actor, deviceNow: clock.wall.nowMs(), appVersion: config.appVersion)
      let written = try action(store, &instance)
      actor = instance.actor
      publisher.publish(written.change, written.events)
      return (written.value, written.change)
    }
    if change.replicas {
      wakes.puller.kick()
      wakes.live.kick()
    }
    return value
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

  // §7.4: a 401 to a call made under `sent`, or no token to call under (`sent` nil), pauses the bound replica, and the
  // live socket closes; unless the account holds another token by now, which a re-authentication saved while the call
  // was in flight (design §4.4 rule 2). The token is read inside the write, so a re-authentication's own write follows
  // this one, or finds the token changed. True when the replica is paused.
  @discardableResult
  func pauseAuth(_ replica: String, sentUnder sent: SessionToken?) throws -> Bool {
    let paused = try write { store, _ in
      try store.write(.authPause) { tx in
        guard var loaded = try tx.replica(replica), let account = loaded.meta.account, tokens.token(for: account) == sent else {
          return Planned(false, ReplicaBatch())
        }
        loaded.update { $0.authPaused = true }
        return Planned(true, loaded.batch)
      }
    }
    if paused { wakes.live.kick() }
    return paused
  }

  // §7.9, in the order the puller pulls and the live channel follows them: a bound replica subscribes the product
  // scopes of the products its surface carries, then the scopes opened by hand; a signed-out one only the trees opened.
  func subscriptions(of meta: ReplicaMeta) -> [ScopeRef] {
    let opened = opened.withLock { $0 }
    guard meta.state == .bound else { return opened.filter { if case .tree = $0.kind { true } else { false } } }
    return registry.products.filter { $0.surfaces.contains(config.surface) }.map { ScopeRef.product($0.name) } + opened
  }

  var isForeground: Bool { foreground.load(ordering: .relaxed) }

  // 426: nothing more is sent or pulled until the app is upgraded; the status says so.
  var upgradeRequired: Bool { upgrade.load(ordering: .relaxed) }

  func requireUpgrade() {
    upgrade.store(true, ordering: .relaxed)
    publishStatus()
    wakes.live.kick()
  }

  // What the store does not hold changed the status: connectivity, or an upgrade required.
  func publishStatus() {
    var change = StoreChange()
    change.status = true
    publisher.publish(change, [])
  }

  // A backoff's ceiling (§7.4): 30 s while any product's live hint holds, else 300 s; a hint that cannot be read does not
  // hold.
  func backoffCeilingMs() -> Int64 {
    guard let physNow = try? physNow() else { return Constants.backoffCeilingMs }
    let live = bindings.contains { binding in
      (try? read(.product(binding.product)) { try binding.liveHint($0, physNow: physNow) }) == true
    }
    return live ? Constants.backoffLiveCeilingMs : Constants.backoffCeilingMs
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

  init(core: EngineCore) {
    self.core = core
  }

  package var wake: Wake { core.wakes.releaser }

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
      core.wakes.sender.kick()
      return .again
    } catch {
      return .wait(ms: Constants.backoffBaseMs)
    }
  }
}
