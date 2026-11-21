import RoadmapLayout
import Testing

struct CaptionLayoutTests {
  // One placer for each canvas, given its insets and blocks once and then asked in turn, so each pass meets the records
  // the passes before it left. A caption's text is measured by the fixtures' ruler.
  @Test(arguments: try Fixtures.roadmaps())
  func captionsSitWhereTheWebSeatsThemPassAfterPass(_ name: String) throws {
    let fixture = try Fixtures.read(RoadmapFixture.self, name)
    let model = try fixture.renderModel()
    var metrics: [UTF16Text: CaptionMetric] = [:]
    for node in model.nodes { metrics[node.id] = CaptionMetric(wrapping: node.label, measure: CaptionMetric.ruler) }
    for written in fixture.canvases {
      var placer = CaptionPlacer()
      placer.setModel(model, SpatialGrid(model.nodes, cellSize: Theme.nodeSize * 2))
      placer.setMetrics(metrics)
      placer.setInsets(written.chrome, blocks: try written.corners())
      for (index, pass) in written.passes.enumerated() {
        placer.setContext(selected: pass.selected.map { UTF16Text($0) }, hovered: pass.hovered.map { UTF16Text($0) })
        let placed = placer.place(camera: pass.camera.frame, viewport: written.size, now: pass.now)
        let captions = placed.captions.map { caption in
          RoadmapFixture.Caption(
            id: Text(caption.id), anchor: caption.anchor.rawValue, left: Number(caption.left), top: Number(caption.top),
            width: Number(caption.width), height: Number(caption.height), lines: caption.lines.map { Text(UTF16Text($0)) },
            shown: caption.shown)
        }
        #expect(CaptionPlacer.captionRankLimit(pass.camera.frame.zoom).rawValue == pass.rankLimit, "\(written.name), pass \(index)")
        #expect(captions == pass.captions, "\(written.name), pass \(index)")
        #expect(placed.nextDeadline.map { Number($0) } == pass.nextDeadline, "\(written.name), pass \(index)")
      }
    }
  }
}
