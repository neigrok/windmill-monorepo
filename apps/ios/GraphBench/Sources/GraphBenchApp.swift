import SwiftUI
import RoadmapLayout

@main
struct GraphBenchApp: App {
  @State private var bench = GraphBench()

  var body: some Scene {
    WindowGroup { GraphBenchScreen(bench: bench) }
  }
}

// The room's own `GraphSurface` over the room's ground, sized as the room's `RoadmapGraphCanvas` sizes it: it runs under
// the screen's edges and takes its size and what covers it from the space around it. It stands alone on the screen,
// the script moving the camera where the room has gestures, and the run's lines stand over it once the run is done.
struct GraphBenchScreen: View {
  let bench: GraphBench

  var body: some View {
    GeometryReader { space in
      let bars = space.safeAreaInsets
      GraphSurface(picture: bench.picture, camera: bench.camera, captions: bench.captions, selected: nil, pinched: bench.pinched,
                   pinch: bench.pinch ?? .room, crowd: GraphPinch.crowd) { began in bench.frames.drew(since: began) }
        .ignoresSafeArea()
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
