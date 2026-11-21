import SyncAPI
import SyncCore
import SyncReplica
import SyncStore

final class TransactionActContext: ActContext {
  let tx: StoreTransaction
  let core: EngineCore
  let instance: Instance
  let staging: ActStaging
  let meta: ReplicaMeta
  var minted: [ScopeRef: TransactionReader] = [:]
  var borrowed: Set<ScopeRef> = []
  var loans: [TransactionReader] = []
  var newMints: Set<ScopeRef> = []
  var failure: (any Error)?
  var isOpen = true
  var loading = true
  var now: Int64 { meta.physNow(deviceNow: instance.deviceNow) }
  var replica: String { meta.replica }
  var actor: String { instance.actor.text }
  var isAnonymous: Bool { meta.state == .anon }

  init(_ tx: StoreTransaction, core: EngineCore, instance: Instance, staging: ActStaging) throws {
    self.tx = tx; self.core = core; self.instance = instance; self.staging = staging
    let active = try tx.activeReplica()
    guard let meta = try tx.meta(of: active) else { throw StoreError.noReplica(active) }
    self.meta = meta
  }

  func finishLoad() throws {
    guard isOpen else { throw TransactionReader.ended }
    if let failure { throw failure }
    for reader in loans { try reader.finish() }
    loading = false
  }

  func inScope<T>(_ scope: ScopeRef, _ body: (any ScopeReader) throws -> T) throws -> T {
    guard isOpen, loading else { failure = failure ?? TransactionReader.ended; throw TransactionReader.ended }
    let reader: TransactionReader
    do { reader = try TransactionReader(tx, core: core, scope: scope, deviceNow: instance.deviceNow, actor: actor) }
    catch { failure = failure ?? error; throw error }
    borrowed.insert(scope)
    loans.append(reader)
    defer { reader.end() }
    do {
      let value = try body(reader)
      try reader.finish()
      return value
    } catch {
      failure = failure ?? reader.failure
      throw error
    }
  }

  func mintID(_ type: String, in scope: ScopeRef) throws -> RecordID {
    try finishLoad()
    do {
      if !borrowed.contains(scope) {
        guard let governing = core.registry.governingRecord(of: scope), !(try tx.holdsScope(scope, in: replica)) else {
          let error = CommitFailure.malformed("load must borrow an existing scope before minting there")
          failure = failure ?? error
          throw error
        }
        let reader = try TransactionReader(tx, core: core, scope: governing.scope, deviceNow: instance.deviceNow, actor: actor)
        defer { reader.end() }
        guard try reader.drawn(governing.key.type, governing.key.id) == nil else {
          let error = CommitFailure.malformed("load must borrow an existing scope before minting there")
          failure = failure ?? error
          throw error
        }
        newMints.insert(scope)
      }
      if minted[scope] == nil {
        minted[scope] = try TransactionReader(tx, core: core, scope: scope, deviceNow: instance.deviceNow, actor: actor)
      }
      return try minted[scope]!.mintID(type)
    } catch { failure = failure ?? error; throw error }
  }

  func opaqueID() throws -> String {
    try finishLoad()
    return try core.identities.replicaID()
  }

  // A part's segment, decided over the act's transaction through every segment staged before it, staged there in turn.
  func stage(_ scope: ScopeRef, _ segment: (any CommitContext) throws -> Gesture) throws -> StagedRefusal? {
    try finishLoad()
    guard core.registry.scopeKind(of: scope) != nil else { throw CommitFailure.malformed("an act stages a scope of its registry") }
    let reader = try TransactionReader(tx, core: core, scope: scope, deviceNow: instance.deviceNow, actor: actor)
    defer { reader.end() }
    let gesture: Gesture
    do { gesture = try segment(reader) }
    catch { failure = failure ?? reader.failure; throw error }
    try reader.finish()
    return try staging.stage(gesture, in: scope)
  }

  func beginPart() throws {
    try finishLoad()
    loading = true
  }

  func finish() throws { try finishLoad(); for reader in minted.values { try reader.finish() } }
  func end() { isOpen = false; for reader in minted.values { reader.end() } }
}

// What a list read and a `RecordsView` list (§7.6, ER-12): the visible records of one type, drawn or stored, every one or
// those whose top-level ref field names an id, in id-byte order.
struct Listing: Hashable, Sendable {
  struct Narrowing: Hashable, Sendable {
    let field: String
    let id: RecordID
  }

  let type: String
  let mode: ViewMode
  let narrowing: Narrowing?

