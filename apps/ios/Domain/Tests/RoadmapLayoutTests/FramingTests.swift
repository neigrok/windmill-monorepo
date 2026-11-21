import RoadmapLayout
import Testing

struct FramingTests {
  @Test(arguments: try Fixtures.roadmaps())
  func aRoadmapIsFramedOnAPhoneAndInABrowser(_ name: String) throws {
    let fixture = try Fixtures.read(RoadmapFixture.self, name)
    let model = try fixture.renderModel()
    for written in fixture.canvases {
      let canvas = GraphCanvas(viewport: written.size, insets: written.chrome, workingZoom: written.workingZoom, fitBounds: model.bounds)
      #expect(RoadmapFixture.Camera(canvas.fitFrame(model.bounds)) == written.fit, "\(written.name)")
      #expect(Number(canvas.minZoom) == written.floor, "\(written.name)")
      let focus = try written.focus.map { focus in
        let node = try #require(model.nodes.firstIndex { Text($0.id) == focus.step })
        let frame = canvas.focusFrame(model, node)
        return RoadmapFixture.Focus(step: focus.step, x: Number(frame.x), y: Number(frame.y), zoom: Number(frame.zoom))
      }
      #expect(focus == written.focus, "\(written.name)")
    }
  }
}
