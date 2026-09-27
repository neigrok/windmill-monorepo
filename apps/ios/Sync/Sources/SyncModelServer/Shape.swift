import SyncCore

// §6.1 step 2: an intent as it arrives, checked against the registry into the form admission runs. Any failure is
// `invalid`; then a stamp past the skew bound is `clock-skew`, time values past it are clamped, and instants past it
// are `invalid`.

// A stamp position: the stamp a client wrote, or one the server mints at §6.1 step 9 (§10.3).
public enum StampSlot: Sendable, Hashable {
  case given(Stamp)
  case server

  public var stamp: Stamp? {
    if case .given(let stamp) = self { return stamp }
    return nil
  }
}

// §4.1 the op a delta's shape makes for its type.
public enum Op: String, Sendable, CaseIterable {
  case create, update, delete, revive, put, write
}

// A register or a life whose stamp may still be the server's to mint.
public struct PlannedRegister: Sendable, Hashable {
  public var value: JSON
  public var slot: StampSlot

  public init(_ value: JSON, _ slot: StampSlot) {
    self.value = value
    self.slot = slot
  }
}

public struct PlannedLife: Sendable, Hashable {
  public var state: Life.State
  public var slot: StampSlot

  public init(_ state: Life.State, _ slot: StampSlot) {
    self.state = state
    self.slot = slot
  }
}

// D-12 a delta as admission runs it: its op, and stamps that may be the server's.
public struct PlannedDelta: Sendable, Hashable {
  public var key: RecordKey
  public var op: Op
  public var life: PlannedLife?
  public var born: StampSlot?
  public var fields: [String: PlannedRegister]
  public var texts: [String: TextWrite]

  public init(key: RecordKey, op: Op, life: PlannedLife? = nil, born: StampSlot? = nil, fields: [String: PlannedRegister] = [:],
              texts: [String: TextWrite] = [:]) {
    self.key = key
    self.op = op
    self.life = life
    self.born = born
    self.fields = fields
    self.texts = texts
  }

  // A server create: born and life at the stamp the pass mints (§10.3).
  public static func serverCreate(_ key: RecordKey, fields: [String: JSON] = [:]) -> PlannedDelta {
    PlannedDelta(key: key, op: .create, life: PlannedLife(.alive, .server), born: .server,
                 fields: fields.mapValues { PlannedRegister($0, .server) })
  }

  // A server write to an existing record, named by its born when it has one.
  public static func serverUpdate(_ key: RecordKey, born: Stamp?, fields: [String: JSON]) -> PlannedDelta {
    PlannedDelta(key: key, op: born == nil ? .write : .update, born: born.map(StampSlot.given),
                 fields: fields.mapValues { PlannedRegister($0, .server) })
  }

  // A server delete of a record born at `born`.
  public static func serverDelete(_ key: RecordKey, born: Stamp?) -> PlannedDelta {
    PlannedDelta(key: key, op: born == nil ? .put : .delete, life: PlannedLife(.dead, .server), born: born.map(StampSlot.given))
  }

  // A copy into a scope the intent creates (§6.1 step 14): the source's registers as stored, and a record with a born
  // born again at its life's stamp, so a revived source's copy keeps its life.
  public static func copy(of row: Row) -> PlannedDelta {
    let life = row.lattice.life.map { PlannedLife($0.state, .given($0.stamp)) }
    let born = row.lattice.born == nil ? nil : row.lattice.life.map { StampSlot.given($0.stamp) }
    let op: Op = born != nil ? .create : life != nil ? .put : .write
    return PlannedDelta(
      key: row.key, op: op, life: life, born: born,
      fields: row.lattice.fields.mapValues { PlannedRegister($0.value, .given($0.stamp)) })
  }

  public var hasServerSlots: Bool { !serverRegisters.isEmpty }

  // The registers whose stamps the server mints: "life", "born", or a field's name.
  public var serverRegisters: [RegisterName] {
    var names: [RegisterName] = []
    if life?.slot == .server { names.append(.life) }
    if born == .server { names.append(.born) }
    names += fields.filter { $0.value.slot == .server }.keys.sorted().map(RegisterName.field)
    return names
  }

  // The stamp this delta writes to a register, when a client gave it.
  public func givenStamp(of register: RegisterName) -> Stamp? {
    switch register {
    case .life: life?.slot.stamp
    case .born: born?.stamp
    case .field(let name): fields[name]?.slot.stamp
    }
  }

