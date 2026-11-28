import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore
import Testing

// A proposal's rules beyond the corpus's cases: the ops' rows and the Shape rule held to the catalog, a name of a ref's form,
// the caps too large to hold as a case, a roadmap's steps and links and a base past its 262,144 bytes, and a large set's time.
struct ProposalsTests {
  static let tree = "t_0000000000000001"

  // A roadmap of the person's own: `a` done, `b` available, `c` waiting on both.
  static func sailing(nodes: [Step]? = nil, edges: [RoadmapTree.Edge]? = nil) -> StandingRoadmaps {
    let steps = nodes ?? [Step(id: "a", label: "Leave the dock", ord: "a0"), Step(id: "b", label: "Tie a bowline", ord: "a1"),
                          Step(id: "c", label: "Sail with an instructor", ord: "a2")]
    let links = edges ?? [RoadmapTree.Edge(from: "a", to: "c", present: true), RoadmapTree.Edge(from: "b", to: "c", present: true)]
    return StandingRoadmaps(trees: [RoadmapTree(id: tree, own: true, meta: RoadmapTree.Metadata(title: "Learn to sail", root: tree), nodes: steps,
                                                edges: links, kinds: [Kind(id: "build", hue: "terracotta", label: "Build", ord: "a0")],
                                                marks: [RoadmapTree.Mark(node: "a", status: "complete", outOfOrder: false, recordedAt: nil, deviceAt: nil)])])
  }

  // The answer's form, as the vectors' `expect` states it.
  static func proposing(_ standing: StandingRoadmaps, _ changes: [JSON], treeId: JSON = .string(tree)) -> JSON {
    var minted = ["Pq7Rk2Xw9Lm4Nb6T", "k1x9q2m7p4z8w3r5", "t6v2n8c4j1b9h7d3"]
    switch RoadmapProposals.answer(["treeId": treeId, "changes": .array(changes)], over: standing, about: tree, ids: { _ in minted.removeFirst() }) {
    case .refused(let refusal):
      var refused: JSON.Object = ["code": .string(refusal.code.rawValue)]
      refused["id"] = refusal.id.map(JSON.string)
      refused["at"] = refusal.at.map { JSON($0) }
      return ["refused": .object(refused)]
    case .minted(let proposal, let result): return ["result": result, "base": JSON(proposal.base.count)]
    }
  }

  @Test func eachOpTakesTheFieldsTheCatalogsLineOfItNamesRequiredAndOptional() throws {
    let entry = try Contract.json("roadmap/catalog.json").member("abilities").asArray().first { (try? $0.member("name").asString()) == RoadmapProposals.name }
    let description = try #require(entry).member("description").asString()
    var lines: [String: ProposalOps.Row] = [:]
    for line in description.split(separator: "\n") {
      guard let colon = line.firstIndex(of: ":"), line.contains(": required "), let semicolon = line.firstIndex(of: ";") else { continue }
      let names = { (list: Substring) -> [String] in list == "none" ? [] : list.split(separator: ", ").map(String.init) }
      let required = line[line.index(colon, offsetBy: ": required ".count)..<semicolon]
      let optional = line[line.index(semicolon, offsetBy: "; optional ".count)...].prefix { $0 != "." }
      lines[String(line[..<colon])] = ProposalOps.Row(required: names(required), optional: names(optional))
    }
    #expect(lines == ProposalOps.rows)
  }

