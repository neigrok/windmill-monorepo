import Foundation
import GRDB
import SyncAPI
import SyncCore
import SyncReplica

// `StoreTransaction`: an open transaction as the rest of the engine sees it, naming no GRDB type and no handle. Its loaders
// build the working copies planners change; its queries serve the readers. Each finds a replica by its id once, then
// reads by its handle. The cursors, staging digests, known scopes and device rows of a replica are always loaded whole;
// rows only as a planner's read set names them, and outbox entries whole or as its entry selection names them.

public struct StoreTransaction {
  let db: Database
  let registry: Registry

  // MARK: Device and replicas

  public func deviceMeta() throws -> (meta: DeviceMeta, active: String)? {
    guard let device = try GRDB.Row.fetchOne(db, sql: """
      SELECT fork_guard, pending_sign_in, replica.id AS active FROM device JOIN replica ON replica.handle = device.active_replica
      """) else { return nil }
    return (DeviceMeta(forkGuard: device["fork_guard"], pendingSignIn: device["pending_sign_in"]), device["active"])
  }

  public func activeReplica() throws -> String {
    guard let device = try deviceMeta() else { throw StoreError.noDevice }
    return device.active
  }

  public func replicaIDs() throws -> [String] {
    try String.fetchAll(db, sql: "SELECT id FROM replica ORDER BY handle")
  }

  // One replica with the rows `reads` names and the outbox entries `entries` names; `notices` loads its notices too.
  public func replica(_ id: String, reads: [ScopeRef: RowSelection] = [:], entries: EntrySelection = .every,
                      notices: Bool = false) throws -> LoadedReplica? {
    guard let (handle, meta) = try record(of: id) else { return nil }
    let cursors = try cursors(of: handle)
    var confirmed: [ScopeRef: Rows] = [:]
    var spent: [ScopeRef: [RecordKey: SpentID]] = [:]
    for (scope, selection) in reads {
      confirmed[scope] = try rows(.confirmed, of: handle, in: scope, selection)
      spent[scope] = try spentIDs(of: handle, in: scope)
    }
    var staging: [ScopeRef: Staging] = [:]
    for (scope, digest) in cursors.staging {
      staging[scope] = Staging(digest: digest, rows: try rows(.staging, of: handle, in: scope, reads[scope] ?? RowSelection()))
    }
    let outbox = try self.outbox(of: handle, entries, touching: reads)
    return LoadedReplica(
      meta: meta, outbox: outbox.read, entries: entries, unreadCommitOrder: outbox.unreadCommitOrder, confirmed: confirmed,
      staging: staging, spent: spent, cursors: cursors.records, known: try known(of: handle),
      notices: notices ? try self.notices(of: handle) : nil, deviceRows: try deviceRows(of: handle), wholeScopes: false,
      isActive: try isActive(handle))
  }

  // Every replica with its notices: what the lifecycle planners read. `rows` loads every row too.
  public func device(rows: Bool = false) throws -> LoadedDevice {
    guard let device = try deviceMeta() else { throw StoreError.noDevice }
    let replicas = try replicaIDs().map { id in
      rows ? try wholeReplica(id) : try replica(id, notices: true)!
    }
    return LoadedDevice(meta: device.meta, active: device.active, replicas: replicas)
  }

  // Everything one replica holds, every row included.
  func wholeReplica(_ id: String) throws -> LoadedReplica {
    guard let (handle, meta) = try record(of: id) else { throw StoreError.noReplica(id) }
    let cursors = try cursors(of: handle)
    var confirmed: [ScopeRef: Rows] = [:]
    for (scope, rows) in try Dictionary(grouping: allRows(.confirmed, of: handle), by: \.scope) { confirmed[scope] = Rows(rows.map(\.row)) }
    var staging: [ScopeRef: Staging] = [:]
    let staged = try Dictionary(grouping: allRows(.staging, of: handle), by: \.scope)
    for (scope, digest) in cursors.staging { staging[scope] = Staging(digest: digest, rows: Rows((staged[scope] ?? []).map(\.row))) }
    var spent: [ScopeRef: [RecordKey: SpentID]] = [:]
    for record in try GRDB.Row.fetchAll(db, sql: "SELECT scope, type, id, born FROM spent WHERE replica = ?", arguments: [handle.value]) {
      let id = try spentID(record)
      spent[try ScopeRef(record["scope"] as String), default: [:]][id.key] = id
    }
    return LoadedReplica(
      meta: meta, outbox: try outbox(of: handle), confirmed: confirmed, staging: staging, spent: spent, cursors: cursors.records,
      known: try known(of: handle), notices: try notices(of: handle), deviceRows: try deviceRows(of: handle), wholeScopes: true,
      isActive: try isActive(handle))
  }

