import DomainKit

// The strongly connected components of a graph given as each vertex's parents, every component after the components it reaches.
public struct Components: Sendable {
  public let groups: [[Int]]
  public let componentOf: [Int]

  public init(_ adjacency: [[Int]]) {
    var reached = [Int](repeating: -1, count: adjacency.count)
    var low = [Int](repeating: 0, count: adjacency.count)
    var active = [Bool](repeating: false, count: adjacency.count)
    var componentOf = [Int](repeating: 0, count: adjacency.count)
    var pending: [Int] = []
    var groups: [[Int]] = []
    var serial = 0
    for start in adjacency.indices where reached[start] == -1 {
      var walk = [(vertex: start, next: 0)]
      while let frame = walk.last {
        let vertex = frame.vertex
        if reached[vertex] == -1 {
          reached[vertex] = serial
          low[vertex] = serial
          serial += 1
          active[vertex] = true
          pending.append(vertex)
        }
        if frame.next < adjacency[vertex].count {
          let parent = adjacency[vertex][frame.next]
          walk[walk.count - 1].next += 1
          if reached[parent] == -1 {
            walk.append((vertex: parent, next: 0))
          } else if active[parent] {
            low[vertex] = min(low[vertex], reached[parent])
          }
          continue
        }
        walk.removeLast()
        if let previous = walk.last { low[previous.vertex] = min(low[previous.vertex], low[vertex]) }
        guard low[vertex] == reached[vertex] else { continue }
        var group: [Int] = []
        while let member = pending.popLast() {
          active[member] = false
          componentOf[member] = groups.count
          group.append(member)
          if member == vertex { break }
        }
        groups.append(group)
      }
    }
    self.groups = groups
    self.componentOf = componentOf
  }
}

extension Collection where Element == UInt32 {
  // The bits set in a row of 32-bit words, ascending.
  func forEachBit(_ body: (Int) -> Void) {
    for (word, bits) in enumerated() {
      var rest = bits
      while rest != 0 {
        body(word * 32 + rest.trailingZeroBitCount)
        rest &= rest - 1
      }
    }
  }
}

// Bitset rows for the members of a raw graph: a member's row holds its own seed and, where it is read through, its member parents' rows.
struct Closure: Sendable {
  let words: Int
  let bits: [UInt32]
  let rowOf: [Int]

  // A vertex outside `members` takes no row, so only the vertices a read passes through cost one.
  init(members: [Int], parents: [[Int]], seedOf: [Int], size: Int, follows: (Int) -> Bool) {
    let words = (size + 31) / 32
    var memberOf = [Int](repeating: -1, count: seedOf.count)
    for (member, vertex) in members.enumerated() { memberOf[vertex] = member }
    let adjacency = members.map { vertex in follows(vertex) ? parents[vertex].map { memberOf[$0] }.filter { $0 >= 0 } : [] }
    let found = Components(adjacency)
    var bits = [UInt32](repeating: 0, count: found.groups.count * words)
    var merged = [Int](repeating: -1, count: found.groups.count)
    for (component, group) in found.groups.enumerated() {
      let row = component * words
      for member in group {
        let seed = seedOf[members[member]]
        if seed >= 0 { bits[row + (seed >> 5)] |= UInt32(1) << (seed & 31) }
        for parent in adjacency[member] {
          let dependency = found.componentOf[parent]
          if dependency == component || merged[dependency] == component { continue }
          merged[dependency] = component
          let source = dependency * words
          for word in 0..<words { bits[row + word] |= bits[source + word] }
        }
      }
    }
    self.words = words
    self.bits = bits
    rowOf = memberOf.map { $0 < 0 ? -1 : found.componentOf[$0] * words }
  }

  func row(of vertex: Int) -> ArraySlice<UInt32>? {
    rowOf[vertex] < 0 ? nil : bits[rowOf[vertex]..<rowOf[vertex] + words]
  }
}

// The present steps' values by id, each read from what is kept at its step's slot.
public struct BySlot<Value>: Sequence {
  let index: TreeIndex
  public let values: [Value]

  public subscript(id: String) -> Value? { index.slot(of: id).map { values[$0] } }

  public func makeIterator() -> Zip2Sequence<[String], [Value]>.Iterator { zip(index.ids, values).makeIterator() }
}

extension BySlot: Sendable where Value: Sendable {}

