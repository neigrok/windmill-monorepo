import SyncAPI
import SyncCore

// §3.1 the interfaces a product declares its entities on. An entity is a value; the kit derives every engine operation
// from its registry type.

public protocol Entity: Sendable {
  static var type: String { get }
  static var scope: ScopeRef { get }
  var id: ID<Self> { get }
  init(_ record: Fields) throws(DecodeError)
}

public protocol Writable: Entity {
  // Every field the client writes, a nil value as JSON null.
  var fields: [String: JSON] { get }
  // In the order violations are reported.
  static var checks: [Check<Self>] { get }
}

public protocol Removable: Entity {
  static var heldRemoval: Bool { get }
}

public protocol Ordered: Entity {
  static var orderField: String { get }
}

public protocol Draftable: Writable {
  static var savesGuarded: Bool { get }
}

// A record that is one fact (engine §2.4 `wholePut`) whose every save records its own moment: the save writes
// `timestampField`, a client `lww` field of integer milliseconds, with the commit's now (engine §7.1 step 4).
public protocol Timestamped: Draftable {
  static var timestampField: String { get }
}

// D-5 a record id only an entity of type `E` carries; ids order by the UTF-8 bytes of their JCS.
public struct ID<E: Entity>: Hashable, Comparable, Sendable, CustomStringConvertible {
  public let record: RecordID

  public init(_ record: RecordID) {
    self.record = record
  }

  // §5.3: a keyed type whose key is a local date takes its text as the id.
  public init(_ day: LocalDay) {
    record = RecordID(day.text)
  }

  public var day: LocalDay? { record.string.flatMap(LocalDay.init) }
  public var ref: RecordRef { RecordRef(type: E.type, id: record) }
  public var json: JSON { record.json }
  public var description: String { record.description }

  public static func < (a: ID, b: ID) -> Bool { a.record < b.record }
}

// What the kit knows of an entity type from its declaration, read once from its metatype.
struct EntityFacts: Sendable {
  let entity: any Entity.Type
  let type: String
  let scope: ScopeRef
  let orderField: String?
  let heldRemoval: Bool?
  let savesGuarded: Bool?
  let timestampField: String?

  init(_ entity: any Entity.Type) {
    self.entity = entity
    type = entity.type
    scope = entity.scope
    orderField = (entity as? any Ordered.Type)?.orderField
    heldRemoval = (entity as? any Removable.Type)?.heldRemoval
    savesGuarded = (entity as? any Draftable.Type)?.savesGuarded
    timestampField = (entity as? any Timestamped.Type)?.timestampField
  }

  var isRemovable: Bool { heldRemoval != nil }
  var isOrdered: Bool { orderField != nil }
  var isGuarded: Bool { savesGuarded == true }
}

// MARK: - Fields

// §3.3 the reader of one record, or of one JSON object inside a record. A read is lenient to the registry: it never
// applies a LOCAL rule, and a value another writer stored reads as stored.
public struct Fields {
  let type: String
  let path: String
  let recordID: RecordID?
  let values: JSON.Object
  let serials: JSON.Object

  public init(_ record: Record) {
    var values = JSON.Object(uniqueKeysWithValues: record.values.map { ($0.key, $0.value) })
    for (name, text) in record.texts { values[name] = .string(text.text) }
    self.init(type: record.type, path: "", recordID: record.id, values: values,
              serials: JSON.Object(uniqueKeysWithValues: record.serials.map { ($0.key, $0.value) }))
  }

  public init(_ object: JSON) throws(DecodeError) {
    try self.init(object, type: "", path: "")
  }

  // A value object inside a record of `type`, at `path`, so a failure names where it is.
  init(_ object: JSON, type: String, path: String) throws(DecodeError) {
    guard case .object(let members) = object else { throw DecodeError(type: type, field: path, reason: "not an object") }
    self.init(type: type, path: path, recordID: nil, values: members, serials: JSON.Object())
  }

  // §3.4 step 7: the record an entity's `fields` build, which decoding turns back into the entity.
  package init(type: String, id: RecordID, values: [String: JSON]) {
    self.init(type: type, path: "", recordID: id, values: JSON.Object(uniqueKeysWithValues: values.map { ($0.key, $0.value) }),
              serials: JSON.Object())
  }

  init(type: String, path: String, recordID: RecordID?, values: JSON.Object, serials: JSON.Object) {
    self.type = type
    self.path = path
    self.recordID = recordID
    self.values = values
    self.serials = serials
  }

  public var id: RecordID {
    guard let recordID else { preconditionFailure("the fields of a value object have no record id") }
    return recordID
  }

