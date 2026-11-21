import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

extension Step.Link: ValueObject {
  public init(_ f: Fields) throws(DecodeError) {
    self.init(url: try f.string("url"), label: try f.string("label"))
  }

  public var json: JSON { ["url": .string(url), "label": .string(label)] }

  public func validated(at path: Path) throws(Violation) -> Step.Link {
    Step.Link(url: try RoadmapSpecs.linkUrl.apply(url, at: path + "url"), label: try RoadmapSpecs.linkLabel.apply(label, at: path + "label"))
  }
}

// A step: a `node` record of a roadmap's tree scope. `ord` is its place among its trunk parent's steps, computed in the
// domain and written as a plain field, so a reorder carries the step's life like every other change. Its authored status
// and the subtree it owns are read, never written here.
public struct RoadmapStep: Writable, Removable {
  public static let type = Roadmap.Types.node
  public static let heldRemoval = true

  // What a gesture names of a step: a change writes each field it names, and a new step takes each over the registry's
  // default.
  public struct Changes: Sendable {
    public var label: String?
    public var icon: String?
    public var color: String?
    public var description: String?
    public var links: [Step.Link]?

    public init(label: String? = nil, icon: String? = nil, color: String? = nil, description: String? = nil, links: [Step.Link]? = nil) {
      self.label = label
      self.icon = icon
      self.color = color
      self.description = description
      self.links = links
    }
  }

  public let id: ID<RoadmapStep>
  public var label: String
  public var icon: String
  public var color: String
  public var ord: String?
  public var description: String
  public var links: [Step.Link]
  public let status: String?
  public let branch: ID<RoadmapEntry>?

  public init(id: ID<RoadmapStep>, label: String = Roadmap.Defaults.Node.label, icon: String = Roadmap.Defaults.Node.icon,
              color: String = Roadmap.Defaults.Node.color, ord: String? = nil, description: String = Roadmap.Defaults.Node.description,
              links: [Step.Link] = [], status: String? = nil, branch: ID<RoadmapEntry>? = nil) {
    self.id = id
    self.label = label
    self.icon = icon
    self.color = color
    self.ord = ord
    self.description = description
    self.links = links
    self.status = status
    self.branch = branch
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), label: try r.string("label", default: Roadmap.Defaults.Node.label), icon: try r.string("icon", default: Roadmap.Defaults.Node.icon),
              color: try r.string("color", default: Roadmap.Defaults.Node.color), ord: try r.optionalString("ord"),
              description: try r.string("description", default: Roadmap.Defaults.Node.description),
              links: try r.optionalList("links", of: Step.Link.self) ?? [], status: try r.optionalString("status"),
              branch: try r.optionalRef("branch", RoadmapEntry.self))
  }

  public var fields: [String: JSON] {
    ["label": .string(label), "icon": .string(icon), "color": .string(color), "ord": .of(ord), "description": .string(description),
     "links": .array(links.map(\.json))]
  }

  public static let checks: [Check<RoadmapStep>] = [
    Check("label") { s, _ in s.label = try RoadmapSpecs.label.apply(s.label, at: "label") },
    Check("icon") { s, _ in s.icon = try RoadmapSpecs.icon.apply(s.icon, at: "icon") },
    Check("color") { s, _ in s.color = try RoadmapSpecs.color.apply(s.color, at: "color") },
    Check("description") { s, _ in s.description = try RoadmapSpecs.description.apply(s.description, at: "description") },
    Check("links") { s, _ in s.links = try RoadmapSpecs.links.apply(s.links, at: "links") },
  ]

  // Its place among its trunk parent's steps, where it holds a key that orders.
  var key: FractionalKey? { ord.flatMap { try? FractionalKey($0) } }

  // The step with each field the changes name, and the names.
  func taking(_ changes: Changes) -> (step: RoadmapStep, named: [String]) {
    var step = self
    var named: [String] = []
    if let label = changes.label {
      step.label = label
      named.append("label")
    }
    if let icon = changes.icon {
      step.icon = icon
      named.append("icon")
    }
    if let color = changes.color {
      step.color = color
      named.append("color")
    }
    if let description = changes.description {
      step.description = description
      named.append("description")
    }
    if let links = changes.links {
      step.links = links
      named.append("links")
    }
    return (step, named)
  }
}

