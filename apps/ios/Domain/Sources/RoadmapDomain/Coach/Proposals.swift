import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// Roadmap Coach §7: a proposal's changes (D-6), their fold over a scratch copy of the standing roadmap (D-2), and the
// ability that mints a proposal of them, `propose_roadmap_change`. A change is one flat object, its `op` and the fields its
// row names. The fold reads a change in a record's form, each new step or kind under the id it is to have, so it folds a set
// as the call sends it, each `ref` standing for its id, and as a record holds it, each ref under its minted id, alike: the
// review and Apply fold a record again. It validates each change over the copy as the changes before it left it and names
// every register each writes, the proposal's base. Nothing here is written: a proposal is written by nobody until the
// person applies it.

// One register of a proposal's base (§7): the type and id of its record, `life` or the field, and the copy's stamp of it,
// none for a record the copy does not hold.
public struct BaseRegister: Sendable, Equatable {
  public let t: String
  public let id: JSON
  public let register: String
  public let stamp: String?

  public var json: JSON { ["t": .string(t), "id": id, "register": .string(register), "stamp": .of(stamp)] }
}

// What a proposal's record holds of a set: its changes, each new step and kind under its id, and its base.
public struct MintedProposal: Sendable, Equatable {
  public let changes: [JSON]
  public let base: [BaseRegister]
}

// What `propose_roadmap_change` answers: the proposal minted, with what the call answers (§7's `{proposalId, removes}`), or
// the refusal of the call.
public enum ProposalAnswer: Sendable {
  case minted(MintedProposal, result: JSON)
  case refused(CoachRefusal)
}

// The types of record a proposal mints an id for: the proposal itself, and each new step and kind its refs name.
public enum ProposalMint: String, Sendable {
  case coachProposal, node, kind
}

// §7 Each op of a change, by the fields its row names, required and then optional.
public enum ProposalOps {
  public struct Row: Sendable, Equatable {
    public let required: [String]
    public let optional: [String]

    public init(required: [String], optional: [String]) {
      self.required = required
      self.optional = optional
    }
  }

  public static let rows: [String: Row] = [
    "add_step": Row(required: ["ref", "label"], optional: ["description", "kind", "prerequisites", "links"]),
    "remove_step": Row(required: ["nodeId"], optional: []),
    "rename": Row(required: ["nodeId", "label"], optional: []),
    "describe": Row(required: ["nodeId"], optional: ["description", "links"]),
    "set_kind": Row(required: ["nodeId", "kind"], optional: []),
    "connect": Row(required: ["nodeId", "prerequisiteId"], optional: []),
    "disconnect": Row(required: ["nodeId", "prerequisiteId"], optional: []),
    "merge": Row(required: ["nodeId", "removeId"], optional: ["label", "description"]),
    "split": Row(required: ["nodeId", "parts"], optional: []),
    "set_progress": Row(required: ["nodeId", "status"], optional: []),
    "add_kind": Row(required: ["ref", "label", "hue"], optional: ["description"]),
    "rename_kind": Row(required: ["kind", "label"], optional: []),
    "recolor_kind": Row(required: ["kind", "hue"], optional: []),
  ]

  // §7 A ref, `new:` and up to 32 lowercase letters, digits and hyphens, the first a letter or digit: a name of its form is a
  // ref, never a step's or a kind's id.
  static func isRef(_ name: String) -> Bool {
    let bytes = Array(name.utf8)
    let lowerOrDigit = { (byte: UInt8) in (0x61...0x7A).contains(byte) || (0x30...0x39).contains(byte) }
    guard bytes.count >= 5, bytes.count <= 36, bytes.starts(with: Array("new:".utf8)), lowerOrDigit(bytes[4]) else { return false }
    return bytes.dropFirst(5).allSatisfy { lowerOrDigit($0) || $0 == 0x2D }
  }
}

// A change as the call sends it or a record holds it: its `op` and the fields its row names.
struct ProposalChange {
  let json: JSON.Object

  var op: String { text("op") ?? "" }

  func text(_ key: String) -> String? {
    guard case .string(let value)? = json[key] else { return nil }
    return value
  }

  func texts(_ key: String) -> [String] {
    guard case .array(let items)? = json[key] else { return [] }
    return items.compactMap { if case .string(let value) = $0 { value } else { nil } }
  }

  var parts: [ProposalChange] {
    guard case .array(let items)? = json["parts"] else { return [] }
    return items.compactMap { if case .object(let part) = $0 { ProposalChange(json: part) } else { nil } }
  }

  var links: [(url: String, label: String?)]? {
    guard case .array(let items)? = json["links"] else { return nil }
    return items.map { (url: (try? $0.member("url").asString()) ?? "", label: try? $0["label"]?.asString()) }
  }

  // §6.1 What a refusal of the change names: its step, else the ref it gives, else its kind.
  var subject: String? { text("nodeId") ?? text("ref") ?? text("kind") }

  // The steps of the roadmap the change names, in its fields' order: a new step's own id is what it gives, not a name.
  var stepsNamed: [String] {
    [op == "add_step" ? nil : text("nodeId"), text("removeId"), text("prerequisiteId")].compactMap { $0 } + texts("prerequisites")
  }

  // The kinds the change names: a new step's, a part's, or the kind it changes; a new kind's own id is what it gives.
  var kindsNamed: [String] {
    [op == "add_kind" ? nil : text("kind")].compactMap { $0 } + parts.compactMap { $0.text("kind") }
  }

  // The new steps and kinds the change gives, in order, by the id the form it is in gives each.
  var given: [(type: ProposalMint, id: String)] {
    switch op {
    case "add_step": [(.node, text("nodeId") ?? text("ref") ?? "")]
    case "add_kind": [(.kind, text("kind") ?? text("ref") ?? "")]
    case "split": parts.map { (.node, $0.text("nodeId") ?? $0.text("ref") ?? "") }
    default: []
    }
  }

  // The change in the record's form, each new step or kind under the id `idOf` gives its ref, and every field that names a
  // ref naming that id. Every other value stays as the call sent it.
  func recorded(_ idOf: (String) -> String) -> ProposalChange {
    func name(_ value: JSON) -> JSON { if case .string(let text) = value { .string(idOf(text)) } else { value } }
    var record = JSON.Object()
    for (key, value) in json.members {
      switch key {
      case "ref": record[op == "add_kind" ? "kind" : "nodeId"] = name(value)
      case "nodeId", "prerequisiteId", "removeId", "kind": record[key] = name(value)
      case "prerequisites": record[key] = .array(((try? value.asArray()) ?? []).map(name))
      case "parts": record[key] = .array(parts.map { .object($0.recorded(idOf).json) })
      default: record[key] = value
      }
    }
    return ProposalChange(json: record)
  }

