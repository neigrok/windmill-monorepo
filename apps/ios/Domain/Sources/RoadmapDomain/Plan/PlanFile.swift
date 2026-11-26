// §7.3 A roadmap written as the plan grammar's file, of its second edition, which reads back to the same steps, links,
// kinds and marks (packages/api-contract/roadmap/plan/README.md, Writing). Each step stands under the first step it
// follows, the rest named in a line of its description, and a loop is written after them, broken at one step of it, which
// is written as a first step. A kind's description and a link's label are not written.
public struct PlanFile: Sendable, Equatable {
  public struct Step: Sendable {
    public let id: String
    public let label: String
    public let color: String
    public let prerequisites: [String]
    public let description: String
    // Its links' addresses.
    public let links: [String]

    public init(id: String, label: String, color: String, prerequisites: [String], description: String = "", links: [String] = []) {
      self.id = id
      self.label = label
      self.color = color
      self.prerequisites = prerequisites
      self.description = description
      self.links = links
    }
  }

  public let text: String

  // The steps in the order to write them; `done` the ids of the steps to mark; the last of `kinds` wearing a hue names it.
  public init(title: String, guide: String = "", kinds: [RoadmapPlan.Kind], steps: [Step], done: Set<String>) {
    var lines = ["# \(Self.name(title))", "<!-- windmill:roadmap \(RoadmapPlan.edition) -->"]
    if guide.unicodeScalars.contains(where: { !PlanText.isWhitespace($0) }) {
      lines.append(RoadmapPlan.guideOpen)
      lines += PlanText.lines(of: guide).map { $0.isEmpty ? ">" : "> \(PlanText.string($0))" }
      lines.append(RoadmapPlan.guideClose)
    }
    let byId = Dictionary(steps.map { (PlanText.key($0.id), $0) }) { _, last in last }
    var kindOf: [[UInt8]: String] = [:]
    for kind in kinds { kindOf[PlanText.key(kind.hue)] = kind.label }
    var children: [[UInt8]: [Step]] = [:]
    for step in steps {
      guard let parent = step.prerequisites.first, byId[PlanText.key(parent)] != nil else { continue }
      children[PlanText.key(parent), default: []].append(step)
    }
    let marked = Set(done.map(PlanText.key))
    var written: Set<[UInt8]> = []
    var hue: String?

    func write(_ step: Step, depth: Int, under: String?) {
      written.insert(PlanText.key(step.id))
      let label = kindOf[PlanText.key(step.color)].map { $0.isEmpty ? "" : " \(Self.name($0, kind: true))" } ?? ""
      let marker = step.color == hue ? "" : " <!-- windmill:kind \(step.color)\(label) -->"
      hue = step.color
      let indent = String(repeating: "  ", count: depth)
      let box = marked.contains(PlanText.key(step.id)) ? "[x] " : ""
      lines.append("\(indent)- \(box)\(Self.name(step.label))\(marker)")
      let notes = indent + "  "
      if !step.description.isEmpty {
        for line in step.description.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false) {
          lines.append(notes + Self.quoted(PlanText.string(line)))
        }
      }
      let also = step.prerequisites.enumerated().filter { $0.offset > 0 || under.map { PlanText.key($0) } != PlanText.key($0.element) }
      if !also.isEmpty {
        lines.append(notes + Self.quoted("needs also: " + also.map { byId[PlanText.key($0.element)]?.label ?? $0.element }.joined(separator: ", ")))
      }
      for url in step.links where !url.isEmpty { lines.append(notes + Self.bracketed(url)) }
      for child in children[PlanText.key(step.id)] ?? [] where !written.contains(PlanText.key(child.id)) {
        write(child, depth: depth + 1, under: step.id)
      }
    }

    for step in steps where step.prerequisites.first.map({ byId[PlanText.key($0)] == nil }) ?? true { write(step, depth: 0, under: nil) }
    // A step no first step reaches stands on a loop or under one: up its first prerequisites the loop is met, and it is
    // broken at the first step of it met, which is written as a first step, the rest of the loop and the steps under it
    // under that step.
    for step in steps where !written.contains(PlanText.key(step.id)) {
      var met: Set<[UInt8]> = []
      var onLoop = step
      while met.insert(PlanText.key(onLoop.id)).inserted, let next = onLoop.prerequisites.first.flatMap({ byId[PlanText.key($0)] }) { onLoop = next }
      write(onLoop, depth: 0, under: nil)
    }
    text = lines.joined(separator: "\n")
  }

  // §7.3 One roadmap of the device's copy, written as the room shows it, as the web writes the roadmap its room reads
  // (`ReplicaRoadmap.seedOf`): its title, a subtree's being its owning step's label; its guide; the kinds that own their hue,
  // in the legend's order; and its present steps in authored order, each following what the domain reads it follows
  // through absent steps (D-5), with its description and its links' addresses, and marked where the room shows it done. A
  // step that owns a subtree or opens a roadmap is written as a step, and the roadmap it leads to is not. Nil for a
  // roadmap that does not stand or is not read.
  public init?(_ id: String, in account: RoadmapAccount) {
    guard let graph = account.graph(id) else { return nil }
    let tree = graph.tree
    let states = graph.states
    self.init(title: account.location(of: id).title ?? "", guide: tree.meta?.guide ?? "",
              kinds: LegendRead(tree).shown.compactMap(\.kind).map { RoadmapPlan.Kind(id: $0.id, hue: $0.hue, label: $0.label, description: $0.description) },
              steps: tree.index.nodes.map { step in
                Step(id: step.id, label: step.label, color: step.color, prerequisites: graph.followed(step.id).map(\.id),
                     description: step.description, links: step.links.map(\.url))
              },
              done: Set(tree.index.nodes.map(\.id).filter { states[$0] == .complete }))
  }

  // A name, or a kind's label, as the read takes it back whole: `&`, `<`, `>`, its line breaks and the two separators as
  // entities, `[` where it would begin a checkbox, whitespace at either end, and in a kind's label `-`.
  static func name(_ text: String, kind: Bool = false) -> String {
    let scalars = Array(text.unicodeScalars)
    let start = scalars.firstIndex { !PlanText.isWhitespace($0) } ?? scalars.count
    let end = (scalars.lastIndex { !PlanText.isWhitespace($0) }).map { $0 + 1 } ?? start
    let inside: Set<Unicode.Scalar> = kind ? ["&", "<", ">", "\r", "\n", "\u{2028}", "\u{2029}", "-"] : ["&", "<", ">", "\r", "\n", "\u{2028}", "\u{2029}"]
    return scalars.enumerated().map { (at: Int, scalar: Unicode.Scalar) -> String in
      if at < start || at >= end || inside.contains(scalar) || (at == start && scalar == "[") { return PlanText.entity(scalar) }
      return String(scalar)
    }.joined()
  }

  // A line of a description as a quote: `&` and line breaks as entities.
  static func quoted(_ line: String) -> String {
    let escaped = line.unicodeScalars.map { ["&", "\r", "\n"].contains($0) ? PlanText.entity($0) : String($0) }.joined()
    return escaped.isEmpty ? ">" : "> \(escaped)"
  }

  // An address between angle brackets: `&`, the brackets and whitespace as entities.
  static func bracketed(_ url: String) -> String {
    "<" + url.unicodeScalars.map { ["&", "<", ">"].contains($0) || PlanText.isWhitespace($0) ? PlanText.entity($0) : String($0) }.joined() + ">"
  }
}
