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

// One record of a roadmap as a replica holds it, visible or not, with the stamp each of its registers was written under.
// The engine's `Record` carries a register's value alone; a mark's date, a pointer's order and a subtree's are read from
// the stamps.
public struct StampedRecord: Sendable {
  public let record: Record
  public let stamps: [String: Stamp]

  public init(_ record: Record, stamps: [String: Stamp] = [:]) {
    self.record = record
    self.stamps = stamps
  }

  func holds<E: Entity>(_ entity: E.Type) -> Bool { record.type.utf8.elementsEqual(E.type.utf8) }
  var present: Bool { record.life?.isAlive == true }
}

extension RoadmapTree {
  // One roadmap as a device's replica holds it. `tree` is every record of its tree scope: its steps and links, absent ones
  // kept, its meta and its kinds. `overlay` is every record of its owner's overlay, for the marks and pointers, nil where
  // the reader takes none (a roadmap someone else owns); `queued` are the overlay's records an entry the device still
  // queues changes. `listed` is its entry in the person's own list, nil where it is not theirs: it says whether the roadmap
  // is present and where it sits, and without it the meta says where. `read` says the device holds the server's whole copy:
  // the first pull of every scope it is read through has ended. Before that it is read only where the device holds records
  // of it and the server has sent none of them, nor of its overlay (none carries the server's `ru`): a roadmap the device
  // made, which the server does not hold yet. A pull under way leaves it unread, whatever it has brought.
  // §5 Dates: the server has received a mark once no queued entry still changes it, and its time is its record's `ru`; a
  // mark an entry still changes is the device's, timed by its stamp. A roadmap was last changed when the server last
  // received a record of it: the newest `ru` among its entry, its tree scope's records and its overlay's.
  public init(id: ID<RoadmapEntry>, listed: Record?, tree: [StampedRecord], overlay: [StampedRecord]?, queued: [RecordKey] = [],
              read: Bool = true) throws(DecodeError) {
    let overlaid = overlay ?? []
    var meta: RoadmapMeta?
    var nodes: [Step] = []
    var edges: [Edge] = []
    var kinds: [Kind] = []
    for held in tree {
      let record = held.record
      if held.holds(RoadmapMeta.self), record.id == RoadmapMeta.singleton.record { meta = try RoadmapMeta(Fields(record)) }
      if held.holds(RoadmapStep.self) {
        let step = try RoadmapStep(Fields(record))
        nodes.append(Step(id: step.id.description, present: held.present, born: record.born, rc: record.rc.map(Instant.init(ms:)),
                          ru: record.ru.map(Instant.init(ms:)), label: step.label, icon: step.icon, color: step.color, ord: step.ord,
                          status: step.status, description: step.description, links: step.links, branch: step.branch?.description,
                          branchStamp: held.stamps["branch"]))
      }
      if held.holds(RoadmapLink.self) {
        let link = try RoadmapLink(Fields(record))
        edges.append(Edge(from: link.from.description, to: link.to.description, present: held.present))
      }
      if held.holds(RoadmapKind.self) {
        let kind = try RoadmapKind(Fields(record))
        kinds.append(Kind(id: kind.id.description, present: held.present, born: record.born, hue: kind.hue, label: kind.label,
                          description: kind.description, ord: kind.ord))
      }
    }
    var marks: [Mark] = []
    var pointers: [Pointer] = []
    for held in overlaid {
      let record = held.record
      if held.holds(StepMark.self) {
        let mark = try StepMark(Fields(record))
        let stamp = held.stamps["mark"]
        let received = queued.contains(RecordKey(record.type, record.id)) ? nil : record.ru.map(Instant.init(ms:))
        marks.append(Mark(node: mark.id.description, status: mark.status, outOfOrder: mark.outOfOrder, recordedAt: received,
                          deviceAt: stamp.map { Instant(ms: $0.ms) }, stamp: stamp))
      }
      if held.holds(StepPointer.self) {
        let pointer = try StepPointer(Fields(record))
        pointers.append(Pointer(node: pointer.id.description, present: held.present, opens: pointer.opens?.description ?? "",
                                setAt: held.stamps["opens"]))
      }
    }
    let place: RoadmapEntry.Parent?
    if let listed { place = try RoadmapEntry(Fields(listed)).parent } else { place = meta?.parent }
    let held = tree + overlaid
    let received = ([listed?.ru] + held.map(\.record.ru)).compactMap { $0 }.max()
    let madeHere = !tree.isEmpty && held.allSatisfy { $0.record.ru == nil }
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
