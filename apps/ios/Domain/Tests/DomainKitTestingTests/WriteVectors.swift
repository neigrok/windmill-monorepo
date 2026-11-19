@testable import DomainKit
import DomainKitTesting
import Foundation
import SyncAPI
import SyncCore
import SyncTesting
import SyncModelServer
import Testing

// The corpus handlers that write: plans and their translation, the run pipeline, drafts and their saves, and refusal
// subjects (domain-kit.md §8–§12, §15.2).

enum Plans {
  static func translate(_ vector: Vector) throws -> JSON {
    do {
      let plan = try build(vector, at: vector.moment)
      return ["gesture": try plan.gesture(in: vector.scope, registry: try declared(vector)).form]
    } catch let violation as Violation {
      return ["violation": violation.form]
    } catch is PlanError {
      return ["error": true]
    }
  }

  // The probe registry, the tag's `label` declared as `tagField` and the link's fields as `linkFields` where a vector says.
  static func declared(_ vector: Vector) throws -> Registry {
    var fields: [String: JSON] = [:]
    if let label = vector.input["tagField"] { fields["tag"] = ["label": label] }
    if let link = vector.input["linkFields"] { fields["link"] = link }
    let registry = try vector.registry
    guard !fields.isEmpty else { return registry }
    var document = try registry.json.asObject()
    document["types"] = .array(try document.member("types").asArray().map { (type: JSON) throws -> JSON in
      guard case .string(let name)? = type["type"], let declared = fields[name] else { return type }
      var declaration = try type.asObject()
      declaration["fields"] = declared
      return .object(declaration)
    })
    return try Registry(json: .object(document))
  }

  static func pipeline(_ vector: Vector) throws -> JSON {
    let registry = try vector.registry
    let drawn = vector.input["drawn"]
    let replica = VectorReplica(try VectorRecords(drawn: drawn, stored: vector.input["stored"] ?? drawn, registry: registry),
                                now: vector.moment.now.ms, registry: registry, answer: try answer(vector))
    let runner = ActionRunner(replica: replica, registry: registry, zone: vector.moment.zone)
    do {
      let outcome = try runner.run(VectorAction(vector: vector, scope: try vector.scope))
      return ["outcome": outcome.form(result: { .null }, refusal: \.form)]
    } catch is PlanError {
      return ["error": true]
    }
  }

  static func act(_ vector: Vector) throws -> JSON {
    let registry = try vector.registry
    let engine = SteppedEngine(registry: registry, startMs: vector.moment.now.ms, account: nil, rules: NoServerRules())
    let runner = ActionRunner(replica: engine.replica, registry: registry, zone: vector.moment.zone)
    if let mint = vector.input["mint"] {
      let scope = try ScopeRef(json: mint.member("scope"))
      let type = try mint.member("type").asString()
      do {
        let result = try engine.replica.commitAct({ context in
          if mint["borrow"] == true { try context.inScope(scope) { _ in () } }
          if let caught = mint["caughtScope"] { _ = try? context.inScope(ScopeRef(json: caught)) { _ in () } }
          let ids = try (0..<Int(mint.member("count").asInteger())).map { _ in try context.mintID(type, in: scope) }
          return (mint["new"] == true ? ActRequest(scopes: [Probe.scope, scope]) : nil, ids)
        }, segment: { ids, index, _ in
          index == 0 ? Gesture(changes: [.create("board", id: .given("b_00000001"))])
            : Gesture(changes: [.create(type, id: .given(ids[0]), ["label": "New"])])
        })
        return ["count": JSON(result.value.count), "distinct": .bool(Set(result.value).count == result.value.count), "committed": .bool(result.outcome != nil)]
      } catch let failure as CommitFailure where failure.kind == .malformed { return ["error": true] }
    }
    let result = try runner.runAct(VectorAct(vector: vector))
    let outcome: JSON
    var stamps: [Stamp?] = []
    switch result {
    case .committed(_, let receipt):
      stamps = receipt.segments.map(\.stamp)
      outcome = ["kind": "committed", "scopes": .array(receipt.segments.map { $0.scope.json }),
                 "counts": .array(receipt.segments.map { JSON($0.localIds.count) }), "held": .bool(receipt.releaseAt != nil)]
      if vector.input["undo"] == true { _ = try runner.cancelHeld(receipt.gestureId) }
    case .unchanged: outcome = ["kind": "unchanged"]
    case .refused(let refusal): outcome = ["kind": "refused", "refusal": refusal.form]
    }
    let records = try vector.input.member("inspect").asArray().map { item in
      let scope = try ScopeRef(json: item.member("scope"))
      return JSON.array(try engine.drawn(scope, item.member("t").asString()).filter(\.isVisible).map { record in
        var result: JSON.Object = ["id": record.id.json, "title": record.values["title"] ?? .null]
        if item["detail"] == true {
          result["fields"] = .object(fields: record.values)
          result["life"] = record.life.map { .string($0.isAlive ? "alive" : "dead") } ?? .null
          result["bornSegment"] = JSON(stamps.firstIndex(of: record.born) ?? -1)
        }
        return .object(result)
      })
    }
    return ["outcome": outcome, "records": .array(records)]
  }

