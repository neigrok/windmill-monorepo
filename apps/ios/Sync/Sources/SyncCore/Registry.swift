// §2.4 the registry in registry.schema.json's format; `json` writes it without `$schema` or default-valued keys.

public struct Registry: Sendable {
  public let name: String
  public let version: Int
  public let minVersion: Int
  public let products: [ProductDef]
  public let types: [TypeDef]
  public let commands: [CommandDef]

  public init(json: JSON) throws(RegistryError) {
    do {
      let root = try json.asObject()
      try root.expectKeys(
        required: ["registry", "version", "minVersion", "products", "types", "commands"], optional: ["$schema"])
      name = try root.member("registry").asString()
      guard RegistryName.isRegistry(name) else { throw RegistryError("\(name) is not a registry name") }
      version = Int(try root.member("version").asInteger(atLeast: 1))
      minVersion = Int(try root.member("minVersion").asInteger(atLeast: 1))
      products = try root.member("products").asObject().members.map { try ProductDef(name: $0.key, json: $0.value) }
      types = try root.member("types").asArray().map { try TypeDef(json: $0) }
      commands = try root.member("commands").asArray().map { try CommandDef(json: $0) }
    } catch let error as RegistryError {
      throw error
    } catch {
      throw RegistryError(context: "registry", underlying: error)
    }
    try checkReferences()
  }

  public func type(_ name: String) -> TypeDef? {
    types.first { $0.name.utf8.elementsEqual(name.utf8) }
  }

  public func command(_ name: String) -> CommandDef? {
    commands.first { $0.name.utf8.elementsEqual(name.utf8) }
  }

  public func product(_ name: String) -> ProductDef? {
    products.first { $0.name.utf8.elementsEqual(name.utf8) }
  }

  public var json: JSON {
    [
      "registry": .string(name),
      "version": JSON(version),
      "minVersion": JSON(minVersion),
      "products": .object(JSON.Object(uniqueKeysWithValues: products.map { ($0.name, $0.json) })),
      "types": .array(types.map(\.json)),
      "commands": .array(commands.map(\.json)),
    ]
  }

  // Rules that need the whole registry: unique names, and every referenced type and product declared.
  func checkReferences() throws(RegistryError) {
    for (index, type) in types.enumerated() where types[..<index].contains(where: { $0.name == type.name }) {
      throw RegistryError("type \(type.name) is declared twice")
    }
    for (index, command) in commands.enumerated() where commands[..<index].contains(where: { $0.name == command.name }) {
      throw RegistryError("command \(command.name) is declared twice")
    }
    for type in types {
      let referenced = type.fields.compactMap(\.ref) + (type.key?.refs ?? [])
      for target in referenced where self.type(target) == nil {
        throw RegistryError("type \(type.name) refers to the unknown type \(target)")
      }
      if case .product(let product) = type.scope, self.product(product) == nil {
        throw RegistryError("type \(type.name) lives in the undeclared product \(product)")
      }
    }
    for command in commands {
      let referenced = command.args.compactMap(\.type.ref) + command.predicts
      for target in referenced where self.type(target) == nil {
        throw RegistryError("command \(command.name) refers to the unknown type \(target)")
      }
      if case .product(let product) = command.scope, self.product(product) == nil {
        throw RegistryError("command \(command.name) lives in the undeclared product \(product)")
      }
    }
  }
}

// MARK: - Products

public struct ProductDef: Sendable {
  public let name: String
  public let surfaces: [Surface]
  public let device: [DeviceRowDef]

  init(name: String, json: JSON) throws(RegistryError) {
    do {
      guard RegistryName.isProduct(name) else { throw RegistryError("not a product name") }
      let object = try json.asObject()
      try object.expectKeys(required: [], optional: ["surfaces", "device"])
      self.name = name
      surfaces = try object["surfaces"]?.asDistinctStrings().map { try Surface(decoding: $0) } ?? []
      device = try object["device"]?.asObject().members.map { try DeviceRowDef(name: $0.key, json: $0.value) } ?? []
    } catch {
      throw RegistryError(context: "product \(name)", underlying: error)
    }
  }

  var json: JSON {
    var object = JSON.Object()
    if !surfaces.isEmpty { object["surfaces"] = .array(surfaces.map { .string($0.rawValue) }) }
    if !device.isEmpty { object["device"] = .object(JSON.Object(uniqueKeysWithValues: device.map { ($0.name, $0.json) })) }
    return .object(object)
  }
}

