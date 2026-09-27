import SyncAPI
import SyncCore

// The working copy a planner changes: what an Action loaded of one replica, or of the device, and every write since.
// A copy changes only by `apply`, which records the write, so its writes are the whole batch the store commits.

// MARK: - One replica

public struct LoadedReplica: Sendable {
  public private(set) var meta: ReplicaMeta
  public private(set) var outbox: [OutboxEntry]
  public private(set) var confirmed: [ScopeRef: Rows]
  public private(set) var staging: [ScopeRef: Staging]
  public private(set) var spent: [ScopeRef: [RecordKey: SpentID]]
  public private(set) var cursors: [ScopeRef: CursorRecord]
  public private(set) var known: [ScopeRef: KnownKind]
  public private(set) var notices: [Notice]
  public private(set) var deviceRows: [String: [String: JSON]]
  public private(set) var writes: [StoreWrite] = []
  public private(set) var events: [EngineEvent] = []
  public private(set) var change = StoreChange()
  // Every scope's rows were loaded, so a scope absent from `confirmed` holds none; otherwise reading it traps.
  public private(set) var wholeScopes: Bool

  // The outbox, cursors, known scopes and staging digests are always loaded whole; rows and notices as a planner needs.
  public init(meta: ReplicaMeta, outbox: [OutboxEntry] = [], confirmed: [ScopeRef: Rows] = [:], staging: [ScopeRef: Staging] = [:],
              spent: [ScopeRef: [RecordKey: SpentID]] = [:], cursors: [ScopeRef: CursorRecord] = [:],
              known: [ScopeRef: KnownKind] = [:], notices: [Notice] = [], deviceRows: [String: [String: JSON]] = [:],
              wholeScopes: Bool) {
    self.meta = meta
    self.outbox = outbox.sorted { $0.commitOrder < $1.commitOrder }
    self.confirmed = confirmed
    self.staging = staging
    self.spent = spent
    self.cursors = cursors
    self.known = known
    self.notices = notices
    self.deviceRows = deviceRows
    self.wholeScopes = wholeScopes
  }

  // A replica created in this transaction: it holds nothing yet.
  public static func fresh(_ meta: ReplicaMeta) -> LoadedReplica {
    LoadedReplica(meta: meta, wholeScopes: true)
  }

  public var id: String { meta.replica }

  // MARK: Reading

  public func entries(in scope: ScopeRef) -> [OutboxEntry] {
    outbox.filter { $0.scope == scope }
  }

