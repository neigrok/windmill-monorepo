import Foundation
import GRDB
import SyncAPI
import SyncCore
import SyncReplica

// Applies a planner's batch as SQL, in its order, inside the Action's transaction. It is the only writer of confirmed
// and staged rows, so it keeps `confirmed_ref` and `staging_ref` (ER-12) a function of them: every row it puts replaces
// its record's ref rows, and every delete, purge and swap takes them along.

struct BatchWriter {
  let db: Database
  let registry: Registry

  func apply(_ batch: ReplicaBatch) throws {
    for write in batch.writes { try apply(write) }
  }

  func apply(_ write: StoreWrite) throws {
    switch write {
    case .device(let meta, let active):
      try db.execute(sql: """
        INSERT INTO device (id, fork_guard, pending_sign_in, active_replica, ref_index_version) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET fork_guard = excluded.fork_guard, pending_sign_in = excluded.pending_sign_in,
          active_replica = excluded.active_replica
        """, arguments: [meta.forkGuard, meta.pendingSignIn, active, registry.version])
    case .createReplica(let meta):
      try db.execute(sql: "INSERT INTO replica (replica, state, account) VALUES (?, ?, ?)", arguments: [meta.replica, meta.state.rawValue, meta.account])
      try put(meta)
    case .deleteReplica(let id):
      try db.execute(sql: "DELETE FROM replica WHERE replica = ?", arguments: [id])
    case .replica(let id, let write):
      try apply(write, to: id)
    }
  }

  func apply(_ write: ReplicaWrite, to replica: String) throws {
    switch write {
    case .meta(let meta): try put(meta)
    case .rename(let id): try rename(replica, to: id)
    case .putEntry(let entry): try put(entry, in: replica)
    case .deleteEntry(let localId):
      try db.execute(sql: "DELETE FROM outbox WHERE local_id = ? AND replica = ?", arguments: [localId, replica])
    case .putRow(let scope, let row): try put(row, in: .confirmed, replica: replica, scope: scope)
    case .deleteRow(let scope, let key): try delete(key, in: .confirmed, replica: replica, scope: scope)
    case .beginStaging(let scope):
      try clear(.staging, replica: replica, scope: scope)
      try setStagingDigest(ScopeDigest.zero, replica: replica, scope: scope)
    case .putStagedRow(let scope, let row): try put(row, in: .staging, replica: replica, scope: scope)
    case .deleteStagedRow(let scope, let key): try delete(key, in: .staging, replica: replica, scope: scope)
    case .stagingDigest(let scope, let digest): try setStagingDigest(digest, replica: replica, scope: scope)
    case .dropStaging(let scope):
      try clear(.staging, replica: replica, scope: scope)
      try setStagingDigest(nil, replica: replica, scope: scope)
    case .swapStaging(let scope):
      try clear(.confirmed, replica: replica, scope: scope)
      for table in ["", "_ref"] {
        try db.execute(sql: "INSERT INTO confirmed\(table) SELECT * FROM staging\(table) WHERE replica = ? AND scope = ?",
                       arguments: [replica, scope.text])
      }
      try clear(.staging, replica: replica, scope: scope)
      try setStagingDigest(nil, replica: replica, scope: scope)
    case .putSpent(let scope, let spent):
      try db.execute(sql: """
        INSERT INTO spent (replica, scope, type, id, born) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (replica, scope, type, id) DO UPDATE SET born = excluded.born
        """, arguments: [replica, scope.text, spent.key.type, spent.key.id.text, spent.born.text])
    case .putCursor(let scope, let record):
      try db.execute(sql: """
        INSERT INTO cursor (replica, scope, cursor, digest, booted, mismatch_reset, digest_stop) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (replica, scope) DO UPDATE SET cursor = excluded.cursor, digest = excluded.digest, booted = excluded.booted,
          mismatch_reset = excluded.mismatch_reset, digest_stop = excluded.digest_stop
        """, arguments: [replica, scope.text, record.cursor, Data(record.digest.bytes), record.booted, record.mismatchReset, record.digestStop])
    case .forgetScope(let scope):
      try clear(.confirmed, replica: replica, scope: scope)
      try clear(.staging, replica: replica, scope: scope)
      for table in ["spent", "cursor"] {
        try db.execute(sql: "DELETE FROM \(table) WHERE replica = ? AND scope = ?", arguments: [replica, scope.text])
      }
    case .putKnown(let scope, let kind):
      try db.execute(sql: """
        INSERT INTO known_scope (replica, scope, kind) VALUES (?, ?, ?) ON CONFLICT (replica, scope) DO UPDATE SET kind = excluded.kind
        """, arguments: [replica, scope.text, kind.rawValue])
    case .deleteKnown(let scope):
      try db.execute(sql: "DELETE FROM known_scope WHERE replica = ? AND scope = ?", arguments: [replica, scope.text])
    case .putNotice(let notice): try put(notice, in: replica)
    case .moveNotice(let notice):
      try db.execute(sql: "DELETE FROM notice WHERE id = ?", arguments: [notice.id])
      try put(notice, in: replica)
    case .putDeviceRow(let product, let key, let value):
      try db.execute(sql: """
        INSERT INTO device_row (replica, product, key, value) VALUES (?, ?, ?, ?)
        ON CONFLICT (replica, product, key) DO UPDATE SET value = excluded.value
        """, arguments: [replica, product, key, Blob.of(value)])
    case .deleteDeviceRow(let product, let key):
      try db.execute(sql: "DELETE FROM device_row WHERE replica = ? AND product = ? AND key = ?", arguments: [replica, product, key])
    case .deleteDeviceRows(let product):
      try db.execute(sql: "DELETE FROM device_row WHERE replica = ? AND product = ?", arguments: [replica, product])
    case .purgeCaches:
      for table in ["confirmed", "confirmed_ref", "staging", "staging_ref", "spent", "cursor", "known_scope", "device_row"] {
        try db.execute(sql: "DELETE FROM \(table) WHERE replica = ?", arguments: [replica])
      }
    }
  }