public enum Surface: String, Sendable, CaseIterable {
  case web, ios, android
}

public struct DeviceRowDef: Sendable {
  public let name: String
  public let keyPattern: Pattern
  public let localOnly: Bool
  public let value: Domain?

  init(name: String, json: JSON) throws(RegistryError) {
    do {
      guard RegistryName.isTypeOrField(name) else { throw RegistryError("not a row name") }
      let object = try json.asObject()
      try object.expectKeys(required: ["keyPattern"], optional: ["localOnly", "value"])
      self.name = name
      keyPattern = try Pattern(object.member("keyPattern").asString())
      localOnly = try object["localOnly"]?.asBool() ?? false
      value = try object["value"].map { try Domain(json: $0) }
    } catch {
      throw RegistryError(context: "device row \(name)", underlying: error)
    }
  }

  var json: JSON {
    var object: JSON.Object = ["keyPattern": .string(keyPattern.source)]
    if localOnly { object["localOnly"] = true }
    if let value { object["value"] = value.json }
    return .object(object)
  }
}

// MARK: - Types

public struct TypeDef: Sendable {
  public let name: String
  public let scope: ScopeKind
  public let identity: IdentityClass
  public let idSpace: IDSpace?
  public let idPattern: Pattern?
  public let key: Key?
  public let singletonId: String?
  public let deriveFallback: String?
  public let seeded: Seeded?
  public let mint: Mint?
  public let life: Bool
  public let revivable: Bool?
  public let deadRows: DeadRows?
  public let governsTree: Bool
  public let origins: [Origin]
  public let fields: [FieldDef]
  public let cap: Int?
  public let visibleWhen: [String]?
  public let primary: Bool

  public var hasBorn: Bool { identity == .minted || identity == .derived }

  public func field(_ name: String) -> FieldDef? {
    fields.first { $0.name.utf8.elementsEqual(name.utf8) }
  }

  init(json: JSON) throws(RegistryError) {
    do {
      let object = try json.asObject()
      try object.expectKeys(
        required: ["type", "scope", "identity", "life", "origins", "fields"],
        optional: ["idSpace", "idPattern", "key", "singletonId", "derive", "seeded", "mint", "revivable", "deadRows",
                   "governs", "cap", "visibleWhen", "primary"])
      name = try object.member("type").asString()
      guard RegistryName.isTypeOrField(name) else { throw RegistryError("\(name) is not a type name") }
      scope = try ScopeKind(text: object.member("scope").asString())
      identity = try IdentityClass(decoding: object.member("identity").asString())
      idSpace = try object["idSpace"].map { try IDSpace(decoding: $0.asString()) }
      idPattern = try object["idPattern"].map { try Pattern($0.asString()) }
      key = try object["key"].map { try Key(json: $0) }
      singletonId = try object["singletonId"]?.asString()
      deriveFallback = try object["derive"].map { derive in
        let rule = try derive.asObject()
        try rule.expectKeys(required: ["fallback"])
        let fallback = try rule.member("fallback").asString()
        guard RegistryName.isDeriveFallback(fallback) else { throw RegistryError("\(fallback) is not a fallback id") }
        return fallback
      }
      seeded = try object["seeded"].map { try Seeded(json: $0) }
      mint = try object["mint"].map { try Mint(json: $0) }
      life = try object.member("life").asBool()
      revivable = try object["revivable"]?.asBool()
      deadRows = try object["deadRows"].map { try DeadRows(decoding: $0.asString()) }
      governsTree = try object["governs"].map { governs in
        guard try governs.asString() == "tree" else { throw RegistryError("a type governs only tree scopes") }
        return true
      } ?? false
      origins = try object.member("origins").asDistinctStrings().map { try Origin(decoding: $0) }
      fields = try object.member("fields").asObject().members.map { try FieldDef(name: $0.key, json: $0.value) }
      cap = try object["cap"].map { Int(try $0.asInteger(atLeast: 1)) }
      visibleWhen = try object["visibleWhen"]?.asDistinctStrings()
      primary = try object["primary"].map { primary in
        guard try primary.asBool() else { throw RegistryError("primary is true or absent") }
        return true
      } ?? false
      try checkRules()
    } catch {
      throw RegistryError(context: "type \(json["type"]?.jcsText ?? "without a name")", underlying: error)
    }
  }