  struct VectorAct: ActAction {
    let vector: Vector
    func load(_ read: ActReader) throws -> Moment { read.moment }
    func decide(_ moment: Moment, ids: ActIDSource) throws(Violation) -> ActDecision<Void, ProbeRefusal> {
      do {
        let segments = try vector.input.member("segments").asArray().map { input in
          let scoped = Vector(file: vector.file, name: vector.name, input: input, expect: .null)
          return ScopedPlan(try scoped.scope, try Plans.build(scoped, at: moment))
        }
        return .write(ActPlan(segments), ())
      } catch let violation as Violation { throw violation }
      catch { preconditionFailure("invalid act vector: \(error)") }
    }
  }

  // §9.5 an act's decision as `ProductCorpus.act` gives it to a product's vectors (README, run/act-decisions.json), at the
  // probe's start in UTC where the case names no moment.
  static func actDecision(_ vector: Vector) throws -> JSON {
    var input = try vector.input.asObject()
    if input["now"] == nil { input["now"] = JSON(Probe.start.ms) }
    if input["offsetSeconds"] == nil { input["offsetSeconds"] = 0 }
    let scene = Vector(file: vector.file, name: vector.name, input: .object(input), expect: vector.expect)
    let corpus = ProductCorpus(RuleBook(registry: try vector.registry, entities: [], rules: []))
    return try corpus.act(DecidingAct(vector: scene), scene, result: { $0 }, refusal: \.form)
  }

  // Each scope of `loads` read for the ids it draws, which is the result; each segment built as in plan/translate.json,
  // an operation with `mint` taking the next id in its segment's scope.
  struct DecidingAct: ActAction {
    let vector: Vector

    func load(_ read: ActReader) throws -> (moment: Moment, drawn: JSON) {
      var drawn: JSON.Object = [:]
      for scope in try (vector.input["loads"]?.asArray() ?? []).map({ (scope: JSON) throws -> ScopeRef in try ScopeRef(json: scope) }) {
        drawn[scope.text] = try read.inScope(scope) { (reader: Reader) throws -> JSON in
          let types: [TypeDef] = reader.registry.types.filter { reader.registry.lives($0.name, in: scope) }
          return .array(try types.flatMap { (type: TypeDef) throws -> [JSON] in try reader.source.drawn(type.name).map(\.id.json) })
        }
      }
      return (read.moment, .object(drawn))
    }

