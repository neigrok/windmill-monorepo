import Observation
import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import Synchronization

// The observation pipeline (design §4.5): each committed transaction's `StoreChange` goes, in commit order, to one
// main-actor loop that refreshes the live views from SQLite, and its events go to every subscriber. Views refresh per
// touched record, or whole when a change reaches a whole scope or the replicas themselves.

// MARK: - Publishing

final class Publisher: Sendable {
  struct State {
    var sequence: UInt64 = 0
    var nextSubscriber = 0
    var subscribers: [Int: AsyncStream<EngineEvent>.Continuation] = [:]
  }

  let changes: AsyncStream<(sequence: UInt64, change: StoreChange)>
  let feed: AsyncStream<(sequence: UInt64, change: StoreChange)>.Continuation
  let state = Mutex(State())

  init() {
    (changes, feed) = AsyncStream.makeStream()
  }

  // Called inside the writer's turn, so changes and events keep commit order; an empty change is not sent.
  func publish(_ change: StoreChange, _ events: [EngineEvent]) {
    state.withLock { state in
      if !change.isEmpty {
        state.sequence += 1
        feed.yield((state.sequence, change))
      }
      for event in events {
        for subscriber in state.subscribers.values { subscriber.yield(event) }
      }
    }
  }

  // The sequence of the last change sent to the views.
  var published: UInt64 { state.withLock(\.sequence) }

  func events() -> AsyncStream<EngineEvent> {
    let (stream, continuation) = AsyncStream<EngineEvent>.makeStream()
    let id = state.withLock { state in
      state.nextSubscriber += 1
      state.subscribers[state.nextSubscriber] = continuation
      return state.nextSubscriber
    }
    continuation.onTermination = { [weak self] _ in self?.state.withLock { $0.subscribers[id] = nil } }
    return stream
  }

  func finish() {
    feed.finish()
    let subscribers = state.withLock { state in
      defer { state.subscribers = [:] }
      return Array(state.subscribers.values)
    }
    for subscriber in subscribers { subscriber.finish() }
  }
}

// MARK: - The hub

@MainActor
final class ViewHub {
  struct Weak<View: AnyObject> {
    weak var view: View?
  }

  let core: EngineCore
  var liveRecords: [RecordsView.Key: Weak<RecordsView>] = [:]
  // Keyed by the product's bytes, so products that differ only by canonical equivalence are two views.
  var liveNotices: [[UInt8]: Weak<NoticesView>] = [:]
  var offersView: UndoOffers?
  var statusView: SyncStatus?
  var applied: UInt64 = 0
  var settling: [(through: UInt64, continuation: CheckedContinuation<Void, Never>)] = []

  // Built beside the engine; each view is made on first use, loaded as the store stands.
  nonisolated init(core: EngineCore) {
    self.core = core
  }

  // The one consumer of the published changes: each is applied whole before the next, so no view goes back in time.
  func run(_ changes: AsyncStream<(sequence: UInt64, change: StoreChange)>) async {
    for await (sequence, change) in changes {
      await apply(change)
      applied = sequence
      let settled = settling.filter { $0.through <= sequence }
      settling.removeAll { $0.through <= sequence }
      for waiter in settled { waiter.continuation.resume() }
    }
    for waiter in settling { waiter.continuation.resume() }
    settling = []
  }

  // Returns once every change up to `sequence` is applied.
  func settle(through sequence: UInt64) async {
    guard applied < sequence else { return }
    await withCheckedContinuation { settling.append((sequence, $0)) }
  }

  // The views are pruned of released ones before any load, so a view made again while a load is awaited stays live.
  func apply(_ change: StoreChange) async {
    let everything = change.replicas
    liveRecords = liveRecords.filter { $0.value.view != nil }
    liveNotices = liveNotices.filter { $0.value.view != nil }
    for (key, entry) in liveRecords {
      guard let view = entry.view else { continue }
      let touched = change.records[key.scope].map { Set($0.filter { $0.type.utf8.elementsEqual(key.type.utf8) }) } ?? []
      if everything || change.scopes.contains(key.scope) || !view.isWhole {
        guard let loaded = await load({ [core] tx in try Self.loadRecords(tx, key, core: core) }) else { continue }
        view.replace(loaded.records, firstPullComplete: loaded.firstPullComplete)
      } else if !touched.isEmpty || change.status {
        guard let loaded = await load({ [core] tx in try Self.loadRecords(tx, key, only: touched, core: core) }) else { continue }
        view.update(loaded.records, of: touched, firstPullComplete: loaded.firstPullComplete)
      }
    }
    if everything || change.notices {
      for entry in liveNotices.values {
        guard let view = entry.view else { continue }
        let product = view.product
        if let loaded = await load({ tx in try Self.loadNotices(tx, of: product) }) { view.notices = loaded }
      }
    }
    if let offersView, everything || change.outbox {
      let deviceNow = core.clock.wall.nowMs()
      if let offers = await load({ tx in try Self.loadOffers(tx, deviceNow: deviceNow) }), offers != offersView.offers {
        offersView.offers = offers
      }
    }
    if let statusView, everything || change.outbox || change.status {
      if let snapshot = await load({ [core] tx in try Self.loadStatus(tx, core: core) }) { statusView.apply(snapshot) }
    }
  }

