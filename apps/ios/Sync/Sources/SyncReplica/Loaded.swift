import SyncAPI
import SyncCore

// The working copy a planner changes: what an Action loaded of one replica, or of the device, and every write since.
// A copy changes only by `apply`, which records the write, so its writes are the whole batch the store commits.

// MARK: - One replica

public struct LoadedReplica: Sendable {
  public private(set) var meta: ReplicaMeta
  // The entries the load read and every one written since, in commit order: the whole outbox, or what `entrySelection`
  // names, and then `unreadCommitOrder` is the highest commit order among the entries it left unread, 0 when none.
  private(set) var loadedEntries: [OutboxEntry]
  let entrySelection: EntrySelection
  let unreadCommitOrder: Int64
  // The scopes uncovered projections target as the load found them, which a partial load cannot read off its entries.
  let loadedProjectionTargets: [ScopeRef]
  public private(set) var confirmed: [ScopeRef: Rows]
  public private(set) var staging: [ScopeRef: Staging]
  public private(set) var spent: [ScopeRef: [RecordKey: SpentID]]
  public private(set) var cursors: [ScopeRef: CursorRecord]
  public private(set) var known: [ScopeRef: KnownKind]
  private(set) var loadedNotices: [Notice]?
  public private(set) var deviceRows: [String: JSON.Object]
  // K-3 the journal (§7.3 Undo of an act): whole, with the entries it names, or nil when the load read none of it.
  private(set) var loadedJournal: Journal?
  // The inverse requests unsettled as the load found them: each one this transaction settles is reported.
  let loadedUnsettledRequests: [String]
  public private(set) var writes: [StoreWrite] = []
  public private(set) var events: [EngineEvent] = []
  public private(set) var change = StoreChange()
  // Every scope's rows were loaded, so a scope absent from `confirmed` holds none; otherwise reading it traps.
  public private(set) var wholeScopes: Bool
  // The device's active replica (§7.12): a re-identify of it announces its new id.
  public internal(set) var isActive: Bool

  // Cursors, known scopes and staging digests are always loaded whole; rows, outbox entries, notices and the journal as a
  // planner needs, `notices` and `journal` nil when they were not loaded. Device rows are keyed by product, then by their
  // key's bytes.
  public init(meta: ReplicaMeta, outbox: [OutboxEntry] = [], entries: EntrySelection = .every, unreadCommitOrder: Int64 = 0,
              projectionTargets: [ScopeRef] = [], confirmed: [ScopeRef: Rows] = [:], staging: [ScopeRef: Staging] = [:],
              spent: [ScopeRef: [RecordKey: SpentID]] = [:], cursors: [ScopeRef: CursorRecord] = [:],
              known: [ScopeRef: KnownKind] = [:], notices: [Notice]? = [], deviceRows: [String: JSON.Object] = [:],
              journal: Journal? = Journal(), wholeScopes: Bool, isActive: Bool = false) {
    self.meta = meta
    loadedEntries = outbox.sorted { $0.commitOrder < $1.commitOrder }
    entrySelection = entries
    self.unreadCommitOrder = unreadCommitOrder
    loadedProjectionTargets = projectionTargets
    self.confirmed = confirmed
    self.staging = staging
    self.spent = spent
    self.cursors = cursors
    self.known = known
    loadedNotices = notices
    self.deviceRows = deviceRows
    loadedJournal = journal
    loadedUnsettledRequests = (journal?.inverses ?? []).filter { $0.state != .settled }.map(\.requestId)
    self.wholeScopes = wholeScopes
    self.isActive = isActive
  }

  // A replica created in this transaction: it holds nothing yet.
  public static func fresh(_ meta: ReplicaMeta) -> LoadedReplica {
    LoadedReplica(meta: meta, wholeScopes: true)
  }

  public var id: String { meta.replica }

  // MARK: Reading

  // Every entry, in commit order; reading it after a load of part of the outbox is a loader bug, and traps.
  public var outbox: [OutboxEntry] {
    precondition(entrySelection.all, "the whole outbox of \(meta.replica) was read but not loaded")
    return loadedEntries
  }

