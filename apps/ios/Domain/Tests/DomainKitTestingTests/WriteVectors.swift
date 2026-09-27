@testable import DomainKit
import DomainKitTesting
import Foundation
import SyncAPI
import SyncCore
import Testing

// The corpus handlers that write: plans and their translation, the run pipeline, drafts and their saves, and refusal
// subjects (domain-kit.md §8–§12, §15.2).

enum Plans {
  static func translate(_ vector: Vector) throws -> JSON {
    do {
      let plan = try build(vector, at: vector.moment)
      return ["gesture": try plan.gesture(in: vector.scope, registry: vector.registry).form]
    } catch let violation as Violation {
      return ["violation": violation.form]
    } catch is PlanError {
      return ["error": true]
    }
  }

  static func pipeline(_ vector: Vector) throws -> JSON {
    let registry = try vector.registry
    let drawn = vector.input["drawn"]
    let replica = VectorReplica(try VectorRecords(drawn: drawn, stored: vector.input["stored"] ?? drawn, registry: registry),
                                now: vector.moment.now.ms, answer: try answer(vector))
    let runner = ActionRunner(replica: replica, registry: registry, zone: vector.moment.zone)
    do {
      let outcome = try runner.run(VectorAction(vector: vector, scope: try vector.scope))
      return ["outcome": outcome.form(result: { .null }, refusal: \.form)]
    } catch is PlanError {
      return ["error": true]
    }
  }

  // The action a pipeline vector runs: it loads nothing and writes the vector's plan.
  struct VectorAction: Action {
    let vector: Vector
    let scope: ScopeRef

    func load(_ read: Reader) throws -> Moment { read.moment }

    func decide(_ moment: Moment, ids: IDSource) throws(Violation) -> Decision<Void, ProbeRefusal> {
      do {
        return .write(try Plans.build(vector, at: moment))
      } catch let violation as Violation {
        throw violation
      } catch {
        return .refuse(.refused(Refused("vector-malformed", subject: nil, detail: .string("\(error)"), path: .predicted)))
      }
    }
  }

  static func answer(_ vector: Vector) throws -> CommitOutcome? {
    if let receipt = vector.input["receipt"] {
      return .committed(CommitReceipt(
        gestureId: try receipt.member("gestureId").asString(), stamp: .unset,
        localIds: try receipt.member("localIds").asArray().map { try $0.asString() }, ids: [],
        releaseAt: try receipt["releaseAt"].flatMap { $0.isNull ? nil : try $0.asInteger() },
        retired: try receipt.member("retired").asArray().map { try $0.asString() }))
    }
    guard let refused = vector.input["refused"] else { return nil }
    return .refused(RefusalCode(try refused.member("code").asString()), detail: refused["detail"])
  }

  // `cmd` and `predict` first, then each operation of `plan` in order (README, plan/translate.json).
  static func build(_ vector: Vector, at moment: Moment) throws -> Plan {
    var plan = try vector.input["cmd"].map { try command($0, predicting: try predictions(vector)) } ?? Plan()
    for operation in try vector.input.member("plan").asArray() {
      let op = try operation.member("op").asString()
      guard op != "device" else {
        let value = try operation.member("value")
        plan.device(try operation.member("key").asString(), value.isNull ? nil : value)
        continue
      }
      try apply(try probeEntity(operation.member("t").asString()), op, operation, to: &plan, at: moment)
    }
    return plan
  }

  static func command(_ json: JSON, predicting predictions: [Prediction]) throws -> Plan {
    let args = try fields(json.member("args"))
    switch try json.member("name").asString() {
    case ProbeStart.name: return try Plan(running: ProbeStart(args: args), predicting: predictions)
    case ProbeEnd.name: return try Plan(running: ProbeEnd(args: args), predicting: predictions)
    case ProbeCopy.name: return try Plan(running: ProbeCopy(args: args), predicting: predictions)
    case let name: throw ContractError("no probe command \(name)")
    }
  }

  static func predictions(_ vector: Vector) throws -> [Prediction] {
    try (vector.input["predict"]?.asArray() ?? []).map { json in
      try prediction(try probeEntity(json.member("t").asString()), json)
    }
  }

