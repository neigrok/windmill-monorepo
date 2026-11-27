import DomainKit
import SyncCore

// Where a roadmap sits among the roadmaps a reader holds. One the reader does not hold, or holds past an unread parent, stays unknown.
public struct Location: Sendable {
  public enum Standing: String, Sendable {
    case standing, hidden, unknown
  }

  // The way down from the root to a standing roadmap, each step with the title of the roadmap that holds it.
  public struct Place: Sendable {
    public struct PathStep: Sendable {
      public let tree: String
      public let step: String
      public let title: String?
    }

    public let root: String
    public let parent: RoadmapTree.Parent?
    public let path: [PathStep]
    public let depth: Int
  }

  public let standing: Standing
  public let place: Place?
  // A root's own title, a subtree's owning step's label; none for a roadmap that is hidden, unknown or unread.
  public let title: String?

  static let hidden = Location(standing: .hidden, place: nil, title: nil)
  static let unknown = Location(standing: .unknown, place: nil, title: nil)
}

// A step's way into another roadmap: the subtree it owns, else the root its pointer opens.
public struct Opening: Sendable {
  public enum Kind: String, Sendable {
    case subtree, pointer
  }

  // An unknown or unread roadmap is neither complete nor dangling; a known one that is hidden or sits elsewhere dangles.
  public enum Status: String, Sendable {
    case loaded, unread, unknown, dangling
  }

  public let node: String
  public let kind: Kind
  public let tree: String
  public let status: Status
}

// What a step's opening comes to: whether the roadmap it opens is complete, how far it is and whether it leads back.
public struct OpeningRead: Sendable {
  public let opening: Opening
  public let complete: Bool
  public let counts: Counts?
  public let loop: Bool
}

// A subtree a step still names that no longer stands where the step is.
public struct StaleBranch: Sendable {
  public let node: String
  public let tree: String
}

// A roadmap's completed steps in authored order, and the date each shows.
public struct Progress: Sendable {
  public struct Dated: Sendable {
    public let node: String
    public let at: Instant?
  }

  public let dates: [Dated]

  public var completed: [String] { dates.map(\.node) }
}

public struct Guide: Sendable {
  public let tree: String
  public let title: String
  public let text: String
  public let own: Bool
  // How many openings away from the roadmap read its guide comes from: 0 for the roadmap's own.
  public let distance: Int
}

// One of the person's own roadmaps as their list shows it.
public struct ListedRoadmap: Sendable {
  public let id: String
  public let title: String?
  public let counts: Counts?
  public let updatedAt: Instant?
}

// The shortest way from a roadmap down to one it leads to: how many openings away, and the next roadmap on the way.
struct WayBack: Sendable {
  let tree: String
  let distance: Int
  let next: String?
}

// The newest stamped mark that completes a roadmap, and its date.
struct LatestMark: Sendable {
  let stamp: Stamp
  let at: Instant?

  static func later(_ a: LatestMark?, _ b: LatestMark?) -> LatestMark? {
    guard let a else { return b }
    guard let b else { return a }
    return a.stamp < b.stamp ? b : a
  }
}

// The roadmaps one reader holds, read together: where each stands, what each step opens and what each roadmap comes to.
public struct RoadmapAccount: Sendable {
  struct Opener: Sendable {
    let tree: String
    let node: String
  }

  // What a read elsewhere says one roadmap has come to, as a reader's progress answer names a subtree its steps own.
  public struct Told: Sendable {
    public let tree: String
    public let counts: Counts

    public init(tree: String, counts: Counts) {
      self.tree = tree
      self.counts = counts
    }
  }

  // Every roadmap, in id byte order.
  public let trees: [RoadmapTree]
  // The groups of standing roadmaps that open one another round, each in id byte order.
  public let loops: [[String]]
  let byId: ByText<RoadmapTree>
  let locations: ByText<Location>
  let openings: ByText<[Opening]>
  let staleBranches: ByText<[StaleBranch]>
  // The steps that open each roadmap and count on it.
  let openers: ByText<[Opener]>
  // How many present steps each roadmap still waits on.
  let pending: ByText<Int>
  let complete: Set<[UInt8]>
  let latestMarks: ByText<LatestMark>
  let loopOf: ByText<Int>
  // The roadmaps counted as a read elsewhere tells them: each the device holds no read copy of, and that is not hidden.
  let told: ByText<Counts>