  public func meta(of id: String) throws -> ReplicaMeta? {
    try record(of: id)?.meta
  }

  // The replica of `id`: its handle, which every other table names it by, and its meta.
  func record(of id: String) throws -> (handle: ReplicaHandle, meta: ReplicaMeta)? {
    guard let record = try GRDB.Row.fetchOne(db.cachedStatement(sql: "SELECT * FROM replica WHERE id = ?"), arguments: [id]) else { return nil }
    guard let state = ReplicaMeta.State(rawValue: record["state"]) else { throw StoreError.corrupt("replica state") }
    var meta = ReplicaMeta(replica: id, state: state, account: record["account"])
    meta.nextN = record["next_n"]
    guard let counter = UInt32(exactly: record["hlc_counter"] as Int64) else { throw StoreError.corrupt("hlc counter") }
    meta.hlc = HLC(ms: record["hlc_ms"], counter: counter)
    meta.hlcHigh = try Stamp(record["hlc_high"] as String)
    meta.admittedHigh = try Stamp(record["admitted_high"] as String)
    meta.serverOffsetMs = record["server_offset_ms"]
    meta.offset = ServerOffset(
      samples: try Blob.json(record["offset_samples"]).asArray().map { try ServerOffset.Sample(json: $0) },
      clockReading: try (record["clock_reading"] as Data?).map { try ClockReading(json: Blob.json($0)) })
    meta.serverEpoch = record["server_epoch"]
    meta.ackThrough = record["ack_through"]
    meta.authPaused = record["auth_paused"]
    return (ReplicaHandle(value: record["handle"]), meta)
  }

  func isActive(_ handle: ReplicaHandle) throws -> Bool {
    try Int64.fetchOne(db.cachedStatement(sql: "SELECT active_replica FROM device WHERE id = 1")) == handle.value
  }

  func outbox(of handle: ReplicaHandle) throws -> [OutboxEntry] {
    try GRDB.Row.fetchAll(db, sql: "SELECT * FROM outbox WHERE replica = ? ORDER BY commit_order", arguments: [handle.value]).map(entry)
  }

  // The entries `selection` names: every one, or those that touch a record `reads` covers, every entry of the held
  // gestures, the sent entries numbered and the first a cursor covers, each found through an index; with the highest
  // commit order among the entries left unread, which only the orders above every entry read can hold.
  func outbox(of handle: ReplicaHandle, _ selection: EntrySelection,
              touching reads: [ScopeRef: RowSelection]) throws -> (read: [OutboxEntry], unreadCommitOrder: Int64) {
    if selection.all { return (try outbox(of: handle), 0) }
    var queries: [(sql: String, arguments: StatementArguments)] = []
    for (scope, rows) in reads {
      if rows.all { queries.append(("SELECT * FROM outbox WHERE replica = ? AND scope = ?", [handle.value, scope.text])) }
      for key in rows.keys {
        queries.append(("""
          SELECT outbox.* FROM outbox_touch JOIN outbox USING (local_id)
          WHERE outbox_touch.scope = ? AND outbox_touch.type = ? AND outbox_touch.id = ? AND outbox.replica = ?
          """, [scope.text, key.type, key.id.text, handle.value]))
      }
      for type in rows.types {
        queries.append(("""
          SELECT outbox.* FROM outbox_touch JOIN outbox USING (local_id)
          WHERE outbox_touch.scope = ? AND outbox_touch.type = ? AND outbox.replica = ?
          """, [scope.text, type, handle.value]))
      }
    }
    if selection.heldGestures {
      queries.append(("""
        SELECT gesture.* FROM outbox AS held JOIN outbox AS gesture USING (gesture_id)
        WHERE held.replica = ?1 AND held.state = 'held' AND gesture.replica = ?1
        """, [handle.value]))
    }
    for n in selection.numbered {
      queries.append(("SELECT * FROM outbox WHERE replica = ? AND state = 'sent' AND n = ?", [handle.value, n]))
    }
    if let covered = selection.covered {
      queries.append(("""
        SELECT * FROM outbox WHERE replica = ? AND scope = ? AND state = 'acked' AND result_epoch = ? AND result_seq <= ?
        ORDER BY commit_order LIMIT ?
        """, [handle.value, covered.scope.text, covered.epoch, covered.cleanSeq, covered.limit]))
    }
    var read: [[UInt8]: GRDB.Row] = [:]
    for query in queries {
      for record in try GRDB.Row.fetchAll(db.cachedStatement(sql: query.sql), arguments: query.arguments) {
        read[Array((record["local_id"] as String).utf8)] = record
      }
    }
    let highest = try GRDB.Row.fetchAll(
      db.cachedStatement(sql: "SELECT local_id, commit_order FROM outbox WHERE replica = ? ORDER BY commit_order DESC LIMIT ?"),
      arguments: [handle.value, read.count + 1])
    let unread = highest.first { read[Array(($0["local_id"] as String).utf8)] == nil }
    return (try read.values.map(entry), unread?["commit_order"] ?? 0)
  }

