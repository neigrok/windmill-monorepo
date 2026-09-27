import DomainKit
import Foundation
import SyncAPI
import SyncCore

// §15 the shared vectors under `packages/api-contract/`, and the JSON forms the kit's values take in them. A runner reads
// a file as `{name, input, expect}` vectors and compares each result with `expect` by JCS.
public enum Contract {
  // The repository's `packages/api-contract`, found by walking up from this file.
  public static func root(from file: String = #filePath) throws -> URL {
    var directory = URL(fileURLWithPath: file).deletingLastPathComponent()
    while directory.path != "/" {
      let contract = directory.appendingPathComponent("packages/api-contract", isDirectory: true)
      if FileManager.default.fileExists(atPath: contract.path) { return contract }
      directory = directory.deletingLastPathComponent()
    }
    throw ContractError("no packages/api-contract above \(file)")
  }

  // A JSON file, by its path under `packages/api-contract`, or an absolute path.
  public static func json(_ path: String) throws -> JSON {
    let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : try root().appendingPathComponent(path)
    guard let data = FileManager.default.contents(atPath: url.path) else { throw ContractError("no file \(path)") }
    return try JSON(parsing: Array(data))
  }

  public static func vectors(_ path: String) throws -> [Vector] {
    try json(path).asArray().map { vector in
      let object = try vector.asObject()
      try object.expectKeys(required: ["name", "input", "expect"])
      return Vector(file: path, name: try object.member("name").asString(), input: try object.member("input"),
                    expect: try object.member("expect"))
    }
  }

  // Every `.json` file under a directory of `packages/api-contract`, by path, in byte order.
  public static func files(under directory: String) throws -> [String] {
    let base = try root().appendingPathComponent(directory, isDirectory: true)
    guard let walk = FileManager.default.enumerator(atPath: base.path) else { throw ContractError("no directory \(directory)") }
    return walk.compactMap { $0 as? String }.filter { $0.hasSuffix(".json") }.map { "\(directory)/\($0)" }
      .sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
  }
}

public struct Vector: Sendable, CustomStringConvertible {
  public let file: String
  public let name: String
  public let input: JSON
  public let expect: JSON

  public var description: String { "\(file) · \(name)" }
}

public struct ContractError: Error, CustomStringConvertible {
  public let description: String

  public init(_ description: String) {
    self.description = description
  }
}

// MARK: - The JSON forms (domain-kit.md §15.2)

extension JSON {
  // An entity's `fields`, or any map of values, as one object.
  public static func object(fields: [String: JSON]) -> JSON {
    .object(JSON.Object(uniqueKeysWithValues: fields.map { ($0.key, $0.value) }))
  }
}

extension Entity {
  // `{id, fields}`, as a product's vectors state an entity: the record its fields build, decoded (§3.4 step 7).
  public init(form: JSON) throws {
    let fields = try form.member("fields").asObject().members.map { ($0.key, $0.value) }
    try self.init(Fields(type: Self.type, id: try RecordID(json: form.member("id")), values: Dictionary(uniqueKeysWithValues: fields)))
  }
}

extension TextSpec {
  // `{path, kind: "text", unit, min, max, trim, nfc}`.
  package init(form: JSON) throws {
    guard let unit = TextUnit(rawValue: try form.member("unit").asString()) else { throw ContractError("no unit in \(form)") }
    self.init(try form.member("path").asString(), unit: unit, min: Int(try form.member("min").asInteger()),
              max: Int(try form.member("max").asInteger()), trim: try form.member("trim").asBool(), nfc: try form.member("nfc").asBool())
  }
}

extension NumberSpec {
  // `{path, kind: "number", min, max, integer, quantum?}`, a null or absent quantum none.
  package init(form: JSON) throws {
    self.init(try form.member("path").asString(), min: try form.member("min").asDouble(), max: try form.member("max").asDouble(),
              integer: try form["integer"]?.asBool() ?? false, quantum: try form["quantum"].flatMap { $0.isNull ? nil : try $0.asDouble() })
  }
}

extension ChoiceSpec {
  // `{path, kind: "choice", values}`.
  package init(form: JSON) throws {
    self.init(try form.member("path").asString(), values: try form.member("values").asArray().map { try $0.asString() })
  }
}

extension CountSpec {
  // `{path, kind: "count", min, max}`.
  package init(form: JSON) throws {
    self.init(try form.member("path").asString(), min: Int(try form.member("min").asInteger()), max: Int(try form.member("max").asInteger()))
  }
}

