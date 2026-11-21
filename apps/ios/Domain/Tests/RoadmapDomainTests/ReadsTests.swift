import RoadmapDomain
import Testing

struct ReadsTests {
  // The web lowercases a capital sigma that ends a word to the final sigma, which Swift's `lowercased()` does not.
  @Test(arguments: [("οδος", ["road"]), ("οδοσ", ["roads"]), ("ΟΔΟΣ", ["road"])])
  func boardSearchLowercasesAsTheWebDoes(search: String, found: [String]) {
    let steps = [Step(id: "road", label: "ΟΔΟΣ"), Step(id: "roads", label: "ΟΔΟΣΑ")]
    let board = BoardRead(FollowGraph(RoadmapTree(id: "T", meta: RoadmapTree.Metadata(root: "T"), nodes: steps)), BoardQuery(search: search))
    #expect(board.columns.map(\.ids) == [[], found, []])
  }

  // The web's size fixture: 5,000 steps, 1,800 unfinished, a fresh graph and Board each run. The ceiling is far above a linear read's time.
  @Test func aBoardOverFiveThousandStepsIsReadInsideItsCeiling() {
    let id = { (index: Int) -> String in "n" + String(repeating: "0", count: 5 - String(index).count) + String(index) }
    let nodes = (0..<5000).map { Step(id: id($0), label: "Step \($0)") }
    let edges = (0..<5000).flatMap { index -> [RoadmapTree.Edge] in
      let parents: Set<Int> = [index - 1, index > 2 ? index / 2 : -1, index > 7 ? index - 7 : -1]
      return parents.filter { $0 >= 0 }.map { RoadmapTree.Edge(from: id($0), to: id(index), present: true) }
    }
    let marks = (0..<3200).map { RoadmapTree.Mark(node: id($0), status: "complete", outOfOrder: false, recordedAt: nil, deviceAt: nil) }
    let tree = RoadmapTree(id: "T", meta: RoadmapTree.Metadata(root: "T"), nodes: nodes, edges: edges, marks: marks)
    let timings = (0..<5).map { run in
      ContinuousClock().measure {
        let board = BoardRead(FollowGraph(tree), BoardQuery(search: run % 2 == 1 ? "step 4" : ""))
        #expect([board.overall.done, board.overall.total] == [3200, 5000])
        #expect(board.columns.map(\.ids.count) == (run % 2 == 1 ? [1000, 0, 111] : [1799, 1, 3200]))
      }
    }.sorted()
    print("roadmap Board over 5,000 steps, 1,800 unfinished: median \(timings[2]), slowest \(timings[4])")
    #expect(timings[2] < .seconds(5))
  }
}