  // The texts and web links of the change and of each of its parts, each with what a refusal of them names: the change's
  // subject, or the part's ref. A kind's words are measured as a kind's.
  var words: [(about: String?, texts: [(String?, TextSpec)], links: [(url: String, label: String?)])] {
    let kind = op == "add_kind" || op == "rename_kind"
    let of = { (words: ProposalChange, about: String?) -> (about: String?, texts: [(String?, TextSpec)], links: [(url: String, label: String?)]) in
      let links = words.links ?? []
      let texts: [(String?, TextSpec)] = [(words.text("label"), kind ? RoadmapSpecs.kindLabel : RoadmapSpecs.label),
                                          (words.text("description"), kind ? RoadmapSpecs.kindDescription : RoadmapSpecs.description)]
      return (about, texts + links.flatMap { [($0.url, RoadmapSpecs.linkUrl), ($0.label, RoadmapSpecs.linkLabel)] }, links)
    }
    return [of(self, subject)] + parts.map { of($0, $0.text("ref")) }
  }

  // The web links the change carries, as the domain stores them: each address trimmed, a label left out empty.
  static func stored(_ links: [(url: String, label: String?)]?) -> [Step.Link] {
    (links ?? []).map { Step.Link(url: RoadmapSpecs.linkUrl.normalised($0.url), label: $0.label ?? "") }
  }

  // §7, §6.1 The rules of the change's input, in order: its op's row; a merge of a step into itself, a describe of neither
  // field and a split of fewer than two parts; a ref given twice, at its second giving; a text the domain cannot store; a
  // value past its cap; and an address the contract does not show. `refs` are the refs the changes before it gave.
  func formRefusal(refs: inout Set<[UInt8]>) -> CoachRefusal? {
    guard let row = ProposalOps.rows[op] else { return CoachRefusal(.invalidInput, subject) }
    let fields = json.keys.filter { $0 != "op" }
    if !row.required.allSatisfy(fields.contains) || !fields.allSatisfy({ row.required.contains($0) || row.optional.contains($0) }) {
      return CoachRefusal(.invalidInput, subject)
    }
    let malformed = (op == "merge" && text("nodeId").map(Array.init) == text("removeId").map(Array.init))
      || (op == "describe" && json["description"] == nil && json["links"] == nil) || (op == "split" && parts.count < 2)
    if malformed { return CoachRefusal(.invalidInput, subject) }
    let given = ([text("ref")] + parts.map { $0.text("ref") }).compactMap { $0 }
    var giving = Set<[UInt8]>()
    if let twice = given.first(where: { refs.contains(Array($0.utf8)) || !giving.insert(Array($0.utf8)).inserted }) {
      return CoachRefusal(.invalidInput, twice)
    }
    refs.formUnion(giving)
    let refused = words.map { (about: $0.about, links: $0.links, code: CoachRefusal.Code(refusing: $0.texts) ?? ($0.links.count > RoadmapSpecs.links.max ? .overLimit : nil)) }
    if let text = refused.first(where: { $0.code == .invalidInput }) ?? refused.first(where: { $0.code != nil }), let code = text.code {
      return CoachRefusal(code, text.about)
    }
    if let unshown = refused.first(where: { ProposalChange.stored($0.links).contains { !RoadmapRules.showsAddress($0.url) } }) {
      return CoachRefusal(.addressNotAllowed, unshown.about)
    }
    return nil
  }
}

// One register a change writes. A write the room's own command makes, a recolour's repainting, is no part of the base.
struct ProposalWrite {
  let t: String
  let id: JSON
  let register: String
  let value: JSON
  var base = true

  static func node(_ id: String, _ register: String, _ value: JSON) -> ProposalWrite { ProposalWrite(t: "node", id: .string(id), register: register, value: value) }
  static func kind(_ id: String, _ register: String, _ value: JSON) -> ProposalWrite { ProposalWrite(t: "kind", id: .string(id), register: register, value: value) }
  static func link(_ from: String, _ to: String, _ alive: Bool) -> ProposalWrite {
    ProposalWrite(t: "edge", id: [.string(from), .string(to)], register: "life", value: .bool(alive))
  }
  static func mark(_ id: String, _ status: String, outOfOrder: Bool = false) -> ProposalWrite {
    ProposalWrite(t: "progress", id: .string(id), register: "mark", value: ["status": .string(status), "outOfOrder": .bool(outOfOrder)])
  }

  // The ids of the record it writes: a link's two steps, any other record's one.
  var ids: [String] {
    if case .array(let ends) = id { return ends.compactMap { try? $0.asString() } }
    return [(try? id.asString()) ?? ""]
  }
}

// §7 A step a change removes, as it stands in the scratch: its id, label, the Unicode scalars of its description, how many
// web links it carries and whether it is complete.
struct ProposalRemoval {
  let nodeId: String
  let label: String
  let descriptionChars: Int
  let links: Int
  let done: Bool

  func json(_ idOf: (String) -> String) -> JSON {
    ["nodeId": .string(idOf(nodeId)), "label": .string(label), "descriptionChars": JSON(descriptionChars), "links": JSON(links), "done": .bool(done)]
  }
}

// What folding one change writes, and what it asks of the copy before it writes: the registers it names without writing them,
// which the turn may have read; the check that is the op's own, of its links or hues; the marks it keeps; whether it changes
// nothing; the step it removes; and the recolour of a kind it makes.
struct ProposalFolding {
  var writes: [ProposalWrite]
  var names: [ProposalWrite] = []
  var check: (() -> CoachRefusal?)? = nil
  var marks: (() -> CoachRefusal?)? = nil
  var unchanged: Bool? = nil
  var removes: String? = nil
  var recolour: (kind: String, hue: String)? = nil
}

// The records of a scratch copy in the order the roadmap holds them, a record a change makes after them, each found by its
// id: its steps, its links by `[from, to]`, its kinds and its marks. Kept in order, a tree of them reads as fast as the
// roadmap's own.
struct ScratchRecords {
  var nodes: [Step]
  var edges: [RoadmapTree.Edge]
  var kinds: [Kind]
  var marks: [RoadmapTree.Mark]
  var nodeAt: ByText<Int>
  var edgeAt: [[UInt8]: Int]
  var kindAt: ByText<Int>
  var markAt: ByText<Int>

