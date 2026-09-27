import DomainKit
import SyncAPI
import SyncCore

// §14.4 the checks every product runs over its declarations: each entity and command against the registry (§3.4, §8.4),
// the rule book against its refusal type and vectors (§6.3), and the book against its pinned JSON.

public struct CheckFailure: Error, Equatable, CustomStringConvertible {
  public let check: String
  public let step: Int
  public let path: String
  public let reason: String

  public init(_ check: String, step: Int, path: String, _ reason: String) {
    self.check = check
    self.step = step
    self.path = path
    self.reason = reason
  }

  public var description: String { "\(check) step \(step), \(path): \(reason)" }
}

public enum RegistryCheck {
  // §3.4 steps 1–10, in order; the first step an entity fails throws.
  public static func entity<E: Writable>(_ type: E.Type, sample: E, book: RuleBook, registry: Registry) throws {
    let definition = try declaration(of: E.self, in: registry)
    let written = sample.fields
    for name in written.keys.sorted() {
      guard let field = definition.field(name), field.writer == .client, !field.isSerial else {
        throw failure(4, "\(E.type).\(name)", "the sample writes a field that is no client-written field")
      }
      guard name != (E.self as? any Ordered.Type)?.orderField else { throw failure(4, "\(E.type).\(name)", "the sample writes the order field") }
    }
    for check in E.checks {
      guard let field = check.field, written[field] == nil else { continue }
      throw failure(5, "\(E.type).\(field)", "a check on a field the entity does not write")
    }
    for spec in specs(in: book) where spec.path.hasPrefix("\(E.type).") {
      let field = spec.path.split(separator: ".")[1]
      guard E.checks.contains(where: { $0.field.map { $0 == field } ?? false }) else {
        throw failure(6, spec.path, "a LOCAL spec on a field with no check")
      }
      if let refused = try SpecTarget(spec.path, in: definition).refusal(of: spec) { throw failure(6, spec.path, refused) }
    }
    if let draftable = E.self as? any Draftable.Type {
      try roundTrip(sample, definition)
      if draftable.savesGuarded && definition.fields.contains(where: \.isText) {
        throw failure(8, E.type, "a type whose saves are guarded has a text field")
      }
    }
    for field in definition.fields {
      guard let quantum = field.quantum else { continue }
      let path = "\(E.type).\(field.name)"
      guard specs(in: book).contains(where: { $0.path == path && $0.quantum.map(quantum.holds) == true }) else {
        throw failure(9, path, "a field with a quantum has no number spec on it")
      }
    }
    try stringsSpecced(StringPaths(of: definition, writing: written.keys).paths, by: specs(in: book), step: 10)
  }

  // Steps 1–3 for a read-only entity.
  public static func entity<E: Entity>(_ type: E.Type, registry: Registry) throws {
    _ = try declaration(of: E.self, in: registry)
  }

  // §8.4: every string argument path has a text or choice spec, in the command and in the book; and each spec the
  // command applies names an argument path, admits no value the registry refuses there, and is the spec the book pins.
  public static func command<C: ServerCommand>(_ type: C.Type, book: RuleBook, registry: Registry) throws {
    guard let definition = registry.command(C.name) else { throw failure(0, C.name, "the registry holds no such command") }
    let declared = C.specs.map { Spec($0.json) }
    var paths: [String] = []
    for argument in definition.args {
      guard let domain = argument.domain else { continue }
      paths += StringPaths.of(domain, at: "\(C.name).\(argument.name)")
    }
    try stringsSpecced(paths, by: declared, step: 10)
    try stringsSpecced(paths, by: specs(in: book), step: 10)
    for spec in declared {
      if let refused = try SpecTarget(spec.path, in: definition).refusal(of: spec) { throw failure(6, spec.path, refused) }
      guard specs(in: book).contains(where: { $0.path == spec.path && $0.json == spec.json }) else {
        throw failure(6, spec.path, "the command applies a spec the book does not pin")
      }
    }
  }

