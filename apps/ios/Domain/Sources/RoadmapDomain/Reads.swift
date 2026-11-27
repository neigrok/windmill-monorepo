import DomainKit
import SyncCore

extension [UInt8] {
  // Whether a text's bytes hold another's in a row, which finds what the web's search by UTF-16 units finds.
  func holds(_ needle: [UInt8]) -> Bool {
    guard needle.count <= count else { return false }
    return (0...(count - needle.count)).contains { self[$0...].starts(with: needle) }
  }
}

// A roadmap's legend: its present kinds in authored order, and the hues they wear.
public struct LegendRead: Sendable {
  // A hue's owner is the kind born first, then the least id; `others` wear it too, in id byte order.
  public struct Hue: Sendable {
    public let name: String
    public let owner: String
    public let others: [String]
  }

  // An entry of the legend a roadmap shows: a hue, and the kind that owns it, none for a hue no kind claims.
  public struct Shown: Sendable {
    public let hue: String
    public let kind: Kind?
  }

  public let kinds: [Kind]
  // In hue byte order.
  public let hues: [Hue]
  // The legend a roadmap shows, which a paste reads its text over: each hue's owner in the kinds' order, then each hue a
  // present step wears that no kind claims, in the palette's order, with no kind.
  public let shown: [Shown]
  let claimed: Set<[UInt8]>

  public init(_ tree: RoadmapTree) {
    let kinds = tree.kinds.filter(\.present)
    var wearers = ByText<[Kind]>()
    for kind in kinds { wearers[kind.hue, default: []].append(kind) }
    let hues = wearers.values.map { wearing -> Hue in
      let byBirth = wearing.sorted { a, b in a.born != b.born ? a.born < b.born : a.id.utf8.lexicographicallyPrecedes(b.id.utf8) }
      let others = byBirth.dropFirst().map(\.id).sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
      return Hue(name: byBirth[0].hue, owner: byBirth[0].id, others: others)
    }
    self.kinds = kinds
    self.hues = hues.sorted { $0.name.utf8.lexicographicallyPrecedes($1.name.utf8) }
    claimed = Set(wearers.keys)
    let owners = Set(hues.map { Array($0.owner.utf8) })
    let worn = Set(tree.index.nodes.map { Array($0.color.utf8) })
    shown = kinds.filter { owners.contains(Array($0.id.utf8)) }.map { Shown(hue: $0.hue, kind: $0) }
      + RoadmapRules.hues.filter { worn.contains(Array($0.utf8)) && wearers[$0] == nil }.map { Shown(hue: $0, kind: nil) }
  }

  public func claims(_ hue: String) -> Bool { claimed.contains(Array(hue.utf8)) }
}

// What MCP's search asks: a kind names a present kind and narrows to its hue, beside any colour.
public struct NodeFilter: Sendable {
  public var query: String
  public var color: String?
  public var kind: String?

  public init(query: String = "", color: String? = nil, kind: String? = nil) {
    self.query = query
    self.color = color
    self.kind = kind
  }
}

extension RoadmapTree {
  // Present steps by rank: an exact id, an id prefix, a label, an id, then a description holding the query, authored order within a rank.
  public func selectNodes(_ filter: NodeFilter = NodeFilter()) -> [String] {
    var hue: String? = nil
    if let named = filter.kind {
      guard let kind = kinds.first(where: { $0.present && $0.id.utf8.elementsEqual(named.utf8) }) else { return [] }
      hue = kind.hue
    }
    // ASCII letters fold and nothing is trimmed, so a query finds only the bytes it holds.
    let folded = { (text: String) -> [UInt8] in text.utf8.map { (0x41...0x5A).contains($0) ? $0 | 0x20 : $0 } }
    let needle = folded(filter.query)
    var ranked: [(id: String, rank: Int)] = []
    for node in nodes where node.present {
      if let color = filter.color, !node.color.utf8.elementsEqual(color.utf8) { continue }
      if let hue, !node.color.utf8.elementsEqual(hue.utf8) { continue }
      let id = folded(node.id)
      if needle.isEmpty {
        ranked.append((node.id, 5))
      } else if id == needle {
        ranked.append((node.id, 0))
      } else if id.starts(with: needle) {
        ranked.append((node.id, 1))
      } else if folded(node.label).holds(needle) {
        ranked.append((node.id, 2))
      } else if id.holds(needle) {
        ranked.append((node.id, 3))
      } else if folded(node.description).holds(needle) {
        ranked.append((node.id, 4))
      }
    }
    return ranked.stablySorted { $0.rank < $1.rank }.map(\.id)
  }
}

