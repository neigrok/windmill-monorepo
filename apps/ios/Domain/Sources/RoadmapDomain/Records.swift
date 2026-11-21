import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// Values by an id or a hue, the same only byte for byte: a String key would fold canonically equivalent spellings into one.
typealias ByText<Value> = [[UInt8]: Value]

extension Dictionary where Key == [UInt8] {
  subscript(text: String) -> Value? {
    get { self[Array(text.utf8)] }
    set { self[Array(text.utf8)] = newValue }
  }

  subscript(text: String, default fallback: @autoclosure () -> Value) -> Value {
    get { self[Array(text.utf8), default: fallback()] }
    set { self[Array(text.utf8)] = newValue }
  }
}

extension Array where Element: Hashable {
  // The elements, then each of `more` they do not hold yet, once.
  func adding(new more: [Element]) -> [Element] {
    var held = Set(self)
    return self + more.filter { held.insert($0).inserted }
  }

  // Each element once, at the place it first came.
  var unique: [Element] { [Element]().adding(new: self) }
}

extension Sequence {
  // One element a key: the last given, at the place the first came.
  func lastByKey(_ key: (Element) -> String) -> [Element] {
    var places = ByText<Int>()
    var kept: [Element] = []
    for element in self {
      if let place = places[key(element)] {
        kept[place] = element
      } else {
        places[key(element)] = kept.count
        kept.append(element)
      }
    }
    return kept
  }

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
protocol Authored {
  var id: String { get }
  var ord: String { get }
  var born: Stamp { get }
}

func authoredOrder<Record: Authored>(_ a: Record, _ b: Record) -> Bool {
  if !a.ord.utf8.elementsEqual(b.ord.utf8) { return a.ord.utf8.lexicographicallyPrecedes(b.ord.utf8) }
  if a.born != b.born { return a.born < b.born }
  return a.id.utf8.lexicographicallyPrecedes(b.id.utf8)
}

extension FractionalKey {
  // The key that places a record after `last`, or first where nothing comes before it.
  init(after last: FractionalKey?) {
    do { try self.init(between: last, and: nil) }
    catch { preconditionFailure("no order key follows \(last?.text ?? "the start"): \(error)") }
  }

  // The key that moves a record holding `own` below `above` among `members`, which do not hold it, or to their top: after
  // `above` and before the member that follows it. Nil for a drop in place, the record already sitting below `above`.
  init?(moving moved: JSON, from own: FractionalKey?, below above: JSON?, among members: [ListMember]) {
    if let own, members.sorted().last(where: { $0 < ListMember(id: moved, key: own) })?.id == above { return nil }
    do { try self.init(dropping: moved, below: above, stored: members, drawn: members) }
    catch { preconditionFailure("no order key drops \(moved.jcsText) below \(above?.jcsText ?? "the top"): \(error)") }
  }
}

func edgeOrder(_ a: RoadmapTree.Edge, _ b: RoadmapTree.Edge) -> Bool {
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
  // Its owner's marks and pointers, one a step, in the order their records came.
  public let marks: [Mark]
  public let pointers: [Pointer]
  public let index: TreeIndex
  let steps: ByText<Step>
  let marksByStep: ByText<Mark>
  let pointersByStep: ByText<Pointer>

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
    self.marks = marks.lastByKey(\.node)
    self.pointers = pointers.lastByKey(\.node)
    marksByStep = Dictionary(uniqueKeysWithValues: self.marks.map { (Array($0.node.utf8), $0) })
    pointersByStep = Dictionary(uniqueKeysWithValues: self.pointers.map { (Array($0.node.utf8), $0) })
    index = TreeIndex(nodes: self.nodes, edges: self.edges, marks: marksByStep, pointers: pointersByStep)
  }

  public func step(_ id: String) -> Step? { steps[id] }
  public func mark(on step: String) -> Mark? { marksByStep[step] }
  public func pointer(on step: String) -> Pointer? { pointersByStep[step] }
}