  // The schema's per-identity requirements and the rules the engine relies on (§2.4, D-8).
  func checkRules() throws(RegistryError) {
    switch identity {
    case .minted, .derived:
      guard idSpace != nil, idPattern != nil, revivable != nil, deadRows != nil, mint != nil, life else {
        throw RegistryError("a minted or derived type has idSpace, idPattern, revivable, deadRows, mint and life")
      }
      guard identity == .minted || deriveFallback != nil else { throw RegistryError("a derived type has derive") }
    case .singleton:
      guard singletonId != nil, idPattern != nil, !life else {
        throw RegistryError("a singleton has singletonId and idPattern, and no life")
      }
    case .keyed:
      guard !life || deadRows != nil else { throw RegistryError("a keyed type with life has deadRows") }
    }
    guard key != nil || idPattern != nil else { throw RegistryError("a type without a key has an idPattern") }
    guard deriveFallback == nil || identity == .derived else { throw RegistryError("only a derived type has derive") }
    guard seeded == nil || identity == .minted else { throw RegistryError("only a minted type is seeded") }
    guard mint == nil || hasBorn else { throw RegistryError("only a minted or derived type has mint") }
    guard key == nil || identity == .keyed else { throw RegistryError("only a keyed type has a key") }
    guard !governsTree || scope.isProduct else { throw RegistryError("a governing type lives in a product scope") }
    guard !governsTree || (identity == .minted && revivable == false) else {
      throw RegistryError("a governing type is minted and not revivable")
    }
    guard !governsTree || idSpace == .global else { throw RegistryError("a governing type's ids are global") }
    guard revivable != true || deadRows == .keep else { throw RegistryError("a revivable type keeps its dead rows") }
    guard origins.contains(.replica) else { throw RegistryError("origins always include replica") }
    guard visibleWhen == nil || !life else { throw RegistryError("visibleWhen is for types without life") }
    guard visibleWhen?.isEmpty != true else { throw RegistryError("visibleWhen names at least one field") }
    guard fields.filter(\.parent).count <= 1 else { throw RegistryError("at most one field is the parent") }
    for name in visibleWhen ?? [] where field(name) == nil { throw RegistryError("visibleWhen names the unknown field \(name)") }
    for field in fields {
      guard case .fracKey? = field.domain?.shape, !hasBorn else { continue }
      throw RegistryError("field \(field.name): an order field belongs to a minted or derived type")
    }
    for field in fields {
      guard case .serial(let next) = field.kind else { continue }
      for name in next where self.field(name) == nil {
        throw RegistryError("field \(field.name): serialNext names the unknown field \(name)")
      }
    }
    for field in fields {
      guard let opens = field.opens else { continue }
      guard scope == .tree, identity == .singleton else {
        throw RegistryError("field \(field.name): opens is for a field of a tree singleton")
      }
      guard case .string(let allowed?, _, _)? = field.domain?.shape else { continue }
      for value in opens where !allowed.contains(where: { $0.utf8.elementsEqual(value.utf8) }) {
        throw RegistryError("field \(field.name): opens the value \(value) outside its domain")
      }
    }
    if let mint, let idPattern {
      for symbol in mint.alphabet.unicodeScalars {
        guard idPattern.matches(mint.prefix + String(repeating: String(symbol), count: mint.length)) else {
          throw RegistryError("a minted id of \(symbol) does not match \(idPattern.source)")
        }
      }
    }
  }

  var json: JSON {
    var object: JSON.Object = [
      "type": .string(name),
      "scope": .string(scope.description),
      "identity": .string(identity.rawValue),
      "life": .bool(life),
      "origins": .array(origins.map { .string($0.rawValue) }),
      "fields": .object(JSON.Object(uniqueKeysWithValues: fields.map { ($0.name, $0.json) })),
    ]
    object["idSpace"] = idSpace.map { .string($0.rawValue) }
    object["idPattern"] = idPattern.map { .string($0.source) }
    object["key"] = key?.json
    object["singletonId"] = singletonId.map { .string($0) }
    object["derive"] = deriveFallback.map { ["fallback": .string($0)] }
    object["seeded"] = seeded.map { ["seedMax": JSON($0.seedMax), "ordinalMax": JSON($0.ordinalMax)] }
    object["mint"] = mint.map { ["prefix": .string($0.prefix), "alphabet": .string($0.alphabet), "length": JSON($0.length)] }
    object["revivable"] = revivable.map { .bool($0) }
    object["deadRows"] = deadRows.map { .string($0.rawValue) }
    object["governs"] = governsTree ? "tree" : nil
    object["cap"] = cap.map { JSON($0) }
    object["visibleWhen"] = visibleWhen.map { .array($0.map { .string($0) }) }
    object["primary"] = primary ? true : nil
    return .object(object)
  }
}

