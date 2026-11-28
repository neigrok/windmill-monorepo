import DomainKit
import SyncCore

// Roadmap Coach D-8, §5: the context, what Coach is told at the start of every turn before it calls anything, a pure function
// of the standing roadmap (D-2), what the conversation is about (D-7) and the step it started from. It answers as a read
// does: the context, or the refusal of the roadmap the conversation is about.
public enum RoadmapContext {
  // §5 The context's bounds, limits.json's `context`: `bytes`, CONTEXT_BYTES, the canonical text of the whole context;
  // `steps`, of a roadmap given whole; `recent`, the newest dated completions; `frontier`, the titles of a row about all
  // roadmaps; `prerequisites`, the ids of the started step's.
  public enum Bounds {
    public static let bytes = 65_536
    public static let steps = 300
    public static let recent = 10
    public static let frontier = 10
    public static let prerequisites = 50
  }

  // §5 A step-started conversation's step in full: every field §5.1 answers, the whole description in place of its summary,
  // but its checklist, which Coach reads with get_nodes.
  static let stepInFull: [StepField] = [.id, .label, .kind, .state, .prerequisites, .unlockCount, .description, .links, .opens]
  // §5 The kind every step of which a roadmap past the bounds is given, and how many links from its frontier it reaches.
  static let milestone = "milestone"
  static let hops = 2

  // The context of a conversation: about all of the person's roadmaps (`about` nil), the rows list_trees answers, in its
  // order, while they stay within `CONTEXT_BYTES`, each with the first titles of its frontier and `frontierOmitted` counting
  // the rest where there are more, so no one roadmap's frontier crowds out the rows after it; about one, what Coach is told
  // of it.
  public static func read(_ standing: StandingRoadmaps, about: String?, step: String? = nil) -> Result<JSON, CoachRefusal> {
    guard let about else {
      precondition(step == nil, "a conversation started from a step is about that step's roadmap")
      guard standing.listRead else { return .failure(CoachRefusal(.roadmapUnavailable)) }
      let rows = standing.account.list()
      return .success(.object(within([:], list: "trees", count: rows.count) { index in
        var row = standing.row(rows[index])
        guard case .array(let frontier)? = row["frontier"], frontier.count > Bounds.frontier else { return row }
        row["frontier"] = .array(Array(frontier.prefix(Bounds.frontier)))
        row["frontierOmitted"] = JSON(frontier.count - Bounds.frontier)
        return row
      }))
    }
    let roadmap: StandingRoadmap
    do { roadmap = try standing.open(about, about: about) } catch { return .failure(error) }
    let started = step.flatMap { roadmap.shown($0) == nil ? nil : Self.started(roadmap, $0) }
    return .success(.object(context(of: roadmap, in: standing, step: started)))
  }

  // §5 What Coach is told of one roadmap: its id, title, kinds and guides, a summary of its diagnostics and its newest dated
  // completions, and the step the conversation started from; with every step's line and every completion where the roadmap is
  // within the bounds, or else its counts by kind and state and the lines of the steps around where the person stands, which
  // Coach pages beyond. The started step counts toward `CONTEXT_BYTES` and stays whole. Where the context with no line taken
  // would pass them, its guides give way, the farthest first and the roadmap's own last, and `guidesOmitted` counts them.
  static func context(of roadmap: StandingRoadmap, in standing: StandingRoadmaps, step: JSON.Object?) -> JSON.Object {
    let header = roadmap.header
    let shown = guides(of: roadmap, in: standing)
    let tree = { (left: Int) -> JSON in
      var tree: JSON.Object = ["id": .string(roadmap.tree.id), "title": header["title"] ?? .string(""), "kinds": header["kinds"] ?? .array([]),
                               "guides": .array(Array(shown.dropFirst(left)))]
      if left > 0 { tree["guidesOmitted"] = JSON(left) }
      return .object(tree)
    }
    let completions = Self.completions(of: roadmap, in: standing)
    var unbounded: JSON.Object = ["diagnostics": .object(diagnosticCounts(of: roadmap, in: standing)), "recent": .array(recent(completions, in: roadmap))]
    if let step { unbounded["step"] = .object(step) }
    if roadmap.graph.ids.count <= Bounds.steps {
      var whole = unbounded
      whole["tree"] = tree(0)
      whole["steps"] = .array(roadmap.order().map { .object(roadmap.step($0, fields: StepField.line)) })
      whole["completed"] = .array(completions.map { ["id": .string($0.id), "at": .of($0.at)] })
      if JSON.object(whole).jcs.count <= Bounds.bytes { return whole }
    }
    let ids = around(roadmap)
    var counted = unbounded
    counted["counts"] = .object(counts(of: roadmap))
    var left = 0
    while left < shown.count {
      var bare = counted
      bare["tree"] = tree(left)
      bare["steps"] = .array([])
      bare["omitted"] = JSON(ids.count)
      if JSON.object(bare).jcs.count <= Bounds.bytes { break }
      left += 1
    }
    counted["tree"] = tree(left)
    return within(counted, list: "steps", count: ids.count) { roadmap.step(ids[$0], fields: StepField.line) }
  }

