import RoadmapLayout
import Testing

struct SkillTreeTests {
  @Test(arguments: try Fixtures.roadmaps())
  func everyStepIsDrawnInItsTier(_ name: String) throws {
    let fixture = try Fixtures.read(RoadmapFixture.self, name)
    #expect(try fixture.tree().tiers.map(\.rawValue) == fixture.tiers)
  }

  @Test(arguments: try Fixtures.roadmaps())
  func everyLinkIsOfTheKindTheTrunkGivesIt(_ name: String) throws {
    let fixture = try Fixtures.read(RoadmapFixture.self, name)
    let model = try fixture.renderModel()
    let drawn = model.links.map { [Text(model.nodes[$0.from].id), Text(model.nodes[$0.to].id), Text(UTF16Text($0.kind.rawValue))] }
    #expect(drawn == fixture.links.map { [$0.from, $0.to, Text(UTF16Text($0.kind))] })
  }

  @Test(arguments: try Fixtures.roadmaps())
  func theBoundsAreTheBoxAroundEverySeat(_ name: String) throws {
    let fixture = try Fixtures.read(RoadmapFixture.self, name)
    let bounds = try fixture.renderModel().bounds
    let drawn = RoadmapFixture.Bounds(minX: Number(bounds.minX), minY: Number(bounds.minY), maxX: Number(bounds.maxX), maxY: Number(bounds.maxY))
    #expect(drawn == fixture.bounds)
  }

  @Test func aRoadmapThatIsNoGraphOfStepsIsRefused() {
    func step(_ id: String, follows: [String]) -> SkillTree.Step {
      SkillTree.Step(id: id, label: id, ord: "a0", born: SkillTree.Stamp(ms: 0, counter: 0, actor: ""), follows: follows, hue: "sky", done: false)
    }
    #expect(throws: SkillTree.Malformed.duplicateStep(UTF16Text("a"))) {
      try SkillTree(steps: [step("a", follows: []), step("a", follows: [])])
    }
    #expect(throws: SkillTree.Malformed.unknownStep(UTF16Text("b"), followedBy: UTF16Text("a"))) {
      try SkillTree(steps: [step("a", follows: ["b"])])
    }
    #expect(throws: SkillTree.Malformed.cycle) {
      try SkillTree(steps: [step("a", follows: ["b"]), step("b", follows: ["a"]), step("c", follows: [])])
    }
  }
}