public enum ScopeKind: Sendable, Hashable, CustomStringConvertible {
  case product(String)
  case tree
  case overlay

  init(text: String) throws(RegistryError) {
    switch text {
    case "tree": self = .tree
    case "overlay": self = .overlay
    case _ where text.hasPrefix("product:"):
      let product = String(text.dropFirst("product:".count))
      guard RegistryName.isProduct(product) else { throw RegistryError("\(text) is not a scope kind") }
      self = .product(product)
    default: throw RegistryError("\(text) is not a scope kind")
    }
  }

  public var isProduct: Bool {
    if case .product = self { return true }
    return false
  }

  public var description: String {
    switch self {
    case .product(let name): "product:\(name)"
    case .tree: "tree"
    case .overlay: "overlay"
    }
  }

  public static func == (lhs: ScopeKind, rhs: ScopeKind) -> Bool { lhs.description.utf8.elementsEqual(rhs.description.utf8) }
  public func hash(into hasher: inout Hasher) { hasher.combine(Array(description.utf8)) }
}

public enum IdentityClass: String, Sendable, CaseIterable {
  case minted, derived, keyed, singleton
}

public enum IDSpace: String, Sendable, CaseIterable {
  case scope, global
}

public enum DeadRows: String, Sendable, CaseIterable {
  case keep, spent
}

public enum Origin: String, Sendable, CaseIterable {
  case replica, server
}

public enum Key: Sendable {
  case ref(String)
  case tuple([(name: String, ref: String)])

  init(json: JSON) throws {
    let object = try json.asObject()
    if let ref = object["ref"] {
      try object.expectKeys(required: ["ref"])
      self = .ref(try ref.asString())
      return
    }
    try object.expectKeys(required: ["tuple"])
    let parts = try object.member("tuple").asArray().map { part in
      let named = try part.asObject()
      try named.expectKeys(required: ["name", "ref"])
      return (name: try named.member("name").asString(), ref: try named.member("ref").asString())
    }
    guard parts.count >= 2 else { throw RegistryError("a tuple key has at least two parts") }
    self = .tuple(parts)
  }

  public var refs: [String] {
    switch self {
    case .ref(let type): [type]
    case .tuple(let parts): parts.map(\.ref)
    }
  }

  var json: JSON {
    switch self {
    case .ref(let type): ["ref": .string(type)]
    case .tuple(let parts): ["tuple": .array(parts.map { ["name": .string($0.name), "ref": .string($0.ref)] })]
    }
  }
}

public struct Seeded: Sendable, Hashable {
  public let seedMax: Int
  public let ordinalMax: Int

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["seedMax", "ordinalMax"])
    seedMax = Int(try object.member("seedMax").asInteger(atLeast: 1))
    ordinalMax = Int(try object.member("ordinalMax").asInteger(atLeast: 1))
  }
}

// D-8: a minted id is the prefix, then `length` characters drawn uniformly from the alphabet.
public struct Mint: Sendable, Hashable {
  public let prefix: String
  public let alphabet: String
  public let length: Int

  init(json: JSON) throws {
    let object = try json.asObject()
    try object.expectKeys(required: ["prefix", "alphabet", "length"])
    prefix = try object.member("prefix").asString()
    alphabet = try object.member("alphabet").asString()
    length = Int(try object.member("length").asInteger(atLeast: 1))
    guard alphabet.unicodeScalars.count >= 2 else { throw RegistryError("a mint alphabet has at least two characters") }
  }

  public static func == (lhs: Mint, rhs: Mint) -> Bool {
    lhs.prefix.utf8.elementsEqual(rhs.prefix.utf8) && lhs.alphabet.utf8.elementsEqual(rhs.alphabet.utf8)
      && lhs.length == rhs.length
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(Array(prefix.utf8))
    hasher.combine(Array(alphabet.utf8))
    hasher.combine(length)
  }
}

