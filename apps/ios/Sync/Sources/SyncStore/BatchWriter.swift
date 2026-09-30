import Foundation
import GRDB
import SyncAPI
import SyncCore
import SyncReplica

// Applies a planner's batch as SQL, in its order, inside the Action's transaction. Writes name a replica by its id, which
// the writer turns into the replica's handle once per batch; a re-identify changes the one `replica` row (§7.11). It is
// the only writer of rows, so it keeps `set_ref` (ER-12) a function of `set_row`: every row it puts replaces its record's
// ref rows, and every delete takes them along. Rows taken out of every view go with the row set that held them, which
// the sweep deletes afterwards, a slice a transaction (§2.5 the writer).

struct BatchWriter {
  let db: Database
  let registry: Registry

  func apply(_ batch: ReplicaBatch) throws {
    var handles = Handles(db: db)
    for write in batch.writes { try apply(write, handles: &handles) }
  }

  func apply(_ write: StoreWrite, handles: inout Handles) throws {
    switch write {
    case .device(let meta, let active):
      try db.execute(sql: """
        INSERT INTO device (id, fork_guard, pending_sign_in, active_replica, ref_index_version) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET fork_guard = excluded.fork_guard, pending_sign_in = excluded.pending_sign_in,
          active_replica = excluded.active_replica
        """, arguments: [meta.forkGuard, meta.pendingSignIn, try handles.of(active).value, registry.version])
    case .createReplica(let meta):
      try db.execute(sql: "INSERT INTO replica (id, state, account) VALUES (?, ?, ?)", arguments: [meta.replica, meta.state.rawValue, meta.account])
      try put(meta, handle: try handles.of(meta.replica))
    case .deleteReplica(let id):
      let handle = try handles.of(id)
      try db.execute(sql: "UPDATE row_set SET role = NULL WHERE replica = ?", arguments: [handle.value])
      try db.execute(sql: "DELETE FROM replica WHERE handle = ?", arguments: [handle.value])
      handles.forget(id)
    case .replica(let id, let write):
      try apply(write, to: try handles.of(id), handles: &handles)
    }
  }

  func apply(_ write: ReplicaWrite, to replica: ReplicaHandle, handles: inout Handles) throws {
    switch write {
    case .meta(let meta): try put(meta, handle: replica)
    case .rename(let id):
      try db.execute(sql: "UPDATE replica SET id = ? WHERE handle = ?", arguments: [id, replica.value])
      handles.renamed(replica, to: id)
    case .putEntry(let entry): try put(entry, in: replica)
    case .deleteEntry(let localId):
      try db.execute(sql: "DELETE FROM outbox WHERE local_id = ? AND replica = ?", arguments: [localId, replica.value])
    case .putRow(let scope, let row): try put(row, in: try rowSet(.confirmed, of: replica, scope, creating: true)!)
    case .deleteRow(let scope, let key):
      if let set = try rowSet(.confirmed, of: replica, scope) { try delete(key, in: set) }
    case .beginStaging(let scope):
      try release(.staging, of: replica, scope)
      _ = try rowSet(.staging, of: replica, scope, creating: true)
      try setStagingDigest(ScopeDigest.zero, replica: replica, scope: scope)
    case .putStagedRow(let scope, let row): try put(row, in: try stagingSet(of: replica, scope))
    case .deleteStagedRow(let scope, let key): try delete(key, in: try stagingSet(of: replica, scope))
    case .stagingDigest(let scope, let digest): try setStagingDigest(digest, replica: replica, scope: scope)
    case .dropStaging(let scope):
      try release(.staging, of: replica, scope)
      try setStagingDigest(nil, replica: replica, scope: scope)
    case .swapStaging(let scope):
      try release(.confirmed, of: replica, scope)
      try db.execute(sql: "UPDATE row_set SET role = 'confirmed' WHERE replica = ? AND scope = ? AND role = 'staging'",
                     arguments: [replica.value, scope.text])
      try setStagingDigest(nil, replica: replica, scope: scope)
    case .putSpent(let scope, let spent):
      try db.execute(sql: """
        INSERT INTO spent (replica, scope, type, id, born) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (replica, scope, type, id) DO UPDATE SET born = excluded.born
        """, arguments: [replica.value, scope.text, spent.key.type, spent.key.id.text, spent.born.text])
    case .putCursor(let scope, let record):
      try db.cachedStatement(sql: """
        INSERT INTO cursor (replica, scope, cursor, digest, booted, behind, mismatch_reset, digest_stop) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (replica, scope) DO UPDATE SET cursor = excluded.cursor, digest = excluded.digest, booted = excluded.booted,
          behind = excluded.behind, mismatch_reset = excluded.mismatch_reset, digest_stop = excluded.digest_stop
        """).execute(arguments: [
          replica.value, scope.text, record.cursor, Data(record.digest.bytes), record.booted, record.behind, record.mismatchReset,
          record.digestStop,
        ])
    case .forgetScope(let scope):
      try db.execute(sql: "UPDATE row_set SET role = NULL WHERE replica = ? AND scope = ? AND role IS NOT NULL", arguments: [replica.value, scope.text])
      for table in ["spent", "cursor"] {
        try db.execute(sql: "DELETE FROM \(table) WHERE replica = ? AND scope = ?", arguments: [replica.value, scope.text])
      }
    case .putKnown(let scope, let kind):
      try db.execute(sql: """
        INSERT INTO known_scope (replica, scope, kind) VALUES (?, ?, ?) ON CONFLICT (replica, scope) DO UPDATE SET kind = excluded.kind
        """, arguments: [replica.value, scope.text, kind.rawValue])
    case .deleteKnown(let scope):
      try db.execute(sql: "DELETE FROM known_scope WHERE replica = ? AND scope = ?", arguments: [replica.value, scope.text])
    case .putNotice(let notice): try put(notice, in: replica)
    case .moveNotice(let notice):
      try db.execute(sql: "DELETE FROM notice WHERE id = ?", arguments: [notice.id])
      try put(notice, in: replica)
    case .putDeviceRow(let product, let key, let value):
      try db.execute(sql: """
        INSERT INTO device_row (replica, product, key, value) VALUES (?, ?, ?, ?)
        ON CONFLICT (replica, product, key) DO UPDATE SET value = excluded.value
        """, arguments: [replica.value, product, key, Blob.of(value)])
    case .deleteDeviceRow(let product, let key):
      try db.execute(sql: "DELETE FROM device_row WHERE replica = ? AND product = ? AND key = ?", arguments: [replica.value, product, key])
    case .deleteDeviceRows(let product):
      try db.execute(sql: "DELETE FROM device_row WHERE replica = ? AND product = ?", arguments: [replica.value, product])
    case .purgeCaches:
      try db.execute(sql: "UPDATE row_set SET role = NULL WHERE replica = ? AND role IS NOT NULL", arguments: [replica.value])
      for table in ["spent", "cursor", "known_scope", "device_row"] {
        try db.execute(sql: "DELETE FROM \(table) WHERE replica = ?", arguments: [replica.value])
      }
    }
  }