  init(_ tree: RoadmapTree) {
    nodes = tree.nodes
    edges = tree.edges
    kinds = tree.kinds
    marks = tree.marks
    nodeAt = ByText(tree.nodes.enumerated().map { (Array($0.element.id.utf8), $0.offset) }) { _, last in last }
    edgeAt = Dictionary(tree.edges.enumerated().map { (ScratchRecords.linkKey($0.element.from, $0.element.to), $0.offset) }) { _, last in last }
    kindAt = ByText(tree.kinds.enumerated().map { (Array($0.element.id.utf8), $0.offset) }) { _, last in last }
    markAt = ByText(tree.marks.enumerated().map { (Array($0.element.node.utf8), $0.offset) }) { _, last in last }
  }

  static func linkKey(_ from: String, _ to: String) -> [UInt8] { JSON.array([.string(from), .string(to)]).jcs }

  func node(_ id: String) -> Step? { nodeAt[id].map { nodes[$0] } }
  func edge(_ from: String, _ to: String) -> RoadmapTree.Edge? { edgeAt[ScratchRecords.linkKey(from, to)].map { edges[$0] } }
  func kind(_ id: String) -> Kind? { kindAt[id].map { kinds[$0] } }
  func mark(_ id: String) -> RoadmapTree.Mark? { markAt[id].map { marks[$0] } }

  // The value a register holds, one they hold no record of reading as unset.
  func value(_ write: ProposalWrite) -> JSON {
    let ids = write.ids
    switch write.t {
    case "edge": return .bool(edge(ids[0], ids.count > 1 ? ids[1] : "")?.present == true)
    case "progress":
      guard let mark = mark(ids[0]) else { return ["status": "none", "outOfOrder": false] }
      return ["status": .string(mark.status), "outOfOrder": .bool(mark.outOfOrder)]
    case "kind":
      let kind = kind(ids[0])
      switch write.register {
      case "life": return .bool(kind?.present == true)
      case "hue": return .string(kind?.hue ?? Roadmap.Defaults.Kind.hue)
      case "label": return .string(kind?.label ?? Roadmap.Defaults.Kind.label)
      case "description": return .string(kind?.description ?? Roadmap.Defaults.Kind.description)
      default: return .string(kind?.ord ?? "")
      }
    default:
      let step = node(ids[0])
      switch write.register {
      case "life": return .bool(step?.present == true)
      case "label": return .string(step?.label ?? Roadmap.Defaults.Node.label)
      case "color": return .string(step?.color ?? Roadmap.Defaults.Node.color)
      case "description": return .string(step?.description ?? Roadmap.Defaults.Node.description)
      case "links": return .array((step?.links ?? []).map(\.json))
      default: return .string(step?.ord ?? "")
      }
    }
  }

  // One register written; a record they held none of is made with every other field unset.
  mutating func write(_ write: ProposalWrite) {
    let ids = write.ids
    let text = (try? write.value.asString()) ?? ""
    switch write.t {
    case "edge":
      let key = ScratchRecords.linkKey(ids[0], ids[1])
      let edge = RoadmapTree.Edge(from: ids[0], to: ids[1], present: write.value == true)
      if let at = edgeAt[key] { edges[at] = edge } else { edgeAt[key] = edges.count; edges.append(edge) }
    case "progress":
      let status = (try? write.value.member("status").asString()) ?? "none"
      let outOfOrder = (try? write.value.member("outOfOrder").asBool()) ?? false
      let mark = RoadmapTree.Mark(node: ids[0], status: status, outOfOrder: outOfOrder, recordedAt: nil, deviceAt: nil)
      if let at = markAt[ids[0]] { marks[at] = mark } else { markAt[ids[0]] = marks.count; marks.append(mark) }
    case "kind":
      let held = kind(ids[0]) ?? Kind(id: ids[0], present: false, hue: Roadmap.Defaults.Kind.hue)
      let kind = Kind(id: held.id, present: write.register == "life" ? write.value == true : held.present, born: held.born,
                      hue: write.register == "hue" ? text : held.hue, label: write.register == "label" ? text : held.label,
                      description: write.register == "description" ? text : held.description, ord: write.register == "ord" ? text : held.ord)
      if let at = kindAt[ids[0]] { kinds[at] = kind } else { kindAt[ids[0]] = kinds.count; kinds.append(kind) }
    default:
      let held = node(ids[0]) ?? Step(id: ids[0], present: false)
      let links = write.register == "links"
        ? ((try? write.value.asArray()) ?? []).map { Step.Link(url: (try? $0.member("url").asString()) ?? "", label: (try? $0.member("label").asString()) ?? "") }
        : held.links
      let step = Step(id: held.id, present: write.register == "life" ? write.value == true : held.present, born: held.born, rc: held.rc, ru: held.ru,
                      label: write.register == "label" ? text : held.label, icon: held.icon, color: write.register == "color" ? text : held.color,
                      ord: write.register == "ord" ? text : held.ord, status: held.status,
                      description: write.register == "description" ? text : held.description, links: links, branch: held.branch, branchStamp: held.branchStamp)
      if let at = nodeAt[ids[0]] { nodes[at] = step } else { nodeAt[ids[0]] = nodes.count; nodes.append(step) }
    }
  }
}

// §7 A set of changes folded in order over a scratch copy of one standing roadmap. Each change is validated over the copy as
// the changes before it left it; what it writes is then folded in, and each register it is the first to touch joins the
// base, with the stamp the copy holds of it.
public final class ProposalFold {
  let standing: StandingRoadmaps
  let original: RoadmapTree
  let held: Set<[UInt8]>
  let stamps: [String: RecordStamps]
  let seen: [String: RecordStamps]
  var records: ScratchRecords
  var given = Set<[UInt8]>()
  var touched: [BaseRegister] = []
  var touchedKeys = Set<String>()
  var removes: [ProposalRemoval] = []
  var recolours: [(kind: String, hue: String)] = []
  var cachedTree: RoadmapTree?
  var cachedRoadmap: StandingRoadmap?

  // `roadmap` is the standing roadmap the set changes, of the standing roadmaps `standing`; `seen` the stamps of the
  // registers the turn's context and reads returned, as the tool host noted them (§5).
  init(_ standing: StandingRoadmaps, _ roadmap: StandingRoadmap, seen: [RecordStamps] = []) {
    self.standing = standing
    original = roadmap.tree
    held = roadmap.held
    records = ScratchRecords(roadmap.tree)
    self.stamps = Dictionary(standing.stamps.map { ($0.key, $0) }) { _, last in last }
    self.seen = Dictionary(seen.map { ($0.key, $0) }) { _, last in last }
  }

  // A record's changes folded over the standing roadmap as it is now: the fold, or the refusal of the first change that no
  // longer folds, or of the roadmap.
  public static func over(_ standing: StandingRoadmaps, treeId: String, changes: [JSON]) -> Result<ProposalFold, CoachRefusal> {
    do throws(CoachRefusal) {
      let fold = ProposalFold(standing, try standing.open(treeId, about: treeId))
      for (at, change) in changes.enumerated() {
        guard case .object(let object) = change else { return .failure(CoachRefusal(.invalidInput, at: at)) }
        if let refused = fold.apply(ProposalChange(json: object)) { return .failure(refused.at(at)) }
      }
      return .success(fold)
    } catch {
      return .failure(error)
    }
  }

