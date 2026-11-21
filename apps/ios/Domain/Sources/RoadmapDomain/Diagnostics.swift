// A list bounded at fifty entries, and how many it left out.
public struct Listed<Entry: Sendable>: Sendable {
  public let entries: [Entry]
  public let omitted: Int

  init(_ all: [Entry]) {
    entries = Array(all.prefix(50))
    omitted = max(0, all.count - 50)
  }
}

// How many steps a finding covers, and the first ten of them.
public struct Counted: Sendable {
  public let count: Int
  public let named: [String]

  init(_ ids: [String]) {
    count = ids.count
    named = Array(ids.prefix(10))
  }
}

// One roadmap's bounded findings. No bound cuts the graph that states and completion read.
public struct Diagnostics: Sendable {
  public struct Smell: Sendable {
    public enum Kind: String, Sendable {
      case labelTooLong = "label-too-long"
      case emptyIcon = "empty-icon"
      case highInDegree = "high-in-degree"
    }

    public let kind: Kind
    public let nodes: Counted
  }

  public struct UnclaimedHue: Sendable {
    public let hue: String
    public let nodes: Counted
  }

  static let hueOrder = ["terracotta", "olive", "gold", "brick", "sky", "plum"]

  // Loops that hold a present step, each by its present steps; a step that follows itself is one.
  public let cycles: Listed<Counted>
  // Loops of absent steps alone, which add no prerequisite.
  public let absentCycles: Listed<Counted>
  // Live links naming an id no step record holds, apart from a known absent step.
  public let missingEdges: Listed<RoadmapTree.Edge>
  public let selfEdges: Listed<RoadmapTree.Edge>
  public let smells: [Smell]
  public let legendEmpty: Bool
  // The hues steps wear that no kind claims, in the legend's hue order.
  public let unclaimedHues: [UnclaimedHue]

  public init(_ graph: FollowGraph) {
    let tree = graph.tree
    let index = tree.index
    var cycles: [[String]] = []
    var absentCycles: [[String]] = []
    for group in Components(index.parents).groups where group.count > 1 || index.parents[group[0]].contains(group[0]) {
      let ids = group.map { index.rawIds[$0] }.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
      let present = ids.filter { index.slot(of: $0) != nil }
      if present.isEmpty { absentCycles.append(ids) } else { cycles.append(present) }
    }
    let byFirst = { (a: [String], b: [String]) in a[0].utf8.lexicographicallyPrecedes(b[0].utf8) }
    let legend = LegendRead(tree)
    let legendEmpty = legend.kinds.isEmpty && !index.nodes.isEmpty
    var longLabel: [String] = []
    var emptyIcon: [String] = []
    var highDegree: [String] = []
    var unclaimed = ByText<(hue: String, nodes: [String])>()
    for slot in index.ids.indices.sorted(by: { index.ids[$0].utf8.lexicographicallyPrecedes(index.ids[$1].utf8) }) {
      let node = index.nodes[slot]
      if node.label.utf8.count > 256 { longLabel.append(node.id) }
      if node.icon.isEmpty { emptyIcon.append(node.id) }
      if graph.degree[slot] > 4 { highDegree.append(node.id) }
      if !legendEmpty && !legend.claims(node.color) { unclaimed[node.color, default: (node.color, [])].nodes.append(node.id) }
    }
    let found: [(kind: Smell.Kind, nodes: [String])] = [(.labelTooLong, longLabel), (.emptyIcon, emptyIcon), (.highInDegree, highDegree)]
    // A hue the legend's order does not name comes first.
    let rank = { (hue: String) in Diagnostics.hueOrder.firstIndex { $0.utf8.elementsEqual(hue.utf8) } ?? -1 }
    let unclaimedHues = unclaimed.values.sorted { a, b in
      rank(a.hue) != rank(b.hue) ? rank(a.hue) < rank(b.hue) : a.hue.utf8.lexicographicallyPrecedes(b.hue.utf8)
    }
    self.cycles = Listed(cycles.sorted(by: byFirst).map(Counted.init))
    self.absentCycles = Listed(absentCycles.sorted(by: byFirst).map(Counted.init))
    missingEdges = Listed(index.edges.filter { tree.step($0.from) == nil || tree.step($0.to) == nil })
    selfEdges = Listed(index.edges.filter { $0.from.utf8.elementsEqual($0.to.utf8) })
    smells = found.filter { !$0.nodes.isEmpty }.map { Smell(kind: $0.kind, nodes: Counted($0.nodes)) }
    self.legendEmpty = legendEmpty
    self.unclaimedHues = unclaimedHues.map { UnclaimedHue(hue: $0.hue, nodes: Counted($0.nodes)) }
  }
}

// What one roadmap's openings come to: the loops that lead back to it, the openings that dangle, and the subtrees its steps still name in vain.
public struct PointerDiagnostics: Sendable {
  // A step whose opening leads back: at most eight roadmaps of the shortest way, and how many more it passes.
  public struct TreeLoop: Sendable {
    public struct PathTree: Sendable {
      public let tree: String
      public let title: String?
    }

    public let node: String
    public let path: [PathTree]
    public let pathOmitted: Int
  }

  public let treeLoops: Listed<TreeLoop>
  public let danglingPointers: Listed<Opening>
  // A stale branch stays diagnosed whatever the step's opening has become.
  public let staleBranches: Listed<StaleBranch>

  public init(_ account: RoadmapAccount, tree: String) {
    let ways = account.waysBack(tree)
    let openings = (account.openings[tree] ?? []).sorted { $0.node.utf8.lexicographicallyPrecedes($1.node.utf8) }
    treeLoops = Listed(openings.compactMap { opening -> TreeLoop? in
      guard opening.status == .loaded || opening.status == .unread, let way = ways[opening.tree] else { return nil }
      var path: [TreeLoop.PathTree] = []
      var current: String? = opening.tree
      while let passed = current, path.count < min(8, way.distance + 1) {
        path.append(TreeLoop.PathTree(tree: passed, title: account.locations[passed]?.title))
        current = ways[passed]?.next
      }
      return TreeLoop(node: opening.node, path: path, pathOmitted: way.distance + 1 - path.count)
    })
    danglingPointers = Listed(openings.filter { $0.status == .dangling })
    staleBranches = Listed((account.staleBranches[tree] ?? []).sorted { $0.node.utf8.lexicographicallyPrecedes($1.node.utf8) })
  }
}
