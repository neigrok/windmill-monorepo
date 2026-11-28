import DomainKit
import SyncCore

// Roadmap Coach §4, §5.1: the read abilities, each answering one page of what it read (§5.2) or refusing the call. The
// roadmap a call names is checked first, then the rules of its input, then its cursor.

// `get_tree`: the roadmap's header, then its steps in get_tree's order, each with the fields asked for.
struct GetTree: RoadmapAbility {
  static let name = "get_tree"

  let treeId: String
  let fields: [StepField]
  let cursor: String?

  init(_ input: JSON) throws {
    treeId = try input.text("treeId")
    fields = StepField.asked(try input.texts(ifAny: "fields"))
    cursor = try input.text(ifAny: "cursor")
  }

  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse {
    let roadmap = try standing.open(treeId, about: about)
    let order = roadmap.order()
    let steps = order.map { id in ReadPages.Entry(under: "steps") { roadmap.step(id, fields: fields) } }
    let pages = ReadPages(lists: ["steps"], entries: [ReadPages.Entry(under: "tree") { roadmap.header }] + steps, read: .array(order.map(JSON.string)))
    return try pages.answer(at: cursor, naming: treeId)
  }
}

// `get_nodes`: the steps by exact id, in the order asked. An id asked twice is malformed, and one the roadmap does not show
// refuses the call, the first such in the order asked: a step under a delete the person can still undo among them.
struct GetNodes: RoadmapAbility {
  static let name = "get_nodes"

  let treeId: String
  let nodeIds: [String]
  let fields: [StepField]
  let cursor: String?

  init(_ input: JSON) throws {
    treeId = try input.text("treeId")
    nodeIds = try input.texts(ifAny: "nodeIds") ?? []
    fields = StepField.asked(try input.texts(ifAny: "fields"))
    cursor = try input.text(ifAny: "cursor")
  }

  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse {
    let roadmap = try standing.open(treeId, about: about)
    var asked = Set<[UInt8]>()
    if let twice = nodeIds.first(where: { !asked.insert(Array($0.utf8)).inserted }) { throw CoachRefusal(.invalidInput, twice) }
    if let unknown = nodeIds.first(where: { roadmap.shown($0) == nil }) { throw CoachRefusal(.unknownStep, unknown) }
    let steps = nodeIds.map { roadmap.step($0, fields: fields) }
    let pages = ReadPages(lists: ["steps"], entries: steps.map { step in ReadPages.Entry(under: "steps") { step } },
                          read: .array(steps.map(JSON.object)))
    return try pages.answer(at: cursor, naming: treeId)
  }
}

// `find_nodes`: the steps that match every filter sent, in the order of the domain's search: a kind the roadmap does not
// have matches none, and a step whose state is unknown matches no state.
struct FindNodes: RoadmapAbility {
  static let name = "find_nodes"

  let treeId: String
  let kind: String?
  let state: String?
  let query: String?
  let fields: [StepField]
  let cursor: String?

  init(_ input: JSON) throws {
    treeId = try input.text("treeId")
    kind = try input.text(ifAny: "kind")
    state = try input.text(ifAny: "state")
    query = try input.text(ifAny: "query")
    fields = StepField.asked(try input.texts(ifAny: "fields"))
    cursor = try input.text(ifAny: "cursor")
  }

  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse {
    let roadmap = try standing.open(treeId, about: about)
    let found = roadmap.tree.selectNodes(NodeFilter(query: query ?? "", kind: kind)).filter { (id: String) -> Bool in
      state.map { roadmap.state(id)?.rawValue.utf8.elementsEqual($0.utf8) == true } ?? true
    }
    let pages = ReadPages(lists: ["steps"], entries: found.map { id in ReadPages.Entry(under: "steps") { roadmap.step(id, fields: fields) } },
                          read: .array(found.map(JSON.string)))
    return try pages.answer(at: cursor, naming: treeId)
  }
}

// `get_progress`: each step the person has completed as the room shows it, in id byte order, with the date the domain's
// `progress` read gives it, none where it gives none.
struct GetProgress: RoadmapAbility {
  static let name = "get_progress"

  let treeId: String
  let cursor: String?

