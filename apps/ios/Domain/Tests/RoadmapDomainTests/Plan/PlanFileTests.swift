import DomainKitTesting
import RoadmapDomain
import SyncCore
import Testing

// Roadmaps the domain accepts, drawn from text that looks like every line the grammar reads, as the web's grammar test
// draws them: each is written and read back to the same steps in the order the file writes them, with the same kinds,
// marks, descriptions and addresses.
struct PlanFileTests {
  // The web test's generator, mulberry32.
  struct Draw {
    var seed: UInt32

    mutating func next() -> Double {
      seed = seed &+ 0x6D2B_79F5
      var t = (seed ^ (seed >> 15)) &* (1 | seed)
      t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
      return Double(t ^ (t >> 14)) / 4_294_967_296
    }

    mutating func pick<T>(_ items: [T]) -> T { items[Int(next() * Double(items.count))] }
    mutating func below(_ bound: Int) -> Int { Int(next() * Double(bound)) }
  }

  static let pieces = ["a", "Sail", " ", "  ", "\t", "\u{A0}", "\u{3000}", "\u{FEFF}", "\u{2028}", "\u{2029}", "\r", "\n", "\r\n", "&", "&#38;", "&#10;",
                       "<", ">", "-->", "<!-- windmill:kind sky -->", " <!-- windmill:kind gold Sea -->", "[x] ", "[ ]", "[", "- ", "* ", "1. ",
                       "## ", "# ", "> ", "<a>", "https://example.com/x", "needs also: A", "\u{1F600}", "e\u{301}", "z", "#", "\u{2022}"]

