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

// A step a gesture brings before it has an id, under a key of the gesture's own that its links name.
public struct ImportedStep: Sendable {
  public let key: String
  public let label: String
  public let icon: String
  public let color: String
  public let description: String
  public let links: [Step.Link]

  public init(key: String, label: String = Roadmap.Defaults.Node.label, icon: String = Roadmap.Defaults.Node.icon,
              color: String = Roadmap.Defaults.Node.color, description: String = Roadmap.Defaults.Node.description, links: [Step.Link] = []) {
    self.key = key
    self.label = label
    self.icon = icon
    self.color = color
    self.description = description
    self.links = links
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

  func write(to plan: inout Plan) {
    plan.create(step)
    for link in links { plan.create(link) }
  }
}

// What an import brings to a new roadmap: its steps under fresh ids, in the order they follow one another, each keyed after
// the steps before it under its trunk parent, with the links that lead to it.
struct StepsImport {
  let units: [ImportUnit]
  // Each step's id by its key, in the import's order.
  let ids: [(key: String, id: ID<RoadmapStep>)]

  // A loop among the import's links is refused before an id is minted, a step past a bound at its place in the import.
  init(_ imported: ImportedSteps, in scope: ScopeRef, at moment: Moment, ids: ActIDSource) throws(Violation) {
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
    var units: [ImportUnit] = []
    while units.count < keys.count {
      guard let index = waiting.firstIndex(of: 0) else { preconditionFailure("an import without a loop orders every step") }
      waiting[index] = -1
      for link in links where link.from == index { waiting[link.to] -= 1 }
      let step = imported.steps[index]
      let leading = links.filter { $0.to == index }.map { minted[$0.from] }
      let ord = FractionalKey(after: lastOrd[leading.first])
      lastOrd[leading.first] = ord
      let valid: Valid<RoadmapStep>
      do throws(Violation) {
        valid = try Valid(RoadmapStep(id: minted[index], label: step.label, icon: step.icon, color: step.color, ord: ord.text,
                                      description: step.description, links: step.links), at: moment)
      } catch {
        throw error.at(Path("steps") + index)
      }
      var made: [Valid<RoadmapLink>] = []
      for from in leading { made.append(try Valid(RoadmapLink(from: from, to: minted[index]), at: moment)) }
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
