import RoadmapDomain
import Testing

// The states a plan's steps land in, read by the domain over the plan as over a roadmap, and over a roadmap as a paste
// would leave it: what New Roadmap and Paste Steps show before anything is written; and how long a read takes.
struct PlanActsTests {
  static let genesis = RoadmapRules.genesisKinds.map { RoadmapPlan.Kind(id: $0.id.description, hue: $0.hue, label: $0.label, description: $0.description) }

  @Test func aPlantedPlanLandsDoneUpNextAndLockedAsItsMarksAndLinksSay() throws {
    let plan = RoadmapPlan(reading: "Summer cruise\n- [x] Pick the week\n- [x] Book the boat\n  - Plan the route\n    - Check the tides\n- Cast off", over: Self.genesis)
    let planting = try #require(plan.planting(named: ""))
    #expect(planting.landing.map { [$0.label, $0.color, $0.state.rawValue] } == [
      ["Summer cruise", "terracotta", "available"], ["Pick the week", "terracotta", "complete"], ["Book the boat", "terracotta", "complete"],
      ["Plan the route", "terracotta", "available"], ["Check the tides", "terracotta", "locked"], ["Cast off", "terracotta", "locked"],
    ])
  }

  // Names alike are renamed, and ids alike counted, in time that grows with their count, as names that differ are read:
  // the plan a person pastes on the phone, however repetitive.
  @Test func namesAlikeReadInTimeThatGrowsWithTheirCount() {
    let count = 4000
    let clock = ContinuousClock()
    func timed(_ lines: [String]) -> (plan: RoadmapPlan, took: Duration) {
      let start = clock.now
      let plan = RoadmapPlan(reading: lines.joined(separator: "\n"), over: Self.genesis)
      return (plan, clock.now - start)
    }
    let different = timed(["Plan"] + (0..<count).map { "- Practice scales, day \($0)" })
    let alike = timed(["Plan"] + Array(repeating: "- Practice scales", count: count))
    let filed = timed(["# Plan", "<!-- windmill:roadmap 2 -->"] + Array(repeating: "- Practice scales", count: count))
    #expect(alike.plan.nodes.last.map { [$0.id, $0.label] } == ["practice-scales-\(count)", "Practice scales (\(count))"])
    #expect(filed.plan.nodes.last.map { [$0.id, $0.label] } == ["practice-scales-\(count)", "Practice scales"])
    #expect(alike.took < different.took * 4 + .seconds(1), "\(count) names alike took \(alike.took), \(count) that differ \(different.took)")
    #expect(filed.took < different.took * 4 + .seconds(1), "\(count) names alike in a file took \(filed.took), \(count) that differ \(different.took)")
  }

  @Test func pastedStepsLandUnderTheStepTheyFollowAsTheRoadmapWouldHoldThem() throws {
    let roadmap = RoadmapTree(id: "t_0000000000000001", meta: RoadmapTree.Metadata(root: "t_0000000000000001"),
                              nodes: [Step(id: "start", label: "Choose a course"), Step(id: "wind", label: "Read the wind")],
                              edges: [RoadmapTree.Edge(from: "start", to: "wind", present: true)],
                              marks: [RoadmapTree.Mark(node: "start", status: "complete", outOfOrder: false, recordedAt: nil, deviceAt: nil)])
    let plan = RoadmapPlan(reading: "## Day sail\n- [x] Check the forecast\n- Plan the passage\n  - Pack the boat", over: Self.genesis, into: true)
    let graft = try #require(plan.graft(under: "start", held: ["start", "wind"], liveKinds: Self.genesis))
    #expect(graft.landing(in: roadmap).map { [$0.label, $0.state.rawValue] } == [
      ["Day sail", "available"], ["Check the forecast", "complete"], ["Plan the passage", "locked"], ["Pack the boat", "locked"],
    ])
    #expect(graft.under == "start" && graft.done == ["check-the-forecast"])
  }
}