// A link: an `edge` record keyed by the step it comes from and the step it leads to.
public struct RoadmapLink: Writable, Removable, Hashable {
  public static let type = Roadmap.Types.edge
  public static let heldRemoval = false

  public let from: ID<RoadmapStep>
  public let to: ID<RoadmapStep>

  public init(from: ID<RoadmapStep>, to: ID<RoadmapStep>) {
    self.from = from
    self.to = to
  }

  public init(_ r: Fields) throws(DecodeError) {
    guard let ends = r.id.parts, ends.count == 2 else { throw DecodeError(type: RoadmapLink.type, field: "id", reason: "not a [from, to] key") }
    self.init(from: ID(RecordID(ends[0])), to: ID(RecordID(ends[1])))
  }

  public var id: ID<RoadmapLink> { ID(.pair(from.description, to.description)) }
  public var fields: [String: JSON] { [:] }
  public static let checks: [Check<RoadmapLink>] = []
}

extension RoadmapTree.Edge {
  var link: RoadmapLink { RoadmapLink(from: ID(RecordID(from)), to: ID(RecordID(to))) }
}

extension RoadmapTree {
  // The steps and links of one tree scope, every record a reader holds, absent ones kept: what a step follows, and its
  // loops, are read through absent steps (D-5).
  init(stepsOf tree: ID<RoadmapEntry>, in read: Reader) throws {
    precondition(read.scope == tree.tree, "the steps of \(tree) are read in its tree scope")
    let records = try read.repository(RoadmapStep.self).records(in: .drawn) + read.repository(RoadmapLink.self).records(in: .drawn)
    try self.init(id: tree, listed: nil, tree: records, overlay: nil)
  }

  // The first of the new links on a loop among what steps follow: one from a step to itself, or one that closes a loop
  // holding a present step. A loop of absent steps alone is read without harm.
  func firstLoop(closedBy links: [RoadmapLink]) -> Int? {
    var vertices = index.vertices
    var parents = index.parents
    let vertex = { (step: ID<RoadmapStep>) -> Int in
      if let known = vertices[step.description] { return known }
      vertices[step.description] = parents.count
      parents.append([])
      return parents.count - 1
    }
    let ends = links.map { (link: RoadmapLink) -> (from: Int, to: Int) in (vertex(link.from), vertex(link.to)) }
    for link in ends { parents[link.to].append(link.from) }
    let loops = Components(parents)
    return ends.firstIndex { (link: (from: Int, to: Int)) -> Bool in
      if link.from == link.to { return true }
      let component = loops.componentOf[link.from]
      return component == loops.componentOf[link.to] && loops.groups[component].contains { $0 < index.ids.count }
    }
  }
}

// A step a gesture brings before it has an id, under a key of the gesture's own that its links name.
public struct ImportedStep: Sendable {
  public let key: String
  public let step: RoadmapStep.Changes

  public init(key: String, _ step: RoadmapStep.Changes = RoadmapStep.Changes()) {
    self.key = key
    self.step = step
  }
}

// The steps a gesture brings and the links among them, each naming the keys of the step it comes from and the step it
// leads to.
public struct ImportedSteps: Sendable {
  public let steps: [ImportedStep]
  public let links: [(from: String, to: String)]

  public init(steps: [ImportedStep] = [], links: [(from: String, to: String)] = []) {
    self.steps = steps
    self.links = links
  }
}

// One imported step and the links that lead to it: the unit a chunk holds whole, measured as its records' JCS bytes.
struct ImportUnit {
  let step: Valid<RoadmapStep>
  let links: [Valid<RoadmapLink>]
  let bytes: Int

  init(step: Valid<RoadmapStep>, links: [Valid<RoadmapLink>]) {
    self.step = step
    self.links = links
    let written = JSON.object(JSON.Object(uniqueKeysWithValues: step.value.fields.map { ($0.key, $0.value) }))
    let node: JSON = ["t": .string(RoadmapStep.type), "id": step.value.id.json, "f": written]
    bytes = links.reduce(node.jcs.count) { (sum: Int, link: Valid<RoadmapLink>) -> Int in
      let edge: JSON = ["t": .string(RoadmapLink.type), "id": link.value.id.json]
      return sum + edge.jcs.count
    }
  }

