import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A roadmap's entry in the person's list: the `tree` record that governs its scope. The client writes its birth and its
// death; its place under a step is the server's.
public struct RoadmapEntry: ProductEntity, Writable, Removable {
  public static let type = Roadmap.Types.tree
  public static let scope = Roadmap.scope
  public static let heldRemoval = true

  // Where a subtree sits: the step of another roadmap that owns it, as its entry and its meta both name it.
  public struct Parent: Equatable, Sendable {
    public let tree: ID<RoadmapEntry>
    public let step: ID<RoadmapStep>

    public init(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>) {
      self.tree = tree
      self.step = step
    }

    // Nil for a root, whose register is unset or holds null.
    init?(_ place: JSON?) {
      guard case .string(let tree)? = place?["tree"], case .string(let step)? = place?["step"] else { return nil }
      self.init(tree: ID(RecordID(tree)), step: ID(RecordID(step)))
    }

    var json: JSON { ["tree": tree.json, "step": step.json] }
  }

  public let id: ID<RoadmapEntry>
  public let parent: Parent?

  public init(id: ID<RoadmapEntry>, parent: Parent? = nil) {
    self.id = id
    self.parent = parent
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), parent: Parent(r.json("parent")))
  }

  public var fields: [String: JSON] { [:] }
  public static let checks: [Check<RoadmapEntry>] = []
}

extension ID where E == RoadmapEntry {
  // The scope the entry governs: the roadmap's meta, steps, links and kinds.
  public var tree: ScopeRef { .tree(description) }
  // The person's own overlay of the roadmap: their marks, and the owner's pointers and workspace.
  public var overlay: ScopeRef { .overlay(description) }
}

// A roadmap's own words and a root's visibility, the singleton of its tree scope. Its place, its reach and whether its
// guide is inherited are the server's.
public struct RoadmapMeta: Writable {
  public static let type = Roadmap.Types.meta
  public static let singleton = ID<RoadmapMeta>("meta")

  public var id: ID<RoadmapMeta> { RoadmapMeta.singleton }
  public var title: String
  public var guide: String
  public var visibility: String
  public let guideInherited: Bool
  // Unset on a root, which is its own.
  public let root: ID<RoadmapEntry>?
  public let parent: RoadmapEntry.Parent?
  public let depth: Int
  public let reach: String

  public init(title: String = Roadmap.Defaults.Meta.title, guide: String = Roadmap.Defaults.Meta.guide,
              visibility: String = Roadmap.Defaults.Meta.visibility, guideInherited: Bool = Roadmap.Defaults.Meta.guideInherited,
              root: ID<RoadmapEntry>? = nil, parent: RoadmapEntry.Parent? = nil, depth: Int = Roadmap.Defaults.Meta.depth,
              reach: String = Roadmap.Defaults.Meta.reach) {
    self.title = title
    self.guide = guide
    self.visibility = visibility
    self.guideInherited = guideInherited
    self.root = root
    self.parent = parent
    self.depth = depth
    self.reach = reach
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(title: try r.string("title", default: Roadmap.Defaults.Meta.title), guide: try r.string("guide", default: Roadmap.Defaults.Meta.guide),
              visibility: try r.string("visibility", default: Roadmap.Defaults.Meta.visibility),
              guideInherited: try r.bool("guideInherited", default: Roadmap.Defaults.Meta.guideInherited),
              root: try r.optionalRef("root", RoadmapEntry.self), parent: RoadmapEntry.Parent(r.json("parent")),
              depth: try r.optionalInt("depth") ?? Roadmap.Defaults.Meta.depth, reach: try r.string("reach", default: Roadmap.Defaults.Meta.reach))
  }

  public var fields: [String: JSON] { ["title": .string(title), "guide": .string(guide), "visibility": .string(visibility)] }

  public static let checks: [Check<RoadmapMeta>] = [
    Check("title") { m, _ in m.title = try RoadmapSpecs.title.apply(m.title, at: "title") },
    Check("guide") { m, _ in m.guide = try RoadmapSpecs.guide.apply(m.guide, at: "guide") },
    Check("visibility") { m, _ in m.visibility = try RoadmapSpecs.visibility.apply(m.visibility, at: "visibility") },
  ]
}

