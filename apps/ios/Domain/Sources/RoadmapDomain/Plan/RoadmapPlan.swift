// §7.1 A plan: a text read by the web's plan grammar into steps, their kinds and what the read did, the same on every
// surface (packages/api-contract/roadmap/plan/README.md, Reading). Reading cannot fail: a line the grammar cannot place is
// a note on a step, and every value it derives stays inside the domain's bounds.
public struct RoadmapPlan: Sendable, Equatable {
  public enum Source: String, Sendable {
    case existing, relabeled, added
  }

  // A kind of the legend the plan is read over, and of the legend it gives.
  public struct Kind: Sendable, Equatable {
    public let id: String
    public var hue: String
    public var label: String
    public var description: String
    public var source: Source

    public init(id: String, hue: String, label: String, description: String, source: Source = .existing) {
      self.id = id
      self.hue = hue
      self.label = label
      self.description = description
      self.source = source
    }
  }

  public struct Node: Sendable, Equatable {
    public let id: String
    public let label: String
    public let color: String
    // The node it follows, none for a node that follows nothing.
    public let follows: String?
    public let done: Bool
    // Its notes, nil where it has none.
    public let description: String?
    public let links: [String]
  }

  // What the read took on a line.
  public enum Liberty: Sendable, Equatable {
    public enum Indent: String, Sendable {
      case ragged, jump
    }

    case clamp(Indent)
    case note
    case clip
    case rename(String)
  }

  // A line of the gutter: what the line made, the node it made or belongs to, and what was taken on it.
  public struct Line: Sendable, Equatable {
    public enum Mark: String, Sendable {
      case root, branch, step, done, note
    }

    public let mark: Mark?
    public let node: String?
    public let liberties: [Liberty]
  }

  public struct Readout: Sendable, Equatable {
    public let steps: Int
    public let branches: Int
    public let done: Int
  }

  public struct Imperfections: Sendable, Equatable {
    public let notes: Int
    public let clamps: Int
    public let renames: Int
    public let clips: Int
  }

  public let title: String
  public let missingRoot: Bool
  // A file the grammar wrote, where no node stands for the plan's name.
  public let isFile: Bool
  public let nodes: [Node]
  public let kinds: [Kind]
  public let gutter: [Line]
  public let readout: Readout
  public let imperfections: Imperfections

  // A text read for a new roadmap over the legend it starts from, or, `into` a roadmap, over the roadmap's own legend,
  // whose kinds a heading binds or adds to and never renames.
  public init(reading text: String, over legend: [Kind], into: Bool = false) {
    var lines = Self.scan(String(String.UnicodeScalarView(text.unicodeScalars.filter { $0.value != 0 })))
    var title = ""
    var root: Int?
    if let first = lines.firstIndex(where: { $0.shape != .blank }), lines[first].shape == .heading(1) || lines[first].shape == .text {
      root = first
      title = PlanText.clipped(lines[first].content, to: PlanText.titleBound)
    }
    var edition = 0
    if let root, let marker = lines.indices.first(where: { $0 > root && lines[$0].shape != .blank }) {
      edition = Self.markers[PlanText.key(lines[marker].content)] ?? 0
      if edition > 0 {
        lines[marker].shape = .blank
        if lines[root].shape == .text && lines[root].content == "#" { title = "" }
        else if edition >= 2 { title = PlanText.clipped(PlanText.readingEntities(lines[root].content), to: PlanText.titleBound) }
        let opening = lines.indices.first { $0 > marker && lines[$0].shape != .blank }
        if let opening, lines[opening].content == Self.guideOpen,
           let closing = lines.indices.first(where: { $0 > opening && lines[$0].content == Self.guideClose }) {
          for at in opening...closing { lines[at].shape = .blank }
        }
      }
    }
    var growth = Growth(legend: legend, into: into, edition: edition, root: root, title: title, count: lines.count)
    growth.grow(lines)
    let assembled = growth.assembled()
    self.title = title
    missingRoot = root == nil
    isFile = edition > 0
    nodes = assembled.nodes
    kinds = growth.book.kinds
    gutter = assembled.gutter
    let liberties = gutter.flatMap(\.liberties)
    imperfections = Imperfections(notes: liberties.count { $0 == .note }, clamps: liberties.count { if case .clamp = $0 { true } else { false } },
                                  renames: liberties.count { if case .rename = $0 { true } else { false } }, clips: liberties.count { $0 == .clip })
    readout = Readout(steps: nodes.count, branches: growth.drafts.count { $0.role == .branch }, done: nodes.count(where: \.done))
  }

