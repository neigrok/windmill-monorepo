import SyncAPI
import SyncCore

// §7.6 views: a scope's confirmed rows joined with its pending deltas and predictions in commit order. `drawn` folds
// held entries too, `stored` leaves them out; texts are the newest pending text; serials come only from confirmed rows.

public struct ViewRecord: Sendable, Hashable {
  public var key: RecordKey
  public var lattice: Lattice
  public var texts: [String: String]
  public var serials: [String: JSON]

  public init(key: RecordKey, lattice: Lattice = Lattice(), texts: [String: String] = [:], serials: [String: JSON] = [:]) {
    self.key = key
    self.lattice = lattice
    self.texts = texts
    self.serials = serials
  }

  public init(_ row: Row) {
    self.init(key: row.key, lattice: row.lattice, texts: row.texts.mapValues(\.text), serials: row.serials)
  }

  public func value(_ field: String) -> JSON? { lattice.fields[field]?.value }

  public var json: JSON {
    var object: JSON.Object = ["t": .string(key.type), "id": key.id.json]
    object["life"] = lattice.life?.json
    object["born"] = lattice.born?.json
    object["f"] = JSON.object(from: lattice.fields) { $0.json }
    object["x"] = JSON.object(from: texts) { .string($0) }
    object["v"] = JSON.object(from: serials) { $0 }
    return .object(object)
  }
}

public struct ScopeView: Sendable {
  public let scope: ScopeRef
  public let mode: ViewMode
  let registry: Registry
  let coverage: Rows
  public private(set) var loaded: [RecordKey: ViewRecord]

  public init(_ replica: LoadedReplica, _ scope: ScopeRef, _ mode: ViewMode, registry: Registry) throws {
    self.scope = scope
    self.mode = mode
    self.registry = registry
    coverage = replica.rows(scope)
    loaded = coverage.loaded.mapValues(ViewRecord.init)
    for entry in replica.entriesTouchingReads where entry.scope == scope && (entry.state != .held || mode == .drawn) {
      for delta in entry.drawnDeltas { try fold(delta) }
    }
  }

  // Whether the load read `key`'s row and entries, so `record` can answer for it.
  public func covers(_ key: RecordKey) -> Bool {
    coverage.covers(key)
  }

  // The folded record, visible or not; nil when no row, delta or prediction names it.
  public func record(_ key: RecordKey) -> ViewRecord? {
    precondition(coverage.covers(key), "\(key) was viewed but its row was not loaded")
    return loaded[key]
  }

  // Every record of a type, visible or not, in record order.
  public func records(ofType type: String) -> [ViewRecord] {
    precondition(coverage.covers(type: type), "the records of \(type) were viewed but not loaded")
    return loaded.values.filter { $0.key.type.utf8.elementsEqual(type.utf8) }.sorted { $0.key < $1.key }
  }

  public var all: [ViewRecord] {
    precondition(coverage.coverage == .all, "every record was viewed but not every row was loaded")
    return loaded.values.sorted { $0.key < $1.key }
  }

  // §7.6 visible(r): a singleton always; a type with life while alive; otherwise by `visibleWhen`, or any field set.
  // A record of a type the registry does not know is never visible.
  public func isVisible(_ record: ViewRecord) -> Bool {
    Visibility.of(record.key.type, registry: registry, life: record.lattice.life) { name in
      record.texts[name].map(JSON.string) ?? record.value(name)
    } anySet: { !record.lattice.fields.isEmpty || !record.texts.isEmpty }
  }

  // capCount(t) over this view.
  public func visibleCount(_ type: String) -> Int {
    records(ofType: type).filter(isVisible).count
  }

  // One delta folded in: the lattice join, and its texts replacing the view's.
  public mutating func fold(_ delta: Delta) throws {
    let current = loaded[delta.key] ?? ViewRecord(key: delta.key)
    var next = current
    next.lattice = try Join.record(registry.type(delta.key.type), current.lattice, delta.lattice)
    for (name, write) in delta.texts { next.texts[name] = write.text }
    loaded[delta.key] = next
  }
}

// §7.6 visible(r), shared by views and rows: `value` reads a field's value, `anySet` says whether any field is set.
public enum Visibility {
  public static func of(_ row: Row, registry: Registry) -> Bool {
    of(row.key.type, registry: registry, life: row.lattice.life) { name in
      row.texts[name].map { JSON.string($0.text) } ?? row.lattice.fields[name]?.value
    } anySet: { !row.lattice.fields.isEmpty || !row.texts.isEmpty }
  }

  public static func of(_ type: String, registry: Registry, life: Life?, value: (String) -> JSON?, anySet: () -> Bool) -> Bool {
    guard let def = registry.type(type) else { return false }
    if def.identity == .singleton { return true }
    if def.life { return life?.isAlive ?? false }
    guard let fields = def.visibleWhen else { return anySet() }
    return fields.contains { name in
      guard let value = value(name) else { return false }
      return !value.isNull && value != ""
    }
  }
}
