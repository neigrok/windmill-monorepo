import DomainKit
import SyncAPI
import SyncCore

// Roadmap Coach D-2, §3, §5: the standing roadmap, the roadmaps the room reads as it shows them, as the plain data every
// ability takes, and what every ability reads of it: whether a call may read the roadmap it names, and each step of that
// roadmap as the room shows it.

// Every roadmap the device holds as the room shows it: the account the domain reads over them, each roadmap's completed
// steps as the room shows them, the steps under a delete the person can still undo, the person's checklists, whether the
// device holds the person's whole list, and the roadmaps whose completion waits on one the device has not brought.
public struct StandingRoadmaps: Sendable {
  // A step under a delete the person can still undo: its roadmap holds it as not present.
  public struct Held: Sendable {
    public let tree: String
    public let step: String

    public init(tree: String, step: String) {
      self.tree = tree
      self.step = step
    }
  }

  // A subtask of the person's own workspace.
  public struct ChecklistItem: Sendable {
    public let tree: String
    public let step: String
    public let label: String
    public let done: Bool

    public init(tree: String, step: String, label: String, done: Bool) {
      self.tree = tree
      self.step = step
      self.label = label
      self.done = done
    }
  }

  let account: RoadmapAccount
  let held: [Held]
  // Each step's items in its checklist's order, a removed step's included.
  let subtasks: [ChecklistItem]
  let listRead: Bool
  // §5 Each standing roadmap's completed steps and their dates as the room shows them, by its id.
  let progress: ByText<Progress>
  // §5 The roadmaps whose completion waits on a roadmap the device has not brought, by their ids.
  let uncertain: Set<[UInt8]>

  // `trees` is every roadmap the device holds. One the person only reads carries as its marks what the room shows of the
  // owner's: on a step that owns a subtree the device does not hold, the server's word of that subtree.
  public init(trees: [RoadmapTree], held: [Held] = [], subtasks: [ChecklistItem] = [], listRead: Bool = true) {
    let account = RoadmapAccount(trees)
    var progress = ByText<Progress>()
    for tree in account.trees {
      guard let openings = account.openings[tree.id] else { continue }
      let told = openings.compactMap { (opening: Opening) -> Progress.Dated? in
        guard let mark = Self.told(tree, opening), mark.isComplete else { return nil }
        return Progress.Dated(node: opening.node, at: mark.at)
      }
      progress[tree.id] = Progress(dates: (account.progress(tree.id)?.dates ?? []) + told)
    }
    self.account = account
    self.held = held
    self.subtasks = subtasks
    self.listRead = listRead
    self.progress = progress
    uncertain = Self.uncertain(in: account, progress: progress)
  }

  // D-2 from the device's copy, as the room reads it: each roadmap of the person's list from its tree scope and their
  // overlay of it, whole once the device has pulled all three, a step under a delete the person can still undo absent from
  // it (`drawn` holds the delete, `stored` the step); and the person's checklists.
  public init(reading runner: ActionRunner) throws {
    let (entries, listRead) = try runner.read(RoadmapEntry.scope) { (list: Reader) throws -> ([Record], Bool) in
      (try list.repository(RoadmapEntry.self).records(in: .drawn), try list.firstPullComplete())
    }
    var trees: [RoadmapTree] = []
    var held: [Held] = []
    var subtasks: [ChecklistItem] = []
    for listed in entries {
      let id = ID<RoadmapEntry>(listed.id)
      let (records, treeRead, kept) = try runner.read(id.tree) { (scope: Reader) throws -> ([Record], Bool, [String]) in
        let steps = scope.repository(RoadmapStep.self)
        let shown = Set(try steps.records(in: .drawn).filter(\.isVisible).map(\.id))
        let kept = try steps.records(in: .stored).filter { $0.isVisible && !shown.contains($0.id) }.map(\.id.description)
        return (try scope.records(in: .drawn), try scope.firstPullComplete(), kept)
      }
      let (overlay, overlayRead, items) = try runner.read(id.overlay) { (scope: Reader) throws -> ([Record], Bool, [Subtask]) in
        (try scope.records(in: .drawn), try scope.firstPullComplete(), try scope.repository(Subtask.self).all(in: .drawn))
      }
      trees.append(try RoadmapTree(id: id, listed: listed, tree: records, overlay: overlay, read: listRead && treeRead && overlayRead))
      held += kept.map { Held(tree: id.description, step: $0) }
      subtasks += items.map { ChecklistItem(tree: id.description, step: $0.step.description, label: $0.label, done: $0.done) }
    }
    self.init(trees: trees, held: held, subtasks: subtasks, listRead: listRead)
  }