  static let markers: [[UInt8]: Int] = [PlanText.key("<!-- windmill:roadmap -->"): 1, PlanText.key("<!-- windmill:roadmap 2 -->"): 2]
  static let edition = 2
  static let guideOpen = "<!-- windmill:guide -->"
  static let guideClose = "<!-- /windmill:guide -->"
  static let kindMarker = "<!-- windmill:kind "
}

// A line of the text: its indent's columns, what its body is, its content, and its level on the text's indent grid.
struct ScannedLine {
  enum Shape: Equatable {
    case blank
    case heading(Int)
    case item(numbered: Bool, done: Bool)
    case text
  }

  var shape: Shape
  // A heading's text, an item's name, a text line trimmed; empty for a blank line.
  var content: String
  // What follows the indent, as it stands.
  let body: [Unicode.Scalar]
  let columns: Int
  var level = 0
  var ragged = false
}

extension RoadmapPlan {
  // The text's lines, each as its body fits a blank, a heading, an item or a text line, on the grid the first indented
  // item or text line sets.
  static func scan(_ text: String) -> [ScannedLine] {
    var unit = 0
    var lines = PlanText.lines(of: text).map { (raw: [Unicode.Scalar]) -> ScannedLine in
      let indent = raw.prefix { $0 == " " || $0 == "\t" }
      let columns = indent.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) }
      let body = Array(raw.dropFirst(indent.count))
      let trimmed = PlanText.trimmed(body)
      if trimmed.isEmpty { return ScannedLine(shape: .blank, content: "", body: body, columns: columns) }
      if let heading = heading(body) { return ScannedLine(shape: .heading(heading.depth), content: heading.content, body: body, columns: columns) }
      if unit == 0 && columns > 0 { unit = columns }
      guard let item = item(body) else { return ScannedLine(shape: .text, content: PlanText.string(trimmed), body: body, columns: columns) }
      return ScannedLine(shape: .item(numbered: item.numbered, done: item.done), content: item.name, body: body, columns: columns)
    }
    let step = unit == 0 ? 2 : unit
    for index in lines.indices {
      lines[index].level = lines[index].columns / step
      lines[index].ragged = lines[index].columns % step != 0
    }
    return lines
  }

  // One to six `#`, whitespace, and a content that, trimmed, is not empty and holds neither separator.
  static func heading(_ body: [Unicode.Scalar]) -> (depth: Int, content: String)? {
    let depth = body.prefix { $0 == "#" }.count
    guard (1...6).contains(depth), depth < body.count, PlanText.isWhitespace(body[depth]) else { return nil }
    let content = PlanText.trimmed(Array(body[depth...]))
    guard !content.isEmpty, !content.contains(where: { PlanText.separators.contains($0.value) }) else { return nil }
    return (depth, PlanText.string(content))
  }

  // A marker, whitespace as far as it runs, and a rest that holds neither separator; a box at the rest's start is taken off.
  static func item(_ body: [Unicode.Scalar]) -> (numbered: Bool, done: Bool, name: String)? {
    let digits = body.prefix { ("0"..."9").contains($0) }.count
    let marker: Int
    if digits > 0 {
      guard digits < body.count, body[digits] == "." || body[digits] == ")" else { return nil }
      marker = digits + 1
    } else {
      guard let first = body.first, first == "-" || first == "*" || first == "\u{2022}" else { return nil }
      marker = 1
    }
    let spaces = body.dropFirst(marker).prefix { PlanText.isWhitespace($0) }.count
    guard spaces > 0 else { return nil }
    let rest = Array(body.dropFirst(marker + spaces))
    guard !rest.contains(where: { PlanText.separators.contains($0.value) }) else { return nil }
    if rest.count >= 3, rest[0] == "[", rest[1] == " " || rest[1] == "x" || rest[1] == "X", rest[2] == "]" {
      return (digits > 0, rest[1] != " ", PlanText.string(PlanText.trimmed(Array(rest.dropFirst(3)))))
    }
    return (digits > 0, false, PlanText.string(PlanText.trimmed(rest)))
  }

  // The kind marker that ends a file's item: the first `<!-- windmill:kind HUE` that begins the name or follows a space and
  // runs to the end as ` -->`, or as a space, a label and ` -->`. The name before it, the hue and the label, none where
  // the marker names none.
  static func itemKind(_ name: String) -> (name: String, hue: String, label: String?)? {
    let scalars = Array(name.unicodeScalars)
    let marker = Array(kindMarker.unicodeScalars)
    for start in scalars.indices where (start == 0 || scalars[start - 1] == " ") && scalars[start...].starts(with: marker) {
      let after = scalars[(start + marker.count)...]
      for hue in PlanText.hues where after.starts(with: hue.unicodeScalars) {
        let rest = Array(after.dropFirst(hue.unicodeScalars.count))
        let before = start == 0 ? "" : PlanText.string(scalars[..<(start - 1)])
        if PlanText.string(rest) == " -->" { return (before, hue, nil) }
        if rest.count >= 5, rest.first == " ", rest.suffix(4).elementsEqual(" -->".unicodeScalars) {
          let label = PlanText.string(rest.dropFirst().dropLast(4))
          return (before, hue, label.isEmpty ? nil : label)
        }
      }
    }
    return nil
  }

  // The kind marker that ends a file's heading: `<!-- windmill:kind HUE -->`, alone or after a label and one space.
  static func headingKind(_ content: String) -> (label: String?, hue: String)? {
    for hue in PlanText.hues {
      let marker = "\(kindMarker)\(hue) -->"
      guard content.unicodeScalars.count >= marker.unicodeScalars.count,
            content.unicodeScalars.suffix(marker.unicodeScalars.count).elementsEqual(marker.unicodeScalars) else { continue }
      let before = Array(content.unicodeScalars.dropLast(marker.unicodeScalars.count))
      if before.isEmpty { return (nil, hue) }
      guard before.last == " " else { return nil }
      return (PlanText.string(before.dropLast()), hue)
    }
    return nil
  }
}