  static func prediction<E: ProbeEntity>(_ type: E.Type, _ json: JSON) throws -> Prediction {
    let (id, values) = (ID<E>(try RecordID(json: json.member("id"))), try fields(json["f"]))
    return try json.member("op").asString() == "create" ? .create(E.self, id, values) : .update(E.self, id, values)
  }

  static func apply<E: ProbeEntity>(_ type: E.Type, _ op: String, _ operation: JSON, to plan: inout Plan, at moment: Moment) throws {
    let id = try RecordID(json: operation.member("id"))
    switch op {
    case "create":
      let valid = try valid(E.self, id, operation, at: moment)
      guard let named = try operation["fields"].map(names) else { return plan.create(valid) }
      plan.create(valid, fields: named)
    case "insert":
      guard let ordered = E.self as? any (ProbeEntity & Ordered).Type else { throw unexpressible(op, E.type) }
      try insert(ordered, id, operation, to: &plan, at: moment)
    case "update":
      let base = try operation["base"].map { try E.decoding(id, fields($0)) }
      plan.update(try valid(E.self, id, operation, at: moment), fields: try operation["fields"].map(names), from: base,
                  guarded: operation["guarded"] == true)
    case "remove":
      guard let removable = E.self as? any (ProbeEntity & Removable).Type else { throw unexpressible(op, E.type) }
      remove(removable, id, from: &plan)
    case "move":
      guard let ordered = E.self as? any (ProbeEntity & Ordered).Type else { throw unexpressible(op, E.type) }
      move(ordered, id, below: try recordID(operation["below"]), in: &plan)
    case "guardRead":
      plan.guardRead(ID<E>(id), fields: try names(operation.member("fields")))
    default:
      throw ContractError("no plan operation \(op)")
    }
  }

  static func insert<E: ProbeEntity & Ordered>(_ type: E.Type, _ id: RecordID, _ operation: JSON, to plan: inout Plan, at moment: Moment) throws {
    plan.insert(try valid(E.self, id, operation, at: moment), below: try recordID(operation["below"]))
  }

  static func remove<E: ProbeEntity & Removable>(_ type: E.Type, _ id: RecordID, from plan: inout Plan) {
    plan.remove(ID<E>(id))
  }

  static func move<E: ProbeEntity & Ordered>(_ type: E.Type, _ id: RecordID, below: RecordID?, in plan: inout Plan) {
    plan.move(ID<E>(id), below: below.map { ID($0) })
  }

  // `Valid(entity, fields: checked, at:)`, `checked` defaulting to `fields`, then to every field.
  static func valid<E: ProbeEntity>(_ type: E.Type, _ id: RecordID, _ operation: JSON, at moment: Moment) throws -> Valid<E> {
    let value = try E.decoding(id, fields(operation["f"]))
    let checked = try operation["checked"].map(names) ?? operation["fields"].map(names) ?? Array(value.fields.keys)
    return try Valid(value, fields: checked, at: moment)
  }

  static func names(_ json: JSON) throws -> [String] {
    try json.asArray().map { try $0.asString() }
  }

  // An operation Swift's types refuse to compile, which the README maps to a failed translation.
  static func unexpressible(_ op: String, _ type: String) -> PlanError {
    PlanError(rule: 0, "\(op) of \(type) does not compile in Swift")
  }
}

// MARK: - draft/save.json and draft/script.json

enum Drafts {
  static func save(_ vector: Vector) throws -> JSON {
    let t = try (vector.input["draft"] ?? vector.input.member("creating")).member("t").asString()
    return try save(try draftable(t), vector)
  }