  // Steps 1–3.
  static func declaration(of entity: any Entity.Type, in registry: Registry) throws -> TypeDef {
    guard let definition = registry.type(entity.type), let product = definition.scope.productName, entity.scope == .product(product)
    else { throw failure(1, entity.type, "the registry declares no \(entity.type) in the product scope \(entity.scope)") }
    if entity is any Removable.Type && !definition.life { throw failure(2, entity.type, "a removable type without life") }
    if let orderField = (entity as? any Ordered.Type)?.orderField {
      guard let field = definition.field(orderField), field.writer == .client, case .lww = field.kind,
            case .fracKey? = field.domain?.shape else { throw failure(3, "\(entity.type).\(orderField)", "the order field is no client lww fracKey") }
    }
    return definition
  }

  // Step 7: the record the sample's fields build decodes back to the same fields.
  static func roundTrip<E: Writable>(_ sample: E, _ definition: TypeDef) throws {
    var values: [String: JSON] = [:]
    var texts: [String: TextValue] = [:]
    for (name, value) in sample.fields {
      guard definition.field(name)?.isText == true, case .string(let text) = value else {
        values[name] = value
        continue
      }
      texts[name] = TextValue(text: text, merged: false, pending: false)
    }
    let record = Record(type: E.type, id: sample.id.record, life: nil, born: nil, values: values, texts: texts, serials: [:], rc: nil,
                        ru: nil, isVisible: true, isPending: false, isHeld: false)
    let decoded = try E(Fields(record))
    let (before, after) = (JSON.object(fields: sample.fields), JSON.object(fields: decoded.fields))
    guard before == after else { throw failure(7, E.type, "the sample's fields \(before) decode as \(after)") }
  }

  static func stringsSpecced(_ paths: [String], by specs: [Spec], step: Int) throws {
    for path in paths where !specs.contains(where: { $0.path == path && ($0.kind == "text" || $0.kind == "choice") }) {
      throw failure(step, path, "a string with no text or choice spec, so a pasted U+0000 is no violation")
    }
  }

  static func specs(in book: RuleBook) -> [Spec] {
    book.rules.compactMap { $0.spec.map(Spec.init) }
  }

  static func failure(_ step: Int, _ path: String, _ reason: String) -> CheckFailure {
    CheckFailure("RegistryCheck", step: step, path: path, reason)
  }
}

// A value spec as its JSON form states it (§15.2), which is all a check needs to read of it.
struct Spec {
  let json: JSON

  init(_ json: JSON) {
    self.json = json
  }

  var path: String { (try? json.member("path").asString()) ?? "" }
  var kind: String { (try? json.member("kind").asString()) ?? "" }
  func number(_ name: String) -> Double? { try? json.member(name).asDouble() }
  var quantum: Double? { json["quantum"].flatMap { try? $0.asDouble() } }
  var unit: MeasureUnit? { (try? json.member("unit").asString()).flatMap(MeasureUnit.init(rawValue:)) }
  var values: [String] { (try? json.member("values").asArray().map { try $0.asString() }) ?? [] }
}

// §3.4 step 6: the registry value a LOCAL spec constrains, and whether the spec admits a value the registry refuses there.
// A text, choice or number spec constrains each value an array holds; a count spec, the array.
struct SpecTarget {
  let domain: Domain?
  let item: Domain?
  let bounds: Bounds?
  let fieldBounds: Bounds?
  let quantum: Quantum?
  let isText: Bool
  let rank: [String]?

  // `<type>.<field>`, then `.<property>` through nested objects, arrays passed through.
  init(_ path: String, in definition: TypeDef) throws {
    let names = path.split(separator: ".").map(String.init)
    guard names.count >= 2, let field = definition.field(names[1]) else {
      throw RegistryCheck.failure(6, path, "the spec names no registry path")
    }
    let domain = try SpecTarget.walk(field.domain, along: names.dropFirst(2), path: path)
    let isField = names.count == 2
    self.init(domain: domain, fieldBounds: field.bounds, isField: isField, quantum: isField ? field.quantum : nil,
              isText: isField && field.isText, rank: isField ? field.rank : nil)
  }

