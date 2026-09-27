import SyncAPI
import SyncCore

// §8.2 a plan becomes one gesture, by each type's identity class, and §8.3's rules refuse a plan no write path makes. The
// kit's test support reads a decision's gesture through it.
extension Plan {
  package func gesture(in scope: ScopeRef, registry: Registry) throws(PlanError) -> Gesture {
    var changes: [Change] = []
    for operation in operations {
      if let change = try operation.change(in: scope, registry: registry) { changes.append(change) }
    }
    try checkOneOperationPerRecord(registry)
    try checkHeldPlan()
    return Gesture(
      changes: changes,
      atomic: changes.count > 1,
      hold: isHeld,
      guards: try guards(registry),
      retire: retire(registry),
      command: command,
      predict: try predicted(registry),
      local: deviceWrites)
  }

  // Rule 2.
  func checkOneOperationPerRecord(_ registry: Registry) throws(PlanError) {
    var named: [RecordKey] = []
    for operation in operations {
      let key = RecordKey(operation.entity.type, operation.recordID(in: registry))
      guard !named.contains(key) else { throw PlanError(rule: 2, "two operations name \(key)") }
      named.append(key)
    }
  }

  // Rule 3: a held plan removes held types and writes device rows, and nothing else.
  func checkHeldPlan() throws(PlanError) {
    guard isHeld else { return }
    for operation in operations {
      guard case .remove = operation.kind, operation.entity.heldRemoval == true else {
        throw PlanError(rule: 3, "a held plan holds an operation on \(operation.ref) other than a held removal")
      }
    }
    guard command == nil, predictions.isEmpty else { throw PlanError(rule: 3, "a held plan runs a command") }
  }

  // Every lattice field a guarded update names, and every `guardRead` register, by type, id, then field bytes.
  func guards(_ registry: Registry) throws(PlanError) -> [RegisterRef] {
    var guards: [RegisterRef] = []
    for operation in operations {
      let definition = registry.type(operation.entity.type)
      switch operation.kind {
      case .update(let named, _, true):
        guards += named.filter { definition?.field($0)?.kind.isLattice == true }
          .map { RegisterRef(type: operation.entity.type, id: operation.recordID(in: registry), field: $0) }
      case .guardRead(let fields):
        for field in fields {
          guard definition?.field(field)?.kind.isLattice == true else {
            throw PlanError(rule: 6, "\(operation.entity.type).\(field) is no lattice register to guard")
          }
          guards.append(RegisterRef(type: operation.entity.type, id: operation.recordID(in: registry), field: field))
        }
      default: continue
      }
    }
    return guards.sorted(by: Plan.precedes).reduce(into: []) { unique, register in
      if unique.last != register { unique.append(register) }
    }
  }

  // Every keyed-with-life record the plan creates.
  func retire(_ registry: Registry) -> [RecordRef] {
    operations.filter { operation in
      guard operation.creates, let definition = registry.type(operation.entity.type) else { return false }
      return definition.identity == .keyed && definition.life
    }.map(\.ref).sorted { a, b in
      a.type.utf8.elementsEqual(b.type.utf8) ? a.id < b.id : a.type.utf8.lexicographicallyPrecedes(b.type.utf8)
    }
  }

  // Rule 5: every prediction is of a type the command's registry entry predicts.
  func predicted(_ registry: Registry) throws(PlanError) -> [Change] {
    var changes: [Change] = []
    for prediction in predictions {
      guard let command, registry.command(command.name)?.predicts.contains(where: { $0.utf8.elementsEqual(prediction.type.utf8) }) == true
      else { throw PlanError(rule: 5, "the plan's command does not predict \(prediction.type)") }
      switch prediction.kind {
      case .create: changes.append(.create(prediction.type, id: .given(prediction.id), prediction.values))
      case .update: changes.append(.update(prediction.type, prediction.id, prediction.values))
      }
    }
    return changes
  }

  static func precedes(_ a: RegisterRef, _ b: RegisterRef) -> Bool {
    if !a.type.utf8.elementsEqual(b.type.utf8) { return a.type.utf8.lexicographicallyPrecedes(b.type.utf8) }
    if a.id != b.id { return a.id < b.id }
    return a.field.utf8.lexicographicallyPrecedes(b.field.utf8)
  }
}

