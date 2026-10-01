import SyncCore

// The SyncSchema target's sources, from the product registries: per registry, `<Product>.generated.swift` holding its
// product's scope, the registry as a literal of SyncCore's JSON, its type and command names, its refusal codes, and the
// default each field declares, typed; and `SyncSchema.swift`, composing them into the one registry the app runs. Pure:
// main.swift reads the registry files and writes or checks what this answers.

struct RegistryFile {
  let name: String
  let json: JSON
}

struct GeneratedFile: Equatable {
  let name: String
  let text: String
}

struct GenerationError: Error, CustomStringConvertible {
  let description: String
}

struct Composition {
  let name: String
  let registries: [String]

  init(json: JSON) throws {
    do {
      let object = try json.asObject()
      try object.expectKeys(required: ["composition", "registries"])
      name = try object.member("composition").asString()
      registries = try object.member("registries").asArray().map { try $0.asString() }
    } catch {
      throw GenerationError(description: "composition.json: \(error)")
    }
    guard !registries.isEmpty else { throw GenerationError(description: "composition.json declares no product registry") }
    for (index, file) in registries.enumerated() {
      guard file.wholeMatch(of: #/[a-z][a-z0-9-]*\.registry\.json/#) != nil else {
        throw GenerationError(description: "composition.json: \(file) is not a product registry filename")
      }
      guard !registries[..<index].contains(file) else {
        throw GenerationError(description: "composition.json declares \(file) twice")
      }
    }
  }
}

enum SchemaSources {
  static let directory = "packages/api-contract/sync"
  // Enum names neither a registry nor a type's defaults can take: they would shadow a name the generated sources use (a
  // registry's enum shadows it for the whole SyncSchema module), or one Swift reserves.
  static let reservedEnumNames: Set<String> = [
    "SyncSchema", "SyncCore", "Registry", "ScopeRef", "RefusalCode", "JSON", "String", "Bool", "Int", "Double", "Optional",
    "Any", "Self", "Type", "Protocol",
  ]

  // A registry, decoded, the enum its sources declare, and the one product whose scope the enum names.
  struct Part {
    let file: String
    let enumName: String
    let product: String
    let registry: Registry
  }

  // Every file of the target, sorted by name. A registry must decode, and decode losslessly, so the literal written is
  // the file itself; the registries must compose, so SyncSchema.swift cannot fail when the app first reads it.
  static func files(from registries: [RegistryFile], composition: Composition) throws -> [GeneratedFile] {
    let parts = try composition.registries.map { name in
      guard let file = registries.first(where: { $0.name == name }) else {
        throw GenerationError(description: "composition.json names missing registry \(name)")
      }
      return try part(file)
    }
    do {
      _ = try Registry(name: composition.name, composing: parts.map(\.registry))
    } catch {
      throw GenerationError(description: "the product registries do not compose: \(error)")
    }
    for (index, part) in parts.enumerated() where parts[..<index].contains(where: { $0.enumName == part.enumName }) {
      throw GenerationError(description: "\(part.file) declares a second enum \(part.enumName)")
    }
    return (try parts.map(productFile) + [schemaFile(parts, name: composition.name)]).sorted { $0.name < $1.name }
  }

  static func part(_ file: RegistryFile) throws -> Part {
    let registry: Registry
    do {
      registry = try Registry(json: file.json)
    } catch {
      throw GenerationError(description: "\(file.name): \(error)")
    }
    var written = try file.json.asObject()
    written["$schema"] = nil
    guard registry.json == .object(written) else {
      throw GenerationError(
        description: "\(file.name) does not round-trip through the registry decoder: it states a key the decoder drops, "
          + "such as a default value")
    }
    let enumName = registry.name.split(separator: "-").map { $0.prefix(1).uppercased() + String($0.dropFirst()) }.joined()
    guard !reservedEnumNames.contains(enumName) else {
      throw GenerationError(description: "\(file.name): the registry \(registry.name) would declare the reserved enum \(enumName)")
    }
    guard registry.products.count == 1, let product = registry.products.first else {
      throw GenerationError(
        description: "\(file.name) declares \(registry.products.count) products: a product registry declares one, whose scope its enum names")
    }
    return Part(file: file.name, enumName: enumName, product: product.name, registry: registry)
  }