  // `<command>.<argument>`, then `.<property>` the same way.
  init(_ path: String, in command: CommandDef) throws {
    let names = path.dropFirst(command.name.count + 1).split(separator: ".").map(String.init)
    guard path.hasPrefix("\(command.name)."), let argument = names.first.flatMap({ name in command.args.first { $0.name == name } }) else {
      throw RegistryCheck.failure(6, path, "the spec names no argument of \(command.name)")
    }
    let domain = try SpecTarget.walk(argument.domain, along: names.dropFirst(), path: path)
    self.init(domain: domain, fieldBounds: nil, isField: false, quantum: nil, isText: false, rank: nil)
  }

  init(domain: Domain?, fieldBounds: Bounds?, isField: Bool, quantum: Quantum?, isText: Bool, rank: [String]?) {
    var item = domain
    while case .array(let items, _)? = item?.shape { item = items }
    self.domain = domain
    self.item = item
    bounds = isField && !SpecTarget.isArray(domain) && fieldBounds != nil ? fieldBounds : SpecTarget.stringBounds(item)
    self.fieldBounds = fieldBounds
    self.quantum = quantum
    self.isText = isText
    self.rank = rank
  }

  static func walk(_ start: Domain?, along names: some Sequence<String>, path: String) throws -> Domain? {
    var domain = start
    for name in names {
      while case .array(let items, _)? = domain?.shape { domain = items }
      guard case .object(let properties, _)? = domain?.shape, let property = properties.first(where: { $0.name == name }) else {
        throw RegistryCheck.failure(6, path, "the spec names no registry path")
      }
      domain = property.domain
    }
    return domain
  }

  // A string the value may hold: from an enum, a ranked field's rank, or any.
  var allowed: [String]? {
    if let rank { return rank }
    guard case .string(let allowed?, _, _)? = item?.shape else { return nil }
    return allowed
  }

  static func isArray(_ domain: Domain?) -> Bool {
    guard case .array? = domain?.shape else { return false }
    return true
  }

  static func stringBounds(_ domain: Domain?) -> Bounds? {
    guard case .string(_, _, let bounds)? = domain?.shape else { return nil }
    return bounds
  }

  // Nil when the spec admits no value the registry refuses (§4.2).
  func refusal(of spec: Spec) -> String? {
    switch spec.kind {
    case "text": return textRefusal(spec)
    case "choice": return choiceRefusal(spec)
    case "number": return numberRefusal(spec)
    case "count": return countRefusal(spec)
    default: return "an unknown spec kind \(spec.kind)"
    }
  }

  var holdsStrings: Bool { isText || rank != nil || SpecTarget.isString(item) }

  func textRefusal(_ spec: Spec) -> String? {
    guard holdsStrings else { return "a text spec on a value that is no string" }
    if allowed != nil { return "a text spec on an enum; a choice spec states it" }
    guard let bounds, let unit = spec.unit, let min = spec.number("min"), let max = spec.number("max") else { return nil }
    if let registryMax = bounds.max, !SpecTarget.fits(Int(max), unit, within: registryMax, bounds.unit) {
      return "admits \(Int(max)) \(unit.rawValue), beyond the registry's \(registryMax) \(bounds.unit.rawValue)"
    }
    if let registryMin = bounds.min, !SpecTarget.reaches(Int(min), unit, atLeast: registryMin, bounds.unit) {
      return "admits \(Int(min)) \(unit.rawValue), below the registry's \(registryMin) \(bounds.unit.rawValue)"
    }
    return nil
  }

  func choiceRefusal(_ spec: Spec) -> String? {
    guard holdsStrings else { return "a choice spec on a value that is no string" }
    for value in spec.values {
      if value.unicodeScalars.contains("\u{0}") { return "admits a value holding U+0000" }
      if let allowed, !allowed.contains(where: { $0.utf8.elementsEqual(value.utf8) }) { return "admits \(value), outside the registry's enum" }
      if case .string(_, let pattern?, _)? = item?.shape, !pattern.matches(value) { return "admits \(value), outside the registry's pattern" }
      if let bounds, !bounds.admits(.string(value)) { return "admits \(value), outside the registry's bounds" }
    }
    return nil
  }

