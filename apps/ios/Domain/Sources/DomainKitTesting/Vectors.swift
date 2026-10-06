import DomainKit
import SyncAPI
import SyncCore
import SyncTesting

// §15 running a vector: the records it lists as the engine's readers answer them, its value cases, and a product's
// corpus over the product's rule book.

// §15.3 a product's corpus under `packages/api-contract/<product>/`: each LOCAL rule's cases (`domain/values.json`), each
// action's and draft save's decisions (`domain/<feature>-actions.json`) and each derived read's results
// (`rules/<read>.json`), run over the book that declares them.
public struct ProductCorpus {
  let book: RuleBook

  public init(_ book: RuleBook) {
    self.book = book
  }

  // `values.json`. A spec case is a value vector (§15.2) whose spec is one of the book's; an entity case, `{entity, id,
  // fields, now, offsetSeconds}`, validates every field of the entity it states → `{fields}` or `{violation}`.
  public func value(_ vector: Vector) throws -> JSON {
    let input = vector.input
    if let spec = input["spec"] {
      guard book.rules.contains(where: { $0.spec == spec }) else { throw ContractError("\(vector) runs a spec the book does not hold") }
      return try ValueVectors.run(input)
    }
    let name = try input.member("entity").asString()
    guard let entity = book.entity(name) as? any Writable.Type else {
      throw ContractError("\(vector) names \(name), no writable entity of the book")
    }
    return try validated(entity, input)
  }

  func validated<E: Writable>(_ type: E.Type, _ input: JSON) throws -> JSON {
    let (entity, moment) = (try E(form: input), try Moment(form: input))
    do throws(Violation) {
      return ["fields": .object(fields: try Valid(entity, at: moment).value.fields)]
    } catch {
      return ["violation": error.form]
    }
  }

  // `<feature>-actions.json`, `{action, input, records: {drawn, stored}, ids, now, offsetSeconds}` → `{decision}`: the
  // decision the decider makes over the records at the moment, minting the listed ids in order, a violation its decide
  // throws folded into its refusal (§9.1). `stored` defaults to `drawn`.
  public func decision<D: Decider>(of decider: D, _ vector: Vector, result: (D.Result) -> JSON, refusal: (D.Refusal) -> JSON)
    throws -> JSON
  {
    let (context, moment) = try scene(of: vector, in: decider.scope)
    let loaded = try decider.load(Reader(context, scope: decider.scope, moment: moment, registry: book.registry))
    let decision = decider.decision(loaded, ids: IDSource(context: context))
    return ["decision": try decision.form(in: decider.scope, registry: book.registry, result: result, refusal: refusal)]
  }

  // An editor opens the drawn entity or starts a new draft, edits its current value, then decides its save (§10.2).
  public func save<E: Draftable, R: ProductRefusal>(_ type: SaveDraft<E, R>.Type, _ vector: Vector, opening blank: E,
                                                   edit: (inout E) -> Void, result: (Saved) -> JSON, refusal: (R) -> JSON)
    throws -> JSON
  {
    let (context, moment) = try scene(of: vector, in: E.scope)
    let read = Reader(context, scope: E.scope, moment: moment, registry: book.registry)
    var draft = try read.repository(E.self).find(blank.id, in: .drawn).map { Draft(opening: $0) } ?? Draft(new: blank)
    edit(&draft.current)
    return try decision(of: SaveDraft<E, R>(draft), vector, result: result, refusal: refusal)
  }

  // `rules/<read>.json`, `{read, input?, records: {drawn, stored?}, firstPullComplete?, now, offsetSeconds}` → `{result}`:
  // a derived read (§7.4) over a reader of the records in `scope` at the moment, the first pull complete unless the
  // vector says otherwise.
  public func read(_ vector: Vector, in scope: ScopeRef, _ body: (Reader) throws -> JSON) throws -> JSON {
    let (context, moment) = try scene(of: vector, in: scope)
    return ["result": try body(Reader(context, scope: scope, moment: moment, registry: book.registry))]
  }