  // §7 The base: every register the set touches, in the order the changes first touch it, with the copy's stamp.
  public var base: [BaseRegister] { touched }

  // §7 Apply: whether anything in a proposal's base differs from the copy now, the standing roadmap's stamps: a stamp that is
  // not the one recorded, or a step or link that has gone or come, which moves the stamp of its life. An entry that is no
  // register is a base that cannot stand.
  public static func baseMoved(_ base: [JSON], over standing: StandingRoadmaps, treeId: String) -> Bool {
    let stamps = Dictionary(standing.stamps.map { ($0.key, $0) }) { _, last in last }
    return base.contains { entry in
      guard let t = try? entry.member("t").asString(), let register = try? entry.member("register").asString(), let id = entry["id"] else { return true }
      let scope = t == "progress" ? ScopeRef.overlay(treeId) : ScopeRef.tree(treeId)
      let recorded = entry["stamp"].flatMap { $0.isNull ? nil : try? $0.asString() }
      let now = stamp(in: stamps[RecordStamps.key(scope.description, t, id)], register).stamp
      return now.map { Array($0.utf8) } != recorded.map { Array($0.utf8) }
    }
  }

  // The scratch copy as a tree, rebuilt once a change has written it.
  var tree: RoadmapTree {
    if let cachedTree { return cachedTree }
    let built = treeOf(records)
    cachedTree = built
    return built
  }

  // The scratch copy as the room would show it, its steps' states and what each follows read among the roadmaps its reading
  // reaches, the scratch in place of the roadmap it copies.
  var roadmap: StandingRoadmap {
    if let cachedRoadmap { return cachedRoadmap }
    guard let opened = try? standing.replacing(tree).open(original.id, about: original.id) else {
      preconditionFailure("a scratch copy stands as the roadmap it copies")
    }
    cachedRoadmap = opened
    return opened
  }

  // The roadmap as the set leaves it: its present kinds and steps in the room's order, each step with its words, its colour,
  // what it follows and its state.
  public var folded: JSON {
    let (tree, roadmap) = (self.tree, self.roadmap)
    let kinds: [JSON] = tree.kinds.filter(\.present).map {
      ["id": .string($0.id), "label": .string($0.label), "hue": .string($0.hue), "description": .string($0.description)]
    }
    let steps: [JSON] = tree.nodes.filter(\.present).map { node in
      ["id": .string(node.id), "label": .string(node.label), "color": .string(node.color), "description": .string(node.description),
       "links": .array(node.links.map(\.json)), "prerequisites": .array(roadmap.graph.followed(node.id).map { .string($0.id) }),
       "state": .of(roadmap.state(node.id)?.rawValue)]
    }
    return ["kinds": .array(kinds), "steps": .array(steps)]
  }

  // §7 Apply: what a set writes, one write a register. The room's recolour of each kind the copy holds, in the order the
  // changes make them, each repainting the steps that wear the kind's hue as the copy and the recolours before it leave them
  // (`wearers`, by id); then every kind, step, link and mark the folded copy holds otherwise than the copy as the recolours
  // leave it, each record by id: one the copy does not hold `created`, with every field the fold gave it, a step that ends
  // removed `removed`, and the fields of the rest that changed. A link the copy does not hold that ends removed is written as
  // nothing.
  public struct Reduced: Sendable, Equatable {
    public struct Recolour: Sendable, Equatable {
      public let kind: String
      public let hue: String
      public let wearers: [String]
    }

    public struct RecordWrite: Sendable, Equatable {
      public let id: String
      public let created: Bool
      public let removed: Bool
      public let fields: [String: JSON]
    }

    public struct LinkWrite: Sendable, Equatable {
      public let from: String
      public let to: String
      public let alive: Bool
      public let created: Bool
    }

    public struct MarkWrite: Sendable, Equatable {
      public let node: String
      public let status: String
      public let outOfOrder: Bool
    }

    public let recolours: [Recolour]
    public let kinds: [RecordWrite]
    public let nodes: [RecordWrite]
    public let links: [LinkWrite]
    public let marks: [MarkWrite]