  // §5 The step a conversation started from, in full, its prerequisites cut to their first ids and `prerequisitesOmitted`
  // counting the rest where there are more, which Coach reads with get_nodes.
  static func started(_ roadmap: StandingRoadmap, _ id: String) -> JSON.Object {
    var step = roadmap.step(id, fields: stepInFull)
    guard case .array(let prerequisites)? = step["prerequisites"], prerequisites.count > Bounds.prerequisites else { return step }
    step["prerequisites"] = .array(Array(prerequisites.prefix(Bounds.prerequisites)))
    step["prerequisitesOmitted"] = JSON(prerequisites.count - Bounds.prerequisites)
    return step
  }

  // §5 The entries of a list, taken in order while the context holding them stays within `CONTEXT_BYTES`, under `list`, and
  // `omitted`, how many are left off. The context starts at its bytes with none taken and `omitted: 0`; each entry taken adds
  // its own bytes and a comma after the first, and `omitted` costs a byte more for each digit past its first.
  static func within(_ context: JSON.Object, list: String, count: Int, entry: (Int) -> JSON.Object) -> JSON.Object {
    var empty = context
    empty[list] = .array([])
    empty["omitted"] = JSON(0)
    var bytes = JSON.object(empty).jcs.count
    var taken: [JSON] = []
    for index in 0..<count {
      let value = JSON.object(entry(index))
      let next = bytes + value.jcs.count + (index > 0 ? 1 : 0)
      if next + String(count - index - 1).utf8.count - 1 > Bounds.bytes { break }
      bytes = next
      taken.append(value)
    }
    var whole = context
    whole[list] = .array(taken)
    whole["omitted"] = JSON(count - taken.count)
    return whole
  }

  // §5 The guides Coach reads before it works the roadmap, as the server's get_tree gives them to an outside assistant: on a
  // roadmap of the person's own, those of their roadmaps above it and its own, farthest first, the domain's `guides` read; on
  // one they only read, its own alone. `yours` says the words are the person's own: written, not inherited, on a roadmap that
  // is theirs.
  static func guides(of roadmap: StandingRoadmap, in standing: StandingRoadmaps) -> [JSON] {
    let header = roadmap.header
    guard roadmap.tree.own else {
      let guide = header["guide"] ?? .string("")
      return guide == .string("") ? [] : [["treeId": .string(roadmap.tree.id), "title": header["title"] ?? .string(""), "text": guide, "yours": false]]
    }
    return standing.account.guides(roadmap.tree.id).map { guide in
      ["treeId": .string(guide.tree), "title": .string(guide.title), "text": .string(guide.text),
       "yours": .bool(guide.own && standing.account.byId[guide.tree]?.own == true)]
    }
  }

  // §5.1 get_progress' completions: each step the person has completed as the room shows it, in id byte order, with the date
  // the domain's `progress` read gives it, none where it gives none.
  static func completions(of roadmap: StandingRoadmap, in standing: StandingRoadmaps) -> [(id: String, at: Instant?)] {
    let dates = ByText((standing.progress[roadmap.tree.id]?.dates ?? []).map { (Array($0.node.utf8), $0) }) { _, last in last }
    return dates.values.sorted { $0.node.utf8.lexicographicallyPrecedes($1.node.utf8) }.map { ($0.node, $0.at) }
  }

  // §5 The newest completions that carry a date, each with its step's label: newest first, and at one date in id byte order.
  static func recent(_ completions: [(id: String, at: Instant?)], in roadmap: StandingRoadmap) -> [JSON] {
    let dated = completions.compactMap { completion in completion.at.map { (id: completion.id, at: $0) } }
    let newest = dated.sorted { $0.at != $1.at ? $0.at > $1.at : $0.id.utf8.lexicographicallyPrecedes($1.id.utf8) }.prefix(Bounds.recent)
    let labels = ByText(roadmap.tree.nodes.map { (Array($0.id.utf8), $0.label) }) { first, _ in first }
    return newest.map { ["id": .string($0.id), "label": .string(labels[$0.id] ?? ""), "at": JSON($0.at.ms)] }
  }

