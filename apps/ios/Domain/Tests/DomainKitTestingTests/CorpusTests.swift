@testable import DomainKit
import DomainKitTesting
import Foundation
import SyncAPI
import SyncCore
import SyncTesting
import Testing

// The kit's shared vectors, packages/api-contract/domain-kit/ (domain-kit.md §15.2): one test case per vector, compared
// with its `expect` by JCS. A trap a vector expects runs in a process of its own (TrapVectorTests).
struct CorpusTests {
  static let directory = "domain-kit"

  static let handlers: [String: @Sendable (Vector) throws -> JSON] = [
    "value/text.json": Values.text,
    "value/number.json": Values.number,
    "value/choice.json": Values.choice,
    "value/count.json": Values.count,
    "time/day.json": Days.handle,
    "order/list.json": Lists.handle,
    "capacity/count.json": Lists.capacity,
    "plan/translate.json": Plans.translate,
    "run/pipeline.json": Plans.pipeline,
    "draft/save.json": Drafts.save,
    "draft/script.json": { try Drafts.script($0, trapping: false) },
    "refusal/subject.json": Refusals.subject,
  ]

  static func vectors() throws -> [Vector] {
    try Contract.files(under: directory).flatMap { try Contract.vectors($0) }
  }

  static func handle(_ vector: Vector) throws -> JSON {
    let file = String(vector.file.dropFirst(directory.count + 1))
    guard let handler = handlers[file] else { throw ContractError("no handler for \(vector.file)") }
    return try handler(vector)
  }

  @Test func everyFileHasAHandler() throws {
    let files = try Contract.files(under: CorpusTests.directory).map { String($0.dropFirst(CorpusTests.directory.count + 1)) }
    #expect(files.sorted() == CorpusTests.handlers.keys.sorted())
  }

  @Test(arguments: try CorpusTests.vectors().filter { !Traps.trapsAtConstruction($0) })
  func vector(_ vector: Vector) throws {
    let result = try CorpusTests.handle(vector)
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}

// MARK: - Vector inputs

extension Vector {
  var registry: Registry { get throws { try Corpus.probeRegistry() } }

  func string(_ key: String) throws -> String { try input.member(key).asString() }

  var moment: Moment {
    let now = (try? input["now"]?.asInteger()) ?? Probe.start.ms
    let offset = (try? input["offsetSeconds"]?.asInteger()).map { Int($0) } ?? 0
    return Moment(now: Instant(ms: now), zone: FixedZone(offsetSeconds: offset))
  }

  var scope: ScopeRef { get throws { try input["scope"].map { try ScopeRef($0.asString()) } ?? Probe.scope } }
}

func fields(_ json: JSON?) throws -> [String: JSON] {
  guard let json else { return [:] }
  return Dictionary(uniqueKeysWithValues: try json.asObject().members.map { ($0.key, $0.value) })
}

func recordID(_ json: JSON?) throws -> RecordID? {
  guard let json, !json.isNull else { return nil }
  return try RecordID(json: json)
}

func placement(_ json: JSON?) throws -> Placement? {
  switch json {
  case nil, .null?: return nil
  case .string("top")?: return .top
  case .string("bottom")?: return .bottom
  case let json?: return .below(try RecordID(json: json.member("below")))
  }
}

// MARK: - value/*.json

enum Values {
  static func text(_ vector: Vector) throws -> JSON {
    if let text = vector.input["isBlank"] { return ["isBlank": .bool(TextSpec.isBlank(try text.asString()))] }
    let spec = try textSpec(vector.input.member("spec"))
    if let text = vector.input["measure"] { return ["measured": JSON(spec.measure(try text.asString()))] }
    return try violationOr {
      let at = at(vector, spec.path)
      guard case .string(let value) = try vector.input.member("value") else { return ["value": .of(try spec.apply(nil as String?, at: at))] }
      return ["value": .string(try spec.apply(value, at: at) as String)]
    }
  }

  static func number(_ vector: Vector) throws -> JSON {
    let spec = try numberSpec(vector.input.member("spec"))
    let at = at(vector, spec.path)
    let value = try vector.input.member("value")
    if vector.input["as"] == "int" {
      if value.isNull { return try violationOr { ["value": .of(try spec.apply(nil as Int?, at: at))] } }
      guard let integer = Int(exactly: try value.asDouble()) else { return ["error": true] }
      return try violationOr { ["value": JSON(try spec.apply(integer, at: at) as Int)] }
    }
    let number: Double? = switch value {
    case .null: nil
    case .string("NaN"): Double.nan
    case .string("Infinity"): Double.infinity
    case .string("-Infinity"): -Double.infinity
    default: try value.asDouble()
    }
    return try violationOr { ["value": .of(try spec.apply(number, at: at))] }
  }