  // §10, §6 rule 1: the roadmap a call names, where it is the conversation's (`about`) or one of the person's own and the
  // device holds it whole; else the refusal of the call. A roadmap that is neither is unknown once the device holds the
  // person's whole list, and one the device has not finished bringing, or that stands under one it has not, is unavailable
  // until it has. A roadmap that does not stand, deleted or never finished, is unknown.
  func open(_ treeId: String, about: String?) throws(CoachRefusal) -> StandingRoadmap {
    let tree = account.byId[treeId]
    if tree?.own != true && about.map({ !treeId.utf8.elementsEqual($0.utf8) }) ?? true {
      throw CoachRefusal(listRead ? .unknownRoadmap : .roadmapUnavailable, treeId)
    }
    guard let tree, tree.read == .loaded else { throw CoachRefusal(.roadmapUnavailable, treeId) }
    let standing = account.location(of: treeId).standing
    guard standing == .standing else { throw CoachRefusal(standing == .unknown ? .roadmapUnavailable : .unknownRoadmap, treeId) }
    return StandingRoadmap(tree, in: self)
  }

  // §5 Whether what an opening comes to waits on a roadmap the device has not brought: one it has not finished bringing
  // or holds nothing of, or one whose own completion waits on such a roadmap in turn; the room's word taken where it shows
  // one.
  func waitsOnUnbrought(_ tree: RoadmapTree, _ opening: Opening) -> Bool {
    if opening.status == .dangling || Self.told(tree, opening) != nil { return false }
    return opening.status == .unread || opening.status == .unknown || uncertain.contains(Array(opening.tree.utf8))
  }

  // The mark the room shows of a step whose opening the device holds no whole copy of, on a roadmap the person only reads:
  // the server's word of the subtree it owns. None where the room shows none, or the device reads the opening itself.
  static func told(_ tree: RoadmapTree, _ opening: Opening) -> RoadmapTree.Mark? {
    guard !tree.own, opening.status == .unread || opening.status == .unknown else { return nil }
    return tree.mark(on: opening.node)
  }

  // §5 The roadmaps that are not complete and whose every unfinished step opens a roadmap the device has not brought, or
  // one of these in turn. Grown from those that wait on an unbrought roadmap directly, so a loop of roadmaps that waits on
  // none is plainly incomplete.
  static func uncertain(in account: RoadmapAccount, progress: ByText<Progress>) -> Set<[UInt8]> {
    var waiting: [(tree: String, openings: [Opening])] = []
    for tree in account.trees {
      guard let openings = account.openings[tree.id] else { continue }
      let done = Set((progress[tree.id]?.completed ?? []).map { Array($0.utf8) })
      let opens = ByText<Opening>(openings.map { (Array($0.node.utf8), $0) }) { _, last in last }
      let unfinished = tree.index.nodes.filter { !done.contains(Array($0.id.utf8)) }.map { opens[$0.id] }
      let settled = unfinished.contains { (opening: Opening?) -> Bool in
        guard let opening else { return true }
        return opening.status == .dangling || told(tree, opening) != nil
      }
      if unfinished.isEmpty || settled { continue }
      waiting.append((tree.id, unfinished.compactMap { $0 }))
    }
    var uncertain = Set<[UInt8]>()
    var grew = true
    while grew {
      grew = false
      for (tree, openings) in waiting where !uncertain.contains(Array(tree.utf8)) {
        let unbrought = openings.allSatisfy { $0.status == .unread || $0.status == .unknown || uncertain.contains(Array($0.tree.utf8)) }
        guard unbrought else { continue }
        uncertain.insert(Array(tree.utf8))
        grew = true
      }
    }
    return uncertain
  }
}

// §5.1 The fields a step comes with.
enum StepField: String {
  case id, label, kind, state, prerequisites, unlockCount, summary, description, links, subtasks, opens

