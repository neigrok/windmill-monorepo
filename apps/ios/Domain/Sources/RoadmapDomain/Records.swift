import DomainKit
import SyncCore
import SyncSchema

// Values by an id or a hue, the same only byte for byte: a String key would fold canonically equivalent spellings into one.
typealias ByText<Value> = [[UInt8]: Value]

extension Dictionary where Key == [UInt8] {
  subscript(text: String) -> Value? {
    get { self[Array(text.utf8)] }
    set { self[Array(text.utf8)] = newValue }
  }
}

extension Sequence {
  // Elements that tie keep the order they came in, which `sorted(by:)` leaves unspecified.
  func stablySorted(by precedes: (Element, Element) -> Bool) -> [Element] {
    enumerated().sorted { a, b in
      if precedes(a.element, b.element) { return true }
      if precedes(b.element, a.element) { return false }
      return a.offset < b.offset
    }.map(\.element)
  }
}

// A record its author placed: authored order is `(ord, born, id)`, ords and ids by their bytes, a missing birth unset.
public protocol Authored {
  var id: String { get }
  var ord: String { get }
  var born: Stamp { get }
}

public func authoredOrder<Record: Authored>(_ a: Record, _ b: Record) -> Bool {
  if !a.ord.utf8.elementsEqual(b.ord.utf8) { return a.ord.utf8.lexicographicallyPrecedes(b.ord.utf8) }
  if a.born != b.born { return a.born < b.born }
  return a.id.utf8.lexicographicallyPrecedes(b.id.utf8)
}

public func edgeOrder(_ a: RoadmapTree.Edge, _ b: RoadmapTree.Edge) -> Bool {
  if !a.from.utf8.elementsEqual(b.from.utf8) { return a.from.utf8.lexicographicallyPrecedes(b.from.utf8) }
  return a.to.utf8.lexicographicallyPrecedes(b.to.utf8)
}

// A `node` record, present while alive; a fact its record does not hold takes the registry's default.
public struct Step: Authored, Sendable {
  public struct Link: Sendable {
    public let url: String
    public let label: String

    public init(url: String, label: String) {
      self.url = url
      self.label = label
    }
  }

  public let id: String
  public let present: Bool
  public let born: Stamp
  public let rc: Instant?
  public let ru: Instant?
  public let label: String
  public let icon: String
  public let color: String
  public let ord: String
  public let status: String
  public let description: String
  public let links: [Link]
  // The subtree the step owns, and the stamp its register was written under.
  public let branch: String?
  public let branchStamp: Stamp?

  public init(id: String, present: Bool? = nil, born: Stamp? = nil, rc: Instant? = nil, ru: Instant? = nil, label: String? = nil,
              icon: String? = nil, color: String? = nil, ord: String? = nil, status: String? = nil, description: String? = nil,
              links: [Link]? = nil, branch: String? = nil, branchStamp: Stamp? = nil) {
    self.id = id
    self.present = present ?? true
    self.born = born ?? .unset
    self.rc = rc
    self.ru = ru
    self.label = label ?? Roadmap.Defaults.Node.label
    self.icon = icon ?? Roadmap.Defaults.Node.icon
    self.color = color ?? Roadmap.Defaults.Node.color
    self.ord = ord ?? ""
    self.status = status ?? "none"
    self.description = description ?? Roadmap.Defaults.Node.description
    self.links = links ?? []
    self.branch = branch
    self.branchStamp = branchStamp
  }
}

// A `kind` record of a roadmap's legend: the hue it wears and what it calls it.
public struct Kind: Authored, Sendable {
  public let id: String
  public let present: Bool
  public let born: Stamp
  public let hue: String
  public let label: String
  public let description: String
  public let ord: String

  public init(id: String, present: Bool? = nil, born: Stamp? = nil, hue: String, label: String? = nil, description: String? = nil,
              ord: String? = nil) {
    self.id = id
    self.present = present ?? true
    self.born = born ?? .unset
    self.hue = hue
    self.label = label ?? Roadmap.Defaults.Kind.label
    self.description = description ?? Roadmap.Defaults.Kind.description
    self.ord = ord ?? ""
  }
}

