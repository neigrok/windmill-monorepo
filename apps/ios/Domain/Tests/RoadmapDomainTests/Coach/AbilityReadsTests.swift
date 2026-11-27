import DomainKit
import RoadmapDomain
import SyncCore
import Testing

// The read abilities' own rules beyond the corpus's cases: get_tree's order around loops, list_trees' frontier in that
// order, and get_diagnostics' lists paged with their counts of what is left off on the first page alone.
struct AbilityReadsTests {
  static func read(_ name: String, _ input: JSON, over trees: [RoadmapTree], listRead: Bool = true) -> JSON {
    RoadmapAbilities.answer(name, input, over: StandingRoadmaps(trees: trees, listRead: listRead), about: "t_0000000000000001", ids: { "" }).form
  }

  @Test func getTreeAnswersEachStepAfterEveryStepItFollowsTheFirstInTheRoomsOrderFirstAndALoopAndWhatWaitsOnItLastInIdByteOrder() throws {
    let steps = ["x", "z", "p", "y", "Q", "r", "s"].enumerated().map { Step(id: $0.element, ord: "a\($0.offset)") }
    let edges = [("y", "x"), ("p", "Q"), ("Q", "p"), ("p", "r"), ("s", "s")].map { RoadmapTree.Edge(from: $0.0, to: $0.1, present: true) }
    let tree = RoadmapTree(id: "t_0000000000000001", own: true, meta: RoadmapTree.Metadata(title: "Sailing", root: "t_0000000000000001"), nodes: steps,
                           edges: edges)
    let answer = Self.read("get_tree", ["treeId": "t_0000000000000001", "fields": ["state"]], over: [tree])
    #expect(try answer["result"]?.member("steps").asArray().map { try $0.member("id") } == ["z", "y", "x", "Q", "p", "r", "s"])
  }

  @Test func listTreesNamesEachRoadmapsFrontierInGetTreesOrderAndIsRefusedWhileTheDeviceHasNotReadThePersonsList() {
    let tree = RoadmapTree(
      id: "t_0000000000000001", own: true, meta: RoadmapTree.Metadata(title: "Sailing", root: "t_0000000000000001"),
      nodes: [Step(id: "c", label: "Sail across", ord: "a0"), Step(id: "e", label: "Read the weather", ord: "a1"), Step(id: "d", label: "Leave the dock", ord: "a5")],
      edges: [RoadmapTree.Edge(from: "d", to: "c", present: true)],
      marks: [RoadmapTree.Mark(node: "d", status: "complete", outOfOrder: false, recordedAt: Instant(ms: 1_800_000_000_000), deviceAt: Instant(ms: 1_800_000_000_000))])
    #expect(Self.read("list_trees", [:], over: [tree]) == ["result": ["trees": [[
      "id": "t_0000000000000001", "title": "Sailing", "counts": ["total": 3, "done": 1, "available": 2, "locked": 0, "unknown": 0],
      "frontier": ["Read the weather", "Sail across"], "lastCompletedAt": 1_800_000_000_000,
    ]]]])
    #expect(Self.read("list_trees", [:], over: [tree], listRead: false) == ["refused": ["code": "roadmap-unavailable"]])
  }

  @Test func getDiagnosticsPagesItsListsEveryPageCarryingEachListAndOnlyTheFirstTheCountsOfWhatEachLeavesOff() throws {
    let step = { (cycle: Int, member: Int) in "c\(cycle < 10 ? "0" : "")\(cycle)-\(String(repeating: "x", count: 110))-\(member)" }
    let loops = (0..<55).map { cycle in (0..<12).map { step(cycle, $0) } }
    let edges = loops.flatMap { loop in loop.indices.map { RoadmapTree.Edge(from: loop[$0], to: loop[($0 + 1) % loop.count], present: true) } }
    let tree = RoadmapTree(id: "t_0000000000000001", own: true, meta: RoadmapTree.Metadata(title: "Knots", root: "t_0000000000000001"),
                           nodes: loops.flatMap { $0 }.map { Step(id: $0) }, edges: edges)
    var pages: [JSON] = []
    var cursor: JSON?
    repeat {
      var input: JSON.Object = ["treeId": "t_0000000000000001"]
      input["cursor"] = cursor
      let page = try #require(Self.read("get_diagnostics", .object(input), over: [tree])["result"])
      #expect(page.jcs.count <= 16384)
      pages.append(page)
      cursor = page["nextCursor"]
    } while cursor != nil && pages.count < 20
    let found = Diagnostics(FollowGraph(tree))
    let lists = ["cycles", "dangling", "danglingPointers", "selfEdges", "smells", "treeLoops"]
    #expect(try pages.map { try $0.asObject().keys.filter { $0 != "nextCursor" }.sorted() }
      == pages.indices.map { ($0 == 0 ? ["cyclesOmitted"] + lists : lists).sorted() })
    #expect(pages[0]["cyclesOmitted"] == 5)
    #expect(try pages.flatMap { try $0.member("cycles").asArray() }
      == found.cycles.entries.map { ["count": JSON($0.count), "nodes": .array($0.named.map(JSON.string))] })
    #expect(try pages.flatMap { try $0.member("smells").asArray() }
      == [["kind": "empty-legend"], ["kind": "empty-icon", "count": 660, "nodes": .array(found.smells[0].nodes.named.map(JSON.string))]])
    #expect(pages.count > 1)

    let reader = RoadmapTree(id: "t_0000000000000001", own: false, meta: RoadmapTree.Metadata(title: "Knots", root: "t_0000000000000001"))
    #expect(Self.read("get_diagnostics", ["treeId": "t_0000000000000001"], over: [reader])
      == ["result": ["cycles": [], "dangling": [], "selfEdges": [], "smells": []]], "a roadmap the person only reads says nothing of the roadmaps its steps open")
  }
}