// A record of a roadmap as the engine's readers hand it over: the entity it holds, and whether it is present.
extension Record {
  func holds<E: Entity>(_ entity: E.Type) -> Bool { type.utf8.elementsEqual(E.type.utf8) }
  var present: Bool { life?.isAlive == true }
}

extension RoadmapTree {
  // One roadmap as a device's replica holds it, from the engine's records as `drawn` folds them, visible or not: a
  // reader's `records(in: .drawn)`, or the room's views of every record. `tree` is every record of its tree scope: its
  // steps and links, absent ones kept, its meta and its kinds. `overlay` is every record of its owner's overlay, for the
  // marks and pointers, nil where the reader takes none (a roadmap someone else owns). `listed` is its entry in the
  // person's own list, nil where it is not theirs: it says whether the roadmap is present and where it sits, and without
  // it the meta says where. `read` says the device holds the server's whole copy: the first pull of every scope it is read
  // through has ended. Before that it is read only where the device holds records of it and the server has sent none of
  // them, nor of its overlay (none carries the server's `ru`): a roadmap the device made, which the server does not hold
  // yet. A pull under way leaves it unread, whatever it has brought.
  // A subtree's date and a pointer's order are the stamps of the registers that hold them. §5 Dates: the server has
  // received a mark once no queued entry still changes its record (`isPending`), and its time is the record's `ru`; a mark
  // an entry still changes is the device's, timed by its register's stamp. A roadmap was last changed when the server
  // last received a record of it: the newest `ru` among its entry, its tree scope's records and its overlay's.
  public init(id: ID<RoadmapEntry>, listed: Record?, tree: [Record], overlay: [Record]?, read: Bool = true) throws(DecodeError) {
    let overlaid = overlay ?? []
    var meta: RoadmapMeta?
    var nodes: [Step] = []
    var edges: [Edge] = []
    var kinds: [Kind] = []
    for record in tree {
      if record.holds(RoadmapMeta.self), record.id == RoadmapMeta.singleton.record { meta = try RoadmapMeta(Fields(record)) }
      if record.holds(RoadmapStep.self) {
        let step = try RoadmapStep(Fields(record))
        nodes.append(Step(id: step.id.description, present: record.present, born: record.born, rc: record.rc.map(Instant.init(ms:)),
                          ru: record.ru.map(Instant.init(ms:)), label: step.label, icon: step.icon, color: step.color, ord: step.ord,
                          status: step.status, description: step.description, links: step.links, branch: step.branch?.description,
                          branchStamp: record.stamps["branch"]))
      }
      if record.holds(RoadmapLink.self) {
        let link = try RoadmapLink(Fields(record))
        edges.append(Edge(from: link.from.description, to: link.to.description, present: record.present))
      }
      if record.holds(RoadmapKind.self) {
        let kind = try RoadmapKind(Fields(record))
        kinds.append(Kind(id: kind.id.description, present: record.present, born: record.born, hue: kind.hue, label: kind.label,
                          description: kind.description, ord: kind.ord))
      }
    }
    var marks: [Mark] = []
    var pointers: [Pointer] = []
    for record in overlaid {
      if record.holds(StepMark.self) {
        let mark = try StepMark(Fields(record))
        let stamp = record.stamps["mark"]
        let received = record.isPending ? nil : record.ru.map(Instant.init(ms:))
        marks.append(Mark(node: mark.id.description, status: mark.status, outOfOrder: mark.outOfOrder, recordedAt: received,
                          deviceAt: stamp.map { Instant(ms: $0.ms) }, stamp: stamp))
      }
      if record.holds(StepPointer.self) {
        let pointer = try StepPointer(Fields(record))
        pointers.append(Pointer(node: pointer.id.description, present: record.present, opens: pointer.opens?.description ?? "",
                                setAt: record.stamps["opens"]))
      }
    }
    let place: RoadmapEntry.Parent?
    if let listed { place = try RoadmapEntry(Fields(listed)).parent } else { place = meta?.parent }
    let held = tree + overlaid
    let received = ([listed?.ru] + held.map(\.ru)).compactMap { $0 }.max()
    let madeHere = !tree.isEmpty && held.allSatisfy { $0.ru == nil }
    let metadata = meta.map { (meta: RoadmapMeta) -> Metadata in
      Metadata(title: meta.title, guide: meta.guide, guideInherited: meta.guideInherited, root: (meta.root ?? id).description, depth: meta.depth,
               visibility: meta.visibility, reach: meta.reach)
    }
    self.init(id: id.description, present: listed.map { $0.life?.isAlive == true } ?? true, read: read || madeHere ? .loaded : .unread,
              own: listed != nil, updatedAt: received.map(Instant.init(ms:)),
              parent: place.map { Parent(tree: $0.tree.description, step: $0.step.description) }, meta: metadata, nodes: nodes, edges: edges,
              kinds: kinds, marks: marks, pointers: pointers)
  }
}