  // MARK: Replicas

  func put(_ meta: ReplicaMeta) throws {
    try db.execute(sql: """
      UPDATE replica SET state = ?, account = ?, next_n = ?, hlc_ms = ?, hlc_counter = ?, hlc_high = ?, admitted_high = ?,
        server_offset_ms = ?, offset_samples = ?, clock_reading = ?, server_epoch = ?, ack_through = ?, auth_paused = ?
      WHERE replica = ?
      """, arguments: [
        meta.state.rawValue, meta.account, meta.nextN, meta.hlc.ms, Int64(meta.hlc.counter), meta.hlcHigh.text,
        meta.admittedHigh.text, meta.serverOffsetMs, Blob.of(.array(meta.offset.samples.map(\.json))),
        meta.offset.clockReading.map { Blob.of($0.json) }, meta.serverEpoch, meta.ackThrough, meta.authPaused, meta.replica,
      ])
  }

  // §7.11: every row of the replica moves to its new id in this transaction; the foreign keys are checked at commit.
  func rename(_ replica: String, to id: String) throws {
    try db.execute(sql: "PRAGMA defer_foreign_keys = ON")
    let tables = ["replica", "confirmed", "staging", "confirmed_ref", "staging_ref", "spent", "cursor", "known_scope", "outbox", "notice", "device_row"]
    for table in tables {
      try db.execute(sql: "UPDATE \(table) SET replica = ? WHERE replica = ?", arguments: [id, replica])
    }
    try db.execute(sql: "UPDATE device SET active_replica = ? WHERE active_replica = ?", arguments: [id, replica])
  }

  // MARK: Notices

  // A notice keeps its replica: the same id under another replica is refused, as a local id is.
  func put(_ notice: Notice, in replica: String) throws {
    try db.execute(sql: """
      INSERT INTO notice (replica, id, product, scope, code, detail, content, at, dismissed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET product = excluded.product, scope = excluded.scope, code = excluded.code,
        detail = excluded.detail, content = excluded.content, at = excluded.at, dismissed = excluded.dismissed
      WHERE notice.replica = excluded.replica
      """, arguments: [replica, notice.id, notice.product, notice.scope.text, notice.code.text, notice.detail.map(Blob.of),
                       Blob.of(notice.content.json), notice.at, notice.isDismissed])
    guard db.changesCount == 1 else { throw StoreError.localIdTaken(notice.id) }
  }

  // MARK: The outbox

