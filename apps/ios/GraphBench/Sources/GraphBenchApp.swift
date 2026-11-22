import QuartzCore
import SwiftUI
import RoadmapLayout

@main
struct GraphBenchApp: App {
  @State private var bench = GraphBench()

  var body: some Scene {
    WindowGroup { GraphBenchScreen(bench: bench) }
  }
}

// The picture on one Canvas over the room's ground, as the room's `RoadmapGraphCanvas` wires it: the canvas runs under
// the screen's edges, takes its size and what covers it from the space around it, and draws again only when the
// picture, the camera or the captions change. It stands alone on the screen, the script moving the camera where the
// room has gestures, and the run's lines stand over it once the run is done. Its draw closure is the room's but for
// what it tells: it times itself, and it holds nothing of the main actor, so a canvas that renders asynchronously can
// call it from another thread.
struct GraphBenchScreen: View {
  let bench: GraphBench

  var body: some View {
    let (picture, camera, captions, drawn) = (bench.picture, bench.camera, bench.captions, bench.frames.drawn)
    GeometryReader { space in
      let bars = space.safeAreaInsets
      Canvas(rendersAsynchronously: bench.rendersAsynchronously) { @Sendable context, _ in
        guard let picture, let camera else { return }
        let began = CACurrentMediaTime()
        GraphDrawing(picture: picture, camera: camera, captions: captions, selected: nil).draw(in: &context)
        drawn.drew(since: began)
      }.ignoresSafeArea()
        .onChange(of: [space.size.width, space.size.height, bars.top, bars.trailing, bars.bottom, bars.leading], initial: true) {
          bench.resize(Viewport(width: space.size.width + bars.leading + bars.trailing, height: space.size.height + bars.top + bars.bottom),
                       under: Insets(top: bars.top, right: bars.trailing, bottom: bars.bottom, left: bars.leading))
        }
    }.background { RoadmapPalette.canvas.ignoresSafeArea() }
      .overlay {
        if let said = bench.said {
          ScrollView {
            Text(verbatim: said.joined(separator: "\n\n")).font(.caption2.monospaced()).foregroundStyle(RoadmapPalette.ink)
              .frame(maxWidth: .infinity, alignment: .leading).padding()
          }.background(RoadmapPalette.canvas)
        }
      }
      .task { await bench.run() }
  }
}
