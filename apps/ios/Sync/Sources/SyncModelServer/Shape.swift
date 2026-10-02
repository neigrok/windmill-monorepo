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
  public var serials: [String: JSON]
  public var replacements: [String: TextReplacement]

  public init(key: RecordKey, op: Op, life: PlannedLife? = nil, born: StampSlot? = nil, fields: [String: PlannedRegister] = [:],
              texts: [String: TextWrite] = [:], serials: [String: JSON] = [:], replacements: [String: TextReplacement] = [:]) {
    self.key = key
    self.op = op
    self.life = life
    self.born = born
    self.fields = fields
    self.texts = texts
    self.serials = serials
    self.replacements = replacements
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
    guard case .object(let object) = json, !json.holdsNul,
          (try? object.expectKeys(required: ["scope"], optional: ["n", "d", "guard", "cmd", "gestureId"])) != nil,
          case .string(let scopeText)? = object["scope"], let scope = try? ScopeRef(scopeText),
          let kind = registry.scopeKind(of: scope), registry.isScopeID(scope),
          object["gestureId"].map({ if case .string = $0 { true } else { false } }) ?? true
    else { throw Refusal(.invalid) }
    let deltas = try (object["d"].map { json throws(Refusal) in try array(json) } ?? [])
      .map { json throws(Refusal) in try delta(json, kind: kind, isReplica: isReplica, registry: registry) }
    let guards = try (object["guard"].map { json throws(Refusal) in try array(json) } ?? [])
      .map { json throws(Refusal) in try guardOf(json, kind: kind, registry: registry) }
    let command = try object["cmd"].map { json throws(Refusal) in try commandOf(json, kind: kind, registry: registry) }
    guard !deltas.isEmpty || command != nil, Set(deltas.map(\.key)).count == deltas.count else { throw Refusal(.invalid) }
    return CheckedIntent(scope: scope, deltas: deltas, guards: guards, command: command)
  }

  static func delta(_ json: JSON, kind: ScopeKind, isReplica: Bool, registry: Registry) throws(Refusal) -> PlannedDelta {
    guard case .object(let object) = json, (try? object.expectKeys(required: ["t", "id"], optional: ["life", "born", "f", "x"])) != nil,
          case .string(let typeName)? = object["t"], let type = registry.type(typeName), type.scope == kind,
          let idJSON = object["id"], registry.isID(idJSON, of: type), let id = try? RecordID(json: idJSON)
    else { throw Refusal(.invalid) }
    let life = try object["life"].map { json throws(Refusal) in try lifeOf(json, isReplica: isReplica) }
    let born = try object["born"].map { json throws(Refusal) in try slot(json, isReplica: isReplica) }
    guard let op = IdentityRules.op(of: type, life: life, born: born) else { throw Refusal(.invalid) }
    var fields: [String: PlannedRegister] = [:]
    for (name, register) in try members(object["f"] ?? [:]) {
      guard let field = type.field(name), field.kind.isLattice, !isReplica || field.writer == .client,
            case .array(let pair) = register, pair.count == 2, registry.admits(pair[0], for: field)
      else { throw Refusal(.invalid) }
      fields[name] = PlannedRegister(pair[0], try slot(pair[1], isReplica: isReplica))
    }
    var texts: [String: TextWrite] = [:]
    for (name, write) in try members(object["x"] ?? [:]) {
      guard let field = type.field(name), case .text = field.kind, !isReplica || field.writer == .client,
            case .object(let parts) = write, (try? parts.expectKeys(required: ["base", "text"])) != nil,
            case .string(let text)? = parts["text"], let base = parts["base"].flatMap(textBase)
      else { throw Refusal(.invalid) }
      texts[name] = TextWrite(text: text, base: base)
    }
    guard !type.wholePut || isWhole(life: life, fields: fields, of: type) else { throw Refusal(.invalid) }
    return PlannedDelta(key: RecordKey(typeName, id), op: op, life: life, born: born, fields: fields, texts: texts)
  }

  // §2.4 a delta of a `wholePut` type carries a life. An alive one carries every client-written lattice field of its
  // type, every register at the life's stamp (null alike from a server origin); a dead one no field register, so a
  // losing delete plants nothing.
  static func isWhole(life: PlannedLife?, fields: [String: PlannedRegister], of type: TypeDef) -> Bool {
    guard let life else { return false }
    guard life.state == .alive else { return fields.isEmpty }
    return type.clientLatticeFields.allSatisfy { fields[$0.name] != nil } && fields.values.allSatisfy { $0.slot == life.slot }
  }

  static func array(_ json: JSON) throws(Refusal) -> [JSON] {
    guard case .array(let items) = json else { throw Refusal(.invalid) }
    return items
  }

  static func members(_ json: JSON) throws(Refusal) -> [(key: String, value: JSON)] {
    guard case .object(let object) = json else { throw Refusal(.invalid) }
    return object.members
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
          let idJSON = object["id"], registry.isID(idJSON, of: type), let id = try? RecordID(json: idJSON),
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
      guard registry.admits(value, for: argument) else { throw Refusal(.invalid) }
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

public struct TextReplacement: Sendable, Hashable {
  public let text: String
  public let archiveNonempty: Bool
  public let archive: JSON.Object

  public init(_ text: String, archiveNonempty: Bool = false, archive: JSON.Object = [:]) {
    self.text = text
    self.archiveNonempty = archiveNonempty
    self.archive = archive
  }
}