// A roadmap's normalized records: every step, absent ones kept, every link's presence, its kinds, and its owner's marks and pointers.
public struct RoadmapTree: Sendable {
  // What a reader holds of a roadmap: its records, or its place alone.
  public enum Read: String, Sendable {
    case loaded, unread
  }

  public struct Edge: Sendable {
    public let from: String
    public let to: String
    public let present: Bool

    public init(from: String, to: String, present: Bool) {
      self.from = from
      self.to = to
      self.present = present
    }
  }

  // A person's progress on a step; a step's authored status never supplies it.
  public struct Mark: Sendable {
    public let node: String
    public let status: String
    public let outOfOrder: Bool
    public let recordedAt: Instant?
    public let deviceAt: Instant?
    public let stamp: Stamp?

    public init(node: String, status: String, outOfOrder: Bool, recordedAt: Instant?, deviceAt: Instant?, stamp: Stamp? = nil) {
      self.node = node
      self.status = status
      self.outOfOrder = outOfOrder
      self.recordedAt = recordedAt
      self.deviceAt = deviceAt
      self.stamp = stamp
    }

    public var isComplete: Bool { status.utf8.elementsEqual("complete".utf8) }
    // When the server received it, else when the device made it.
    public var at: Instant? { recordedAt ?? deviceAt }
  }

  // The roadmap a step opens, and the stamp it was set under.
  public struct Pointer: Sendable {
    public let node: String
    public let present: Bool
    public let opens: String
    public let setAt: Stamp?

    public init(node: String, present: Bool, opens: String, setAt: Stamp? = nil) {
      self.node = node
      self.present = present
      self.opens = opens
      self.setAt = setAt
    }
  }

  // Where a subtree sits: the roadmap that holds its owning step, and that step.
  public struct Parent: Equatable, Sendable {
    public let tree: String
    public let step: String

    public init(tree: String, step: String) {
      self.tree = tree
      self.step = step
    }

    public static func == (a: Parent, b: Parent) -> Bool {
      a.tree.utf8.elementsEqual(b.tree.utf8) && a.step.utf8.elementsEqual(b.step.utf8)
    }
  }

  public struct Metadata: Sendable {
    public let title: String
    public let guide: String
    public let guideInherited: Bool
    public let root: String
    public let depth: Int
    public let visibility: String
    public let reach: String

    public init(title: String? = nil, guide: String? = nil, guideInherited: Bool? = nil, root: String, depth: Int? = nil,
                visibility: String? = nil, reach: String? = nil) {
      self.title = title ?? Roadmap.Defaults.Meta.title
      self.guide = guide ?? Roadmap.Defaults.Meta.guide
      self.guideInherited = guideInherited ?? Roadmap.Defaults.Meta.guideInherited
      self.root = root
      self.depth = depth ?? Roadmap.Defaults.Meta.depth
      self.visibility = visibility ?? Roadmap.Defaults.Meta.visibility
      self.reach = reach ?? Roadmap.Defaults.Meta.reach
    }
  }

  public let id: String
  public let present: Bool
  public let read: Read
  // Whether it is in the person's own list.
  public let own: Bool
  // When the server last received any record of it.
  public let updatedAt: Instant?
  public let parent: Parent?
  // Nil while its tree scope holds no meta.
  public let meta: Metadata?
  public let nodes: [Step]
  public let edges: [Edge]
  public let kinds: [Kind]
  public let index: TreeIndex
  let steps: ByText<Step>
  let marks: ByText<Mark>
  let pointers: ByText<Pointer>