  // MARK: Replicas

  func put(_ meta: ReplicaMeta, handle: ReplicaHandle) throws {
    try db.cachedStatement(sql: """
      UPDATE replica SET state = ?, account = ?, next_n = ?, hlc_ms = ?, hlc_counter = ?, hlc_high = ?, admitted_high = ?,
        server_offset_ms = ?, offset_samples = ?, clock_reading = ?, server_epoch = ?, ack_through = ?, auth_paused = ?
      WHERE handle = ?
      """).execute(arguments: [
        meta.state.rawValue, meta.account, meta.nextN, meta.hlc.ms, Int64(meta.hlc.counter), meta.hlcHigh.text,
        meta.admittedHigh.text, meta.serverOffsetMs, Blob.of(.array(meta.offset.samples.map(\.json))),
        meta.offset.clockReading.map { Blob.of($0.json) }, meta.serverEpoch, meta.ackThrough, meta.authPaused, handle.value,
      ])
  }

  // MARK: Notices

  // A notice keeps its replica: the same id under another replica is refused, as a local id is.
  func put(_ notice: Notice, in replica: ReplicaHandle) throws {
    try db.execute(sql: """
      INSERT INTO notice (replica, id, product, scope, code, detail, content, at, dismissed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET product = excluded.product, scope = excluded.scope, code = excluded.code,
        detail = excluded.detail, content = excluded.content, at = excluded.at, dismissed = excluded.dismissed
      WHERE notice.replica = excluded.replica
      """, arguments: [replica.value, notice.id, notice.product, notice.scope.text, notice.code.text, notice.detail.map(Blob.of),
                       Blob.of(notice.content.json), notice.at, notice.isDismissed])
    guard db.changesCount == 1 else { throw StoreError.localIdTaken(notice.id) }
  }

  // MARK: The outbox