public enum StepState: String, Sendable {
  case available, locked, complete
}

// A step another follows: the live links entering the follower that reach it, by where they come from, and whether one passes an absent step.
public struct Followed: Sendable {
  public let id: String
  public let incoming: [RoadmapTree.Edge]
  public let throughAbsent: Bool
}

// How many of a roadmap's present steps are complete.
public struct Counts: Sendable {
  public let done: Int
  public let total: Int
}

// What each present step follows as it is read: its present parents and, through each absent step, what that step followed.
public struct FollowGraph: Sendable {
  public let tree: RoadmapTree
  let done: [Bool]
  let dateAt: [Instant?]
  let stateAt: [StepState]
  let unmetCount: [Int]
  let firstUnmet: [Int?]
  let degree: [Int]
  // The steps finishing each step alone would open.
  let opens: [[Int]]
  // What each absent step is read through to: the present steps behind it.
  let reach: Closure
  // The followed prerequisites of a step behind an absent parent; any other step follows its parents.
  let rows: [Int: [UInt32]]

  // A step is complete by the tree's own marks, which sets an opening's mark aside.
  public init(_ tree: RoadmapTree) {
    self.init(tree, done: tree.index.markedDone, dateAt: tree.index.markedAt)
  }

  // Which steps are complete, and when, by slot.
  init(_ tree: RoadmapTree, done: [Bool], dateAt: [Instant?]) {
    precondition(tree.read == .loaded, "Roadmap graph is unread")
    let index = tree.index
    let count = index.ids.count
    let absent = Array(count..<index.rawIds.count)
    var seedOf = [Int](repeating: -1, count: index.rawIds.count)
    var touching: [Int] = []
    for vertex in absent {
      for parent in index.parents[vertex] where parent < count && seedOf[parent] < 0 {
        seedOf[parent] = parent
        touching.append(parent)
      }
    }
    let reach = Closure(members: touching + absent, parents: index.parents, seedOf: seedOf, size: count) { $0 >= count }
    var stateAt = [StepState](repeating: .available, count: count)
    var unmetCount = [Int](repeating: 0, count: count)
    var firstUnmet = [Int?](repeating: nil, count: count)
    var degree = [Int](repeating: 0, count: count)
    var opens = [[Int]](repeating: [], count: count)
    var rows: [Int: [UInt32]] = [:]
    // The step whose parents last counted each parent, so a parent linked twice counts once.
    var countedFor = [Int](repeating: -1, count: count)
    for slot in 0..<count {
      let parents = index.parents[slot]
      var unmet = 0
      var followed = 0
      var first: Int? = nil
      if parents.allSatisfy({ $0 < count }) {
        for parent in parents where countedFor[parent] != slot {
          countedFor[parent] = slot
          followed += 1
          if done[parent] { continue }
          first = min(first ?? parent, parent)
          unmet += 1
        }
      } else {
        var row = [UInt32](repeating: 0, count: reach.words)
        for parent in parents {
          if parent < count {
            row[parent >> 5] |= UInt32(1) << (parent & 31)
          } else if let source = reach.row(of: parent) {
            for (word, bits) in source.enumerated() { row[word] |= bits }
          }
        }
        rows[slot] = row
        row.forEachBit { prerequisite in
          followed += 1
          if done[prerequisite] { return }
          first = first ?? prerequisite
          unmet += 1
        }
      }
      unmetCount[slot] = unmet
      firstUnmet[slot] = first
      degree[slot] = followed
      stateAt[slot] = done[slot] ? .complete : unmet > 0 ? .locked : .available
      if !done[slot], unmet == 1, let first, first != slot { opens[first].append(slot) }
    }
    self.tree = tree
    self.done = done
    self.dateAt = dateAt
    self.stateAt = stateAt
    self.unmetCount = unmetCount
    self.firstUnmet = firstUnmet
    self.degree = degree
    self.opens = opens
    self.reach = reach
    self.rows = rows
  }

  public var ids: [String] { tree.index.ids }
  public var states: BySlot<StepState> { BySlot(index: tree.index, values: stateAt) }
  // How many present steps each step follows, met or not.
  public var inDegree: BySlot<Int> { BySlot(index: tree.index, values: degree) }
  public var counts: Counts { Counts(done: done.count { $0 }, total: done.count) }

