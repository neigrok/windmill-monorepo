import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A kind of the roadmap's legend: a hue, its words, and its place among the roadmap's kinds.
public struct RoadmapKind: Writable, Removable {
  public static let type = Roadmap.Types.kind
  public static let heldRemoval = false

  public let id: ID<RoadmapKind>
  public var hue: String
  public var label: String
  public var description: String
  public var ord: String?

  public init(id: ID<RoadmapKind>, hue: String = Roadmap.Defaults.Kind.hue, label: String = Roadmap.Defaults.Kind.label,
              description: String = Roadmap.Defaults.Kind.description, ord: String? = nil) {
    self.id = id
    self.hue = hue
    self.label = label
    self.description = description
    self.ord = ord
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), hue: try r.string("hue", default: Roadmap.Defaults.Kind.hue), label: try r.string("label", default: Roadmap.Defaults.Kind.label),
              description: try r.string("description", default: Roadmap.Defaults.Kind.description), ord: try r.optionalString("ord"))
  }

  public var fields: [String: JSON] {
    ["hue": .string(hue), "label": .string(label), "description": .string(description), "ord": .of(ord)]
  }

  public static let checks: [Check<RoadmapKind>] = [
    Check("hue") { k, _ in k.hue = try RoadmapSpecs.hue.apply(k.hue, at: "hue") },
    Check("label") { k, _ in k.label = try RoadmapSpecs.kindLabel.apply(k.label, at: "label") },
    Check("description") { k, _ in k.description = try RoadmapSpecs.kindDescription.apply(k.description, at: "description") },
  ]

  // §4 a hue another present kind wears is refused where a kind is made or changed.
  func checkHueUnworn(among present: [RoadmapKind]) throws(Violation) {
    guard present.contains(where: { $0.id != id && $0.hue.utf8.elementsEqual(hue.utf8) }) else { return }
    throw Violation(rule: RoadmapChecks.wornHue, path: "hue", reason: .custom("worn"))
  }

  // Its place among the roadmap's kinds, where it holds one that orders.
  var key: FractionalKey? { ord.flatMap { try? FractionalKey($0) } }
}

// A kind as a person words it before it has an id: the hue it wears and what it calls it.
public struct NewKind: Sendable {
  public let hue: String
  public let label: String
  public let description: String

  public init(hue: String, label: String = Roadmap.Defaults.Kind.label, description: String = Roadmap.Defaults.Kind.description) {
    self.hue = hue
    self.label = label
    self.description = description
  }
}

// The roadmap's kinds as one reader holds them: what the device holds of the named kind (§5), and the present ones.
public struct HeldKinds: Sendable {
  public let held: HeldRecord<RoadmapKind>
  public let present: [RoadmapKind]
  public let moment: Moment

  init(_ kind: ID<RoadmapKind>, in read: Reader) throws {
    let kinds = read.repository(RoadmapKind.self)
    held = try HeldRecord(RoadmapKind(id: kind), in: kinds)
    present = try kinds.all(in: .drawn)
    moment = read.moment
  }

  // §5 A change to a kind carries its life as alive, as a step's does, whether the device still holds the kind or knows it
  // only by its spent id; a change that changes nothing writes nothing.
  func changing(to valid: Valid<RoadmapKind>, in tree: ID<RoadmapEntry>) -> ActDecision<Void, RoadmapRefusal> {
    let changed = held.changed(by: valid)
    guard !changed.isEmpty else { return .unchanged(()) }
    return .write(held.reviving(valid, fields: changed), in: tree.tree, ())
  }
}

// A new kind, after the roadmap's kinds, wearing a hue no present kind wears.
public struct CreateKind: ActAction {
  public typealias Loaded = (present: [RoadmapKind], capacity: Capacity, moment: Moment)

  public let tree: ID<RoadmapEntry>
  public let kind: NewKind

  public init(tree: ID<RoadmapEntry>, kind: NewKind) {
    self.tree = tree
    self.kind = kind
  }