  @Test func everyRoadmapTheDomainAcceptsReadsBackFromItsFile() {
    var draw = Draw(seed: 0x5EED)
    func text(_ most: Int) -> String { (0..<draw.below(most)).map { _ in draw.pick(Self.pieces) }.joined() }
    func clipped(_ text: String, _ bound: Int) -> String { String(String.UnicodeScalarView(text.unicodeScalars.prefix(bound))) }
    let hues = ["terracotta", "olive", "gold", "brick", "sky", "plum"]
    for _ in 0..<300 {
      let kinds = hues.filter { _ in draw.next() < 0.5 }.enumerated().map { index, hue in
        RoadmapPlan.Kind(id: "k\(index)", hue: hue, label: clipped(text(6), 24), description: "")
      }
      var steps = (0..<(1 + draw.below(8))).map { index in
        PlanFile.Step(id: "s\(index)", label: clipped(text(8), 200), color: draw.pick(hues), prerequisites: [],
                      description: draw.next() < 0.5 ? text(10) : "",
                      links: (0..<draw.below(3)).map { _ in draw.pick(["https://", "mailto:", "www.", ""]) + (text(4).trimmed ?? "x") })
      }
      for index in steps.indices.dropFirst() where draw.next() < 0.7 {
        let step = steps[index]
        steps[index] = PlanFile.Step(id: step.id, label: step.label, color: step.color, prerequisites: ["s\(draw.below(index))"],
                                     description: step.description, links: step.links)
      }
      let done = Set(steps.filter { _ in draw.next() < 0.3 }.map(\.id))
      let title = clipped(text(6), 200)
      let file = PlanFile(title: title, kinds: kinds, steps: steps, done: done)
      let read = RoadmapPlan(reading: file.text, over: [])

      var written: [PlanFile.Step] = []
      func walk(_ step: PlanFile.Step) {
        written.append(step)
        for child in steps where child.prerequisites.first == step.id { walk(child) }
      }
      for step in steps where step.prerequisites.isEmpty { walk(step) }
      let named = { (hue: String) in kinds.last { $0.hue == hue }?.label ?? "" }
      let readBack = read.nodes.map { node in
        Shown(label: Array(node.label.unicodeScalars), color: node.color, done: node.done, description: node.description.map { Array($0.unicodeScalars) },
              links: node.links.map { Array($0.unicodeScalars) }, under: read.nodes.firstIndex { $0.id == node.follows })
      }
      let wrote = written.map { step in
        Shown(label: Array(step.label.unicodeScalars), color: step.color, done: done.contains(step.id),
              description: step.description.isEmpty ? nil : Array(step.description.unicodeScalars),
              links: step.links.map { Array($0.unicodeScalars) }, under: written.firstIndex { $0.id == step.prerequisites.first })
      }
      var worn: [String] = []
      for step in written where !worn.contains(step.color) { worn.append(step.color) }
      #expect(Array(read.title.unicodeScalars) == Array(title.unicodeScalars), "\(file.text)")
      #expect(readBack == wrote, "\(file.text)")
      #expect(read.kinds.map { [$0.hue, $0.label].map { Array($0.unicodeScalars) } }
              == worn.filter { !named($0).isEmpty }.map { [$0, named($0)].map { Array($0.unicodeScalars) } }, "\(file.text)")
    }
  }

  // §7.3 A roadmap of the device's copy, written as the room shows it, is the text of the shared case that names it, whose
  // writing and read-back the web's grammar runs too: its
  // title, guide and the kinds owning their hues; *Night passage*, which owns a subtree, and *Become a skipper*, whose
  // pointer opens a roadmap that is complete, are steps; *Leave the dock*, deleted, is left out, and *Sail solo*, which
  // followed it, follows what it followed; *Night passage*'s own mark is set aside while its subtree is not done.
  @Test func aRoadmapOfTheDevicesCopyIsWrittenAsTheRoomShowsIt() throws {
    let born = "1000:0:r_aaaaaaaaaaaa"
    let trees: [JSON] = [
      ["id": "t_0000000000000001", "own": true, "meta": ["title": "Learn to sail", "guide": "Sundays with Maya.\nBring the tide table."],
       "kinds": [["id": "sea", "hue": "sky", "label": "Sea", "description": "Open water.", "ord": "a0", "born": .string(born)],
                 ["id": "goal", "hue": "gold", "label": "Milestone", "description": "Moments that matter", "ord": "a1", "born": .string(born)]],
       "nodes": [["id": "course", "label": "Choose a course", "color": "sky", "ord": "a0", "description": "Start nearby.",
                  "links": [["url": "https://example.com/course", "label": "The school"]]],
                 ["id": "night", "label": "Night passage", "color": "sky", "ord": "a1", "branch": "t_0000000000000002"],
                 ["id": "gone", "label": "Leave the dock", "color": "sky", "ord": "a2", "present": false],
                 ["id": "solo", "label": "Sail solo", "color": "gold", "ord": "a3"],
                 ["id": "skipper", "label": "Become a skipper", "color": "terracotta", "ord": "a4"]],
       "edges": [["from": "course", "to": "night", "present": true], ["from": "course", "to": "gone", "present": true],
                 ["from": "gone", "to": "solo", "present": true], ["from": "night", "to": "skipper", "present": true]],
       "marks": [["node": "course", "status": "complete", "outOfOrder": false], ["node": "night", "status": "complete", "outOfOrder": false]],
       "pointers": [["node": "skipper", "present": true, "opens": "t_0000000000000003"]]],
      ["id": "t_0000000000000002", "own": true, "parent": ["tree": "t_0000000000000001", "step": "night"],
       "meta": ["title": "Night passage", "root": "t_0000000000000001", "depth": 1],
       "nodes": [["id": "lights", "label": "Fit the navigation lights", "ord": "a0"]]],
      ["id": "t_0000000000000003", "own": true, "meta": ["title": "Day skipper"], "nodes": [["id": "theory", "label": "Pass the theory", "ord": "a0"]],
       "marks": [["node": "theory", "status": "complete", "outOfOrder": false]]],
    ]
    let account = RoadmapAccount(try trees.map(RoadmapTree.init(form:)))
    let named = "The iPhone's Export of its copy: a step that owns a subtree or opens a roadmap is a step, a step deleted is left out and the step after it follows what it followed, and a step is done as the iPhone's room shows it"
    let shared = try #require(try Contract.vectors("roadmap/plan/write.json").first { $0.name == named })
    let file = try #require(PlanFile("t_0000000000000001", in: account))
    #expect(JSON.string(file.text) == shared.expect["text"])
    #expect(PlanFile("t_00000000000000ff", in: account) == nil)
  }

  struct Shown: Equatable {
    let label: [Unicode.Scalar]
    let color: String
    let done: Bool
    let description: [Unicode.Scalar]?
    let links: [[Unicode.Scalar]]
    let under: Int?
  }
}

extension String {
  // The text with the kit's whitespace gone from both ends, nil where nothing else is left.
  fileprivate var trimmed: String? {
    let blank: Set<UInt32> = [0x9, 0xA, 0xB, 0xC, 0xD, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
                              0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
    let scalars = Array(unicodeScalars)
    guard let first = scalars.firstIndex(where: { !blank.contains($0.value) }), let last = scalars.lastIndex(where: { !blank.contains($0.value) }) else {
      return nil
    }
    return String(String.UnicodeScalarView(scalars[first...last]))
  }
}