// MARK: - Fields

public struct FieldDef: Sendable {
  public let name: String
  public let kind: FieldKind
  public let writer: Writer
  public let ref: String?
  public let parent: Bool
  public let bounds: Bounds?
  public let domain: Domain?
  public let quantum: Quantum?
  public let opens: [String]?

  init(name: String, json: JSON) throws(RegistryError) {
    do {
      guard RegistryName.isTypeOrField(name) else { throw RegistryError("not a field name") }
      let object = try json.asObject()
      try object.expectKeys(
        required: ["kind", "writer"],
        optional: ["ref", "parent", "unit", "min", "max", "domain", "quantum", "serialNext", "rank", "opens"])
      self.name = name
      kind = try FieldKind(name: object.member("kind").asString(), rank: object["rank"], serialNext: object["serialNext"])
      writer = try Writer(decoding: object.member("writer").asString())
      ref = try object["ref"]?.asString()
      parent = try object["parent"].map { parent in
        guard try parent.asBool() else { throw RegistryError("parent is true or absent") }
        return true
      } ?? false
      bounds = try Bounds(in: object)
      domain = try object["domain"].map { try Domain(json: $0) }
      quantum = try object["quantum"].map { step in
        guard let quantum = Quantum(try step.asDouble()) else { throw RegistryError("a quantum is an integer or 1/k") }
        return quantum
      }
      opens = try object["opens"]?.asDistinctStrings()
      guard !parent || ref != nil else { throw RegistryError("the parent field is a ref") }
      guard !kind.isText || bounds?.max != nil else { throw RegistryError("a text field has unit and max") }
      guard !kind.isSerial || writer == .server else { throw RegistryError("a serial field is server-written") }
      guard quantum == nil || domain?.isNumber == true else { throw RegistryError("a quantum needs a number domain") }
      guard opens == nil || (writer == .server && opens?.isEmpty == false) else {
        throw RegistryError("opens lists values of a server-written field")
      }
    } catch {
      throw RegistryError(context: "field \(name)", underlying: error)
    }
  }

  var json: JSON {
    var object: JSON.Object = ["kind": .string(kind.name), "writer": .string(writer.rawValue)]
    object["ref"] = ref.map { .string($0) }
    object["parent"] = parent ? true : nil
    bounds?.write(into: &object)
    object["domain"] = domain?.json
    object["quantum"] = quantum.map { .number(JSON.Number($0.step)!) }
    object["opens"] = opens.map { .array($0.map { .string($0) }) }
    switch kind {
    case .ranked(let rank):
      object["rank"] = .object(JSON.Object(uniqueKeysWithValues: rank.values.map { ($0.value, JSON($0.rank)) }))
    case .serial(let next): object["serialNext"] = .array(next.map { .string($0) })
    default: break
    }
    return .object(object)
  }
}

public enum FieldKind: Sendable {
  case lww
  case ranked(Rank)
  case fww
  case const
  case time
  case serial(next: [String])
  case text

  init(name: String, rank: JSON?, serialNext: JSON?) throws {
    switch (name, rank, serialNext) {
    case ("lww", nil, nil): self = .lww
    case ("ranked", let rank?, nil): self = .ranked(try Rank(json: rank))
    case ("fww", nil, nil): self = .fww
    case ("const", nil, nil): self = .const
    case ("time", nil, nil): self = .time
    case ("serial", nil, let next?): self = .serial(next: try next.asDistinctStrings())
    case ("text", nil, nil): self = .text
    default: throw RegistryError("kind \(name) goes with rank iff ranked and serialNext iff serial")
    }
  }

  public var name: String {
    switch self {
    case .lww: "lww"
    case .ranked: "ranked"
    case .fww: "fww"
    case .const: "const"
    case .time: "time"
    case .serial: "serial"
    case .text: "text"
    }
  }

  public var isLattice: Bool { !isText && !isSerial }

  var isText: Bool {
    if case .text = self { return true }
    return false
  }

  var isSerial: Bool {
    if case .serial = self { return true }
    return false
  }
}

public enum Writer: String, Sendable, CaseIterable {
  case client, server
}

// A ranked field's domain: each value's integer rank (§3.2 joinRanked), matched by bytes.
public struct Rank: Sendable {
  public let values: [(value: String, rank: Int)]

