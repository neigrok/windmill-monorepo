import Observation
import SyncAPI
import SyncCore
import SyncReplica
import SyncStore
import Synchronization

// The observation pipeline (design §4.5): each committed transaction's `StoreChange` goes, in commit order, to one
// main-actor loop that refreshes the live views from SQLite, and its events go to every subscriber. Every read of a
// records view runs off the main actor, which only shows what the read made. A records view is loaded whole once it is
// made, by a lane of first loads beside the loop, and again after a change that reaches its whole scope or the
// replicas themselves; any other change reads only the records of its type the change touched.

// MARK: - Publishing

final class Publisher: Sendable {
  struct State {
    var sequence: UInt64 = 0
    var nextSubscriber = 0
    var subscribers: [Int: AsyncStream<EngineEvent>.Continuation] = [:]
    var taps: [@Sendable (EngineEvent) -> Void] = []
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
        for tap in state.taps { tap(event) }
      }
    }
  }

  // Every event from now on, handed over inside the writer's turn: a step-mode harness sees each one before the step
  // that published it returns.
  func tap(_ tap: @escaping @Sendable (EngineEvent) -> Void) {
    state.withLock { $0.taps.append(tap) }
  }

  // An empty change: the views take a turn with nothing new, in which each reads what it owes (after a first load landed,
  // or at a retry).
  func nudge() {
    state.withLock { state in
      state.sequence += 1
      feed.yield((state.sequence, StoreChange()))
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

  // A records view's read that failed is tried again after the first of these, and after the next each time it fails
  // again.
  static let retryMs: [Int64] = [100, 200, 400, 800, 1_600, 3_200]
  // How many of the records views asked for last the hub holds, so a UI that asks again without keeping its view (a
  // SwiftUI body) finds it live and loaded.
  static let heldRecent = 8

  let core: EngineCore
  var liveRecords: [RecordsView.Key: Weak<RecordsView>] = [:]
  // The records views asked for last, the most recent last.
  var recent: [RecordsView] = []
  // The lane of first loads, while a view waits for its first load.
  var firstLoads: Task<Void, Never>?
  // The retry of the records views' failed reads, while one is due.
  var retry: Task<Void, Never>?
  // Keyed by the product's bytes, so products that differ only by canonical equivalence are two views.
  var liveNotices: [[UInt8]: Weak<NoticesView>] = [:]
  var offersView: UndoOffers?
  var statusView: SyncStatus?
  var begun: UInt64 = 0
  var applied: UInt64 = 0
  var beginning: [(sequence: UInt64, continuation: CheckedContinuation<Void, Never>)] = []
  var settling: [(through: UInt64, continuation: CheckedContinuation<Void, Never>)] = []

  // Built beside the engine; each view is made on first use.
  nonisolated init(core: EngineCore) {
    self.core = core
  }

  // The one consumer of the published changes: each is applied whole before the next, so no view goes back in time.
  func run(_ changes: AsyncStream<(sequence: UInt64, change: StoreChange)>) async {
    for await (sequence, change) in changes {
      begun = sequence
      let begins = beginning.filter { $0.sequence <= sequence }
      beginning.removeAll { $0.sequence <= sequence }
      for waiter in begins { waiter.continuation.resume() }
      await apply(change)
      applied = sequence
      let settled = settling.filter { $0.through <= sequence }
      settling.removeAll { $0.through <= sequence }
      for waiter in settled { waiter.continuation.resume() }
    }
    for waiter in beginning { waiter.continuation.resume() }
    for waiter in settling { waiter.continuation.resume() }
    beginning = []
    settling = []
  }

  // Returns once the hub has begun applying change `sequence`. The hub holds the main actor until its first load, so a
  // caller on the main actor runs again while that load is awaited, or once the change is applied.
  func begins(_ sequence: UInt64) async {
    guard begun < sequence else { return }
    await withCheckedContinuation { beginning.append((sequence, $0)) }
  }

  // Returns once every change up to `sequence` is applied.
  func applied(through sequence: UInt64) async {
    guard applied < sequence else { return }
    await withCheckedContinuation { settling.append((sequence, $0)) }
  }

  // Returns once every change published before the call is applied and no view waits for its first load, but for a view
  // waiting to retry a read that failed.
  func settle() async {
    while true {
      if let firstLoads {
        await firstLoads.value
        continue
      }
      let published = core.publisher.published
      guard applied < published else { return }
      await applied(through: published)
    }
  }

  // The views are pruned of released ones before any load, so a view made again while a load is awaited stays live.
  func apply(_ change: StoreChange) async {
    let everything = change.replicas
    liveRecords = liveRecords.filter { $0.value.view != nil }
    liveNotices = liveNotices.filter { $0.value.view != nil }
    await refreshRecords(owing: change)
    if everything || change.notices {
      for entry in liveNotices.values {
        guard let view = entry.view else { continue }
        let product = view.product
        if let loaded = try? await load({ tx in try Self.loadNotices(tx, of: product) }) { view.notices = loaded }
      }
    }
    if let offersView, everything || change.outbox {
      let deviceNow = core.clock.wall.nowMs()
      if let offers = try? await load({ tx in try Self.loadOffers(tx, deviceNow: deviceNow) }), offers != offersView.offers {
        offersView.offers = offers
      }
    }
    if let statusView, everything || change.outbox || change.status {
      if let snapshot = try? await load({ [core] tx in try Self.loadStatus(tx, core: core) }) { statusView.apply(snapshot) }
    }
  }

  // Every records view owes `change` until a read of it lands. One not yet loaded owes it to its first load, and one
  // waiting to retry a read to the retry; any other reads now what may have changed of what it shows. A scope's first
  // pull is read once in the turn, and only when the changes may have moved it.
  func refreshRecords(owing change: StoreChange) async {
    let views = liveRecords.values.compactMap(\.view)
    for view in views { view.owed.merge(change) }
    var firstPulls: [ScopeRef: Bool] = [:]
    for view in views {
      guard case .loaded(let shown) = view.state, !view.waitsForRetry else { continue }
      let (key, owed) = (view.key, view.beginRead())
      do {
        if core.movesFirstPulls(owed), firstPulls[key.scope] == nil {
          firstPulls[key.scope] = try await load { [core] tx in try core.firstPullComplete(tx, of: key.scope, in: tx.activeReplica()) }
        }
        switch view.refresh(of: shown, owing: owed, firstPullComplete: firstPulls[key.scope]) {
        case .none: view.land(nil)
        case .show(let next): view.land(next)
        case .read(let read): view.land(try await load { [core] tx in try Self.loadRecords(tx, key, read, core: core) })
        }
      } catch {
        fail(view, owing: owed)
      }
    }
  }

  // The lane of first loads: one view at a time, in a task of its own, so no refresh waits behind a first load and the
  // first loads take one of the store's readers at most. What is applied while a view loads stays owed, and is read in
  // the turn its landing asks for.
  func loadFirst() {
    guard firstLoads == nil, liveRecords.values.contains(where: { $0.view?.awaitsFirstLoad == true }) else { return }
    firstLoads = Task { [weak self] in
      while let hub = self, let view = hub.liveRecords.values.lazy.compactMap(\.view).first(where: \.awaitsFirstLoad) {
        let (key, owed, core) = (view.key, view.beginRead(), hub.core)
        do {
          view.land(try await hub.load { tx in try Self.loadRecords(tx, key, .whole(shown: nil), core: core) })
        } catch {
          hub.fail(view, owing: owed)
        }
        core.publisher.nudge()
      }
      self?.firstLoads = nil
    }
  }

  // A read for `view` failed: it owes again what the read was to read, and waits for the retry, which is due after the
  // backoff of the reads the view failed in a row unless one is due already. At the retry every waiting view reads again,
  // one not loaded in the lane of first loads.
  func fail(_ view: RecordsView, owing owed: StoreChange) {
    view.fail(owing: owed)
    guard retry == nil else { return }
    let ms = Self.retryMs[min(view.failures, Self.retryMs.count) - 1]
    retry = Task { [weak self, sleeper = core.clock.sleeper] in
      try? await sleeper.sleep(for: .milliseconds(ms))
      guard let self else { return }
      retry = nil
      for view in liveRecords.values.compactMap(\.view) { view.waitsForRetry = false }
      loadFirst()
      core.publisher.nudge()
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

  // The live view of `key`, or one made `.loading`, which the lane of first loads loads. The last views asked for stay
  // held.
  func records(_ key: RecordsView.Key) -> RecordsView {
    let view = liveRecords[key]?.view ?? RecordsView(key: key)
    liveRecords[key] = Weak(view: view)
    recent.removeAll { $0 === view }
    recent.append(view)
    if recent.count > Self.heldRecent { recent.removeFirst() }
    loadFirst()
    return view
  }

  func notices(_ product: String) -> NoticesView {
    if let view = liveNotices[Array(product.utf8)]?.view { return view }
    let view = NoticesView(product: product, notices: (try? core.store.read { try Self.loadNotices($0, of: product) }) ?? [])
    liveNotices[Array(product.utf8)] = Weak(view: view)
    return view
  }

  // MARK: Loads

  // Every read of a records view runs on the concurrent executor; a notices view, the Undo offers and the status, each
  // a small read, load on the main actor when first asked for, and one whose read fails keeps what it shows until the
  // next change.
  @concurrent nonisolated func load<Value: Sendable>(_ read: @Sendable (StoreTransaction) throws -> Value) async throws -> Value {
    try core.store.read(read)
  }

  // What `read` makes of the view `key`: the snapshot to show, or nil when the view shows it already.
  nonisolated static func loadRecords(_ tx: StoreTransaction, _ key: RecordsView.Key, _ read: RecordsView.Read,
                                      core: EngineCore) throws -> RecordsView.Snapshot? {
    let reader = try TransactionReader(tx, core: core, scope: key.scope, deviceNow: core.clock.wall.nowMs())
    switch read {
    case .whole(let shown):
      let loaded = RecordsView.Snapshot(records: try reader.records(key.listing), firstPullComplete: try reader.firstPullComplete())
      return loaded == shown ? nil : loaded
    case .records(let touched, let shown, let firstPullComplete):
      return shown.updating(touched, to: try reader.records(touched, in: key.listing), firstPullComplete: firstPullComplete)
    }
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

// The visible records of one type of one scope, drawn or stored, every one or only those whose top-level ref field names
// an id (ER-12), as the store holds them after every applied change. The view is `.loading` until its first load, read
// off the main actor, lands. A change then reads again only the records of its type it touched: a change to one the
// view does not list costs it one read of that record, and a change that touches none of its type costs it no read, but
// the one read of its scope's first pull all the scope's views share when the change may have moved it.
@MainActor @Observable
public final class RecordsView {
  struct Key: Hashable, Sendable {
    let scope: ScopeRef
    let listing: Listing
  }

  public enum State: Sendable, Equatable {
    case loading
    case loaded(Snapshot)
  }

  // What a loaded view lists: its records in id-byte order, as the one-shot read of the same list returns them, and
  // whether the scope's first pull is complete (§7.9).
  public struct Snapshot: Sendable, Equatable {
    public let records: [Record]
    public let firstPullComplete: Bool

    public init(records: [Record], firstPullComplete: Bool) {
      self.records = records
      self.firstPullComplete = firstPullComplete
    }

    // The record of `id`, found by its bytes, which order the records.
    public func record(_ id: RecordID) -> Record? {
      let index = position(of: id)
      return index < records.count && records[index].id == id ? records[index] : nil
    }

    // Where `id` is or would go: the first record whose id is not below it.
    func position(of id: RecordID) -> Int {
      var (low, high) = (0, records.count)
      while low < high {
        let middle = (low + high) / 2
        if records[middle].id < id { low = middle + 1 } else { high = middle }
      }
      return low
    }

    // The snapshot once the records `touched` were read again: each one `held`, which the list still holds, in its place
    // as read, the other touched ones gone, and the records between them as they were; nil when nothing shown changes.
    func updating(_ touched: Set<RecordKey>, to held: [RecordKey: Record], firstPullComplete: Bool) -> Snapshot? {
      let unchanged = firstPullComplete == self.firstPullComplete && touched.allSatisfy { record($0.id) == held[$0] }
      guard !unchanged else { return nil }
      var next: [Record] = []
      next.reserveCapacity(records.count + held.count)
      var kept = 0
      for key in touched.sorted(by: { $0.id < $1.id }) {
        let index = position(of: key.id)
        next += records[kept..<index]
        if let record = held[key] { next.append(record) }
        kept = index < records.count && records[index].id == key.id ? index + 1 : index
      }
      next += records[kept...]
      return Snapshot(records: next, firstPullComplete: firstPullComplete)
    }
  }

  // A read a view needs: the records of its type some changes touched, the others kept as `shown` has them, beside its
  // scope's first pull; or every record and the first pull, to replace what it shows, nil before its first load.
  enum Read: Sendable {
    case records(Set<RecordKey>, shown: Snapshot, firstPullComplete: Bool)
    case whole(shown: Snapshot?)
  }

  // What the changes a view owes ask of it: nothing, a snapshot shown at once, or a read.
  enum Refresh: Sendable {
    case none
    case show(Snapshot)
    case read(Read)
  }

  let key: Key
  public private(set) var state = State.loading
  // What was applied since the view's read in flight, or its last read, began: its next read reads it again.
  @ObservationIgnored var owed = StoreChange()
  // The view's reads that failed in a row; after one, it reads nothing until the hub's retry.
  @ObservationIgnored var failures = 0
  @ObservationIgnored var waitsForRetry = false

  init(key: Key) {
    self.key = key
  }

  public var scope: ScopeRef { key.scope }
  public var type: String { key.listing.type }
  public var mode: ViewMode { key.listing.mode }

  var awaitsFirstLoad: Bool {
    guard case .loading = state else { return false }
    return !waitsForRetry
  }

  // What the changes `owed` ask of the view showing `shown`, `firstPullComplete` being its scope's first pull read again
  // in this turn: every record read again after a change to its whole scope or to the replicas; else the records of its
  // type the changes touched; else the first pull alone, shown at once when it moved; else nothing.
  func refresh(of shown: Snapshot, owing owed: StoreChange, firstPullComplete: Bool?) -> Refresh {
    if owed.replicas || owed.scopes.contains(key.scope) { return .read(.whole(shown: shown)) }
    let type = key.listing.type
    let touched: Set<RecordKey> = owed.records[key.scope]?.filter { $0.type.utf8.elementsEqual(type.utf8) } ?? []
    let firstPull = firstPullComplete ?? shown.firstPullComplete
    if !touched.isEmpty { return .read(.records(touched, shown: shown, firstPullComplete: firstPull)) }
    guard firstPull != shown.firstPullComplete else { return .none }
    return .show(Snapshot(records: shown.records, firstPullComplete: firstPull))
  }

  // A read begins: it takes what the view owes, and the view owes afresh what is applied while it runs.
  func beginRead() -> StoreChange {
    defer { owed = StoreChange() }
    return owed
  }

  // A read for the view landed: `next` is shown, unless the view shows it already.
  func land(_ next: Snapshot?) {
    if let next { state = .loaded(next) }
    failures = 0
  }

  // A read for the view failed: it owes again what the read was to read, and waits for the hub's retry.
  func fail(owing read: StoreChange) {
    var owing = read
    owing.merge(owed)
    owed = owing
    failures += 1
    waitsForRetry = true
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
