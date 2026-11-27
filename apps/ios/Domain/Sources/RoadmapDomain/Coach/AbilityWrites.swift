import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// Roadmap Coach §6: the direct writes, each answering the room's acts it is carried out as, the parts of one act, and what
// the call answers, by §6's table, or refusing the call (§6.1). A write changes one step and removes nothing. A call is
// checked in §6's order: the roadmap it names and whether this write may reach it (rules 1 to 3), the rules of its input,
// a text the domain cannot store among them, the caps the server keeps (4), the graph (5), the marks (7) and that it
// changes something (8); but `connect` asks whether the step already follows the step it names before it asks whether the
// link closes a loop, since a link that stands closes none. A new step's id is drawn last, once the call is taken (6).

extension CoachRefusal.Code {
  // §6.1, §6 rule 4: what the door would refuse of the texts a write sends, by the spec it applies to each, none where it
  // takes every one. A text the domain cannot store, one that holds U+0000, or one it takes no blank of, a subtask's, is
  // `invalid-input`, before any cap; one past its cap, measured as its spec measures it after the trim it applies, is
  // `over-limit`. A blank address is the address rule's (rule 5). A lone surrogate, which no store takes either, never
  // reaches Swift: its decoder refuses one first.
  init?(refusing texts: [(String?, TextSpec)]) {
    var codes: [CoachRefusal.Code] = []
    for (text, spec) in texts {
      guard let text else { continue }
      do throws(Violation) {
        _ = try spec.apply(text, at: Path(spec.path))
      } catch {
        switch error.reason {
        case .tooLong: codes.append(.overLimit)
        case .nul: codes.append(.invalidInput)
        default: if spec.path != RoadmapSpecs.linkUrl.path { codes.append(.invalidInput) }
        }
      }
    }
    guard let first = codes.first else { return nil }
    self = codes.contains(.invalidInput) ? .invalidInput : first
  }
}

extension StandingRoadmaps {
  // §6 rules 1 to 3: the roadmap a call names, where the device holds it whole and the person may write it in this
  // conversation. A step the call names under a delete the person can still undo is not ready, the first in the order
  // named; a roadmap the person only reads takes no write; and a direct write names the roadmap the conversation is about.
  func writable(_ treeId: String, about: String?, naming named: [String]) throws(CoachRefusal) -> StandingRoadmap {
    let roadmap = try open(treeId, about: about)
    if let held = named.first(where: { roadmap.held.contains(Array($0.utf8)) }) { throw CoachRefusal(.roadmapNotReady, held) }
    guard roadmap.tree.own else { throw CoachRefusal(.notOwner, treeId) }
    guard about.map({ treeId.utf8.elementsEqual($0.utf8) }) == true else { throw CoachRefusal(.outOfScope, treeId) }
    return roadmap
  }
}

extension StandingRoadmap {
  // §6 rule 4: whether more steps, links or subtasks would pass the sync registry's caps of a roadmap, which counts what it
  // holds alive as the engine does: each step the room shows and each under a delete the person can still undo, until its
  // hold ends, each link, and each subtask of its checklists, a removed step's included.
  func passesCaps(steps: Int = 0, links: Int = 0, subtasks: Int = 0) -> Bool {
    let cap = { (type: String) -> Int in
      guard let cap = SyncSchema.registry.type(type)?.cap else { preconditionFailure("the sync registry caps \(type)") }
      return cap
    }
    return graph.ids.count + held.count + steps > cap(RoadmapStep.type) || tree.index.edges.count + links > cap(RoadmapLink.type)
      || subtaskCount + subtasks > cap(Subtask.type)
  }
}

// `set_progress`: the room's Complete or Reset. A step that opens a roadmap is complete when that roadmap is, and takes no
// mark either way; a locked step is not marked complete, as the room offers no Complete on it.
struct SetProgress: RoadmapAbility {
  static let name = "set_progress"

  let treeId: String
  let nodeId: String
  let completes: Bool