  public init(_ values: [(value: String, rank: Int)]) {
    self.values = values
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    guard !object.isEmpty else { throw RegistryError("a rank lists at least one value") }
    values = try object.members.map { (value: $0.key, rank: Int(try $0.value.asInteger())) }
  }

  public func of(_ value: JSON) -> Int? {
    guard case .string(let text) = value else { return nil }
    return values.first { $0.value.utf8.elementsEqual(text.utf8) }?.rank
  }
}

public enum MeasureUnit: String, Sendable, CaseIterable {
  case chars, bytes

  // D-9: chars are Unicode code points, never Swift's grapheme clusters.
  public func length(of text: String) -> Int {
    switch self {
    case .chars: text.unicodeScalars.count
    case .bytes: text.utf8.count
    }
  }
}

// D-9 a length bound, always in its stated unit: a string is measured itself, any other value by its JCS text.
public struct Bounds: Sendable, Hashable {
  public let unit: MeasureUnit
  public let min: Int?
  public let max: Int?

  public init(unit: MeasureUnit, min: Int? = nil, max: Int? = nil) {
    self.unit = unit
    self.min = min
    self.max = max
  }

  // The `unit`, `min` and `max` keys of a field or a string domain; nil when it states none, and a bound without its
  // unit is refused.
  init?(in object: JSON.Object) throws {
    let min = try object["min"].map { Int(try $0.asInteger(atLeast: 0)) }
    let max = try object["max"].map { Int(try $0.asInteger(atLeast: 1)) }
    guard let unit = try object["unit"].map({ try MeasureUnit(decoding: $0.asString()) }) else {
      guard min == nil && max == nil else { throw RegistryError("a bound states its unit") }
      return nil
    }
    self.init(unit: unit, min: min, max: max)
  }

  public func admits(_ value: JSON) -> Bool {
    let text = if case .string(let string) = value { string } else { value.jcsText }
    let length = unit.length(of: text)
    return length >= (min ?? 0) && length <= (max ?? Int.max)
  }

  func write(into object: inout JSON.Object) {
    object["unit"] = .string(unit.rawValue)
    object["min"] = min.map { JSON($0) }
    object["max"] = max.map { JSON($0) }
  }
}

// A number field's step, rounded half away from zero in doubles (SPEC-GAP 12); the server accepts only fixed points.
public struct Quantum: Sendable, Hashable {
  public let step: Double

  public init?(_ step: Double) {
    guard step.isFinite, step > 0 else { return nil }
    guard step.rounded() == step || 1 / (1 / step).rounded() == step else { return nil }
    self.step = step
  }

  public func rounded(_ value: Double) -> Double {
    if step.rounded() == step { return Quantum.roundHalfAway(value / step) * step }
    let perUnit = (1 / step).rounded()
    return Quantum.roundHalfAway(value * perUnit) / perUnit
  }

  public func holds(_ value: Double) -> Bool {
    rounded(value) == value
  }

  static func roundHalfAway(_ value: Double) -> Double {
    let rounded = value.rounded(.toNearestOrAwayFromZero)
    return rounded == 0 ? 0 : rounded
  }
}

// MARK: - Domains

public struct Domain: Sendable {
  public let nullable: Bool
  public let shape: Shape

  public indirect enum Shape: Sendable {
    case string(allowed: [String]?, pattern: Pattern?, bounds: Bounds?)
    case number(integer: Bool, min: Double?, max: Double?)
    case boolean
    case fracKey
    case stamp
    case id
    case json
    case array(items: Domain, maxItems: Int?)
    case object(properties: [(name: String, domain: Domain)], required: [String])
  }

  public var isNumber: Bool {
    if case .number = shape { return true }
    return false
  }