    func decide(_ loaded: (moment: Moment, drawn: JSON), ids: ActIDSource) throws(Violation) -> ActDecision<JSON, ProbeRefusal> {
      do {
        let segments: [JSON] = try vector.input.member("segments").asArray()
        guard !segments.isEmpty else { return .unchanged(loaded.drawn) }
        let plans: [ScopedPlan] = try segments.map { (segment: JSON) throws -> ScopedPlan in
          let scope = try ScopeRef(json: segment.member("scope"))
          var input = try segment.asObject()
          input["plan"] = .array(try segment.member("plan").asArray().map { (operation: JSON) throws -> JSON in
            guard operation["mint"] == true else { return operation }
            var minted = try operation.asObject()
            minted["id"] = DecidingAct.mint(try probeEntity(operation.member("t").asString()), ids: ids, in: scope).json
            return .object(minted)
          })
          let built = Vector(file: vector.file, name: vector.name, input: .object(input), expect: .null)
          return ScopedPlan(scope, try Plans.build(built, at: loaded.moment))
        }
        return .write(ActPlan(plans), loaded.drawn)
      } catch let violation as Violation { throw violation }
      catch { preconditionFailure("invalid act decision vector: \(error)") }
    }

    static func mint<E: ProbeEntity>(_ type: E.Type, ids: ActIDSource, in scope: ScopeRef) -> RecordID {
      ids.mint(E.self, inScope: scope).record
    }
  }

  // §9.6 run/undo.json and §9.7 run/composed.json: an act opted into Undo, a composed act, a single action or a reversible
  // draft's save over the real engine and the model server, then its Undo, Redo and held-cancel steps; each result without
  // the ids the engine draws.
  static func engineAct(_ vector: Vector) throws -> JSON {
    let phone = Harness(registry: try vector.registry, start: Probe.start, rules: ProbeServerRules())
    let plans = { (segments: JSON) throws -> [ScopedPlan] in
      let moment = try phone.runner.moment()
      return try segments.asArray().map { (segment: JSON) throws -> ScopedPlan in try Plans.scoped(segment, of: vector, at: moment) }
    }
    for setup in try vector.input["before"]?.asArray() ?? [] {
      guard case .committed = try phone.runner.runAct(PlannedAct(plans: try plans(setup))) else { throw ContractError("\(vector) set up no act") }
      phone.sync()
    }
    let actId: String?
    let outcome: JSON
    do {
      if let parts = vector.input["parts"] {
        let moment = try phone.runner.moment()
        let actions: [AnyActAction<ProbeRefusal>] = try parts.asArray().map { (part: JSON) throws -> AnyActAction<ProbeRefusal> in
          AnyActAction(VectorPart(item: part, scope: try ScopeRef(json: part.member("scope")), vector: vector, moment: moment))
        }
        switch try phone.runner.runComposed(actions) {
        case .committed(_, let receipt):
          actId = receipt.gestureId
          outcome = Plans.form(receipt)
        case .unchanged:
          actId = nil
          outcome = ["kind": "unchanged"]
        case .refused(let part, let refusal):
          actId = nil
          outcome = ["kind": "refused", "part": JSON(part), "refusal": refusal.form]
        }
      } else if let save = vector.input["save"] {
        let saved = try Plans.save(try Drafts.draftable(save.member("t").asString()), save, on: phone)
        actId = saved.receipt?.gestureId
        outcome = saved.form
      } else if let reversible = vector.input["reversible"] {
        guard let segment = try plans(vector.input.member("segments")).first else { throw ContractError("a single action names one segment") }
        let ran = try phone.runner.run(PlannedAction(scope: segment.scope, plan: segment.plan, reversible: try reversible.asBool()))
        actId = ran.receipt?.gestureId
        outcome = ran.receipt.map { (receipt: CommitReceipt) -> JSON in ["kind": "committed", "count": JSON(receipt.localIds.count)] } ?? ["kind": "refused"]
      } else {
        let ran = try phone.runner.runAct(PlannedAct(plans: try plans(vector.input.member("segments"))))
        guard case .committed(_, let receipt) = ran else { return ["outcome": ["kind": "refused"]] }
        actId = receipt.gestureId
        outcome = Plans.form(receipt)
      }
    } catch is PlanError {
      return ["error": true]
    }
    var results: [JSON] = []
    var requestId: String?
    for step in try vector.input.member("steps").asArray() {
      switch try step.asString() {
      case "sync": phone.sync()
      case "read": results.append(Plans.form(try phone.runner.inverseResult(requestId ?? "")))
      case "cancel": results.append(["cancelled": .bool(try phone.runner.cancelHeld(actId ?? ""))])
      case let undoOrRedo:
        let result = undoOrRedo == "undo" ? try phone.runner.undo(actId ?? "") : try phone.runner.redo(requestId ?? "")
        if case .unavailable = result {} else { requestId = Plans.requestId(of: result) }
        results.append(Plans.form(result))
      }
    }
    let records: [JSON] = try vector.input.member("inspect").asArray().map { (item: JSON) throws -> JSON in
      let scope = try ScopeRef(json: item.member("scope"))
      let field = try item["field"]?.asString() ?? "title"
      let drawn = try phone.runner.read(scope) { (read: Reader) throws -> [JSON] in
        try Plans.drawn(try probeEntity(item.member("t").asString()), field: field, in: read)
      }
      return .array(drawn)
    }
    return ["outcome": outcome, "results": .array(results), "records": .array(records)]
  }

