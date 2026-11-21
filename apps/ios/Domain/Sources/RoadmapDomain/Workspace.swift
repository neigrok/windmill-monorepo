import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A step's private workspace, in its owner's overlay (R-3): its subtasks, its links and its note. Subtasks and links keep
// their order in the overlay's one list of their type, which keeps each step's items in order.

// A subtask or a link of a step's workspace.
public protocol WorkspaceItem: Writable, Removable, Ordered {
  // What a gesture names of an item: a change writes each field it names, and a new item takes each over the registry's
  // default.
  associatedtype Changes: Sendable
  var step: ID<RoadmapStep> { get }
  init(id: ID<Self>, step: ID<RoadmapStep>)
  // The item with each field the changes name, and the names.
  func taking(_ changes: Changes) -> (item: Self, named: [String])
}

public struct Subtask: WorkspaceItem {
  public static let type = Roadmap.Types.subtask
  public static let orderField = "ord"
  public static let heldRemoval = true

  public struct Changes: Sendable {
    public var label: String?
    public var done: Bool?

    public init(label: String? = nil, done: Bool? = nil) {
      self.label = label
      self.done = done
    }
  }

  public let id: ID<Subtask>
  public let step: ID<RoadmapStep>
  public var label: String
  public var done: Bool

  public init(id: ID<Subtask>, step: ID<RoadmapStep>, label: String, done: Bool) {
    self.id = id
    self.step = step
    self.label = label
    self.done = done
  }

  public init(id: ID<Subtask>, step: ID<RoadmapStep>) {
    self.init(id: id, step: step, label: Roadmap.Defaults.Subtask.label, done: Roadmap.Defaults.Subtask.done)
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), step: try r.ref("step", RoadmapStep.self), label: try r.string("label", default: Roadmap.Defaults.Subtask.label),
              done: try r.bool("done", default: Roadmap.Defaults.Subtask.done))
  }

  public var fields: [String: JSON] { ["step": step.json, "label": .string(label), "done": .bool(done)] }

  public static let checks: [Check<Subtask>] = [
    Check("label") { s, _ in s.label = try RoadmapSpecs.subtask.apply(s.label, at: "label") },
  ]

  public func taking(_ changes: Changes) -> (item: Subtask, named: [String]) {
    var item = self
    var named: [String] = []
    if let label = changes.label {
      item.label = label
      named.append("label")
    }
    if let done = changes.done {
      item.done = done
      named.append("done")
    }
    return (item, named)
  }
}

// A link a person keeps beside a step, apart from the links the step itself carries (`Step.Link`).
public struct WorkspaceLink: WorkspaceItem {
  public static let type = Roadmap.Types.stepLink
  public static let orderField = "ord"
  public static let heldRemoval = true

  public struct Changes: Sendable {
    public var url: String?
    public var title: String?

    public init(url: String? = nil, title: String? = nil) {
      self.url = url
      self.title = title
    }
  }

  public let id: ID<WorkspaceLink>
  public let step: ID<RoadmapStep>
  public var url: String
  public var title: String

  public init(id: ID<WorkspaceLink>, step: ID<RoadmapStep>, url: String, title: String) {
    self.id = id
    self.step = step
    self.url = url
    self.title = title
  }

  public init(id: ID<WorkspaceLink>, step: ID<RoadmapStep>) {
    self.init(id: id, step: step, url: "", title: Roadmap.Defaults.StepLink.title)
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), step: try r.ref("step", RoadmapStep.self), url: try r.string("url", default: ""),
              title: try r.string("title", default: Roadmap.Defaults.StepLink.title))
  }

  public var fields: [String: JSON] { ["step": step.json, "url": .string(url), "title": .string(title)] }

  public static let checks: [Check<WorkspaceLink>] = [
    Check("url") { l, _ in l.url = try RoadmapSpecs.url.apply(l.url, at: "url") },
    Check("title") { l, _ in l.title = try RoadmapSpecs.linkTitle.apply(l.title, at: "title") },
  ]

  public func taking(_ changes: Changes) -> (item: WorkspaceLink, named: [String]) {
    var item = self
    var named: [String] = []
    if let url = changes.url {
      item.url = url
      named.append("url")
    }
    if let title = changes.title {
      item.title = title
      named.append("title")
    }
    return (item, named)
  }
}

