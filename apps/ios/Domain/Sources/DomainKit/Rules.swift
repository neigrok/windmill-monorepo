import SyncCore

// §6 every rule a product states is LOCAL (enforced by `Valid` on what is written) or SERVER-DECIDED (predicted from
// `stored`, decided by the server at admission, returned as a notice).
public struct Rule: Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    case local, serverDecided
  }

  public let name: String, subject: String, kind: Kind
  // A SERVER-DECIDED rule's refusal codes, or a LOCAL rule's server backstop.
  public let codes: [RefusalCode]
  // A LOCAL spec's JSON form.
  public let spec: JSON?

  init(name: String, subject: String, kind: Kind, codes: [RefusalCode], spec: JSON?) {
    self.name = name
    self.subject = subject
    self.kind = kind
    self.codes = codes
    self.spec = spec
  }

  // Named by the spec's path, about the type the path begins with.
  public static func local(_ spec: some ValueSpec) -> Rule {
    let subject = spec.path.split(separator: ".", maxSplits: 1).first.map(String.init) ?? spec.path
    return Rule(name: spec.path, subject: subject, kind: .local, codes: [], spec: spec.json)
  }

  public static func local(_ name: String, subject: String, backstop: [RefusalCode] = []) -> Rule {
    Rule(name: name, subject: subject, kind: .local, codes: backstop, spec: nil)
  }

  public static func serverDecided(_ name: String, codes: [RefusalCode], subject: String) -> Rule {
    Rule(name: name, subject: subject, kind: .serverDecided, codes: codes, spec: nil)
  }

  // §15.2: `{name, subject, kind, spec?, codes?}`, an empty `codes` omitted.
  var json: JSON {
    var object: JSON.Object = ["name": .string(name), "subject": .string(subject), "kind": kind == .local ? "local" : "server"]
    object["spec"] = spec
    object["codes"] = codes.isEmpty ? nil : .array(codes.map(\.json))
    return .object(object)
  }
}

// D-15 a product's rules and entity facts, with each entity's standard rules added, in the UTF-8 order of their names.
public struct RuleBook: Sendable {
  public let rules: [Rule]
  // What the kit's test support checks the book against.
  package let registry: Registry
  let entities: [EntityFacts]

  public init(registry: Registry, entities: [any Entity.Type], rules: [Rule]) {
    let facts = entities.map(EntityFacts.init).sorted { $0.type.utf8.lexicographicallyPrecedes($1.type.utf8) }
    let standard = facts.flatMap { RuleBook.standardRules(of: $0, in: registry) }
    self.rules = (rules + standard).sorted { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
    self.registry = registry
    self.entities = facts
  }

  // The book's entity of a registry type, for the kit's test support to build the entities a vector states.
  package func entity(_ type: String) -> (any Entity.Type)? {
    entities.first { $0.type.utf8.elementsEqual(type.utf8) }?.entity
  }

  // Pinned byte for byte across implementations by `packages/api-contract/<product>/domain/rules.json`.
  public var json: JSON {
    let facts = entities.map { entity -> JSON in
      ["type": .string(entity.type), "removable": .bool(entity.isRemovable), "held": .bool(entity.heldRemoval == true),
       "ordered": .bool(entity.isOrdered), "guarded": .bool(entity.isGuarded)]
    }
    return ["entities": .array(facts), "rules": .array(rules.map(\.json))]
  }

  // §6.3: gone for a type with life, taken for a minted type, stale for a guarded draft, cap for a capped type, size for a
  // type with a text field.
  static func standardRules(of entity: EntityFacts, in registry: Registry) -> [Rule] {
    guard let definition = registry.type(entity.type) else { return [] }
    let standard: [(applies: Bool, name: String, codes: [RefusalCode])] = [
      (definition.life, "gone", [.unknownRecord, .recordDead]),
      (definition.identity == .minted, "taken", [.idTaken, .idSpent]),
      (entity.isGuarded, "stale", [.stale]),
      (definition.cap != nil, "cap", [.cap]),
      (definition.fields.contains { if case .text = $0.kind { true } else { false } }, "size", [.tooLarge]),
    ]
    return standard.filter(\.applies).map { .serverDecided("\(entity.type).\($0.name)", codes: $0.codes, subject: entity.type) }
  }
}