  func entry(_ record: GRDB.Row) throws -> OutboxEntry {
    guard let state = EntryState(rawValue: record["state"]) else { throw StoreError.corrupt("entry state") }
    let baseTexts = try (record["base_texts"] as Data?).map { try Blob.json($0).asObject().members } ?? []
    var entry = OutboxEntry(
      localId: record["local_id"], gestureId: record["gesture_id"], lineage: record["lineage"],
      scope: try ScopeRef(record["scope"] as String), state: state, commitOrder: record["commit_order"],
      releaseAt: record["release_at"], stamp: try Stamp(record["stamp"] as String), intent: try Intent(json: Blob.json(record["intent"])),
      predict: try (record["predict"] as Data?).map { try Blob.json($0).asArray().map { try Delta(json: $0) } } ?? [],
      baseTexts: Dictionary(uniqueKeysWithValues: try baseTexts.map { (try TextRef(text: $0.key), try $0.value.asString()) }))
    entry.digest = (record["digest"] as Data?).map(Blob.hex)
    entry.resultSeq = record["result_seq"]
    entry.resultEpoch = record["result_epoch"]
    entry.orphanOf = record["orphan_of"]
    return entry
  }

  func cursors(of handle: ReplicaHandle) throws -> (records: [ScopeRef: CursorRecord], staging: [ScopeRef: ScopeDigest]) {
    var records: [ScopeRef: CursorRecord] = [:]
    var staging: [ScopeRef: ScopeDigest] = [:]
    for record in try GRDB.Row.fetchAll(db.cachedStatement(sql: "SELECT * FROM cursor WHERE replica = ?"), arguments: [handle.value]) {
      let scope = try ScopeRef(record["scope"] as String)
      records[scope] = CursorRecord(
        cursor: record["cursor"], digest: try ScopeDigest(bytes: [UInt8](record["digest"] as Data)), booted: record["booted"],
        behind: record["behind"], mismatchReset: record["mismatch_reset"], digestStop: record["digest_stop"])
      if let digest = record["staging_digest"] as Data? { staging[scope] = try ScopeDigest(bytes: [UInt8](digest)) }
    }
    return (records, staging)
  }

  func known(of handle: ReplicaHandle) throws -> [ScopeRef: KnownKind] {
    var known: [ScopeRef: KnownKind] = [:]
    for record in try GRDB.Row.fetchAll(db.cachedStatement(sql: "SELECT scope, kind FROM known_scope WHERE replica = ?"),
                                        arguments: [handle.value]) {
      guard let kind = KnownKind(rawValue: record["kind"]) else { throw StoreError.corrupt("known-scope kind") }
      known[try ScopeRef(record["scope"] as String)] = kind
    }
    return known
  }

  // In the order they were written.
  func notices(of handle: ReplicaHandle) throws -> [Notice] {
    try GRDB.Row.fetchAll(db, sql: "SELECT * FROM notice WHERE replica = ? ORDER BY rowid", arguments: [handle.value]).map { record in
      Notice(
        id: record["id"], product: record["product"], scope: try ScopeRef(record["scope"] as String),
        code: RefusalCode(record["code"] as String), detail: try (record["detail"] as Data?).map(Blob.json),
        content: try NoticeContent(json: Blob.json(record["content"])), at: record["at"], isDismissed: record["dismissed"])
    }
  }

  func deviceRows(of handle: ReplicaHandle) throws -> [String: JSON.Object] {
    var rows: [String: JSON.Object] = [:]
    for record in try GRDB.Row.fetchAll(db.cachedStatement(sql: "SELECT product, key, value FROM device_row WHERE replica = ?"),
                                        arguments: [handle.value]) {
      rows[record["product"], default: JSON.Object()][record["key"]] = try Blob.json(record["value"])
    }
    return rows
  }

