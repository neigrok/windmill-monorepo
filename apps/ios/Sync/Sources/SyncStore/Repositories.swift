import Foundation
import GRDB
import SyncAPI
import SyncCore
import SyncReplica

// `StoreTransaction`: an open transaction as the rest of the engine sees it, naming no GRDB type. Its loaders build the
// working copies planners change; its queries serve the readers. The outbox, cursors, staging digests, known scopes
// and device rows of a replica are always loaded whole; rows only as a planner's read set names them.

public struct StoreTransaction {
  let db: Database
  let registry: Registry

  // MARK: Device and replicas

  public func deviceMeta() throws -> (meta: DeviceMeta, active: String)? {
    guard let device = try GRDB.Row.fetchOne(db, sql: "SELECT fork_guard, pending_sign_in, active_replica FROM device") else { return nil }
    return (DeviceMeta(forkGuard: device["fork_guard"], pendingSignIn: device["pending_sign_in"]), device["active_replica"])
  }

  public func activeReplica() throws -> String {
    guard let device = try deviceMeta() else { throw StoreError.noDevice }
    return device.active
  }

  public func replicaIDs() throws -> [String] {
    try String.fetchAll(db, sql: "SELECT replica FROM replica ORDER BY rowid")
  }

  // One replica with the rows `reads` names; `notices` loads its notices too.
  public func replica(_ id: String, reads: [ScopeRef: RowSelection] = [:], notices: Bool = false) throws -> LoadedReplica? {
    guard let meta = try meta(of: id) else { return nil }
    let cursors = try cursors(of: id)
    var confirmed: [ScopeRef: Rows] = [:]
    var spent: [ScopeRef: [RecordKey: SpentID]] = [:]
    for (scope, selection) in reads {
      confirmed[scope] = try rows(.confirmed, of: id, in: scope, selection)
      spent[scope] = try spentIDs(of: id, in: scope)
    }
    var staging: [ScopeRef: Staging] = [:]
    for (scope, digest) in cursors.staging {
      staging[scope] = Staging(digest: digest, rows: try rows(.staging, of: id, in: scope, reads[scope] ?? RowSelection()))
    }
    return LoadedReplica(
      meta: meta, outbox: try outbox(of: id), confirmed: confirmed, staging: staging, spent: spent, cursors: cursors.records,
      known: try known(of: id), notices: notices ? try self.notices(of: id) : nil, deviceRows: try deviceRows(of: id), wholeScopes: false)
  }

  // Every replica with its notices and the rows `reads` names from its outbox: what the lifecycle planners read. `rows`
  // loads every row instead.
  public func device(rows: Bool = false, reads: ([OutboxEntry]) -> [ScopeRef: RowSelection] = { _ in [:] }) throws -> LoadedDevice {
    guard let device = try deviceMeta() else { throw StoreError.noDevice }
    let replicas = try replicaIDs().map { id in
      rows ? try wholeReplica(id) : try replica(id, reads: reads(try outbox(of: id)), notices: true)!
    }
    return LoadedDevice(meta: device.meta, active: device.active, replicas: replicas)
  }

  // Everything one replica holds, every row included.
  func wholeReplica(_ id: String) throws -> LoadedReplica {
    guard let meta = try meta(of: id) else { throw StoreError.noReplica(id) }
    let cursors = try cursors(of: id)
    var confirmed: [ScopeRef: Rows] = [:]
    for (scope, rows) in try Dictionary(grouping: allRows(.confirmed, of: id), by: \.scope) { confirmed[scope] = Rows(rows.map(\.row)) }
    var staging: [ScopeRef: Staging] = [:]
    let staged = try Dictionary(grouping: allRows(.staging, of: id), by: \.scope)
    for (scope, digest) in cursors.staging { staging[scope] = Staging(digest: digest, rows: Rows((staged[scope] ?? []).map(\.row))) }
    var spent: [ScopeRef: [RecordKey: SpentID]] = [:]
    for record in try GRDB.Row.fetchAll(db, sql: "SELECT scope, type, id, born FROM spent WHERE replica = ?", arguments: [id]) {
      let id = try spentID(record)
      spent[try ScopeRef(record["scope"] as String), default: [:]][id.key] = id
    }
    return LoadedReplica(
      meta: meta, outbox: try outbox(of: id), confirmed: confirmed, staging: staging, spent: spent, cursors: cursors.records,
      known: try known(of: id), notices: try notices(of: id), deviceRows: try deviceRows(of: id), wholeScopes: true)
  }

  func meta(of id: String) throws -> ReplicaMeta? {
    guard let record = try GRDB.Row.fetchOne(db, sql: "SELECT * FROM replica WHERE replica = ?", arguments: [id]) else { return nil }
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
    return meta
  }