  // Every entry with effects in a scope, in commit order; after a load of part of the outbox, reading a scope it did not
  // load whole traps.
  public func entries(in scope: ScopeRef) -> [OutboxEntry] {
    precondition(entrySelection.all || entrySelection.scopes.contains(scope), "the entries of \(scope) were read but not loaded")
    return loadedEntries.filter { $0.scopes.contains(scope) }
  }

  // The entries that touch one record, in commit order; after a load of part of the outbox, reading a record whose row it did not read traps.
  public func entries(touching key: RecordKey, in scope: ScopeRef) -> [OutboxEntry] {
    precondition(entrySelection.all || confirmed[scope]?.wasRead(key) == true, "the entries touching \(key) were read but not loaded")
    return loadedEntries.filter { $0.deltas(in: scope).contains { $0.key == key } }
  }

  // The entries that touch a record the load read, in commit order: every entry after a load of the whole outbox, and
  // otherwise those that touch a record the rows it read cover. Views fold these and the silent fold searches them, since
  // no other entry changes what those records draw.
  public var entriesTouchingReads: [OutboxEntry] {
    if entrySelection.all { return loadedEntries }
    return loadedEntries.filter { entry in
      entry.effects().contains { effect in effect.deltas.contains { delta in confirmed[effect.scope].map { $0.covers(delta.key) } ?? wholeScopes } }
    }
  }

  // Every entry of each gesture that holds a held entry, in commit order.
  public var heldGestures: [OutboxEntry] {
    precondition(entrySelection.all || entrySelection.heldGestures, "the held gestures of \(meta.replica) were read but not loaded")
    let held = loadedEntries.filter { $0.state == .held }.map(\.gestureId)
    return loadedEntries.filter { entry in held.contains { $0.utf8.elementsEqual(entry.gestureId.utf8) } }
  }

  // §7.5 step 2: an acked entry of the replica's epoch is covered in a scope whose stored cursor has received `seq` there
  // whole; an opted entry's projection is covered too in a scope the replica knows gone.
  public func covers(_ entry: OutboxEntry, in scope: ScopeRef, at seq: Int64?) -> Bool {
    guard entry.state == .acked, let epoch = entry.resultEpoch, meta.serverEpoch?.utf8.elementsEqual(epoch.utf8) == true else { return false }
    if entry.predictions != nil && known[scope] == .gone { return true }
    guard let seq, let cleanSeq = cursors[scope]?.cleanSeq else { return false }
    return seq <= cleanSeq
  }

  // A legacy entry is covered in its scope; an opted one once each projection is, by its own scope.
  public func covers(_ entry: OutboxEntry) -> Bool {
    guard let predictions = entry.predictions else { return covers(entry, in: entry.scope, at: entry.resultSeq) }
    return predictions.allSatisfy { $0.covered || covers(entry, in: $0.scope, at: $0.resultSeq) }
  }

  // The acked entries with an uncovered effect in `scope` its stored cursor now covers, in commit order; a partial load
  // reads its covered selection.
  public func covered(in scope: ScopeRef) -> [OutboxEntry] {
    precondition(entrySelection.all || entrySelection.covered?.scope == scope, "the covered entries of \(scope) were read but not loaded")
    return loadedEntries.filter { entry in
      guard let predictions = entry.predictions else { return entry.scope == scope && covers(entry) }
      return predictions.contains { $0.scope == scope && !$0.covered && covers(entry, in: scope, at: $0.resultSeq) }
    }
  }

  // §7.9 the scopes uncovered projections target, which a bound replica follows, in commit order: read off the outbox when
  // it was loaded whole, else as the load found them.
  public var projectionTargets: [ScopeRef] {
    guard entrySelection.all else {
      precondition(entrySelection.projectionTargets, "the projection targets of \(meta.replica) were read but not loaded")
      return loadedProjectionTargets
    }
    var targets: [ScopeRef] = []
    for projection in loadedEntries.flatMap({ $0.predictions ?? [] }) where !projection.covered && !targets.contains(projection.scope) {
      targets.append(projection.scope)
    }
    return targets
  }