    public var json: JSON {
      func written(_ record: RecordWrite) -> JSON {
        ["id": .string(record.id), "created": .bool(record.created), "removed": .bool(record.removed), "fields": .object(JSON.Object(uniqueKeysWithValues: record.fields.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }))]
      }
      return ["recolours": .array(recolours.map { ["kind": .string($0.kind), "hue": .string($0.hue), "wearers": .array($0.wearers.map { .string($0) })] }),
              "kinds": .array(kinds.map(written)), "nodes": .array(nodes.map(written)),
              "links": .array(links.map { ["from": .string($0.from), "to": .string($0.to), "alive": .bool($0.alive), "created": .bool($0.created)] }),
              "marks": .array(marks.map { ["node": .string($0.node), "mark": ["status": .string($0.status), "outOfOrder": .bool($0.outOfOrder)]] })]
    }
  }

  // §7 Apply: what the set writes, one write a register. The recolours are the room's commands, so they come first, each over
  // the copy as the ones before it left it; every other register the folded copy holds otherwise is then written its folded
  // value, which the commands' repainting cannot reach after them.
  public var reduced: Reduced {
    var hues = ByText<String>(original.kinds.map { (Array($0.id.utf8), $0.hue) }) { _, last in last }
    var colours = ByText<String>(original.nodes.map { (Array($0.id.utf8), $0.color) }) { _, last in last }
    let byId = { (a: String, b: String) in a.utf8.lexicographicallyPrecedes(b.utf8) }
    let recoloured = recolours.map { (kind: String, hue: String) -> Reduced.Recolour in
      let old = hues[kind]
      let wearers = original.nodes.map(\.id).filter { colours[$0].map { Array($0.utf8) } == old.map { Array($0.utf8) } }.sorted(by: byId)
      for id in wearers { colours[id] = hue }
      hues[kind] = hue
      return Reduced.Recolour(kind: kind, hue: hue, wearers: wearers)
    }
    func changed<Held>(_ folded: [Held], _ copy: [Held], id: (Held) -> String, present: (Held) -> Bool,
                       fields: (Held, Bool) -> [(String, JSON)]) -> [Reduced.RecordWrite] {
      let before = ByText<Held>(copy.map { (Array(id($0).utf8), $0) }) { _, last in last }
      return folded.sorted { byId(id($0), id($1)) }.compactMap { record in
        let written = fields(record, false)
        guard let held = before[id(record)] else {
          return Reduced.RecordWrite(id: id(record), created: true, removed: !present(record), fields: Dictionary(written) { _, last in last })
        }
        if !present(record) && present(held) { return Reduced.RecordWrite(id: id(record), created: false, removed: true, fields: [:]) }
        let was = Dictionary(fields(held, true)) { _, last in last }
        let differing = written.filter { was[$0.0] != $0.1 }
        return differing.isEmpty ? nil : Reduced.RecordWrite(id: id(record), created: false, removed: false, fields: Dictionary(differing) { _, last in last })
      }
    }
    let kinds = changed(records.kinds, original.kinds, id: \.id, present: \.present) { kind, copied in
      [("hue", .string(copied ? hues[kind.id] ?? kind.hue : kind.hue)), ("label", .string(kind.label)), ("description", .string(kind.description)), ("ord", .string(kind.ord))]
    }
    let nodes = changed(records.nodes, original.nodes, id: \.id, present: \.present) { node, copied in
      [("label", .string(node.label)), ("icon", .string(node.icon)), ("color", .string(copied ? colours[node.id] ?? node.color : node.color)),
       ("description", .string(node.description)), ("links", .array(node.links.map(\.json))), ("ord", .string(node.ord))]
    }
    let copiedEdges = Dictionary(original.edges.map { (ScratchRecords.linkKey($0.from, $0.to), $0.present) }) { _, last in last }
    let links = records.edges.sorted { byId($0.from, $1.from) || ($0.from.utf8.elementsEqual($1.from.utf8) && byId($0.to, $1.to)) }.compactMap { edge -> Reduced.LinkWrite? in
      let before = copiedEdges[ScratchRecords.linkKey(edge.from, edge.to)]
      if edge.present == (before == true) || (before == nil && !edge.present) { return nil }
      return Reduced.LinkWrite(from: edge.from, to: edge.to, alive: edge.present, created: before == nil)
    }
    let copiedMarks = ByText<RoadmapTree.Mark>(original.marks.map { (Array($0.node.utf8), $0) }) { _, last in last }
    let marks = records.marks.sorted { byId($0.node, $1.node) }.compactMap { mark -> Reduced.MarkWrite? in
      let before = copiedMarks[mark.node]
      let unset = mark.status.utf8.elementsEqual(((try? Roadmap.Defaults.Progress.mark.member("status").asString()) ?? "none").utf8) && !mark.outOfOrder
      if let before, before.status.utf8.elementsEqual(mark.status.utf8), before.outOfOrder == mark.outOfOrder { return nil }
      if before == nil && unset { return nil }
      return Reduced.MarkWrite(node: mark.node, status: mark.status, outOfOrder: mark.outOfOrder)
    }
    return Reduced(recolours: recoloured, kinds: kinds, nodes: nodes, links: links, marks: marks)
  }

  // §7 One change in the record's form folded over the scratch, after the checks of the copy, in order: a step under a delete
  // the person can still undo, an id it gives that the copy holds, the steps and kinds it names, the caps of the roadmap's
  // counts, the op's own check of its links or hues, a register the turn saw at another stamp than the copy's, the marks,
  // and a change that writes nothing. Answers the refusal of the change, or none once it has folded.
  func apply(_ change: ProposalChange) -> CoachRefusal? {
    let named = change.stepsNamed
    if let step = named.first(where: { held.contains(Array($0.utf8)) }) { return CoachRefusal(.roadmapNotReady, step) }
    let giving = change.given
    if let taken = giving.first(where: { $0.type == .node ? records.node($0.id) != nil : records.kind($0.id) != nil }) {
      return CoachRefusal(.invalidInput, taken.id)
    }
    if let unknown = named.first(where: { !shows($0) }) { return CoachRefusal(.unknownStep, unknown) }
    let kinds = change.kindsNamed
    if !kinds.isEmpty {
      let shown = Set(LegendRead(tree).shown.compactMap { $0.kind.map { Array($0.id.utf8) } })
      if let kind = kinds.first(where: { (ProposalOps.isRef($0) && !given.contains(Array($0.utf8))) || !shown.contains(Array($0.utf8)) }) {
        return CoachRefusal(.unknownKind, kind)
      }
    }
    let folding = self.folding(change)
    if passesCaps(folding.writes) { return CoachRefusal(.overLimit, original.id) }
    if let own = folding.check?() { return own }
    let touching = registers(named, folding.writes + folding.names, giving: Set(giving.map { Array($0.id.utf8) }))
    if let moved = touching.first(where: \.moved) { return CoachRefusal(.roadmapChanged, moved.owner) }
    if let marks = folding.marks?() { return marks }
    if folding.unchanged ?? folding.writes.allSatisfy({ records.value($0) == $0.value }) { return CoachRefusal(.noChange, change.subject) }
    if let removed = folding.removes { removes.append(removal(removed)) }
    if let recolour = folding.recolour, !given.contains(Array(recolour.kind.utf8)) { recolours.append(recolour) }
    for each in touching where touchedKeys.insert(each.key).inserted { touched.append(each.register) }
    for each in giving { given.insert(Array(each.id.utf8)) }
    for write in folding.writes { records.write(write) }
    cachedTree = nil
    cachedRoadmap = nil
    return nil
  }

  // A step the scratch shows: present, and named by its id, or by a ref an earlier change gave.
  func shows(_ id: String) -> Bool {
    (!ProposalOps.isRef(id) || given.contains(Array(id.utf8))) && records.node(id)?.present == true
  }

  // What one change writes, by its op, of a scratch that shows every step and kind it names.
  func folding(_ change: ProposalChange) -> ProposalFolding {
    let nodeId = change.text("nodeId") ?? ""
    switch change.op {
    case "add_step":
      var once = Set<[UInt8]>()
      return ProposalFolding(writes: newStep(nodeId, change, following: change.texts("prerequisites").filter { once.insert(Array($0.utf8)).inserted }, placed: []))
    case "remove_step":
      return ProposalFolding(writes: [.node(nodeId, "life", false)], check: {
        EffectsRead(self.roadmap.graph, ids: [nodeId]).takesEveryStart ? CoachRefusal(.takesEveryStart, nodeId) : nil
      }, removes: nodeId)
    case "rename": return ProposalFolding(writes: [.node(nodeId, "label", .string(change.text("label") ?? ""))])
    case "describe":
      let description = change.text("description").map { [ProposalWrite.node(nodeId, "description", .string($0))] } ?? []
      let links = change.links.map { [ProposalWrite.node(nodeId, "links", .array(ProposalChange.stored($0).map(\.json)))] } ?? []
      return ProposalFolding(writes: description + links)
    case "set_kind": return ProposalFolding(writes: [.node(nodeId, "color", .string(hue(of: change.text("kind") ?? "")))])
    case "connect": return connecting(nodeId, change.text("prerequisiteId") ?? "")
    case "disconnect": return disconnecting(nodeId, change.text("prerequisiteId") ?? "")
    case "merge": return merging(change)
    case "split": return splitting(change)
    case "set_progress": return marking(nodeId, change.text("status") ?? "none")
    case "add_kind": return newKind(change)
    case "rename_kind": return ProposalFolding(writes: [.kind(change.text("kind") ?? "", "label", .string(change.text("label") ?? ""))])
    case "recolor_kind": return recolouring(change.text("kind") ?? "", change.text("hue") ?? "")
    default: preconditionFailure("no op \(change.op)")
    }
  }

  // A new step after the steps it follows, wearing its kind's hue, where it names none `color` (a split's step's) or
  // terracotta, its order key the room's for a new step, after the keys of `placed`.
  func newStep(_ id: String, _ words: ProposalChange, following: [String], placed: [FractionalKey], color: String = Roadmap.Defaults.Node.color)
    -> [ProposalWrite] {
    let worn = words.text("kind").map { hue(of: $0) } ?? color
    let last = ([tree.index.lastKey(under: following.first)].compactMap { $0 } + placed).max()
    return [.node(id, "life", true), .node(id, "label", .string(words.text("label") ?? "")), .node(id, "color", .string(worn)),
            .node(id, "description", .string(words.text("description") ?? "")),
            .node(id, "links", .array(ProposalChange.stored(words.links).map(\.json))), .node(id, "ord", .string(FractionalKey(after: last).text))]
      + following.map { .link($0, id, true) }
  }

  // A link added, the step `nodeId` coming to wait on `prerequisiteId`. A link the step already follows, through removed
  // steps too, changes nothing and so closes nothing; a new one that would close a loop is refused as the room's is.
  func connecting(_ nodeId: String, _ prerequisiteId: String) -> ProposalFolding {
    let follows = roadmap.graph.followed(nodeId).contains { $0.id.utf8.elementsEqual(prerequisiteId.utf8) }
    return ProposalFolding(writes: [.link(prerequisiteId, nodeId, true)], check: {
      guard !follows else { return nil }
      let link = RoadmapLink(from: ID(RecordID(prerequisiteId)), to: ID(RecordID(nodeId)))
      return self.tree.firstLoop(closedBy: [link]) == 0 ? CoachRefusal(.closesCycle, nodeId) : nil
    }, unchanged: follows)
  }

  // A link removed, as the room's own removes one: the step's direct link, or, of a prerequisite it follows through removed
  // steps alone, each link by which it reaches it. The direct link is named either way, so one the turn read that is gone
  // since is a roadmap changed, not a change of nothing.
  func disconnecting(_ nodeId: String, _ prerequisiteId: String) -> ProposalFolding {
    let direct = ProposalWrite.link(prerequisiteId, nodeId, false)
    if records.edge(prerequisiteId, nodeId)?.present == true { return ProposalFolding(writes: [direct]) }
    let followed = roadmap.graph.followed(nodeId).first { $0.id.utf8.elementsEqual(prerequisiteId.utf8) }
    return ProposalFolding(writes: (followed?.incoming ?? []).map { .link($0.from, $0.to, false) }, names: [direct])
  }

  // R-9: `removeId` folds into `nodeId`, which keeps its mark and web links and takes the words sent. Each live link into or
  // out of `removeId` dies and its like is made to or from `nodeId`, one that already stands made once; a link between the
  // two dies with them. `removeId` is removed, its web links with it. A link is between the two as the follow graph reads
  // one, through deleted steps (Roadmap on the sync engine D-5): directly, or through deleted steps alone.
  func merging(_ change: ProposalChange) -> ProposalFolding {
    let (nodeId, removeId) = (change.text("nodeId") ?? "", change.text("removeId") ?? "")
    let touching = tree.edges.filter { $0.present && ($0.from.utf8.elementsEqual(removeId.utf8) || $0.to.utf8.elementsEqual(removeId.utf8)) }
    var made: [(from: String, to: String)] = []
    var making = Set<[UInt8]>()
    for edge in touching {
      let out = edge.from.utf8.elementsEqual(removeId.utf8)
      let between = out ? edge.to.utf8.elementsEqual(nodeId.utf8) || reachesThroughAbsent(edge.to, onward: true, nodeId)
        : edge.from.utf8.elementsEqual(nodeId.utf8) || reachesThroughAbsent(edge.from, onward: false, nodeId)
      let (from, to) = out ? (nodeId, edge.to) : (edge.from, nodeId)
      if between || edge.from.utf8.elementsEqual(edge.to.utf8) || records.edge(from, to)?.present == true
        || !making.insert(ScratchRecords.linkKey(from, to)).inserted { continue }
      made.append((from, to))
    }
    let others = (change.text("label").map { [ProposalWrite.node(nodeId, "label", .string($0))] } ?? [])
      + (change.text("description").map { [ProposalWrite.node(nodeId, "description", .string($0))] } ?? [])
      + touching.map { ProposalWrite.link($0.from, $0.to, false) } + [.node(removeId, "life", false)]
    return ProposalFolding(writes: others + made.map { .link($0.from, $0.to, true) }, check: { self.loopRefusal(others, made, nodeId) }, removes: removeId)
  }

  // R-9: the step becomes its parts, side by side: each follows the step's prerequisites and precedes each step that followed
  // it by a copy of each of its live links, takes its mark, and its colour unless it names a kind. The step and its links die.
  func splitting(_ change: ProposalChange) -> ProposalFolding {
    let nodeId = change.text("nodeId") ?? ""
    let touching = tree.edges.filter { $0.present && ($0.from.utf8.elementsEqual(nodeId.utf8) || $0.to.utf8.elementsEqual(nodeId.utf8)) }
    let before = touching.filter { $0.to.utf8.elementsEqual(nodeId.utf8) && !$0.from.utf8.elementsEqual(nodeId.utf8) }.map(\.from)
    let after = touching.filter { $0.from.utf8.elementsEqual(nodeId.utf8) && !$0.to.utf8.elementsEqual(nodeId.utf8) }.map(\.to)
    let color = records.node(nodeId)?.color ?? Roadmap.Defaults.Node.color
    let mark = records.mark(nodeId)
    var placed: [FractionalKey] = []
    var others = touching.map { ProposalWrite.link($0.from, $0.to, false) } + [.node(nodeId, "life", false)]
    var links: [(from: String, to: String)] = []
    for part in change.parts {
      let id = part.text("nodeId") ?? ""
      let made = newStep(id, part, following: before, placed: placed, color: color)
      if let ord = made.first(where: { $0.register == "ord" }), let key = try? FractionalKey((try? ord.value.asString()) ?? "") { placed.append(key) }
      others += made.filter { $0.t != "edge" }
      if let mark { others.append(.mark(id, mark.status, outOfOrder: mark.outOfOrder)) }
      links += before.map { ($0, id) } + after.map { (id, $0) }
    }
    return ProposalFolding(writes: others + links.map { .link($0.from, $0.to, true) }, check: { [others, links] in self.loopRefusal(others, links, nodeId) },
                           removes: nodeId)
  }

  // §6 rule 7 for a mark: a step that opens a roadmap takes none, and a locked step is not marked complete; a mark that
  // already stands changes nothing.
  func marking(_ nodeId: String, _ status: String) -> ProposalFolding {
    let roadmap = self.roadmap
    let state = roadmap.state(nodeId)
    let completes = status == "complete"
    return ProposalFolding(writes: [.mark(nodeId, status)], marks: {
      if roadmap.openings[nodeId] != nil { return CoachRefusal(.opensRoadmap, nodeId) }
      return completes && state == .locked ? CoachRefusal(.stepLocked, nodeId) : nil
    }, unchanged: (state == .complete) == completes)
  }

  // A new kind after the kinds the roadmap holds, wearing a hue no present kind wears.
  func newKind(_ change: ProposalChange) -> ProposalFolding {
    let (kind, hue) = (change.text("kind") ?? "", change.text("hue") ?? "")
    let last = records.kinds.filter(\.present).compactMap { try? FractionalKey($0.ord) }.max()
    return ProposalFolding(writes: [.kind(kind, "life", true), .kind(kind, "hue", .string(hue)), .kind(kind, "label", .string(change.text("label") ?? "")),
                                    .kind(kind, "description", .string(change.text("description") ?? "")), .kind(kind, "ord", .string(FractionalKey(after: last).text))],
                           check: { self.hueRefusal(hue, kind) })
  }

  // A kind's hue, and the colour of every step the copy holds wearing its old one, present or not, as the room's recolour
  // repaints them; the repainting is the room's command's, no register of the base.
  func recolouring(_ kind: String, _ hue: String) -> ProposalFolding {
    let old = self.hue(of: kind)
    let wearing = records.nodes.filter { $0.color.utf8.elementsEqual(old.utf8) }
    return ProposalFolding(writes: [.kind(kind, "hue", .string(hue))] + wearing.map {
      var repaint = ProposalWrite.node($0.id, "color", .string(hue))
      repaint.base = false
      return repaint
    }, check: { self.hueRefusal(hue, kind) }, recolour: (kind, hue))
  }

  // §6.1 `hue-taken`: a hue another present kind wears, checked at each change as the room's recolour checks it, so two kinds
  // do not swap hues in one proposal.
  func hueRefusal(_ hue: String, _ kind: String) -> CoachRefusal? {
    records.kinds.contains { $0.present && !$0.id.utf8.elementsEqual(kind.utf8) && $0.hue.utf8.elementsEqual(hue.utf8) }
      ? CoachRefusal(.hueTaken, kind) : nil
  }

  // `closes-cycle`: a link a change makes that, over the scratch as the change's other writes leave it, lies on a loop that
  // holds a present step.
  func loopRefusal(_ writes: [ProposalWrite], _ links: [(from: String, to: String)], _ nodeId: String) -> CoachRefusal? {
    var trial = records
    for write in writes { trial.write(write) }
    let made = links.map { RoadmapLink(from: ID(RecordID($0.from)), to: ID(RecordID($0.to))) }
    return treeOf(trial).firstLoop(closedBy: made) != nil ? CoachRefusal(.closesCycle, nodeId) : nil
  }

  // §6 rule 4 over the scratch: whether what a change makes would pass the roadmap's caps of steps, links or kinds, which
  // count what it holds alive, a step under a delete the person can still undo among them.
  func passesCaps(_ writes: [ProposalWrite]) -> Bool {
    let growth = { (t: String, was: (ProposalWrite) -> Bool) -> Int in
      let lives = writes.filter { $0.t == t && $0.register == "life" }
      return lives.filter { $0.value == true && !was($0) }.count - lives.filter { $0.value == false && was($0) }.count
    }
    let steps = growth("node") { self.records.node($0.ids[0])?.present == true }
    if steps > 0 && records.nodes.filter(\.present).count + held.count + steps > RoadmapCaps.steps { return true }
    let links = growth("edge") { self.records.edge($0.ids[0], $0.ids[1])?.present == true }
    if links > 0 && records.edges.filter(\.present).count + links > RoadmapCaps.links { return true }
    let kinds = growth("kind") { self.records.kind($0.ids[0])?.present == true }
    return kinds > 0 && records.kinds.filter(\.present).count + kinds > RoadmapCaps.kinds
  }

  // §7 The registers a change touches, each with the base entry it adds and whether the turn saw it at another stamp than the
  // copy's: the being there of every step it names, then every register it writes but the room's command's, and every
  // register it names without writing, each once. A
  // record of a new step or kind of the set is that id's alone: only the life of each the change itself gives joins the base,
  // unheld.
  func registers(_ named: [String], _ writes: [ProposalWrite], giving: Set<[UInt8]>) -> [(key: String, register: BaseRegister, moved: Bool, owner: String)] {
    let isNew = { (id: String) in self.given.contains(Array(id.utf8)) || giving.contains(Array(id.utf8)) }
    var found: [(key: String, register: BaseRegister, moved: Bool, owner: String)] = []
    var keys = Set<String>()
    for write in named.map({ ProposalWrite.node($0, "life", true) }) + writes.filter(\.base) {
      let scope = write.t == "progress" ? ScopeRef.overlay(original.id) : ScopeRef.tree(original.id)
      let record = RecordStamps.key(scope.description, write.t, write.id)
      let key = record + " " + write.register
      guard keys.insert(key).inserted else { continue }
      let ids = write.ids
      if ids.contains(where: isNew) {
        if write.t != "edge" && write.t != "progress" && write.register == "life" && giving.contains(Array(ids[0].utf8)) {
          found.append((key, BaseRegister(t: write.t, id: write.id, register: write.register, stamp: nil), false, ids[0]))
        }
        continue
      }
      let copy = ProposalFold.stamp(in: stamps[record], write.register)
      let saw = ProposalFold.stamp(in: seen[record], write.register)
      found.append((key, BaseRegister(t: write.t, id: write.id, register: write.register, stamp: copy.stamp), saw.held && saw.stamp != copy.stamp,
                    ids.last ?? ""))
    }
    return found
  }

  // The stamp of one register in a record's stamps, none where they hold none of it, and whether they hold it.
  static func stamp(in record: RecordStamps?, _ register: String) -> (held: Bool, stamp: String?) {
    guard let record else { return (false, nil) }
    if register == "life" { return (record.life != nil, record.life) }
    return (record.f[register] != nil, record.f[register])
  }

  // Whether `start`, a step the scratch holds no present step of, reaches `target` over live links onward or back through
  // such steps alone, as the follow graph reads a link through absent steps.
  func reachesThroughAbsent(_ start: String, onward: Bool, _ target: String) -> Bool {
    let index = tree.index
    guard let begin = index.vertices[start], begin >= index.ids.count, let goal = index.slot(of: target) else { return false }
    var passed: Set<Int> = [begin]
    var pending = [begin]
    while let vertex = pending.popLast() {
      for next in onward ? index.children[vertex] : index.parents[vertex] {
        if next == goal { return true }
        if next < index.ids.count || !passed.insert(next).inserted { continue }
        pending.append(next)
      }
    }
    return false
  }

  // A tree of scratch records, the roadmap's own in every other part.
  func treeOf(_ records: ScratchRecords) -> RoadmapTree {
    RoadmapTree(id: original.id, present: original.present, read: original.read, own: original.own, updatedAt: original.updatedAt,
                stampedAt: original.stampedAt, parent: original.parent, meta: original.meta, nodes: records.nodes, edges: records.edges,
                kinds: records.kinds, marks: records.marks, pointers: original.pointers)
  }

  // The hue of a kind the scratch holds.
  func hue(of kind: String) -> String { records.kind(kind)?.hue ?? Roadmap.Defaults.Node.color }

  func removal(_ id: String) -> ProposalRemoval {
    let step = records.node(id)
    return ProposalRemoval(nodeId: id, label: step?.label ?? "", descriptionChars: step?.description.unicodeScalars.count ?? 0, links: step?.links.count ?? 0,
                           done: roadmap.state(id) == .complete)
  }
}