  static func productFile(_ part: Part) throws -> GeneratedFile {
    let commands = try uniqueMembers(part.registry.commands.map { (String($0.name.drop { $0 != "." }.dropFirst()), $0.name) },
                                     of: "commands", in: part)
    let codes = try uniqueMembers(part.registry.products.flatMap(\.codes).map { (camelCase($0.text), $0.text) },
                                  of: "refusal codes", in: part)
    var text = """
      // Generated by SyncSchemaGen from \(directory)/\(part.file). Do not edit.

      import SyncCore

      public enum \(part.enumName) {
        public static let scope = ScopeRef.product(\(SwiftLiteral.string(part.product)))

        public enum Types {

      """
    for type in part.registry.types {
      text += "    public static let \(SwiftLiteral.identifier(type.name)) = \(SwiftLiteral.string(type.name))\n"
    }
    text += "  }\n"
    if !commands.isEmpty {
      text += "\n  public enum Commands {\n"
      for command in commands {
        text += "    public static let \(SwiftLiteral.identifier(command.member)) = \(SwiftLiteral.string(command.name))\n"
      }
      text += "  }\n"
    }
    if !codes.isEmpty {
      text += "\n  public enum Codes {\n"
      for code in codes {
        text += "    public static let \(SwiftLiteral.identifier(code.member)): RefusalCode = \(SwiftLiteral.string(code.name))\n"
      }
      text += "  }\n"
    }
    text += try defaults(of: part)
    let lead = "  static let registryFile: JSON = "
    text += "\n\(lead)\(SwiftLiteral.render(part.registry.json, indent: 2, column: lead.count))\n}\n"
    return GeneratedFile(name: "\(part.enumName).generated.swift", text: text)
  }

  // Each name's Swift member, unique within its enum.
  static func uniqueMembers(_ named: [(member: String, name: String)], of kind: String, in part: Part) throws
    -> [(member: String, name: String)] {
    for (index, entry) in named.enumerated() where named[..<index].contains(where: { $0.member == entry.member }) {
      throw GenerationError(description: "\(part.file): two \(kind) are named \(entry.member)")
    }
    return named
  }

  // `Defaults`, one enum per type that declares a default, one constant per such field, typed as a reader holds it: a
  // string, a boolean, an integer or a number, optional when its domain is nullable; any other value as JSON.
  static func defaults(of part: Part) throws -> String {
    let declaring = part.registry.types.filter { $0.fields.contains { $0.defaultValue != nil } }
    guard !declaring.isEmpty else { return "" }
    var text = "\n  public enum Defaults {\n"
    for (index, type) in declaring.enumerated() {
      let enumName = type.name.prefix(1).uppercased() + type.name.dropFirst()
      guard !reservedEnumNames.contains(enumName) else {
        throw GenerationError(description: "\(part.file): the type \(type.name) would declare the reserved enum \(enumName)")
      }
      text += (index == 0 ? "" : "\n") + "    public enum \(enumName) {\n"
      for field in type.fields {
        guard let value = field.defaultValue else { continue }
        guard let scalar = scalarType(of: field) else {
          let lead = "      public static let \(SwiftLiteral.identifier(field.name)): JSON = "
          text += lead + SwiftLiteral.render(value, indent: 6, column: lead.count) + "\n"
          continue
        }
        let type = field.domain?.nullable == true ? scalar + "?" : scalar
        let literal = value.isNull ? "nil" : SwiftLiteral.inline(value)
        text += "      public static let \(SwiftLiteral.identifier(field.name)): \(type) = \(literal)\n"
      }
      text += "    }\n"
    }
    return text + "  }\n"
  }

  // The Swift type a reader holds a field's value in: a string, boolean or number domain's, or a ranked field's string;
  // nil for any other value, held as JSON.
  static func scalarType(of field: FieldDef) -> String? {
    if case .ranked = field.kind { return "String" }
    switch field.domain?.shape {
    case .string?: return "String"
    case .boolean?: return "Bool"
    case .number(let integer, _, _, _)?: return integer ? "Int" : "Double"
    default: return nil
    }
  }

  // A refusal code's member: `unknown-exercise` is `unknownExercise`.
  static func camelCase(_ code: String) -> String {
    let words = code.split(separator: "-")
    return words.prefix(1).joined() + words.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
  }

