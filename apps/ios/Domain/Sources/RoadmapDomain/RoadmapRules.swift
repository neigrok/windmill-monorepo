import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// Roadmap's rules as every surface shares them: what a person may write, the limits a gesture is refused at where it is made,
// the legend a new roadmap starts with, and the rule book over them, pinned by packages/api-contract/roadmap/domain/rules.json.
public enum RoadmapRules {
  public static let hues = ["terracotta", "olive", "gold", "brick", "sky", "plum"]

  public static let genesisKinds = [
    RoadmapKind(id: ID("build"), hue: "terracotta", label: "Build", description: "Things you make", ord: "a0"),
    RoadmapKind(id: ID("learn"), hue: "olive", label: "Learn", description: "Things you figure out", ord: "a1"),
    RoadmapKind(id: ID("milestone"), hue: "gold", label: "Milestone", description: "Moments that matter", ord: "a2"),
  ]

  public static let book = RuleBook(
    registry: SyncSchema.registry,
    entities: [RoadmapEntry.self, RoadmapMeta.self, RoadmapStep.self, RoadmapLink.self, RoadmapKind.self, StepMark.self, StepPointer.self,
               Subtask.self, WorkspaceLink.self, StepNote.self],
    rules: RoadmapSpecs.all.map { .local($0) } + [
      .local(RoadmapChecks.cycle, subject: RoadmapLink.type),
      .local(RoadmapChecks.wornHue, subject: RoadmapKind.type),
      .local(RoadmapChecks.opening, subject: StepMark.type),
      .serverDecided("tree.root", codes: [Roadmap.Codes.notARoot], subject: RoadmapEntry.type),
      .serverDecided("tree.alive", codes: [.scopeDead], subject: RoadmapEntry.type),
      .serverDecided("tree.reach", codes: [.forbidden, .notFound], subject: RoadmapEntry.type),
      .serverDecided("tree.subtreeStep", codes: [Roadmap.Codes.stepOpensATree], subject: RoadmapStep.type),
      .serverDecided("tree.depth", codes: [Roadmap.Codes.depthLimit], subject: RoadmapEntry.type),
    ])
}

public enum RoadmapLimits {
  // An import commits at most this many records an intent, and half the engine's push limit in their JCS bytes.
  public static let importChunk = 500
  public static let importChunkBytes = Constants.pushMaxBytes / 2
  public static let maxDepth = 8
}

// Roadmap measures a text in characters as it was typed: never composed, and trimmed only where a blank one is refused.
extension TextSpec {
  fileprivate init(_ path: String, chars max: Int, min: Int = 0, trim: Bool = false) {
    self.init(path, unit: .chars, min: min, max: max, trim: trim, nfc: false)
  }
}

public enum RoadmapSpecs {
  public static let title = TextSpec("meta.title", chars: 200)
  public static let guide = TextSpec("meta.guide", chars: 5000)
  public static let visibility = ChoiceSpec("meta.visibility", values: ["private", "unlisted", "public"])
  public static let label = TextSpec("node.label", chars: 200)
  public static let icon = TextSpec("node.icon", chars: 64)
  public static let color = ChoiceSpec("node.color", values: RoadmapRules.hues)
  public static let description = TextSpec("node.description", chars: 16000)
  public static let links = CountSpec("node.links", min: 0, max: 32)
  public static let linkUrl = TextSpec("node.links.url", chars: 2048, min: 1, trim: true)
  public static let linkLabel = TextSpec("node.links.label", chars: 200)
  public static let hue = ChoiceSpec("kind.hue", values: RoadmapRules.hues)
  public static let recolourHue = ChoiceSpec("roadmap.recolourKind.hue", values: RoadmapRules.hues)
  public static let kindLabel = TextSpec("kind.label", chars: 24)
  public static let kindDescription = TextSpec("kind.description", chars: 80)
  public static let mark = ChoiceSpec("progress.mark.status", values: ["complete", "none"])
  public static let subtask = TextSpec("subtask.label", chars: 200, min: 1, trim: true)
  public static let url = TextSpec("stepLink.url", chars: 2048, min: 1, trim: true)
  public static let linkTitle = TextSpec("stepLink.title", chars: 200, trim: true)
  public static let note = TextSpec("stepNote.text", chars: 16000)

  static let all: [any ValueSpec] = [title, guide, visibility, label, icon, color, description, links, linkUrl, linkLabel, hue, recolourHue,
                                     kindLabel, kindDescription, mark, subtask, url, linkTitle, note]
}

// The rules a gesture checks over the records it reads, named as their violations name them.
public enum RoadmapChecks {
  public static let cycle = "edge.cycle"
  public static let wornHue = "kind.hue.worn"
  public static let opening = "progress.opening"
}

// Roadmap's one refusal: every code its rules declare, mapped from the code, the subject, the path and a cap's detail.
public enum RoadmapRefusal: ProductRefusal, Equatable {
  case invalid(Violation)
  case gone(RecordRef, Refused.Path)
  case taken(RecordRef, Refused.Path)
  case tooLarge(RecordRef, Refused.Path)
  case full(type: String, cap: Int, Refused.Path)
  case roadmapGone(Refused)
  case unreachable(Refused)
  case notARoot(Refused)
  case stepOpensARoadmap(Refused)
  case depthLimit(Refused)
  case other(Refused)