  // `told` counts a roadmap the device holds no read copy of as it is told, complete once it has steps and every one is
  // done; one the device has read counts from its copy whatever it is told.
  public init(_ trees: [RoadmapTree], told: [Told] = []) {
    let ordered = trees.sorted { $0.id.utf8.lexicographicallyPrecedes($1.id.utf8) }
    let byId = ByText<RoadmapTree>(ordered.map { (Array($0.id.utf8), $0) }) { _, last in last }
    precondition(byId.count == trees.count, "Duplicate normalized tree identity")

    var locations = ByText<Location>()
    for start in ordered where locations[start.id] == nil {
      var subtrees: [RoadmapTree] = []
      var seen = Set<[UInt8]>()
      var current = start.id
      var base = Location.unknown
      while seen.insert(Array(current.utf8)).inserted {
        if let known = locations[current] {
          base = known
          break
        }
        guard let tree = byId[current] else { break }
        // D-3: a root stands once its tree scope holds its meta; one read without it, a creation or a fork under way, does not.
        if !tree.present || (tree.parent == nil && tree.read == .loaded && tree.meta == nil) {
          base = .hidden
          locations[current] = base
          break
        }
        guard let parent = tree.parent else {
          let place = Location.Place(root: tree.id, parent: nil, path: [], depth: 0)
          base = Location(standing: .standing, place: place, title: tree.read == .loaded ? tree.meta?.title : nil)
          locations[current] = base
          break
        }
        subtrees.append(tree)
        current = parent.tree
      }
      for subtree in subtrees.reversed() {
        guard let parent = subtree.parent else { continue }
        let holder = byId[parent.tree]
        let step = holder?.step(parent.step)
        if base.standing == .standing && holder?.read != .loaded {
          base = .unknown
        } else if base.standing == .standing && step?.present != true {
          base = .hidden
        } else if let place = base.place, let step {
          let down = Location.Place.PathStep(tree: parent.tree, step: parent.step, title: base.title)
          let deeper = Location.Place(root: place.root, parent: parent, path: place.path + [down], depth: place.depth + 1)
          base = Location(standing: .standing, place: deeper, title: step.label)
        }
        locations[subtree.id] = base
      }
    }

    var counted = ByText<Counts>()
    for each in told where locations[each.tree]?.standing != .hidden {
      let read = byId[each.tree]?.read == .loaded && locations[each.tree]?.standing == .standing
      if !read { counted[each.tree] = each.counts }
    }

    var openings = ByText<[Opening]>()
    var staleBranches = ByText<[StaleBranch]>()
    var openers = ByText<[Opener]>()
    var pending = ByText<Int>()
    var latestMarks = ByText<LatestMark>()
    var ready: [String] = []
    for tree in ordered where locations[tree.id]?.standing == .standing && tree.read == .loaded {
      var opened: [Opening] = []
      var stale: [StaleBranch] = []
      var waiting = tree.index.nodes.count
      var latest: LatestMark? = nil
      for node in tree.index.nodes {
        let here = RoadmapTree.Parent(tree: tree.id, step: node.id)
        var branch = node.branch
        if let named = branch, let child = byId[named], locations[named]?.standing == .hidden || (child.read == .loaded && child.parent != here) {
          stale.append(StaleBranch(node: node.id, tree: named))
          branch = nil
        }
        let pointer = tree.pointer(on: node.id)
        if let target = branch ?? (pointer?.present == true ? pointer?.opens : nil) {
          let kind: Opening.Kind = branch == nil ? .pointer : .subtree
          var status = Opening.Status.unknown
          if let roadmap = byId[target] {
            let allowed = kind == .pointer ? roadmap.parent == nil : roadmap.read == .unread || roadmap.parent == here
            let standing = locations[target]?.standing
            if !allowed || standing == .hidden {
              status = .dangling
            } else if standing == .standing {
              status = roadmap.read == .loaded ? .loaded : .unread
            }
          }
          opened.append(Opening(node: node.id, kind: kind, tree: target, status: status))
          if status == .loaded || status == .unread || (status == .unknown && counted[target] != nil) {
            openers[target, default: []].append(Opener(tree: tree.id, node: node.id))
          }
          if status != .dangling { continue }
        }
        guard let mark = tree.mark(on: node.id), mark.isComplete else { continue }
        waiting -= 1
        if let stamp = mark.stamp, stamp != .unset { latest = LatestMark.later(latest, LatestMark(stamp: stamp, at: mark.at)) }
      }
      openings[tree.id] = opened
      staleBranches[tree.id] = stale
      pending[tree.id] = waiting
      latestMarks[tree.id] = latest
      if !tree.index.nodes.isEmpty && waiting == 0 { ready.append(tree.id) }
    }

    for (id, counts) in counted where counts.total > 0 && counts.done == counts.total { ready.append(String(decoding: id, as: UTF8.self)) }
    // Completion is the least fixed point: a roadmap completes once every step it waits on has, and never by a loop alone.
    var complete = Set<[UInt8]>()
    while let id = ready.popLast() {
      guard complete.insert(Array(id.utf8)).inserted else { continue }
      for opener in openers[id] ?? [] {
        let remaining = (pending[opener.tree] ?? 0) - 1
        pending[opener.tree] = remaining
        latestMarks[opener.tree] = LatestMark.later(latestMarks[opener.tree], latestMarks[id])
        if remaining == 0 { ready.append(opener.tree) }
      }
    }

    let standing = ordered.map(\.id).filter { locations[$0]?.standing == .standing }
    let slots = ByText<Int>(uniqueKeysWithValues: standing.enumerated().map { (Array($0.element.utf8), $0.offset) })
    let adjacency = standing.map { id in (openers[id] ?? []).compactMap { slots[$0.tree] } }
    let loops = Components(adjacency).groups.filter { $0.count > 1 || adjacency[$0[0]].contains($0[0]) }
      .map { group in group.map { standing[$0] }.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) } }
      .sorted { $0[0].utf8.lexicographicallyPrecedes($1[0].utf8) }
    var loopOf = ByText<Int>()
    for (loop, ids) in loops.enumerated() {
      for id in ids { loopOf[id] = loop }
    }

    self.trees = ordered
    self.loops = loops
    self.byId = byId
    self.locations = locations
    self.openings = openings
    self.staleBranches = staleBranches
    self.openers = openers
    self.pending = pending
    self.complete = complete
    self.latestMarks = latestMarks
    self.loopOf = loopOf
    self.told = counted
  }

  public func location(of id: String) -> Location { locations[id] ?? .unknown }
  public func isComplete(_ id: String) -> Bool { complete.contains(Array(id.utf8)) }

  // A roadmap that stands and is read; an unread or empty roadmap is never a complete one.
  func standingTree(_ id: String) -> RoadmapTree? {
    guard let tree = byId[id], tree.read == .loaded, locations[id]?.standing == .standing else { return nil }
    return tree
  }

  // A roadmap the device holds no read copy of counts as it was told, where it was.
  public func counts(_ id: String) -> Counts? {
    guard let total = standingTree(id)?.index.nodes.count else { return told[id] }
    return Counts(done: total - (pending[id] ?? total), total: total)
  }

  // An opening that does not dangle sets the step's mark aside: the step is complete as the roadmap it opens is, and dated by it.
  // A roadmap complete only by what a read elsewhere tells of it holds no marks to date the step by, so the step's own
  // complete mark dates it as that read dated it, stamped or not.
  public func progress(_ id: String) -> Progress? {
    guard let tree = standingTree(id) else { return nil }
    let opened = ByText<Opening>((openings[id] ?? []).map { (Array($0.node.utf8), $0) }) { _, last in last }
    return Progress(dates: tree.index.nodes.compactMap { node -> Progress.Dated? in
      let mark = tree.mark(on: node.id)
      guard let opening = opened[node.id], opening.status != .dangling else {
        return mark?.isComplete == true ? Progress.Dated(node: node.id, at: mark?.at) : nil
      }
      guard isComplete(opening.tree) else { return nil }
      if let mark, mark.isComplete, told[opening.tree] != nil || (mark.stamp.map { $0 != .unset } ?? false) {
        return Progress.Dated(node: node.id, at: mark.at)
      }
      let setAt = opening.kind == .subtree ? node.branchStamp : tree.pointer(on: node.id)?.setAt
      let set = setAt.flatMap { $0 == .unset ? nil : LatestMark(stamp: $0, at: Instant(ms: $0.ms)) }
      return Progress.Dated(node: node.id, at: LatestMark.later(latestMarks[opening.tree], set)?.at)
    })
  }

  // The graph of a standing roadmap that is read, its steps complete and dated as the account reads them.
  public func graph(_ id: String) -> FollowGraph? {
    guard let tree = standingTree(id), let progress = progress(id) else { return nil }
    var done = [Bool](repeating: false, count: tree.index.ids.count)
    var dateAt = [Instant?](repeating: nil, count: done.count)
    for date in progress.dates {
      guard let slot = tree.index.slot(of: date.node) else { continue }
      done[slot] = true
      dateAt[slot] = date.at
    }
    return FollowGraph(tree, done: done, dateAt: dateAt)
  }

  // Every roadmap that leads to `target`, by the shortest way, the least id next among equals.
  func waysBack(_ target: String) -> ByText<WayBack> {
    var ways = ByText<WayBack>()
    guard locations[target]?.standing == .standing else { return ways }
    ways[target] = WayBack(tree: target, distance: 0, next: nil)
    var level = [target]
    var distance = 0
    while !level.isEmpty {
      distance += 1
      var above: [String] = []
      for below in level {
        for opener in openers[below] ?? [] {
          guard let known = ways[opener.tree] else {
            ways[opener.tree] = WayBack(tree: opener.tree, distance: distance, next: below)
            above.append(opener.tree)
            continue
          }
          if known.distance == distance, let next = known.next, below.utf8.lexicographicallyPrecedes(next.utf8) {
            ways[opener.tree] = WayBack(tree: opener.tree, distance: distance, next: below)
          }
        }
      }
      level = above
    }
    return ways
  }

  // The nearest eight nonempty guides, the roadmap's own included, farthest first, equals in id byte order.
  public func guides(_ id: String) -> [Guide] {
    let candidates = waysBack(id).values.compactMap { way -> Guide? in
      guard let tree = byId[way.tree], tree.read == .loaded, let meta = tree.meta, !meta.guide.isEmpty else { return nil }
      return Guide(tree: way.tree, title: locations[way.tree]?.title ?? "", text: meta.guide, own: !meta.guideInherited, distance: way.distance)
    }
    let nearest = candidates.sorted { a, b in
      a.distance != b.distance ? a.distance < b.distance : a.tree.utf8.lexicographicallyPrecedes(b.tree.utf8)
    }.prefix(8)
    return nearest.sorted { a, b in
      a.distance != b.distance ? a.distance > b.distance : a.tree.utf8.lexicographicallyPrecedes(b.tree.utf8)
    }
  }

  // What each step of one roadmap opens comes to, read without reading every roadmap: one the device holds no read copy of
  // as a read elsewhere told it.
  public func openings(of id: String) -> [OpeningRead] {
    (openings[id] ?? []).map { opening in
      let known = opening.status == .loaded || opening.status == .unread
      return OpeningRead(opening: opening, complete: opening.status != .dangling && isComplete(opening.tree),
                         counts: opening.status == .dangling ? nil : counts(opening.tree),
                         loop: known && loopOf[id] != nil && loopOf[id] == loopOf[opening.tree])
    }
  }

  // The person's own roots that stand, newest first by when the server last received a record of each, or, of one no server
  // has received, by its newest stamp the phone holds; one with neither last, equals in id byte order.
  public func list() -> [ListedRoadmap] {
    let roots = trees.filter { $0.own && locations[$0.id]?.standing == .standing && $0.parent == nil }
    let newestFirst = roots.sorted { a, b in
      let (left, right) = (a.updatedAt ?? a.stampedAt, b.updatedAt ?? b.stampedAt)
      if (left == nil) != (right == nil) { return left != nil }
      if let left, let right, left != right { return left > right }
      return a.id.utf8.lexicographicallyPrecedes(b.id.utf8)
    }
    return newestFirst.compactMap { listing($0.id) }
  }

  // A roadmap that stands, whoever owns it, as a list shows it: what a reader's cover names a roadmap someone else shared by.
  public func listing(_ id: String) -> ListedRoadmap? {
    guard let tree = byId[id], locations[id]?.standing == .standing else { return nil }
    return ListedRoadmap(id: tree.id, title: locations[id]?.title, counts: counts(id), updatedAt: tree.updatedAt)
  }
}