  // The sent entry numbered `n`, which a push result answers.
  public func sentEntry(numbered n: Int64) -> OutboxEntry? {
    precondition(entrySelection.all || entrySelection.numbered.contains(n), "the sent entry \(n) was read but not loaded")
    return loadedEntries.first { $0.state == .sent && $0.n == n }
  }

  // The entries the load read, or that were written since, by local id.
  public func entry(_ localId: String) -> OutboxEntry? {
    loadedEntries.first { $0.localId.utf8.elementsEqual(localId.utf8) }
  }

  // An entry the journal names, nil once it ended. A load of the journal reads every one it names; asking for another the
  // load left unread traps.
  public func named(_ localId: String) -> OutboxEntry? {
    if let entry = entry(localId) { return entry }
    let endedHere = writes.contains { write in
      guard case .replica(_, .deleteEntry(let deleted)) = write else { return false }
      return deleted.isSameID(as: localId)
    }
    precondition(entrySelection.all || entrySelection.localIds.contains(localId) || endedHere, "\(localId) was read but not loaded")
    return nil
  }

  // The records `after` adds or changes over `before`, and the ids it drops.
  static func changes<Record: Hashable>(_ before: [Record], _ after: [Record], id: (Record) -> String) -> (put: [Record], gone: [String]) {
    let previous = Dictionary(before.map { (id($0), $0) }) { first, _ in first }
    let kept = Set(after.map(id))
    return (after.filter { previous[id($0)] != $0 }, before.map(id).filter { !kept.contains($0) })
  }

  // The journal changed through `body`: each act, request and cancellation it adds, changes or drops is one write, and each
  // request the load found unsettled that settles now is reported.
  public mutating func updateJournal<T>(_ body: (inout Journal) throws -> T) rethrows -> T {
    var next = journal
    let value = try body(&next)
    let acts = LoadedReplica.changes(journal.acts, next.acts, id: \.actId)
    let inverses = LoadedReplica.changes(journal.inverses, next.inverses, id: \.requestId)
    let cancellations = LoadedReplica.changes(journal.cancellations, next.cancellations, id: \.inverseActId)
    for request in inverses.put where loadedUnsettledRequests.contains(where: { $0.isSameID(as: request.requestId) }) {
      guard case .settled(_, _, _, let applied, let skipped)? = request.result, journal.request(request.requestId)?.state != .settled else { continue }
      record(.inverseSettled(applied: applied, skipped: skipped, reason: request.skipReason))
    }
    for id in acts.gone { apply(.deleteAct(id)) }
    for act in acts.put { apply(.putAct(act)) }
    for id in inverses.gone { apply(.deleteInverse(id)) }
    for request in inverses.put { apply(.putInverse(request)) }
    for id in cancellations.gone { apply(.deleteCancellation(id)) }
    for cancellation in cancellations.put { apply(.putCancellation(cancellation)) }
    journal = next
    return value
  }

  public func rows(_ scope: ScopeRef) -> Rows {
    if let rows = confirmed[scope] { return rows }
    precondition(wholeScopes, "the rows of \(scope) were read but not loaded")
    return Rows()
  }

  public func spentIDs(_ scope: ScopeRef) -> [RecordKey: SpentID] {
    if let ids = spent[scope] { return ids }
    precondition(wholeScopes, "the spent ids of \(scope) were read but not loaded")
    return [:]
  }

  // Reading notices a load did not cover is a loader bug, and traps.
  public var notices: [Notice] {
    guard let loadedNotices else { preconditionFailure("the notices of \(meta.replica) were read but not loaded") }
    return loadedNotices
  }

  // Reading or writing a journal a load did not cover is a loader bug, and traps.
  public private(set) var journal: Journal {
    get {
      guard let loadedJournal else { preconditionFailure("the journal of \(meta.replica) was read but not loaded") }
      return loadedJournal
    }
    set { loadedJournal = newValue }
  }