  var undoOffers: UndoOffers {
    if let offersView { return offersView }
    let deviceNow = core.clock.wall.nowMs()
    let view = UndoOffers(offers: (try? core.store.read { try Self.loadOffers($0, deviceNow: deviceNow) }) ?? [])
    offersView = view
    return view
  }

  var status: SyncStatus {
    if let statusView { return statusView }
    let view = SyncStatus(try? core.store.read { try Self.loadStatus($0, core: core) })
    statusView = view
    return view
  }

  func records(_ key: RecordsView.Key) -> RecordsView {
    if let view = liveRecords[key]?.view { return view }
    let loaded = try? core.store.read { try Self.loadRecords($0, key, core: core) }
    let view = RecordsView(key: key, records: loaded?.records, firstPullComplete: loaded?.firstPullComplete ?? false)
    liveRecords[key] = Weak(view: view)
    return view
  }

  func notices(_ product: String) -> NoticesView {
    if let view = liveNotices[Array(product.utf8)]?.view { return view }
    let view = NoticesView(product: product, notices: (try? core.store.read { try Self.loadNotices($0, of: product) }) ?? [])
    liveNotices[Array(product.utf8)] = Weak(view: view)
    return view
  }

  // MARK: Loads

  // A new view loads once on the main actor, so it shows the store at once; every refresh reads on the concurrent
  // executor, and a read that fails leaves the views as they are until the next change.
  @concurrent nonisolated func load<Value: Sendable>(_ read: @Sendable (StoreTransaction) throws -> Value) async -> Value? {
    try? core.store.read(read)
  }

  nonisolated static func loadRecords(_ tx: StoreTransaction, _ key: RecordsView.Key, only keys: Set<RecordKey>? = nil,
                                  core: EngineCore) throws -> (records: [RecordKey: Record], firstPullComplete: Bool) {
    let reader = try TransactionReader(tx, core: core, scope: key.scope, deviceNow: core.clock.wall.nowMs())
    let firstPullComplete = try reader.firstPullComplete()
    guard let keys else {
      let records = try reader.records(ofType: key.type, key.mode)
      return (Dictionary(uniqueKeysWithValues: records.map { (RecordKey($0.type, $0.id), $0) }), firstPullComplete)
    }
    return (try reader.records(keys, key.mode), firstPullComplete)
  }

  nonisolated static func loadNotices(_ tx: StoreTransaction, of product: String) throws -> [Notice] {
    let active = try tx.activeReplica()
    return try tx.replica(active, notices: true)?.notices.filter { !$0.isDismissed && $0.product.utf8.elementsEqual(product.utf8) } ?? []
  }

  // §7.3: a held gesture is offered for Undo while every entry of it is held and `releaseAt` is still ahead.
  nonisolated static func loadOffers(_ tx: StoreTransaction, deviceNow: Int64) throws -> [UndoOffer] {
    let active = try tx.activeReplica()
    let outbox = try tx.replica(active)?.outbox ?? []
    var offers: [UndoOffer] = []
    for entry in outbox where !offers.contains(where: { $0.id.utf8.elementsEqual(entry.gestureId.utf8) }) {
      let gesture = outbox.filter { $0.gestureId.utf8.elementsEqual(entry.gestureId.utf8) }
      guard gesture.allSatisfy({ $0.state == .held }), entry.releaseAt > deviceNow else { continue }
      offers.append(UndoOffer(id: entry.gestureId, scope: entry.scope, releaseAt: entry.releaseAt))
    }
    return offers
  }

  nonisolated static func loadStatus(_ tx: StoreTransaction, core: EngineCore) throws -> SyncStatus.Snapshot {
    guard let device = try tx.deviceMeta(), let replica = try tx.replica(device.active) else { throw StoreError.noDevice }
    return SyncStatus.Snapshot(
      account: replica.meta.state == .bound ? replica.meta.account : nil, authPaused: replica.meta.authPaused,
      upgradeRequired: core.upgradeRequired, online: core.connectivity.isOnline, pendingSignIn: device.meta.pendingSignIn,
      ready: replica.outbox.filter { $0.state == .ready }.count, sent: replica.outbox.filter { $0.state == .sent }.count)
  }
}