extension Operation {
  // The table's cell for this operation, or nil for a guard, which writes nothing.
  func change(in scope: ScopeRef, registry: Registry) throws(PlanError) -> Change? {
    guard let definition = registry.type(entity.type) else { throw PlanError(rule: 0, "the registry holds no type \(entity.type)") }
    guard entity.scope == scope, registry.lives(entity.type, in: scope) else {
      throw PlanError(rule: 1, "\(entity.type) lives outside the action's scope \(scope)")
    }
    guard definition.identity != .derived else { throw PlanError(rule: 0, "the kit writes no derived type (\(entity.type))") }
    switch kind {
    case .create(let named, let base):
      guard !entity.isOrdered else { throw PlanError(rule: 4, "create names the ordered type \(entity.type); insert places it") }
      guard named == nil || definition.identity != .minted else {
        throw PlanError(rule: 4, "create(_:fields:) names the minted type \(entity.type)")
      }
      return try creation(definition, writing: named ?? Array(values.keys).uniqueInByteOrder, anchor: nil, editedFrom: base)
    case .insert(let below):
      guard let orderField = entity.orderField else { throw PlanError(rule: 4, "insert names the unordered type \(entity.type)") }
      return try creation(definition, writing: Array(values.keys).uniqueInByteOrder,
                          anchor: OrderAnchor(field: orderField, below: below))
    case .update(let named, let base, _):
      return try update(definition, writing: named, base: base)
    case .remove:
      return try removal(definition)
    case .move(let below):
      guard let orderField = entity.orderField, definition.identity != .singleton else {
        throw PlanError(rule: 0, "the singleton \(entity.type) has no order to move in")
      }
      return .move(entity.type, id, to: OrderAnchor(field: orderField, below: below))
    case .guardRead:
      return nil
    }
  }

  // A minted create leaves a nil time field unset, so the engine stamps it with the commit's now (§5.3, engine §7.1
  // step 4).
  func creation(_ definition: TypeDef, writing names: [String], anchor: OrderAnchor?, editedFrom base: [String: JSON]? = nil)
    throws(PlanError) -> Change {
    var (values, texts) = try split(names, definition, editedFrom: base)
    if definition.identity == .minted {
      values = values.filter { name, value in !(value.isNull && definition.field(name)?.isTime == true) }
    }
    guard anchor == nil || definition.identity == .minted else {
      throw PlanError(rule: 0, "an anchored create of the \(definition.identity.rawValue) type \(entity.type)")
    }
    if definition.identity != .minted && names.isEmpty {
      throw PlanError(rule: 8, "a keyed create of \(ref) writes no field")
    }
    switch definition.identity {
    case .minted: return .create(entity.type, id: .given(id), values, texts: texts, anchor: anchor)
    case .keyed where definition.life: return .put(entity.type, id, present: true, values, texts: texts)
    default: return .write(entity.type, recordID(in: definition), values, texts: texts)
    }
  }

  func update(_ definition: TypeDef, writing names: [String], base: [String: JSON]?) throws(PlanError) -> Change {
    guard !names.isEmpty else { throw PlanError(rule: 8, "an update of \(ref) names no field") }
    for name in names {
      guard let kind = definition.field(name)?.kind else { continue }
      switch kind {
      case .const, .time: throw PlanError(rule: 7, "an update names the \(kind.name) field \(entity.type).\(name)")
      case .text where base == nil: throw PlanError(rule: 7, "an update names the text field \(entity.type).\(name) without a base")
      default: continue
      }
    }
    let (values, texts) = try split(names, definition, editedFrom: base)
    switch definition.identity {
    case .minted: return .update(entity.type, id, values, texts: texts)
    case .keyed where definition.life: return .put(entity.type, id, present: nil, values, texts: texts)
    default: return .write(entity.type, recordID(in: definition), values, texts: texts)
    }
  }

  func removal(_ definition: TypeDef) throws(PlanError) -> Change {
    switch definition.identity {
    case .minted: return .delete(entity.type, id)
    case .keyed where definition.life: return .put(entity.type, id, present: false)
    default: throw PlanError(rule: 0, "the \(entity.type) type has no life to remove")
    }
  }

  // Rule 6, then the named fields' values: a text field as a `TextEdit` from its base's text, or from "" in a create.
  func split(_ names: [String], _ definition: TypeDef, editedFrom base: [String: JSON]?) throws(PlanError)
    -> (values: [String: JSON], texts: [String: TextEdit]) {
    var values: [String: JSON] = [:]
    var texts: [String: TextEdit] = [:]
    for name in names {
      guard let field = definition.field(name), field.writer == .client else {
        throw PlanError(rule: 6, "\(entity.type).\(name) is no client-written field")
      }
      if case .serial = field.kind { throw PlanError(rule: 6, "\(entity.type).\(name) is a serial") }
      guard name != entity.orderField else { throw PlanError(rule: 6, "\(entity.type).\(name) is the order field") }
      guard let value = self.values[name] else { throw PlanError(rule: 6, "\(entity.type).\(name) is not among the value's fields") }
      guard checked.contains(name) else { throw PlanError(rule: 6, "\(entity.type).\(name) was not checked") }
      guard case .text = field.kind else {
        values[name] = value
        continue
      }
      guard case .string(let text) = value, case .string(let from) = base?[name] ?? .string("") else {
        throw PlanError(rule: 6, "the text field \(entity.type).\(name) or its base holds no text")
      }
      texts[name] = TextEdit(text: text, editedFrom: from)
    }
    return (values, texts)
  }

  // A singleton's record is its registry id.
  func recordID(in definition: TypeDef) -> RecordID {
    definition.singletonId.map { RecordID($0) } ?? id
  }

  func recordID(in registry: Registry) -> RecordID {
    registry.type(entity.type).map(recordID(in:)) ?? id
  }
}

extension FieldDef {
  var isTime: Bool {
    if case .time = kind { return true }
    return false
  }
}