  // Where a call names none: the context's line.
  static let line: [StepField] = [.id, .label, .kind, .state, .prerequisites, .unlockCount, .summary]

  // The fields a call names of each step, the context's line where it names none.
  static func asked(_ names: [String]?) -> [StepField] {
    names.map { $0.compactMap(StepField.init(rawValue:)) } ?? line
  }
}

// One roadmap as the room shows it, read whole: its present steps in the room's order, what each follows through removed
// steps and what finishing it alone opens, the kind that owns each hue, what each step opens, each step's state, the steps
// under a delete the person can still undo, which it does not show, and each step's checklist.
struct StandingRoadmap {
  // §5 A step's state: the one the room shows, or `unknown` where it waits on a roadmap the device has not brought.
  enum State: String {
    case locked, available, complete, unknown
  }

  // §5.1 A summary is the description's first 160 Unicode scalars, `…` added where it is longer.
  static let summaryScalars = 160

  let tree: RoadmapTree
  let graph: FollowGraph
  // The kinds the legend shows, in its order, and the one that owns each hue.
  let kinds: [Kind]
  let owners: ByText<String>
  let openings: ByText<Opening>
  // Each present step's state, by slot.
  let states: [State]
  let held: Set<[UInt8]>
  // Every subtask of the roadmap, a removed step's included, and each step's checklist.
  let subtaskCount: Int
  let checklists: ByText<[StandingRoadmaps.ChecklistItem]>
  // The roadmap's title as the account reads it, and the newest date its completions carry.
  let title: String?
  let lastCompletedAt: Instant?

  init(_ tree: RoadmapTree, in roadmaps: StandingRoadmaps) {
    let dates = roadmaps.progress[tree.id]?.dates ?? []
    var done = [Bool](repeating: false, count: tree.index.ids.count)
    var dateAt = [Instant?](repeating: nil, count: done.count)
    for date in dates {
      guard let slot = tree.index.slot(of: date.node) else { continue }
      done[slot] = true
      dateAt[slot] = date.at
    }
    let graph = FollowGraph(tree, done: done, dateAt: dateAt)
    let kinds = LegendRead(tree).shown.compactMap(\.kind)
    let subtasks = roadmaps.subtasks.filter { $0.tree.utf8.elementsEqual(tree.id.utf8) }
    var checklists = ByText<[StandingRoadmaps.ChecklistItem]>()
    for item in subtasks { checklists[item.step, default: []].append(item) }
    self.tree = tree
    self.graph = graph
    self.kinds = kinds
    owners = ByText(kinds.map { (Array($0.hue.utf8), $0.id) }) { _, last in last }
    openings = ByText((roadmaps.account.openings[tree.id] ?? []).map { (Array($0.node.utf8), $0) }) { _, last in last }
    held = Set(roadmaps.held.filter { $0.tree.utf8.elementsEqual(tree.id.utf8) }.map { Array($0.step.utf8) })
    subtaskCount = subtasks.count
    self.checklists = checklists
    title = roadmaps.account.location(of: tree.id).title
    lastCompletedAt = dates.compactMap(\.at).max()
    states = Self.states(of: graph, unbrought: openings.values.compactMap { (opening: Opening) -> Int? in
      guard let slot = tree.index.slot(of: opening.node), !graph.done[slot], roadmaps.waitsOnUnbrought(tree, opening) else { return nil }
      return slot
    })
  }

  // §5: each present step's state by slot, the one the room shows, but `unknown` for each unfinished step whose opened
  // roadmap waits on one the device has not brought, and for every unfinished step that waits on such a step.
  static func states(of graph: FollowGraph, unbrought: [Int]) -> [State] {
    var states = graph.stateAt.map { (state: StepState) -> State in
      switch state {
      case .locked: .locked
      case .available: .available
      case .complete: .complete
      }
    }
    guard !unbrought.isEmpty else { return states }
    let waiting = followers(of: follows(in: graph))
    var reached = [Bool](repeating: false, count: states.count)
    var pending = unbrought
    for slot in pending { reached[slot] = true }
    while let slot = pending.popLast() {
      states[slot] = .unknown
      for next in waiting[slot] where !reached[next] && !graph.done[next] {
        reached[next] = true
        pending.append(next)
      }
    }
    return states
  }