// What the Board asks: how to sort what is unfinished, the hues to keep, words to find in a label or a description, and a branch to stay in.
public struct BoardQuery: Sendable {
  public enum Sort: String, Sendable {
    case roadmap, newest, oldest
  }

  public var sort: Sort
  public var kinds: [String]
  public var search: String
  public var branch: String?
  public var doneExpanded: Bool

  public init(sort: Sort = .roadmap, kinds: [String] = [], search: String = "", branch: String? = nil, doneExpanded: Bool = false) {
    self.sort = sort
    self.kinds = kinds
    self.search = search
    self.branch = branch
    self.doneExpanded = doneExpanded
  }
}

// One roadmap's Board: the cards a query keeps, in three columns. A filter narrows cards and never changes a state or the overall count.
public struct BoardRead: Sendable {
  // The filters the query applies, which an empty column offers to clear.
  public enum Recovery: String, Sendable {
    case search, kinds, both
  }

  // Why a card is locked: the first step it still follows, how many more, and how many steps it owes however far back.
  public struct Needs: Sendable {
    public let first: String
    public let extra: Int
    public let toGo: Int
  }

  public struct Unlocks: Sendable {
    public let first: String
    public let extra: Int
  }

  public struct Card: Sendable {
    public let id: String
    public let column: Column.Name
    public let needs: Needs?
    public let unlocks: Unlocks?
    public let unlockCount: Int
  }

  // Done folds to its first twelve unless expanded.
  public struct Column: Sendable {
    public enum Name: String, Sendable, CaseIterable {
      case locked, upNext, done
    }

    public let name: Name
    public let ids: [String]
    public let shown: [String]
    public let folded: Bool
  }

  public let overall: Counts
  public let sort: BoardQuery.Sort
  // The branch the query named, where that step is present; a missing one does not filter.
  public let branch: String?
  public let recovery: Recovery?
  public let columns: [Column]
  public let cards: [Card]

  public init(_ graph: FollowGraph, _ query: BoardQuery = BoardQuery()) {
    let index = graph.tree.index
    let branch = query.branch.flatMap { graph.branch(of: $0) }
    let words = query.search.unicodeScalars
    var needle: [UInt8] = []
    if let first = words.firstIndex(where: { !TextWhitespace.contains($0) }), let last = words.lastIndex(where: { !TextWhitespace.contains($0) }) {
      needle = BoardRead.lowercase(String(words[first...last]))
    }
    let hues = Set(query.kinds.map { Array($0.utf8) })
    let toGo = graph.owedIndex().toGo
    var cards: [Card] = []
    var slots: [Int] = []
    for (slot, node) in index.nodes.enumerated() {
      if let branch, !branch[slot] { continue }
      if !hues.isEmpty && !hues.contains(Array(node.color.utf8)) { continue }
      if !needle.isEmpty && !BoardRead.lowercase(node.label).holds(needle) && !BoardRead.lowercase(node.description).holds(needle) {
        continue
      }
      let state = graph.stateAt[slot]
      let unlocked = state == .complete ? [] : graph.opens[slot].map { index.ids[$0] }
      let needs = state == .locked ? graph.firstUnmet[slot].map { first in
        Needs(first: index.ids[first], extra: graph.unmetCount[slot] - 1, toGo: toGo[slot])
      } : nil
      let unlocks = state == .available ? unlocked.first.map { Unlocks(first: $0, extra: unlocked.count - 1) } : nil
      slots.append(slot)
      cards.append(Card(id: node.id, column: state == .complete ? .done : state == .locked ? .locked : .upNext, needs: needs,
                        unlocks: unlocks, unlockCount: unlocked.count))
    }
    // Dated before undated, then the newest or the oldest first.
    let dated = { (a: Instant?, b: Instant?, newest: Bool) -> Bool in
      guard let a, let b else { return a != nil && b == nil }
      return newest ? a > b : a < b
    }
    columns = Column.Name.allCases.map { name in
      let members = cards.indices.filter { cards[$0].column == name }.stablySorted { a, b in
        if name == .done { return dated(graph.dateAt[slots[a]], graph.dateAt[slots[b]], true) }
        if query.sort != .roadmap { return dated(index.nodes[slots[a]].createdAt, index.nodes[slots[b]].createdAt, query.sort == .newest) }
        let (owed, other) = (cards[a].needs?.toGo ?? 0, cards[b].needs?.toGo ?? 0)
        return owed != other ? owed < other : cards[a].unlockCount > cards[b].unlockCount
      }
      let ids = members.map { cards[$0].id }
      let folded = name == .done && !query.doneExpanded && ids.count > 12
      return Column(name: name, ids: ids, shown: folded ? Array(ids.prefix(12)) : ids, folded: folded)
    }
    overall = graph.counts
    sort = query.sort
    self.branch = branch == nil ? nil : query.branch
    recovery = needle.isEmpty ? (hues.isEmpty ? nil : .kinds) : (hues.isEmpty ? .search : .both)
    self.cards = cards
  }