  // An act's committed outcome: the entries of each segment, and whether the act is held.
  static func form(_ receipt: ActReceipt) -> JSON {
    let counts: [JSON] = receipt.segments.map { (segment: ActSegmentReceipt) -> JSON in JSON(segment.localIds.count) }
    return ["kind": "committed", "counts": .array(counts), "held": .bool(receipt.releaseAt != nil)]
  }

  // A segment as the vector states it: its plan, and its Undo recipes, or, `undo` empty, named for evidence alone.
  static func scoped(_ segment: JSON, of vector: Vector, at moment: Moment) throws -> ScopedPlan {
    let scoped = Vector(file: vector.file, name: vector.name, input: segment, expect: .null)
    var plan = try Plans.build(scoped, at: moment)
    let recipes: [UndoRecipe] = try (segment["undo"]?.asArray() ?? []).map(Plans.undoRecipe)
    if !recipes.isEmpty { plan.undoRecipes += recipes } else if segment["undo"] != nil { plan.evidenceForUndo() }
    return ScopedPlan(try scoped.scope, plan)
  }

  // A composed act's part as the vector states it: a plan as given; `append`, which reads a record through the parts before
  // it and writes a field's value with a suffix, refusing when the record is gone; or `unchanged`.
  struct VectorPart: ActAction {
    let item: JSON
    let scope: ScopeRef
    let vector: Vector
    let moment: Moment

    func load(_ read: ActReader) throws -> JSON? {
      guard let append = item["append"] else { return nil }
      let type = try probeEntity(append.member("t").asString())
      let id = try RecordID(json: append.member("id"))
      let field = try append.member("field").asString()
      return try read.inScope(scope) { (reader: Reader) throws -> JSON? in try Plans.value(type, id, field: field, in: reader) }
    }

    func decide(_ found: JSON?, ids: ActIDSource) throws(Violation) -> ActDecision<Void, ProbeRefusal> {
      if item["unchanged"] == true { return .unchanged(()) }
      do {
        guard let append = item["append"] else { return .write(ActPlan([try Plans.scoped(item, of: vector, at: moment)]), ()) }
        let (type, id, field) = (try append.member("t").asString(), try append.member("id"), try append.member("field").asString())
        guard let found else {
          return .refuse(ProbeRefusal(Refused(.unknownRecord, subject: RecordRef(type: type, id: try RecordID(json: id)), path: .predicted)))
        }
        let written: JSON = .string(((try? found.asString()) ?? "") + (try append.member("suffix").asString()))
        var update = try item.asObject()
        update["append"] = nil
        update["plan"] = [["op": "update", "t": .string(type), "id": id, "f": .object([field: written]), "fields": [.string(field)]]]
        return .write(ActPlan([try Plans.scoped(.object(update), of: vector, at: moment)]), ())
      } catch let violation as Violation {
        throw violation
      } catch {
        preconditionFailure("invalid composed part: \(error)")
      }
    }
  }