  // The SyncCore delta, the server's slots holding `stamp`.
  public func minted(with stamp: Stamp?) -> Delta {
    let fill = { (slot: StampSlot) -> Stamp in
      switch slot {
      case .given(let given): return given
      case .server:
        guard let stamp else { preconditionFailure("a server slot of \(key) has no minted stamp") }
        return stamp
      }
    }
    return Delta(
      key: key,
      lattice: Lattice(
        life: life.map { Life($0.state, fill($0.slot)) }, born: born.map(fill),
        fields: fields.mapValues { Register($0.value, fill($0.slot)) }),
      texts: texts)
  }
}

public enum RegisterName: Sendable, Hashable {
  case life, born
  case field(String)
}

// A command as admission runs it: its declaration, and arguments checked and clamped.
public struct CheckedCommand: Sendable, Hashable {
  public let definition: CommandDef
  public let args: JSON.Object

  public var name: String { definition.name }

  public static func == (lhs: CheckedCommand, rhs: CheckedCommand) -> Bool {
    lhs.name.isSameID(as: rhs.name) && lhs.args == rhs.args
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(name.utf8))
    hasher.combine(args)
  }
}

public struct CheckedIntent: Sendable, Hashable {
  public let scope: ScopeRef
  public let deltas: [PlannedDelta]
  public let guards: [Guard]
  public let command: CheckedCommand?
}

public enum IntentShape {
  public static func check(_ json: JSON, isReplica: Bool, registry: Registry, serverNow: Int64) throws(Refusal) -> CheckedIntent {
    let bound = serverNow + Constants.maxSkewMs
    var intent = try parse(json, isReplica: isReplica, registry: registry)
    try refuseSkew(intent.deltas, bound: bound)
    intent = clamped(intent, registry: registry, bound: bound, serverNow: serverNow)
    try refuseLateInstants(intent.command, bound: bound)
    return intent
  }

  static func parse(_ json: JSON, isReplica: Bool, registry: Registry) throws(Refusal) -> CheckedIntent {
    guard case .object(let object) = json, !holdsNul(json),
          (try? object.expectKeys(required: ["scope"], optional: ["n", "d", "guard", "cmd", "gestureId"])) != nil,
          case .string(let scopeText)? = object["scope"], let scope = try? ScopeRef(scopeText),
          let kind = registry.scopeKind(of: scope), Values.isScopeID(scope, registry: registry),
          object["gestureId"].map({ if case .string = $0 { true } else { false } }) ?? true
    else { throw Refusal(.invalid) }
    let deltas = try (object["d"].map { json throws(Refusal) in try Values.array(json) } ?? [])
      .map { json throws(Refusal) in try delta(json, kind: kind, isReplica: isReplica, registry: registry) }
    let guards = try (object["guard"].map { json throws(Refusal) in try Values.array(json) } ?? [])
      .map { json throws(Refusal) in try guardOf(json, kind: kind, registry: registry) }
    let command = try object["cmd"].map { json throws(Refusal) in try commandOf(json, kind: kind, registry: registry) }
    guard !deltas.isEmpty || command != nil, Set(deltas.map(\.key)).count == deltas.count else { throw Refusal(.invalid) }
    return CheckedIntent(scope: scope, deltas: deltas, guards: guards, command: command)
  }

  // Any string of the intent, a key or a value at any depth, holding U+0000.
  static func holdsNul(_ json: JSON) -> Bool {
    switch json {
    case .string(let text): text.utf8.contains(0)
    case .array(let items): items.contains(where: holdsNul)
    case .object(let object): object.members.contains { $0.key.utf8.contains(0) || holdsNul($0.value) }
    case .null, .bool, .number: false
    }
  }

