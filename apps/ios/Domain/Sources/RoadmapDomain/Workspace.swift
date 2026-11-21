import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A step's private workspace, in its owner's overlay (R-3): its subtasks, its links and its note. Subtasks and links keep
// their order in the overlay's one list of their type, which keeps each step's items in order.

public struct Subtask: Writable, Removable, Ordered {
  public static let type = Roadmap.Types.subtask
  public static let orderField = "ord"
  public static let heldRemoval = true

  public let id: ID<Subtask>
  public let step: ID<RoadmapStep>
  public var label: String
  public var done: Bool

  public init(id: ID<Subtask>, step: ID<RoadmapStep>, label: String = Roadmap.Defaults.Subtask.label, done: Bool = Roadmap.Defaults.Subtask.done) {
    self.id = id
    self.step = step
    self.label = label
    self.done = done
  }

  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), step: try r.ref("step", RoadmapStep.self), label: try r.string("label", default: Roadmap.Defaults.Subtask.label),
              done: try r.bool("done", default: Roadmap.Defaults.Subtask.done))
  }

  public var fields: [String: JSON] { ["step": step.json, "label": .string(label), "done": .bool(done)] }

  public static let checks: [Check<Subtask>] = [
    Check("label") { s, _ in s.label = try RoadmapSpecs.subtask.apply(s.label, at: "label") },
  ]
}

// A link a person keeps beside a step, apart from the links the step itself carries (`Step.Link`).
public struct WorkspaceLink: Writable, Removable, Ordered {
  public static let type = Roadmap.Types.stepLink
  public static let orderField = "ord"
  public static let heldRemoval = true

  public let id: ID<WorkspaceLink>
  public let step: ID<RoadmapStep>
  public var url: String
  public var title: String

  public init(id: ID<WorkspaceLink>, step: ID<RoadmapStep>, url: String = "", title: String = Roadmap.Defaults.StepLink.title) {
    self.id = id
    self.step = step
    self.url = url
    self.title = title
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