  // A field of a record as `drawn` shows it, nil when the record is not there.
  static func value<E: ProbeEntity>(_ type: E.Type, _ id: RecordID, field: String, in read: Reader) throws -> JSON? {
    try read.repository(E.self).find(ID<E>(id), in: .drawn).map { (entity: E) -> JSON in entity.fields[field] ?? .null }
  }

  // Each record `drawn` lists as `{id, <field>}`.
  static func drawn<E: ProbeEntity>(_ type: E.Type, field: String, in read: Reader) throws -> [JSON] {
    try read.repository(E.self).all(in: .drawn).map { (entity: E) -> JSON in
      ["id": entity.id.record.json, field: entity.fields[field] ?? .null]
    }
  }

  // `save: {t, id, scope?, current}`: the record's draft opened on the phone, `current` edited over it and saved through
  // `ActionRunner.save`.
  static func save<E: ProbeEntity & Draftable>(_ type: E.Type, _ save: JSON, on phone: Harness) throws -> (receipt: CommitReceipt?, form: JSON) {
    let id = try RecordID(json: save.member("id"))
    let scope = try save["scope"].map { (scope: JSON) throws -> ScopeRef in try ScopeRef(json: scope) } ?? E.fixtureScope
    guard var draft = try phone.runner.open(ID<E>(id), in: scope) else { throw ContractError("a save opens a record the phone holds") }
    draft.current = try E.decoding(id, fields(save["current"]))
    switch phone.runner.save(&draft, in: scope, SaveDraft<E, ProbeRefusal>.self) {
    case .saved(let receipt): return (receipt, ["kind": "saved"])
    case .refused: return (nil, ["kind": "refused"])
    case .failed: return (nil, ["kind": "failed"])
    }
  }

  // An InverseResult without the ids the engine draws.
  static func form(_ result: InverseResult) -> JSON {
    guard case .object(var object) = result.json else { return result.json }
    object["requestId"] = nil
    object["inverseActId"] = nil
    return .object(object)
  }

  static func requestId(of result: InverseResult) -> String? {
    switch result {
    case .cancelled(let id, _, _), .pending(let id, _, _), .settled(let id, _, _, _, _): id
    case .unavailable(let id, _): id
    }
  }

  // An Undo recipe in the vector language: each target or record by type and id, in its own scope or its segment's.
  static func undoRecipe(_ json: JSON) throws -> UndoRecipe {
    let record = { (item: JSON) throws -> UndoRecord in
      try Plans.record(try probeEntity(item.member("t").asString()), try RecordID(json: item.member("id")),
                       scope: try item["scope"].map { (scope: JSON) throws -> ScopeRef in try ScopeRef(json: scope) })
    }
    let target = { (item: JSON) throws -> UndoTarget in
      UndoTarget(record: try record(item), slot: try EffectSlot.Slot(json: item.member("slot")))
    }
    switch try json.member("kind").asString() {
    case "fields":
      return .fields(restoreCommand: try json.member("restoreCommand").asString(),
                     targets: try json.member("targets").asArray().map { (item: JSON) throws -> (target: UndoTarget, default: JSON?) in
                       (try target(item), item["defaultValue"])
                     })
    case "createdRecord":
      return .createdRecord(restoreCommand: try json.member("restoreCommand").asString(), record: try record(json))
    default:
      let evidence = try json.member("evidence")
      return .command(try json.member("command").asString(), input: try json.member("input"),
                      ownedFields: try evidence.member("ownedFields").asArray().map(target),
                      unchangedCreatedRecords: try evidence.member("unchangedCreatedRecords").asArray().map(record),
                      unchangedCreatedScopes: try evidence.member("unchangedCreatedScopes").asArray().map { (scope: JSON) throws -> ScopeRef in
                        try ScopeRef(json: scope)
                      })
    }
  }