  public func cursor(_ scope: ScopeRef) -> CursorRecord? {
    cursors[scope]
  }

  // After every entry the replica holds, read or not, as its outbox stands now.
  public var nextCommitOrder: Int64 { max(unreadCommitOrder, loadedEntries.map(\.commitOrder).max() ?? 0) + 1 }

  // MARK: Writing

  public var batch: ReplicaBatch { ReplicaBatch(writes: writes, events: events, change: change) }

  public mutating func apply(_ write: ReplicaWrite) {
    writes.append(.replica(meta.replica, write))
    note(write)
    switch write {
    case .meta(let meta):
      precondition(meta.replica.utf8.elementsEqual(self.meta.replica.utf8), "a replica's id changes only by a rename")
      self.meta = meta
    case .rename(let id):
      if isActive { record(.activeReplicaChanged(previous: meta.replica, replica: id)) }
      meta.replica = id
    case .putEntry(let entry):
      precondition(self.entry(entry.localId).map { $0.commitOrder == entry.commitOrder } ?? true,
                   "\(entry.localId) is another entry's local id, which is unique on the device")
      loadedEntries.removeAll { $0.localId.utf8.elementsEqual(entry.localId.utf8) }
      loadedEntries.insert(entry, at: loadedEntries.firstIndex { $0.commitOrder > entry.commitOrder } ?? loadedEntries.endIndex)
    case .deleteEntry(let localId): loadedEntries.removeAll { $0.localId.utf8.elementsEqual(localId.utf8) }
    case .putRow(let scope, let row):
      precondition(confirmed[scope] != nil || wholeScopes, "the rows of \(scope) were written but not loaded")
      confirmed[scope, default: Rows()].put(row)
    case .deleteRow(let scope, let key):
      precondition(confirmed[scope] != nil || wholeScopes, "the rows of \(scope) were written but not loaded")
      confirmed[scope, default: Rows()].remove(key)
    case .beginStaging(let scope):
      precondition(cursors[scope] != nil, "staging of \(scope) begins after its cursor record")
      staging[scope] = Staging()
    case .putStagedRow(let scope, let row): staging[scope]!.rows.put(row)
    case .deleteStagedRow(let scope, let key): staging[scope]!.rows.remove(key)
    case .stagingDigest(let scope, let digest): staging[scope]!.digest = digest
    case .dropStaging(let scope): staging[scope] = nil
    case .swapStaging(let scope):
      confirmed[scope] = staging[scope]!.rows
      staging[scope] = nil
    case .putSpent(let scope, let id):
      precondition(spent[scope] != nil || wholeScopes, "the spent ids of \(scope) were written but not loaded")
      spent[scope, default: [:]][id.key] = id
    case .putCursor(let scope, let record): cursors[scope] = record
    case .forgetScope(let scope):
      confirmed[scope] = Rows()
      spent[scope] = [:]
      cursors[scope] = nil
      staging[scope] = nil
    case .putKnown(let scope, let kind): known[scope] = kind
    case .deleteKnown(let scope): known[scope] = nil
    case .putAct(let act):
      journal.acts.removeAll { $0.actId.isSameID(as: act.actId) }
      journal.acts.append(act)
    case .deleteAct(let id): journal.acts.removeAll { $0.actId.isSameID(as: id) }
    case .putInverse(let request):
      if let index = journal.inverses.firstIndex(where: { $0.requestId.isSameID(as: request.requestId) }) {
        journal.inverses[index] = request
      } else {
        journal.inverses.append(request)
      }
    case .deleteInverse(let id): journal.inverses.removeAll { $0.requestId.isSameID(as: id) }
    case .putCancellation(let cancellation):
      if let index = journal.cancellations.firstIndex(where: { $0.inverseActId.isSameID(as: cancellation.inverseActId) }) {
        journal.cancellations[index] = cancellation
      } else {
        journal.cancellations.append(cancellation)
      }
    case .deleteCancellation(let id): journal.cancellations.removeAll { $0.inverseActId.isSameID(as: id) }
    case .putNotice(let notice):
      if let index = loadedNotices?.firstIndex(where: { $0.id.utf8.elementsEqual(notice.id.utf8) }) {
        loadedNotices?[index] = notice
      } else {
        loadedNotices?.append(notice)
      }
    case .moveNotice(let notice):
      loadedNotices?.removeAll { $0.id.utf8.elementsEqual(notice.id.utf8) }
      loadedNotices?.append(notice)
    case .putDeviceRow(let product, let key, let value): deviceRows[product, default: JSON.Object()][key] = value
    case .deleteDeviceRow(let product, let key): deviceRows[product]?[key] = nil
    case .deleteDeviceRows(let product): deviceRows[product] = nil
    case .purgeCaches:
      confirmed = [:]
      spent = [:]
      wholeScopes = true
      cursors = [:]
      staging = [:]
      known = [:]
    }
  }