  static func save<E: ProbeEntity & Draftable>(_ type: E.Type, _ vector: Vector) throws -> JSON {
    let registry = try vector.registry
    let save: SaveDraft<E, ProbeRefusal>
    if let draft = vector.input["draft"] {
      let id = try RecordID(json: draft.member("id"))
      var opened = Draft(try E.decoding(id, fields(draft["base"])), isNew: try draft.member("isNew").asBool(),
                         placement: try placement(draft["placement"]))
      opened.current = try E.decoding(id, fields(draft["current"]))
      save = SaveDraft(opened)
    } else {
      let creating = try vector.input.member("creating")
      save = SaveDraft(creating: try E.decoding(RecordID(json: creating.member("id")), fields(creating["f"])),
                       placement: try placement(creating["placement"]))
    }
    let reader = VectorReader(records: try VectorRecords(drawn: vector.input["drawn"], stored: vector.input["stored"], registry: registry),
                              now: vector.moment.now.ms)
    let decode = { (record: Record?) throws -> E? in try record.map { try E(Fields($0)) } }
    let visible = { (record: Record?) in record.flatMap { $0.isVisible ? $0 : nil } }
    guard let definition = registry.type(E.type) else { throw ContractError("no type \(E.type)") }
    let loaded = SaveDraftLoaded<E>(
      drawn: try decode(visible(try reader.drawn(E.type, save.id.record))),
      stored: try decode(visible(try reader.stored(E.type, save.id.record))),
      folded: try decode(try reader.stored(E.type, save.id.record)),
      anchor: try recordID(vector.input["anchor"]), moment: vector.moment, definition: definition)
    let decision = save.decision(loaded, ids: IDSource(context: reader))
    return ["decision": try decision.form(in: E.scope, registry: registry, result: \.form, refusal: \.form)]
  }

  // Runs the script's operations; a last step that expects a trap runs only when `trapping`, in its own process.
  static func script(_ vector: Vector, trapping: Bool) throws -> JSON {
    try script(try draftable(vector.string("t")), vector, trapping: trapping)
  }

  static func script<E: ProbeEntity & Draftable>(_ type: E.Type, _ vector: Vector, trapping: Bool) throws -> JSON {
    let registry = try vector.registry
    let replica = VectorReplica(try VectorRecords(drawn: vector.input["drawn"], stored: vector.input["stored"], registry: registry),
                                now: vector.moment.now.ms)
    let runner = ActionRunner(replica: replica, registry: registry, zone: vector.moment.zone)
    let operations = try vector.input.member("ops").asArray()
    let trapsLast = Traps.trapsLast(vector)
    var draft: Draft<E>?
    var steps: [JSON] = []
    for (index, operation) in operations.enumerated() {
      if trapsLast && index == operations.count - 1 && !trapping {
        steps.append(["trap": true])
        break
      }
      var step: JSON.Object = [:]
      let id = try recordID(operation["id"])
      switch try operation.member("op").asString() {
      case "new":
        let blank = try E.decoding(try id ?? missing("id"), [:])
        draft = Draft(blank, isNew: true, placement: try placement(operation["placement"]))
      case "open":
        draft = try runner.open(ID<E>(try id ?? missing("id")))
      case "openOrNew":
        let key = try id ?? missing("id")
        draft = try runner.open(ID<E>(key), orNew: try E.decoding(try recordID(operation["blank"]) ?? key, [:]))
      case "edit":
        guard var edited = draft else { throw ContractError("an edit with no draft") }
        edited.current = try E.decoding(edited.id.record, edited.current.fields.merging(try fields(operation["f"])) { _, set in set })
        draft = edited
      case "save":
        guard var saving = draft else { throw ContractError("a save with no draft") }
        if let other = try recordID(operation["as"]) { saving.current = try E.decoding(other, saving.current.fields) }
        if operation["fail"] == true { replica.failNextCommit() }
        let committed = replica.gestures.count
        var result = form(runner.save(&saving, SaveDraft<E, ProbeRefusal>.self))
        if operation["gesture"] == true, case .object(var members) = result {
          members["gesture"] = replica.gestures.count > committed ? replica.gestures[committed].form : .null
          result = .object(members)
        }
        step["result"] = result
        draft = saving
      case "rebase":
        guard let mine = draft else { throw ContractError("a rebase with no draft") }
        draft = mine.rebased(onto: try E.decoding(id ?? mine.id.record, fields(operation["f"])))
      case "records":
        replica.records = try VectorRecords(drawn: operation["drawn"], stored: operation["stored"], registry: registry)
      case let op:
        throw ContractError("no script operation \(op)")
      }
      step["draft"] = draft?.form ?? .null
      steps.append(.object(step))
    }
    return ["steps": .array(steps)]
  }

  static func form(_ result: SaveResult<ProbeRefusal>) -> JSON {
    switch result {
    case .saved(let receipt): ["saved": receipt.map { .string($0.gestureId) } ?? .null]
    case .refused(let refusal): ["refused": refusal.form]
    case .failed: ["failed": true]
    }
  }