  init(_ input: JSON) throws {
    treeId = try input.text("treeId")
    nodeId = try input.text("nodeId")
    completes = try input.text("status") == "complete"
  }

  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse {
    let roadmap = try standing.writable(treeId, about: about, naming: [nodeId])
    guard roadmap.shown(nodeId) != nil else { throw CoachRefusal(.unknownStep, nodeId) }
    guard roadmap.openings[nodeId] == nil else { throw CoachRefusal(.opensRoadmap, nodeId) }
    let state = roadmap.graph.states[nodeId]
    if completes && state == .locked { throw CoachRefusal(.stepLocked, nodeId) }
    if (state == .complete) == completes { throw CoachRefusal(.noChange, nodeId) }
    let (tree, step) = (ID<RoadmapEntry>(RecordID(treeId)), ID<RoadmapStep>(RecordID(nodeId)))
    return .writes([.mark(completes ? .complete(tree: tree, step: step) : .reset(tree: tree, step: step))], result: [:])
  }
}

// `update_node`: the room's change of the step's label, description and web links, each sent replaced whole and written as
// the domain stores it (an address trimmed, a label left out empty), and the room's new subtask for each item it adds to
// the end of the step's checklist, the person's own: one act. It never edits, checks or removes an item. A call that names
// no field is malformed, every address must be one the room shows, and a call whose every field the step already holds,
// adding no subtask, changes nothing.
struct UpdateNode: RoadmapAbility {
  static let name = "update_node"

  let treeId: String
  let nodeId: String
  let label: String?
  let description: String?
  let links: [(url: String, label: String?)]?
  let subtasks: [String]?

  init(_ input: JSON) throws {
    treeId = try input.text("treeId")
    nodeId = try input.text("nodeId")
    label = try input.text(ifAny: "label")
    description = try input.text(ifAny: "description")
    links = try input["links"]?.asArray().map { (url: try $0.text("url"), label: try $0.text(ifAny: "label")) }
    subtasks = try input.texts(ifAny: "subtasks")
  }

  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse {
    let roadmap = try standing.writable(treeId, about: about, naming: [nodeId])
    guard label != nil || description != nil || links != nil || subtasks != nil else { throw CoachRefusal(.invalidInput, nodeId) }
    let adding = subtasks ?? []
    let words: [(String?, TextSpec)] = [(label, RoadmapSpecs.label), (description, RoadmapSpecs.description)]
    let addresses = (links ?? []).flatMap { (link: (url: String, label: String?)) -> [(String?, TextSpec)] in
      [(link.url, RoadmapSpecs.linkUrl), (link.label, RoadmapSpecs.linkLabel)]
    }
    let texts = words + addresses + adding.map { (item: String) -> (String?, TextSpec) in (item, RoadmapSpecs.subtask) }
    if let code = CoachRefusal.Code(refusing: texts) ?? ((links?.count ?? 0) > RoadmapSpecs.links.max ? .overLimit : nil) {
      throw CoachRefusal(code, nodeId)
    }
    if roadmap.passesCaps(subtasks: adding.count) { throw CoachRefusal(.overLimit, treeId) }
    guard let step = roadmap.shown(nodeId) else { throw CoachRefusal(.unknownStep, nodeId) }
    let carried = links?.map { Step.Link(url: RoadmapSpecs.linkUrl.normalised($0.url), label: $0.label ?? "") }
    if carried?.contains(where: { !RoadmapRules.showsAddress($0.url) }) == true { throw CoachRefusal(.addressNotAllowed, nodeId) }
    let holds: JSON = ["label": .string(step.label), "description": .string(step.description), "links": .array(step.links.map(\.json))]
    let takes: JSON = ["label": .string(label ?? step.label), "description": .string(description ?? step.description),
                       "links": .array((carried ?? step.links).map(\.json))]
    guard takes != holds || !adding.isEmpty else { throw CoachRefusal(.noChange, nodeId) }
    let (tree, id) = (ID<RoadmapEntry>(RecordID(treeId)), ID<RoadmapStep>(RecordID(nodeId)))
    let change = RoomAct.changeStep(ChangeStep(tree: tree, step: id, changes: RoadmapStep.Changes(label: label, description: description, links: carried)))
    return .writes((takes != holds ? [change] : []) + adding.map { .addSubtask(AddSubtask(tree: tree, step: id, item: Subtask.Changes(label: $0))) },
                   result: [:])
  }
}