  init(json: JSON) throws {
    let object = try json.asObject()
    let type = try object.member("type").asString()
    switch type {
    case "string":
      try object.expectKeys(required: ["type"], optional: ["nullable", "enum", "pattern", "unit", "min", "max"])
      let allowed = try object["enum"]?.asDistinctStrings()
      guard allowed?.isEmpty != true else { throw RegistryError("an enum lists at least one value") }
      shape = .string(
        allowed: allowed,
        pattern: try object["pattern"].map { try Pattern($0.asString()) },
        bounds: try Bounds(in: object))
    case "number":
      try object.expectKeys(required: ["type"], optional: ["nullable", "integer", "min", "max"])
      shape = .number(
        integer: try object["integer"]?.asBool() ?? false,
        min: try object["min"]?.asDouble(),
        max: try object["max"]?.asDouble())
    case "boolean", "fracKey", "stamp", "id", "json":
      try object.expectKeys(required: ["type"], optional: ["nullable"])
      shape = switch type {
      case "boolean": .boolean
      case "fracKey": .fracKey
      case "stamp": .stamp
      case "id": .id
      default: .json
      }
    case "array":
      try object.expectKeys(required: ["type", "items"], optional: ["nullable", "maxItems"])
      shape = .array(
        items: try Domain(json: object.member("items")),
        maxItems: try object["maxItems"].map { Int(try $0.asInteger(atLeast: 0)) })
    case "object":
      try object.expectKeys(required: ["type", "properties"], optional: ["nullable", "required"])
      shape = .object(
        properties: try object.member("properties").asObject().members.map { (name: $0.key, domain: try Domain(json: $0.value)) },
        required: try object["required"]?.asDistinctStrings() ?? [])
    default:
      throw RegistryError("\(type) is not a domain type")
    }
    nullable = try object["nullable"]?.asBool() ?? false
  }

  var json: JSON {
    var object = JSON.Object()
    switch shape {
    case .string(let allowed, let pattern, let bounds):
      object["type"] = "string"
      object["enum"] = allowed.map { .array($0.map { .string($0) }) }
      object["pattern"] = pattern.map { .string($0.source) }
      bounds?.write(into: &object)
    case .number(let integer, let min, let max):
      object["type"] = "number"
      object["integer"] = integer ? true : nil
      object["min"] = min.map { .number(JSON.Number($0)!) }
      object["max"] = max.map { .number(JSON.Number($0)!) }
    case .boolean: object["type"] = "boolean"
    case .fracKey: object["type"] = "fracKey"
    case .stamp: object["type"] = "stamp"
    case .id: object["type"] = "id"
    case .json: object["type"] = "json"
    case .array(let items, let maxItems):
      object["type"] = "array"
      object["items"] = items.json
      object["maxItems"] = maxItems.map { JSON($0) }
    case .object(let properties, let required):
      object["type"] = "object"
      object["properties"] = .object(JSON.Object(uniqueKeysWithValues: properties.map { ($0.name, $0.domain.json) }))
      object["required"] = required.isEmpty ? nil : .array(required.map { .string($0) })
    }
    object["nullable"] = nullable ? true : nil
    return .object(object)
  }
}

// MARK: - Commands

public struct CommandDef: Sendable {
  public let name: String
  public let scope: ScopeKind
  public let origins: [Origin]
  public let serverInternal: Bool
  public let args: [ArgumentDef]
  public let predicts: [String]
  public let beforePull: Bool

  init(json: JSON) throws(RegistryError) {
    do {
      let object = try json.asObject()
      try object.expectKeys(
        required: ["name", "scope", "origins", "serverInternal", "args"], optional: ["predicts", "beforePull"])
      name = try object.member("name").asString()
      guard RegistryName.isCommand(name) else { throw RegistryError("\(name) is not a command name") }
      scope = try ScopeKind(text: object.member("scope").asString())
      origins = try object.member("origins").asDistinctStrings().map { try Origin(decoding: $0) }
      serverInternal = try object.member("serverInternal").asBool()
      args = try object.member("args").asObject().members.map { try ArgumentDef(name: $0.key, json: $0.value) }
      predicts = try object["predicts"]?.asDistinctStrings() ?? []
      beforePull = try object["beforePull"]?.asBool() ?? false
      guard !origins.isEmpty else { throw RegistryError("a command has at least one origin") }
      guard !serverInternal || !origins.contains(.replica) else {
        throw RegistryError("a server-internal command has server origin only")
      }
      guard !beforePull || serverInternal else { throw RegistryError("a beforePull command is server-internal") }
    } catch {
      throw RegistryError(context: "command \(json["name"]?.jcsText ?? "without a name")", underlying: error)
    }
  }

  var json: JSON {
    var object: JSON.Object = [
      "name": .string(name),
      "scope": .string(scope.description),
      "origins": .array(origins.map { .string($0.rawValue) }),
      "serverInternal": .bool(serverInternal),
      "args": .object(JSON.Object(uniqueKeysWithValues: args.map { ($0.name, $0.json) })),
    ]
    object["predicts"] = predicts.isEmpty ? nil : .array(predicts.map { .string($0) })
    object["beforePull"] = beforePull ? true : nil
    return .object(object)
  }
}