// §5 Create a roadmap: its entry, then its tree scope with the title, its kinds and the first steps, in chunks when the
// steps are many. Its kinds are the genesis kinds, or a legend of its own in its order, each checked as a kind made is
// and none wearing a hue a kind before it wears. The engine drops the tree's intents when the entry is refused. Its Undo
// is `roadmap.undoCreateRoadmap`, while the entry, the tree and the owner's overlay of it are as it left them; each tree
// segment is journaled as that Undo's evidence, so its receipts prove the tree unchanged.
public struct CreateRoadmap: ActAction {
  public struct Result: Sendable {
    public let tree: ID<RoadmapEntry>
    // Each planted step's id by its key, in the order the gesture brought them.
    public let steps: [(key: String, id: ID<RoadmapStep>)]
  }

  public let title: String
  public let steps: ImportedSteps
  // Its own legend, nil for the genesis kinds.
  public let kinds: [NewKind]?

  public init(title: String, steps: ImportedSteps = ImportedSteps(), kinds: [NewKind]? = nil) {
    self.title = title
    self.steps = steps
    self.kinds = kinds
  }

  // The entry's scope is borrowed for the id the decision mints in it.
  public func load(_ read: ActReader) throws -> Moment {
    try read.inScope(RoadmapEntry.scope) { (account: Reader) -> Moment in account.moment }
  }

  public func decide(_ moment: Moment, ids: ActIDSource) throws(Violation) -> ActDecision<Result, RoadmapRefusal> {
    let words = try Valid(RoadmapMeta(title: title), fields: ["title"], at: moment)
    let tree = ids.mint(RoadmapEntry.self)
    var legend: [Valid<RoadmapKind>] = []
    if let kinds {
      for (place, kind) in kinds.enumerated() {
        let id = ids.mint(RoadmapKind.self, inScope: tree.tree)
        if kinds[..<place].contains(where: { $0.hue.utf8.elementsEqual(kind.hue.utf8) }) {
          throw Violation(rule: RoadmapChecks.wornHue, path: Path("kinds") + place + "hue", reason: .custom("worn"))
        }
        do throws(Violation) {
          legend.append(try Valid(RoadmapKind(id: id, hue: kind.hue, label: kind.label, description: kind.description, ord: "a\(place)"), at: moment))
        } catch {
          throw error.at(Path("kinds") + place)
        }
      }
    } else {
      for kind in RoadmapRules.genesisKinds { legend.append(try Valid(kind, at: moment)) }
    }
    let imported = try StepsImport(steps, in: tree.tree, at: moment, ids: ids)
    var entry = Plan()
    entry.create(try Valid(RoadmapEntry(id: tree), at: moment))
    entry.undoBy(.command(Roadmap.Commands.undoCreateRoadmap, input: ["tree": tree.json], unchangedCreatedRecords: [.of(tree)],
                          unchangedCreatedScopes: [tree.tree]))
    var segments = [ScopedPlan(RoadmapEntry.scope, entry)]
    for (index, chunk) in imported.chunks(reserving: 1 + legend.count).enumerated() {
      var plan = Plan()
      if index == 0 {
        plan.create(words, fields: ["title"])
        for kind in legend { plan.create(kind) }
      }
      for unit in chunk { unit.write(to: &plan) }
      plan.evidenceForUndo()
      segments.append(ScopedPlan(tree.tree, plan))
    }
    return .write(ActPlan(segments), Result(tree: tree, steps: imported.ids))
  }
}