  // A type that is no type of `scope`, then a narrowing by a field that is no top-level ref of the type, is malformed,
  // as every misuse of a reader is.
  init(_ type: String, _ mode: ViewMode, where narrowing: Narrowing? = nil, in scope: ScopeRef, registry: Registry) throws {
    guard registry.lives(type, in: scope) else { throw CommitFailure.malformed("\(type) is no type of \(scope)") }
    if let narrowing, registry.type(type)?.field(narrowing.field)?.ref == nil {
      throw CommitFailure.malformed("\(type).\(narrowing.field) is not a top-level ref field")
    }
    self.type = type
    self.mode = mode
    self.narrowing = narrowing
  }

  // Whether the list holds `record` as `view` folds it: visible, and where narrowed, its field naming the id.
  func holds(_ record: ViewRecord, in view: ScopeView) -> Bool {
    guard view.isVisible(record) else { return false }
    guard let narrowing else { return true }
    return record.value(narrowing.field) == narrowing.id.json
  }
}

// One scope of the active replica, read inside one open transaction: the `ScopeReader` a `read` passes and the
// `CommitContext` a commit's body decides through (§7.1, §7.6), and the loads the views refresh from. Each read folds the
// rows it names with the pending entries that touch them. A misuse of the reader (a scope the registry does not hold, a type
// outside it, a field that is no ref, a mint of a type that mints none, a read or a mint after its call returned) throws
// a malformed `CommitFailure` where it happens, so it is malformed wherever it surfaces. The first failure of a read or
// a mint is kept, and fails the commit whose body met it.

final class TransactionReader: CommitContext {
  // What a read throws once the call that passed the reader has returned.
  static let ended = CommitFailure.malformed("a reader serves only inside the call that passed it")

  let tx: StoreTransaction
  let core: EngineCore
  let scope: ScopeRef
  let meta: ReplicaMeta
  let now: Int64
  var replica: String { meta.replica }
  let actor: String
  var isAnonymous: Bool { meta.state == .anon }
  var isOpen = true
  var minted: Set<RecordID> = []
  var failure: (any Error)?

  // `deviceNow`: the device clock this call reads at; `now` is physNow() at it (§10.2).
  init(_ tx: StoreTransaction, core: EngineCore, scope: ScopeRef, deviceNow: Int64, actor: String? = nil) throws {
    guard core.registry.scopeKind(of: scope) != nil else {
      throw CommitFailure.malformed("\(scope) is no product, tree or overlay scope of the registry")
    }
    let active = try tx.activeReplica()
    guard let meta = try tx.meta(of: active) else { throw StoreError.noReplica(active) }
    self.tx = tx
    self.core = core
    self.scope = scope
    self.actor = actor ?? ""
    self.meta = meta
    now = meta.physNow(deviceNow: deviceNow)
  }

  var registry: Registry { core.registry }

  // Ends the call: every later read throws.
  func end() {
    isOpen = false
  }

  // A commit's body is over: a read or a mint that failed inside it fails the commit.
  func finish() throws {
    if let failure { throw failure }
  }

  // One read, its failure kept.
  func reading<Value>(_ read: () throws -> Value) throws -> Value {
    do {
      return try read()
    } catch {
      failure = failure ?? error
      throw error
    }
  }

  // MARK: ScopeReader

  func drawn(_ type: String, _ id: RecordID) throws -> Record? { try reading { try record(RecordKey(type, id), .drawn) } }
  func stored(_ type: String, _ id: RecordID) throws -> Record? { try reading { try record(RecordKey(type, id), .stored) } }
  func drawn(_ type: String) throws -> [Record] { try reading { try records(Listing(type, .drawn, in: scope, registry: registry)) } }
  func stored(_ type: String) throws -> [Record] { try reading { try records(Listing(type, .stored, in: scope, registry: registry)) } }

  func drawn(_ type: String, where field: String, is id: RecordID) throws -> [Record] {
    try reading { try records(Listing(type, .drawn, where: Listing.Narrowing(field: field, id: id), in: scope, registry: registry)) }
  }

  func stored(_ type: String, where field: String, is id: RecordID) throws -> [Record] {
    try reading { try records(Listing(type, .stored, where: Listing.Narrowing(field: field, id: id), in: scope, registry: registry)) }
  }

  func spentBorn(_ type: String, _ id: RecordID) throws -> Stamp? {
    try reading {
      try checkLives(type)
      let key = RecordKey(type, id)
      return try load(RowSelection(keys: [key])).spentIDs(scope)[key]?.born
    }
  }

  // Found by the key's bytes, as the store compares text.
  func device(_ key: String) throws -> JSON? {
    try reading {
      guard isOpen else { throw TransactionReader.ended }
      guard let product = registry.product(of: scope) else { return nil }
      return try tx.deviceRow(meta.replica, product: product, key: key)
    }
  }

