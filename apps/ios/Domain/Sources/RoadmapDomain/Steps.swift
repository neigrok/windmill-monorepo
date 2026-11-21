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
}

// A link: an `edge` record keyed by the step it comes from and the step it leads to.
public struct RoadmapLink: Writable, Removable {
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