  public func load(_ read: ActReader) throws -> Loaded {
    try read.inScope(tree.tree) { (scope: Reader) throws -> Loaded in
      let kinds = scope.repository(RoadmapKind.self)
      return (try kinds.all(in: .drawn), try kinds.capacity(), scope.moment)
    }
  }

  public func decide(_ loaded: Loaded, ids: ActIDSource) throws(Violation) -> ActDecision<ID<RoadmapKind>, RoadmapRefusal> {
    let id = ids.mint(RoadmapKind.self, inScope: tree.tree)
    let ord = FractionalKey(after: loaded.present.compactMap(\.key).max())
    let made = try Valid(RoadmapKind(id: id, hue: kind.hue, label: kind.label, description: kind.description, ord: ord.text), at: loaded.moment)
    try made.value.checkHueUnworn(among: loaded.present)
    if let full = loaded.capacity.refusal(growing: 1, subject: id.ref) { return .refuse(RoadmapRefusal(full)) }
    var plan = Plan()
    plan.create(made)
    plan.undoBy(.createdRecord(restoreCommand: Roadmap.Commands.restoreTree, record: .of(id)))
    return .write(plan, in: tree.tree, id)
  }
}

// A kind's words, changed.
public struct ChangeKind: ActAction {
  public let tree: ID<RoadmapEntry>
  public let kind: ID<RoadmapKind>
  public let label: String?
  public let description: String?

  public init(tree: ID<RoadmapEntry>, kind: ID<RoadmapKind>, label: String? = nil, description: String? = nil) {
    self.tree = tree
    self.kind = kind
    self.label = label
    self.description = description
  }

  public func load(_ read: ActReader) throws -> HeldKinds {
    try read.inScope(tree.tree) { (scope: Reader) throws -> HeldKinds in try HeldKinds(kind, in: scope) }
  }

  public func decide(_ loaded: HeldKinds, ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    guard loaded.held.isKnown else { return .refuse(.gone(kind.ref, .predicted)) }
    var changed = loaded.held.value
    var named: [String] = []
    if let label {
      changed.label = label
      named.append("label")
    }
    if let description {
      changed.description = description
      named.append("description")
    }
    return loaded.changing(to: try Valid(changed, fields: named, at: loaded.moment), in: tree)
  }
}

// A kind moved below another of the roadmap's kinds, or to their top. A drop in place writes nothing.
public struct MoveKind: ActAction {
  public let tree: ID<RoadmapEntry>
  public let kind: ID<RoadmapKind>
  public let below: ID<RoadmapKind>?

  public init(tree: ID<RoadmapEntry>, kind: ID<RoadmapKind>, below: ID<RoadmapKind>?) {
    self.tree = tree
    self.kind = kind
    self.below = below
  }

  public func load(_ read: ActReader) throws -> HeldKinds {
    try read.inScope(tree.tree) { (scope: Reader) throws -> HeldKinds in try HeldKinds(kind, in: scope) }
  }

  public func decide(_ loaded: HeldKinds, ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    guard loaded.held.isKnown else { return .refuse(.gone(kind.ref, .predicted)) }
    let members = loaded.present.filter { $0.id != kind }.compactMap { (other: RoadmapKind) -> ListMember? in
      other.key.map { ListMember(id: other.id.json, key: $0) }
    }.sorted()
    if let below, !members.contains(where: { $0.id == below.json }) { return .refuse(.gone(below.ref, .predicted)) }
    var moved = loaded.held.value
    if let own = moved.key {
      let above = members.last { $0 < ListMember(id: kind.json, key: own) }
      if above?.id == below?.json { return .unchanged(()) }
    }
    moved.ord = FractionalKey(dropping: kind.json, below: below?.json, among: members).text
    return loaded.changing(to: try Valid(moved, fields: ["ord"], at: loaded.moment), in: tree)
  }
}

// §4 `roadmap.recolourKind {kind, hue}`, run in the roadmap's tree.
public struct RecolourKindCommand: ServerCommand {
  public static let name = Roadmap.Commands.recolourKind
  public static let specs: [any ValueSpec] = [RoadmapSpecs.recolourHue]
  public let args: [String: JSON]

