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
  // A new notice goes after the others; one rewritten keeps its place. No write deletes a notice: they leave only with
  // their whole replica, or move, after the others, to the replica a sign-in binds (D-17).
  case putNotice(Notice)
  case moveNotice(Notice)
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
// outbox (holds, unsent counts, Undo); the notices; a replica's status (its meta, cursors, known scopes, device rows)
// and, among them, what may move a scope's first pull; and the replicas themselves (one created, deleted, renamed or
// purged, or another made active), which reloads everything.
public struct StoreChange: Sendable, Hashable {
  public var records: [ScopeRef: Set<RecordKey>] = [:]
  public var scopes: Set<ScopeRef> = []
  public var outbox = false
  public var notices = false
  public var status = false
  // A cursor, a known scope or the replica's state changed, so a scope's first pull may have completed or begun again
  // (§7.9).
  public var firstPulls = false
  public var replicas = false
  // Rows left every view, for the sweep to delete (§2.5).
  public var released = false
  // A sign-in, a sign-out or a re-identify of the active replica, whether or not its id changed (§7.12).
  public var seat = false

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
    firstPulls = firstPulls || other.firstPulls
    replicas = replicas || other.replicas
    released = released || other.released
    seat = seat || other.seat
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