  // An entry keeps its replica and its commit order: a put that would replace another replica's entry, or another entry
  // of the same local id, is refused. Every put replaces the records the entry touches in `outbox_touch`, and a delete
  // takes them along.
  func put(_ entry: OutboxEntry, in replica: ReplicaHandle) throws {
    let baseTexts = JSON.object(from: Dictionary(uniqueKeysWithValues: entry.baseTexts.map { ($0.key.text, $0.value) })) { .string($0) }
    try db.cachedStatement(sql: """
      INSERT INTO outbox (replica, local_id, gesture_id, lineage, scope, state, commit_order, release_at, stamp, intent,
        predict, base_texts, n, digest, result_seq, result_epoch, orphan_of)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (local_id) DO UPDATE SET gesture_id = excluded.gesture_id, lineage = excluded.lineage,
        scope = excluded.scope, state = excluded.state, commit_order = excluded.commit_order, release_at = excluded.release_at,
        stamp = excluded.stamp, intent = excluded.intent, predict = excluded.predict,
        base_texts = excluded.base_texts, n = excluded.n, digest = excluded.digest, result_seq = excluded.result_seq,
        result_epoch = excluded.result_epoch, orphan_of = excluded.orphan_of
      WHERE outbox.replica = excluded.replica AND outbox.commit_order = excluded.commit_order
      """).execute(arguments: [
        replica.value, entry.localId, entry.gestureId, entry.lineage, entry.scope.text, entry.state.rawValue, entry.commitOrder,
        entry.releaseAt, entry.stamp.text, Blob.of(entry.intent.json),
        entry.predict.isEmpty ? nil : Blob.of(.array(entry.predict.map(\.json))), baseTexts.map(Blob.of), entry.n,
        entry.digest.map { Data(Blob.hexBytes($0)) }, entry.resultSeq, entry.resultEpoch, entry.orphanOf,
      ])
    guard db.changesCount == 1 else { throw StoreError.localIdTaken(entry.localId) }
    try db.cachedStatement(sql: "DELETE FROM outbox_touch WHERE local_id = ?").execute(arguments: [entry.localId])
    for key in Set(entry.drawnDeltas.map(\.key)) {
      try db.cachedStatement(sql: "INSERT INTO outbox_touch (local_id, scope, type, id) VALUES (?, ?, ?, ?)")
        .execute(arguments: [entry.localId, entry.scope.text, key.type, key.id.text])
    }
  }

  // MARK: Row sets, their rows and their ref index

  // The row set of `role` of a replica's scope; with `creating`, a new one when it has none.
  func rowSet(_ role: RowRole, of replica: ReplicaHandle, _ scope: ScopeRef, creating: Bool = false) throws -> RowSetID? {
    let found = try Int64.fetchOne(db.cachedStatement(sql: "SELECT id FROM row_set WHERE replica = ? AND scope = ? AND role = ?"),
                                   arguments: [replica.value, scope.text, role.rawValue])
    if let found { return RowSetID(value: found) }
    guard creating else { return nil }
    try db.cachedStatement(sql: "INSERT INTO row_set (replica, scope, role) VALUES (?, ?, ?)")
      .execute(arguments: [replica.value, scope.text, role.rawValue])
    return RowSetID(value: db.lastInsertedRowID)
  }

  func stagingSet(of replica: ReplicaHandle, _ scope: ScopeRef) throws -> RowSetID {
    guard let set = try rowSet(.staging, of: replica, scope) else { throw StoreError.corrupt("staging of \(scope) that never began") }
    return set
  }

  // The set of `role` takes no role: its rows leave every view at once, and the sweep deletes them.
  func release(_ role: RowRole, of replica: ReplicaHandle, _ scope: ScopeRef) throws {
    try db.execute(sql: "UPDATE row_set SET role = NULL WHERE replica = ? AND scope = ? AND role = ?",
                   arguments: [replica.value, scope.text, role.rawValue])
  }

  // A pull page puts every row of a chunk in one transaction, so the statements of a row and of a delete are prepared once
  // per connection.
  func put(_ row: SyncCore.Row, in set: RowSetID) throws {
    try db.cachedStatement(sql: """
      INSERT INTO set_row (row_set, type, id, seq, visible, row, hash) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (row_set, type, id) DO UPDATE SET seq = excluded.seq, visible = excluded.visible, row = excluded.row,
        hash = excluded.hash
      """).execute(arguments: [set.value, row.key.type, row.key.id.text, row.seq, Visibility.of(row, registry: registry),
                               Blob.of(row.json), Data(row.digest.bytes)])
    try db.cachedStatement(sql: "DELETE FROM set_ref WHERE row_set = ? AND type = ? AND id = ?")
      .execute(arguments: [set.value, row.key.type, row.key.id.text])
    for (field, target) in BatchWriter.references(of: row, registry: registry) {
      try db.cachedStatement(sql: "INSERT INTO set_ref (row_set, type, field, target, id) VALUES (?, ?, ?, ?, ?)")
        .execute(arguments: [set.value, row.key.type, field, target.text, row.key.id.text])
    }
  }

  func delete(_ key: RecordKey, in set: RowSetID) throws {
    for table in ["set_ref", "set_row"] {
      try db.cachedStatement(sql: "DELETE FROM \(table) WHERE row_set = ? AND type = ? AND id = ?")
        .execute(arguments: [set.value, key.type, key.id.text])
    }
  }