// MARK: - Views

// The visible records of one type of one scope, drawn or stored, as the store holds them after every applied change.
@MainActor @Observable
public final class RecordsView {
  struct Key: Hashable, Sendable {
    let scope: ScopeRef
    let type: String
    let mode: ViewMode
  }

  public let scope: ScopeRef
  public let type: String
  public let mode: ViewMode
  public private(set) var records: [RecordID: Record]
  public private(set) var firstPullComplete: Bool
  // False while the view holds less than its whole type: its first load failed, so the next change reloads it whole.
  @ObservationIgnored var isWhole: Bool

  // `records` nil: the store could not be read yet.
  init(key: Key, records: [RecordKey: Record]?, firstPullComplete: Bool) {
    scope = key.scope
    type = key.type
    mode = key.mode
    self.records = Dictionary(uniqueKeysWithValues: (records ?? [:]).values.filter(\.isVisible).map { ($0.id, $0) })
    self.firstPullComplete = firstPullComplete
    isWhole = records != nil
  }

  func replace(_ loaded: [RecordKey: Record], firstPullComplete: Bool) {
    let visible = Dictionary(uniqueKeysWithValues: loaded.values.filter(\.isVisible).map { ($0.id, $0) })
    if visible != records { records = visible }
    if firstPullComplete != self.firstPullComplete { self.firstPullComplete = firstPullComplete }
    isWhole = true
  }

  // The touched records as loaded: a visible one is set, any other removed.
  func update(_ loaded: [RecordKey: Record], of touched: Set<RecordKey>, firstPullComplete: Bool) {
    var next = records
    for key in touched {
      next[key.id] = loaded[key].flatMap { $0.isVisible ? $0 : nil }
    }
    if next != records { records = next }
    if firstPullComplete != self.firstPullComplete { self.firstPullComplete = firstPullComplete }
  }
}

// The durable refusals of one product in the active replica (D-17) that the person has not dismissed, in the order they
// were written.
@MainActor @Observable
public final class NoticesView {
  public let product: String
  public internal(set) var notices: [Notice]

  init(product: String, notices: [Notice]) {
    self.product = product
    self.notices = notices
  }
}

// The held gestures Undo can still remove (§7.3), each until its `releaseAt` on the device clock.
@MainActor @Observable
public final class UndoOffers {
  public internal(set) var offers: [UndoOffer]

  init(offers: [UndoOffer]) {
    self.offers = offers
  }
}

// What the person may need to know about sync: who is signed in, a pause waiting for re-authentication, an upgrade the
// server requires, the network, the unsent entries (a sent one may already have landed), and an unfinished sign-in.
@MainActor @Observable
public final class SyncStatus {
  struct Snapshot: Sendable, Equatable {
    var account: String?
    var authPaused = false
    var upgradeRequired = false
    var online = true
    var pendingSignIn: String?
    var ready = 0
    var sent = 0

    static func == (lhs: Snapshot, rhs: Snapshot) -> Bool {
      lhs.account.map { Array($0.utf8) } == rhs.account.map { Array($0.utf8) } && lhs.authPaused == rhs.authPaused
        && lhs.upgradeRequired == rhs.upgradeRequired && lhs.online == rhs.online
        && lhs.pendingSignIn.map { Array($0.utf8) } == rhs.pendingSignIn.map { Array($0.utf8) } && lhs.ready == rhs.ready
        && lhs.sent == rhs.sent
    }
  }

  public private(set) var account: String?
  public private(set) var authPaused = false
  public private(set) var upgradeRequired = false
  public private(set) var online = true
  public private(set) var pendingSignIn: String?
  public private(set) var ready = 0
  public private(set) var sent = 0

  // A store that cannot be read yet shows the defaults until the next change.
  init(_ snapshot: Snapshot?) {
    if let snapshot { apply(snapshot) }
  }

  var snapshot: Snapshot {
    Snapshot(account: account, authPaused: authPaused, upgradeRequired: upgradeRequired, online: online,
             pendingSignIn: pendingSignIn, ready: ready, sent: sent)
  }

  func apply(_ next: Snapshot) {
    guard next != snapshot else { return }
    account = next.account
    authPaused = next.authPaused
    upgradeRequired = next.upgradeRequired
    online = next.online
    pendingSignIn = next.pendingSignIn
    ready = next.ready
    sent = next.sent
  }
}