  public init(kind: ID<RoadmapKind>, hue: String) {
    args = ["kind": kind.json, "hue": .string(hue)]
  }
}

// §4 `roadmap.recolourKind`: the kind's hue and the colour of every step the device holds that wears it, present or not,
// predicted so the legend and the steps change at once. A kind this device holds as deleted, or knows only by its spent
// id, is revived first, as every change to a kind carries its life; the command revives no step. Of a kind known only by
// its spent id the device knows no hue, so it predicts the kind's new hue alone, the server recolours the steps that wore
// the old one, and an Undo deletes the kind again.
public struct RecolourKind: ActAction {
  public let tree: ID<RoadmapEntry>
  public let kind: ID<RoadmapKind>
  public let hue: String

  public init(tree: ID<RoadmapEntry>, kind: ID<RoadmapKind>, hue: String) {
    self.tree = tree
    self.kind = kind
    self.hue = hue
  }

  public func load(_ read: ActReader) throws -> (kinds: HeldKinds, steps: [RoadmapStep]) {
    try read.inScope(tree.tree) { (scope: Reader) throws -> (kinds: HeldKinds, steps: [RoadmapStep]) in
      let held = try scope.repository(RoadmapStep.self).records(in: .drawn)
      return (try HeldKinds(kind, in: scope), try held.map { (record: Record) throws -> RoadmapStep in try RoadmapStep(Fields(record)) })
    }
  }

  public func decide(_ loaded: (kinds: HeldKinds, steps: [RoadmapStep]), ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    let held = loaded.kinds.held
    guard held.isKnown else { return .refuse(.gone(kind.ref, .predicted)) }
    var worn = held.value
    worn.hue = hue
    let recoloured = try Valid(worn, fields: ["hue"], at: loaded.kinds.moment)
    let chosen = recoloured.value.hue
    try recoloured.value.checkHueUnworn(among: loaded.kinds.present)
    guard !held.changed(by: recoloured).isEmpty else { return .unchanged(()) }
    let wearers = held.holdsValues ? loaded.steps.filter { $0.color.utf8.elementsEqual(held.value.hue.utf8) } : []
    var predicted = [Prediction.update(RoadmapKind.self, kind, ["hue": .string(chosen)])]
    for step in wearers { predicted.append(.update(RoadmapStep.self, step.id, ["color": .string(chosen)])) }
    var recolour = try Plan(running: RecolourKindCommand(kind: kind, hue: chosen), predicting: predicted)
    if held.holdsValues {
      var restored = [UndoTarget.restored(kind, "hue")]
      for step in wearers { restored.append(UndoTarget.restored(step.id, "color")) }
      recolour.undoBy(.fields(restoreCommand: Roadmap.Commands.restoreTree, targets: restored))
    }
    let command = ScopedPlan(tree.tree, recolour)
    guard held.isAbsent else { return .write(ActPlan([command]), ()) }
    let revival = held.reviving(try Valid(held.value, fields: [], at: loaded.kinds.moment), fields: [])
    return .write(ActPlan([ScopedPlan(tree.tree, revival), command]), ())
  }
}

// A kind's death, which an Undo writes back.
public struct DeleteKind: ActAction {
  public let tree: ID<RoadmapEntry>
  public let kind: ID<RoadmapKind>

  public init(tree: ID<RoadmapEntry>, kind: ID<RoadmapKind>) {
    self.tree = tree
    self.kind = kind
  }

  public func load(_ read: ActReader) throws -> RoadmapKind? {
    try read.inScope(tree.tree) { (scope: Reader) throws -> RoadmapKind? in try scope.repository(RoadmapKind.self).find(kind, in: .drawn) }
  }

  public func decide(_ drawn: RoadmapKind?, ids: ActIDSource) -> ActDecision<Void, RoadmapRefusal> {
    guard drawn != nil else { return .unchanged(()) }
    var plan = Plan()
    plan.remove(kind)
    plan.undoBy(.restoring(kind, life: true, by: Roadmap.Commands.restoreTree))
    return .write(plan, in: tree.tree, ())
  }
}