  func setStagingDigest(_ digest: ScopeDigest?, replica: ReplicaHandle, scope: ScopeRef) throws {
    try db.execute(sql: "UPDATE cursor SET staging_digest = ? WHERE replica = ? AND scope = ?",
                   arguments: [digest.map { Data($0.bytes) }, replica.value, scope.text])
  }

  // ER-12: one entry per top-level registry `ref` field of a known type whose value is an id.
  static func references(of row: SyncCore.Row, registry: Registry) -> [(field: String, target: RecordID)] {
    guard let type = registry.type(row.key.type) else { return [] }
    return type.fields.compactMap { field in
      guard field.ref != nil, case .string(let target)? = row.lattice.fields[field.name]?.value else { return nil }
      return (field.name, RecordID(target))
    }
  }

  // At open, a registry version other than the one the index was built for rebuilds the ref index, and the visible
  // column, from the rows.
  func rebuildDerivedColumns() throws {
    try db.execute(sql: "DELETE FROM set_ref")
    for record in try GRDB.Row.fetchAll(db, sql: "SELECT row_set, row FROM set_row") {
      try put(try Blob.row(record["row"]), in: RowSetID(value: record["row_set"]))
    }
    try db.execute(sql: "UPDATE device SET ref_index_version = ?", arguments: [registry.version])
  }

  // §2.5 one slice: up to `limit` rows of released sets, oldest first, each set deleted once empty; true while any is left.
  func sweep(limit: Int) throws -> Bool {
    var left = limit
    while left > 0, let set = try Int64.fetchOne(db, sql: "SELECT id FROM row_set WHERE role IS NULL ORDER BY id LIMIT 1") {
      let slice = "SELECT type, id FROM set_row WHERE row_set = ?1 ORDER BY type, id LIMIT ?2"
      try db.execute(sql: "DELETE FROM set_ref WHERE row_set = ?1 AND (type, id) IN (\(slice))", arguments: [set, left])
      try db.execute(sql: "DELETE FROM set_row WHERE row_set = ?1 AND (type, id) IN (\(slice))", arguments: [set, left])
      left -= db.changesCount
      if try !Bool.fetchOne(db, sql: "SELECT EXISTS (SELECT 1 FROM set_row WHERE row_set = ?)", arguments: [set])! {
        try db.execute(sql: "DELETE FROM set_ref WHERE row_set = ?", arguments: [set])
        try db.execute(sql: "DELETE FROM row_set WHERE id = ?", arguments: [set])
      }
    }
    return try Bool.fetchOne(db, sql: "SELECT EXISTS (SELECT 1 FROM row_set WHERE role IS NULL)")!
  }
}

// A replica as every table names it: a handle a re-identify leaves alone.
struct ReplicaHandle: Hashable {
  let value: Int64
}

// A set of rows: a scope's confirmed rows, a boot's staging, or rows no view reads any more.
struct RowSetID: Hashable {
  let value: Int64
}

enum RowRole: String {
  case confirmed, staging
}

// The handles a batch's writes name, found once each by the replica's id.
struct Handles {
  let db: Database
  var known: [String: ReplicaHandle] = [:]

  init(db: Database) {
    self.db = db
  }

  mutating func of(_ id: String) throws -> ReplicaHandle {
    if let handle = known[id] { return handle }
    guard let value = try Int64.fetchOne(db.cachedStatement(sql: "SELECT handle FROM replica WHERE id = ?"), arguments: [id]) else {
      throw StoreError.noReplica(id)
    }
    known[id] = ReplicaHandle(value: value)
    return known[id]!
  }

  mutating func renamed(_ handle: ReplicaHandle, to id: String) {
    known = known.filter { $0.value != handle }
    known[id] = handle
  }

  mutating func forget(_ id: String) {
    known[id] = nil
  }
}

// JSON values as the JCS blobs the store keeps, and back.
enum Blob {
  static func of(_ json: JSON) -> Data {
    Data(json.jcs)
  }

  static func json(_ data: Data) throws -> JSON {
    try JSON(parsing: [UInt8](data))
  }

  static func row(_ data: Data) throws -> SyncCore.Row {
    try SyncCore.Row(json: json(data))
  }

  static func hexBytes(_ hex: String) -> [UInt8] {
    let digits = Array(hex.utf8)
    return stride(from: 0, to: digits.count - 1, by: 2).compactMap { UInt8(String(decoding: digits[$0...$0 + 1], as: UTF8.self), radix: 16) }
  }

  static func hex(_ data: Data) -> String {
    data.map { byte in
      let digits = String(byte, radix: 16)
      return digits.count == 1 ? "0" + digits : digits
    }.joined()
  }
}