// The plan's legend as the read claims its kinds: a heading binds the kind of its label, or takes over an unclaimed
// kind, or adds one in a free hue, or goes round the kinds.
struct KindBook {
  var kinds: [RoadmapPlan.Kind]
  var claimed: Set<[UInt8]> = []
  var overflow = 0
  // Into a roadmap: no kind of it is renamed.
  let into: Bool

  init(_ legend: [RoadmapPlan.Kind], into: Bool) {
    kinds = legend.map { RoadmapPlan.Kind(id: $0.id, hue: $0.hue, label: $0.label, description: $0.description) }
    self.into = into
  }

  var firstHue: String { kinds.first?.hue ?? PlanText.hues[0] }

  // The hue `label` claims, as it stands: a heading's is trimmed already, and a file's marker keeps its padding.
  mutating func claim(_ label: String, hue: String? = nil) -> String {
    let wanted = PlanText.key(PlanText.lowercased(PlanText.trimmed(label)))
    if let bound = kinds.firstIndex(where: { kind in
      !kind.label.isEmpty && PlanText.key(PlanText.lowercased(PlanText.trimmed(kind.label))) == wanted && (hue.map { kind.hue == $0 } ?? true)
    }) {
      claimed.insert(PlanText.key(kinds[bound].id))
      return kinds[bound].hue
    }
    if let hue, into, kinds.contains(where: { $0.hue == hue }) { return claim(label) }
    if !into, let starter = hue.map({ hue in kinds.firstIndex { $0.hue == hue } })
                          ?? kinds.firstIndex(where: { $0.source == .existing && !claimed.contains(PlanText.key($0.id)) }) {
      kinds[starter].label = PlanText.clipped(label, to: PlanText.kindLabelBound)
      kinds[starter].description = ""
      kinds[starter].source = .relabeled
      claimed.insert(PlanText.key(kinds[starter].id))
      return kinds[starter].hue
    }
    if let free = hue ?? PlanText.hues.first(where: { hue in !kinds.contains { $0.hue == hue } }) {
      let minted = RoadmapPlan.Kind(id: mintedId(label), hue: free, label: PlanText.clipped(label, to: PlanText.kindLabelBound), description: "", source: .added)
      kinds.append(minted)
      claimed.insert(PlanText.key(minted.id))
      return free
    }
    let reused = kinds[overflow % kinds.count]
    overflow += 1
    return reused.hue
  }

  func mintedId(_ label: String) -> String {
    let base = PlanText.idForm(label).isEmpty ? "kind" : PlanText.idForm(label)
    let held = Set(kinds.map { PlanText.key($0.id) })
    guard held.contains(PlanText.key(base)) else { return base }
    var n = 2
    while held.contains(PlanText.key("\(base)-\(n)")) { n += 1 }
    return "\(base)-\(n)"
  }
}

// The nodes a read grows line by line, each by its index, and the gutter's raw marks.
struct Growth {
  enum Role {
    case root, branch, step
  }

  struct Draft {
    let role: Role
    let label: String
    let hue: String
    // The index of the node it follows, nil for none.
    let parent: Int?
    let done: Bool
    var notes: [(text: String, line: Int)] = []
    var links: [String] = []
    let line: Int?
  }