// `propose_roadmap_change` (§7): the changes folded in order over a scratch copy of the standing roadmap, each validated, and
// the proposal minted of them: its id and one id for each ref, drawn from the tool host's random source once the set
// validates, the record's changes each ref under its id, and the base. The call is checked in order: its Shape; the roadmap
// and the person; the count of changes; each change, at its index, the rules of its input and then the fold's checks; and
// the record's size. `seen` are the stamps the turn's reads returned (§5).
public enum RoadmapProposals {
  public static let name = "propose_roadmap_change"

  public static func answer(_ input: JSON, over standing: StandingRoadmaps, about: String?, seen: [RecordStamps] = [], ids: (ProposalMint) -> String)
    -> ProposalAnswer {
    do throws(CoachRefusal) {
      let (treeId, changes) = try shaped(input)
      let roadmap = try standing.open(treeId, about: about)
      guard roadmap.tree.own else { throw CoachRefusal(.notOwner, treeId) }
      guard changes.count <= proposalChanges else { throw CoachRefusal(.overLimit, at: proposalChanges) }
      let fold = ProposalFold(standing, roadmap, seen: seen)
      var refs = Set<[UInt8]>()
      for (at, change) in changes.enumerated() {
        if let step = change.stepsNamed.first(where: { fold.held.contains(Array($0.utf8)) }) { throw CoachRefusal(.roadmapNotReady, step, at: at) }
        if let refused = change.formRefusal(refs: &refs) ?? fold.apply(change.recorded { $0 }) { throw refused.at(at) }
      }
      let proposalId = ids(.coachProposal)
      var minted = ByText<String>()
      for given in changes.flatMap(\.given) { minted[given.id] = ids(given.type) }
      let idOf = { (name: String) in minted[name] ?? name }
      let record = MintedProposal(changes: changes.map { .object($0.recorded(idOf).json) }, base: fold.base.map {
        BaseRegister(t: $0.t, id: (try? $0.id.asString()).map { .string(idOf($0)) } ?? $0.id, register: $0.register, stamp: $0.stamp)
      })
      guard JSON.array(record.changes).jcs.count <= proposalChangesBytes, JSON.array(record.base.map(\.json)).jcs.count <= proposalBaseBytes else {
        throw CoachRefusal(.overLimit)
      }
      return .minted(record, result: ["proposalId": .string(proposalId), "removes": .array(fold.removes.map { $0.json(idOf) })])
    } catch {
      return .refused(error)
    }
  }

