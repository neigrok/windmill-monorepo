import CoreGraphics
import RoadmapLayout

// The Graph's camera (Roadmap · iOS 04.1, 04.4; the web's `Camera2D` without its glides): the world point at the
// centre of the canvas and the zoom, over a canvas that runs under the room's bars. It opens where the layout frames
// the roadmap and stays inside what that framing gives: no zoom under the layout's floor, none over the web's pinch
// ceiling, and the roadmap's box never out of what the bars leave.
nonisolated struct GraphCamera: Equatable {
  // The web's pinch ceiling (`Camera2D.PINCH_MAX_ZOOM`).
  static let pinchCeiling = 2.5

  private(set) var frame = Frame(x: 0, y: 0, zoom: 1)
  // The canvas's size, the points the bars cover on each side of it, and the box around the roadmap's seats.
  let viewport: Viewport
  let insets: Insets
  let bounds: Rect

  // The camera as the layout frames the roadmap: the whole of it inside what the bars leave, no closer than the
  // phone's working zoom.
  init(framing bounds: Rect, in viewport: Viewport, under insets: Insets) {
    self.viewport = viewport
    self.insets = insets
    self.bounds = bounds
    frame = framing.fitFrame(bounds)
  }

  // The same place seen over another box of seats, canvas size or bars, held to their limits.
  init(_ camera: GraphCamera, over bounds: Rect, in viewport: Viewport, under insets: Insets) {
    self.viewport = viewport
    self.insets = insets
    self.bounds = bounds
    frame = camera.frame
    hold()
  }

  // The camera's own facts as the layout's framing reads them, at the phone's working zoom.
  var framing: GraphCanvas {
    GraphCanvas(viewport: viewport, insets: insets, workingZoom: Theme.phoneWorkingZoom, fitBounds: bounds)
  }

  // One finger's drag: the picture follows it.
  mutating func pan(by translation: CGSize) {
    frame.x -= translation.width / frame.zoom
    frame.y -= translation.height / frame.zoom
    hold()
  }

  // A pinch: the world point under `point` stays under it while the zoom changes.
  mutating func zoom(by factor: Double, about point: CGPoint) {
    let pinned = world(point)
    frame.zoom = min(Self.pinchCeiling, max(framing.minZoom, frame.zoom * factor))
    frame.x = pinned.x - (point.x - viewport.width / 2) / frame.zoom
    frame.y = pinned.y - (point.y - viewport.height / 2) / frame.zoom
    hold()
  }

  // The zoom stays between the layout's floor and the pinch ceiling, and the world point at the centre of what the
  // bars leave stays inside the roadmap's box.
  private mutating func hold() {
    frame.zoom = min(Self.pinchCeiling, max(framing.minZoom, frame.zoom))
    let (right, down) = ((insets.right - insets.left) / (2 * frame.zoom), (insets.bottom - insets.top) / (2 * frame.zoom))
    frame.x = min(bounds.maxX, max(bounds.minX, frame.x - right)) + right
    frame.y = min(bounds.maxY, max(bounds.minY, frame.y - down)) + down
  }

  func screen(_ x: Double, _ y: Double) -> CGPoint {
    CGPoint(x: (x - frame.x) * frame.zoom + viewport.width / 2, y: (y - frame.y) * frame.zoom + viewport.height / 2)
  }

  func world(_ point: CGPoint) -> Point {
    Point(x: frame.x + (point.x - viewport.width / 2) / frame.zoom, y: frame.y + (point.y - viewport.height / 2) / frame.zoom)
  }

  // The world rectangle the canvas shows, grown by `margin` points on each side.
  func holds(margin: Double = 0) -> Rect {
    let (halfWidth, halfHeight) = ((viewport.width / 2 + margin) / frame.zoom, (viewport.height / 2 + margin) / frame.zoom)
    return Rect(minX: frame.x - halfWidth, maxX: frame.x + halfWidth, minY: frame.y - halfHeight, maxY: frame.y + halfHeight)
  }

  // A step's body across, in points: the layout's body at this zoom, a crowned root's wider, and never under the floor
  // the layout keeps for each.
  func body(crowned: Bool) -> Double {
    max(Theme.bodyWU * (crowned ? Theme.rootBodyScale : 1) * frame.zoom, crowned ? Theme.minRootBodyPx : Theme.minBodyPx)
  }
}
