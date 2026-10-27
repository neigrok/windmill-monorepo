import DomainKit
import SyncCore

// The gym ability catalog (Coach §3) as the phone reads it: every ability's declaration, generated into
// Catalog.generated.swift from packages/api-contract/gym/catalog.json, the agent rules that decide what a seat is offered,
// and the JSON Schema check every call's input passes again on the phone (G-3).

public enum AbilityClass: String, Sendable {
  case read, add, change, remove
}

public enum AgentRule: String, Sendable {
  case runs, proposes, withheld
}

public enum AbilitySeats: String, Sendable {
  case any, bound
}

// Whose store a turn runs against (Coach D-10).
public enum Seat: Sendable, Equatable {
  case anon, bound
}

public struct Ability: Sendable {
  public let name: String
  public let kind: AbilityClass
  public let agent: AgentRule
  public let seats: AbilitySeats
  // False for an ability the server declares no tool for: it has no server golden, and the phone does not run it either.
  public let declared: Bool
  public let phrase: String
  public let input: JSON
  public let result: JSON

  public init(name: String, kind: AbilityClass, agent: AgentRule, seats: AbilitySeats, declared: Bool, phrase: String, input: JSON, result: JSON) {
    self.name = name
    self.kind = kind
    self.agent = agent
    self.seats = seats
    self.declared = declared
    self.phrase = phrase
    self.input = input
    self.result = result
  }

  public func admits(_ seat: Seat) -> Bool {
    seats == .any || seat == .bound
  }
}

public enum Catalog {
  public static func ability(named name: String) -> Ability? {
    declared.first { $0.name.utf8.elementsEqual(name.utf8) }
  }

  // §3.4, G-1 and G-2: a withheld ability is never offered, nor one no executor declares, and one that needs an account
  // is not offered to `anon`.
  public static func offered(seat: Seat) -> [Ability] {
    declared.filter { $0.agent != .withheld && $0.declared && $0.admits(seat) }
  }
}

// MARK: - The schema check

public struct SchemaFault: Error, Equatable, Sendable, CustomStringConvertible {
  public let path: Path
  public let reason: String

  public init(path: Path, reason: String) {
    self.path = path
    self.reason = reason
  }

  public var description: String { "\(path): \(reason)" }
}

// A JSON Schema as the catalog writes one, checked at every depth: type, enum, const, an object's properties, required
// and additionalProperties, an array's items, minItems, maxItems and uniqueItems, a string's minLength, maxLength and
// pattern, a number's minimum and maximum. The first fault, in schema order, is the answer.
public struct JSONSchema: Sendable {
  public let json: JSON

  public init(_ json: JSON) {
    self.json = json
  }

  public func fault(in value: JSON) -> SchemaFault? {
    fault(in: value, against: json, at: Path(""))
  }

  func fault(in value: JSON, against schema: JSON, at path: Path) -> SchemaFault? {
    guard case .object(let rules) = schema else { return nil }
    if let expected = rules["type"], !matches(value, type: expected) {
      return SchemaFault(path: path, reason: "not \(expected.jcsText)")
    }
    if case .array(let allowed)? = rules["enum"], !allowed.contains(value) { return SchemaFault(path: path, reason: "not one of the enum") }
    if let constant = rules["const"], constant != value { return SchemaFault(path: path, reason: "not the constant") }
    switch value {
    case .object(let members): return fault(inObject: members, rules: rules, at: path)
    case .array(let items): return fault(inArray: items, rules: rules, at: path)
    case .string(let text): return fault(inString: text, rules: rules, at: path)
    case .number(let number): return fault(inNumber: number.value, rules: rules, at: path)
    default: return nil
    }
  }

  func matches(_ value: JSON, type: JSON) -> Bool {
    switch (type, value) {
    case (.array(let names), _): return names.contains { matches(value, type: $0) }
    case ("object", .object), ("array", .array), ("string", .string), ("boolean", .bool), ("null", .null), ("number", .number): return true
    case ("integer", .number(let number)): return number.value.rounded() == number.value
    default: return false
    }
  }

  func fault(inObject members: JSON.Object, rules: JSON.Object, at path: Path) -> SchemaFault? {
    let properties = (try? rules["properties"]?.asObject()) ?? JSON.Object()
    if case .array(let required)? = rules["required"] {
      for name in required {
        guard case .string(let key) = name else { continue }
        if members[key] == nil { return SchemaFault(path: path + key, reason: "required") }
      }
    }
    if rules["additionalProperties"] == false {
      for key in members.keys where properties[key] == nil { return SchemaFault(path: path + key, reason: "not a property") }
    }
    for property in properties.members {
      guard let value = members[property.key], let found = fault(in: value, against: property.value, at: path + property.key) else { continue }
      return found
    }
    return nil
  }

  func fault(inArray items: [JSON], rules: JSON.Object, at path: Path) -> SchemaFault? {
    if let bound = integer(rules["minItems"]), items.count < bound { return SchemaFault(path: path, reason: "fewer than \(bound) items") }
    if let bound = integer(rules["maxItems"]), items.count > bound { return SchemaFault(path: path, reason: "more than \(bound) items") }
    if rules["uniqueItems"] == true {
      for (index, item) in items.enumerated() where items[..<index].contains(item) {
        return SchemaFault(path: path + index, reason: "repeats an item")
      }
    }
    guard let itemSchema = rules["items"] else { return nil }
    for (index, item) in items.enumerated() {
      if let found = fault(in: item, against: itemSchema, at: path + index) { return found }
    }
    return nil
  }

  func fault(inString text: String, rules: JSON.Object, at path: Path) -> SchemaFault? {
    let length = text.unicodeScalars.count
    if let bound = integer(rules["minLength"]), length < bound { return SchemaFault(path: path, reason: "shorter than \(bound)") }
    if let bound = integer(rules["maxLength"]), length > bound { return SchemaFault(path: path, reason: "longer than \(bound)") }
    if case .string(let pattern)? = rules["pattern"] {
      guard let regex = try? Regex(pattern), text.wholeMatch(of: regex) != nil else { return SchemaFault(path: path, reason: "not \(pattern)") }
    }
    return nil
  }

  func fault(inNumber value: Double, rules: JSON.Object, at path: Path) -> SchemaFault? {
    if case .number(let bound)? = rules["minimum"], value < bound.value { return SchemaFault(path: path, reason: "below \(bound)") }
    if case .number(let bound)? = rules["maximum"], value > bound.value { return SchemaFault(path: path, reason: "above \(bound)") }
    return nil
  }

  func integer(_ json: JSON?) -> Int? {
    guard case .number(let number)? = json else { return nil }
    return Int(exactly: number.value)
  }
}