  func freshness() throws -> SyncFreshness {
    try reading {
      guard isOpen else { throw TransactionReader.ended }
      guard try firstPullComplete() else { return SyncFreshness() }
      return core.freshness(scope, meta: meta)
    }
  }

  func firstPullComplete() throws -> Bool {
    try reading {
      guard isOpen else { throw TransactionReader.ended }
      return try core.firstPullComplete(tx, of: scope, in: meta.replica)
    }
  }

  func confirmed(_ type: String, _ id: RecordID) throws -> Record? {
    try reading {
      try checkLives(type)
      let key = RecordKey(type, id), replica = try load(RowSelection(keys: [key]))
      guard let row = replica.rows(scope).row(key) else { return nil }
      return Record(type: type, id: id, life: row.lattice.life, born: row.lattice.born,
        values: row.lattice.fields.mapValues(\.value), stamps: row.lattice.fields.mapValues(\.stamp),
        texts: row.texts.mapValues { TextValue(text: $0.text, merged: $0.merged, pending: false) }, serials: row.serials,
        seq: row.seq, rc: row.rc, ru: row.ru, isVisible: Visibility.of(row, registry: registry), isPending: false, isHeld: false)
    }
  }

  func checkpoint() throws -> ScopeCheckpoint {
    try reading {
      let replica = try load(RowSelection())
      let cursor = replica.cursor(scope)
      let cursorEpoch = cursor?.cursor.flatMap(Cursor.init(decoding:))?.epoch
      let clean = cursorEpoch == meta.serverEpoch && cursor?.behind == false && cursor?.digestStop == nil && cursor?.mismatchReset != true && replica.staging[scope] == nil
      return ScopeCheckpoint(epoch: meta.serverEpoch, cleanSeq: clean ? cursor?.cleanSeq : nil)
    }
  }

  func devices(prefix: String) throws -> JSON.Object {
    try reading {
      let replica = try load(RowSelection())
      guard let product = registry.product(of: scope) else { return [:] }
      return JSON.Object(uniqueKeysWithValues: (replica.deviceRows[product]?.members ?? []).filter { $0.key.hasPrefix(prefix) })
    }
  }

  func commands() throws -> [QueuedCommand] {
    try reading {
      guard isOpen else { throw TransactionReader.ended }
      guard let replica = try tx.replica(meta.replica, entries: EntrySelection(scopes: [scope])) else { throw StoreError.noReplica(meta.replica) }
      return replica.entries(in: scope).filter { $0.scope == scope }.compactMap { entry in
        entry.intent.command.map { QueuedCommand(gestureId: entry.gestureId, command: $0,
          canSupersede: meta.state == .anon && entry.isQueued && entry.n == nil, isAdmitted: entry.state == .acked) }
      }
    }
  }

  func opaqueID() throws -> String {
    try reading { guard isOpen else { throw TransactionReader.ended }; return try core.identities.replicaID() }
  }

  // MARK: CommitContext

  // A CSPRNG id by the type's mint, drawn again while drawn, spent or minted earlier in this call holds it. Each draw is
  // looked up by its key, so a mint costs the same whatever the type holds.
  func mintID(_ type: String) throws -> RecordID {
    try reading {
      try checkLives(type)
      while true {
        let id = try core.identities.mint(type, in: registry)
        let key = RecordKey(type, id)
        let replica = try load(RowSelection(keys: [key]))
        let drawn = try ScopeView(replica, scope, .drawn, registry: registry)
        guard minted.contains(id) || drawn.record(key) != nil || replica.spentIDs(scope)[key] != nil else {
          minted.insert(id)
          return id
        }
      }
    }
  }

  // MARK: Reads

  func record(_ key: RecordKey, _ mode: ViewMode) throws -> Record? {
    try checkLives(key.type)
    return try records([key], mode)[key]
  }

  // The folded records of `keys`, visible or not; a key no row, delta or prediction names is absent.
  func records(_ keys: Set<RecordKey>, _ mode: ViewMode) throws -> [RecordKey: Record] {
    let replica = try load(RowSelection(keys: keys))
    let view = try ScopeView(replica, scope, mode, registry: registry)
    let pending = pendingMetadata(in: replica, mode: mode)
    var records: [RecordKey: Record] = [:]
    for key in keys {
      if let record = view.record(key) {
        records[key] = shaped(record, in: view, confirmed: replica.rows(scope).row(key), pending: pending[key, default: PendingMetadata()])
      }
    }
    return records
  }