// A step's note: one text, merged by the engine, saved from a draft, each save an act an Undo names.
public struct StepNote: Draftable {
  public static let type = Roadmap.Types.stepNote
  public static let savesGuarded = false
  public static let savesReversibly = true

  public let id: ID<StepNote>
  public var text: String

  public init(id: ID<StepNote>, text: String = "") {
    self.id = id
    self.text = text
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), text: r.text("text"))
  }

  public var fields: [String: JSON] { ["text": .string(text)] }

  public static let checks: [Check<StepNote>] = [
    Check("text") { n, _ in n.text = try RoadmapSpecs.note.apply(n.text, at: "text") },
  ]
}

// A step's note is edited in one draft, opened from what the overlay draws or new, and saved by the kit's draft save, its
// text merged by the engine. Its Undo restores the text the draft was saved from, and skips where a write the device had
// not seen changed the note.
public typealias SaveStepNote = SaveDraft<StepNote, RoadmapRefusal>

public typealias AddSubtask = AddToWorkspace<Subtask>
public typealias ChangeSubtask = ChangeInWorkspace<Subtask>
public typealias MoveSubtask = MoveInWorkspace<Subtask>
public typealias DeleteSubtask = RemoveFromWorkspace<Subtask>
public typealias AddStepLink = AddToWorkspace<WorkspaceLink>
public typealias ChangeStepLink = ChangeInWorkspace<WorkspaceLink>
public typealias MoveStepLink = MoveInWorkspace<WorkspaceLink>
public typealias DeleteStepLink = RemoveFromWorkspace<WorkspaceLink>

// A new subtask or link, at the bottom of its type's list. Its step must be one the roadmap knows, present or deleted
// elsewhere. An item given its id is made once: where the overlay holds that id, or knows it deleted, nothing is written.
public struct AddToWorkspace<Item: WorkspaceItem>: ActAction {
  public typealias Loaded = (stepKnown: Bool, held: Bool, anchor: RecordID?, capacity: Capacity, moment: Moment)

  public let tree: ID<RoadmapEntry>
  public let step: ID<RoadmapStep>
  public let item: Item.Changes
  // The id its surface gave the item, nil to mint one.
  public let id: ID<Item>?

  public init(tree: ID<RoadmapEntry>, step: ID<RoadmapStep>, item: Item.Changes, id: ID<Item>? = nil) {
    self.tree = tree
    self.step = step
    self.item = item
    self.id = id
  }

  public func load(_ read: ActReader) throws -> Loaded {
    let stepKnown = try read.inScope(tree.tree) { (scope: Reader) throws -> Bool in
      try HeldRecord(RoadmapStep(id: step), in: scope.repository(RoadmapStep.self)).isKnown
    }
    return try read.inScope(tree.overlay) { (overlay: Reader) throws -> Loaded in
      let items = overlay.repository(Item.self)
      let held = try id.map { (given: ID<Item>) throws -> Bool in try items.record(given, in: .stored) != nil || items.spentBorn(given) != nil }
      return (stepKnown, held ?? false, try items.anchor(.bottom), try items.capacity(), overlay.moment)
    }
  }

  public func decide(_ loaded: Loaded, ids: ActIDSource) throws(Violation) -> ActDecision<ID<Item>, RoadmapRefusal> {
    guard loaded.stepKnown else { return .refuse(.gone(step.ref, .predicted)) }
    if let id, loaded.held { return .unchanged(id) }
    let made = id ?? ids.mint(Item.self, inScope: tree.overlay)
    let valid = try Valid(Item(id: made, step: step).taking(item).item, at: loaded.moment)
    if let full = loaded.capacity.refusal(growing: 1, subject: made.ref) { return .refuse(RoadmapRefusal(full)) }
    var plan = Plan()
    plan.insert(valid, below: loaded.anchor)
    plan.undoBy(.createdRecord(restoreCommand: Roadmap.Commands.restoreOverlay, record: .of(made)))
    return .write(plan, in: tree.overlay, made)
  }
}

