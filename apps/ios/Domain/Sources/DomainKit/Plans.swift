import SyncAPI
import SyncCore

// §8.1 what a decision writes, in the kit's vocabulary. Every writing operation takes a `Valid` value, and the plan
// becomes exactly one engine gesture (§8.2).
public struct Plan: Sendable {
  var operations: [Operation] = []
  var command: Command?
  var predictions: [Prediction] = []
  var deviceWrites: [DeviceWrite] = []

  public init() {}

  // §8.4: the one command a plan runs, its string arguments normalised by the command's specs.
  public init<C: ServerCommand>(running command: C, predicting: [Prediction] = []) throws(Violation) {
    var args = JSON.object(JSON.Object(uniqueKeysWithValues: command.args.map { ($0.key, $0.value) }))
    for spec in C.specs {
      let prefix = "\(C.name)."
      precondition(spec.path.hasPrefix(prefix), "the spec \(spec.path) of \(C.name) is not at <name>.<argument>")
      let keys = spec.path.dropFirst(prefix.count).split(separator: ".").map(String.init)
      args = try Plan.applying(spec, to: args, along: keys[...], at: Path(""))
    }
    if let path = args.firstNul(at: Path("")), let argument = path.text.split(separator: ".").first {
      throw Violation(rule: "\(C.name).\(argument)", path: path, reason: .nul)
    }
    self.command = Command(name: C.name, args: args)
    predictions = predicting
  }

  // `create` writes every field of the value, or the named ones (a keyed or singleton create).
  public mutating func create<E: Writable>(_ value: Valid<E>) {
    append(.create(named: nil, base: nil), value)
  }

  public mutating func create<E: Writable>(_ value: Valid<E>, fields: [String]) {
    append(.create(named: fields.uniqueInByteOrder, base: nil), value)
  }

  public mutating func insert<E: Writable & Ordered>(_ value: Valid<E>, below anchor: RecordID?) {
    append(.insert(below: anchor), value)
  }

  // Names `value.checked` by default; the engine writes each named field whose value differs from `drawn`.
  public mutating func update<E: Writable>(_ value: Valid<E>, fields: [String]? = nil, from base: E? = nil,
                                           guarded: Bool = false) {
    append(.update(named: (fields ?? value.checked).uniqueInByteOrder, base: base?.fields, guarded: guarded), value)
  }

  public mutating func remove<E: Removable>(_ id: ID<E>) {
    operations.append(Operation(.remove, of: E.self, id: id.record))
  }

  public mutating func move<E: Ordered>(_ id: ID<E>, below anchor: ID<E>?) {
    operations.append(Operation(.move(below: anchor?.record), of: E.self, id: id.record))
  }

  public mutating func guardRead<E: Entity>(_ id: ID<E>, fields: [String]) {
    operations.append(Operation(.guardRead(fields.uniqueInByteOrder), of: E.self, id: id.record))
  }

  public mutating func device(_ key: String, _ value: JSON?) {
    deviceWrites.append(DeviceWrite(key: key, value: value))
  }

  // An insert of an entity the kit knows is ordered only by its metatype: a new draft's first save (§10.2 step 3).
  mutating func place<E: Writable>(_ value: Valid<E>, below anchor: RecordID?) {
    append(.insert(below: anchor), value)
  }

  // A keyed or singleton create whose text fields edit from the draft's base (§10.1), as a present-again save writes it.
  mutating func create<E: Writable>(_ value: Valid<E>, fields: [String], from base: E) {
    append(.create(named: fields.uniqueInByteOrder, base: base.fields), value)
  }

  mutating func append<E: Writable>(_ kind: Operation.Kind, _ value: Valid<E>) {
    operations.append(Operation(kind, of: E.self, id: value.value.id.record, values: value.value.fields, checked: value.checked))
  }

  // A plan is held iff it removes a type whose removal is held.
  var isHeld: Bool {
    operations.contains { if case .remove = $0.kind { $0.entity.heldRemoval == true } else { false } }
  }

  // Each spec reaches the strings at its path, through arrays and objects; a text or choice spec normalises them.
  static func applying(_ spec: any ValueSpec, to json: JSON, along keys: ArraySlice<String>, at path: Path) throws(Violation) -> JSON {
    switch json {
    case .array(let items):
      var applied: [JSON] = []
      for (index, item) in items.enumerated() { applied.append(try applying(spec, to: item, along: keys, at: path + index)) }
      return .array(applied)
    case .object(var members):
      guard let key = keys.first, let value = members[key] else { return json }
      members[key] = try applying(spec, to: value, along: keys.dropFirst(), at: path + key)
      return .object(members)
    case .string(let text) where keys.isEmpty:
      if let spec = spec as? TextSpec { return .string(try spec.apply(text, at: path) as String) }
      if let spec = spec as? ChoiceSpec { return .string(try spec.apply(text, at: path) as String) }
      return json
    default:
      return json
    }
  }
}

// One record operation of a plan, with what translation needs of the value it names.
struct Operation: Sendable {
  enum Kind: Sendable {
    case create(named: [String]?, base: [String: JSON]?)
    case insert(below: RecordID?)
    case update(named: [String], base: [String: JSON]?, guarded: Bool)
    case remove
    case move(below: RecordID?)
    case guardRead([String])
  }

  let kind: Kind
  let entity: EntityFacts
  let id: RecordID
  let values: [String: JSON]
  let checked: [String]

  init(_ kind: Kind, of entity: any Entity.Type, id: RecordID, values: [String: JSON] = [:], checked: [String] = []) {
    self.kind = kind
    self.entity = EntityFacts(entity)
    self.id = id
    self.values = values
    self.checked = checked
  }

  var ref: RecordRef { RecordRef(type: entity.type, id: id) }

  var writes: Bool {
    if case .guardRead = kind { return false }
    return true
  }

  var creates: Bool {
    switch kind {
    case .create, .insert: true
    default: false
    }
  }

  // The record an insert or a move places its member below.
  var anchor: RecordID? {
    switch kind {
    case .insert(let below), .move(let below): below
    default: nil
    }
  }
}

// §8.4 a registry command a plan runs, with the specs of its string arguments at `<name>.<argument>`.
public protocol ServerCommand: Sendable {
  static var name: String { get }
  static var specs: [any ValueSpec] { get }
  // `ref<t>`: an id; `time` and `instant`: `Instant.ms`.
  var args: [String: JSON] { get }
}

// The values a product expects its command to write, server-written fields included, drawn until the result arrives.
public struct Prediction: Sendable {
  enum Kind: Sendable {
    case create, update
  }

  let kind: Kind
  let type: String
  let id: RecordID
  let values: [String: JSON]

  public static func create<E: Entity>(_ type: E.Type, _ id: ID<E>, _ values: [String: JSON]) -> Prediction {
    Prediction(kind: .create, type: E.type, id: id.record, values: values)
  }

  public static func update<E: Entity>(_ type: E.Type, _ id: ID<E>, _ values: [String: JSON]) -> Prediction {
    Prediction(kind: .update, type: E.type, id: id.record, values: values)
  }
}

// §8.3 a plan translation refuses: a programming fault that fails the run and any test reaching it. `rule` is §8.3's
// number, or 0 for a write §8.2's table has no cell for.
public struct PlanError: Error, Hashable, Sendable, CustomStringConvertible {
  public let rule: Int
  public let reason: String

  public init(rule: Int, _ reason: String) {
    self.rule = rule
    self.reason = reason
  }

  public var description: String { "plan rule \(rule): \(reason)" }
}