  // What each present step follows, by slot, through removed steps, in the room's order (the graph's `followed`).
  static func follows(in graph: FollowGraph) -> [[Int]] {
    graph.ids.map { id in graph.followed(id).compactMap { graph.tree.index.slot(of: $0.id) } }
  }

  // The steps that follow each present step, by slot.
  static func followers(of follows: [[Int]]) -> [[Int]] {
    var waiting = [[Int]](repeating: [], count: follows.count)
    for (slot, prerequisites) in follows.enumerated() {
      for prerequisite in prerequisites { waiting[prerequisite].append(slot) }
    }
    return waiting
  }

  // The step the room shows under `id`, none where it shows none: a step removed, or under a delete the person can still
  // undo, among them.
  func shown(_ id: String) -> Step? {
    tree.index.slot(of: id).map { tree.index.nodes[$0] }
  }

  func state(_ id: String) -> State? {
    tree.index.slot(of: id).map { states[$0] }
  }

  // §5.1 get_tree's order, as present step ids: each step after every step it follows, and of the steps that can come
  // next, the first in the room's order (its slot); a step on a loop, or after one, last, in id byte order.
  func order() -> [String] {
    let ids = graph.ids
    let follows = Self.follows(in: graph)
    let waiting = Self.followers(of: follows)
    var waits = follows.map(\.count)
    // The steps that can come next, the first in the room's order last.
    var ready: [Int] = waits.indices.filter { waits[$0] == 0 }.reversed()
    var placed = [Bool](repeating: false, count: ids.count)
    var order: [String] = []
    while let slot = ready.popLast() {
      placed[slot] = true
      order.append(ids[slot])
      for next in waiting[slot] {
        waits[next] -= 1
        guard waits[next] == 0 else { continue }
        ready.insert(next, at: ready.firstIndex { $0 < next } ?? ready.endIndex)
      }
    }
    let looped = ids.indices.filter { !placed[$0] }.map { ids[$0] }
    return order + looped.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
  }

  // §5.1 get_tree's header: the roadmap's title, its kinds as the legend shows them, its own guide and how many steps it has.
  var header: JSON.Object {
    let legend: [JSON] = kinds.map {
      ["id": .string($0.id), "label": .string($0.label), "hue": .string($0.hue), "description": .string($0.description)]
    }
    return ["title": .string(title ?? ""), "kinds": .array(legend), "guide": .string(tree.meta?.guide ?? ""), "stepCount": JSON(graph.ids.count)]
  }

  // §5.1 One present step with the fields asked for, `id` always.
  func step(_ id: String, fields: [StepField]) -> JSON.Object {
    guard let slot = tree.index.slot(of: id) else { preconditionFailure("a step is read only where the roadmap shows it: \(id)") }
    let node = tree.index.nodes[slot]
    var line: JSON.Object = ["id": .string(id)]
    for field in fields {
      switch field {
      case .id: continue
      case .label: line["label"] = .string(node.label)
      case .kind: line["kind"] = .of(owners[node.color])
      case .state: line["state"] = .string(states[slot].rawValue)
      case .prerequisites: line["prerequisites"] = .array(graph.followed(id).map { .string($0.id) })
      case .unlockCount: line["unlockCount"] = JSON(graph.opens[slot].count)
      case .summary:
        let scalars = node.description.unicodeScalars
        line["summary"] = .string(scalars.count > Self.summaryScalars ? String(scalars.prefix(Self.summaryScalars)) + "…" : node.description)
      case .description: line["description"] = .string(node.description)
      case .links: line["links"] = .array(node.links.map(\.json))
      case .subtasks: line["subtasks"] = .array((checklists[id] ?? []).map { ["label": .string($0.label), "done": .bool($0.done)] })
      case .opens: line["opens"] = .of(openings[id]?.tree)
      }
    }
    return line
  }

  // §5.1 list_trees' counts: every present step, and how many stand in each state.
  var counts: JSON.Object {
    let count = { (state: State) in JSON(states.count { $0 == state }) }
    return ["total": JSON(states.count), "done": count(.complete), "available": count(.available), "locked": count(.locked),
            "unknown": count(.unknown)]
  }
}