  var count: Int { 1 + links.count }

  // The step and its links, and, where the act's Undo is not a command's over the whole roadmap, an Undo that deletes them
  // again while they are as the import made them.
  func write(to plan: inout Plan, undoable: Bool) {
    plan.create(step)
    for link in links { plan.create(link) }
    guard undoable else { return }
    plan.undoBy(.createdRecord(restoreCommand: Roadmap.Commands.restoreTree, record: .of(step.value.id)))
    for link in links { plan.undoBy(.createdRecord(restoreCommand: Roadmap.Commands.restoreTree, record: .of(link.value.id))) }
  }
}

// What an import brings to a roadmap: its steps under fresh ids, in the order they follow one another, each keyed after
// the steps before it under its trunk parent, with the links that lead to it. A step the import has no prerequisite for
// comes after the roadmap's first steps or, under `under`, follows that step and comes after the steps it leads to.
struct StepsImport {
  let units: [ImportUnit]
  // Each step's id by its key, in the import's order.
  let ids: [(key: String, id: ID<RoadmapStep>)]

  // A loop among the import's links is refused before an id is minted, a step past a bound at its place in the import.
  init(_ imported: ImportedSteps, into roadmap: RoadmapTree, under: ID<RoadmapStep>?, in scope: ScopeRef, at moment: Moment,
       ids: ActIDSource) throws(Violation) {
    let keys = imported.steps.map { Array($0.key.utf8) }
    precondition(Set(keys).count == keys.count, "an import names each step once")
    var links: [(from: Int, to: Int)] = []
    for link in imported.links {
      guard let from = keys.firstIndex(of: Array(link.from.utf8)), let to = keys.firstIndex(of: Array(link.to.utf8)) else {
        preconditionFailure("an import links its own steps")
      }
      if !links.contains(where: { $0.from == from && $0.to == to }) { links.append((from, to)) }
    }
    var parents = [[Int]](repeating: [], count: keys.count)
    for link in links { parents[link.to].append(link.from) }
    let loops = Components(parents).componentOf
    if let loop = links.firstIndex(where: { $0.from == $0.to || loops[$0.from] == loops[$0.to] }) {
      throw Violation(rule: RoadmapChecks.cycle, path: Path("links") + loop, reason: .custom(links[loop].from == links[loop].to ? "self" : "loop"))
    }
    let minted = imported.steps.map { (step: ImportedStep) -> ID<RoadmapStep> in ids.mint(RoadmapStep.self, inScope: scope) }
    var waiting = keys.indices.map { (index: Int) -> Int in parents[index].count }
    var lastOrd: [ID<RoadmapStep>?: FractionalKey] = [:]
    lastOrd[under] = roadmap.index.lastKey(under: under?.description)
    var units: [ImportUnit] = []
    while units.count < keys.count {
      // The first step that waits for no step before it is placed, and counted no more.
      guard let index = waiting.firstIndex(of: 0) else { preconditionFailure("an import without a loop orders every step") }
      waiting[index] = -1
      for link in links where link.from == index { waiting[link.to] -= 1 }
      let leading = links.filter { $0.to == index }.map { minted[$0.from] }
      let parent = leading.first ?? under
      let ord = FractionalKey(after: lastOrd[parent])
      lastOrd[parent] = ord
      let valid: Valid<RoadmapStep>
      do throws(Violation) {
        valid = try Valid(RoadmapStep(id: minted[index], ord: ord.text).taking(imported.steps[index].step).step, at: moment)
      } catch {
        throw error.at(Path("steps") + index)
      }
      var made: [Valid<RoadmapLink>] = []
      for from in leading.isEmpty ? (under.map { [$0] } ?? []) : leading {
        made.append(try Valid(RoadmapLink(from: from, to: minted[index]), at: moment))
      }
      units.append(ImportUnit(step: valid, links: made))
    }
    self.units = units
    self.ids = zip(imported.steps, minted).map { (key: $0.key, id: $1) }
  }