public struct ArgumentDef: Sendable {
  public let name: String
  public let type: ArgumentType
  public let optional: Bool
  public let domain: Domain?

  init(name: String, json: JSON) throws(RegistryError) {
    do {
      guard RegistryName.isTypeOrField(name) else { throw RegistryError("not an argument name") }
      let object = try json.asObject()
      try object.expectKeys(required: ["type"], optional: ["optional", "domain"])
      self.name = name
      type = try ArgumentType(text: object.member("type").asString())
      optional = try object["optional"]?.asBool() ?? false
      domain = try object["domain"].map { try Domain(json: $0) }
    } catch {
      throw RegistryError(context: "argument \(name)", underlying: error)
    }
  }

  var json: JSON {
    var object: JSON.Object = ["type": .string(type.description)]
    object["optional"] = optional ? true : nil
    object["domain"] = domain?.json
    return .object(object)
  }
}

public enum ArgumentType: Sendable, Hashable, CustomStringConvertible {
  case json
  case time
  case instant
  case ref(String)

  init(text: String) throws(RegistryError) {
    switch text {
    case "json": self = .json
    case "time": self = .time
    case "instant": self = .instant
    case _ where text.hasPrefix("ref<") && text.hasSuffix(">"):
      let type = String(text.dropFirst("ref<".count).dropLast())
      guard RegistryName.isTypeOrField(type) else { throw RegistryError("\(text) is not an argument type") }
      self = .ref(type)
    default: throw RegistryError("\(text) is not an argument type")
    }
  }

  public var ref: String? {
    if case .ref(let type) = self { return type }
    return nil
  }

  public var description: String {
    switch self {
    case .json: "json"
    case .time: "time"
    case .instant: "instant"
    case .ref(let type): "ref<\(type)>"
    }
  }

  public static func == (lhs: ArgumentType, rhs: ArgumentType) -> Bool {
    lhs.description.utf8.elementsEqual(rhs.description.utf8)
  }

  public func hash(into hasher: inout Hasher) { hasher.combine(Array(description.utf8)) }
}

// MARK: - Patterns and names

// An ECMAScript registry pattern run as a Swift Regex, searched like `test`; compiled per match, as Regex is not Sendable.
public struct Pattern: Sendable {
  public let source: String

  public init(_ source: String) throws {
    guard source.hasPrefix("^"), source.hasSuffix("$") else { throw RegistryError("\(source) is not an anchored pattern") }
    _ = try Pattern.compile(source)
    self.source = source
  }

  public func matches(_ text: String) -> Bool {
    text.firstMatch(of: try! Pattern.compile(source)) != nil
  }

  static func compile(_ source: String) throws -> Regex<AnyRegexOutput> {
    try Regex(source).matchingSemantics(.unicodeScalar).asciiOnlyDigits().asciiOnlyWordCharacters()
  }
}

// The name rules of registry.schema.json; every name is ASCII.
enum RegistryName {
  static func isRegistry(_ name: String) -> Bool {
    name.isPrintableASCII && name.wholeMatch(of: #/[a-z][a-z0-9-]*/#) != nil
  }

  static func isProduct(_ name: String) -> Bool {
    name.isPrintableASCII && name.wholeMatch(of: #/[a-z][a-z0-9]*/#) != nil
  }

  static func isTypeOrField(_ name: String) -> Bool {
    name.isPrintableASCII && name.wholeMatch(of: #/[a-z][A-Za-z0-9]*/#) != nil
  }

  static func isCommand(_ name: String) -> Bool {
    name.isPrintableASCII && name.wholeMatch(of: #/[a-z][a-z0-9]*\.[a-z][A-Za-z0-9]*/#) != nil
  }

  static func isDeriveFallback(_ name: String) -> Bool {
    name.isPrintableASCII && name.wholeMatch(of: #/[a-z0-9]+(?:-[a-z0-9]+)*/#) != nil
  }
}

extension RawRepresentable where RawValue == String {
  init(decoding text: String) throws {
    guard let value = Self(rawValue: text) else { throw RegistryError("\(text) is not a \(Self.self)") }
    self = value
  }
}