  // A vector's records as the engine's readers of `scope` answer them, at its moment, minting its `ids` in order.
  func scene(of vector: Vector, in scope: ScopeRef) throws -> (VectorReader, Moment) {
    let input = vector.input
    let rows = try input.member("records")
    let records = try VectorRecords(drawn: rows["drawn"], stored: rows["stored"] ?? rows["drawn"], registry: book.registry)
    let (moment, ids) = (try Moment(form: input), try (input["ids"]?.asArray() ?? []).map { try RecordID(json: $0) })
    let firstPullComplete = try input["firstPullComplete"]?.asBool() ?? true
    let reader = VectorReader(records: records, now: moment.now.ms, ids: ids, firstPullComplete: firstPullComplete,
                              scope: (scope, book.registry))
    return (reader, moment)
  }
}

extension Moment {
  // `{now, offsetSeconds}`: the instant in a fixed zone.
  init(form: JSON) throws {
    let offset = Int(try form.member("offsetSeconds").asInteger())
    self.init(now: Instant(ms: try form.member("now").asInteger()), zone: FixedZone(offsetSeconds: offset))
  }
}

// MARK: - Records

// The records a vector lists per view (§15.1), each an engine row as the engine's readers hand it to a product.
package struct VectorRecords: Sendable {
  package var drawn: [Record]
  package var stored: [Record]

  package init(drawn: JSON?, stored: JSON?, registry: Registry) throws {
    self.drawn = try VectorRecords.records(drawn, registry: registry)
    self.stored = try VectorRecords.records(stored, registry: registry)
  }

  static func records(_ rows: JSON?, registry: Registry) throws -> [Record] {
    try (rows?.asArray() ?? []).map { json in Record(confirmed: try Row(json: json), registry: registry) }
  }
}

// A reader over a vector's records: the folded record by id visible or not, and the visible records of a type in id
// order, as the engine's readers answer (ER-3, ER-12). Given a scope, it refuses a type of another scope as they do. It
// mints the ids the vector lists, in order, and no other; the replica it writes to is one no vector names.
package final class VectorReader: CommitContext {
  let records: VectorRecords
  package let now: Int64
  package let replica = "rp_00000000000000000000000000000001"
  package var actor: String { replica }
  package let isAnonymous = false
  var ids: [RecordID]
  let pulled: Bool
  let scope: (ref: ScopeRef, registry: Registry)?

  package init(records: VectorRecords, now: Int64, ids: [RecordID] = [], firstPullComplete: Bool = true,
               scope: (ref: ScopeRef, registry: Registry)? = nil) {
    self.records = records
    self.now = now
    self.ids = ids
    pulled = firstPullComplete
    self.scope = scope
  }

  package func drawn(_ type: String, _ id: RecordID) throws -> Record? { find(records.drawn, try lives(type), id) }
  package func stored(_ type: String, _ id: RecordID) throws -> Record? { find(records.stored, try lives(type), id) }
  package func drawn(_ type: String) throws -> [Record] { visible(records.drawn, try lives(type)) }
  package func stored(_ type: String) throws -> [Record] { visible(records.stored, try lives(type)) }

  package func drawn(_ type: String, where field: String, is id: RecordID) throws -> [Record] {
    visible(records.drawn, try lives(type)).filter { $0.values[field] == id.json }
  }

  package func stored(_ type: String, where field: String, is id: RecordID) throws -> [Record] {
    visible(records.stored, try lives(type)).filter { $0.values[field] == id.json }
  }

  // The engine's readers throw on a type of another scope.
  func lives(_ type: String) throws -> String {
    guard let scope, !scope.registry.lives(type, in: scope.ref) else { return type }
    throw CommitFailure.malformed("\(type) is no type of \(scope.ref)")
  }

  package func device(_ key: String) throws -> JSON? { nil }
  package func firstPullComplete() throws -> Bool { pulled }
  package func confirmed(_ type: String, _ id: RecordID) throws -> Record? { try stored(type, id) }
  package func checkpoint() throws -> ScopeCheckpoint { ScopeCheckpoint() }
  package func devices(prefix: String) throws -> JSON.Object { [:] }
  package func commands() throws -> [QueuedCommand] { [] }
  package func opaqueID() throws -> String { throw CommitFailure.malformed("the vector lists no opaque identity") }

  package func mintID(_ type: String) throws -> RecordID {
    guard !ids.isEmpty else { throw CommitFailure.malformed("the vector lists no id left to mint a \(type)") }
    return ids.removeFirst()
  }

  func find(_ records: [Record], _ type: String, _ id: RecordID) -> Record? {
    records.first { $0.type == type && $0.id == id }
  }

  func visible(_ records: [Record], _ type: String) -> [Record] {
    records.filter { $0.type == type && $0.isVisible }.sorted { $0.id < $1.id }
  }
}