  public func string(_ f: String) throws(DecodeError) -> String {
    guard case .string(let text) = try present(f) else { throw failure(f, "not a string") }
    return text
  }

  public func string(_ f: String, default d: String) throws(DecodeError) -> String {
    isAbsent(f) ? d : try string(f)
  }

  public func optionalString(_ f: String) throws(DecodeError) -> String? {
    isAbsent(f) ? nil : try string(f)
  }

  public func int(_ f: String) throws(DecodeError) -> Int {
    guard case .number(let number) = try present(f), let integer = Int(exactly: number.value) else {
      throw failure(f, "not an integer")
    }
    return integer
  }

  public func optionalInt(_ f: String) throws(DecodeError) -> Int? {
    isAbsent(f) ? nil : try int(f)
  }

  public func double(_ f: String) throws(DecodeError) -> Double {
    guard case .number(let number) = try present(f) else { throw failure(f, "not a number") }
    return number.value
  }

  public func optionalDouble(_ f: String) throws(DecodeError) -> Double? {
    isAbsent(f) ? nil : try double(f)
  }

  public func bool(_ f: String) throws(DecodeError) -> Bool {
    guard case .bool(let flag) = try present(f) else { throw failure(f, "not a boolean") }
    return flag
  }

  public func bool(_ f: String, default d: Bool) throws(DecodeError) -> Bool {
    isAbsent(f) ? d : try bool(f)
  }

  // Any integer-millisecond field: a time field, or an instant a person chose.
  public func instant(_ f: String) throws(DecodeError) -> Instant {
    guard case .number(let number) = try present(f), let ms = Int64(exactly: number.value) else {
      throw failure(f, "not an integer of milliseconds")
    }
    return Instant(ms: ms)
  }

  public func optionalInstant(_ f: String) throws(DecodeError) -> Instant? {
    isAbsent(f) ? nil : try instant(f)
  }

  public func ref<E: Entity>(_ f: String, _ type: E.Type) throws(DecodeError) -> ID<E> {
    let value = try present(f)
    guard let id = try? RecordID(json: value) else { throw failure(f, "not an id") }
    return ID(id)
  }

  public func optionalRef<E: Entity>(_ f: String, _ type: E.Type) throws(DecodeError) -> ID<E>? {
    isAbsent(f) ? nil : try ref(f, type)
  }

  public func value<V: ValueObject>(_ f: String, of: V.Type) throws(DecodeError) -> V {
    try V(Fields(try present(f), type: self.type, path: named(f)))
  }

  public func optionalValue<V: ValueObject>(_ f: String, of: V.Type) throws(DecodeError) -> V? {
    isAbsent(f) ? nil : try value(f, of: of)
  }

  public func list<V: ValueObject>(_ f: String, of: V.Type) throws(DecodeError) -> [V] {
    guard case .array(let items) = try present(f) else { throw failure(f, "not an array") }
    var list: [V] = []
    for (index, item) in items.enumerated() {
      list.append(try V(Fields(item, type: type, path: "\(named(f)).\(index)")))
    }
    return list
  }

  public func optionalList<V: ValueObject>(_ f: String, of: V.Type) throws(DecodeError) -> [V]? {
    isAbsent(f) ? nil : try list(f, of: of)
  }

  // A text field's text; "" when unset.
  public func text(_ f: String) -> String {
    guard case .string(let text)? = values[f] else { return "" }
    return text
  }

  // A confirmed serial with any pending command prediction overlaid (engine §7.6).
  public func serial(_ f: String) -> Int? {
    guard case .number(let number)? = serials[f] else { return nil }
    return Int(exactly: number.value)
  }

  public func json(_ f: String) -> JSON? {
    values[f] ?? serials[f]
  }

  // For a non-optional getter, null is absent.
  func present(_ f: String) throws(DecodeError) -> JSON {
    guard let value = values[f], !value.isNull else { throw failure(f, "absent") }
    return value
  }

  func isAbsent(_ f: String) -> Bool {
    values[f]?.isNull ?? true
  }

  func named(_ f: String) -> String {
    path.isEmpty ? f : "\(path).\(f)"
  }

  func failure(_ f: String, _ reason: String) -> DecodeError {
    DecodeError(type: type, field: named(f), reason: reason)
  }
}

public struct DecodeError: Error, Equatable, Sendable, CustomStringConvertible {
  public let type: String, field: String, reason: String

  public init(type: String, field: String, reason: String) {
    self.type = type
    self.field = field
    self.reason = reason
  }

  public var description: String { "\(type).\(field): \(reason)" }
}