  // The web's `toLowerCase`, as bytes: Swift's own lowercase, but a capital sigma that ends a word becomes the final sigma.
  static func lowercase(_ text: String) -> [UInt8] {
    guard text.unicodeScalars.contains("\u{3A3}") else { return Array(text.lowercased().utf8) }
    let scalars = Array(text.unicodeScalars)
    var lowered = String.UnicodeScalarView()
    for (at, scalar) in scalars.enumerated() {
      guard scalar.value == 0x3A3 else {
        lowered.append(contentsOf: scalar.properties.lowercaseMapping.unicodeScalars)
        continue
      }
      let before: Unicode.Scalar? = scalars[..<at].last { !$0.properties.isCaseIgnorable }
      let after: Unicode.Scalar? = scalars[(at + 1)...].first { !$0.properties.isCaseIgnorable }
      let endsWord = before?.properties.isCased == true && after?.properties.isCased != true
      lowered.append(endsWord ? "\u{3C2}" : "\u{3C3}")
    }
    return Array(String(lowered).utf8)
  }
}

// A roadmap's Activity, or with `step` that step's History (spec §3, R-11): each present step's creation and completion
// that the copy holds a time for, newest first. At one time a completion stands before a creation, then the roadmap's
// authored order reversed, the last authored step first. A completion is the graph's, so a step that opens or owns a
// roadmap is completed, and dated, as the Board's Done has it.
public struct ActivityRead: Sendable {
  public struct Row: Sendable, Equatable {
    public enum Kind: String, Sendable {
      case created, completed
    }

    public let kind: Kind
    public let step: String
    public let at: Instant
  }

  public let rows: [Row]

  public init(_ graph: FollowGraph, step: String? = nil) {
    var rows: [(row: Row, slot: Int)] = []
    for (slot, node) in graph.tree.index.nodes.enumerated() {
      if let step, !node.id.utf8.elementsEqual(step.utf8) { continue }
      if graph.done[slot], let at = graph.dateAt[slot] { rows.append((Row(kind: .completed, step: node.id, at: at), slot)) }
      if let at = node.createdAt { rows.append((Row(kind: .created, step: node.id, at: at), slot)) }
    }
    self.rows = rows.sorted { a, b in
      if a.row.at != b.row.at { return a.row.at > b.row.at }
      if a.row.kind != b.row.kind { return a.row.kind == .completed }
      return a.slot > b.slot
    }.map(\.row)
  }
}

// What deleting `ids`, resetting one, attaching a roadmap to one or linking one would do (the corpus README's
// `effects`); each fact past the starting steps walks the graph when asked. `links` are a draft's sides of the one step,
// by default what it follows and what follows it as stored; `attach` is a roadmap attached to it, complete or not.
public struct EffectsRead: Sendable {
  // A draft's two sides of one step: the steps it would require and the steps it would open.
  public struct Links: Sendable {
    public let requires: [String]
    public let opens: [String]

    public init(requires: [String], opens: [String]) {
      self.requires = requires
      self.opens = opens
    }
  }

  // The present steps a new link of the one step would close a loop with: the steps it may not come to follow, and
  // the steps it may not come to lead to, each itself included.
  public struct Loops: Sendable {
    public let requires: [String]
    public let opens: [String]
  }

  public let kept: String?
  // Where a paste lands: the first starting step in authored order, none where every step follows another.
  public let under: String?
  public let takesEveryStart: Bool
  public let deletable: Bool
  let graph: FollowGraph
  let chosen: [Int]
  let only: Int?
  // The one step `ids` names, present or not.
  let drafted: String?
  let links: Links?
  let attach: Bool?