  // Every present step a step follows, in authored order, with the links that reach each.
  public func followed(_ id: String) -> [Followed] {
    let index = tree.index
    guard let slot = index.slot(of: id) else { return [] }
    var found: [Int: (incoming: [String], throughAbsent: Bool)] = [:]
    for parent in Set(index.parents[slot]) {
      let throughAbsent = parent >= index.ids.count
      let reached = { (prerequisite: Int) in
        found[prerequisite, default: ([], false)].incoming.append(index.rawIds[parent])
        if throughAbsent { found[prerequisite]?.throughAbsent = true }
      }
      if throughAbsent { reach.row(of: parent)?.forEachBit(reached) } else { reached(parent) }
    }
    return found.sorted { $0.key < $1.key }.map { prerequisite, entry in
      let sources = entry.incoming.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
      return Followed(id: index.ids[prerequisite], incoming: sources.map { RoadmapTree.Edge(from: $0, to: id, present: true) },
                      throughAbsent: entry.throughAbsent)
    }
  }

  // The followed prerequisites a step still owes, in authored order.
  public func unmet(_ id: String) -> [String] {
    let index = tree.index
    guard let slot = index.slot(of: id) else { return [] }
    var prerequisites: [Int] = []
    if let row = rows[slot] { row.forEachBit { prerequisites.append($0) } } else { prerequisites = Set(index.parents[slot]).sorted() }
    return prerequisites.filter { !done[$0] }.map { index.ids[$0] }
  }

  // The steps finishing a step alone would open, in authored order.
  public func unlocks(_ id: String) -> [String] {
    tree.index.slot(of: id).map { opens[$0].map { tree.index.ids[$0] } } ?? []
  }

  // The present steps a step's branch holds, by slot: itself, all it follows and all that follow it; nil for a step that is not present.
  func branch(of id: String) -> [Bool]? {
    let index = tree.index
    guard let origin = index.slot(of: id) else { return nil }
    var included = [Bool](repeating: false, count: index.ids.count)
    included[origin] = true
    for adjacency in [index.parents, index.children] {
      var seen = [Bool](repeating: false, count: index.rawIds.count)
      seen[origin] = true
      var pending = [origin]
      while let vertex = pending.popLast() {
        for next in adjacency[vertex] where !seen[next] {
          seen[next] = true
          if next < included.count { included[next] = true }
          pending.append(next)
        }
      }
    }
    return included
  }

  // Only the unfinished and absent vertices take a row.
  public func owedIndex() -> OwedIndex {
    let index = tree.index
    var seedOf = [Int](repeating: -1, count: index.rawIds.count)
    var unfinished: [Int] = []
    var members: [Int] = []
    for vertex in index.rawIds.indices where vertex >= done.count || !done[vertex] {
      if vertex < done.count {
        seedOf[vertex] = unfinished.count
        unfinished.append(vertex)
      }
      members.append(vertex)
    }
    let closure = Closure(members: members, parents: index.parents, seedOf: seedOf, size: unfinished.count) { _ in true }
    let toGo = index.ids.indices.map { slot in
      closure.row(of: slot).map { row in row.reduce(0) { $0 + $1.nonzeroBitCount } - 1 } ?? 0
    }
    return OwedIndex(index: index, closure: closure, unfinished: unfinished, toGo: toGo)
  }
}

// What each unfinished step owes: every unfinished step behind it, read through absent steps and stopping at completed ones.
public struct OwedIndex: Sendable {
  let index: TreeIndex
  let closure: Closure
  // The unfinished steps' slots in authored order; each holds the bit of its place here.
  let unfinished: [Int]
  // How many steps each step owes, by slot.
  public let toGo: [Int]

  // The steps a step owes, in authored order, never itself, even when it was completed out of order.
  public func owed(_ id: String) -> [String] {
    guard let subject = index.slot(of: id) else { return [] }
    var bits = [UInt32](repeating: 0, count: closure.words)
    for parent in index.parents[subject] {
      guard let row = closure.row(of: parent) else { continue }
      for (word, behind) in row.enumerated() { bits[word] |= behind }
    }
    return unfinished.enumerated().filter { bit, slot in slot != subject && bits[bit >> 5] & (UInt32(1) << (bit & 31)) != 0 }
      .map { index.ids[$0.element] }
  }
}