  static func record<E: ProbeEntity>(_ type: E.Type, _ id: RecordID, scope: ScopeRef?) -> UndoRecord {
    .of(ID<E>(id), in: scope)
  }

  // An act of the vector's plans, loading nothing.
  struct PlannedAct: ActAction {
    let plans: [ScopedPlan]
    func load(_ read: ActReader) throws {}
    func decide(_ loaded: Void, ids: ActIDSource) throws(Violation) -> ActDecision<Void, ProbeRefusal> { .write(ActPlan(plans), ()) }
  }

  // A single action writing the vector's plan, reversible as the vector says.
  struct PlannedAction: Action {
    let scope: ScopeRef
    let plan: Plan
    let reversible: Bool
    func load(_ read: Reader) throws {}
    func decide(_ loaded: Void, ids: IDSource) throws(Violation) -> Decision<Void, ProbeRefusal> { .write(plan) }
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
    case ProbeBranch.name: return try Plan(running: ProbeBranch(args: args), predicting: predictions)
    case let name: throw ContractError("no probe command \(name)")
    }
  }

  static func predictions(_ vector: Vector) throws -> [Prediction] {
    try (vector.input["predict"]?.asArray() ?? []).map { json in
      try prediction(try probeEntity(json.member("t").asString()), json)
    }
  }

  // `{op: "create" | "update" | "write", t, id, f, scope?}`, `scope` naming a scope other than the plan's.
  static func prediction<E: ProbeEntity>(_ type: E.Type, _ json: JSON) throws -> Prediction {
    let (id, values) = (ID<E>(try RecordID(json: json.member("id"))), try fields(json["f"]))
    let scope: ScopeRef? = try json["scope"].map { (scope: JSON) throws -> ScopeRef in try ScopeRef(json: scope) }
    switch try json.member("op").asString() {
    case "create": return .create(E.self, id, values, in: scope)
    case "write": return .write(E.self, id, values, in: scope)
    default: return .update(E.self, id, values, in: scope)
    }
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
    case "revive":
      let base = try operation["base"].map { try E.decoding(id, fields($0)) }
      plan.revive(try valid(E.self, id, operation, at: moment), fields: try names(operation.member("fields")), from: base,
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
      var opened = Draft(try E.decoding(id, fields(draft["base"])), in: E.fixtureScope, isNew: try draft.member("isNew").asBool(),
                         placement: try placement(draft["placement"]))
      opened.current = try E.decoding(id, fields(draft["current"]))
      save = SaveDraft(opened)
    } else {
      let creating = try vector.input.member("creating")
      save = SaveDraft(creating: try E.decoding(RecordID(json: creating.member("id")), fields(creating["f"])),
                       in: E.fixtureScope, placement: try placement(creating["placement"]))
    }
    let reader = VectorReader(records: try VectorRecords(drawn: vector.input["drawn"], stored: vector.input["stored"], registry: registry),
                              now: vector.moment.now.ms)
    let found = try save.load(Reader(reader, scope: E.fixtureScope, moment: vector.moment, registry: registry))
    let loaded = SaveDraftLoaded<E>(
      drawn: found.drawn, stored: found.stored, folded: found.folded, anchor: try recordID(vector.input["anchor"]), moment: found.moment,
      definition: found.definition, restoreCommand: found.restoreCommand, creationUndoable: found.creationUndoable)
    let decision = save.decision(loaded, ids: IDSource(context: reader))
    return ["decision": try decision.form(in: E.fixtureScope, registry: registry, result: \.form, refusal: \.form)]
  }

  // Runs the script's operations; a last step that expects a trap runs only when `trapping`, in its own process.
  static func script(_ vector: Vector, trapping: Bool) throws -> JSON {
    try script(try draftable(vector.string("t")), vector, trapping: trapping)
  }

  static func script<E: ProbeEntity & Draftable>(_ type: E.Type, _ vector: Vector, trapping: Bool) throws -> JSON {
    let registry = try vector.registry
    let replica = VectorReplica(try VectorRecords(drawn: vector.input["drawn"], stored: vector.input["stored"], registry: registry),
                                now: vector.moment.now.ms, registry: registry)
    let runner = ActionRunner(replica: replica, registry: registry, zone: vector.moment.zone)
    if case .object(let scopes)? = vector.input["scopes"] {
      for (scope, rows) in scopes.members {
        replica.scopes[try ScopeRef(scope)] = try VectorRecords(drawn: rows["drawn"], stored: rows["stored"], registry: registry)
      }
    }
    var remembered: [String: Draft<E>] = [:]
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
      let scope = try (operation["scope"] ?? vector.input["scope"]).map { try ScopeRef($0.asString()) } ?? E.fixtureScope
      switch try operation.member("op").asString() {
      case "new":
        let blank = try E.decoding(try id ?? missing("id"), [:])
        draft = Draft(blank, in: scope, isNew: true, placement: try placement(operation["placement"]))
      case "open":
        draft = try runner.open(ID<E>(try id ?? missing("id")), in: scope)
      case "openOrNew":
        let key = try id ?? missing("id")
        draft = try runner.open(ID<E>(key), in: scope, orNew: try E.decoding(try recordID(operation["blank"]) ?? key, [:]))
      case "edit":
        guard var edited = draft else { throw ContractError("an edit with no draft") }
        edited.current = try E.decoding(edited.id.record, edited.current.fields.merging(try fields(operation["f"])) { _, set in set })
        draft = edited
      case "save":
        guard var saving = draft else { throw ContractError("a save with no draft") }
        if let other = try recordID(operation["as"]) { saving.current = try E.decoding(other, saving.current.fields) }
        if operation["fail"] == true { replica.failNextCommit() }
        let committed = replica.gestures.count
        var result = form(runner.save(&saving, in: try operation["scope"].map { try ScopeRef($0.asString()) } ?? saving.scope, SaveDraft<E, ProbeRefusal>.self))
        if operation["gesture"] == true, case .object(var members) = result {
          members["gesture"] = replica.gestures.count > committed ? replica.gestures[committed].form : .null
          result = .object(members)
        }
        if vector.input["reportScope"] == true, case .object(var members) = result {
          members["scope"] = replica.commitScopes.count > committed ? .string(replica.commitScopes[committed].description) : .null
          result = .object(members)
        }
        step["result"] = result
        draft = saving
      case "rebase":
        guard let mine = draft else { throw ContractError("a rebase with no draft") }
        draft = mine.rebased(onto: try E.decoding(id ?? mine.id.record, fields(operation["f"])))
      case "load":
        guard let draft else { throw ContractError("a load with no draft") }
        _ = try runner.read(scope) { try SaveDraft<E, ProbeRefusal>(draft).load($0) }
      case "remember":
        remembered[try operation.member("name").asString()] = draft
      case "recall":
        draft = remembered[try operation.member("name").asString()]
      case "records":
        replica.records = try VectorRecords(drawn: operation["drawn"], stored: operation["stored"], registry: registry)
      case let op:
        throw ContractError("no script operation \(op)")
      }
      step["draft"] = draft?.form ?? .null
      if vector.input["reportScope"] == true, let draft, case .object(var members) = draft.form {
        members["scope"] = .string(draft.scope.description)
        step["draft"] = .object(members)
      }
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
