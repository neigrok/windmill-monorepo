import Foundation

// A package as `swift package dump-package` resolves its manifest.
struct PackageDump: Decodable, Sendable {
  let name: String
  let toolsVersion: String
  let languageModes: [String]
  var dependencies: [PackageDependency]
  let products: [Product]
  let targets: [Target]

  struct Product: Decodable, Sendable {
    let name: String
    let targets: [String]
  }

  struct Target: Decodable, Sendable {
    let name: String
    let type: String
    let path: String?
    let sources: [String]?
    let exclude: [String]
    let dependencies: [TargetDependency]
    let settings: [BuildSetting]
    let pluginUsages: [PluginUsage]?

    var isTest: Bool { type == "test" }
  }

  enum CodingKeys: String, CodingKey {
    case name, toolsVersion, swiftLanguageVersions, swiftLanguageModes, dependencies, products, targets
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    name = try container.decode(String.self, forKey: .name)
    toolsVersion = try container.decode([String: String].self, forKey: .toolsVersion)["_version"] ?? ""
    languageModes = try container.decodeIfPresent([String].self, forKey: .swiftLanguageModes)
      ?? container.decodeIfPresent([String].self, forKey: .swiftLanguageVersions) ?? []
    dependencies = try container.decode([PackageDependency].self, forKey: .dependencies)
    products = try container.decode([Product].self, forKey: .products)
    targets = try container.decode([Target].self, forKey: .targets)
  }
}

struct PackageDependency: Decodable, Sendable {
  enum Location: Sendable {
    case local(String)
    case remote
  }

  let identity: String
  var location: Location

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: DynamicKey.self)
    let kind = try DynamicKey.only(in: container)
    let details = try container.decode([Details].self, forKey: kind)[0]
    identity = details.identity
    location = kind.stringValue == "fileSystem" ? .local(details.path ?? "") : .remote
  }

  private struct Details: Decodable {
    let identity: String
    let path: String?
  }
}

enum TargetDependency: Decodable, Sendable {
  case byName(String)
  case target(String)
  case product(String, package: String?)

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: DynamicKey.self)
    let kind = try DynamicKey.only(in: container)
    let fields = try container.decode([JSONValue].self, forKey: kind)
    let name = fields.first?.text ?? ""
    switch kind.stringValue {
    case "product": self = .product(name, package: fields.count > 1 ? fields[1].text : nil)
    case "target": self = .target(name)
    default: self = .byName(name)
    }
  }
}

struct PluginUsage: Decodable, Sendable, CustomStringConvertible {
  let usage: JSONValue

  init(from decoder: Decoder) throws { usage = try JSONValue(from: decoder) }

  var description: String { usage.fields.first?.value.elements.first?.text ?? usage.description }
}

// A target setting as the manifest spells it, e.g. `enableUpcomingFeature(MemberImportVisibility)`, with its condition if any.
struct BuildSetting: Decodable, Sendable, CustomStringConvertible {
  let tool: String
  let kind: [String: JSONValue]
  let condition: JSONValue?

  var description: String {
    let name = kind.keys.first ?? "?"
    let arguments: [String] = kind[name].map { value in
      guard case .object(let fields) = value else { return [value.description] }
      return fields.sorted { $0.key < $1.key }.map(\.value.description)
    } ?? []
    let call = "\(name)(\(arguments.joined(separator: ", ")))"
    let spelled = tool == "swift" ? call : "\(tool).\(call)"
    return condition.map { "\(spelled) when \($0)" } ?? spelled
  }
}

enum JSONValue: Decodable, Hashable, Sendable, CustomStringConvertible {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  case array([JSONValue])
  case object([String: JSONValue])

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() { self = .null }
    else if let value = try? container.decode(Bool.self) { self = .bool(value) }
    else if let value = try? container.decode(Double.self) { self = .number(value) }
    else if let value = try? container.decode(String.self) { self = .string(value) }
    else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
    else { self = .object(try container.decode([String: JSONValue].self)) }
  }

  var text: String? {
    if case .string(let text) = self { return text }
    return nil
  }

  subscript(key: String) -> JSONValue? {
    if case .object(let fields) = self { return fields[key] }
    return nil
  }

  var fields: [(key: String, value: JSONValue)] {
    guard case .object(let fields) = self else { return [] }
    return fields.sorted { $0.key < $1.key }
  }

  var elements: [JSONValue] {
    if case .array(let elements) = self { return elements }
    return []
  }

  var description: String {
    switch self {
    case .string(let text): text
    case .number(let number): number == number.rounded() ? String(Int(number)) : String(number)
    case .bool(let flag): String(flag)
    case .null: "nil"
    case .array(let elements): "[\(elements.map(\.description).joined(separator: ", "))]"
    case .object(let fields): "{\(fields.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: ", "))}"
    }
  }
}

struct DynamicKey: CodingKey {
  let stringValue: String
  var intValue: Int? { nil }

  init(_ stringValue: String) { self.stringValue = stringValue }
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { nil }

  // The one key of an object dump-package writes as `{"<kind>": […]}`.
  static func only(in container: KeyedDecodingContainer<DynamicKey>) throws -> DynamicKey {
    guard container.allKeys.count == 1, let key = container.allKeys.first else {
      throw DecodingError.dataCorrupted(.init(codingPath: container.codingPath, debugDescription: "expected one kind"))
    }
    return key
  }
}