  // §5 Import and paste: chunks of at most `importChunk` records and `importChunkBytes`, a step's prerequisites in its chunk
  // or an earlier one. The first chunk keeps room for `reserved` records.
  func chunks(reserving reserved: Int) -> [[ImportUnit]] {
    var chunks: [[ImportUnit]] = [[]]
    var (count, bytes) = (reserved, 0)
    for unit in units {
      if count > 0 && (count + unit.count > RoadmapLimits.importChunk || bytes + unit.bytes > RoadmapLimits.importChunkBytes) {
        chunks.append([unit])
        (count, bytes) = (unit.count, unit.bytes)
        continue
      }
      chunks[chunks.count - 1].append(unit)
      count += unit.count
      bytes += unit.bytes
    }
    return chunks
  }
}

// The steps and links of one tree scope as an act reads them, and which of the steps it names the roadmap knows: a step
// the device holds, present or deleted, or one another device deleted that it knows only by its spent id (engine §7.5). A
// step it never knew is gone. With them, the room its steps and links have left, and the device's note of the roadmap as a
// write of it takes it (§6).
public struct HeldSteps: Sendable {
  public let roadmap: RoadmapTree
  public let known: Set<ID<RoadmapStep>>
  public let steps: Capacity
  public let links: Capacity
  public let note: LandingNote
  public let moment: Moment

  init(of tree: ID<RoadmapEntry>, naming named: [ID<RoadmapStep>], in read: Reader) throws {
    let held = read.repository(RoadmapStep.self)
    let roadmap = try RoadmapTree(stepsOf: tree, in: read)
    self.roadmap = roadmap
    known = Set(try named.filter { (step: ID<RoadmapStep>) throws -> Bool in
      try roadmap.step(step.description) != nil || held.spentBorn(step) != nil
    })
    steps = try held.capacity()
    links = try read.repository(RoadmapLink.self).capacity()
    note = try LandingNote(settledOf: tree, in: read, roadmap: roadmap)
    moment = read.moment
  }

  // The name of each step the device links from, as it holds it now, for a landing line that may come to name it once
  // another device deletes it (§6): the roadmap's own, or one the act makes. A step it holds no name of has none.
  func names(of linked: [ID<RoadmapStep>], made: [ID<RoadmapStep>: String] = [:]) -> [LandingNote.Name] {
    linked.unique.compactMap { (step: ID<RoadmapStep>) -> LandingNote.Name? in
      (roadmap.step(step.description)?.label ?? made[step]).map { LandingNote.Name(id: step, name: $0) }
    }
  }
}

// §5 Create a step: the step and one link from each prerequisite, in one intent, the step after the steps its first
// prerequisite leads to, or after the roadmap's first steps. The device notes both, so it can tell the person once if the
// step turns out to follow through a step deleted elsewhere (§6). A surface that shows the step before its write lands
// mints its id and gives it here; an id the roadmap holds, a deleted step's included, is refused, so no step is made over
// another.
public struct CreateStep: ActAction {
  public let tree: ID<RoadmapEntry>
  public let step: RoadmapStep.Changes
  public let prerequisites: [ID<RoadmapStep>]
  public let id: ID<RoadmapStep>?

  public init(tree: ID<RoadmapEntry>, step: RoadmapStep.Changes, prerequisites: [ID<RoadmapStep>] = [], id: ID<RoadmapStep>? = nil) {
    self.tree = tree
    self.step = step
    self.prerequisites = prerequisites.unique
    self.id = id
  }

  public func load(_ read: ActReader) throws -> HeldSteps {
    try read.inScope(tree.tree) { (scope: Reader) throws -> HeldSteps in
      try HeldSteps(of: tree, naming: prerequisites + (id.map { [$0] } ?? []), in: scope)
    }
  }

