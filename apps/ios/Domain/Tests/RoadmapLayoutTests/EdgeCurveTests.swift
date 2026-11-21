import RoadmapLayout
import Testing

struct EdgeCurveTests {
  @Test(arguments: try Fixtures.roadmaps())
  func everyLinkBowsAsTheWebBowsIt(_ name: String) throws {
    let fixture = try Fixtures.read(RoadmapFixture.self, name)
    let model = try fixture.renderModel()
    let drawn = model.links.map { link in
      let control = model.controlPoint(of: link)
      return [Number(link.sway), Number(control.x), Number(control.y)]
    }
    #expect(drawn == fixture.links.map { [$0.sway, $0.cx, $0.cy] })
  }
}