  static func draftable(_ type: String) throws -> any (ProbeEntity & Draftable).Type {
    guard let draftable = try probeEntity(type) as? any (ProbeEntity & Draftable).Type else {
      throw ContractError("\(type) is no probe draftable")
    }
    return draftable
  }

  static func missing<T>(_ key: String) throws -> T {
    throw ContractError("an operation without \(key)")
  }
}

// MARK: - refusal/subject.json

enum Refusals {
  static func subject(_ vector: Vector) throws -> JSON {
    let registry = try vector.registry
    switch try vector.string("source") {
    case "commit":
      let plan = try Plans.build(vector, at: vector.moment)
      let subject = plan.subject(ofRefusal: RefusalCode(try vector.string("code")), detail: vector.input["detail"], registry: registry)
      return ["subject": subject?.form ?? .null]
    case "notice":
      let notice = DomainNotice<ProbeRefusal>(try Refusals.notice(vector.input.member("notice")), registry: registry)
      var form: JSON.Object = ["subject": notice.subject?.form ?? .null, "gestureId": .string(notice.gestureId)]
      if let of = vector.input["of"] {
        let values = notice.values(of: RecordRef(type: try of.member("t").asString(), id: try RecordID(json: of.member("id"))))
        form["values"] = .object(fields: values)
      }
      return .object(form)
    case let source:
      throw ContractError("no subject source \(source)")
    }
  }

  static func notice(_ json: JSON) throws -> Notice {
    Notice(id: try json.member("id").asString(), product: "probe", scope: try ScopeRef(json.member("scope").asString()),
           code: RefusalCode(try json.member("code").asString()), detail: json["detail"], content: try content(json.member("content")),
           at: try json["at"]?.asInteger() ?? 0)
  }

  static func content(_ json: JSON) throws -> NoticeContent {
    NoticeContent(deltas: try (json["d"]?.asArray() ?? []).map { try Delta(json: $0) }, command: try json["cmd"].map { try Command(json: $0) },
                  dependents: try (json["dependents"]?.asArray() ?? []).map(content))
  }
}

// MARK: - Traps

// A vector that expects a trap: a script whose last step is `{trap: true}`, or a number spec that is integer and has a
// quantum. Each runs in a process of its own, which must die by the trap's signal; the case reaches that process through
// a file its parent names by its own pid.
enum Traps {
  static func traps(_ vector: Vector) -> Bool {
    trapsLast(vector) || trapsAtConstruction(vector)
  }

  static func trapsLast(_ vector: Vector) -> Bool {
    guard case .array(let steps)? = vector.expect["steps"] else { return false }
    return steps.last?["trap"] == true
  }

  static func trapsAtConstruction(_ vector: Vector) -> Bool {
    guard vector.file.hasSuffix("value/number.json"), vector.expect == ["error": true], let spec = vector.input["spec"] else { return false }
    return spec["integer"] == true && !(spec["quantum"]?.isNull ?? true)
  }

  static func caseFile(of pid: Int32) -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("domain-kit-trap-\(pid).json")
  }

  static func announce(_ vector: Vector) throws {
    let json: JSON = ["file": .string(vector.file), "name": .string(vector.name)]
    try Data(json.jcs).write(to: caseFile(of: getpid()))
  }

  static func announced() throws -> Vector {
    guard let data = FileManager.default.contents(atPath: caseFile(of: getppid()).path) else { throw ContractError("no announced trap") }
    let announced = try JSON(parsing: Array(data))
    let (file, name) = (try announced.member("file").asString(), try announced.member("name").asString())
    guard let vector = try Contract.vectors(file).first(where: { $0.name == name }) else { throw ContractError("no vector \(name)") }
    return vector
  }

  static func run(_ vector: Vector) throws {
    if trapsAtConstruction(vector) {
      _ = try NumberSpec(form: vector.input.member("spec"))
    } else {
      _ = try Drafts.script(vector, trapping: true)
    }
  }
}

@Suite(.serialized) struct TrapVectorTests {
  @Test(arguments: try CorpusTests.vectors().filter(Traps.traps))
  func trap(_ vector: Vector) async throws {
    try Traps.announce(vector)
    defer { try? FileManager.default.removeItem(at: Traps.caseFile(of: getpid())) }
    await #expect(processExitsWith: .signal(SIGTRAP), "\(vector)") {
      guard let vector = try? Traps.announced() else { return }
      try? Traps.run(vector)
    }
  }
}