  init(_ input: JSON) throws {
    treeId = try input.text("treeId")
    cursor = try input.text(ifAny: "cursor")
  }

  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse {
    _ = try standing.open(treeId, about: about)
    let dates = ByText((standing.progress[treeId]?.dates ?? []).map { (Array($0.node.utf8), $0) }) { _, last in last }
    let completed = dates.values.sorted { $0.node.utf8.lexicographicallyPrecedes($1.node.utf8) }
    let pages = ReadPages(lists: ["completed"],
                          entries: completed.map { date in ReadPages.Entry(under: "completed") { ["id": .string(date.node), "at": .of(date.at)] } },
                          read: .array(completed.map { .string($0.node) }))
    return try pages.answer(at: cursor, naming: treeId)
  }
}

// `get_diagnostics`: what is wrong with the roadmap's graph, from the domain's `diagnostics` read, and on a roadmap of the
// person's own what the roadmaps its steps open come to, from its `pointers` read. Each list holds its first 50, and the
// first page counts the rest of each.
struct GetDiagnostics: RoadmapAbility {
  static let name = "get_diagnostics"

  let treeId: String
  let cursor: String?

  init(_ input: JSON) throws {
    treeId = try input.text("treeId")
    cursor = try input.text(ifAny: "cursor")
  }

  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse {
    let roadmap = try standing.open(treeId, about: about)
    let found = Diagnostics(roadmap.graph)
    let named = { (nodes: Counted) -> JSON in .array(nodes.named.map(JSON.string)) }
    let link = { (edge: RoadmapTree.Edge) -> JSON.Object in ["from": .string(edge.from), "to": .string(edge.to)] }
    let smells: [JSON.Object] = (found.legendEmpty ? [["kind": "empty-legend"]] : [])
      + found.unclaimedHues.map { ["kind": "unclaimed-hue", "hue": .string($0.hue), "count": JSON($0.nodes.count), "nodes": named($0.nodes)] }
      + found.smells.map { ["kind": .string($0.kind.rawValue), "count": JSON($0.nodes.count), "nodes": named($0.nodes)] }
    var lists: [(name: String, entries: [JSON.Object], omitted: Int)] = [
      ("cycles", found.cycles.entries.map { ["count": JSON($0.count), "nodes": named($0)] }, found.cycles.omitted),
      ("dangling", found.missingEdges.entries.map(link), found.missingEdges.omitted),
      ("selfEdges", found.selfEdges.entries.map(link), found.selfEdges.omitted),
      ("smells", smells, 0),
    ]
    if roadmap.tree.own {
      let pointers = PointerDiagnostics(standing.account, tree: treeId)
      let loops = pointers.treeLoops.entries.map { (loop: PointerDiagnostics.TreeLoop) -> JSON.Object in
        var entry: JSON.Object = ["node": .string(loop.node), "path": .array(loop.path.map { ["treeId": .string($0.tree), "title": .of($0.title)] })]
        if loop.pathOmitted > 0 { entry["pathOmitted"] = JSON(loop.pathOmitted) }
        return entry
      }
      lists.append(("treeLoops", loops, pointers.treeLoops.omitted))
      lists.append(("danglingPointers", pointers.danglingPointers.entries.map { ["node": .string($0.node), "treeId": .string($0.tree)] },
                    pointers.danglingPointers.omitted))
    }
    lists.sort { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
    let entries = lists.flatMap { list in list.entries.map { entry in ReadPages.Entry(under: list.name) { entry } } }
    let first = JSON.Object(uniqueKeysWithValues: lists.filter { $0.omitted > 0 }.map { ("\($0.name)Omitted", JSON($0.omitted)) })
    let pages = ReadPages(lists: lists.map { $0.name }, entries: entries, read: .array(lists.flatMap { $0.entries.map(JSON.object) }), first: first)
    return try pages.answer(at: cursor, naming: treeId)
  }
}

// `list_trees`: one row for each roadmap the person owns that stands, in the order of the domain's `list` read, newest
// first: its title, its steps by state, the titles of its available steps in get_tree's order and its newest completion's
// date. A roadmap the device has not finished bringing has its counts, frontier and date null, and the title the device
// holds of it, null where it holds none. While the device does not hold the person's whole list the call is refused, so
// no roadmap of theirs goes unlisted.
struct ListTrees: RoadmapAbility {
  static let name = "list_trees"

  let cursor: String?

  init(_ input: JSON) throws {
    cursor = try input.text(ifAny: "cursor")
  }

  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse {
    guard standing.listRead else { throw CoachRefusal(.roadmapUnavailable) }
    let rows = standing.account.list()
    let pages = ReadPages(lists: ["trees"], entries: rows.map { row in ReadPages.Entry(under: "trees") { standing.row(row) } },
                          read: .array(rows.map { .string($0.id) }))
    return try pages.answer(at: cursor, naming: nil)
  }
}