  public mutating func update(meta change: (inout ReplicaMeta) throws -> Void) rethrows {
    var meta = self.meta
    try change(&meta)
    if meta != self.meta { apply(.meta(meta)) }
  }

  public mutating func update(entry localId: String, _ change: (inout OutboxEntry) throws -> Void) rethrows {
    guard var entry = entry(localId) else { preconditionFailure("no entry \(localId)") }
    let before = entry
    try change(&entry)
    if entry != before { apply(.putEntry(entry)) }
  }

  // One pass over a whole outbox, retaining each entry's identity, scope and position.
  public mutating func updateEntries(_ update: (inout OutboxEntry) throws -> Void) rethrows {
    precondition(entrySelection.all, "bulk entry updates require the whole outbox")
    for index in loadedEntries.indices {
      let before = loadedEntries[index]
      var entry = before
      try update(&entry)
      precondition(entry.localId.utf8.elementsEqual(before.localId.utf8) && entry.commitOrder == before.commitOrder,
                   "bulk entry updates preserve identity and order")
      guard entry != before else { continue }
      let write = ReplicaWrite.putEntry(entry)
      writes.append(.replica(meta.replica, write))
      note(write, previousEntry: before)
      loadedEntries[index] = entry
    }
  }

  // §7.5 step 2 an acked entry's coverage as it stands: an opted entry's projections each marked covered once its scope
  // covers it, and the entry resolved once wholly covered. True when it resolved.
  @discardableResult
  public mutating func settle(_ localId: String) throws -> Bool {
    guard let entry = entry(localId) else { return false }
    var marked = entry
    marked.predictions = entry.predictions?.map { projection in
      var projection = projection
      if covers(entry, in: projection.scope, at: projection.resultSeq) { projection.covered = true }
      return projection
    }
    if covers(marked) {
      try move(localId, .resolve)
      return true
    }
    if marked != entry { apply(.putEntry(marked)) }
    return false
  }

  // A scope's end, or its leaving the subscription set (§7.5, §7.9): an acked legacy entry of it resolves, and an acked
  // opted entry's projection into it is covered, the entry resolving once every one is.
  public mutating func endProjections(in scope: ScopeRef) throws {
    for entry in entries(in: scope) where entry.state == .acked {
      guard var predictions = entry.predictions else {
        if entry.scope == scope { try move(entry.localId, .resolve) }
        continue
      }
      for index in predictions.indices where predictions[index].scope == scope { predictions[index].covered = true }
      update(entry: entry.localId) { $0.predictions = predictions }
      try settle(entry.localId)
    }
  }

  // D-17: the product dismisses a notice, which hides it until content folds into it; true iff the replica holds it. A
  // notice the replica does not hold is left alone.
  public mutating func dismiss(notice id: String) -> Bool {
    guard let notice = notices.first(where: { $0.id.utf8.elementsEqual(id.utf8) }) else { return false }
    if !notice.isDismissed { apply(.putNotice(notice.dismissed)) }
    return true
  }