  func outbox(of id: String) throws -> [OutboxEntry] {
    try GRDB.Row.fetchAll(db, sql: "SELECT * FROM outbox WHERE replica = ? ORDER BY commit_order", arguments: [id]).map { record in
      guard let state = EntryState(rawValue: record["state"]) else { throw StoreError.corrupt("entry state") }
      let baseTexts = try (record["base_texts"] as Data?).map { try Blob.json($0).asObject().members } ?? []
      var entry = OutboxEntry(
        localId: record["local_id"], gestureId: record["gesture_id"], lineage: record["lineage"],
        scope: try ScopeRef(record["scope"] as String), state: state, commitOrder: record["commit_order"],
        releaseAt: record["release_at"], stamp: try Stamp(record["stamp"] as String), intent: try Intent(json: Blob.json(record["intent"])),
        predict: try (record["predict"] as Data?).map { try Blob.json($0).asArray().map { try Delta(json: $0) } } ?? [],
        baseTexts: Dictionary(uniqueKeysWithValues: try baseTexts.map { (try TextRef(text: $0.key), try $0.value.asString()) }))
      entry.numbered = record["numbered"]
      entry.digest = (record["digest"] as Data?).map(Blob.hex)
      entry.resultSeq = record["result_seq"]
      entry.resultEpoch = record["result_epoch"]
      entry.orphanOf = record["orphan_of"]
      return entry
    }
  }

  func cursors(of id: String) throws -> (records: [ScopeRef: CursorRecord], staging: [ScopeRef: ScopeDigest]) {
    var records: [ScopeRef: CursorRecord] = [:]
    var staging: [ScopeRef: ScopeDigest] = [:]
    for record in try GRDB.Row.fetchAll(db, sql: "SELECT * FROM cursor WHERE replica = ?", arguments: [id]) {
      let scope = try ScopeRef(record["scope"] as String)
      records[scope] = CursorRecord(
        cursor: record["cursor"], digest: try ScopeDigest(bytes: [UInt8](record["digest"] as Data)), booted: record["booted"],
        mismatchReset: record["mismatch_reset"], digestStop: record["digest_stop"])
      if let digest = record["staging_digest"] as Data? { staging[scope] = try ScopeDigest(bytes: [UInt8](digest)) }
    }
    return (records, staging)
  }

  func known(of id: String) throws -> [ScopeRef: KnownKind] {
    var known: [ScopeRef: KnownKind] = [:]
    for record in try GRDB.Row.fetchAll(db, sql: "SELECT scope, kind FROM known_scope WHERE replica = ?", arguments: [id]) {
      guard let kind = KnownKind(rawValue: record["kind"]) else { throw StoreError.corrupt("known-scope kind") }
      known[try ScopeRef(record["scope"] as String)] = kind
    }
    return known
  }

  // In the order they were written.
  func notices(of id: String) throws -> [Notice] {
    try GRDB.Row.fetchAll(db, sql: "SELECT * FROM notice WHERE replica = ? ORDER BY rowid", arguments: [id]).map { record in
      Notice(
        id: record["id"], product: record["product"], scope: try ScopeRef(record["scope"] as String),
        code: RefusalCode(record["code"] as String), detail: try (record["detail"] as Data?).map(Blob.json),
        content: try NoticeContent(json: Blob.json(record["content"])), at: record["at"])
    }
  }

  func deviceRows(of id: String) throws -> [String: JSON.Object] {
    var rows: [String: JSON.Object] = [:]
    for record in try GRDB.Row.fetchAll(db, sql: "SELECT product, key, value FROM device_row WHERE replica = ?", arguments: [id]) {
      rows[record["product"], default: JSON.Object()][record["key"]] = try Blob.json(record["value"])
    }
    return rows
  }

  // A row of `device/<product>`, found by its key's bytes as SQLite compares text.
  public func deviceRow(_ replica: String, product: String, key: String) throws -> JSON? {
    try Data.fetchOne(db, sql: "SELECT value FROM device_row WHERE replica = ? AND product = ? AND key = ?",
                      arguments: [replica, product, key]).map(Blob.json)
  }

  func spentIDs(of id: String, in scope: ScopeRef) throws -> [RecordKey: SpentID] {
    let records = try GRDB.Row.fetchAll(db, sql: "SELECT type, id, born FROM spent WHERE replica = ? AND scope = ?", arguments: [id, scope.text])
    return Dictionary(uniqueKeysWithValues: try records.map(spentID).map { ($0.key, $0) })
  }

