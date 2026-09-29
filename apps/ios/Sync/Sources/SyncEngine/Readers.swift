import SyncAPI
import SyncCore
import SyncReplica
import SyncStore

// One scope of the active replica, read inside one open transaction: the `ScopeReader` a `read` passes and the
// `CommitContext` a commit's body decides through (§7.1, §7.6), and the loads the views refresh from. Each read folds the
// rows it names with the scope's pending entries. A misuse of the reader (a scope the registry does not hold, a type
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
  var isOpen = true
  var minted: Set<RecordID> = []
  var failure: (any Error)?

  // `deviceNow`: the device clock this call reads at; `now` is physNow() at it (§10.2).
  init(_ tx: StoreTransaction, core: EngineCore, scope: ScopeRef, deviceNow: Int64) throws {
    guard core.registry.scopeKind(of: scope) != nil else {
      throw CommitFailure.malformed("\(scope) is no product, tree or overlay scope of the registry")
    }
    let active = try tx.activeReplica()
    guard let replica = try tx.replica(active) else { throw StoreError.noReplica(active) }
    self.tx = tx
    self.core = core
    self.scope = scope
    meta = replica.meta
    now = replica.meta.physNow(deviceNow: deviceNow)
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
  func drawn(_ type: String) throws -> [Record] { try reading { try records(ofType: type, .drawn) } }
  func stored(_ type: String) throws -> [Record] { try reading { try records(ofType: type, .stored) } }

  func drawn(_ type: String, where field: String, is id: RecordID) throws -> [Record] {
    try reading { try records(ofType: type, where: field, is: id, .drawn) }
  }

  func stored(_ type: String, where field: String, is id: RecordID) throws -> [Record] {
    try reading { try records(ofType: type, where: field, is: id, .stored) }
  }

  // Found by the key's bytes, as the store compares text.
  func device(_ key: String) throws -> JSON? {
    try reading {
      guard isOpen else { throw TransactionReader.ended }
      guard let product = registry.product(of: scope) else { return nil }
      return try tx.deviceRow(meta.replica, product: product, key: key)
    }
  }

  func firstPullComplete() throws -> Bool {
    try reading {
      let replica = try load(RowSelection())
      return ReplicaLifecycle(registry: registry).firstPullComplete(scope, in: replica, subscribed: Set(core.subscriptions(of: meta)))
    }
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
    var records: [RecordKey: Record] = [:]
    for key in keys {
      if let record = view.record(key) { records[key] = shaped(record, in: view, of: replica) }
    }
    return records
  }

  // The visible records of a type, in id order.
  func records(ofType type: String, _ mode: ViewMode) throws -> [Record] {
    try checkLives(type)
    let replica = try load(RowSelection(types: [type]))
    let view = try ScopeView(replica, scope, mode, registry: registry)
    return view.records(ofType: type).filter(view.isVisible).map { shaped($0, in: view, of: replica) }
  }

  // ER-12: the confirmed records the ref index names, and every record of the type a pending entry of the view touches,
  // each folded; the visible ones whose folded field names `id`, in id order. A pending write that moves a reference
  // is so seen on both sides.
  func records(ofType type: String, where field: String, is id: RecordID, _ mode: ViewMode) throws -> [Record] {
    try checkLives(type)
    guard registry.type(type)?.field(field)?.ref != nil else {
      throw CommitFailure.malformed("\(type).\(field) is not a top-level ref field")
    }
    let indexed = try tx.referencing(meta.replica, in: scope, type: type, field: field, target: id)
    let pending = try load(RowSelection()).entries(in: scope).filter { $0.state != .held || mode == .drawn }
      .flatMap(\.drawnDeltas).map(\.key).filter { $0.type.utf8.elementsEqual(type.utf8) }
    let candidates = Set(indexed).union(pending)
    let replica = try load(RowSelection(keys: candidates))
    let view = try ScopeView(replica, scope, mode, registry: registry)
    return candidates.sorted().compactMap { view.record($0) }
      .filter { view.isVisible($0) && $0.value(field) == id.json }
      .map { shaped($0, in: view, of: replica) }
  }

  func load(_ selection: RowSelection) throws -> LoadedReplica {
    guard isOpen else { throw TransactionReader.ended }
    guard let replica = try tx.replica(meta.replica, reads: [scope: selection]) else { throw StoreError.noReplica(meta.replica) }
    return replica
  }

  func checkLives(_ type: String) throws {
    guard isOpen else { throw TransactionReader.ended }
    guard registry.lives(type, in: scope) else { throw CommitFailure.malformed("\(type) is no type of \(scope)") }
  }

  // A folded record as products read it: its texts marked pending where an entry of the view writes them, its server
  // times from the confirmed row, and whether the view's entries or a held entry touch it.
  func shaped(_ record: ViewRecord, in view: ScopeView, of replica: LoadedReplica) -> Record {
    let touching = replica.entries(in: scope).filter { $0.touches(record.key) }
    let folded = touching.filter { $0.state != .held || view.mode == .drawn }
    let confirmed = replica.rows(scope).row(record.key)
    let pendingTexts = Set(folded.flatMap { $0.drawnDeltas.filter { $0.key == record.key }.flatMap(\.texts.keys) })
    var texts: [String: TextValue] = [:]
    for (name, text) in record.texts {
      let pending = pendingTexts.contains(name)
      texts[name] = TextValue(text: text, merged: !pending && confirmed?.texts[name]?.merged == true, pending: pending)
    }
    return Record(
      type: record.key.type, id: record.key.id, life: record.lattice.life, born: record.lattice.born,
      values: record.lattice.fields.mapValues(\.value), texts: texts, serials: record.serials, rc: confirmed?.rc,
      ru: confirmed?.ru, isVisible: view.isVisible(record), isPending: !folded.isEmpty,
      isHeld: touching.contains { $0.state == .held })
  }
}