  // §8.1 an entry's move by the machine: a terminal outcome removes it and is reported; a return to ready clears
  // its number and result. `change` is written with the new state, in the same write.
  @discardableResult
  public mutating func move(_ localId: String, _ event: IntentEvent, to target: IntentNode? = nil,
                            with change: (inout OutboxEntry) -> Void = { _ in }) throws(TransitionError) -> IntentNode {
    guard var entry = entry(localId) else { preconditionFailure("no entry \(localId)") }
    let next = try Machines.intent.transition(from: entry.state, event, to: target)
    switch next {
    case .ended(let outcome):
      apply(.deleteEntry(localId))
      record(.ended(localId: localId, outcome: outcome, event: event, orphanOf: entry.orphanOf))
    case .state(let state):
      entry.state = state
      if state == .ready {
        entry.intent.n = nil
        entry.digest = nil
        entry.resultSeq = nil
        entry.resultEpoch = nil
      }
      change(&entry)
      apply(.putEntry(entry))
    }
    return next
  }

  public mutating func record(_ event: EngineEvent) {
    events.append(event)
  }

  // What a write changes for the views, read before it applies: an entry's records before and after it.
  mutating func note(_ write: ReplicaWrite, previousEntry: OutboxEntry? = nil) {
    switch write {
    case .meta(let meta):
      change.status = true
      change.firstPulls = change.firstPulls || meta.state != self.meta.state
      change.seat = change.seat || isActive && meta.state != self.meta.state
    case .putKnown, .deleteKnown, .putCursor:
      change.status = true
      change.firstPulls = true
    case .putDeviceRow, .deleteDeviceRow, .deleteDeviceRows:
      change.status = true
    case .rename:
      change.replicas = true
      change.seat = change.seat || isActive
    case .purgeCaches:
      change.replicas = true
      change.released = true
    case .putEntry(let entry):
      change.outbox = true
      let previous = previousEntry ?? self.entry(entry.localId)
      for effect in entry.effects() + (previous?.effects() ?? []) { change.touch(effect.scope, effect.deltas.map(\.key)) }
    case .deleteEntry(let localId):
      change.outbox = true
      if let entry = entry(localId) { for effect in entry.effects() { change.touch(effect.scope, effect.deltas.map(\.key)) } }
    case .putRow(let scope, let row): change.touch(scope, [row.key])
    case .deleteRow(let scope, let key): change.touch(scope, [key])
    case .swapStaging(let scope), .forgetScope(let scope):
      change.scopes.insert(scope)
      change.released = true
    case .beginStaging, .dropStaging: change.released = true
    case .putNotice, .moveNotice: change.notices = true
    case .putStagedRow, .deleteStagedRow, .stagingDigest, .putSpent: break
    case .putAct, .deleteAct, .putInverse, .deleteInverse, .putCancellation, .deleteCancellation: change.outbox = true
    }
  }

  // The writes, events and changes so far, handed to the device that holds this replica.
  mutating func drain() -> ReplicaBatch {
    defer {
      writes = []
      events = []
      change = StoreChange()
    }
    return batch
  }
}

// MARK: - The device

// D-3 the device database: its meta, the active replica, and the replicas an Action loaded.
public struct LoadedDevice: Sendable {
  public private(set) var meta: DeviceMeta
  public private(set) var active: String
  public private(set) var replicas: [LoadedReplica]
  public private(set) var writes: [StoreWrite] = []
  public private(set) var events: [EngineEvent] = []
  public private(set) var change = StoreChange()

  public init(meta: DeviceMeta, active: String, replicas: [LoadedReplica]) {
    self.meta = meta
    self.active = active
    self.replicas = replicas.map { replica in
      var marked = replica
      marked.isActive = replica.id.utf8.elementsEqual(active.utf8)
      return marked
    }
  }

  // §8.2 a store's first launch: its one replica, active from the start, so no change of the active replica is announced.
  public static func launching(_ meta: ReplicaMeta) -> LoadedDevice {
    var device = LoadedDevice(meta: DeviceMeta(), active: meta.replica, replicas: [])
    device.add(meta)
    device.writes.append(.device(DeviceMeta(), active: meta.replica))
    return device
  }

