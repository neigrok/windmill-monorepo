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