  @Test func aChangeOutsideTheCatalogsSchemaIsRefusedByTheShapeRuleAtItsIndexAsTheGateRefusesIt() throws {
    let schema = try #require(try Catalog.roadmap.ability(named: RoadmapProposals.name)?.input.member("properties").member("changes").member("items"))
    let broken: [JSON] = [
      ["op": "rename_step", "nodeId": "b", "label": "Bowline"],
      ["op": "rename", "nodeId": 7, "label": "Bowline"],
      ["op": "add_step", "ref": "hoist", "label": "Hoist the sail"],
      ["op": "add_step", "ref": "new:Hoist", "label": "Hoist the sail"],
      ["op": "describe", "nodeId": "b", "links": [["label": "Knots"]]],
      ["op": "describe", "nodeId": "b", "links": [["url": "https://example.org", "title": "Knots"]]],
      ["op": "add_kind", "ref": "new:sport", "label": "Sport", "hue": "teal"],
      ["op": "set_progress", "nodeId": "b", "status": "done"],
      ["op": "add_step", "ref": "new:hoist", "label": "Hoist the sail", "prerequisites": ["a", 3]],
      ["op": "split", "nodeId": "b", "parts": [["ref": "new:loop"], ["ref": "new:end", "label": "Pass the end"]]],
      ["op": "split", "nodeId": "b", "parts": [["ref": "loop", "label": "Make the loop"], ["ref": "new:end", "label": "Pass the end"]]],
      ["op": "rename", "nodeId": "b", "label": "Bowline", "color": "sky"],
      ["nodeId": "b", "label": "Bowline"],
    ]
    for change in broken {
      #expect(JSONSchema(schema).fault(in: change) != nil, "\(change.jcsText)")
      var refused: JSON.Object = ["code": "invalid-input", "at": 1]
      refused["id"] = change["nodeId"].flatMap { try? $0.asString() }.map(JSON.string) ?? change["ref"].map { $0 }
      #expect(Self.proposing(Self.sailing(), [["op": "rename", "nodeId": "a", "label": "Cast off"], change]) == ["refused": .object(refused)], "\(change.jcsText)")
    }
    #expect(Self.proposing(Self.sailing(), [["op": "rename", "nodeId": "zz", "label": "Cast off"], broken[0]])
      == ["refused": ["code": "invalid-input", "id": "b", "at": 1]], "the Shape rule runs over every change before any folds")
    #expect(Self.proposing(Self.sailing(), []) == ["refused": ["code": "invalid-input"]])
    #expect(Self.proposing(Self.sailing(), [["op": "rename", "nodeId": "a", "label": "Cast off"]], treeId: "Learn to sail") == ["refused": ["code": "invalid-input"]])
  }

  @Test func aNameOfARefsFormIsARefNeverAStepsIdAndARefTheRoadmapHoldsAsAnIdIsNoNewStep() {
    let holding = Self.sailing(nodes: [Step(id: "a", ord: "a0"), Step(id: "b", ord: "a1"), Step(id: "c", ord: "a2"), Step(id: "new:tack", label: "Tack", ord: "a3")])
    #expect(Self.proposing(holding, [["op": "connect", "nodeId": "c", "prerequisiteId": "new:tack"]]) == ["refused": ["code": "unknown-step", "id": "new:tack", "at": 0]])
    #expect(Self.proposing(holding, [["op": "add_step", "ref": "new:tack", "label": "Tack again"]]) == ["refused": ["code": "invalid-input", "id": "new:tack", "at": 0]])
  }

  @Test func aRoadmapWhoseStepsOrLinksAreAtTheSyncRegistrysCapTakesNoChangeThatAddsOneNamingTheRoadmap() {
    let steps = (0..<10_000).map { Step(id: "s\($0)", label: "Step \($0)", ord: "a" + String(repeating: "0", count: 5 - String($0).count) + String($0)) }
    let add: JSON = ["op": "add_step", "ref": "new:more", "label": "One more"]
    #expect(Self.proposing(Self.sailing(nodes: steps, edges: []), [["op": "rename", "nodeId": "s0", "label": "First"], add])
      == ["refused": ["code": "over-limit", "id": .string(Self.tree), "at": 1]])
    #expect(Self.proposing(Self.sailing(nodes: Array(steps.dropFirst()), edges: []), [add])["base"] != nil, "the ten thousandth step")
    #expect(Self.proposing(Self.sailing(nodes: steps, edges: []), [["op": "remove_step", "nodeId": "s1"], add])["base"] != nil,
            "a step the set removes makes room for one it adds")
    // Every link from a step to each step after it among 202, the first 20,000 of them: s200 to s201 is not among them.
    let ids = (0..<202).map { "s\($0)" }
    let links = ids.indices.flatMap { from in ids[(from + 1)...].map { RoadmapTree.Edge(from: ids[from], to: $0, present: true) } }.prefix(20_000)
    let woven = Self.sailing(nodes: ids.enumerated().map { Step(id: $0.element, label: $0.element, ord: "a" + String(repeating: "0", count: 3 - String($0.offset).count) + String($0.offset)) },
                             edges: Array(links))
    #expect(Self.proposing(woven, [["op": "connect", "nodeId": "s201", "prerequisiteId": "s200"]]) == ["refused": ["code": "over-limit", "id": .string(Self.tree), "at": 0]])
  }

  @Test func aBasePastTheBytesTheSyncRegistryCapsItAtRefusesTheWholeSetThoughItsChangesAreFew() {
    // `n` and `r` each follow 2,500 steps of their own, so folding `r` into `n` retires 2,500 links and makes 2,500.
    let sources = (0..<2500).map { "s" + String(repeating: "0", count: 4 - String($0).count) + String($0) }
    let nodes = [Step(id: "n", label: "Knead the dough", ord: "b0"), Step(id: "r", label: "Work the dough", ord: "b1")]
      + sources.enumerated().map { Step(id: $0.element, label: "Weigh \($0.offset)", ord: "c" + $0.element) }
    let merge: [JSON] = [["op": "merge", "nodeId": "n", "removeId": "r"]]
    #expect(Self.proposing(Self.sailing(nodes: nodes, edges: sources.map { RoadmapTree.Edge(from: $0, to: "r", present: true) }), merge)
      == ["refused": ["code": "over-limit"]])
    let smaller = Self.sailing(nodes: nodes, edges: sources.prefix(100).map { RoadmapTree.Edge(from: $0, to: "r", present: true) })
    #expect(Self.proposing(smaller, merge)["base"] == JSON(2 + 100 + 100))
  }

  // The web's size case: a set of 100 changes of every common kind over a roadmap of 5,000 steps, each following the one
  // before it. The ceiling is far above the time the fold takes.
  @Test func aProposalOfOneHundredChangesFoldsOverFiveThousandStepsInsideItsCeiling() {
    let treeId = "t_00000000000000bb"
    let id = { (step: Int) -> String in "s" + String(repeating: "0", count: 5 - String(step).count) + String(step) }
    let nodes = (0..<5000).map { Step(id: id($0), label: "Step \($0)", ord: String(repeating: "0", count: 5 - String($0).count) + String($0)) }
    let standing = StandingRoadmaps(trees: [RoadmapTree(id: treeId, own: true, meta: RoadmapTree.Metadata(title: "Five thousand steps", root: treeId),
                                                        nodes: nodes, edges: (1..<5000).map { RoadmapTree.Edge(from: id($0 - 1), to: id($0), present: true) },
                                                        kinds: [Kind(id: "learn", hue: "olive", label: "Learn", ord: "a0")])])
    let marks: [JSON] = (0..<10).map { ["op": "set_progress", "nodeId": .string(id($0)), "status": "complete"] }
    let added: [JSON] = (0..<25).map { ["op": "add_step", "ref": .string("new:s\($0)"), "label": .string("New \($0)"), "kind": "learn", "prerequisites": [.string(id($0 * 10))]] }
    let renamed: [JSON] = (0..<25).map { ["op": "rename", "nodeId": .string(id(1000 + $0)), "label": .string("Renamed \($0)")] }
    let described: [JSON] = (0..<10).map { ["op": "describe", "nodeId": .string(id(2000 + $0)), "description": .string("Described \($0)")] }
    let connected: [JSON] = (0..<20).map { ["op": "connect", "nodeId": .string(id(2500 + $0 * 10)), "prerequisiteId": .string(id(2495 + $0 * 10))] }
    let merged: [JSON] = (0..<5).map { ["op": "merge", "nodeId": .string(id(3000 + $0 * 10)), "removeId": .string(id(3001 + $0 * 10))] }
    let removed: [JSON] = (0..<5).map { ["op": "remove_step", "nodeId": .string(id(4000 + $0 * 10))] }
    let changes = marks + added + renamed + described + connected + merged + removed
    var minted = ["Pq7Rk2Xw9Lm4Nb6T"] + (0..<25).map { "m" + String(repeating: "0", count: 15 - String($0).count) + String($0) }
    var answer: ProposalAnswer?
    let elapsed = ContinuousClock().measure {
      answer = RoadmapProposals.answer(["treeId": .string(treeId), "changes": .array(changes)], over: standing, about: treeId, ids: { _ in minted.removeFirst() })
    }
    guard case .minted(let proposal, _)? = answer else {
      Issue.record("the set is refused: \(String(describing: answer))")
      return
    }
    #expect(proposal.changes.count == 100)
    print("propose_roadmap_change: 100 changes over 5,000 steps in \(elapsed), a base of \(proposal.base.count) registers")
    #expect(elapsed < .seconds(30))
  }
}
