import SyncAPI
import SyncCore

// §7.1 what a load reads through, valid only inside the one run or read that made it.
public struct Reader {
  public let moment: Moment
  let scope: ScopeRef
  let source: any ScopeReader
  let registry: Registry

  package init(_ source: any ScopeReader, scope: ScopeRef, moment: Moment, registry: Registry) {
    self.source = source
    self.scope = scope
    self.moment = moment
    self.registry = registry
  }

  public var replica: String { (source as? any CommitContext)?.replica ?? "" }
  public var actor: String { (source as? any CommitContext)?.actor ?? "" }
  public var isAnonymous: Bool { source.isAnonymous }
  public func commands() throws -> [QueuedCommand] { try (source as? any CommitContext)?.commands() ?? [] }
  public func devices(prefix: String) throws -> JSON.Object { try source.devices(prefix: prefix) }
  public func checkpoint() throws -> ScopeCheckpoint { try source.checkpoint() }
  public func confirmed<E: Entity>(_ type: E.Type, _ id: ID<E>) throws -> Record? { try source.confirmed(E.type, id.record) }

  public func repository<E: Entity>(_ type: E.Type) -> Repository<E> {
    Repository(source: source, registry: registry)
  }

  // A `device/<product>` row of the scope's product (engine §2.5).
  public func device(_ key: String) throws -> JSON? {
    try source.device(key)
  }

  // Engine §7.9, for the reader's scope. A read that asserts absence waits for it.
  public func firstPullComplete() throws -> Bool {
    try source.firstPullComplete()
  }
}

// §7.2 the records of one entity type. The view is always explicit: `stored` decides, `drawn` draws (INV-9).
public struct Repository<E: Entity> {
  let source: any ScopeReader
  let registry: Registry

  public func find(_ id: ID<E>, in view: ViewMode) throws -> E? {
    guard let record = try record(id.record, in: view), record.isVisible else { return nil }
    return try E(Fields(record))
  }

  public func all(in view: ViewMode) throws -> [E] {
    try Repository.decode(view == .drawn ? source.drawn(E.type) : source.stored(E.type))
  }

  // Through the engine's indexed read (ER-12): the cost follows the children, not the type.
  public func children<P: Entity>(of parent: ID<P>, via field: String, in view: ViewMode) throws -> [E] {
    let records = view == .drawn
      ? try source.drawn(E.type, where: field, is: parent.record)
      : try source.stored(E.type, where: field, is: parent.record)
    return try Repository.decode(records)
  }

  public func capacity() throws -> Capacity {
    Capacity(of: E.self, stored: try source.stored(E.type), registry: registry)
  }

  public func record(_ id: ID<E>, in view: ViewMode) throws -> Record? { try record(id.record, in: view) }

  // The visible records, decoded in `all`'s order: an `Ordered` type by its key then its id, any other by its id. A record
  // that does not decode is a schema fault, surfaced, never skipped.
  public static func decode(_ records: some Sequence<Record>) throws(DecodeError) -> [E] {
    var entities: [E] = []
    for record in ordered(records.filter(\.isVisible)) {
      entities.append(try E(Fields(record)))
    }
    return entities
  }

  // §7.5: top → none; below(x) → x; bottom → the last member in `stored` order, a held one included, or none.
  func anchor(_ placement: Placement, orderField: String) throws -> RecordID? {
    switch placement {
    case .top: return nil
    case .below(let above): return above
    case .bottom: return Repository.ordered(try source.stored(E.type).filter(\.isVisible), by: orderField).last?.id
    }
  }

  // The record of a view, visible or not: the engine's folded record (ER-3).
  func record(_ id: RecordID, in view: ViewMode) throws -> Record? {
    view == .drawn ? try source.drawn(E.type, id) : try source.stored(E.type, id)
  }

  static func ordered(_ records: [Record]) -> [Record] {
    guard let orderField = (E.self as? any Ordered.Type)?.orderField else { return records.sorted { $0.id < $1.id } }
    return ordered(records, by: orderField)
  }

  // Engine D-25: a list sorts by `(key, id)`, keys by their bytes; an unset key sorts as "".
  static func ordered(_ records: [Record], by orderField: String) -> [Record] {
    let key = { (record: Record) -> [UInt8] in
      guard case .string(let key)? = record.values[orderField] else { return [] }
      return Array(key.utf8)
    }
    return records.sorted { a, b in
      let (keyA, keyB) = (key(a), key(b))
      guard keyA == keyB else { return keyA.lexicographicallyPrecedes(keyB) }
      return a.id < b.id
    }
  }
}

extension Repository where E: Ordered {
  public func anchor(_ placement: Placement) throws -> RecordID? {
    try anchor(placement, orderField: E.orderField)
  }
}

// §7.3 how full a capped type is: `used` counts the visible `stored` records, so a record inside its delete window keeps
// its slot, as the engine's commit-time check counts it.
public struct Capacity: Equatable, Sendable {
  public let type: String, used: Int, cap: Int

  public init<E: Entity>(of: E.Type, stored: some Collection<Record>, registry: Registry) {
    guard let cap = registry.type(E.type)?.cap else { preconditionFailure("\(E.type) has no cap in the registry") }
    type = E.type
    used = stored.filter { $0.isVisible && $0.type.utf8.elementsEqual(E.type.utf8) }.count
    self.cap = cap
  }

  // The UI's "full" line.
  public var isFull: Bool { used >= cap }

  // The engine's growth rule (engine §6.1 step 12): a plan whose creates of the type less its removals of it, `growth`,
  // raise `used` past `cap` is refused `cap`, about `subject`, the first record it creates.
  public func refusal(growing growth: Int, subject: RecordRef?) -> Refused? {
    guard growth > 0, used + growth > cap else { return nil }
    return Refused(.cap, subject: subject, detail: ["type": .string(type), "cap": JSON(cap)], path: .predicted)
  }
}

// §7.5 where a new member of an ordered list goes.
public enum Placement: Hashable, Sendable {
  case top, below(RecordID), bottom
}
