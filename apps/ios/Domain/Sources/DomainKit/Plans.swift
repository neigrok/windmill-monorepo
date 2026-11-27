import SyncAPI
import SyncCore

// §8.1 what a decision writes, in the kit's vocabulary. Every writing operation takes a `Valid` value, and the plan
// becomes exactly one engine gesture (§8.2).
public struct Plan: Sendable {
  var operations: [Operation] = []
  var command: Command?
  var predictions: [Prediction] = []
  var deviceWrites: [DeviceWrite] = []
  var supersededGestures: [String] = []
  var undoRecipes: [UndoRecipe] = []
  var undoChecks: [any UndoCheck] = []
  var undoEvidence = false

  public init() {}

  // §9.6: opts the plan's act into Undo after its hold, with the recipes an Undo runs.
  public mutating func undoBy(_ recipes: UndoRecipe...) {
    precondition(!recipes.isEmpty, "undoBy takes Undo recipes")
    undoRecipes += recipes
  }

  // §9.6: what the act's Undo must find standing where it is asked, as a rule its act kept that the Undo could break: the
  // runner hands it out with the act's Undo, which is asked with it.
  public mutating func undoCheckedBy(_ check: any UndoCheck) {
    undoChecks.append(check)
  }

  // §9.6: names the plan's segment for its act's Undo with no recipe of its own. The engine journals the segment's
  // receipts, which prove what another segment's command recipe names as evidence, such as a scope the act created and
  // this segment wrote.
  public mutating func evidenceForUndo() {
    undoEvidence = true
  }

  // The plan's Undo recipes as engine §7.3's `{version: 1, recipes}`, with no recipe for evidence alone, or nil when it
  // does not opt in.
  public var undo: (version: Int, recipes: [UndoRecipe])? {
    undoRecipes.isEmpty && !undoEvidence ? nil : (1, undoRecipes)
  }

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

  public mutating func revive<E: Writable>(_ value: Valid<E>, fields: [String], from base: E? = nil,
                                           guarded: Bool = false) {
    append(.revive(named: fields.uniqueInByteOrder, base: base?.fields, guarded: guarded), value)
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

  public mutating func supersede(_ gestureIds: [String]) { supersededGestures = gestureIds }

  public mutating func device(_ key: String, _ value: JSON?) {
    deviceWrites.append(DeviceWrite(key: key, value: value))
  }

  // An insert of an entity the kit knows is ordered only by its metatype: a new draft's first save (§10.2 step 4).
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
    case revive(named: [String], base: [String: JSON]?, guarded: Bool)
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

// The values a product expects its command to write, server-written fields included, drawn until the result arrives. A
// prediction names its scope when that is not the plan's: a command with scoped effects (engine E-7) may predict records
// in every scope it changes.
public struct Prediction: Sendable {
  enum Kind: Sendable {
    case create, update, write, remove
  }

  let kind: Kind
  let type: String
  let id: RecordID
  let values: [String: JSON]
  var texts: [String: String] = [:]
  var scope: ScopeRef?

  public static func write<E: Entity>(_ type: E.Type, _ id: ID<E>, _ values: [String: JSON], texts: [String: String] = [:],
                                      in scope: ScopeRef? = nil) -> Prediction {
    Prediction(kind: .write, type: E.type, id: id.record, values: values, texts: texts, scope: scope)
  }

  public static func create<E: Entity>(_ type: E.Type, _ id: ID<E>, _ values: [String: JSON], in scope: ScopeRef? = nil) -> Prediction {
    Prediction(kind: .create, type: E.type, id: id.record, values: values, scope: scope)
  }

  public static func update<E: Entity>(_ type: E.Type, _ id: ID<E>, _ values: [String: JSON], in scope: ScopeRef? = nil) -> Prediction {
    Prediction(kind: .update, type: E.type, id: id.record, values: values, scope: scope)
  }

  public static func remove<E: Entity>(_ type: E.Type, _ id: ID<E>, in scope: ScopeRef? = nil) -> Prediction {
    Prediction(kind: .remove, type: E.type, id: id.record, values: [:], scope: scope)
  }
}

// MARK: - Undo of an act (§9.6, K-3)

// A record an Undo recipe names, in its scope or, nil, in the scope of the plan that carries it.
public struct UndoRecord: Sendable {
  let key: RecordKey
  let scope: ScopeRef?

  public static func of<E: Entity>(_ id: ID<E>, in scope: ScopeRef? = nil) -> UndoRecord {
    UndoRecord(key: RecordKey(E.type, id.record), scope: scope)
  }
}

// One slot of a record an Undo recipe names: a field, a text or the life.
public struct UndoTarget: Sendable {
  let record: UndoRecord
  let slot: EffectSlot.Slot

  public static func field<E: Entity>(_ id: ID<E>, _ name: String, in scope: ScopeRef? = nil) -> UndoTarget {
    UndoTarget(record: .of(id, in: scope), slot: .field(name))
  }

  public static func text<E: Entity>(_ id: ID<E>, _ name: String, in scope: ScopeRef? = nil) -> UndoTarget {
    UndoTarget(record: .of(id, in: scope), slot: .text(name))
  }

  public static func life<E: Entity>(_ id: ID<E>, in scope: ScopeRef? = nil) -> UndoTarget {
    UndoTarget(record: .of(id, in: scope), slot: .life)
  }
}

// What an Undo of a plan's writes runs, the closed union: earlier values of client fields, texts and lives by the scope's
// restore command, a target unset before the act carrying the value equivalent to unset; a record the plan created,
// deleted again while its own writes are all that changed it; or a product's inverse command over the evidence the
// engine builds.
public enum UndoRecipe: Sendable {
  case fields(restoreCommand: String, targets: [(target: UndoTarget, default: JSON?)])
  case createdRecord(restoreCommand: String, record: UndoRecord)
  case command(String, input: JSON, ownedFields: [UndoTarget] = [], unchangedCreatedRecords: [UndoRecord] = [],
               unchangedCreatedScopes: [ScopeRef] = [])
}

// A product's Redo of one source of an inverse act, by its ordinal, with the scope that source wrote: its plan's Undo
// recipes stand in for the stored ones, as a Redo of a terminal creation names its own command and a fresh id.
public struct ProductSlot: Sendable {
  public let index: Int
  public let scope: ScopeRef
  public let plan: Plan

  public init(index: Int, scope: ScopeRef, plan: Plan) {
    self.index = index
    self.scope = scope
    self.plan = plan
  }
}

// What an act's Undo must find standing where it is asked, read in one scope: `check` throws the `Violation` the Undo
// would break, as a decide does, and the Undo then writes nothing. A plan names it beside its recipes.
public protocol UndoCheck: Sendable {
  var scope: ScopeRef { get }
  func check(_ read: Reader) throws
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