// §5 Delete a roadmap: held nine seconds, and permanent once the hold ends (R-7). A subtree goes with the step that owns
// it, so only a root's entry is deleted here. The device's notes (§6) of the roadmap and of every subtree under it go at
// once, and an Undo within the hold does not bring them back.
public struct DeleteRoadmap: ActAction {
  public let tree: ID<RoadmapEntry>

  public init(tree: ID<RoadmapEntry>) {
    self.tree = tree
  }

  public func load(_ read: ActReader) throws -> (roadmap: RoadmapEntry?, notes: [String]) {
    try read.inScope(RoadmapEntry.scope) { (account: Reader) throws -> (roadmap: RoadmapEntry?, notes: [String]) in
      let entries = account.repository(RoadmapEntry.self)
      let roadmaps = try entries.all(in: .drawn)
      var under = [tree]
      var next = 0
      while next < under.count {
        for each in roadmaps where each.parent?.tree == under[next] && !under.contains(each.id) { under.append(each.id) }
        next += 1
      }
      return (try entries.find(tree, in: .drawn), try under.map(LandingNote.key).filter { try account.device($0) != nil })
    }
  }

  public func decide(_ loaded: (roadmap: RoadmapEntry?, notes: [String]), ids: ActIDSource) -> ActDecision<Void, RoadmapRefusal> {
    guard let roadmap = loaded.roadmap else { return .unchanged(()) }
    guard roadmap.parent == nil else {
      return .refuse(.notARoot(Refused(Roadmap.Codes.notARoot, subject: tree.ref, path: .predicted)))
    }
    var plan = Plan()
    plan.remove(tree)
    for key in loaded.notes { plan.device(key, nil) }
    return .write(plan, in: RoadmapEntry.scope, ())
  }
}

// A roadmap's title or guide, written in its tree scope.
public struct WriteRoadmap: ActAction {
  public let tree: ID<RoadmapEntry>
  public let title: String?
  public let guide: String?

  public init(tree: ID<RoadmapEntry>, title: String? = nil, guide: String? = nil) {
    self.tree = tree
    self.title = title
    self.guide = guide
  }

  public func load(_ read: ActReader) throws -> (meta: RoadmapMeta, moment: Moment) {
    try read.inScope(tree.tree) { (scope: Reader) throws -> (meta: RoadmapMeta, moment: Moment) in
      (try scope.repository(RoadmapMeta.self).find(RoadmapMeta.singleton, in: .drawn) ?? RoadmapMeta(), scope.moment)
    }
  }

  public func decide(_ loaded: (meta: RoadmapMeta, moment: Moment), ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    var meta = loaded.meta
    var named: [String] = []
    if let title {
      meta.title = title
      named.append("title")
    }
    if let guide {
      meta.guide = guide
      named.append("guide")
    }
    let valid = try Valid(meta, fields: named, at: loaded.moment)
    let changed = valid.changed(from: loaded.meta)
    guard !changed.isEmpty else { return .unchanged(()) }
    var plan = Plan()
    plan.update(valid, fields: changed)
    plan.undoBy(.restoring(RoadmapMeta.singleton, fields: changed, by: Roadmap.Commands.restoreTree))
    return .write(plan, in: tree.tree, ())
  }
}

// A roadmap's entry as the device holds it, and the subtrees under it that stand: each step that owns a roadmap on the way
// down from it is present (D-3).
struct Branch {
  let entry: RoadmapEntry?
  let standing: [ID<RoadmapEntry>]