  public init(id: String, present: Bool? = nil, read: Read? = nil, own: Bool? = nil, updatedAt: Instant? = nil, parent: Parent? = nil,
              meta: Metadata?, nodes: [Step] = [], edges: [Edge] = [], kinds: [Kind] = [], marks: [Mark] = [], pointers: [Pointer] = []) {
    self.id = id
    self.present = present ?? true
    self.read = read ?? .loaded
    self.own = own ?? false
    self.updatedAt = updatedAt
    self.parent = parent
    self.meta = meta
    self.nodes = nodes.sorted(by: authoredOrder)
    self.edges = edges.stablySorted(by: edgeOrder)
    self.kinds = kinds.sorted(by: authoredOrder)
    steps = Dictionary(nodes.map { (Array($0.id.utf8), $0) }) { _, last in last }
    let kindIds = Set(kinds.map { Array($0.id.utf8) })
    precondition(steps.count == nodes.count && kindIds.count == kinds.count, "Duplicate normalized roadmap identity")
    self.marks = Dictionary(marks.map { (Array($0.node.utf8), $0) }) { _, last in last }
    self.pointers = Dictionary(pointers.map { (Array($0.node.utf8), $0) }) { _, last in last }
    index = TreeIndex(nodes: self.nodes, edges: self.edges, marks: self.marks, pointers: self.pointers)
  }

  public func step(_ id: String) -> Step? { steps[id] }
  public func mark(on step: String) -> Mark? { marks[step] }
  public func pointer(on step: String) -> Pointer? { pointers[step] }
}

// A tree's records by slot, derived once and shared by every read over it: its present steps in authored order, then every other id a live link names.
public struct TreeIndex: Sendable {
  public let nodes: [Step]
  public let ids: [String]
  public let edges: [RoadmapTree.Edge]
  // Every vertex: a present step at its slot, then the absent ids in link order.
  public let rawIds: [String]
  public let parents: [[Int]]
  public let children: [[Int]]
  // Which present steps the tree's own marks complete, a step that owns a subtree or opens a roadmap taking none, and when.
  public let markedDone: [Bool]
  public let markedAt: [Instant?]
  let vertices: ByText<Int>

  init(nodes: [Step], edges: [RoadmapTree.Edge], marks: ByText<RoadmapTree.Mark>, pointers: ByText<RoadmapTree.Pointer>) {
    let present = nodes.filter(\.present)
    var rawIds = present.map(\.id)
    var vertices = ByText<Int>(uniqueKeysWithValues: rawIds.enumerated().map { (Array($0.element.utf8), $0.offset) })
    var parents = [[Int]](repeating: [], count: rawIds.count)
    var children = parents
    func vertexOf(_ id: String) -> Int {
      if let known = vertices[id] { return known }
      vertices[id] = rawIds.count
      rawIds.append(id)
      parents.append([])
      children.append([])
      return rawIds.count - 1
    }
    let live = edges.filter(\.present)
    for edge in live {
      let (from, to) = (vertexOf(edge.from), vertexOf(edge.to))
      parents[to].append(from)
      children[from].append(to)
    }
    var markedDone = [Bool](repeating: false, count: present.count)
    var markedAt = [Instant?](repeating: nil, count: present.count)
    for (slot, node) in present.enumerated() {
      guard let mark = marks[node.id] else { continue }
      markedAt[slot] = mark.at
      markedDone[slot] = mark.isComplete && (node.branch ?? "").isEmpty && pointers[node.id]?.present != true
    }
    self.nodes = present
    ids = present.map(\.id)
    self.edges = live
    self.rawIds = rawIds
    self.parents = parents
    self.children = children
    self.markedDone = markedDone
    self.markedAt = markedAt
    self.vertices = vertices
  }

  public func vertex(of id: String) -> Int? { vertices[id] }

  public func slot(of id: String) -> Int? {
    vertices[id].flatMap { $0 < ids.count ? $0 : nil }
  }

  // The absent steps a present step is linked from over live links; none for a step that is not present.
  public func absentParents(_ id: String) -> [String] {
    guard let slot = slot(of: id) else { return [] }
    return parents[slot].filter { $0 >= ids.count }.map { rawIds[$0] }
  }
}