  static func choice(_ vector: Vector) throws -> JSON {
    let spec = try choiceSpec(vector.input.member("spec"))
    let value = try vector.input.member("value")
    return try violationOr {
      guard case .string(let text) = value else { return ["value": .of(try spec.apply(nil as String?, at: at(vector, spec.path)))] }
      return ["value": .string(try spec.apply(text, at: at(vector, spec.path)) as String)]
    }
  }

  static func count(_ vector: Vector) throws -> JSON {
    let spec = try countSpec(vector.input.member("spec"))
    let itemSpec = try vector.input["itemSpec"].map(valueSpec)
    let items = try vector.input.member("items")
    if items.isNull { return try violationOr { ["items": try spec.apply(nil as [Item]?, at: at(vector, spec.path)).map { .array($0.map(\.json)) } ?? .null] } }
    let values = try items.asArray().map { Item(value: $0, spec: itemSpec) }
    return try violationOr { ["items": .array(try spec.apply(values, at: at(vector, spec.path)).map(\.json))] }
  }

  // An item holding one raw value; it validates by applying the item spec at its own path.
  struct Item: ValueObject {
    let value: JSON
    let spec: (any ValueSpec)?

    init(value: JSON, spec: (any ValueSpec)?) {
      self.value = value
      self.spec = spec
    }

    init(_ f: Fields) throws(DecodeError) {
      throw DecodeError(type: "", field: "", reason: "a vector item is built, never decoded")
    }

    var json: JSON { value }

    func validated(at path: Path) throws(Violation) -> Item {
      switch (spec, value) {
      case (let spec as TextSpec, .string(let text)): Item(value: .string(try spec.apply(text, at: path) as String), spec: spec)
      case (let spec as ChoiceSpec, .string(let text)): Item(value: .string(try spec.apply(text, at: path) as String), spec: spec)
      case (let spec as NumberSpec, .number(let number)): Item(value: .of(try spec.apply(number.value, at: path) as Double), spec: spec)
      default: self
      }
    }
  }

  static func at(_ vector: Vector, _ path: String) -> Path {
    if case .string(let at)? = vector.input["at"] { return Path(at) }
    return Path(path.split(separator: ".").last.map(String.init) ?? path)
  }

  static func violationOr(_ body: () throws -> JSON) throws -> JSON {
    do {
      return try body()
    } catch let violation as Violation {
      return ["violation": violation.form]
    }
  }

  static func valueSpec(_ json: JSON) throws -> any ValueSpec {
    switch try json.member("kind").asString() {
    case "text": try textSpec(json)
    case "number": try numberSpec(json)
    case "choice": try choiceSpec(json)
    default: try countSpec(json)
    }
  }

  static func textSpec(_ json: JSON) throws -> TextSpec {
    guard let unit = TextUnit(rawValue: try json.member("unit").asString()) else { throw ContractError("no unit in \(json)") }
    return TextSpec(try json.member("path").asString(), unit: unit, min: Int(try json.member("min").asInteger()),
                    max: Int(try json.member("max").asInteger()), trim: try json.member("trim").asBool(), nfc: try json.member("nfc").asBool())
  }

  static func numberSpec(_ json: JSON) throws -> NumberSpec {
    NumberSpec(try json.member("path").asString(), min: try json.member("min").asDouble(), max: try json.member("max").asDouble(),
               integer: try json["integer"]?.asBool() ?? false, quantum: try json["quantum"].flatMap { $0.isNull ? nil : try $0.asDouble() })
  }

  static func choiceSpec(_ json: JSON) throws -> ChoiceSpec {
    ChoiceSpec(try json.member("path").asString(), values: try json.member("values").asArray().map { try $0.asString() })
  }