  func numberRefusal(_ spec: Spec) -> String? {
    guard case .number(let integer, let min, let max)? = item?.shape else { return "a number spec on a value that is no number" }
    if let min, let specMin = spec.number("min"), specMin < min { return "admits \(specMin), below the registry's \(min)" }
    if let max, let specMax = spec.number("max"), specMax > max { return "admits \(specMax), above the registry's \(max)" }
    let specIntegral = spec.json["integer"] == .bool(true) || spec.quantum.map { $0.rounded() == $0 } == true
    if integer && !specIntegral { return "admits a fraction the registry's integer domain refuses" }
    if let quantum, !(spec.quantum.map(quantum.holds) ?? false) { return "admits a value off the registry's quantum \(quantum.step)" }
    return nil
  }

  // A count's `max` is at most the array's `maxItems`, and `max` items at the item's largest JCS encoding fit the
  // field's bound. An item whose encoding has no bound (an id, a fractional key, a stamp, raw JSON) is not measured.
  func countRefusal(_ spec: Spec) -> String? {
    guard case .array(let items, let maxItems)? = domain?.shape else { return "a count spec on a value that is no array" }
    guard let max = spec.number("max").map(Int.init) else { return nil }
    if let maxItems, max > maxItems { return "admits \(max) items, beyond the registry's \(maxItems)" }
    guard let item = SpecTarget.largestEncoding(items), let bound = fieldBounds?.max else { return nil }
    let largest = 2 + max * item + Swift.max(max - 1, 0)
    return largest > bound ? "\(max) items encode in up to \(largest) bytes, beyond the field's \(bound)" : nil
  }

  static func isString(_ domain: Domain?) -> Bool {
    guard case .string? = domain?.shape else { return false }
    return true
  }

  // A text of `count` in `unit` measures at most `limit` in the registry's unit: a code point is at most 4 bytes.
  static func fits(_ count: Int, _ unit: MeasureUnit, within limit: Int, _ registryUnit: MeasureUnit) -> Bool {
    switch (unit, registryUnit) {
    case (.chars, .bytes): 4 * count <= limit
    default: count <= limit
    }
  }

  // A text of at least `count` in `unit` measures at least `limit` in the registry's unit.
  static func reaches(_ count: Int, _ unit: MeasureUnit, atLeast limit: Int, _ registryUnit: MeasureUnit) -> Bool {
    switch (unit, registryUnit) {
    case (.bytes, .chars): count >= 4 * limit - 3
    default: count >= limit
    }
  }

  // The most UTF-8 bytes a value of the domain takes in JCS, or nil when nothing bounds it.
  static func largestEncoding(_ domain: Domain) -> Int? {
    let value: Int?
    switch domain.shape {
    case .string(let allowed, _, let bounds):
      if let allowed { value = allowed.map { JSON.string($0).jcs.count }.max() } else { value = bounds?.max.map { 2 + 6 * $0 } }
    case .number(let integer, let min, let max):
      guard integer, let min, let max else { value = 24; break }
      value = Swift.max(JSON.of(min).jcs.count, JSON.of(max).jcs.count)
    case .boolean: value = 5
    case .fracKey, .stamp, .id, .json: value = nil
    case .array(let items, let maxItems):
      guard let item = largestEncoding(items), let maxItems else { value = nil; break }
      value = 2 + maxItems * item + Swift.max(maxItems - 1, 0)
    case .object(let properties, _):
      var total = 2 + Swift.max(properties.count - 1, 0)
      for property in properties {
        guard let size = largestEncoding(property.domain) else { return nil }
        total += JSON.string(property.name).jcs.count + 1 + size
      }
      value = total
    }
    return value.map { domain.nullable ? Swift.max($0, 4) : $0 }
  }
}

// §3.4 step 10: the string paths of the fields an entity writes, nested ones included, arrays passed through.
struct StringPaths {
  let paths: [String]