  public func decide(_ loaded: HeldSteps, ids: ActIDSource) throws(Violation) -> ActDecision<ID<RoadmapStep>, RoadmapRefusal> {
    if let unknown = prerequisites.first(where: { !loaded.known.contains($0) }) { return .refuse(.gone(unknown.ref, .predicted)) }
    if let id, loaded.known.contains(id) { return .refuse(.taken(id.ref, .predicted)) }
    let made = id ?? ids.mint(RoadmapStep.self, inScope: tree.tree)
    let ord = FractionalKey(after: loaded.roadmap.index.lastKey(under: prerequisites.first?.description))
    let placed = try Valid(RoadmapStep(id: made, ord: ord.text).taking(step).step, at: loaded.moment)
    var links: [Valid<RoadmapLink>] = []
    for from in prerequisites { links.append(try Valid(RoadmapLink(from: from, to: made), at: loaded.moment)) }
    let full = loaded.steps.refusal(growing: 1, subject: made.ref) ?? loaded.links.refusal(growing: links.count, subject: links.first?.value.id.ref)
    if let full { return .refuse(RoadmapRefusal(full)) }
    var plan = Plan()
    plan.create(placed)
    plan.undoBy(.createdRecord(restoreCommand: Roadmap.Commands.restoreTree, record: .of(made)))
    for link in links {
      plan.create(link)
      plan.undoBy(.createdRecord(restoreCommand: Roadmap.Commands.restoreTree, record: .of(link.value.id)))
    }
    plan.note(loaded.note.adding(nodes: [made], edges: links.map(\.value), names: loaded.names(of: prerequisites)), of: tree)
    return .write(plan, in: tree.tree, made)
  }
}

// What the device holds of one step a change names (§5), and, where it found the step absent, its note of the roadmap as a
// write of it takes it: any change to a step carries its life as alive under the gesture's stamp, so a step deleted
// elsewhere comes back with the change (P-4, INV-1), and the device notes the step it brought back (§6).
public struct HeldStep: Sendable {
  public let tree: ID<RoadmapEntry>
  public let held: HeldRecord<RoadmapStep>
  public let note: LandingNote?
  public let moment: Moment

  init(_ step: ID<RoadmapStep>, of tree: ID<RoadmapEntry>, in read: Reader) throws {
    self.tree = tree
    held = try HeldRecord(RoadmapStep(id: step), in: read.repository(RoadmapStep.self))
    note = held.isAbsent ? try LandingNote(settledOf: tree, in: read, roadmap: RoadmapTree(stepsOf: tree, in: read)) : nil
    moment = read.moment
  }

  // The revival a change plans, with the device's note of a step it brings back.
  func reviving(_ valid: Valid<RoadmapStep>, fields: [String]) -> Plan {
    var plan = held.reviving(valid, fields: fields)
    if let note { plan.note(note.adding(revived: [held.value.id]), of: tree) }
    return plan
  }

  // A change that changes nothing writes nothing.
  func changing(to valid: Valid<RoadmapStep>) -> ActDecision<Void, RoadmapRefusal> {
    let changed = held.changed(by: valid)
    guard !changed.isEmpty else { return .unchanged(()) }
    return .write(reviving(valid, fields: changed), in: tree.tree, ())
  }
}

// A step's own fields, changed: a `revive` naming the changed fields. A step the device knows only by its spent id is
// revived with every field the change names, its other fields the server's.
public struct ChangeStep: ActAction {
  public let tree: ID<RoadmapEntry>
  public let step: ID<RoadmapStep>
  public let changes: RoadmapStep.Changes

  public init(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>, changes: RoadmapStep.Changes) {
    self.tree = tree
    self.step = step
    self.changes = changes
  }

  public func load(_ read: ActReader) throws -> HeldStep {
    try read.inScope(tree.tree) { (scope: Reader) throws -> HeldStep in try HeldStep(step, of: tree, in: scope) }
  }

  public func decide(_ loaded: HeldStep, ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    guard loaded.held.isKnown else { return .refuse(.gone(step.ref, .predicted)) }
    let changed = loaded.held.value.taking(changes)
    return loaded.changing(to: try Valid(changed.step, fields: changed.named, at: loaded.moment))
  }
}

// §5 Reorder: the step lands below the sibling above it among its trunk parent's steps, which the layout names, keyed
// between that sibling and the next. A drop in place writes nothing.
public struct MoveStep: ActAction {
  public let tree: ID<RoadmapEntry>
  public let step: ID<RoadmapStep>
  public let below: ID<RoadmapStep>?
  public let siblings: [ID<RoadmapStep>]