  public init(_ graph: FollowGraph, ids: [String], links: Links? = nil, attach complete: Bool? = nil) {
    let index = graph.tree.index
    let slots = ids.compactMap(index.slot(of:))
    let chosen = Set(slots)
    let present = slots.count == ids.count
    self.graph = graph
    self.chosen = Array(chosen)
    only = present && chosen.count == 1 ? chosen.first : nil
    drafted = Set(ids.map { Array($0.utf8) }).count == 1 ? ids.first : nil
    self.links = links
    attach = complete
    kept = graph.starting.count == 1 ? graph.starting[0] : nil
    under = graph.starting.first
    takesEveryStart = !graph.starting.isEmpty && graph.starting.allSatisfy { index.slot(of: $0).map(chosen.contains) == true }
    deletable = !ids.isEmpty && present && !takesEveryStart
  }

  public var follow: [String] {
    let index = graph.tree.index
    // A present step stops the walk: what follows it follows it, not the selection.
    var passed = Set(chosen)
    var pending = chosen
    var followers: [Int] = []
    while let vertex = pending.popLast() {
      for next in index.children[vertex] {
        guard passed.insert(next).inserted else { continue }
        if next < index.ids.count { followers.append(next) } else { pending.append(next) }
      }
    }
    return followers.sorted().map { index.ids[$0] }
  }

  // Whether the one step holds a complete mark, counted or set aside.
  var marked: Bool { only.map { graph.tree.mark(on: graph.tree.index.ids[$0])?.isComplete == true } ?? false }

  // The followers that stand Up next only while the one step stands complete.
  var upNextFollowers: [String] { follow.filter { graph.states[$0] == .available } }

  public var relocks: [String] {
    guard let only, graph.done[only], graph.tree.index.markedDone[only] else { return [] }
    return upNextFollowers
  }

  // A complete mark the graph does not count, because the step opens or owns a roadmap that is not complete: the steps
  // it alone would open, which lock while it stands aside.
  public var setAside: [String]? {
    guard let only, marked, !graph.tree.index.markedDone[only], !graph.done[only] else { return nil }
    return graph.opens[only].map { graph.tree.index.ids[$0] }
  }

  // What attaching a roadmap does to the steps after a marked step: a roadmap that is not complete sets the mark aside,
  // so the steps that stood Up next by the step's completion lock again.
  public var attachRelocks: [String]? {
    guard let complete = attach, let only, marked else { return nil }
    return complete || !graph.done[only] ? [] : upNextFollowers
  }

  // Live links are walked through absent steps, never through the step itself: onward from the steps it opens for the
  // steps it may not require, back from the steps it requires for the steps it may not open. A step the roadmap does not
  // hold yet is read by a draft's sides alone.
  public var loops: Loops? {
    let index = graph.tree.index
    guard only != nil || (links != nil && drafted != nil) else { return nil }
    let own = drafted.flatMap { index.vertices[$0] }
    let reached = { (sides: [String]?, onward: [[Int]]) -> [String] in
      var passed = Set(own.map { [$0] } ?? [])
      var pending = sides.map { $0.compactMap(index.slot(of:)) } ?? own.map { onward[$0] } ?? []
      while let vertex = pending.popLast() {
        guard passed.insert(vertex).inserted else { continue }
        pending.append(contentsOf: onward[vertex])
      }
      return passed.filter { $0 < index.ids.count }.sorted().map { index.ids[$0] }
    }
    return Loops(requires: reached(links?.opens, index.children), opens: reached(links?.requires, index.parents))
  }
}

// A step the device linked that is now read through an absent step: its own links that bridge the absence, and what it follows through them.
public struct LandingFact: Sendable {
  public let node: String
  public let incoming: [RoadmapTree.Edge]
  public let followed: [Followed]
}

extension FollowGraph {
  // `own` are the device's own links. One from a present step is direct and says nothing; an absent root or cycle can leave `followed` empty.
  public func landingFacts(own: [RoadmapTree.Edge]) -> [LandingFact] {
    var linked = ByText<Set<[UInt8]>>()
    for edge in own { linked[edge.to, default: []].insert(Array(edge.from.utf8)) }
    return ids.compactMap { node -> LandingFact? in
      guard let from = linked[node] else { return nil }
      let sources = Set(tree.index.absentParents(node).map { Array($0.utf8) }).intersection(from)
      guard !sources.isEmpty else { return nil }
      let incoming = sources.sorted { $0.lexicographicallyPrecedes($1) }.map {
        RoadmapTree.Edge(from: String(decoding: $0, as: UTF8.self), to: node, present: true)
      }
      let bridged = followed(node).compactMap { entry -> Followed? in
        let through = entry.incoming.filter { sources.contains(Array($0.from.utf8)) }
        return through.isEmpty ? nil : Followed(id: entry.id, incoming: through, throughAbsent: entry.throughAbsent)
      }
      return LandingFact(node: node, incoming: incoming, followed: bridged)
    }
  }
}
