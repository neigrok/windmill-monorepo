import DomainKit
import Foundation
import SyncCore
import Testing

// §9.4: what a catalog offers each seat, and the schema check, keyword by keyword and against the shared patterns every
// language matches alike.
struct AbilitiesTests {
  static func ability(_ name: String, agent: AgentRule = .runs, seats: AbilitySeats = .any, declared: Bool = true) -> Ability {
    Ability(name: name, kind: .read, agent: agent, seats: seats, declared: declared, strict: true, phrase: "read \(name)", input: ["type": "object"],
            result: ["type": "array"])
  }

  @Test func aSeatIsOfferedWhatIsNeitherWithheldNorUndeclaredAndWhatItAdmits() {
    let catalog = Catalog(version: "catalog/9", abilities: [
      Self.ability("everyone"), Self.ability("account", seats: .bound), Self.ability("proposed", agent: .proposes),
      Self.ability("withheld", agent: .withheld), Self.ability("undeclared", declared: false),
    ])
    #expect(catalog.offered(seat: .bound).map(\.name) == ["everyone", "account", "proposed"])
    #expect(catalog.offered(seat: .anon).map(\.name) == ["everyone", "proposed"])
    #expect(catalog.ability(named: "withheld")?.agent == .withheld)
    #expect(catalog.ability(named: "absent") == nil)
    #expect(catalog.ability(named: "account").map { [$0.admits(.bound), $0.admits(.anon)] } == [true, false])
  }

  // packages/api-contract/catalog/schema-patterns.json, found by walking up from this file.
  @Test func sharedPatternsMatchTheWholeValueWithBacktracking() throws {
    var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while !FileManager.default.fileExists(atPath: directory.appendingPathComponent("packages/api-contract").path) {
      try #require(directory.path != "/")
      directory.deleteLastPathComponent()
    }
    let file = directory.appendingPathComponent("packages/api-contract/catalog/schema-patterns.json")
    for sample in try JSON(parsing: [UInt8](try Data(contentsOf: file))).asArray() {
      let expected = try sample.member("fault")
      let fault = JSONSchema(try sample.member("schema")).fault(in: try sample.member("value"))
      let actual: JSON = fault.map { ["path": .string($0.path.text), "reason": .string($0.reason)] } ?? .null
      let name = try sample.member("name").asString()
      #expect(actual == expected, "\(name)")
    }
  }

  static let schema = JSONSchema([
    "type": "object", "additionalProperties": false, "required": ["id", "entries"],
    "properties": [
      "id": ["type": "string", "minLength": 8, "maxLength": 64, "pattern": "^[A-Za-z0-9_-]+$"],
      "kind": ["type": "string", "enum": ["read", "add"]],
      "saved": ["type": "boolean", "const": true],
      "limit": ["type": "integer", "minimum": 1, "maximum": 200],
      "load": ["type": "number", "minimum": -500, "maximum": 500],
      "entries": [
        "type": "array", "minItems": 1, "maxItems": 2, "uniqueItems": true,
        "items": ["type": "object", "additionalProperties": false, "required": ["exerciseId"], "properties": ["exerciseId": ["type": "string"]]],
      ],
    ],
  ])

  static let faults: [(JSON, SchemaFault)] = [
    faulted(JSON.array([]), SchemaFault(path: "", reason: "not \"object\"")),
    faulted(["entries": [["exerciseId": "a"]]], SchemaFault(path: "id", reason: "required")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "extra": 1], SchemaFault(path: "extra", reason: "not a property")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "kind": "remove"], SchemaFault(path: "kind", reason: "not one of the enum")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "saved": false], SchemaFault(path: "saved", reason: "not the constant")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "limit": 1.5], SchemaFault(path: "limit", reason: "not \"integer\"")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "limit": 0], SchemaFault(path: "limit", reason: "below 1")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "load": 500.5], SchemaFault(path: "load", reason: "above 500")),
    faulted(["id": "abc", "entries": [["exerciseId": "a"]]], SchemaFault(path: "id", reason: "shorter than 8")),
    faulted(["id": .string(String(repeating: "a", count: 65)), "entries": [["exerciseId": "a"]]], SchemaFault(path: "id", reason: "longer than 64")),
    faulted(["id": "abcdefg h", "entries": [["exerciseId": "a"]]], SchemaFault(path: "id", reason: "not ^[A-Za-z0-9_-]+$")),
    faulted(["id": "abcdefgh", "entries": []], SchemaFault(path: "entries", reason: "fewer than 1 items")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"], ["exerciseId": "b"], ["exerciseId": "c"]]], SchemaFault(path: "entries", reason: "more than 2 items")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"], ["exerciseId": "a"]]], SchemaFault(path: "entries.1", reason: "repeats an item")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"], ["exerciseId": 2]]], SchemaFault(path: "entries.1.exerciseId", reason: "not \"string\"")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a", "sets": []]]], SchemaFault(path: "entries.0.sets", reason: "not a property")),
  ]

  static func faulted(_ value: JSON, _ fault: SchemaFault) -> (JSON, SchemaFault) { (value, fault) }

  @Test(arguments: AbilitiesTests.faults)
  func theSchemaCheckNamesTheFirstFault(_ value: JSON, _ fault: SchemaFault) {
    #expect(Self.schema.fault(in: value) == fault)
  }

  @Test func aValueInsideItsSchemaPasses() {
    #expect(Self.schema.fault(in: ["id": "abcdefgh", "entries": [["exerciseId": "a"], ["exerciseId": "b"]], "kind": "add", "saved": true, "limit": 200,
                                   "load": -500]) == nil)
  }
}