  // §2.5: an outbox entry or a notice of any replica on the device carries the gesture id, whose local ids are
  // `<gestureId>/<k>` and notice ids `notice:<localId>`. The notices are those whose ids begin `notice:<gestureId>/`, a
  // range of the text key, which ends before `notice:<gestureId>0` since "0" is the byte after "/".
  public func carries(gestureId: String) throws -> Bool {
    if try Bool.fetchOne(db, sql: "SELECT EXISTS (SELECT 1 FROM outbox WHERE gesture_id = ?)", arguments: [gestureId]) == true {
      return true
    }
    let noticed = try String.fetchAll(db, sql: "SELECT id FROM notice WHERE id >= ? AND id < ?",
                                      arguments: ["notice:\(gestureId)/", "notice:\(gestureId)0"])
    return noticed.contains { Notice.gestureId(ofNotice: $0)?.utf8.elementsEqual(gestureId.utf8) == true }
  }

  // §7.6: the records of `type` in `scope` that the replica's entries touch, a held entry's only `withHeld`, in id order.
  public func touched(_ replica: String, in scope: ScopeRef, type: String, withHeld: Bool) throws -> [RecordKey] {
    guard let handle = try handle(of: replica) else { throw StoreError.noReplica(replica) }
    let ids = try String.fetchAll(db, sql: """
      SELECT DISTINCT outbox_touch.id FROM outbox_touch JOIN outbox USING (local_id)
      WHERE outbox.replica = ? AND outbox_touch.scope = ? AND outbox_touch.type = ? AND (? OR outbox.state <> 'held')
      """, arguments: [handle.value, scope.text, type, withHeld])
    return try ids.map { RecordKey(type, try RecordID(text: $0)) }.sorted()
  }

  // A row of `device/<product>`, found by its key's bytes as SQLite compares text.
  public func deviceRow(_ replica: String, product: String, key: String) throws -> JSON? {
    guard let handle = try handle(of: replica) else { throw StoreError.noReplica(replica) }
    return try Data.fetchOne(db, sql: "SELECT value FROM device_row WHERE replica = ? AND product = ? AND key = ?",
                             arguments: [handle.value, product, key]).map(Blob.json)
  }

  func handle(of id: String) throws -> ReplicaHandle? {
    try Int64.fetchOne(db.cachedStatement(sql: "SELECT handle FROM replica WHERE id = ?"), arguments: [id]).map(ReplicaHandle.init)
  }

  func spentIDs(of handle: ReplicaHandle, in scope: ScopeRef) throws -> [RecordKey: SpentID] {
    let records = try GRDB.Row.fetchAll(db.cachedStatement(sql: "SELECT type, id, born FROM spent WHERE replica = ? AND scope = ?"),
                                        arguments: [handle.value, scope.text])
    return Dictionary(uniqueKeysWithValues: try records.map(spentID).map { ($0.key, $0) })
  }

  func spentID(_ record: GRDB.Row) throws -> SpentID {
    SpentID(key: RecordKey(record["type"], try RecordID(text: record["id"])), born: try Stamp(record["born"] as String))
  }

  // MARK: Rows

  // The row set of `role` of a scope, nil when the scope holds none.
  func rowSet(_ role: RowRole, of handle: ReplicaHandle, in scope: ScopeRef) throws -> RowSetID? {
    try Int64.fetchOne(db.cachedStatement(sql: "SELECT id FROM row_set WHERE replica = ? AND scope = ? AND role = ?"),
                       arguments: [handle.value, scope.text, role.rawValue]).map(RowSetID.init)
  }

  // A scope's rows as a selection names them: every row, or some records and some whole types, with whether the
  // scope holds any row at all.
  func rows(_ role: RowRole, of handle: ReplicaHandle, in scope: ScopeRef, _ selection: RowSelection) throws -> Rows {
    guard let set = try rowSet(role, of: handle, in: scope) else {
      return selection.all ? Rows() : Rows(loaded: [], keys: selection.keys, types: selection.types, empty: true)
    }
    if selection.all {
      return Rows(try Data.fetchAll(db, sql: "SELECT row FROM set_row WHERE row_set = ?", arguments: [set.value]).map(Blob.row))
    }
    var loaded: [SyncCore.Row] = []
    for key in selection.keys {
      if let row = try row(in: set, key) { loaded.append(row) }
    }
    for type in selection.types {
      let records = try Data.fetchAll(db.cachedStatement(sql: "SELECT row FROM set_row WHERE row_set = ? AND type = ?"),
                                      arguments: [set.value, type])
      loaded += try records.map(Blob.row).filter { !selection.keys.contains($0.key) }
    }
    let empty = try !Bool.fetchOne(db.cachedStatement(sql: "SELECT EXISTS (SELECT 1 FROM set_row WHERE row_set = ?)"),
                                   arguments: [set.value])!
    return Rows(loaded: loaded, keys: selection.keys, types: selection.types, empty: empty)
  }