// A tree's records by slot, derived once for every read over it: its present steps in authored order, then every other id a live link names.
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

  public func slot(of id: String) -> Int? {
    vertices[id].flatMap { $0 < ids.count ? $0 : nil }
  }

  // The absent steps a present step is linked from over live links; none for a step that is not present.
  public func absentParents(_ id: String) -> [String] {
    guard let slot = slot(of: id) else { return [] }
    return parents[slot].filter { $0 >= ids.count }.map { rawIds[$0] }
  }

  // The last order key among the present steps a new step joins: those its trunk parent leads to over live links, or, with
  // no parent, those no live link leads to. A step that holds no key that orders bounds nothing.
  func lastKey(under parent: String?) -> FractionalKey? {
    let siblings: [Int]
    if let parent {
      siblings = vertices[parent].map { children[$0].filter { $0 < nodes.count } } ?? []
    } else {
      siblings = nodes.indices.filter { parents[$0].isEmpty }
    }
    return siblings.compactMap { try? FractionalKey(nodes[$0].ord) }.max()
  }
}

// §6 The order the device knows of a roadmap's writes, by the server's sequence numbers, read in its tree scope. A step or
// a link the device wrote has landed once the server's copy of it holds every write of the device's own, as the device has
// pulled it; one it holds no record of at all was deleted after, its own write long settled. A link met the delete of the
// step it comes from when the server took the delete, at its spent id's `seq`, before it took the link, at the `seq` of
// the link's copy. A delete taken after met nothing of the device's, and one the device knows no `seq` of, its own delete
// the server has not yet sent back among them, meets nothing. Before the roadmap's first pull completes nothing has landed.
struct LandingOrder {
  let read: Reader
  let pulled: Bool

  init(_ read: Reader) throws {
    self.read = read
    pulled = try read.firstPullComplete()
  }

  func landed<E: Entity>(_ id: ID<E>) throws -> Bool {
    guard pulled else { return false }
    guard let drawn = try read.repository(E.self).record(id, in: .drawn) else { return true }
    guard let confirmed = try read.confirmed(E.self, id) else { return false }
    return drawn.life == confirmed.life && drawn.born == confirmed.born && drawn.values == confirmed.values && drawn.stamps == confirmed.stamps
  }

  func met(_ link: RoadmapLink) throws -> Bool {
    guard let deleted = try read.repository(RoadmapStep.self).spentSeq(link.from),
          let linked = try read.confirmed(RoadmapLink.self, link.id)?.seq else { return false }
    return try landed(link.id) && deleted < linked
  }
}

// The device's own note of what it made and revived in one roadmap (§6), held in its `landing:<tree>` row until the person
// has been told, or until it can tell nothing: its new steps, its new links, the steps its changes brought back, and the
// name of each step a link it still notes comes from, as it was when the device made the link. The device keeps nothing of
// a step deleted elsewhere (engine §7.5), so a line that names one reads it here. The row never leaves the device.
public struct LandingNote: Sendable {
  public struct Name: Sendable {
    public let id: ID<RoadmapStep>
    public let name: String
  }

  // The names a note keeps at most, one for each step a roadmap holds at most (§4); the oldest goes first.
  static let namesKept = 10_000

  public let nodes: [ID<RoadmapStep>]
  public let edges: [RoadmapLink]
  public let revived: [ID<RoadmapStep>]
  public let names: [Name]

  // A name is kept only while a link from its step is noted.
  init(nodes: [ID<RoadmapStep>] = [], edges: [RoadmapLink] = [], revived: [ID<RoadmapStep>] = [], names: [Name] = []) {
    self.nodes = nodes
    self.edges = edges
    self.revived = revived
    self.names = names.filter { name in edges.contains { $0.from == name.id } }
  }

  // The note a device row holds, read leniently: a part that is not what the note keeps there is left out.
  init(row: JSON?) {
    let steps = { (list: JSON?) -> [ID<RoadmapStep>] in
      guard case .array(let items)? = list else { return [] }
      return items.compactMap { if case .string(let id) = $0 { ID(RecordID(id)) } else { nil } }
    }
    var edges: [RoadmapLink] = []
    if case .array(let links)? = row?["edges"] {
      for link in links {
        guard case .array(let ends) = link, ends.count == 2, case .string(let from) = ends[0], case .string(let to) = ends[1] else { continue }
        edges.append(RoadmapLink(from: ID(RecordID(from)), to: ID(RecordID(to))))
      }
    }
    var names: [Name] = []
    if case .array(let entries)? = row?["names"] {
      for entry in entries {
        guard case .string(let id)? = entry["id"], case .string(let name)? = entry["name"] else { continue }
        names.append(Name(id: ID(RecordID(id)), name: name))
      }
    }
    self.init(nodes: steps(row?["nodes"]), edges: edges, revived: steps(row?["revived"]), names: names)
  }

