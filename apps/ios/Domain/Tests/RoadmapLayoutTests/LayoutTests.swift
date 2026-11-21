import Foundation
import RoadmapLayout
import Testing

struct LayoutTests {
  @Test func everyFileOfTheDirectoryIsClaimed() throws {
    let claimed = [
      "archipelago", "arithmetic", "braided", "ceiling", "deep", "empty", "fallback", "fallback-roots", "handbook", "ids", "islands",
      "learn-to-sail", "scripts", "wide",
    ]
    #expect(try Fixtures.names() == claimed)
  }

  @Test(arguments: try Fixtures.roadmaps())
  func aRoadmapIsSeatedWhereTheWebSeatsIt(_ name: String) throws {
    let fixture = try Fixtures.read(RoadmapFixture.self, name)
    let seating = try fixture.seating()
    #expect(seating.engine.rawValue == fixture.engine)
    #expect(seating.seats.map { [Number($0.x), Number($0.y)] } == fixture.seats)
  }

  // No roadmap a person can make turns the bubble layout through an angle the arithmetic refuses, so the engine here does.
  @Test func aRoadmapWhoseLayoutThrowsIsSeatedByTheFallback() throws {
    struct Refusing: LayoutEngine {
      let name = LayoutName.bubble

      func layout(_ tree: SkillTree) throws -> [Point] {
        [Point(x: try Arithmetic.cos(Arithmetic.reducibleBelow), y: 0)]
      }
    }
    let fixture = try Fixtures.read(RoadmapFixture.self, "fallback")
    let seating = try Seating(of: try fixture.tree(), by: Refusing())
    #expect(seating.engine == .radial)
    #expect(seating.seats.map { [Number($0.x), Number($0.y)] } == fixture.seats)
  }

  // The app's budget is a first frame under a second on an iPhone XR; the ceiling here only catches a layout that hangs.
  @Test func fiveThousandStepsAreSeatedWithinAGenerousCeiling() throws {
    let fixture = try Fixtures.read(RoadmapFixture.self, "handbook")
    let took = try ContinuousClock().measure {
      let tree = try fixture.tree()
      _ = RenderModel(of: tree, seats: try Seating(of: tree).seats)
    }
    print("RoadmapLayout drew handbook's \(fixture.roadmap.steps.count) steps in \(took)")
    #expect(took < .seconds(120))
  }
}