  // A pull page loads every row it carries by key, so the lookup is prepared once per connection.
  func row(in set: RowSetID, _ key: RecordKey) throws -> SyncCore.Row? {
    try Data.fetchOne(db.cachedStatement(sql: "SELECT row FROM set_row WHERE row_set = ? AND type = ? AND id = ?"),
                      arguments: [set.value, key.type, key.id.text]).map(Blob.row)
  }

  func allRows(_ role: RowRole, of handle: ReplicaHandle) throws -> [(scope: ScopeRef, row: SyncCore.Row)] {
    try GRDB.Row.fetchAll(db, sql: """
      SELECT row_set.scope, set_row.row FROM row_set JOIN set_row ON set_row.row_set = row_set.id
      WHERE row_set.replica = ? AND row_set.role = ?
      """, arguments: [handle.value, role.rawValue]).map { record in
      (try ScopeRef(record["scope"] as String), try Blob.row(record["row"]))
    }
  }

  // ER-12: the confirmed records of a type whose top-level ref `field` names `target`, in id-byte order.
  public func referencing(_ replica: String, in scope: ScopeRef, type: String, field: String, target: RecordID) throws -> [RecordKey] {
    guard registry.type(type)?.field(field)?.ref != nil else { throw StoreError.notARefField(type: type, field: field) }
    guard let handle = try handle(of: replica) else { throw StoreError.noReplica(replica) }
    guard let set = try rowSet(.confirmed, of: handle, in: scope) else { return [] }
    let ids = try String.fetchAll(db, sql: """
      SELECT id FROM set_ref WHERE row_set = ? AND type = ? AND field = ? AND target = ?
      """, arguments: [set.value, type, field, target.text])
    return try ids.map { RecordKey(type, try RecordID(text: $0)) }.sorted()
  }

  // The ref index as it stands and as the rows say it must be, as JSON lines: equal whenever the batch writer kept it true.
  public func refIndex() throws -> (stored: [JSON], expected: [JSON]) {
    let stored = try GRDB.Row.fetchAll(db, sql: "SELECT * FROM set_ref").map { record -> JSON in
      .array([JSON(record["row_set"] as Int64)] + ["type", "field", "target", "id"].map { .string(record[$0] as String) })
    }
    var expected: [JSON] = []
    for record in try GRDB.Row.fetchAll(db, sql: "SELECT row_set, row FROM set_row") {
      let row = try Blob.row(record["row"])
      for (field, target) in BatchWriter.references(of: row, registry: registry) {
        expected.append(.array([JSON(record["row_set"] as Int64)] + [row.key.type, field, target.text, row.key.id.text].map { .string($0) }))
      }
    }
    return (stored.sorted { $0.jcsPrecedes($1) }, expected.sorted { $0.jcsPrecedes($1) })
  }

  // The rows no view reads, left for the sweep (§2.5): how many, in the row sets that hold no role.
  public func releasedRows() throws -> Int {
    try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM set_row JOIN row_set ON row_set.id = set_row.row_set WHERE row_set.role IS NULL")!
  }

  // The outbox's touch index as it stands and as the entries say it must be, as JSON lines: equal whenever the batch
  // writer kept it true.
  public func touchIndex() throws -> (stored: [JSON], expected: [JSON]) {
    let stored = try GRDB.Row.fetchAll(db, sql: "SELECT * FROM outbox_touch").map { record -> JSON in
      .array(["local_id", "scope", "type", "id"].map { .string(record[$0] as String) })
    }
    var expected: [JSON] = []
    for entry in try GRDB.Row.fetchAll(db, sql: "SELECT * FROM outbox").map(entry) {
      for key in Set(entry.drawnDeltas.map(\.key)) {
        expected.append(.array([entry.localId, entry.scope.text, key.type, key.id.text].map { .string($0) }))
      }
    }
    return (stored.sorted { $0.jcsPrecedes($1) }, expected.sorted { $0.jcsPrecedes($1) })
  }
}

public enum StoreError: Error, Hashable, CustomStringConvertible {
  case noDevice
  case noReplica(String)
  case noNotice(String)
  case corrupt(String)
  case notARefField(type: String, field: String)
  case localIdTaken(String)

  public var description: String {
    switch self {
    case .noDevice: "the store holds no device row; run its first launch"
    case .noReplica(let id): "the store holds no replica \(id)"
    case .noNotice(let id): "the active replica holds no notice \(id)"
    case .corrupt(let column): "the store holds an unreadable \(column)"
    case .notARefField(let type, let field): "\(type).\(field) is not a top-level ref field"
    case .localIdTaken(let localId): "another entry or notice holds the local id \(localId), which is unique on the device"
    }
  }
}