  struct Mark {
    let node: Int
    let mark: RoadmapPlan.Line.Mark
    var liberties: [RoadmapPlan.Liberty]
  }

  struct Open {
    let level: Int
    let index: Int
    let numbered: Bool
    let anchor: Int?
  }

  var book: KindBook
  let edition: Int
  let root: Int?
  var drafts: [Draft] = []
  var marks: [Mark?]
  // A file's text before its first step, which that step takes.
  var loose: [(line: ScannedLine, at: Int)] = []
  var branch: Int?
  var hue: String
  var open: [Open] = []

  init(legend: [RoadmapPlan.Kind], into: Bool, edition: Int, root: Int?, title: String, count: Int) {
    book = KindBook(legend, into: into)
    self.edition = edition
    self.root = root
    marks = Array(repeating: nil, count: count)
    hue = book.firstHue
    guard edition == 0 else { return }
    drafts = [Draft(role: .root, label: title, hue: book.firstHue, parent: nil, done: false, line: root)]
    branch = 0
    if let root { marks[root] = Mark(node: 0, mark: .root, liberties: []) }
  }

  var isFile: Bool { edition > 0 }

  mutating func grow(_ lines: [ScannedLine]) {
    for (at, line) in lines.enumerated() where at != root && line.shape != .blank {
      switch line.shape {
      case .heading: heading(line, at: at)
      case .item(let numbered, let done): item(line, at: at, numbered: numbered, done: done)
      case .text, .blank:
        if drafts.isEmpty { loose.append((line, at)) } else { take(line, at: at, on: drafts.count - 1) }
      }
    }
    guard !loose.isEmpty else { return }
    drafts.append(Draft(role: .step, label: "", hue: hue, parent: nil, done: false, line: nil))
    for held in loose { take(held.line, at: held.at, on: 0) }
  }

  // A file's heading only claims a kind; any other heading also opens a branch under the first node.
  mutating func heading(_ line: ScannedLine, at: Int) {
    if isFile, let marked = RoadmapPlan.headingKind(line.content) {
      hue = marked.label.map { book.claim(PlanText.trimmed($0), hue: marked.hue) } ?? marked.hue
    } else {
      hue = book.claim(line.content)
    }
    guard !isFile else { return }
    let label = PlanText.clipped(line.content, to: PlanText.labelBound)
    drafts.append(Draft(role: .branch, label: label, hue: hue, parent: 0, done: false, line: at))
    branch = drafts.count - 1
    open = []
    marks[at] = Mark(node: drafts.count - 1, mark: .branch, liberties: PlanText.count(line.content) > PlanText.labelBound ? [.clip] : [])
  }

  // Depth is dependency, numbers chain, bullets fan, a box arrives done; a level past the last open step's next is
  // brought down to it.
  mutating func item(_ line: ScannedLine, at: Int, numbered: Bool, done: Bool) {
    var name = line.content
    if isFile, let marked = RoadmapPlan.itemKind(name) {
      name = marked.name
      hue = marked.label.map { book.claim(PlanText.readingEntities($0), hue: marked.hue) } ?? marked.hue
    }
    if isFile { name = PlanText.readingEntities(name) }
    let label = PlanText.clipped(name, to: PlanText.labelBound)
    var liberties: [RoadmapPlan.Liberty] = []
    if line.ragged { liberties.append(.clamp(.ragged)) }
    let ceiling = (open.last?.level ?? -1) + 1
    let level = min(line.level, ceiling)
    if line.level > ceiling { liberties.append(.clamp(.jump)) }
    if PlanText.count(name) > PlanText.labelBound { liberties.append(.clip) }
    var sibling: Open?
    while let last = open.last, last.level >= level {
      open.removeLast()
      if last.level == level { sibling = last }
    }
    let anchor = open.last?.index ?? branch
    let chains = numbered && (sibling.map { $0.numbered && $0.anchor == anchor } ?? false)
    drafts.append(Draft(role: .step, label: label, hue: hue, parent: chains ? sibling?.index : anchor, done: done, line: at))
    open.append(Open(level: level, index: drafts.count - 1, numbered: numbered, anchor: anchor))
    marks[at] = Mark(node: drafts.count - 1, mark: done ? .done : .step, liberties: liberties)
    for held in loose { take(held.line, at: held.at, on: drafts.count - 1) }
    loose = []
  }

  // A text line under a node: one of its links where it is an address that fits them, which takes no liberty, otherwise
  // one of its notes.
  mutating func take(_ line: ScannedLine, at: Int, on node: Int) {
    let read = Self.note(line, edition: edition)
    if let link = read.link, drafts[node].links.count < PlanText.linksBound, PlanText.count(link) <= PlanText.linkBound {
      drafts[node].links.append(link)
      marks[at] = Mark(node: node, mark: .note, liberties: [])
      return
    }
    drafts[node].notes.append((read.note ?? read.link ?? "", at))
    marks[at] = Mark(node: node, mark: .note, liberties: [.note])
  }