  // A list's records, folded, in id order. A narrowed list (ER-12) folds the confirmed records the ref index names and
  // every record of the type a pending entry of the view touches, so its cost follows the list and the outbox, not the
  // type, and a pending write that moves a reference is seen on both sides.
  func records(_ listing: Listing) throws -> [Record] {
    guard isOpen else { throw TransactionReader.ended }
    guard let narrowing = listing.narrowing else {
      let replica = try load(RowSelection(types: [listing.type]))
      let view = try ScopeView(replica, scope, listing.mode, registry: registry)
      let pending = pendingMetadata(in: replica, mode: listing.mode)
      return view.records(ofType: listing.type).filter { listing.holds($0, in: view) }
        .map { shaped($0, in: view, confirmed: replica.rows(scope).row($0.key), pending: pending[$0.key, default: PendingMetadata()]) }
    }
    let indexed = try tx.referencing(meta.replica, in: scope, type: listing.type, field: narrowing.field, target: narrowing.id)
    let pending = try tx.touched(meta.replica, in: scope, type: listing.type, withHeld: listing.mode == .drawn)
    let candidates = Set(indexed).union(pending)
    let replica = try load(RowSelection(keys: candidates))
    let view = try ScopeView(replica, scope, listing.mode, registry: registry)
    let metadata = pendingMetadata(in: replica, mode: listing.mode)
    return candidates.sorted().compactMap { view.record($0) }.filter { listing.holds($0, in: view) }
      .map { shaped($0, in: view, confirmed: replica.rows(scope).row($0.key), pending: metadata[$0.key, default: PendingMetadata()]) }
  }

  // The records of `keys` a list holds, each folded again, as a view refreshes them (design §4.5); a key the list does
  // not hold is absent.
  func records(_ keys: Set<RecordKey>, in listing: Listing) throws -> [RecordKey: Record] {
    let replica = try load(RowSelection(keys: keys))
    let view = try ScopeView(replica, scope, listing.mode, registry: registry)
    let pending = pendingMetadata(in: replica, mode: listing.mode)
    var held: [RecordKey: Record] = [:]
    for key in keys {
      if let record = view.record(key), listing.holds(record, in: view) {
        held[key] = shaped(record, in: view, confirmed: replica.rows(scope).row(key), pending: pending[key, default: PendingMetadata()])
      }
    }
    return held
  }

  // The rows `selection` names, with the entries that touch them.
  func load(_ selection: RowSelection) throws -> LoadedReplica {
    guard isOpen else { throw TransactionReader.ended }
    guard let replica = try tx.replica(meta.replica, reads: [scope: selection], entries: EntrySelection()) else {
      throw StoreError.noReplica(meta.replica)
    }
    return replica
  }

  func checkLives(_ type: String) throws {
    guard isOpen else { throw TransactionReader.ended }
    guard registry.lives(type, in: scope) else { throw CommitFailure.malformed("\(type) is no type of \(scope)") }
  }

  struct PendingMetadata {
    var isPending = false
    var isHeld = false
    var texts: Set<String> = []
  }

  // Each read batch indexes its pending metadata once, including duplicate delta and prediction touches, an opted entry's
  // only while its projection into the scope is uncovered.
  func pendingMetadata(in replica: LoadedReplica, mode: ViewMode) -> [RecordKey: PendingMetadata] {
    var records: [RecordKey: PendingMetadata] = [:]
    for entry in replica.entriesTouchingReads {
      let folded = entry.state != .held || mode == .drawn
      for delta in entry.deltas(in: scope, active: true) {
        var pending = records[delta.key, default: PendingMetadata()]
        pending.isHeld = pending.isHeld || entry.state == .held
        if folded {
          pending.isPending = true
          pending.texts.formUnion(delta.texts.keys)
        }
        records[delta.key] = pending
      }
    }
    return records
  }

  // Shaping receives only this record's metadata, so it cannot rescan the read batch's outbox.
  func shaped(_ record: ViewRecord, in view: ScopeView, confirmed: Row?, pending: PendingMetadata) -> Record {
    var texts: [String: TextValue] = [:]
    for (name, text) in record.texts {
      let hasPendingText = pending.texts.contains(name)
      texts[name] = TextValue(text: text, merged: !hasPendingText && confirmed?.texts[name]?.merged == true, pending: hasPendingText)
    }
    return Record(
      type: record.key.type, id: record.key.id, life: record.lattice.life, born: record.lattice.born,
      values: record.lattice.fields.mapValues(\.value), stamps: record.lattice.fields.mapValues(\.stamp), texts: texts,
      serials: record.serials, seq: confirmed?.seq, rc: confirmed?.rc, ru: confirmed?.ru, isVisible: view.isVisible(record),
      isPending: pending.isPending, isHeld: pending.isHeld)
  }
}