  static func delta(_ json: JSON, kind: ScopeKind, isReplica: Bool, registry: Registry) throws(Refusal) -> PlannedDelta {
    guard case .object(let object) = json, (try? object.expectKeys(required: ["t", "id"], optional: ["life", "born", "f", "x"])) != nil,
          case .string(let typeName)? = object["t"], let type = registry.type(typeName), type.scope == kind,
          let idJSON = object["id"], Values.isID(idJSON, of: type, registry: registry), let id = try? RecordID(json: idJSON)
    else { throw Refusal(.invalid) }
    let life = try object["life"].map { json throws(Refusal) in try lifeOf(json, isReplica: isReplica) }
    let born = try object["born"].map { json throws(Refusal) in try slot(json, isReplica: isReplica) }
    guard let op = IdentityRules.op(of: type, life: life, born: born) else { throw Refusal(.invalid) }
    var fields: [String: PlannedRegister] = [:]
    for (name, register) in try Values.object(object["f"] ?? [:]) {
      guard let field = type.field(name), field.kind.isLattice, !isReplica || field.writer == .client,
            case .array(let pair) = register, pair.count == 2, Values.accepts(pair[0], for: field, registry: registry)
      else { throw Refusal(.invalid) }
      fields[name] = PlannedRegister(pair[0], try slot(pair[1], isReplica: isReplica))
    }
    var texts: [String: TextWrite] = [:]
    for (name, write) in try Values.object(object["x"] ?? [:]) {
      guard let field = type.field(name), case .text = field.kind, !isReplica || field.writer == .client,
            case .object(let parts) = write, (try? parts.expectKeys(required: ["base", "text"])) != nil,
            case .string(let text)? = parts["text"], let base = parts["base"].flatMap(textBase)
      else { throw Refusal(.invalid) }
      texts[name] = TextWrite(text: text, base: base)
    }
    return PlannedDelta(key: RecordKey(typeName, id), op: op, life: life, born: born, fields: fields, texts: texts)
  }

  static func textBase(_ json: JSON) -> TextBase? {
    guard case .object(let base) = json, base.count == 1 else { return nil }
    if let rev = base["rev"], let number = try? rev.asInteger(atLeast: 0) { return .rev(number) }
    if case .string(let text)? = base["text"] { return .text(text) }
    return nil
  }

  static func lifeOf(_ json: JSON, isReplica: Bool) throws(Refusal) -> PlannedLife {
    guard case .array(let pair) = json, pair.count == 2, case .string(let state)? = pair.first,
          let life = Life.State(rawValue: state) else { throw Refusal(.invalid) }
    return PlannedLife(life, try slot(pair[1], isReplica: isReplica))
  }

  // A set stamp, or null from a server origin, which the server mints.
  static func slot(_ json: JSON, isReplica: Bool) throws(Refusal) -> StampSlot {
    if json.isNull, !isReplica { return .server }
    guard case .string(let text) = json, let stamp = try? Stamp(text), stamp != .unset else { throw Refusal(.invalid) }
    return .given(stamp)
  }

  static func guardOf(_ json: JSON, kind: ScopeKind, registry: Registry) throws(Refusal) -> Guard {
    guard case .object(let object) = json, (try? object.expectKeys(required: ["field", "id", "stamp", "t"])) != nil,
          case .string(let typeName)? = object["t"], let type = registry.type(typeName), type.scope == kind,
          let idJSON = object["id"], Values.isID(idJSON, of: type, registry: registry), let id = try? RecordID(json: idJSON),
          case .string(let fieldName)? = object["field"], let field = type.field(fieldName), field.kind.isLattice,
          let stamp = object["stamp"]
    else { throw Refusal(.invalid) }
    if stamp.isNull { return Guard(key: RecordKey(typeName, id), field: fieldName, stamp: nil) }
    guard case .string(let text) = stamp, let parsed = try? Stamp(text), parsed != .unset else { throw Refusal(.invalid) }
    return Guard(key: RecordKey(typeName, id), field: fieldName, stamp: parsed)
  }

  static func commandOf(_ json: JSON, kind: ScopeKind, registry: Registry) throws(Refusal) -> CheckedCommand {
    guard case .object(let object) = json, (try? object.expectKeys(required: ["args", "name"])) != nil,
          case .string(let name)? = object["name"], let definition = registry.command(name), definition.scope == kind,
          case .object(let args)? = object["args"],
          args.keys.allSatisfy({ key in definition.args.contains { $0.name.utf8.elementsEqual(key.utf8) } })
    else { throw Refusal(.invalid) }
    for argument in definition.args {
      guard let value = args[argument.name] else {
        if argument.optional { continue }
        throw Refusal(.invalid)
      }
      guard Values.accepts(value, for: argument, registry: registry) else { throw Refusal(.invalid) }
    }
    return CheckedCommand(definition: definition, args: args)
  }

