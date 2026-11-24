import RoadmapDomain
import Testing

// The states a plan's steps land in, read by the domain over the plan as over a roadmap, and over a roadmap as a paste
// would leave it: what New Roadmap and Paste Steps show before anything is written.
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