  public init(_ violation: Violation) {
    self = .invalid(violation)
  }

  public init(_ refused: Refused) {
    switch (refused.code, refused.subject, refused.cap) {
    case (.unknownRecord, let subject?, _), (.recordDead, let subject?, _): self = .gone(subject, refused.path)
    case (.idTaken, let subject?, _), (.idSpent, let subject?, _): self = .taken(subject, refused.path)
    case (.tooLarge, let subject?, _): self = .tooLarge(subject, refused.path)
    case (_, _, let cap?): self = .full(type: cap.type, cap: cap.cap, refused.path)
    case (.scopeDead, _, _): self = .roadmapGone(refused)
    case (.forbidden, _, _), (.notFound, _, _): self = .unreachable(refused)
    case (Roadmap.Codes.notARoot, _, _): self = .notARoot(refused)
    case (Roadmap.Codes.stepOpensATree, _, _): self = .stepOpensARoadmap(refused)
    case (Roadmap.Codes.depthLimit, _, _): self = .depthLimit(refused)
    default: self = .other(refused)
    }
  }

  public var isGeneric: Bool {
    guard case .other = self else { return false }
    return true
  }
}

extension Violation {
  // The violation of one item among those a gesture brings, named by the item's place.
  func at(_ place: Path) -> Violation {
    Violation(rule: rule, path: place + path.text, reason: reason)
  }
}

extension ActDecision {
  // An act that writes one scope.
  static func write(_ plan: Plan, in scope: ScopeRef, _ result: Result) -> ActDecision {
    .write(ActPlan([ScopedPlan(scope, plan)]), result)
  }
}

extension UndoTarget {
  // K-3 a field an Undo writes back to its value before the act. A field unset then takes the value the registry reads an
  // unset register as; `ord` has none, as every create writes it.
  static func restored<E: Entity>(_ id: ID<E>, _ name: String, in scope: ScopeRef? = nil) -> (target: UndoTarget, default: JSON?) {
    (.field(id, name, in: scope), SyncSchema.registry.type(E.type)?.field(name)?.defaultValue)
  }
}

extension UndoRecipe {
  // An Undo that writes back the named fields of one record, and its life where `life` says so.
  static func restoring<E: Entity>(_ id: ID<E>, fields names: [String] = [], life: Bool = false, by restoreCommand: String) -> UndoRecipe {
    var targets = names.map { (name: String) -> (target: UndoTarget, default: JSON?) in UndoTarget.restored(id, name) }
    if life { targets.append((.life(id), nil)) }
    return .fields(restoreCommand: restoreCommand, targets: targets)
  }
}

// What this device holds of one step or kind (§5): the record it draws, present or deleted; where another device's delete
// left it no row, only the record's spent id (engine §7.5), so that it knows the record was and nothing of its values; or
// nothing, for a record it never knew. A change carries the record's life, so a record the device knows comes back with it,
// and one it never knew is gone. `value` is the record's values, or the blank where the device holds none.
public struct HeldRecord<E: Writable>: Sendable {
  public enum State: Sendable {
    case present, deleted, spent, unknown
  }

  public let value: E
  public let state: State

  init(_ blank: E, in repository: Repository<E>) throws {
    guard let record = try repository.record(blank.id, in: .drawn) else {
      value = blank
      state = try repository.spentBorn(blank.id) == nil ? .unknown : .spent
      return
    }
    value = try E(Fields(record))
    state = record.life?.isAlive == true ? .present : .deleted
  }

  public var isKnown: Bool { state != .unknown }
  public var isAbsent: Bool { state == .deleted || state == .spent }
  public var holdsValues: Bool { state == .present || state == .deleted }

  // The fields a change writes: each it names whose value differs from the record's, or each it names where the device
  // holds no values to compare.
  func changed(by valid: Valid<E>) -> [String] {
    guard holdsValues else { return valid.checked }
    let (before, after) = (value.fields, valid.value.fields)
    return valid.checked.filter { before[$0] != after[$0] }
  }

  // The revival a change plans: the record's life under the gesture's stamp and the fields it writes, and its Undo, which
  // writes each field back to the value it held and the life where the change brought the record back. A record known only
  // by its spent id was dead and its values are the server's alone, so its Undo deletes it again and keeps what the change
  // wrote. A record that held no `ord` has none to write back.
  func reviving(_ valid: Valid<E>, fields: [String]) -> Plan {
    var plan = Plan()
    plan.revive(valid, fields: fields)
    guard holdsValues else {
      plan.undoBy(.fields(restoreCommand: Roadmap.Commands.restoreTree, targets: [(target: .life(value.id), default: "dead")]))
      return plan
    }
    let restorable = fields.filter { $0 != "ord" || value.fields["ord"]?.isNull == false }
    if !restorable.isEmpty || isAbsent {
      plan.undoBy(.restoring(value.id, fields: restorable, life: isAbsent, by: Roadmap.Commands.restoreTree))
    }
    return plan
  }
}