  static func countSpec(_ json: JSON) throws -> CountSpec {
    CountSpec(try json.member("path").asString(), min: Int(try json.member("min").asInteger()), max: Int(try json.member("max").asInteger()))
  }
}

// MARK: - time/day.json

enum Days {
  static func handle(_ vector: Vector) throws -> JSON {
    let input = vector.input
    switch try vector.string("op") {
    case "fromInstant":
      return ["day": .string(LocalDay(Instant(ms: try input.member("ms").asInteger()), offsetSeconds: Int(try input.member("offsetSeconds").asInteger())).text)]
    case "parse":
      guard let day = LocalDay(try vector.string("text")) else { return ["error": true] }
      return ["day": .string(day.text)]
    case "adding":
      return ["day": .string(try day(vector, "day").adding(days: Int(try input.member("days").asInteger())).text)]
    case "daysUntil":
      return ["days": JSON(try day(vector, "day").days(until: try day(vector, "other")))]
    case "weekday":
      return ["weekday": JSON(try day(vector, "day").weekday)]
    case let op:
      throw ContractError("no day op \(op)")
    }
  }

  static func day(_ vector: Vector, _ key: String) throws -> LocalDay {
    guard let day = LocalDay(try vector.string(key)) else { throw ContractError("\(key) is no day") }
    return day
  }
}

// MARK: - order/list.json and capacity/count.json

enum Lists {
  static func handle(_ vector: Vector) throws -> JSON {
    try list(try probeEntity(vector.string("t")), vector)
  }

  static func list<E: ProbeEntity>(_ type: E.Type, _ vector: Vector) throws -> JSON {
    let registry = try vector.registry
    let records = try VectorRecords(drawn: vector.input["records"]?["drawn"], stored: vector.input["records"]?["stored"], registry: registry)
    let source = VectorReader(records: records, now: vector.moment.now.ms)
    let reader = Reader(source, scope: E.scope, moment: vector.moment, registry: registry)
    let repository = reader.repository(E.self)
    if let view = vector.input["view"] {
      return ["ids": .array(try repository.all(in: view == "drawn" ? .drawn : .stored).map(\.id.json))]
    }
    if let children = vector.input["children"] {
      let parent = ID<E>(try RecordID(json: children.member("of")))
      let view: ViewMode = children["view"] == "stored" ? .stored : .drawn
      return ["ids": .array(try repository.children(of: parent, via: try children.member("via").asString(), in: view).map(\.id.json))]
    }
    if let remove = vector.input["remove"] {
      guard let removable = E.self as? any (ProbeEntity & Removable).Type else { return ["error": true] }
      return try Lists.remove(removable, try RecordID(json: remove.member("id")), reader: reader, ids: IDSource(context: source), registry: registry)
    }
    guard let ordered = E.self as? any (ProbeEntity & Ordered).Type else { return ["error": true] }
    if let placement = try placement(vector.input["placement"]) {
      return ["anchor": try repository.anchor(placement, orderField: ordered.orderField)?.json ?? .null]
    }
    return try move(ordered, vector, reader: reader, ids: IDSource(context: source), registry: registry)
  }

  static func move<E: ProbeEntity & Ordered>(_ type: E.Type, _ vector: Vector, reader: Reader, ids: IDSource, registry: Registry) throws -> JSON {
    let move = try vector.input.member("move")
    let action = Move<E, ProbeRefusal>(ID(try RecordID(json: move.member("id"))), below: try recordID(move["below"]).map { ID($0) })
    let decision = try action.decide(try action.load(reader), ids: ids)
    return ["decision": try decision.form(in: E.scope, registry: registry, result: { .null }, refusal: \.form)]
  }

  static func remove<E: ProbeEntity & Removable>(_ type: E.Type, _ id: RecordID, reader: Reader, ids: IDSource, registry: Registry) throws -> JSON {
    let action = Remove<E, ProbeRefusal>(ID(id))
    let decision = try action.decide(try action.load(reader), ids: ids)
    return ["decision": try decision.form(in: E.scope, registry: registry, result: { .null }, refusal: \.form)]
  }

  static func capacity(_ vector: Vector) throws -> JSON {
    try capacity(try probeEntity(vector.string("t")), vector)
  }

  static func capacity<E: ProbeEntity>(_ type: E.Type, _ vector: Vector) throws -> JSON {
    let registry = try vector.registry
    let records = try VectorRecords(drawn: vector.input["records"]?["drawn"], stored: vector.input["records"]?["stored"], registry: registry)
    let capacity = Capacity(of: E.self, stored: records.stored, registry: registry)
    return ["used": JSON(capacity.used), "cap": JSON(capacity.cap), "full": .bool(capacity.isFull)]
  }
}