  // §5 The diagnostics in summary: how many entries each list of get_diagnostics' report holds, and its smells, each without
  // the steps it names.
  static func diagnosticCounts(of roadmap: StandingRoadmap, in standing: StandingRoadmaps) -> JSON.Object {
    let found = Diagnostics(roadmap.graph)
    let smells: [JSON] = (found.legendEmpty ? [["kind": "empty-legend"]] : [])
      + found.unclaimedHues.map { ["kind": "unclaimed-hue", "hue": .string($0.hue), "count": JSON($0.nodes.count)] }
      + found.smells.map { ["kind": .string($0.kind.rawValue), "count": JSON($0.nodes.count)] }
    var counts: JSON.Object = ["cycles": JSON(found.cycles.entries.count + found.cycles.omitted),
                               "dangling": JSON(found.missingEdges.entries.count + found.missingEdges.omitted),
                               "selfEdges": JSON(found.selfEdges.entries.count + found.selfEdges.omitted), "smells": .array(smells)]
    if roadmap.tree.own {
      let pointers = PointerDiagnostics(standing.account, tree: roadmap.tree.id)
      counts["treeLoops"] = JSON(pointers.treeLoops.entries.count + pointers.treeLoops.omitted)
      counts["danglingPointers"] = JSON(pointers.danglingPointers.entries.count + pointers.danglingPointers.omitted)
    }
    return counts
  }

  // §5 The steps counted by state as list_trees counts them, and again for each kind in the room's order, and for the steps no
  // kind owns where there are any.
  static func counts(of roadmap: StandingRoadmap) -> JSON.Object {
    let kinds = roadmap.graph.ids.indices.map { roadmap.kindAt($0) }
    let named: [String?] = roadmap.kinds.map(\.id) + (kinds.contains(nil) ? [nil] : [])
    var counts = roadmap.counts
    counts["byKind"] = .array(named.map { kind in
      var counted = roadmap.counts { kinds[$0] == kind }
      counted["kind"] = .of(kind)
      return .object(counted)
    })
    return counts
  }

  // §5 The steps a roadmap past the bounds is given the lines of, in the order they are taken: the frontier, so it is never
  // left off while a milestone is in; then every step of the kind `milestone`; then every step within two links of the
  // frontier, a link read both ways; each group in get_tree's order, and a step in the first group it falls in.
  static func around(_ roadmap: StandingRoadmap) -> [String] {
    let order = roadmap.order()
    let frontier = order.filter { roadmap.state($0) == .available }
    let follows = StandingRoadmap.follows(in: roadmap.graph)
    let waiting = StandingRoadmap.followers(of: follows)
    var near = [Bool](repeating: false, count: roadmap.graph.ids.count)
    var ring = frontier.compactMap { roadmap.tree.index.slot(of: $0) }
    for slot in ring { near[slot] = true }
    for _ in 0..<hops {
      var reached: [Int] = []
      for slot in ring {
        for linked in follows[slot] + waiting[slot] where !near[linked] {
          near[linked] = true
          reached.append(linked)
        }
      }
      ring = reached
    }
    let slot = { (id: String) in roadmap.tree.index.slot(of: id) ?? 0 }
    let milestones = order.filter { roadmap.kindAt(slot($0)) == milestone }
    let neighbourhood = order.filter { near[slot($0)] }
    var seen = Set<[UInt8]>()
    return (frontier + milestones + neighbourhood).filter { seen.insert(Array($0.utf8)).inserted }
  }
}

extension StandingRoadmap {
  // §5.1 The id of the kind that owns the hue of the step at `slot`; nil where none does.
  func kindAt(_ slot: Int) -> String? {
    owners[tree.index.nodes[slot].color]
  }

  // §5.1 list_trees' counts of the present steps `keep` takes: how many, and how many stand in each state.
  func counts(where keep: (Int) -> Bool) -> JSON.Object {
    var tally = (total: 0, done: 0, available: 0, locked: 0, unknown: 0)
    for (slot, state) in states.enumerated() where keep(slot) {
      tally.total += 1
      switch state {
      case .complete: tally.done += 1
      case .available: tally.available += 1
      case .locked: tally.locked += 1
      case .unknown: tally.unknown += 1
      }
    }
    return ["total": JSON(tally.total), "done": JSON(tally.done), "available": JSON(tally.available), "locked": JSON(tally.locked),
            "unknown": JSON(tally.unknown)]
  }
}

extension StandingRoadmaps {
  // §5.1 list_trees' row of a roadmap the person owns: its title, its steps by state, the titles of its frontier and its newest
  // completion's date. A roadmap the device has not finished bringing has its counts, frontier and date null, and the title
  // the device holds of it, null where it holds none.
  func row(_ listed: ListedRoadmap) -> JSON.Object {
    guard let roadmap = try? open(listed.id, about: nil) else {
      return ["id": .string(listed.id), "title": .of(listed.title ?? account.byId[listed.id]?.meta?.title), "counts": .null, "frontier": .null,
              "lastCompletedAt": .null]
    }
    let frontier = roadmap.order().filter { roadmap.state($0) == .available }.map { JSON.string(roadmap.shown($0)?.label ?? "") }
    return ["id": .string(listed.id), "title": .of(listed.title), "counts": .object(roadmap.counts), "frontier": .array(frontier),
            "lastCompletedAt": .of(roadmap.lastCompletedAt)]
  }
}