  public func replica(_ id: String) -> LoadedReplica? {
    replicas.first { $0.id.utf8.elementsEqual(id.utf8) }
  }

  public var activeReplica: LoadedReplica {
    guard let replica = replica(active) else { preconditionFailure("the active replica \(active) was not loaded") }
    return replica
  }

  public var anon: LoadedReplica? { replicas.first { $0.meta.state == .anon } }

  // §2.5: an outbox entry, a notice, a reversible act, an inverse request or a cancellation of any replica on the device
  // carries the gesture id.
  public func carries(gestureId: String) -> Bool {
    replicas.contains { replica in
      replica.outbox.contains { $0.gestureId.utf8.elementsEqual(gestureId.utf8) }
        || replica.notices.contains { Notice.gestureId(ofNotice: $0.id)?.utf8.elementsEqual(gestureId.utf8) == true }
        || replica.journal.carries(gestureId: gestureId)
    }
  }

  public func dormant(of account: String) -> LoadedReplica? {
    replicas.first { $0.meta.state == .dormant && $0.meta.account?.utf8.elementsEqual(account.utf8) == true }
  }

  // Runs a replica planner on one replica; its writes and events join the device's in order. A re-identify inside it
  // keeps the device's active replica pointing at it: the store names the active replica by its handle (§2.5).
  @discardableResult
  public mutating func modify<T>(_ id: String, _ body: (inout LoadedReplica) throws -> T) rethrows -> T {
    guard let index = replicas.firstIndex(where: { $0.id.utf8.elementsEqual(id.utf8) }) else { preconditionFailure("no replica \(id)") }
    defer {
      let batch = replicas[index].drain()
      writes += batch.writes
      events += batch.events
      change.merge(batch.change)
      if replicas[index].isActive { active = replicas[index].id }
    }
    return try body(&replicas[index])
  }

  public var batch: ReplicaBatch { ReplicaBatch(writes: writes, events: events, change: change) }

  // A change of the active replica is announced (§7.12).
  public mutating func setMeta(_ meta: DeviceMeta, active: String) {
    guard meta != self.meta || !active.utf8.elementsEqual(self.active.utf8) else { return }
    if !active.utf8.elementsEqual(self.active.utf8) {
      events.append(.activeReplicaChanged(previous: self.active, replica: active))
      change.seat = true
      for index in replicas.indices { replicas[index].isActive = replicas[index].id.utf8.elementsEqual(active.utf8) }
    }
    self.meta = meta
    self.active = active
    writes.append(.device(meta, active: active))
    change.replicas = true
  }

  public mutating func add(_ meta: ReplicaMeta) {
    writes.append(.createReplica(meta))
    var fresh = LoadedReplica.fresh(meta)
    fresh.isActive = meta.replica.utf8.elementsEqual(active.utf8)
    replicas.append(fresh)
    change.replicas = true
  }

  public mutating func remove(_ id: String) {
    writes.append(.deleteReplica(id))
    replicas.removeAll { $0.id.utf8.elementsEqual(id.utf8) }
    change.replicas = true
    change.released = true
  }

  public mutating func record(_ event: EngineEvent) {
    events.append(event)
  }
}

// MARK: - The whole-store JSON form (corpus/README.md "Client steps")