extension Violation {
  // `{rule, path, reason, …}`, the reason's members as keys.
  public var form: JSON {
    var object: JSON.Object = ["rule": .string(rule), "path": .string(path.text)]
    switch reason {
    case .blank: object["reason"] = "blank"
    case .nul: object["reason"] = "nul"
    case .notANumber: object["reason"] = "notANumber"
    case .notInteger: object["reason"] = "notInteger"
    case .notOneOf: object["reason"] = "notOneOf"
    case .tooShort(let min, let unit):
      object["reason"] = "tooShort"
      object["min"] = JSON(min)
      object["unit"] = .string(unit.rawValue)
    case .tooLong(let max, let unit, let measured):
      object["reason"] = "tooLong"
      object["max"] = JSON(max)
      object["unit"] = .string(unit.rawValue)
      object["measured"] = JSON(measured)
    case .below(let min):
      object["reason"] = "below"
      object["min"] = .of(min)
    case .above(let max):
      object["reason"] = "above"
      object["max"] = .of(max)
    case .tooFew(let min):
      object["reason"] = "tooFew"
      object["min"] = JSON(min)
    case .tooMany(let max):
      object["reason"] = "tooMany"
      object["max"] = JSON(max)
    case .custom(let text):
      object["reason"] = "custom"
      object["custom"] = .string(text)
    }
    return .object(object)
  }
}

extension Refused {
  public var form: JSON {
    ["code": code.json, "subject": subject.map(\.form) ?? .null, "detail": detail ?? .null, "path": path.form]
  }
}

extension Refused.Path {
  public var form: JSON { self == .predicted ? "predicted" : "notice" }
}

extension RecordRef {
  public var form: JSON { ["t": .string(type), "id": id.json] }
}

extension Gesture {
  // `{changes, atomic, hold, guards, retire, cmd, predict, local}`, all eight keys always.
  public var form: JSON {
    ["changes": .array(changes.map(\.form)), "atomic": .bool(atomic), "hold": .bool(hold),
     "guards": .array(guards.map { ["t": .string($0.type), "id": $0.id.json, "field": .string($0.field)] }),
     "retire": .array(retire.map(\.form)), "cmd": command?.json ?? .null, "predict": .array(predict.map(\.form)),
     "local": .array(local.map { ["key": .string($0.key), "value": $0.value ?? .null] })]
  }
}

extension Change {
  // `{op, t, id}`, `f` and `x` when non-empty, `present` on a put, `anchor` when set.
  public var form: JSON {
    var object: JSON.Object = ["t": .string(type), "id": id?.json ?? .null]
    switch operation {
    case .create: object["op"] = "create"
    case .update: object["op"] = "update"
    case .delete: object["op"] = "delete"
    case .revive: object["op"] = "revive"
    case .put(_, let present):
      object["op"] = "put"
      object["present"] = present.map { .bool($0) } ?? .null
    case .write: object["op"] = "write"
    case .move: object["op"] = "move"
    }
    if !values.isEmpty { object["f"] = .object(fields: values) }
    if !texts.isEmpty {
      object["x"] = .object(JSON.Object(uniqueKeysWithValues: texts.map { name, edit in
        (name, ["text": .string(edit.text), "from": edit.editedFrom.map { .string($0) } ?? .null])
      }))
    }
    object["anchor"] = anchor.map { ["field": .string($0.field), "below": $0.below?.json ?? .null] }
    return .object(object)
  }
}

extension CommitReceipt {
  public var form: JSON {
    ["gestureId": .string(gestureId), "localIds": .array(localIds.map { .string($0) }),
     "retired": .array(retired.map { .string($0) }), "releaseAt": releaseAt.map { JSON($0) } ?? .null]
  }
}

extension Saved {
  public var form: JSON {
    ["values": .object(fields: values), "exists": .bool(exists)]
  }
}

extension Placement {
  public var form: JSON {
    switch self {
    case .top: "top"
    case .bottom: "bottom"
    case .below(let id): ["below": id.json]
    }
  }
}

extension Draft {
  public var form: JSON {
    ["id": id.json, "base": .object(fields: base.fields), "current": .object(fields: current.fields), "isNew": .bool(isNew),
     "placement": placement?.form ?? .null]
  }
}

extension Decision {
  // A write's gesture as §8.2 translates its plan for `scope`.
  public func form(in scope: ScopeRef, registry: Registry, result: (Result) -> JSON, refusal: (Refusal) -> JSON) throws -> JSON {
    switch self {
    case .write(let plan, let value):
      ["write": ["gesture": try plan.gesture(in: scope, registry: registry).form, "result": result(value)]]
    case .unchanged(let value): ["unchanged": ["result": result(value)]]
    case .refuse(let reason): ["refuse": refusal(reason)]
    }
  }
}

extension Outcome {
  public func form(result: (Result) -> JSON, refusal: (Refusal) -> JSON) -> JSON {
    switch self {
    case .committed(let value, let receipt): ["committed": ["result": result(value), "receipt": receipt.form]]
    case .unchanged(let value): ["unchanged": ["result": result(value)]]
    case .refused(let reason): ["refused": refusal(reason)]
    }
  }
}