// A subtask's or a link's own fields, changed: the fields the change names whose value differs.
public struct ChangeInWorkspace<Item: WorkspaceItem>: ActAction {
  public let tree: ID<RoadmapEntry>
  public let id: ID<Item>
  public let changes: Item.Changes

  public init(tree: ID<RoadmapEntry>, id: ID<Item>, changes: Item.Changes) {
    self.tree = tree
    self.id = id
    self.changes = changes
  }

  public func load(_ read: ActReader) throws -> (item: Item?, moment: Moment) {
    try read.inScope(tree.overlay) { (overlay: Reader) throws -> (item: Item?, moment: Moment) in
      (try overlay.repository(Item.self).find(id, in: .drawn), overlay.moment)
    }
  }

  public func decide(_ loaded: (item: Item?, moment: Moment), ids: ActIDSource) throws(Violation) -> ActDecision<Void, RoadmapRefusal> {
    guard let item = loaded.item else { return .refuse(.gone(id.ref, .predicted)) }
    let taken = item.taking(changes)
    let valid = try Valid(taken.item, fields: taken.named, at: loaded.moment)
    let changed = valid.changed(from: item)
    guard !changed.isEmpty else { return .unchanged(()) }
    var plan = Plan()
    plan.update(valid, fields: changed)
    plan.undoBy(.restoring(id, fields: changed, by: Roadmap.Commands.restoreOverlay))
    return .write(plan, in: tree.overlay, ())
  }
}

// A subtask or a link moved below another of its step's, or to their top. A drop in place writes nothing.
public struct MoveInWorkspace<Item: WorkspaceItem>: ActAction {
  public let tree: ID<RoadmapEntry>
  public let id: ID<Item>
  public let below: ID<Item>?

  public init(tree: ID<RoadmapEntry>, id: ID<Item>, below: ID<Item>?) {
    self.tree = tree
    self.id = id
    self.below = below
  }

  // Whether the overlay draws the item, and its step's items in their order.
  public func load(_ read: ActReader) throws -> (drawn: Bool, siblings: [ID<Item>]) {
    try read.inScope(tree.overlay) { (overlay: Reader) throws -> (drawn: Bool, siblings: [ID<Item>]) in
      let items = overlay.repository(Item.self)
      guard let item = try items.find(id, in: .drawn) else { return (false, []) }
      return (true, try items.children(of: item.step, via: "step", in: .drawn).map(\.id))
    }
  }

  public func decide(_ loaded: (drawn: Bool, siblings: [ID<Item>]), ids: ActIDSource) -> ActDecision<Void, RoadmapRefusal> {
    guard loaded.drawn else { return .refuse(.gone(id.ref, .predicted)) }
    if let below, !loaded.siblings.contains(below) { return .refuse(.gone(below.ref, .predicted)) }
    let above = loaded.siblings.firstIndex(of: id).flatMap { $0 > 0 ? loaded.siblings[$0 - 1] : nil }
    guard below != id, below != above else { return .unchanged(()) }
    var plan = Plan()
    plan.move(id, below: below)
    plan.undoBy(.restoring(id, fields: [Item.orderField], by: Roadmap.Commands.restoreOverlay))
    return .write(plan, in: tree.overlay, ())
  }
}

// A subtask's or a link's death, held and terminal: an Undo in its hold is its one way back.
public struct RemoveFromWorkspace<Item: WorkspaceItem>: ActAction {
  public let tree: ID<RoadmapEntry>
  public let id: ID<Item>

  public init(tree: ID<RoadmapEntry>, id: ID<Item>) {
    self.tree = tree
    self.id = id
  }

  public func load(_ read: ActReader) throws -> Item? {
    try read.inScope(tree.overlay) { (overlay: Reader) throws -> Item? in try overlay.repository(Item.self).find(id, in: .drawn) }
  }

  public func decide(_ drawn: Item?, ids: ActIDSource) -> ActDecision<Void, RoadmapRefusal> {
    guard drawn != nil else { return .unchanged(()) }
    var plan = Plan()
    plan.remove(id)
    return .write(plan, in: tree.overlay, ())
  }
}