  // An entry keeps its replica and its commit order: a put that would replace another replica's entry, or another entry
  // of the same local id, is refused. Every put replaces the records the entry touches in `outbox_touch`, and a delete
  // takes them along.
  func put(_ entry: OutboxEntry, in replica: String) throws {
    let baseTexts = JSON.object(from: Dictionary(uniqueKeysWithValues: entry.baseTexts.map { ($0.key.text, $0.value) })) { .string($0) }
    try db.execute(sql: """
      INSERT INTO outbox (replica, local_id, gesture_id, lineage, scope, state, commit_order, release_at, stamp, intent,
        predict, base_texts, n, digest, result_seq, result_epoch, orphan_of)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (local_id) DO UPDATE SET gesture_id = excluded.gesture_id, lineage = excluded.lineage,
        scope = excluded.scope, state = excluded.state, commit_order = excluded.commit_order, release_at = excluded.release_at,
        stamp = excluded.stamp, intent = excluded.intent, predict = excluded.predict,
        base_texts = excluded.base_texts, n = excluded.n, digest = excluded.digest, result_seq = excluded.result_seq,
        result_epoch = excluded.result_epoch, orphan_of = excluded.orphan_of
      WHERE outbox.replica = excluded.replica AND outbox.commit_order = excluded.commit_order
      """, arguments: [
        replica, entry.localId, entry.gestureId, entry.lineage, entry.scope.text, entry.state.rawValue, entry.commitOrder,
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

  // MARK: Rows and their ref index

  enum RowTable: String {
    case confirmed, staging
  }

  // A pull page puts every row it carries in one transaction, so the statements of a row and of a delete are prepared
  // once per connection.
  func put(_ row: SyncCore.Row, in table: RowTable, replica: String, scope: ScopeRef) throws {
    try db.cachedStatement(sql: """
      INSERT INTO \(table.rawValue) (replica, scope, type, id, seq, visible, row, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (replica, scope, type, id) DO UPDATE SET seq = excluded.seq, visible = excluded.visible, row = excluded.row,
        hash = excluded.hash
      """).execute(arguments: [replica, scope.text, row.key.type, row.key.id.text, row.seq, Visibility.of(row, registry: registry),
                               Blob.of(row.json), Data(row.digest.bytes)])
    try db.cachedStatement(sql: "DELETE FROM \(table.rawValue)_ref WHERE replica = ? AND scope = ? AND type = ? AND id = ?")
      .execute(arguments: [replica, scope.text, row.key.type, row.key.id.text])
    for (field, target) in BatchWriter.references(of: row, registry: registry) {
      try db.cachedStatement(sql: "INSERT INTO \(table.rawValue)_ref (replica, scope, type, field, target, id) VALUES (?, ?, ?, ?, ?, ?)")
        .execute(arguments: [replica, scope.text, row.key.type, field, target.text, row.key.id.text])
    }
  }

  func delete(_ key: RecordKey, in table: RowTable, replica: String, scope: ScopeRef) throws {
    for suffix in ["", "_ref"] {
      try db.cachedStatement(sql: "DELETE FROM \(table.rawValue)\(suffix) WHERE replica = ? AND scope = ? AND type = ? AND id = ?")
        .execute(arguments: [replica, scope.text, key.type, key.id.text])
    }
  }

  func clear(_ table: RowTable, replica: String, scope: ScopeRef) throws {
    for suffix in ["", "_ref"] {
      try db.execute(sql: "DELETE FROM \(table.rawValue)\(suffix) WHERE replica = ? AND scope = ?", arguments: [replica, scope.text])
    }
  }

  func setStagingDigest(_ digest: ScopeDigest?, replica: String, scope: ScopeRef) throws {
    try db.execute(sql: "UPDATE cursor SET staging_digest = ? WHERE replica = ? AND scope = ?",
                   arguments: [digest.map { Data($0.bytes) }, replica, scope.text])
  }

  // ER-12: one entry per top-level registry `ref` field of a known type whose value is an id.
  static func references(of row: SyncCore.Row, registry: Registry) -> [(field: String, target: RecordID)] {
    guard let type = registry.type(row.key.type) else { return [] }
    return type.fields.compactMap { field in
      guard field.ref != nil, case .string(let target)? = row.lattice.fields[field.name]?.value else { return nil }
      return (field.name, RecordID(target))
    }
  }

  // At open, a registry version other than the one the index was built for rebuilds both indexes, and the visible
  // column, from the rows.
  func rebuildDerivedColumns() throws {
    for table in [RowTable.confirmed, .staging] {
      try db.execute(sql: "DELETE FROM \(table.rawValue)_ref")
      let stored = try GRDB.Row.fetchAll(db, sql: "SELECT replica, scope, row FROM \(table.rawValue)")
      for record in stored {
        try put(try Blob.row(record["row"]), in: table, replica: record["replica"], scope: try ScopeRef(record["scope"] as String))
      }
    }
    try db.execute(sql: "UPDATE device SET ref_index_version = ?", arguments: [registry.version])
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
