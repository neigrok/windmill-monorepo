// A roadmap as the picture reads it: the web's `model/SkillTree.js` (the topological order, the links, the bounds),
// `model/TrunkTree.js` (the link each step is seated by, sibling order, branches, link kinds) and the tiers, the state the
// web's domain reads of each step (`graph.json`). A step is named by its place in `steps`, the order the room hands them in, which the picture reads.
public struct SkillTree: Sendable {
  public struct Step: Sendable {
    public let id: UTF16Text
    public let label: String
    public let ord: UTF16Text
    public let born: Stamp
    public let follows: [UTF16Text]
    public let hue: UTF16Text
    public let done: Bool

    public init(id: String, label: String, ord: String, born: Stamp, follows: [String], hue: String, done: Bool) {
      self.id = UTF16Text(id)
      self.label = label
      self.ord = UTF16Text(ord)
      self.born = born
      self.follows = follows.map { UTF16Text($0) }
      self.hue = UTF16Text(hue)
      self.done = done
    }

    // Sibling order: `ord`, then `born`, then id. An empty `ord` sorts first.
    static func cmpOrder(_ a: Step, _ b: Step) -> Int {
      if a.ord != b.ord { return a.ord < b.ord ? -1 : 1 }
      if a.born.ms != b.born.ms { return a.born.ms < b.born.ms ? -1 : 1 }
      if a.born.counter != b.born.counter { return a.born.counter < b.born.counter ? -1 : 1 }
      if a.born.actor != b.born.actor { return a.born.actor < b.born.actor ? -1 : 1 }
      if a.id < b.id { return -1 }
      return a.id > b.id ? 1 : 0
    }
  }

  // The stamp of a step's creation, the record's `born`; a step with none carries zeros and an empty actor.
  public struct Stamp: Sendable {
    public let ms: Int64
    public let counter: Int64
    public let actor: UTF16Text

    public init(ms: Int64, counter: Int64, actor: String) {
      self.ms = ms
      self.counter = counter
      self.actor = UTF16Text(actor)
    }
  }

  public enum Malformed: Error, Equatable {
    case duplicateStep(UTF16Text)
    case unknownStep(UTF16Text, followedBy: UTF16Text)
    case cycle
  }

  public let steps: [Step]
  let follows: [[Int]]
  // The steps that follow nothing, in the steps' order.
  let roots: [Int]
  let topoOrder: [Int]
  let trunk: TrunkTree

  public init(steps: [Step]) throws(Malformed) {
    var placeOf: [UTF16Text: Int] = [:]
    for (place, step) in steps.enumerated() {
      if placeOf.updateValue(place, forKey: step.id) != nil { throw .duplicateStep(step.id) }
    }
    var follows: [[Int]] = []
    for step in steps {
      var followed: [Int] = []
      for id in step.follows {
        guard let place = placeOf[id] else { throw .unknownStep(id, followedBy: step.id) }
        followed.append(place)
      }
      follows.append(followed)
    }
    var followers = [[Int]](repeating: [], count: steps.count)
    for (follower, followed) in follows.enumerated() {
      for step in followed { followers[step].append(follower) }
    }

    // A queue: it starts as the steps that follow nothing, in the steps' order; a step leaves from the front, and its
    // followers each join the back once every step they follow has left.
    let roots = steps.indices.filter { follows[$0].isEmpty }
    var unmet = follows.map(\.count)
    var topoOrder = roots
    var front = 0
    while front < topoOrder.count {
      for follower in followers[topoOrder[front]] {
        unmet[follower] -= 1
        if unmet[follower] == 0 { topoOrder.append(follower) }
      }
      front += 1
    }
    if topoOrder.count != steps.count { throw .cycle }

    self.steps = steps
    self.follows = follows
    self.roots = roots
    self.topoOrder = topoOrder
    self.trunk = TrunkTree(steps: steps, follows: follows, roots: roots, topoOrder: topoOrder)
  }

  // A step that is done is complete; any other is available when every step it follows is done.
  public var tiers: [Tier] {
    steps.indices.map { step in
      if steps[step].done { return .complete }
      return follows[step].allSatisfy { steps[$0].done } ? .available : .locked
    }
  }
}

// The tier a step is drawn in; higher is more progress.
public enum Tier: Int, Sendable {
  case locked = 0
  case available = 1
  case complete = 2
}

public enum LinkKind: String, Sendable {
  case trunk
  case inBranch = "in-branch"
  case crossBranch = "cross-branch"
}

// One trunk parent elected for each step, then each step's trunk depth, the head of its branch and its leaf weight.
struct TrunkTree: Sendable {
  // The one step that follows nothing, when there is exactly one.
  let center: Int?
  let primaryParentOf: [Int?]
  let trunkDepthOf: [Int]
  let branchOf: [Int]
  let trunkChildrenOf: [[Int]]
  let leafCountOf: [Int]

