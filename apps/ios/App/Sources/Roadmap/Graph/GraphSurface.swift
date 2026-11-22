import QuartzCore
import SwiftUI
import RoadmapLayout

// How the Graph keeps its frames while a pinch moves a crowd of steps (Roadmap on iOS §5): at 5,000 steps a phone gives
// a pinch of the whole roadmap fewer frames than its budget when every disc is drawn anew at each of them. Each way
// draws what `live` draws once the pinch rests, and at every camera that holds no crowd.
nonisolated enum GraphPinch: String, CaseIterable, Sendable {
  // The picture drawn anew at every camera.
  case live
  // The picture drawn at the pinch's stops alone, the zooms `reach` apart counted from where the pinch began, and
  // scaled from the nearest stop to the camera: discs, rings and connectors grow and shrink with it, and no caption
  // is drawn.
  case held
  // The picture drawn anew at every camera, each disc one square of its colour, with no ring, dot or halo.
  case coarse
  // As `live`, composited through the system's `drawingGroup`.
  case layered

  // The way the Roadmap room keeps them.
  static let room = GraphPinch.live
  // A way acts while more steps than this are in view.
  static let crowd = 500
  static let reach = 1.5
}

// The Graph's picture on one Canvas, under a camera, as a strategy keeps a pinch's frames (Roadmap · iOS 04.1, 04.2,
// 04.4). The canvas draws again only when its drawing differs: under `held` a pinch between two stops moves the camera
// and not the drawing, and the canvas is scaled to the camera in place of a draw.
struct GraphSurface: View {
  let picture: GraphPicture?
  let camera: GraphCamera?
  let captions: [Caption]
  // The selected step, by its place.
  let selected: Int?
  let pinched: GraphCamera.Pinched?
  let pinch: GraphPinch
  let crowd: Int
  // Told each time the canvas has drawn the picture, with the moment that draw began.
  let drew: (CFTimeInterval) -> Void

  var body: some View {
    let drawing = picture.flatMap { (picture: GraphPicture) -> GraphDrawing? in
      camera.map { GraphDrawing(picture: picture, camera: $0, captions: captions, selected: selected, pinched: pinched, by: pinch, crowd: crowd) }
    }
    let canvas = Layer(drawing: drawing, drew: drew).equatable()
    switch pinch {
    case .live, .coarse: canvas
    case .held: canvas.transformEffect(drawing.flatMap { camera?.carries(from: $0.camera) } ?? .identity)
    case .layered: canvas.drawingGroup()
    }
  }

  // The canvas of one drawing, equal to another of the same drawing whoever is told of its draws.
  struct Layer: View, Equatable {
    let drawing: GraphDrawing?
    let drew: (CFTimeInterval) -> Void

    nonisolated static func == (one: Layer, other: Layer) -> Bool { one.drawing == other.drawing }

    var body: some View {
      Canvas { context, _ in
        guard let drawing else { return }
        let began = CACurrentMediaTime()
        drawing.draw(in: &context)
        drew(began)
      }
    }
  }
}