  static func schemaFile(_ parts: [Part], name: String) -> GeneratedFile {
    let decoded = parts.map { "    Registry(json: \($0.enumName).registryFile),\n" }.joined()
    return GeneratedFile(name: "SyncSchema.swift", text: """
      // Generated by SyncSchemaGen from \(directory)/composition.json. Do not edit.

      import SyncCore

      public enum SyncSchema {
        public static let registry = try! Registry(name: \(SwiftLiteral.string(name)), composing: [
      \(decoded)  ])
        public static let version = registry.version
      }

      """)
  }

  // The names of the target's files that differ from what the registries generate, byte for byte: changed, missing, or
  // left over from a registry that is gone. Empty when the checked-in target is current.
  static func stale(_ generated: [GeneratedFile], existing: [String: [UInt8]]) -> [String] {
    let changed = generated.filter { existing[$0.name] != Array($0.text.utf8) }.map(\.name)
    let extra = existing.keys.filter { name in !generated.contains { $0.name == name } }
    return (changed + extra).sorted()
  }
}

// A JSON value as a Swift literal of SyncCore's JSON, and the names and strings the sources declare.
enum SwiftLiteral {
  static let width = 120
  static let keywords: Set<String> = [
    "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import", "init", "inout", "internal",
    "let", "operator", "private", "precedencegroup", "protocol", "public", "rethrows", "static", "struct", "subscript",
    "typealias", "var", "break", "case", "catch", "continue", "default", "defer", "do", "else", "fallthrough", "for",
    "guard", "if", "in", "repeat", "return", "throw", "switch", "where", "while", "as", "await", "false", "is", "nil",
    "self", "super", "throws", "true", "try",
  ]

  // `json` starting at `column` of a line indented by `indent`: on that line when it fits the width with the comma after
  // it, otherwise one member per line.
  static func render(_ json: JSON, indent: Int, column: Int) -> String {
    let inline = self.inline(json)
    guard column + inline.count + 1 > width, let members = members(of: json) else { return inline }
    let pad = String(repeating: " ", count: indent + 2)
    let lines = members.map { member in
      let label = member.key.map { "\(string($0)): " } ?? ""
      return pad + label + render(member.value, indent: indent + 2, column: pad.count + label.count) + ","
    }
    return "[\n" + lines.joined(separator: "\n") + "\n" + String(repeating: " ", count: indent) + "]"
  }

  static func inline(_ json: JSON) -> String {
    switch json {
    case .null: return ".null"
    case .bool(let flag): return flag ? "true" : "false"
    case .number(let number): return self.number(number)
    case .string(let text): return string(text)
    case .array(let items): return "[" + items.map(inline).joined(separator: ", ") + "]"
    case .object(let object):
      guard !object.isEmpty else { return "[:]" }
      return "[" + object.members.map { "\(string($0.key)): \(inline($0.value))" }.joined(separator: ", ") + "]"
    }
  }

  // A non-empty array's items or object's members; nil for any other value, which never breaks across lines.
  static func members(of json: JSON) -> [(key: String?, value: JSON)]? {
    switch json {
    case .array(let items) where !items.isEmpty: items.map { (key: nil, value: $0) }
    case .object(let object) where !object.isEmpty: object.members.map { (key: $0.key, value: $0.value) }
    default: nil
    }
  }

  // The number's JCS text. A safe integer is an integer literal; any other number a float literal, which Swift rounds
  // correctly to the same double.
  static func number(_ number: JSON.Number) -> String {
    let text = number.description
    if number.value.rounded() == number.value && number.value.magnitude <= Double(JSON.maxSafeInteger) { return text }
    return text.contains { $0 == "." || $0 == "e" } ? text : text + ".0"
  }

  // A string literal holding exactly the text's scalars: printable ASCII as itself, every other scalar escaped.
  static func string(_ text: String) -> String {
    var literal = "\""
    for scalar in text.unicodeScalars {
      switch scalar {
      case "\"": literal += "\\\""
      case "\\": literal += "\\\\"
      case " "..."~": literal.unicodeScalars.append(scalar)
      default: literal += "\\u{\(String(scalar.value, radix: 16, uppercase: true))}"
      }
    }
    return literal + "\""
  }

  static func identifier(_ name: String) -> String {
    keywords.contains(name) ? "`\(name)`" : name
  }
}