  // §7 The Shape rule (Coach engine §6) over the call, the gate's first rule and so the first check: a change outside the
  // catalog's schema refuses the call at its index, naming its subject; a fault outside the changes names nothing.
  static func shaped(_ input: JSON) throws(CoachRefusal) -> (treeId: String, changes: [ProposalChange]) {
    guard callSchema.fault(in: input) == nil, case .string(let treeId)? = input["treeId"], case .array(let sent)? = input["changes"] else {
      throw CoachRefusal(.invalidInput)
    }
    if let at = sent.firstIndex(where: { changeSchema.fault(in: $0) != nil }) {
      let subject = (try? sent[at].asObject()).map { ProposalChange(json: $0).subject } ?? nil
      throw CoachRefusal(.invalidInput, subject, at: at)
    }
    return (treeId, sent.compactMap { if case .object(let change) = $0 { ProposalChange(json: change) } else { nil } })
  }

  // The catalog's schema of the call, its changes a list of anything, and of one change (`changes.items`).
  static let (callSchema, changeSchema): (JSONSchema, JSONSchema) = {
    guard let ability = Catalog.roadmap.ability(named: name), case .object(var call) = ability.input, case .object(var list)? = call["properties"],
          case .object(var changes)? = list["changes"], let items = changes["items"] else { preconditionFailure("the catalog declares \(name)") }
    changes["items"] = nil
    list["changes"] = .object(changes)
    call["properties"] = .object(list)
    return (JSONSchema(.object(call)), JSONSchema(items))
  }()

  // The sync registry's caps of a proposal's record: its changes, counted and in bytes, and its base in bytes (§6 rule 4).
  static let proposalChanges = registryCap("changes").items ?? 0
  static let proposalChangesBytes = registryCap("changes").bytes
  static let proposalBaseBytes = registryCap("base").bytes

  static func registryCap(_ name: String) -> (bytes: Int, items: Int?) {
    guard let field = SyncSchema.registry.type(CoachProposal.type)?.field(name), let bytes = field.bounds?.max else {
      preconditionFailure("the sync registry caps coachProposal.\(name)")
    }
    guard case .array(_, let items)? = field.domain?.shape else { return (bytes, nil) }
    return (bytes, items)
  }
}
