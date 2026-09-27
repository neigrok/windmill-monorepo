import SyncAPI
import SyncCore

// A transaction's decision as data (§3.6 of the design): each write the store applies, in order, what the writes
// changed for the views, and the batch that carries them with the events to publish.

// One change to one replica's rows, as the store applies it; the replica it targets is bound when it is recorded.
public enum ReplicaWrite: Sendable, Hashable {
  case meta(ReplicaMeta)
  case rename(to: String)
  case putEntry(OutboxEntry)
  case deleteEntry(String)
  case putRow(ScopeRef, Row)
  case deleteRow(ScopeRef, RecordKey)
  case beginStaging(ScopeRef)
  case putStagedRow(ScopeRef, Row)
  case deleteStagedRow(ScopeRef, RecordKey)
  case stagingDigest(ScopeRef, ScopeDigest)
  case dropStaging(ScopeRef)
  case swapStaging(ScopeRef)
  case putSpent(ScopeRef, SpentID)
  case putCursor(ScopeRef, CursorRecord)
  case forgetScope(ScopeRef)
  case putKnown(ScopeRef, KnownKind)
  case deleteKnown(ScopeRef)
  case putNotice(Notice)
  case deleteNotice(String)
  case putDeviceRow(product: String, key: String, JSON)
  case deleteDeviceRow(product: String, key: String)
  case deleteDeviceRows(product: String)
  case purgeCaches
}

public enum StoreWrite: Sendable, Hashable {
  case device(DeviceMeta, active: String)
  case createReplica(ReplicaMeta)
  case deleteReplica(String)
  case replica(String, ReplicaWrite)
}

// What one transaction's writes changed, for views to refresh: records per scope and scopes to reload whole; the
// outbox (holds, unsent counts, Undo); the notices; a replica's status (its meta, cursors, known scopes, device rows);
// and the replicas themselves (one created, deleted, renamed or purged, or another made active), which reloads
// everything.
public struct StoreChange: Sendable, Hashable {
  public var records: [ScopeRef: Set<RecordKey>] = [:]
  public var scopes: Set<ScopeRef> = []
  public var outbox = false
  public var notices = false
  public var status = false
  public var replicas = false

  public init() {}

  public var isEmpty: Bool { self == StoreChange() }

  mutating func touch(_ scope: ScopeRef, _ keys: [RecordKey]) {
    if !keys.isEmpty { records[scope, default: []].formUnion(keys) }
  }

  public mutating func merge(_ other: StoreChange) {
    records.merge(other.records) { $0.union($1) }
    scopes.formUnion(other.scopes)
    outbox = outbox || other.outbox
    notices = notices || other.notices
    status = status || other.status
    replicas = replicas || other.replicas
  }
}

// One transaction's decision as data: the writes the store applies in order, the events it publishes after the
// commit, and what the writes changed.
public struct ReplicaBatch: Sendable {
  public let writes: [StoreWrite]
  public let events: [EngineEvent]
  public let change: StoreChange

  public init(writes: [StoreWrite] = [], events: [EngineEvent] = [], change: StoreChange = StoreChange()) {
    self.writes = writes
    self.events = events
    self.change = change
  }
}
