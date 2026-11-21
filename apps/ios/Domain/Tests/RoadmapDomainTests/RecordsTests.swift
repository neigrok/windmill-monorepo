import RoadmapDomain
import SyncCore
import Testing

struct RecordsTests {
  // Swift's own String equality folds the two spellings into one; the web and the server read two steps.
  @Test func idsThatDifferOnlyInSpellingAreTwoSteps() {
    let composed = "\u{E9}"
    let decomposed = "e\u{301}"
    let tree = RoadmapTree(id: "T", meta: RoadmapTree.Metadata(root: "T"), nodes: [Step(id: composed, ord: "a0"), Step(id: decomposed, ord: "a1")],
                           edges: [RoadmapTree.Edge(from: composed, to: decomposed, present: true)],
                           marks: [RoadmapTree.Mark(node: composed, status: "complete", outOfOrder: false, recordedAt: nil, deviceAt: nil)])
    let expected: JSON = [
      "presentIds": [.string(composed), .string(decomposed)],
      "states": [["id": .string(composed), "state": "complete"], ["id": .string(decomposed), "state": "available"]],
      "steps": [
        ["id": .string(composed), "followed": [], "unmet": [], "owed": [], "owedCount": 0, "unlocks": []],
        ["id": .string(decomposed), "unmet": [], "owed": [], "owedCount": 0, "unlocks": [],
         "followed": [["id": .string(composed), "incoming": [[.string(composed), .string(decomposed)]], "throughAbsent": false]]],
      ],
    ]
    #expect(FollowGraph(tree).form(subjects: [composed, decomposed]) == expected)
  }
}