// MARK: - Value vectors

// §15.2 a value vector over the spec its form states: `{spec, value, at?}` (`value` null: the optional overload), a text
// spec's `{spec, measure}` and `{isBlank}`, a number spec's `{spec, value, as: "int"}`, and a count spec's `{spec, items,
// itemSpec?}`. The spec applies at `at`, by default the last dotted component of its path.
package enum ValueVectors {
  package static func run(_ input: JSON) throws -> JSON {
    if let text = input["isBlank"] { return ["isBlank": .bool(TextSpec.isBlank(try text.asString()))] }
    let form = try input.member("spec")
    let path = try form.member("path").asString()
    let at = Path(try input["at"]?.asString() ?? path.split(separator: ".").last.map(String.init) ?? path)
    switch try spec(form) {
    case let spec as TextSpec: return try text(spec, input, at: at)
    case let spec as NumberSpec: return try number(spec, input, at: at)
    case let spec as ChoiceSpec: return try choice(spec, input, at: at)
    case let spec as CountSpec: return try count(spec, input, at: at)
    case let spec: throw ContractError("no value vector for \(spec.json)")
    }
  }

  package static func spec(_ form: JSON) throws -> any ValueSpec {
    switch try form.member("kind").asString() {
    case "text": try TextSpec(form: form)
    case "number": try NumberSpec(form: form)
    case "choice": try ChoiceSpec(form: form)
    case "count": try CountSpec(form: form)
    case let kind: throw ContractError("no spec kind \(kind)")
    }
  }

  static func text(_ spec: TextSpec, _ input: JSON, at: Path) throws -> JSON {
    if let text = input["measure"] { return ["measured": JSON(spec.measure(try text.asString()))] }
    let value = try input.member("value")
    return try violationOr {
      guard case .string(let text) = value else { return ["value": .of(try spec.apply(nil as String?, at: at))] }
      return ["value": .string(try spec.apply(text, at: at) as String)]
    }
  }

  // A number that is not finite is written "NaN", "Infinity" or "-Infinity".
  static func number(_ spec: NumberSpec, _ input: JSON, at: Path) throws -> JSON {
    let value = try input.member("value")
    if input["as"] == "int" {
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

  static func choice(_ spec: ChoiceSpec, _ input: JSON, at: Path) throws -> JSON {
    let value = try input.member("value")
    return try violationOr {
      guard case .string(let text) = value else { return ["value": .of(try spec.apply(nil as String?, at: at))] }
      return ["value": .string(try spec.apply(text, at: at) as String)]
    }
  }

  static func count(_ spec: CountSpec, _ input: JSON, at: Path) throws -> JSON {
    let itemSpec = try input["itemSpec"].map(ValueVectors.spec)
    let items = try input.member("items")
    if items.isNull { return try violationOr { ["items": try spec.apply(nil as [Item]?, at: at).map { .array($0.map(\.json)) } ?? .null] } }
    let values = try items.asArray().map { Item(value: $0, spec: itemSpec) }
    return try violationOr { ["items": .array(try spec.apply(values, at: at).map(\.json))] }
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

  static func violationOr(_ body: () throws -> JSON) throws -> JSON {
    do {
      return try body()
    } catch let violation as Violation {
      return ["violation": violation.form]
    }
  }
}