// `create_node`: the room's new step after the prerequisites named, wearing the hue of a kind its legend shows, as the
// room's New step offers them, terracotta where it names none, under the id the tool host draws; it answers that id. A new
// step's links close no loop: nothing follows it yet.
struct CreateNode: RoadmapAbility {
  static let name = "create_node"

  let treeId: String
  let label: String
  let kind: String?
  let description: String?
  let prerequisites: [String]

  init(_ input: JSON) throws {
    treeId = try input.text("treeId")
    label = try input.text("label")
    kind = try input.text(ifAny: "kind")
    description = try input.text(ifAny: "description")
    var named = Set<[UInt8]>()
    prerequisites = (try input.texts(ifAny: "prerequisites") ?? []).filter { named.insert(Array($0.utf8)).inserted }
  }

  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse {
    let roadmap = try standing.writable(treeId, about: about, naming: prerequisites)
    if let code = CoachRefusal.Code(refusing: [(label, RoadmapSpecs.label), (description, RoadmapSpecs.description)]) { throw CoachRefusal(code) }
    if roadmap.passesCaps(steps: 1, links: prerequisites.count) { throw CoachRefusal(.overLimit, treeId) }
    if let unknown = prerequisites.first(where: { roadmap.shown($0) == nil }) { throw CoachRefusal(.unknownStep, unknown) }
    var hue = Roadmap.Defaults.Node.color
    if let kind {
      guard let worn = roadmap.kinds.first(where: { $0.id.utf8.elementsEqual(kind.utf8) }) else { throw CoachRefusal(.unknownKind, kind) }
      hue = worn.hue
    }
    let nodeId = ids()
    let step = RoadmapStep.Changes(label: label, color: hue, description: description?.isEmpty == false ? description : nil)
    let act = CreateStep(tree: ID(RecordID(treeId)), step: step, prerequisites: prerequisites.map { ID(RecordID($0)) }, id: ID(RecordID(nodeId)))
    return .writes([.createStep(act)], result: ["nodeId": .string(nodeId)])
  }
}

// `connect`: the room's one link added, the step `nodeId` coming to wait on `prerequisiteId`. A link the step already
// follows, through removed steps too, changes nothing and so closes nothing; a new one that would close a loop among what
// steps follow is refused as the room's own link is.
struct Connect: RoadmapAbility {
  static let name = "connect"

  let treeId: String
  let nodeId: String
  let prerequisiteId: String

  init(_ input: JSON) throws {
    treeId = try input.text("treeId")
    nodeId = try input.text("nodeId")
    prerequisiteId = try input.text("prerequisiteId")
  }

  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse {
    let roadmap = try standing.writable(treeId, about: about, naming: [nodeId, prerequisiteId])
    if roadmap.passesCaps(links: 1) { throw CoachRefusal(.overLimit, treeId) }
    if let unknown = [nodeId, prerequisiteId].first(where: { roadmap.shown($0) == nil }) { throw CoachRefusal(.unknownStep, unknown) }
    if roadmap.graph.followed(nodeId).contains(where: { $0.id.utf8.elementsEqual(prerequisiteId.utf8) }) { throw CoachRefusal(.noChange, nodeId) }
    let (step, prerequisite) = (ID<RoadmapStep>(RecordID(nodeId)), ID<RoadmapStep>(RecordID(prerequisiteId)))
    if roadmap.tree.firstLoop(closedBy: [RoadmapLink(from: prerequisite, to: step)]) == 0 { throw CoachRefusal(.closesCycle, nodeId) }
    return .writes([.changePrerequisites(ChangePrerequisites(tree: ID(RecordID(treeId)), step: step, add: [prerequisite]))], result: [:])
  }
}
