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
  package let sweeper: Sweeper
  let loops = Mutex(Loops())

  public convenience init(config: EngineConfig, bindings: [any ProductBinding] = [], store: Store, transport: any SyncTransport,
                          tokens: any TokenStore, forkGuard: any ForkGuardStore, clock: EngineClock, random: any RandomSource,
                          connectivity: any Connectivity, telemetry: any Telemetry = NoopTelemetry()) throws {
    try self.init(config: config, bindings: bindings, store: store, transport: transport, tokens: tokens, forkGuard: forkGuard,
                  clock: clock, random: random, identities: Identities(random: random), connectivity: connectivity, telemetry: telemetry)
  }

  // Construction runs engine start's first half (`EngineCore.launch`). `identities` mints every id and actor; the
  // transcript runner hands the corpus's queues. `tap` receives every event from the first transaction on, inside the
  // transaction's turn that published it.
  package init(config: EngineConfig, bindings: [any ProductBinding], store: Store, transport: any SyncTransport,
               tokens: any TokenStore, forkGuard: any ForkGuardStore, clock: EngineClock, random: any RandomSource,
               identities: any IdentitySource & Sendable, connectivity: any Connectivity,
               tap: (@Sendable (EngineEvent) -> Void)? = nil, telemetry: any Telemetry = NoopTelemetry()) throws {
    let core = EngineCore(config: config, bindings: bindings, store: store, tokens: tokens, clock: clock, random: random,
                          identities: identities, connectivity: connectivity, telemetry: telemetry)
    if let tap { core.publisher.tap(tap) }
    try core.launch(forkGuard: forkGuard)

    self.core = core
    self.transport = transport
    hub = ViewHub(core: core)
    sender = Sender(core: core, transport: transport)
    releaser = Releaser(core: core)
    puller = Puller(core: core, transport: transport)
    live = LiveChannel(core: core, transport: transport, puller: puller)
    sweeper = Sweeper(core: core)
    let (hub, changes) = (hub, core.publisher.changes)
    loops.withLock { $0.tasks.append(Task { @MainActor in await hub.run(changes) }) }
    connectivity.onChange { [weak core] _ in
      core?.wakes.kickAll()
      core?.publish(\.status)
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
    if let pending = try? core.storageRead({ try $0.deviceMeta()?.meta.pendingSignIn }) {
      _ = try? await continueSignIn(as: pending)
    } else {
      let seat = try? core.seat()
      let account = seat?.state == .bound && seat?.authPaused == false ? seat?.account : nil
      _ = await hello(token: account.flatMap { core.tokens.token(for: $0) })
    }
    core.pullWants.all()
    guard core.config.drivesLoops else { return }
    let (sender, releaser, puller, live, sweeper) = (sender, releaser, puller, live, sweeper)
    loops.withLock { loops in
      guard !loops.started else { return }
      loops.started = true
      loops.tasks += [
        Task { await sender.run() }, Task { await releaser.run() }, Task { await puller.run() }, Task { await live.run() },
        Task { await sweeper.run() },
      ]
    }
  }

  // §9.2 under `token`, or none: the answer's offset sample is recorded for the active replica (§10.4); an answer handled
  // as a 401 (§9.1: a 401, or a hello served as anyone but the active replica's account) pauses it while `token` is
  // still the account's; and a `minSchema` above the registry's version, or a 426, requires an upgrade.
  package func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    let send = core.clock.wall.reading()
    let reply = await transport.hello(token: token)
    let timing = Timing(send: send, recv: core.clock.wall.reading())
    guard case .answered(let answer) = reply else { return reply }
    if let serverTime = answer.serverTime { _ = try? core.write { store, _ in try store.sample(serverTime: serverTime, timing: timing) } }
    if let seat = try? core.seat(), answer.isUnauthenticated(for: seat.account) {
      _ = try? core.pauseAuth(seat.replica, sentUnder: token)
    }
    switch answer {
    case .ok(let hello): if hello.minSchema > core.registry.version { core.requireUpgrade() }
    case .failed(let failure): if failure.status == 426 { core.requireUpgrade() }
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
        try store.commit(in: scope, instance: instance, identities: core.identities) { [core, deviceNow = instance.deviceNow, actor = instance.actor.text] tx in
          let context = try TransactionReader(tx, core: core, scope: scope, deviceNow: deviceNow, actor: actor)
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

  // §7.12 the id of the replica commits, views, the sender and the puller act on, each change of it announced.
  public func activeReplica() throws -> String {
    try core.storageRead { try $0.activeReplica() }
  }

  // MARK: Observing (UI modules)

  // Each view is made `.loading` and loads off the main actor. Asking again for the same list answers the view already
  // live: one the UI holds, or one of the last views asked for, which the engine holds for a body that does not keep
  // its view. A type of another scope throws malformed, as the one-shot read does.
  @MainActor public func records(_ scope: ScopeRef, _ type: String, _ mode: ViewMode = .drawn) throws -> RecordsView {
    hub.records(RecordsView.Key(scope: scope, listing: try Listing(type, mode, in: scope, registry: core.registry)))
  }

  // ER-12: the records of `type` whose top-level ref `field` names `id`, the list `drawn(type, where:is:)` or
  // `stored(type, where:is:)` reads. A type of another scope, or a field that is no top-level ref of the type, throws
  // malformed, as that read does.
  @MainActor public func records(_ scope: ScopeRef, _ type: String, where field: String, is id: RecordID,
                                 _ mode: ViewMode = .drawn) throws -> RecordsView {
    let narrowing = Listing.Narrowing(field: field, id: id)
    return hub.records(RecordsView.Key(scope: scope, listing: try Listing(type, mode, where: narrowing, in: scope, registry: core.registry)))
  }

  @MainActor public func notices(_ product: String) -> NoticesView {
    hub.notices(product)
  }

  @MainActor public var undoOffers: UndoOffers { hub.undoOffers }
  @MainActor public var status: SyncStatus { hub.status }

  // Every event from now on, one stream per subscriber: terminal outcomes, telemetry and changes of the active replica.
  public func events() -> AsyncStream<EngineEvent> {
    core.publisher.events()
  }

  public func dismissNotice(_ id: String) throws {
    try core.write { store, _ in try store.dismissNotice(id) }
  }

  // Returns once the views have applied every change committed before the call, and each view made before it has loaded,
  // but for a view waiting to retry a read that failed.
  package func settle() async {
    await hub.settle()
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
    core.publish(\.firstPulls)
    core.pullWants.add([scope])
    core.wakes.puller.kick()
    core.wakes.live.kick()
    return outcome
  }

  // A scope that leaves the subscription set is forgotten, and its acked entries resolve.
  public func unsubscribe(_ scope: ScopeRef) throws {
    core.opened.withLock { $0.removeAll { $0 == scope } }
    try core.reconcileSubscriptions()
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

  // The leave flush: one drain, joined with the sender's loop; then the live socket is closed, unless the app came back
  // to the foreground while the flush ran and the socket it wants again is open.
  public func flushOnLeave() async {
    await sender.flushOnce()
    await live.closeInBackground()
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

  // What `notices(product)` and `undoOffers` show, read from the store now rather than through the main-actor views.
  package func currentNotices(_ product: String) throws -> [Notice] {
    try core.storageRead { try ViewHub.loadNotices($0, of: product) }
  }

  package func currentUndoOffers() throws -> [UndoOffer] {
    let deviceNow = core.clock.wall.nowMs()
    return try core.storageRead { try ViewHub.loadOffers($0, deviceNow: deviceNow) }
  }

  package var identities: any IdentitySource & Sendable { core.identities }

  // The scopes in doubt as they stand (§7.9).
  package var doubts: Doubts { core.doubts.withLock { $0 } }

  // The store's writer, as the engine's writes take it in turn (§2.5).
  package var writers: WriterLine { core.writers }

  // The sizes the engine's sliced steps take next (§2.5).
  package var slices: WriterSlices { core.slices.withLock { $0 } }
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
  let telemetry: any Telemetry
  let publisher = Publisher()
  let wakes = Wakes()
  let pullWants = PullWants()
  // A re-authentication cleared the pause: the live channel's next step opens its socket at once, with `k` reset.
  let liveReopensAtOnce = Atomic(false)
  let actor = Mutex(EngineCore.provisionalActor)
  let upgrade = Atomic(false)
  let foreground = Atomic(true)
  let opened = Mutex<[ScopeRef]>([])
  let doubts = Mutex(Doubts())
  let writers = WriterLine()
  let slices: Mutex<WriterSlices>
  // The thread inside a write, 0 when none: a write nested in one on the same thread (an engine call from a commit's
  // body) stops with a message instead of waiting on itself.
  let writingThread = Atomic<UInt64>(0)

  init(config: EngineConfig, bindings: [any ProductBinding], store: Store, tokens: any TokenStore, clock: EngineClock,
       random: any RandomSource, identities: any IdentitySource & Sendable, connectivity: any Connectivity,
       telemetry: any Telemetry = NoopTelemetry()) {
    self.config = config
    self.bindings = bindings
    self.store = store
    self.tokens = tokens
    self.clock = clock
    self.random = random
    self.identities = identities
    self.connectivity = connectivity
    let telemetry: any Telemetry = telemetry is NoopTelemetry || telemetry is BoundedTelemetry ? telemetry : BoundedTelemetry(telemetry)
    self.telemetry = telemetry
    slices = Mutex(WriterSlices(config.slicing))
    publisher.tap { event in
      switch event {
      case .digestMismatch(let kind, _):
        let kind = ["product", "tree", "overlay"].contains(kind) ? kind : "unknown"
        telemetry.failure("sync_digest", kind: "digest_mismatch", properties: ["scope_kind": kind])
      case .pushMalformed:
        telemetry.failure("sync_admission", kind: "malformed")
      case .ended, .activeReplicaChanged: break
      }
    }
  }

  var registry: Registry { store.registry }

  // One of the store's Actions, as this instance: its actor and the device clock now. Writes take the writer in the
  // order they asked for it, so a commit waiting while a pull's chunk holds it goes before the pull's next chunk
  // (§2.5). The actor is held for the whole transaction, so an actor a re-identify mints serves every later write, and
  // changes and events go out in commit order. A sign-in, a sign-out or a re-identify of the active replica ends every
  // doubt and wants every scope (§7.12). A write that renames or swaps the replicas, or changes the seat, wakes the
  // puller and the live channel, which then reconnects for the replica now active. A write that changes the outbox
  // while a scope waits for its governing record's create, or that touches a governing record and so may change the
  // subscription set, wakes both, which pull and follow the scopes that joined it (§7.9). One that takes rows out of
  // every view wakes the sweep.
  func write<Value>(_ action: (Store, inout Instance) throws -> Written<Value>) throws -> Value {
    try timedWrite(action).value
  }

  // The same, and how long it held the writer on the engine's clock, which sizes the next sliced step (§2.5).
  func timedWrite<Value>(_ action: (Store, inout Instance) throws -> Written<Value>) throws -> (value: Value, held: Duration) {
    var thread: UInt64 = 0
    pthread_threadid_np(nil, &thread)
    precondition(writingThread.load(ordering: .acquiring) != thread,
                 "an engine write inside another: a commit's body reads through its context and writes nothing")
    writers.enter()
    defer { writers.leave() }
    var written: (value: Value, change: StoreChange)?
    let held: Duration
    do {
      held = try clock.sleeper.measure {
        written = try actor.withLock { actor in
          writingThread.store(thread, ordering: .releasing)
          defer { writingThread.store(0, ordering: .releasing) }
          var instance = Instance(actor: actor, deviceNow: clock.wall.nowMs(), appVersion: config.appVersion)
          let written = try action(store, &instance)
          actor = instance.actor
          publisher.publish(written.change, written.events)
          return (written.value, written.change)
        }
      }
    } catch {
      reportStorage(error, operation: "storage_write")
      throw error
    }
    let (value, change) = written!
    if change.seat {
      doubts.withLock { $0.clear() }
      pullWants.all()
    }
    if change.replicas || change.seat || change.outbox && pullWants.isWaiting || touchesGoverningRecords(change) {
      wakes.puller.kick()
      wakes.live.kick()
    }
    if change.released { wakes.sweeper.kick() }
    return (value, held)
  }

  // A governing record changed, or a whole scope was swapped or forgotten, so the set may hold other trees now (§7.9).
  func touchesGoverningRecords(_ change: StoreChange) -> Bool {
    guard let governing = registry.governingType?.name else { return false }
    return !change.scopes.isEmpty || change.records.values.contains { $0.contains { $0.type.utf8.elementsEqual(governing.utf8) } }
  }

  // §7.9: a scope's first pull is complete once its cursor is booted, or while the subscription set does not hold it, so
  // it moves with a cursor, a known scope, the replica's state, the governing records and the scopes opened by hand.
  func movesFirstPulls(_ change: StoreChange) -> Bool {
    change.firstPulls || change.replicas || touchesGoverningRecords(change)
  }

  // Whether `scope`'s first pull is complete in `replica`, or the replica does not pull it (§7.9).
  func firstPullComplete(_ tx: StoreTransaction, of scope: ScopeRef, in replica: String) throws -> Bool {
    let lifecycle = ReplicaLifecycle(registry: registry)
    let subscriptions = subscriptions()
    guard let loaded = try tx.replica(replica, reads: lifecycle.reads(of: subscriptions), entries: EntrySelection()) else {
      throw StoreError.noReplica(replica)
    }
    return lifecycle.firstPullComplete(scope, in: loaded, subscribed: Set(try lifecycle.subscriptionSet(of: loaded, subscriptions)))
  }

  // §7.4, §7.5: no answer in REQUEST_TIMEOUT_MS is a transport error; cancelling the caller cancels the call too.
  func answered<Body: Sendable>(operation: String, _ call: @escaping @Sendable () async -> Reply<Body>) async
    -> (reply: Reply<Body>, failureKind: String?) {
    let diagnostics = TransportDiagnostics.Invocation()
    let start = clock.wall.reading().mono
    return await TransportDiagnostics.$invocation.withValue(diagnostics) {
      let reply = await withTaskGroup(of: RequestRace<Body>.self) { group in
        group.addTask { .answered(await call()) }
        group.addTask { [sleeper = clock.sleeper] in
          do {
            try await sleeper.sleep(for: .milliseconds(Constants.requestTimeoutMs))
            return .timedOut
          } catch {
            return .stopped
          }
        }
        while let first = await group.next() {
          switch first {
          case .answered(let reply):
            group.cancelAll()
            return reply
          case .timedOut:
            if !Task.isCancelled {
              TransportDiagnostics.report(telemetry, operation: operation, method: "POST", kind: "timeout",
                                          durationMs: max(0, clock.wall.reading().mono - start))
            }
            group.cancelAll()
            return .unreachable
          case .stopped:
            continue
          }
        }
        return .unreachable
      }
      return (reply, diagnostics.kind.withLock { $0 })
    }
  }

  func read<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T {
    try storageRead { tx in
      let reader = try TransactionReader(tx, core: self, scope: scope, deviceNow: clock.wall.nowMs())
      defer { reader.end() }
      return try body(reader)
    }
  }

  // The active replica's meta.
  func seat() throws -> ReplicaMeta? {
    try storageRead { tx in try tx.meta(of: tx.activeReplica()) }
  }

  // The central read/write boundaries report only storage failures, preserving product/body errors as thrown.
  func storageRead<T>(_ body: (StoreTransaction) throws -> T) throws -> T {
    try storageOperation { try store.read(body) }
  }

  func storageOperation<T>(_ body: () throws -> T) throws -> T {
    do { return try body() }
    catch {
      reportStorage(error, operation: "storage_read")
      throw error
    }
  }

  func reportStorage(_ error: any Error, operation: String) {
    if let kind = Store.failureKind(error) { telemetry.failure(operation, kind: kind) }
  }

  func outcome<Body: Sendable>(_ name: String, reply: Reply<Body>, since start: Int64, failureKind: String? = nil) {
    guard !Task.isCancelled else { return }
    let properties: [String: String]
    switch reply {
    case .answered(.ok): properties = ["outcome": "ok"]
    case .answered(.failed(let failure)):
      properties = ["outcome": "failed", "failure_kind": "http", "status": String(failure.status)]
    case .unreachable: properties = ["outcome": "failed", "failure_kind": failureKind ?? "transport"]
    }
    telemetry.event(name, properties: properties, durationMs: max(0, clock.wall.reading().mono - start))
  }

  func failedOutcome(_ name: String, error: any Error, since start: Int64) {
    guard !Task.isCancelled else { return }
    let kind = Store.failureKind(error) ?? "unexpected_admission"
    telemetry.event(name, properties: ["outcome": "failed", "failure_kind": kind],
                    durationMs: max(0, clock.wall.reading().mono - start))
    if kind == "unexpected_admission" { telemetry.failure("sync_admission", kind: kind) }
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

  // §7.9 "When a scope leaves the subscription set, its acked entries resolve": every scope outside the set is forgotten,
  // and every acked entry outside it resolves, since no pull will bring its row. The set is read inside the write, so a
  // scope subscribed meanwhile stays. It runs when a scope is closed, and at each pull round: a scope the last process
  // held open is not open in this one, and an entry may be acked in a scope no longer followed. Answers the set.
  @discardableResult
  func reconcileSubscriptions() throws -> [ScopeRef] {
    try write { store, _ in try store.reconcile(subscriptions()) }
  }

  // §7.9 the active replica's own subscription set: the products its surface carries, the trees its governing records
  // hold alive, and the scopes opened by hand. A transaction reads it against the replica as it then stands.
  func subscriptions() -> SubscriptionSet {
    .own(Subscriptions(
      products: registry.products.filter { $0.surfaces.contains(config.surface) }.map(\.name), opened: opened.withLock { $0 }))
  }

  var isForeground: Bool { foreground.load(ordering: .relaxed) }

  // 426: nothing more is sent or pulled until the app is upgraded; the status says so.
  var upgradeRequired: Bool { upgrade.load(ordering: .relaxed) }

  func requireUpgrade() {
    upgrade.store(true, ordering: .relaxed)
    publish(\.status)
    wakes.live.kick()
  }

  // What the store does not hold changed: the status (connectivity, an upgrade required), or the first pulls (the
  // scopes opened by hand).
  func publish(_ changed: WritableKeyPath<StoreChange, Bool>) {
    var change = StoreChange()
    change[keyPath: changed] = true
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

// How a request's race against REQUEST_TIMEOUT_MS ended for one of its two runners.
enum RequestRace<Body: Sendable>: Sendable {
  case answered(Reply<Body>)
  case timedOut
  case stopped
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
      let due = try core.storageRead { tx in
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

// MARK: - The sweep

package enum SweeperStep: Sendable, Hashable {
  case again
  case idle
  case wait(ms: Int64)
}

// §2.5 deletes the rows no view reads any more, a slice a transaction, each taking the writer in its turn beside commits.
package final class Sweeper: Sendable {
  let core: EngineCore

  init(core: EngineCore) {
    self.core = core
  }

  package var wake: Wake { core.wakes.sweeper }

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

  // One slice; a store that fails is tried again in a second.
  package func step() -> SweeperStep {
    do {
      return try core.write { store, _ in try store.sweep() } ? .again : .idle
    } catch {
      return .wait(ms: Constants.backoffBaseMs)
    }
  }
}