  init(of definition: TypeDef, writing written: some Collection<String>) {
    var paths: [String] = []
    for field in definition.fields where written.contains(field.name) {
      let path = "\(definition.name).\(field.name)"
      if field.isText {
        paths.append(path)
      } else if let domain = field.domain {
        paths += StringPaths.of(domain, at: path)
      }
    }
    self.paths = paths
  }

  static func of(_ domain: Domain, at path: String) -> [String] {
    switch domain.shape {
    case .string: [path]
    case .array(let items, _): of(items, at: path)
    case .object(let properties, _): properties.flatMap { of($0.domain, at: "\(path).\($0.name)") }
    default: []
    }
  }
}

public enum RuleBookCheck {
  // §6.3: names are unique; every LOCAL rule has a vector; every code of a SERVER-DECIDED rule maps to a non-generic
  // refusal on both paths, and every backstop code on the notice path. `vectors` is a path under `packages/api-contract/`.
  public static func check<R: ProductRefusal>(_ book: RuleBook, refusal: R.Type, vectors: String) throws {
    let names = book.rules.map(\.name)
    for (index, name) in names.enumerated() where names[..<index].contains(name) {
      throw failure(name, "two rules share the name")
    }
    let cases = try Contract.vectors(vectors)
    for rule in book.rules where rule.kind == .local {
      if let spec = rule.spec.map(Spec.init), !cases.contains(where: { $0.input["spec"].map(Spec.init)?.path == spec.path }) {
        throw failure(rule.name, "a LOCAL spec with no spec case in \(vectors)")
      }
      guard rule.spec == nil || book.bindsToAField(rule) else { continue }
      guard cases.contains(where: { $0.input["entity"] != nil && $0.expect["violation"]?["rule"] == .string(rule.name) }) else {
        throw failure(rule.name, "a LOCAL rule bound to a field with no entity case in \(vectors)")
      }
    }
    for rule in book.rules {
      let paths: [Refused.Path] = rule.kind == .serverDecided ? [.predicted, .notice] : [.notice]
      for code in rule.codes {
        for path in paths where R(sample(code, of: rule.subject, on: path, registry: book.registry)).isGeneric {
          throw failure(rule.name, "\(code) on the \(path) path maps to the generic refusal")
        }
      }
    }
  }

  // A refusal of `code` about a record of `subject`, `cap` carrying its registry detail.
  static func sample(_ code: RefusalCode, of subject: String, on path: Refused.Path, registry: Registry) -> Refused {
    let detail: JSON? = code == .cap ? ["type": .string(subject), "cap": JSON(registry.type(subject)?.cap ?? 0)] : nil
    return Refused(code, subject: RecordRef(type: subject, id: RecordID("subject")), detail: detail, path: path)
  }

  static func failure(_ rule: String, _ reason: String) -> CheckFailure {
    CheckFailure("RuleBookCheck", step: 0, path: rule, reason)
  }
}

public enum RuleBookParity {
  // The book's JSON equals the pinned file by JCS, so Swift and Kotlin cannot drift. `file` is under `packages/api-contract/`.
  public static func check(_ book: RuleBook, file: String) throws {
    let pinned = try Contract.json(file)
    guard pinned == book.json else {
      throw CheckFailure("RuleBookParity", step: 0, path: file, "the book is \(book.json.jcsText), and the file pins \(pinned.jcsText)")
    }
  }
}

extension RuleBook {
  // A LOCAL spec is bound to a field when its path begins with the type of an entity of the book.
  func bindsToAField(_ rule: Rule) -> Bool {
    let types = (try? json.member("entities").asArray().map { try $0.member("type").asString() }) ?? []
    return types.contains { rule.name.hasPrefix("\($0).") }
  }
}

extension FieldDef {
  var isText: Bool {
    if case .text = kind { return true }
    return false
  }

  var isSerial: Bool {
    if case .serial = kind { return true }
    return false
  }

  // A ranked field's domain is its rank's values.
  var rank: [String]? {
    guard case .ranked(let rank) = kind else { return nil }
    return rank.values.map(\.value)
  }
}