  init(of root: ID<RoadmapEntry>, in read: ActReader) throws {
    let roadmaps = try read.inScope(RoadmapEntry.scope) { (account: Reader) throws -> [RoadmapEntry] in
      try account.repository(RoadmapEntry.self).all(in: .drawn)
    }
    let entries = Dictionary(uniqueKeysWithValues: roadmaps.map { ($0.id, $0) })
    let members = roadmaps.filter { (roadmap: RoadmapEntry) -> Bool in
      var seen: Set<ID<RoadmapEntry>> = []
      var parent = roadmap.parent
      while let place = parent, !seen.contains(place.tree) {
        if place.tree == root { return true }
        seen.insert(place.tree)
        parent = entries[place.tree]?.parent
      }
      return false
    }
    var owned: Set<ID<RoadmapEntry>> = []
    for holder in Set(members.compactMap(\.parent?.tree)) {
      try read.inScope(holder.tree) { (scope: Reader) throws -> Void in
        let steps = scope.repository(RoadmapStep.self)
        for member in members {
          guard let place = member.parent, place.tree == holder, try steps.find(place.step, in: .drawn) != nil else { continue }
          owned.insert(member.id)
        }
      }
    }
    func stands(_ id: ID<RoadmapEntry>) -> Bool {
      guard let place = entries[id]?.parent, owned.contains(id) else { return false }
      return place.tree == root || stands(place.tree)
    }
    entry = entries[root]
    standing = members.map(\.id).filter(stands).sorted()
  }
}

// The engine's capture of a tree scope, which a root's visibility is written under so that the reach the server writes is
// predicted with it.
struct CaptureTree: ServerCommand {
  static let name = Roadmap.Commands.captureTree
  static let specs: [any ValueSpec] = []
  let args: [String: JSON] = [:]
}

// §4 a root's visibility: the owner's field, written under the gesture's stamp, so the newest choice stands. The server
// writes the reach of the root and of every standing subtree of its branch, predicted here.
public struct SetVisibility: ActAction {
  public typealias Loaded = (roadmap: RoadmapEntry?, subtrees: [ID<RoadmapEntry>], meta: RoadmapMeta, moment: Moment)

  public let tree: ID<RoadmapEntry>
  public let visibility: String

  public init(tree: ID<RoadmapEntry>, visibility: String) {
    self.tree = tree
    self.visibility = visibility
  }

  public func load(_ read: ActReader) throws -> Loaded {
    let branch = try Branch(of: tree, in: read)
    let meta = try read.inScope(tree.tree) { (scope: Reader) throws -> RoadmapMeta in
      try scope.repository(RoadmapMeta.self).find(RoadmapMeta.singleton, in: .drawn) ?? RoadmapMeta()
    }
    return (branch.entry, branch.standing, meta, read.moment)
  }

  public func decide(_ loaded: Loaded, ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    guard let roadmap = loaded.roadmap else { return .refuse(.gone(tree.ref, .predicted)) }
    guard roadmap.parent == nil else {
      return .refuse(.notARoot(Refused(Roadmap.Codes.notARoot, subject: tree.ref, path: .predicted)))
    }
    var meta = loaded.meta
    meta.visibility = visibility
    let valid = try Valid(meta, fields: ["visibility"], at: loaded.moment)
    let chosen = valid.value.visibility
    guard !chosen.utf8.elementsEqual(loaded.meta.visibility.utf8) else { return .unchanged(()) }
    var reaches = [Prediction.write(RoadmapMeta.self, RoadmapMeta.singleton, ["reach": .string(chosen)])]
    for subtree in loaded.subtrees {
      reaches.append(.write(RoadmapMeta.self, RoadmapMeta.singleton, ["reach": .string(chosen)], in: subtree.tree))
    }
    var plan = try Plan(running: CaptureTree(), predicting: reaches)
    plan.update(valid, fields: ["visibility"])
    plan.undoBy(.restoring(RoadmapMeta.singleton, fields: ["visibility"], by: Roadmap.Commands.restoreTree))
    return .write(plan, in: tree.tree, ())
  }
}

// §4 `roadmap.createSubtree {tree, root, step, subtree}`, run in the person's list.
struct CreateSubtreeCommand: ServerCommand {
  static let name = Roadmap.Commands.createSubtree
  static let specs: [any ValueSpec] = []
  let args: [String: JSON]
}

