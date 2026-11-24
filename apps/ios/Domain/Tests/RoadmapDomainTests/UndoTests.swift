import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// K-3, undo.json: each scene played on the kit's harness over the model server with roadmap's rules, its acts and a note's
// draft saves, then their Undo and Redo, outcome for outcome as the corpus README's Undo section states them.
struct UndoTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/undo.json"))
  func scene(_ vector: Vector) throws {
    var scene = UndoScene()
    let outcomes = try scene.play(try vector.input.member("steps").asArray())
    #expect(outcomes == vector.expect, "\(vector)\n  got    \(outcomes.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}

// A scene's phones, `a` first, and the roles its steps name, in the order they were first named: what each act or save was
// given and answered, the act its Undo names, and the request of its latest Undo or Redo, which a Redo and a read name.
struct UndoScene {
  struct Role {
    let input: JSON
    let result: JSON
    let actId: String?
    var requestId: String?
  }

  var phones = ["a": RoadmapsTests.phone()]
  var roles: [(name: String, role: Role)] = []

  mutating func play(_ steps: [JSON]) throws -> JSON {
    var outcomes: [JSON] = []
    for step in steps {
      if let device = step["device"] {
        phones[try device.asString()] = try phone("a").device()
        continue
      }
      if let outcome = try play(step, on: try phone(try step["on"]?.asString() ?? "a")) { outcomes.append(outcome) }
    }
    return ["outcomes": .array(outcomes)]
  }

  // One step's outcome, nil for a sync or a move of the clock.
  mutating func play(_ step: JSON, on phone: Harness) throws -> JSON? {
    if let action = step["run"] {
      let input = try bound(step.member("input"))
      let (outcome, result, actId): (JSON, JSON, String?) = switch try RoadmapAct(try action.asString(), input).run(phone.runner) {
      case .committed(let result, let receipt): ("committed", result, receipt.gestureId)
      case .unchanged(let result): ("unchanged", result, nil)
      case .refused(let refusal): (["refused": refusal.form], .null, nil)
      }
      try remember(step, Role(input: input, result: result, actId: actId))
      return outcome
    }
    if let saved = step["save"] {
      guard saved == "StepNote" else { throw ContractError("no draft \(saved) to save") }
      let input = try bound(step.member("input"))
      let (tree, note): (ID<RoadmapEntry>, ID<StepNote>) = (try input.id("tree"), try input.id("step"))
      var draft = try phone.runner.open(note, in: tree.overlay, orNew: StepNote(id: note))
      draft.current.text = try input.member("text").asString()
      let (outcome, actId): (JSON, String?) = switch phone.runner.save(&draft, in: tree.overlay, SaveStepNote.self) {
      case .saved(let receipt): ("saved", receipt?.gestureId)
      case .refused: ("refused", nil)
      case .failed: ("failed", nil)
      }
      try remember(step, Role(input: input, result: .null, actId: actId))
      return outcome
    }
    if step["sync"] == true {
      try self.phone("a").sync()
      return nil
    }
    if let ms = step["advance"] {
      try self.phone("a").advance(ms: try ms.asInteger())
      return nil
    }
    if let name = step["undo"] {
      let (index, role) = try self.role(name)
      guard let actId = role.actId else { throw ContractError("\(name) committed no act") }
      let undone = try phone.runner.undo(actId)
      roles[index].role.requestId = undone.requestId ?? role.requestId
      return undone.form
    }
    if let name = step["redo"] {
      let (index, role) = try self.role(name)
      guard let requestId = role.requestId else { throw ContractError("\(name) was not undone") }
      let slots = step["subtree"] == true ? try Self.subtreeRedo(of: role, under: phone.runner.mint(RoadmapEntry.self)) : nil
      let redone = try phone.runner.redo(requestId, productSlots: slots)
      roles[index].role.requestId = redone.requestId ?? role.requestId
      return redone.form
    }
    if let name = step["read"] {
      guard let requestId = try self.role(name).role.requestId else { throw ContractError("\(name) was not undone") }
      return try phone.runner.inverseResult(requestId).form
    }
    if let name = step["cancelHeld"] {
      guard let actId = try self.role(name).role.actId else { throw ContractError("\(name) committed no act") }
      return ["cancelHeld": .bool(try phone.runner.cancelHeld(actId))]
    }
    if let inspect = step["inspect"] {
      let type = try inspect.member("t").asString()
      let fields = try inspect.member("fields").asArray().map { try $0.asString() }
      let records = try phone.runner.read(try ScopeRef(try bound(inspect.member("scope")).asString())) { try $0.records(in: .drawn) }
      let rows = records.filter { $0.isVisible && $0.type.utf8.elementsEqual(type.utf8) }.map { (record: Record) -> JSON in
        .object(JSON.Object(uniqueKeysWithValues: fields.map { (name: String) -> (String, JSON) in
          (name, name == "id" ? record.id.json : record.values[name] ?? record.texts[name].map { .string($0.text) } ?? .null)
        }))
      }
      return [type: .array(rows.map(named).sorted { $0.jcsPrecedes($1) })]
    }
    throw ContractError("no scene step \(step.jcsText)")
  }

  func phone(_ name: String) throws -> Harness {
    guard let phone = phones[name] else { throw ContractError("no phone \(name) in the scene") }
    return phone
  }

  func role(_ name: JSON) throws -> (index: Int, role: Role) {
    let name = try name.asString()
    guard let index = roles.firstIndex(where: { $0.name.utf8.elementsEqual(name.utf8) }) else { throw ContractError("no scene role \(name)") }
    return (index, roles[index].role)
  }

  // A role keeps the place it was first named in.
  mutating func remember(_ step: JSON, _ role: Role) throws {
    guard let name = try step["as"]?.asString() else { return }
    guard let index = roles.firstIndex(where: { $0.name.utf8.elementsEqual(name.utf8) }) else {
      roles.append((name, role))
      return
    }
    roles[index].role = role
  }

  // An input with each `$role` or `$role.path` it names replaced by that role's result, or the part of it the path names; a
  // name inside a longer text, as in a scope, by that text.
  func bound(_ value: JSON) throws -> JSON {
    switch value {
    case .array(let items): return .array(try items.map(bound))
    case .object(let object): return .object(JSON.Object(uniqueKeysWithValues: try object.members.map { ($0.key, try bound($0.value)) }))
    case .string(let text) where text.contains("$"):
      if let whole = text.wholeMatch(of: /\$([\w.]+)/) { return try lookup(String(whole.1)) }
      var replaced = ""
      var rest = text[...]
      for match in text.matches(of: /\$([\w.]+)/) {
        replaced += text[rest.startIndex..<match.range.lowerBound]
        replaced += try lookup(String(match.1)).asString()
        rest = text[match.range.upperBound...]
      }
      return .string(replaced + rest)
    default: return value
    }
  }

  func lookup(_ path: String) throws -> JSON {
    let keys = path.split(separator: ".").map(String.init)
    var found = try role(.string(keys[0])).role.result
    for key in keys.dropFirst() {
      guard let member = found[key] else { throw ContractError("$\(path) names nothing") }
      found = member
    }
    return found
  }

  // What a scene reads back, each id named by the first role holding it, any other minted id `<new>`.
  func named(_ value: JSON) -> JSON {
    var known: [(id: String, path: String)] = []
    func walk(_ found: JSON, _ path: String) {
      switch found {
      case .string(let text) where !known.contains(where: { $0.id.utf8.elementsEqual(text.utf8) }): known.append((text, path))
      case .array(let items): for (index, item) in items.enumerated() { walk(item, "\(path).\(index)") }
      case .object(let object): for member in object.members { walk(member.value, "\(path).\(member.key)") }
      default: break
      }
    }
    for (name, role) in roles { walk(role.result, "$\(name)") }
    func rename(_ item: JSON) -> JSON {
      switch item {
      case .string(let text):
        if let path = known.first(where: { $0.id.utf8.elementsEqual(text.utf8) })?.path { return .string(path) }
        return text.wholeMatch(of: /t_[0-9a-f]{16}|[0-9a-z]{16}/) == nil ? item : "<new>"
      case .array(let items): return .array(items.map(rename))
      case .object(let object): return .object(JSON.Object(uniqueKeysWithValues: object.members.map { ($0.key, rename($0.value)) }))
      default: return item
      }
    }
    return rename(value)
  }

  // R-8: a Redo of a subtree's creation plants a fresh one, by the product's slots.
  static func subtreeRedo(of role: Role, under fresh: ID<RoadmapEntry>) throws -> [ProductSlot] {
    let creation = CreateSubtree(tree: try role.input.id("tree"), step: try role.input.id("step"))
    return creation.redo((root: try role.result.id("root"), revived: try role.result.member("revived").asBool()), under: fresh)
  }
}

extension InverseResult {
  // The result without its ids.
  var form: JSON {
    switch self {
    case .cancelled(_, _, let changed): ["kind": "cancelled", "changed": .bool(changed)]
    case .pending(_, _, let localChanged): ["kind": "pending", "localChanged": .bool(localChanged)]
    case .settled(_, _, let changed, let applied, let skipped):
      ["kind": "settled", "changed": .bool(changed), "appliedCount": JSON(applied), "skippedCount": JSON(skipped)]
    case .unavailable(_, let reason): ["kind": "unavailable", "reason": .string(reason)]
    }
  }

  // The request a Redo or a read names, none for an inverse that is unavailable.
  var requestId: String? {
    switch self {
    case .cancelled(let id, _, _), .pending(let id, _, _), .settled(let id, _, _, _, _): id
    case .unavailable: nil
    }
  }
}