extension LoadedReplica {
  public init(json: JSON, registry: Registry) throws {
    let object = try json.asObject()
    let scoped = { (name: String) throws -> [(ScopeRef, JSON)] in
      try (object[name]?.asObject().members ?? []).map { (try ScopeRef($0.key), $0.value) }
    }
    var staging: [ScopeRef: Staging] = [:]
    for (scope, staged) in try scoped("staging") {
      staging[scope] = Staging(
        digest: try ScopeDigest(hex: staged.member("digest").asString()),
        rows: Rows(try staged.member("rows").asArray().map { try Row(json: $0) }))
    }
    self.init(
      meta: try ReplicaMeta(json: object.member("meta")),
      outbox: try object["outbox"]?.asArray().map { try OutboxEntry(json: $0) } ?? [],
      confirmed: Dictionary(uniqueKeysWithValues: try scoped("confirmed").map { ($0.0, Rows(try $0.1.asArray().map { try Row(json: $0) })) }),
      staging: staging,
      spent: Dictionary(uniqueKeysWithValues: try scoped("spentIds").map { scope, ids in
        (scope, Dictionary(uniqueKeysWithValues: try ids.asArray().map { try SpentID(json: $0) }.map { ($0.key, $0) }))
      }),
      cursors: Dictionary(uniqueKeysWithValues: try scoped("cursors").map { ($0.0, try CursorRecord(json: $0.1)) }),
      known: Dictionary(uniqueKeysWithValues: try scoped("known").map { scope, kind in
        guard let known = KnownKind(rawValue: try kind.asString()) else { throw JSONError.shape("not a known-scope kind") }
        return (scope, known)
      }),
      notices: try object["notices"]?.asArray().map { try Notice(json: $0, registry: registry) } ?? [],
      deviceRows: try JSON.map(object["device"]) { try $0.asObject() },
      journal: Journal(
        acts: try (object["journal"]?.asArray() ?? []).map { (act: JSON) throws -> ReversibleAct in try ReversibleAct(json: act) },
        inverses: try (object["inverses"]?.asArray() ?? []).map { (request: JSON) throws -> InverseRequest in try InverseRequest(json: request) },
        cancellations: try (object["cancellations"]?.asArray() ?? []).map { (receipt: JSON) throws -> CancellationReceipt in
          try CancellationReceipt(json: receipt)
        }),
      wholeScopes: true)
  }

  // Empty parts are left out; rows sort by record, the outbox by commit order, notices in the order they were written.
  public var json: JSON {
    var object: JSON.Object = ["meta": meta.json]
    let byScope = { (map: [ScopeRef: JSON]) -> JSON? in
      map.isEmpty ? nil : .object(JSON.Object(uniqueKeysWithValues: map.map { ($0.key.text, $0.value) }))
    }
    object["confirmed"] = byScope(confirmed.compactMapValues { $0.all.isEmpty ? nil : .array($0.all.map(\.json)) })
    object["spentIds"] = byScope(spent.compactMapValues { $0.isEmpty ? nil : .array($0.values.sorted { $0.key < $1.key }.map(\.json)) })
    object["cursors"] = byScope(cursors.mapValues(\.json))
    object["staging"] = byScope(staging.mapValues { ["digest": .string($0.digest.hex), "rows": .array($0.rows.all.map(\.json))] })
    object["known"] = byScope(known.mapValues { .string($0.rawValue) })
    object["outbox"] = outbox.isEmpty ? nil : .array(outbox.map(\.json))
    object["notices"] = notices.isEmpty ? nil : .array(notices.map(\.storedJSON))
    let device = deviceRows.compactMapValues { $0.isEmpty ? nil : JSON.object($0) }
    object["device"] = JSON.object(from: device) { $0 }
    let stored = journal.json
    object["journal"] = stored.acts.isEmpty ? nil : .array(stored.acts)
    object["inverses"] = stored.inverses.isEmpty ? nil : .array(stored.inverses)
    object["cancellations"] = stored.cancellations.isEmpty ? nil : .array(stored.cancellations)
    return .object(object)
  }
}

extension LoadedDevice {
  public init(json: JSON, registry: Registry) throws {
    self.init(
      meta: try DeviceMeta(json: json["meta"]),
      active: try json.member("active").asString(),
      replicas: try json.member("replicas").asArray().map { try LoadedReplica(json: $0, registry: registry) })
  }

  public var json: JSON {
    var object: JSON.Object = [
      "active": .string(active),
      "replicas": .array(replicas.sorted { $0.id.utf8.lexicographicallyPrecedes($1.id.utf8) }.map(\.json)),
    ]
    if meta != DeviceMeta() { object["meta"] = meta.json }
    return .object(object)
  }
}