  // Life, born and field stamps only; guards name stamps the server already holds.
  static func refuseSkew(_ deltas: [PlannedDelta], bound: Int64) throws(Refusal) {
    for delta in deltas {
      let stamps = [delta.life?.slot.stamp, delta.born?.stamp].compactMap { $0 } + delta.fields.values.compactMap(\.slot.stamp)
      if stamps.contains(where: { $0.ms > bound }) { throw Refusal(.clockSkew) }
    }
  }

  static func clamped(_ intent: CheckedIntent, registry: Registry, bound: Int64, serverNow: Int64) -> CheckedIntent {
    let clamp = { (value: JSON) -> JSON in
      guard let ms = try? value.asInteger(), ms > bound else { return value }
      return JSON(serverNow)
    }
    let deltas = intent.deltas.map { delta in
      var clamped = delta
      for (name, register) in delta.fields {
        guard case .time? = registry.type(delta.key.type)?.field(name)?.kind else { continue }
        clamped.fields[name] = PlannedRegister(clamp(register.value), register.slot)
      }
      return clamped
    }
    let command = intent.command.map { command in
      var args = command.args
      for argument in command.definition.args where argument.type == .time {
        args[argument.name] = args[argument.name].map(clamp)
      }
      return CheckedCommand(definition: command.definition, args: args)
    }
    return CheckedIntent(scope: intent.scope, deltas: deltas, guards: intent.guards, command: command)
  }

  static func refuseLateInstants(_ command: CheckedCommand?, bound: Int64) throws(Refusal) {
    guard let command else { return }
    for argument in command.definition.args where argument.type == .instant {
      if let ms = try? command.args[argument.name]?.asInteger(), ms > bound { throw Refusal(.invalid) }
    }
  }
}

// §4.1 and §4.3: the op a delta's shape makes, and what each op does to each id state.
public enum IdentityRules {
  public enum Verdict: Sendable, Hashable {
    case apply
    case ok
    case refuse(RefusalCode)
  }

  // nil is a shape §4.1 refuses `invalid`. A server-minted born is fresh, so only a create mints both.
  public static func op(of type: TypeDef, life: PlannedLife?, born: StampSlot?) -> Op? {
    switch type.identity {
    case .minted, .derived:
      guard let born else { return nil }
      guard let life else { return born == .server ? nil : .update }
      switch (life.state, life.slot, born) {
      case (.alive, .server, .server): return .create
      case (_, _, .server): return nil
      case (.alive, .given(let stamp), .given(let given)): return stamp == given ? .create : .revive
      case (.alive, .server, .given): return .revive
      case (.dead, _, _): return .delete
      }
    case .keyed where type.life:
      return life != nil && born == nil ? .put : nil
    case .keyed, .singleton:
      return life == nil && born == nil ? .write : nil
    }
  }

  public static func verdict(_ op: Op, on state: IdState, born: StampSlot?, revivable: Bool) -> Verdict {
    let sameBorn = { (row: Row) in born?.stamp != nil && row.lattice.born == born?.stamp }
    switch (op, state) {
    case (.put, _), (.write, _): return .apply
    case (.create, .none): return .apply
    case (.create, .foreign): return .refuse(.idTaken)
    case (.create, .alive(let row)): return sameBorn(row) ? .apply : .refuse(.idTaken)
    case (.create, .dead(let row)): return sameBorn(row) ? .ok : .refuse(.idSpent)
    case (.update, .none), (.update, .foreign): return .refuse(.unknownRecord)
    case (.update, .alive(let row)): return sameBorn(row) ? .apply : .refuse(.unknownRecord)
    case (.update, .dead(let row)): return sameBorn(row) ? .refuse(.recordDead) : .refuse(.unknownRecord)
    case (.delete, .none), (.delete, .foreign): return .ok
    case (.delete, .alive(let row)), (.delete, .dead(let row)): return sameBorn(row) ? .apply : .ok
    case (.revive, .none), (.revive, .foreign): return .refuse(.unknownRecord)
    case (.revive, .alive(let row)): return sameBorn(row) ? .apply : .refuse(.unknownRecord)
    case (.revive, .dead(let row)):
      guard sameBorn(row) else { return .refuse(.unknownRecord) }
      return revivable ? .apply : .refuse(.idSpent)
    }
  }
}

// Registry value checks: ids, field values and command arguments, in their units, domains and quanta.
enum Values {
  static func array(_ json: JSON) throws(Refusal) -> [JSON] {
    guard case .array(let items) = json else { throw Refusal(.invalid) }
    return items
  }