  // The device's note of one roadmap as its row holds it.
  init(of tree: ID<RoadmapEntry>, in read: Reader) throws {
    self.init(row: try read.device(LandingNote.key(of: tree)))
  }

  // §6 The note as a write of it takes it, read in the roadmap's tree scope: less each entry whose write has landed and
  // that says nothing of the roadmap as it now stands, a step or a link of the device's through which no line is said, and
  // a step its change brought back that is absent again. A line is said only of a delete the server took before the write,
  // and once the write has landed the device holds every such delete, so an entry let go of could never say more.
  init(settledOf tree: ID<RoadmapEntry>, in read: Reader, roadmap: RoadmapTree) throws {
    let held = try LandingNote(of: tree, in: read)
    let order = try LandingOrder(read)
    let said = try held.saying(of: roadmap, by: order)
    self.init(
      nodes: try held.nodes.filter { (step: ID<RoadmapStep>) throws -> Bool in
        try !order.landed(step) || said.contains { $0.to == step }
      },
      edges: try held.edges.filter { (link: RoadmapLink) throws -> Bool in try !order.landed(link.id) || said.contains(link) },
      revived: try held.revived.filter { (step: ID<RoadmapStep>) throws -> Bool in
        try !order.landed(step) || roadmap.step(step.description)?.present == true
      },
      names: held.names)
  }

  static func key(of tree: ID<RoadmapEntry>) -> String { "landing:\(tree)" }

  // The note with what the device made or revived added, each once; a step's newer name replaces the one noted before.
  func adding(nodes made: [ID<RoadmapStep>] = [], edges linked: [RoadmapLink] = [], revived brought: [ID<RoadmapStep>] = [],
              names given: [Name] = []) -> LandingNote {
    let named = (names + given).lastByKey(\.id.description).suffix(LandingNote.namesKept)
    return LandingNote(nodes: nodes.adding(new: made), edges: edges.adding(new: linked), revived: revived.adding(new: brought), names: Array(named))
  }

  // The note less what was told.
  func clearing(nodes told: [ID<RoadmapStep>], edges linked: [RoadmapLink], revived brought: [ID<RoadmapStep>]) -> LandingNote {
    LandingNote(nodes: nodes.filter { !told.contains($0) }, edges: edges.filter { !linked.contains($0) },
                revived: revived.filter { !brought.contains($0) }, names: names)
  }

  // The links whose lines the note says of the roadmap as it now stands: each link it notes, and each into a step it notes,
  // that is read through a step the server took the delete of before it took the link.
  func saying(of roadmap: RoadmapTree, by order: LandingOrder) throws -> [RoadmapLink] {
    let through = { (step: ID<RoadmapStep>) -> [RoadmapLink] in
      roadmap.index.absentParents(step.description).map { RoadmapLink(from: ID(RecordID($0)), to: step) }
    }
    let bridging = nodes.flatMap(through) + edges.filter { through($0.to).contains($0) }
    return try bridging.unique.filter(order.met)
  }

  // The name the note keeps of a step.
  func name(of step: ID<RoadmapStep>) -> String? { names.first { $0.id == step }?.name }

  var isEmpty: Bool { nodes.isEmpty && edges.isEmpty && revived.isEmpty }

  public var json: JSON {
    let links: [JSON] = edges.map { [$0.from.json, $0.to.json] }
    let named: [JSON] = names.map { ["id": $0.id.json, "name": .string($0.name)] }
    return ["nodes": .array(nodes.map(\.json)), "edges": .array(links), "revived": .array(revived.map(\.json)), "names": .array(named)]
  }
}

extension Plan {
  // §6 The device's note of a roadmap as a write leaves it: its row, or no row once it notes nothing.
  mutating func note(_ note: LandingNote, of tree: ID<RoadmapEntry>) {
    device(LandingNote.key(of: tree), note.isEmpty ? nil : note.json)
  }
}