  func spentID(_ record: GRDB.Row) throws -> SpentID {
    SpentID(key: RecordKey(record["type"], try RecordID(text: record["id"])), born: try Stamp(record["born"] as String))
  }

  // MARK: Rows

  // A scope's rows as a selection names them: every row, or some records and some whole types, with whether the
  // scope holds any row at all.
  func rows(_ table: BatchWriter.RowTable, of id: String, in scope: ScopeRef, _ selection: RowSelection) throws -> Rows {
    if selection.all { return Rows(try allRows(table, of: id).filter { $0.scope == scope }.map(\.row)) }
    var loaded: [SyncCore.Row] = []
    for key in selection.keys {
      if let row = try row(table, of: id, in: scope, key) { loaded.append(row) }
    }
    for type in selection.types {
      let records = try Data.fetchAll(db, sql: "SELECT row FROM \(table.rawValue) WHERE replica = ? AND scope = ? AND type = ?",
                                      arguments: [id, scope.text, type])
      loaded += try records.map(Blob.row).filter { !selection.keys.contains($0.key) }
    }
    let empty = try !Bool.fetchOne(db, sql: "SELECT EXISTS (SELECT 1 FROM \(table.rawValue) WHERE replica = ? AND scope = ?)",
                                   arguments: [id, scope.text])!
    return Rows(loaded: loaded, keys: selection.keys, types: selection.types, empty: empty)
  }

  func row(_ table: BatchWriter.RowTable, of id: String, in scope: ScopeRef, _ key: RecordKey) throws -> SyncCore.Row? {
    try Data.fetchOne(db, sql: "SELECT row FROM \(table.rawValue) WHERE replica = ? AND scope = ? AND type = ? AND id = ?",
                      arguments: [id, scope.text, key.type, key.id.text]).map(Blob.row)
  }

  func allRows(_ table: BatchWriter.RowTable, of id: String) throws -> [(scope: ScopeRef, row: SyncCore.Row)] {
    try GRDB.Row.fetchAll(db, sql: "SELECT scope, row FROM \(table.rawValue) WHERE replica = ?", arguments: [id]).map { record in
      (try ScopeRef(record["scope"] as String), try Blob.row(record["row"]))
    }
  }

  // ER-12: the confirmed records of a type whose top-level ref `field` names `target`, in id-byte order.
  public func referencing(_ replica: String, in scope: ScopeRef, type: String, field: String, target: RecordID) throws -> [RecordKey] {
    guard registry.type(type)?.field(field)?.ref != nil else { throw StoreError.notARefField(type: type, field: field) }
    let ids = try String.fetchAll(db, sql: """
      SELECT id FROM confirmed_ref WHERE replica = ? AND scope = ? AND type = ? AND field = ? AND target = ?
      """, arguments: [replica, scope.text, type, field, target.text])
    return try ids.map { RecordKey(type, try RecordID(text: $0)) }.sorted()
  }

  // The ref index as it stands and as the rows say it must be, as JSON lines: equal whenever the batch writer kept it true.
  public func refIndex() throws -> (stored: [JSON], expected: [JSON]) {
    var stored: [JSON] = []
    var expected: [JSON] = []
    for table in [BatchWriter.RowTable.confirmed, .staging] {
      stored += try GRDB.Row.fetchAll(db, sql: "SELECT * FROM \(table.rawValue)_ref").map { record in
        .array(([table.rawValue] + ["replica", "scope", "type", "field", "target", "id"].map { record[$0] as String }).map { .string($0) })
      }
      for record in try GRDB.Row.fetchAll(db, sql: "SELECT replica, scope, row FROM \(table.rawValue)") {
        let row = try Blob.row(record["row"])
        let (replica, scope): (String, String) = (record["replica"], record["scope"])
        for (field, target) in BatchWriter.references(of: row, registry: registry) {
          expected.append(.array([table.rawValue, replica, scope, row.key.type, field, target.text, row.key.id.text].map { .string($0) }))
        }
      }
    }
    return (stored.sorted { $0.jcsPrecedes($1) }, expected.sorted { $0.jcsPrecedes($1) })
  }
}

public enum StoreError: Error, Hashable, CustomStringConvertible {
  case noDevice
  case noReplica(String)
  case corrupt(String)
  case notARefField(type: String, field: String)
  case localIdTaken(String)

  public var description: String {
    switch self {
    case .noDevice: "the store holds no device row; run its first launch"
    case .noReplica(let id): "the store holds no replica \(id)"
    case .corrupt(let column): "the store holds an unreadable \(column)"
    case .notARefField(let type, let field): "\(type).\(field) is not a top-level ref field"
    case .localIdTaken(let localId): "another replica holds the local id \(localId), which is unique on the device"
    }
  }
}