  // What a text line gives: a note, or an address. A file of the second edition quotes a note and brackets a link.
  static func note(_ line: ScannedLine, edition: Int) -> (note: String?, link: String?) {
    if edition >= 2, line.body.first == ">" {
      let quoted = line.body.dropFirst()
      return (PlanText.readingEntities(PlanText.string(quoted.first == " " ? quoted.dropFirst() : quoted)), nil)
    }
    let content = Array(line.content.unicodeScalars)
    if edition >= 2, content.count > 2, content.first == "<", content.last == ">",
       !content.dropFirst().dropLast().contains(where: { PlanText.isWhitespace($0) || $0 == "<" || $0 == ">" }) {
      return (nil, PlanText.readingEntities(PlanText.string(content.dropFirst().dropLast())))
    }
    for scheme in ["http://", "https://"] where content.starts(with: scheme.unicodeScalars) {
      let address = content.dropFirst(scheme.unicodeScalars.count)
      if !address.isEmpty && !address.contains(where: PlanText.isWhitespace) { return (nil, line.content) }
    }
    return (line.content, nil)
  }

  // The plan's nodes: duplicate names renamed where the text is not a file, ids made from names, each node's description
  // within its bound and each note line it does not keep whole said; and the gutter.
  mutating func assembled() -> (nodes: [RoadmapPlan.Node], gutter: [RoadmapPlan.Line]) {
    var labels = Taken(form: Self.renamed)
    var ids = Taken { base, n in "\(base)-\(n)" }
    var named: [(id: String, label: String)] = []
    for (index, draft) in drafts.enumerated() {
      var label = draft.label
      if !isFile && !label.isEmpty && labels.has(label) {
        label = labels.free(label)
        if let line = draft.line { marks[line]?.liberties.append(.rename(label)) }
      }
      if !label.isEmpty { labels.add(label) }
      let base = PlanText.idForm(label).isEmpty ? (index == 0 ? "root" : "step") : PlanText.idForm(label)
      let id = ids.has(base) ? ids.free(base) : base
      ids.add(id)
      named.append((id, label))
    }
    let nodes = drafts.enumerated().map { (index: Int, draft: Draft) -> RoadmapPlan.Node in
      var description: String?
      if !draft.notes.isEmpty {
        description = PlanText.clipped(draft.notes.map(\.text).joined(separator: "\n"), to: PlanText.descriptionBound)
        var end = -1
        for note in draft.notes {
          end += 1 + PlanText.count(note.text)
          if end > PlanText.descriptionBound { marks[note.line]?.liberties.append(.clip) }
        }
      }
      return RoadmapPlan.Node(id: named[index].id, label: named[index].label, color: draft.hue, follows: draft.parent.map { named[$0].id },
                       done: draft.done, description: description, links: draft.links)
    }
    let gutter = marks.map { (mark: Mark?) -> RoadmapPlan.Line in
      guard let mark else { return RoadmapPlan.Line(mark: nil, node: nil, liberties: []) }
      return RoadmapPlan.Line(mark: mark.mark, node: nodes[mark.node].id, liberties: mark.liberties)
    }
    return (nodes, gutter)
  }

  // A label renamed `label (n)`, keeping as much of it as leaves the count room within its bound.
  static func renamed(_ label: String, _ n: Int) -> String {
    let suffix = " (\(n))"
    return PlanText.clipped(label, to: PlanText.labelBound - suffix.unicodeScalars.count) + suffix
  }
}

// Names taken so far, compared by scalar value, and for each name the count its next free form starts from: a form once
// taken stays taken, so the count only climbs, and a thousand alike take a thousand steps rather than half a million.
struct Taken {
  // A name's form counted `n`.
  let form: (String, Int) -> String
  var names: Set<[UInt8]> = []
  var next: [[UInt8]: Int] = [:]

  init(form: @escaping (String, Int) -> String) {
    self.form = form
  }

  func has(_ name: String) -> Bool { names.contains(PlanText.key(name)) }

  mutating func add(_ name: String) { names.insert(PlanText.key(name)) }

  // The first form of `name`, counted from 2, that is not taken.
  mutating func free(_ name: String) -> String {
    var n = next[PlanText.key(name)] ?? 2
    while has(form(name, n)) { n += 1 }
    next[PlanText.key(name)] = n + 1
    return form(name, n)
  }
}