  public func entry(_ localId: String) -> OutboxEntry? {
    outbox.first { $0.localId == localId }
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

  public func cursor(_ scope: ScopeRef) -> CursorRecord? {
    cursors[scope]
  }

  public var nextCommitOrder: Int64 { (outbox.map(\.commitOrder).max() ?? 0) + 1 }

  // MARK: Writing

  public var batch: ReplicaBatch { ReplicaBatch(writes: writes, events: events, change: change) }

  public mutating func apply(_ write: ReplicaWrite) {
    writes.append(.replica(meta.replica, write))
    note(write)
    switch write {
    case .meta(let meta):
      precondition(meta.replica == self.meta.replica, "a replica's id changes only by a rename")
      self.meta = meta
    case .rename(let id): meta.replica = id
    case .putEntry(let entry):
      outbox.removeAll { $0.localId == entry.localId }
      outbox.insert(entry, at: outbox.firstIndex { $0.commitOrder > entry.commitOrder } ?? outbox.endIndex)
    case .deleteEntry(let localId): outbox.removeAll { $0.localId == localId }
    case .putRow(let scope, let row):
      var rows = rows(scope)
      rows.put(row)
      confirmed[scope] = rows
    case .deleteRow(let scope, let key):
      var rows = rows(scope)
      rows.remove(key)
      confirmed[scope] = rows
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
      var ids = spentIDs(scope)
      ids[id.key] = id
      spent[scope] = ids
    case .putCursor(let scope, let record): cursors[scope] = record
    case .forgetScope(let scope):
      confirmed[scope] = Rows()
      spent[scope] = [:]
      cursors[scope] = nil
      staging[scope] = nil
    case .putKnown(let scope, let kind): known[scope] = kind
    case .deleteKnown(let scope): known[scope] = nil
    case .putNotice(let notice):
      notices.removeAll { $0.id == notice.id }
      notices.append(notice)
    case .deleteNotice(let id): notices.removeAll { $0.id == id }
    case .putDeviceRow(let product, let key, let value): deviceRows[product, default: [:]][key] = value
    case .deleteDeviceRow(let product, let key): deviceRows[product]?[key] = nil
    case .deleteDeviceRows(let product): deviceRows[product] = nil
    case .purgeCaches:
      confirmed = [:]
      spent = [:]
      wholeScopes = true
      cursors = [:]
      staging = [:]
      known = [:]
      deviceRows = [:]
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
  mutating func note(_ write: ReplicaWrite) {
    switch write {
    case .meta, .putKnown, .deleteKnown, .putDeviceRow, .deleteDeviceRow, .deleteDeviceRows:
      change.status = true
    case .rename, .purgeCaches:
      change.replicas = true
    case .putEntry(let entry):
      change.outbox = true
      change.touch(entry.scope, entry.drawnDeltas.map(\.key) + (self.entry(entry.localId)?.drawnDeltas.map(\.key) ?? []))
    case .deleteEntry(let localId):
      change.outbox = true
      if let entry = entry(localId) { change.touch(entry.scope, entry.drawnDeltas.map(\.key)) }
    case .putRow(let scope, let row): change.touch(scope, [row.key])
    case .deleteRow(let scope, let key): change.touch(scope, [key])
    case .swapStaging(let scope), .forgetScope(let scope): change.scopes.insert(scope)
    case .putNotice, .deleteNotice: change.notices = true
    case .beginStaging, .putStagedRow, .deleteStagedRow, .stagingDigest, .dropStaging, .putSpent, .putCursor: break
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
    self.replicas = replicas
  }

  public func replica(_ id: String) -> LoadedReplica? {
    replicas.first { $0.id == id }
  }

  public var activeReplica: LoadedReplica {
    guard let replica = replica(active) else { preconditionFailure("the active replica \(active) was not loaded") }
    return replica
  }

  public var anon: LoadedReplica? { replicas.first { $0.meta.state == .anon } }

  public func dormant(of account: String) -> LoadedReplica? {
    replicas.first { $0.meta.state == .dormant && $0.meta.account == account }
  }

  // Runs a replica planner on one replica; its writes and events join the device's in order. A re-identify inside
  // it keeps the device's active replica pointing at it.
  @discardableResult
  public mutating func modify<T>(_ id: String, _ body: (inout LoadedReplica) throws -> T) rethrows -> T {
    guard let index = replicas.firstIndex(where: { $0.id == id }) else { preconditionFailure("no replica \(id)") }
    defer {
      let batch = replicas[index].drain()
      writes += batch.writes
      events += batch.events
      change.merge(batch.change)
      let renamed = replicas[index].id
      if active == id && renamed != id { setMeta(meta, active: renamed) }
    }
    return try body(&replicas[index])
  }

  public var batch: ReplicaBatch { ReplicaBatch(writes: writes, events: events, change: change) }

  public mutating func setMeta(_ meta: DeviceMeta, active: String) {
    guard meta != self.meta || active != self.active else { return }
    self.meta = meta
    self.active = active
    writes.append(.device(meta, active: active))
    change.replicas = true
  }

  public mutating func add(_ meta: ReplicaMeta) {
    writes.append(.createReplica(meta))
    replicas.append(.fresh(meta))
    change.replicas = true
  }

  public mutating func remove(_ id: String) {
    writes.append(.deleteReplica(id))
    replicas.removeAll { $0.id == id }
    change.replicas = true
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
      deviceRows: try JSON.map(object["device"]) { try JSON.map($0) { $0 } },
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
    let device = deviceRows.compactMapValues { $0.isEmpty ? nil : JSON.object(from: $0) { $0 } }
    object["device"] = JSON.object(from: device) { $0 }
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