  init(steps: [SkillTree.Step], follows: [[Int]], roots: [Int], topoOrder: [Int]) {
    let center = roots.count == 1 ? roots[0] : nil
    var primaryParentOf = [Int?](repeating: nil, count: steps.count)
    var trunkDepthOf = [Int](repeating: 0, count: steps.count)
    var branchOf = Array(steps.indices)
    var trunkChildrenOf = [[Int]](repeating: [], count: steps.count)

    // A step with several links is seated by one: among the steps it follows that share its hue, or among all of them
    // when none does, the one of least trunk depth, then of least id.
    for step in topoOrder where !follows[step].isEmpty {
      let parents = follows[step]
      let sameKind = parents.filter { steps[$0].hue == steps[step].hue }
      let candidates = sameKind.isEmpty ? parents : sameKind
      var elected = candidates[0]
      for candidate in candidates.dropFirst() {
        let depthGap = trunkDepthOf[candidate] - trunkDepthOf[elected]
        if depthGap < 0 || (depthGap == 0 && steps[candidate].id < steps[elected].id) { elected = candidate }
      }
      primaryParentOf[step] = elected
      trunkDepthOf[step] = trunkDepthOf[elected] + 1
      let cutsBranch = elected == center || steps[elected].hue != steps[step].hue
      branchOf[step] = cutsBranch ? step : branchOf[elected]
      trunkChildrenOf[elected].append(step)
    }

    for step in steps.indices {
      trunkChildrenOf[step].sort { SkillTree.Step.cmpOrder(steps[$0], steps[$1]) < 0 }
    }

    var leafCountOf = [Int](repeating: 1, count: steps.count)
    for step in topoOrder.reversed() where !trunkChildrenOf[step].isEmpty {
      leafCountOf[step] = trunkChildrenOf[step].reduce(0) { $0 + leafCountOf[$1] }
    }

    self.center = center
    self.primaryParentOf = primaryParentOf
    self.trunkDepthOf = trunkDepthOf
    self.branchOf = branchOf
    self.trunkChildrenOf = trunkChildrenOf
    self.leafCountOf = leafCountOf
  }

  func edgeKind(_ from: Int, _ to: Int) -> LinkKind {
    if primaryParentOf[to] == from { return .trunk }
    if branchOf[from] == branchOf[to] { return .inBranch }
    return .crossBranch
  }
}

// World units, y down.
public struct Point: Sendable, Equatable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

public struct Rect: Sendable, Equatable {
  public var minX: Double
  public var maxX: Double
  public var minY: Double
  public var maxY: Double

  public init(minX: Double, maxX: Double, minY: Double, maxY: Double) {
    self.minX = minX
    self.maxX = maxX
    self.minY = minY
    self.maxY = maxY
  }
}

// A roadmap seated (`SkillTree.toRenderModel`): every step where it is drawn and in which tier, every link with its kind
// and its sway, and the box around every seat, grown by a step's size on each side.
public struct RenderModel: Sendable {
  public struct Node: Sendable {
    public let id: UTF16Text
    public let label: String
    public let x: Double
    public let y: Double
    public let tier: Tier
    // The head of the step's branch, by its place.
    public let branch: Int
    // A step that follows nothing wears the crown.
    public let crowned: Bool
  }

  // One for each id a step follows, steps in order and each step's `follows` in order: `from` the followed, `to` the follower.
  public struct Link: Sendable {
    public let from: Int
    public let to: Int
    public let kind: LinkKind
    public let sway: Double
  }

  public let nodes: [Node]
  public let links: [Link]
  public let bounds: Rect

  public init(of tree: SkillTree, seats: [Point]) {
    let tiers = tree.tiers
    nodes = tree.steps.indices.map { step in
      Node(
        id: tree.steps[step].id, label: tree.steps[step].label, x: seats[step].x, y: seats[step].y, tier: tiers[step],
        branch: tree.trunk.branchOf[step], crowned: tree.follows[step].isEmpty)
    }
    links = tree.steps.indices.flatMap { to in
      tree.follows[to].map { from in
        Link(from: from, to: to, kind: tree.trunk.edgeKind(from, to), sway: EdgeCurve.bendOf(tree.steps[from].id, tree.steps[to].id))
      }
    }
    // A roadmap with no steps has the extent of one step at the origin.
    let xs = seats.isEmpty ? [0] : seats.map(\.x)
    let ys = seats.isEmpty ? [0] : seats.map(\.y)
    bounds = Rect(
      minX: Math.min(of: xs) - Theme.nodeSize, maxX: Math.max(of: xs) + Theme.nodeSize,
      minY: Math.min(of: ys) - Theme.nodeSize, maxY: Math.max(of: ys) + Theme.nodeSize)
  }

  // The control point of a link's quadratic curve between its two seats.
  public func controlPoint(of link: Link) -> Point {
    EdgeCurve.controlPoint(nodes[link.from].x, nodes[link.from].y, nodes[link.to].x, nodes[link.to].y, link.sway)
  }
}