  public init(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>, below: ID<RoadmapStep>?, siblings: [ID<RoadmapStep>]) {
    self.tree = tree
    self.step = step
    self.below = below
    self.siblings = siblings.filter { $0 != step }
  }

  // The siblings the roadmap draws that hold a key that orders, each with its key.
  public func load(_ read: ActReader) throws -> (step: HeldStep, members: [ListMember]) {
    try read.inScope(tree.tree) { (scope: Reader) throws -> (step: HeldStep, members: [ListMember]) in
      let steps = scope.repository(RoadmapStep.self)
      let members = try siblings.compactMap { (sibling: ID<RoadmapStep>) throws -> ListMember? in
        try steps.find(sibling, in: .drawn)?.key.map { ListMember(id: sibling.json, key: $0) }
      }
      return (try HeldStep(step, of: tree, in: scope), members)
    }
  }

  public func decide(_ loaded: (step: HeldStep, members: [ListMember]), ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    guard loaded.step.held.isKnown else { return .refuse(.gone(step.ref, .predicted)) }
    if let below, !loaded.members.contains(where: { $0.id == below.json }) { return .refuse(.gone(below.ref, .predicted)) }
    var moved = loaded.step.held.value
    guard let ord = FractionalKey(moving: step.json, from: moved.key, below: below?.json, among: loaded.members) else { return .unchanged(()) }
    moved.ord = ord.text
    return loaded.step.changing(to: try Valid(moved, fields: ["ord"], at: loaded.step.moment))
  }
}

// §5 Delete a step: held, and the step's death alone. Its links stay, unread while it is absent, and return with it.
public struct DeleteStep: ActAction {
  public let tree: ID<RoadmapEntry>
  public let step: ID<RoadmapStep>

  public init(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>) {
    self.tree = tree
    self.step = step
  }

  public func load(_ read: ActReader) throws -> RoadmapStep? {
    try read.inScope(tree.tree) { (scope: Reader) throws -> RoadmapStep? in try scope.repository(RoadmapStep.self).find(step, in: .drawn) }
  }

  public func decide(_ drawn: RoadmapStep?, ids: ActIDSource) -> ActDecision<Void, RoadmapRefusal> {
    guard drawn != nil else { return .unchanged(()) }
    var plan = Plan()
    plan.remove(step)
    plan.undoBy(.restoring(step, life: true, by: Roadmap.Commands.restoreTree))
    return .write(plan, in: tree.tree, ())
  }
}

// §5 A step's prerequisites, added and removed in one gesture. A removed prerequisite the step follows through an absent
// step retires each link the step reaches it by; an added one that closes a loop among what steps follow is refused before
// anything is written; and an added link is noted with the name of the step it comes from (§6).
public struct ChangePrerequisites: ActAction {
  public let tree: ID<RoadmapEntry>
  public let step: ID<RoadmapStep>
  public let add: [ID<RoadmapStep>]
  public let remove: [ID<RoadmapStep>]

  public init(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>, add: [ID<RoadmapStep>] = [], remove: [ID<RoadmapStep>] = []) {
    self.tree = tree
    self.step = step
    self.add = add.unique
    self.remove = remove.unique
  }

  public func load(_ read: ActReader) throws -> HeldSteps {
    try read.inScope(tree.tree) { (scope: Reader) throws -> HeldSteps in try HeldSteps(of: tree, naming: [step] + add, in: scope) }
  }

