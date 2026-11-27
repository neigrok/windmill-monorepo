import DomainKit
import RoadmapDomain
import SyncCore
import Testing

// The direct writes' rules beyond the corpus's cases: every refusal of §6 and §6.1 a direct write meets, in §6's order,
// and what a write sends where a call leaves a field out. A lone surrogate never reaches Swift, so the web alone holds
// its case (web/test/products/roadmap/domain/abilities/writes.test.js).
struct AbilityWritesTests {
  // A roadmap of the person's own as the standing roadmap holds it: `a` done, `b` available, `c` waiting on both, and `x` a
  // step another device deleted, removed from it.
  static func sailing(own: Bool = true, read: RoadmapTree.Read = .loaded, nodes: [Step]? = nil, edges: [RoadmapTree.Edge]? = nil,
                      marks: [RoadmapTree.Mark]? = nil, pointers: [RoadmapTree.Pointer] = []) -> RoadmapTree {
    let steps = [Step(id: "a", label: "Leave the dock", ord: "a0"),
                 Step(id: "b", label: "Tie a bowline", ord: "a1", description: "Round the post.", links: [Step.Link(url: "https://example.org/bowline", label: "Knots")]),
                 Step(id: "c", label: "Sail with an instructor", ord: "a2"), Step(id: "x", present: false, label: "Read the wind", ord: "a3")]
    let links = [RoadmapTree.Edge(from: "a", to: "c", present: true), RoadmapTree.Edge(from: "b", to: "c", present: true)]
    let done = [RoadmapTree.Mark(node: "a", status: "complete", outOfOrder: false, recordedAt: Instant(ms: 1_800_000_000_000), deviceAt: Instant(ms: 1_800_000_000_000))]
    return RoadmapTree(id: "t_0000000000000001", read: read, own: own, meta: RoadmapTree.Metadata(title: "Learn to sail", root: "t_0000000000000001"), nodes: nodes ?? steps,
                       edges: edges ?? links, kinds: [Kind(id: "build", hue: "terracotta", label: "Build", ord: "a0"), Kind(id: "learn", hue: "olive", label: "Learn", ord: "a1")],
                       marks: marks ?? done, pointers: pointers)
  }

  // One call of each direct write on `step`.
  static func everyWrite(_ tree: String, _ step: String = "b") -> [(String, JSON)] {
    [("set_progress", ["treeId": .string(tree), "nodeId": .string(step), "status": "complete"]),
     ("update_node", ["treeId": .string(tree), "nodeId": .string(step), "label": "Tie a cleat hitch"]),
     ("update_node", ["treeId": .string(tree), "nodeId": .string(step), "description": "Through the loop."]),
     ("create_node", ["treeId": .string(tree), "label": "Hoist the sail", "prerequisites": [.string(step)]]),
     ("connect", ["treeId": .string(tree), "nodeId": .string(step), "prerequisiteId": "a"])]
  }

  static func answers(_ standing: StandingRoadmaps, _ calls: [(String, JSON)], about: String? = "t_0000000000000001") -> [JSON] {
    calls.map { RoadmapAbilities.answer($0.0, $0.1, over: standing, about: about, ids: { "k1x9q2m7p4z8w3r5" }).form }
  }

  static func refused(_ code: String, _ id: String? = nil) -> JSON {
    ["refused": id.map { ["code": .string(code), "id": .string($0)] } ?? ["code": .string(code)]]
  }

  static func write(_ name: String, _ input: JSON.Object, over standing: StandingRoadmaps = StandingRoadmaps(trees: [sailing()])) -> JSON {
    var call = input
    call["treeId"] = "t_0000000000000001"
    return answers(standing, [(name, .object(call))])[0]
  }