  static func object(_ json: JSON) throws(Refusal) -> [(key: String, value: JSON)] {
    guard case .object(let object) = json else { throw Refusal(.invalid) }
    return object.members
  }

  // A tree or overlay reference names an id of the governing type.
  static func isScopeID(_ scope: ScopeRef, registry: Registry) -> Bool {
    guard let tree = scope.tree else { return true }
    guard let governing = registry.governingType else { return false }
    return isID(.string(tree), of: governing, registry: registry)
  }

  static func isID(_ id: JSON, of type: TypeDef, registry: Registry) -> Bool {
    if case .keyed = type.identity, let key = type.key {
      switch key {
      case .ref(let target):
        guard let target = registry.type(target) else { return false }
        return isID(id, of: target, registry: registry) && (type.idPattern.map { matches(id, $0) } ?? true)
      case .tuple(let parts):
        guard case .array(let items) = id, items.count == parts.count else { return false }
        return zip(items, parts).allSatisfy { item, part in registry.type(part.ref).map { isID(item, of: $0, registry: registry) } ?? false }
      }
    }
    guard let pattern = type.idPattern, matches(id, pattern) else { return false }
    guard type.identity == .singleton, let singleton = type.singletonId else { return true }
    return id == .string(singleton)
  }

  static func matches(_ id: JSON, _ pattern: Pattern) -> Bool {
    guard case .string(let text) = id else { return false }
    return pattern.matches(text)
  }

  static func isEpochMs(_ value: JSON) -> Bool {
    (try? value.asInteger(atLeast: 0)) != nil
  }

  static func accepts(_ value: JSON, for field: FieldDef, registry: Registry) -> Bool {
    switch field.kind {
    case .ranked(let rank): guard rank.of(value) != nil else { return false }
    case .time: guard isEpochMs(value) else { return false }
    default: break
    }
    if let domain = field.domain, !accepts(value, in: domain) { return false }
    if value.isNull { return field.domain?.nullable ?? (field.ref == nil) }
    if let target = field.ref, !(registry.type(target).map { isID(value, of: $0, registry: registry) } ?? false) { return false }
    if let quantum = field.quantum, case .number(let number) = value, !quantum.holds(number.value) { return false }
    return field.bounds?.admits(value) ?? true
  }

  static func accepts(_ value: JSON, for argument: ArgumentDef, registry: Registry) -> Bool {
    if let domain = argument.domain, !accepts(value, in: domain) { return false }
    switch argument.type {
    case .json: return true
    case .time, .instant: return isEpochMs(value)
    case .ref(let target):
      if value.isNull { return argument.domain?.nullable ?? false }
      return registry.type(target).map { isID(value, of: $0, registry: registry) } ?? false
    }
  }

  static func accepts(_ value: JSON, in domain: Domain) -> Bool {
    if value.isNull { return domain.nullable }
    switch domain.shape {
    case .string(let allowed, let pattern, let bounds):
      guard case .string(let text) = value else { return false }
      if let allowed, !allowed.contains(where: { $0.utf8.elementsEqual(text.utf8) }) { return false }
      if let pattern, !pattern.matches(text) { return false }
      return bounds?.admits(value) ?? true
    case .number(let integer, let min, let max):
      guard case .number(let number) = value else { return false }
      if integer && number.value.rounded(.towardZero) != number.value { return false }
      return number.value >= (min ?? -.infinity) && number.value <= (max ?? .infinity)
    case .boolean:
      if case .bool = value { return true }
      return false
    case .fracKey:
      guard case .string(let text) = value else { return false }
      return (try? FractionalKey(text)) != nil
    case .stamp:
      guard case .string(let text) = value else { return false }
      return (try? Stamp(text)) != nil
    case .id:
      if case .string = value { return true }
      return false
    case .json:
      return true
    case .array(let items, let maxItems):
      guard case .array(let elements) = value, elements.count <= (maxItems ?? Int.max) else { return false }
      return elements.allSatisfy { accepts($0, in: items) }
    case .object(let properties, let required):
      guard case .object(let object) = value else { return false }
      for (name, member) in object.members {
        guard let property = properties.first(where: { $0.name.utf8.elementsEqual(name.utf8) }),
              accepts(member, in: property.domain) else { return false }
      }
      return required.allSatisfy { object[$0] != nil }
    }
  }
}