  public func decide(_ loaded: HeldSteps, ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    if let unknown = ([step] + add).first(where: { !loaded.known.contains($0) }) { return .refuse(.gone(unknown.ref, .predicted)) }
    let roadmap = loaded.roadmap
    let live = Set(roadmap.index.edges.map(\.link))
    let adding = add.map { RoadmapLink(from: $0, to: step) }.filter { !live.contains($0) }
    if let loop = roadmap.firstLoop(closedBy: adding), let named = add.firstIndex(of: adding[loop].from) {
      throw Violation(rule: RoadmapChecks.cycle, path: Path("add") + named, reason: .custom(adding[loop].from == step ? "self" : "loop"))
    }
    let followed = FollowGraph(roadmap).followed(step.description)
    var removing: [RoadmapLink] = []
    for prerequisite in remove {
      let direct = RoadmapLink(from: prerequisite, to: step)
      let through = followed.first { $0.id.utf8.elementsEqual(prerequisite.description.utf8) }?.incoming.map(\.link) ?? []
      removing = removing.adding(new: (live.contains(direct) ? [direct] : through).filter { !adding.contains($0) })
    }
    guard !adding.isEmpty || !removing.isEmpty else { return .unchanged(()) }
    var made: [Valid<RoadmapLink>] = []
    for link in adding { made.append(try Valid(link, at: loaded.moment)) }
    if let full = loaded.links.refusal(growing: adding.count - removing.count, subject: adding.first?.id.ref) { return .refuse(RoadmapRefusal(full)) }
    let held = Set(roadmap.edges.map(\.link))
    var plan = Plan()
    for link in made { plan.create(link) }
    for link in removing { plan.remove(link.id) }
    for link in adding {
      let restored = UndoRecipe.restoring(link.id, life: true, by: Roadmap.Commands.restoreTree)
      plan.undoBy(held.contains(link) ? restored : .createdRecord(restoreCommand: Roadmap.Commands.restoreTree, record: .of(link.id)))
    }
    for link in removing { plan.undoBy(.restoring(link.id, life: true, by: Roadmap.Commands.restoreTree)) }
    if !adding.isEmpty { plan.note(loaded.note.adding(edges: adding, names: loaded.names(of: adding.map(\.from))), of: tree) }
    return .write(plan, in: tree.tree, ())
  }
}

// §5 Import and paste into a roadmap: the steps under fresh ids, in chunks, prerequisites first, one act and so one Undo.
// Under a step, the import's first steps follow it. The device notes every step and link, with the name of each step a
// link comes from (§6).
public struct ImportSteps: ActAction {
  public let tree: ID<RoadmapEntry>
  public let imported: ImportedSteps
  public let under: ID<RoadmapStep>?

  public init(tree: ID<RoadmapEntry>, imported: ImportedSteps, under: ID<RoadmapStep>? = nil) {
    self.tree = tree
    self.imported = imported
    self.under = under
  }

  public func load(_ read: ActReader) throws -> HeldSteps {
    try read.inScope(tree.tree) { (scope: Reader) throws -> HeldSteps in try HeldSteps(of: tree, naming: under.map { [$0] } ?? [], in: scope) }
  }

  // Each planted step's id by its key, in the order the gesture brought them.
  public func decide(_ loaded: HeldSteps, ids: ActIDSource) throws(Violation) -> ActDecision<[(key: String, id: ID<RoadmapStep>)], RoadmapRefusal> {
    if let under, !loaded.known.contains(under) { return .refuse(.gone(under.ref, .predicted)) }
    guard !imported.steps.isEmpty else { return .unchanged([]) }
    let planned = try StepsImport(imported, into: loaded.roadmap, under: under, in: tree.tree, at: loaded.moment, ids: ids)
    let (steps, links) = (planned.units.map(\.step.value), planned.units.flatMap(\.links).map(\.value))
    let full = loaded.steps.refusal(growing: steps.count, subject: steps.first?.id.ref)
      ?? loaded.links.refusal(growing: links.count, subject: links.first?.id.ref)
    if let full { return .refuse(RoadmapRefusal(full)) }
    var chunks = planned.chunks(reserving: 0).map { (chunk: [ImportUnit]) -> Plan in
      var plan = Plan()
      for unit in chunk { unit.write(to: &plan, undoable: true) }
      return plan
    }
    let labels = Dictionary(uniqueKeysWithValues: steps.map { ($0.id, $0.label) })
    chunks[0].note(loaded.note.adding(nodes: steps.map(\.id), edges: links, names: loaded.names(of: links.map(\.from), made: labels)), of: tree)
    return .write(ActPlan(chunks.map { ScopedPlan(tree.tree, $0) }), planned.ids)
  }
}