// §4 `roadmap.createSubtree`, predicted so a subtree is made with no connection: the subtree's entry, its meta and genesis
// kinds, and the step's `branch`. A step this device holds as deleted, or knows only by its spent id, is revived first, and
// noted (§6); of the latter the device knows no subtree, so the server answers any it owns.
public struct CreateSubtree: ActAction {
  public struct Result: Sendable {
    public let subtree: ID<RoadmapEntry>
    // What a Redo of the creation plants again: the root of the branch, and whether the step was revived first. Nil for a
    // subtree the step already owned.
    public let creation: (root: ID<RoadmapEntry>, revived: Bool)?
  }

  public typealias Loaded = (roadmap: RoadmapEntry?, pointer: StepPointer?, meta: RoadmapMeta, step: HeldStep)

  public let tree: ID<RoadmapEntry>
  public let step: ID<RoadmapStep>

  public init(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>) {
    self.tree = tree
    self.step = step
  }

  public func load(_ read: ActReader) throws -> Loaded {
    let roadmap = try read.inScope(RoadmapEntry.scope) { (account: Reader) throws -> RoadmapEntry? in
      try account.repository(RoadmapEntry.self).find(tree, in: .drawn)
    }
    let held = try read.inScope(tree.tree) { (scope: Reader) throws -> (meta: RoadmapMeta, step: HeldStep) in
      (try scope.repository(RoadmapMeta.self).find(RoadmapMeta.singleton, in: .drawn) ?? RoadmapMeta(), try HeldStep(step, of: tree, in: scope))
    }
    let pointer = try read.inScope(tree.overlay) { (overlay: Reader) throws -> StepPointer? in
      try overlay.repository(StepPointer.self).find(ID(step.record), in: .drawn)
    }
    return (roadmap, pointer, held.meta, held.step)
  }

  public func decide(_ loaded: Loaded, ids: ActIDSource) throws(Violation) -> ActDecision<Result, RoadmapRefusal> {
    guard loaded.roadmap != nil else { return .refuse(.gone(tree.ref, .predicted)) }
    let held = loaded.step.held
    guard held.isKnown else { return .refuse(.gone(step.ref, .predicted)) }
    if let owned = held.value.branch { return .unchanged(Result(subtree: owned, creation: nil)) }
    guard loaded.pointer == nil else {
      return .refuse(.stepOpensARoadmap(Refused(Roadmap.Codes.stepOpensATree, subject: step.ref, path: .predicted)))
    }
    let depth = loaded.meta.depth + 1
    guard depth <= RoadmapLimits.maxDepth else {
      return .refuse(.depthLimit(Refused(Roadmap.Codes.depthLimit, subject: tree.ref, path: .predicted)))
    }
    let subtree = ids.mint(RoadmapEntry.self)
    let root = loaded.meta.root ?? tree
    let place = RoadmapEntry.Parent(tree: tree, step: step).json
    var planted = [
      Prediction.create(RoadmapEntry.self, subtree, ["parent": place]),
      Prediction.write(RoadmapMeta.self, RoadmapMeta.singleton,
                       ["root": root.json, "parent": place, "depth": JSON(depth), "reach": .string(loaded.meta.reach)], in: subtree.tree),
    ]
    for kind in RoadmapRules.genesisKinds { planted.append(.create(RoadmapKind.self, kind.id, kind.fields, in: subtree.tree)) }
    planted.append(.update(RoadmapStep.self, step, ["branch": subtree.json], in: tree.tree))
    let command = CreateSubtreeCommand(args: ["tree": tree.json, "root": root.json, "step": step.json, "subtree": subtree.json])
    var connection = try Plan(running: command, predicting: planted)
    connection.undoBy(.command(Roadmap.Commands.undoCreateSubtree, input: ["tree": tree.json, "step": step.json, "subtree": subtree.json],
                               ownedFields: [.field(step, "branch", in: tree.tree)], unchangedCreatedRecords: [.of(subtree)],
                               unchangedCreatedScopes: [subtree.tree]))
    let connected = ScopedPlan(RoadmapEntry.scope, connection)
    let result = Result(subtree: subtree, creation: (root, held.isAbsent))
    guard held.isAbsent else { return .write(ActPlan([connected]), result) }
    let revival = loaded.step.reviving(try Valid(held.value, fields: [], at: loaded.step.moment), fields: [])
    return .write(ActPlan([ScopedPlan(tree.tree, revival), connected]), result)
  }
}