  @Test func aWriteNamesARoadmapTheDeviceHoldsWholeOneItIsStillBringingWaitsAndOneThatIsNoneOfThePersonsIsUnknown() {
    #expect(Self.answers(StandingRoadmaps(trees: [Self.sailing(read: .unread)]), Self.everyWrite("t_0000000000000001"))
      == Self.everyWrite("t_0000000000000001").map { _ in Self.refused("roadmap-unavailable", "t_0000000000000001") })
    let other = "t_0000000000000009"
    #expect(Self.answers(StandingRoadmaps(trees: [Self.sailing()]), Self.everyWrite(other)) == Self.everyWrite(other).map { _ in Self.refused("unknown-roadmap", other) })
  }

  @Test func aConversationAboutAllOfThePersonsRoadmapsTakesNoDirectWrite() {
    #expect(Self.answers(StandingRoadmaps(trees: [Self.sailing()]), Self.everyWrite("t_0000000000000001"), about: nil)
      == Self.everyWrite("t_0000000000000001").map { _ in Self.refused("out-of-scope", "t_0000000000000001") })
  }

  @Test func everyWriteThatNamesAStepUnderADeleteThePersonCanStillUndoIsNotReadyBeforeWhoseRoadmapItIs() {
    let held = Self.sailing(own: false, nodes: Self.sailing().nodes + [Step(id: "h", present: false, label: "Reef the sail", ord: "a4")])
    let standing = StandingRoadmaps(trees: [held], held: [StandingRoadmaps.Held(tree: "t_0000000000000001", step: "h")])
    #expect(Self.answers(standing, Self.everyWrite("t_0000000000000001", "h")) == Self.everyWrite("t_0000000000000001").map { _ in Self.refused("roadmap-not-ready", "h") })
    #expect(Self.answers(standing, [("connect", ["treeId": "t_0000000000000001", "nodeId": "b", "prerequisiteId": "h"]),
                                    ("create_node", ["treeId": "t_0000000000000001", "label": "Hoist the sail", "prerequisites": ["a", "h"]])])
      == [Self.refused("roadmap-not-ready", "h"), Self.refused("roadmap-not-ready", "h")])
  }

  @Test func aStepTheRoadmapDoesNotShowIsUnknownToEveryWriteAStepAnotherDeviceDeletedAmongThem() {
    let standing = StandingRoadmaps(trees: [Self.sailing()])
    for step in ["zz", "x"] {
      #expect(Self.answers(standing, Self.everyWrite("t_0000000000000001", step)) == Self.everyWrite("t_0000000000000001").map { _ in Self.refused("unknown-step", step) })
    }
    #expect(Self.write("connect", ["nodeId": "b", "prerequisiteId": "zz"]) == Self.refused("unknown-step", "zz"), "the step waited on")
  }

  @Test func aValuePastACapIsRefusedOnTheDeviceNamingTheStepItWritesNoneForANewOneAndTheRoadmapWhereItsCountIsFull() {
    let link: JSON = ["url": "https://example.org/knots", "label": "Knots"]
    let accent = { (count: Int) in String(repeating: "é", count: count) }
    #expect([
      Self.write("update_node", ["nodeId": "b", "description": .string(accent(16_001))]),
      Self.write("update_node", ["nodeId": "b", "links": .array(Array(repeating: link, count: 33))]),
      Self.write("update_node", ["nodeId": "b", "links": [["url": .string("https://example.org/" + String(repeating: "k", count: 2_029))]]]),
      Self.write("update_node", ["nodeId": "b", "links": [["url": "https://example.org/knots", "label": .string(String(repeating: "k", count: 201))]]]),
      Self.write("create_node", ["label": .string(accent(201)), "prerequisites": []]),
      Self.write("create_node", ["label": "Hoist the sail", "description": .string(accent(16_001)), "prerequisites": []]),
    ] == [Self.refused("over-limit", "b"), Self.refused("over-limit", "b"), Self.refused("over-limit", "b"), Self.refused("over-limit", "b"),
          Self.refused("over-limit"), Self.refused("over-limit")])
    #expect(Self.write("update_node", ["nodeId": "b", "description": .string(accent(16_000)), "links": .array(Array(repeating: link, count: 32))])
      == ["writes": [["action": "ChangeStep", "input": ["tree": "t_0000000000000001", "step": "b", "changes": [
        "description": .string(accent(16_000)), "links": .array(Array(repeating: link, count: 32))]]]], "result": [:]], "a value at its cap")

    let created: JSON = ["writes": [["action": "CreateStep", "input": ["tree": "t_0000000000000001", "step": ["label": "Hoist the sail", "color": "terracotta"],
                                                                        "prerequisites": [], "id": "k1x9q2m7p4z8w3r5"]]], "result": ["nodeId": "k1x9q2m7p4z8w3r5"]]
    let steps = { (count: Int) in (0..<count).map { Step(id: "s\($0)") } }
    let create: (String, JSON) = ("create_node", ["treeId": "t_0000000000000001", "label": "Hoist the sail", "prerequisites": []])
    #expect(Self.answers(StandingRoadmaps(trees: [Self.sailing(nodes: steps(10_000), edges: [], marks: [])]), [create]) == [Self.refused("over-limit", "t_0000000000000001")])
    #expect(Self.answers(StandingRoadmaps(trees: [Self.sailing(nodes: steps(9_999), edges: [], marks: [])]), [create]) == [created], "the ten thousandth step")

    let ids = (0..<202).map { "s\($0)" }
    let linked = ids.indices.flatMap { from in ids[(from + 1)...].map { RoadmapTree.Edge(from: ids[from], to: $0, present: true) } }.prefix(20_000)
    let woven = StandingRoadmaps(trees: [Self.sailing(nodes: ids.map { Step(id: $0) }, edges: Array(linked), marks: [])])
    #expect(Self.answers(woven, [("connect", ["treeId": "t_0000000000000001", "nodeId": "s201", "prerequisiteId": "s200"]),
                                 ("create_node", ["treeId": "t_0000000000000001", "label": "Hoist the sail", "prerequisites": ["s0"]])])
      == [Self.refused("over-limit", "t_0000000000000001"), Self.refused("over-limit", "t_0000000000000001")])
  }

  @Test func aLinkThatWouldCloseALoopAmongWhatStepsFollowIsRefusedThroughARemovedStepAndFromAStepToItself() {
    let standing = StandingRoadmaps(trees: [Self.sailing(edges: [RoadmapTree.Edge(from: "a", to: "x", present: true), RoadmapTree.Edge(from: "x", to: "b", present: true)])])
    #expect(Self.answers(standing, [("connect", ["treeId": "t_0000000000000001", "nodeId": "a", "prerequisiteId": "b"]),
                                    ("connect", ["treeId": "t_0000000000000001", "nodeId": "c", "prerequisiteId": "c"])])
      == [Self.refused("closes-cycle", "a"), Self.refused("closes-cycle", "c")])
  }

  @Test func aWriteThatSendsWhatTheStepAlreadyHoldsChangesNothing() {
    let standing = StandingRoadmaps(trees: [Self.sailing(edges: [RoadmapTree.Edge(from: "a", to: "x", present: true), RoadmapTree.Edge(from: "x", to: "b", present: true),
                                                                 RoadmapTree.Edge(from: "b", to: "c", present: true)])])
    #expect(Self.answers(standing, [
      ("update_node", ["treeId": "t_0000000000000001", "nodeId": "b", "label": "Tie a bowline"]),
      ("update_node", ["treeId": "t_0000000000000001", "nodeId": "b", "description": "Round the post.", "links": [["url": "  https://example.org/bowline ", "label": "Knots"]]]),
      ("connect", ["treeId": "t_0000000000000001", "nodeId": "b", "prerequisiteId": "a"]),
      ("connect", ["treeId": "t_0000000000000001", "nodeId": "c", "prerequisiteId": "b"]),
      ("set_progress", ["treeId": "t_0000000000000001", "nodeId": "c", "status": "none"]),
    ]) == ["b", "b", "b", "c", "c"].map { Self.refused("no-change", $0) })
  }

  @Test func webLinksAreWrittenAsTheDomainStoresThemAndAnAddressTheRoomDoesNotShowIsRefused() {
    #expect(Self.write("update_node", ["nodeId": "b", "links": [["url": " mailto:skipper@example.org "]]])
      == ["writes": [["action": "ChangeStep", "input": ["tree": "t_0000000000000001", "step": "b", "changes": ["links": [["url": "mailto:skipper@example.org", "label": ""]]]]]],
          "result": [:]])
    #expect(Self.write("update_node", ["nodeId": "b", "links": [["url": "https://example.org/knots"], ["url": "ftp://example.org/knots"]]])
      == Self.refused("address-not-allowed", "b"))
  }

  @Test func aNewStepWearsItsKindsHueTerracottaWhereItNamesNoneAfterEachPrerequisiteOnceWithTheWordsItIsGiven() {
    #expect(Self.write("create_node", ["label": "Hoist the sail", "description": "Main first.", "prerequisites": ["a", "b", "a"]])
      == ["writes": [["action": "CreateStep", "input": ["tree": "t_0000000000000001", "step": ["label": "Hoist the sail", "color": "terracotta", "description": "Main first."],
                                                        "prerequisites": ["a", "b"], "id": "k1x9q2m7p4z8w3r5"]]], "result": ["nodeId": "k1x9q2m7p4z8w3r5"]])
    #expect(Self.write("create_node", ["label": "Hoist the sail", "kind": "learn", "description": "", "prerequisites": []])
      == ["writes": [["action": "CreateStep", "input": ["tree": "t_0000000000000001", "step": ["label": "Hoist the sail", "color": "olive"], "prerequisites": [],
                                                        "id": "k1x9q2m7p4z8w3r5"]]], "result": ["nodeId": "k1x9q2m7p4z8w3r5"]])
  }

  @Test func aStepThatOpensARoadmapTheDeviceHoldsNothingOfTakesNeitherMarkAndALockedStepMayStillBeMarkedNotDone() {
    let marks = [RoadmapTree.Mark(node: "a", status: "complete", outOfOrder: false, recordedAt: nil, deviceAt: nil),
                 RoadmapTree.Mark(node: "c", status: "complete", outOfOrder: true, recordedAt: nil, deviceAt: nil)]
    let standing = StandingRoadmaps(trees: [Self.sailing(marks: marks, pointers: [RoadmapTree.Pointer(node: "b", present: true, opens: "t_0000000000000009")])])
    #expect(Self.answers(standing, [
      ("set_progress", ["treeId": "t_0000000000000001", "nodeId": "b", "status": "complete"]),
      ("set_progress", ["treeId": "t_0000000000000001", "nodeId": "b", "status": "none"]),
      ("set_progress", ["treeId": "t_0000000000000001", "nodeId": "c", "status": "none"]),
    ]) == [Self.refused("opens-roadmap", "b"), Self.refused("opens-roadmap", "b"),
           ["writes": [["action": "Reset", "input": ["tree": "t_0000000000000001", "step": "c"]]], "result": [:]]])
  }

  @Test func aTextTheDomainCannotStoreIsMalformedBeforeAnyCapAndABlankAddressIsTheAddressRules() {
    #expect([
      Self.write("update_node", ["nodeId": "b", "description": .string(String(repeating: "é", count: 16_001) + "\u{0}")]),
      Self.write("update_node", ["nodeId": "b", "links": .array(Array(repeating: ["url": "https://example.org/knots", "label": "\u{0}"], count: 33))]),
      Self.write("create_node", ["label": "Hoist the sail", "description": "Main\u{0}first.", "prerequisites": []]),
      Self.write("update_node", ["nodeId": "b", "label": "Tie a \u{1F600} bowline"]),
      Self.write("update_node", ["nodeId": "b", "links": [["url": "   "]]]),
    ] == [
      Self.refused("invalid-input", "b"), Self.refused("invalid-input", "b"), Self.refused("invalid-input"),
      ["writes": [["action": "ChangeStep", "input": ["tree": "t_0000000000000001", "step": "b", "changes": ["label": "Tie a \u{1F600} bowline"]]]], "result": [:]],
      Self.refused("address-not-allowed", "b"),
    ])
  }

  @Test func aStepsChecklistTakesNewItemsAtItsEndEachHeldToTheSubtasksRuleAndTheRoadmapsCountOfSubtasksToItsCap() {
    let checklist = { (count: Int) in
      (0..<count).map { StandingRoadmaps.ChecklistItem(tree: "t_0000000000000001", step: $0 % 2 == 1 ? "b" : "x", label: "Item \($0)", done: false) }
    }
    let add = { (subtasks: [StandingRoadmaps.ChecklistItem], items: [String]) -> JSON in
      Self.write("update_node", ["nodeId": "b", "subtasks": .array(items.map(JSON.string))], over: StandingRoadmaps(trees: [Self.sailing()], subtasks: subtasks))
    }
    let padded = "  " + String(repeating: "é", count: 200) + "  "
    #expect([
      add(checklist(19_999), ["Check the shackle"]),
      add(checklist(19_999), ["Check the shackle", "Coil the line"]),
      add([], ["Check the shackle", "   "]),
      add([], [padded]),
    ] == [
      ["writes": [["action": "AddSubtask", "input": ["tree": "t_0000000000000001", "step": "b", "label": "Check the shackle"]]], "result": [:]],
      Self.refused("over-limit", "t_0000000000000001"),
      Self.refused("invalid-input", "b"),
      ["writes": [["action": "AddSubtask", "input": ["tree": "t_0000000000000001", "step": "b", "label": .string(padded)]]], "result": [:]],
    ], "a removed step's items count too, and a label is measured after the trim the domain applies")
  }
}
