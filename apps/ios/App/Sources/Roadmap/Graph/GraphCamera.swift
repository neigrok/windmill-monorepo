import SwiftUI
import RoadmapLayout

// The Graph's camera (Roadmap · iOS 04.1, 04.3 to 04.5; the web's `Camera2D`): the world point at the centre of the
// canvas and the zoom, over a canvas that runs under the room's bars. It opens where the layout frames the roadmap and
// stays inside what that framing gives: no zoom under the layout's floor, none over the web's pinch ceiling, and the
// roadmap's box never out of what the bars leave.
nonisolated struct GraphCamera: Equatable {
  // A pinch under way: the camera it began from, and the point of the canvas it zooms about.
  struct Pinched: Equatable {
    let from: GraphCamera
    let about: CGPoint
  }

  // The camera's glide from one place to another, in the web's three lengths and its easing (`Camera2D.glideTo`). It
  // zooms about the one point of the canvas at which both ends show the same place, so every step moves along a
  // straight line and the glide is a pinch about that point; two ends at one zoom are a pan.
  struct Glide {
    static let ease = UnitCurve.bezier(startControlPoint: UnitPoint(x: 0.16, y: 1), endControlPoint: UnitPoint(x: 0.3, y: 1))

    let from: GraphCamera
    let to: GraphCamera
    // 0.48 s where the camera's centre travels half the shorter side of what the bars leave or less, 0.72 s where it
    // travels that side or more, and 0.6 s between.
    let seconds: Double
    // The pinch the glide is; none where it is a pan.
    let pinched: Pinched?

    init(from: GraphCamera, to: GraphCamera) {
      self.from = from
      self.to = to
      let side = min(from.viewport.width - from.insets.left - from.insets.right, from.viewport.height - from.insets.top - from.insets.bottom) / from.frame.zoom
      let travel = hypot(to.frame.x - from.frame.x, to.frame.y - from.frame.y)
      seconds = travel <= side / 2 ? 0.48 : travel >= side ? 0.72 : 0.6
      let (near, far) = (from.frame.zoom, to.frame.zoom)
      guard abs(far / near - 1) > 1e-6 else {
        pinched = nil
        return
      }
      pinched = Pinched(from: from, about: from.screen((from.frame.x * near - to.frame.x * far) / (near - far),
                                                       (from.frame.y * near - to.frame.y * far) / (near - far)))
    }

    // Where the glide has the camera so many seconds after it began: at its end from `seconds` on.
    func camera(after elapsed: Double) -> GraphCamera {
      guard elapsed < seconds else { return to }
      let eased = Self.ease.value(at: max(0, elapsed) / seconds)
      var camera = from
      if let pinched {
        camera.zoom(by: pow(to.frame.zoom / from.frame.zoom, eased), about: pinched.about)
      } else {
        camera.pan(by: CGSize(width: (from.frame.x - to.frame.x) * from.frame.zoom * eased, height: (from.frame.y - to.frame.y) * from.frame.zoom * eased))
      }
      return camera
    }
  }

  // The web's pinch ceiling (`Camera2D.PINCH_MAX_ZOOM`).
  static let pinchCeiling = 2.5

  private(set) var frame = Frame(x: 0, y: 0, zoom: 1)
  // Where the last move left the camera, which `frame` is held from: a camera over another canvas or other bars holds
  // this place anew and keeps it, so bars that come and go leave the picture where it was.
  private(set) var left = Frame(x: 0, y: 0, zoom: 1)
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
    left = frame
  }

  // The place `camera` was left at, seen over another box of seats, canvas size or bars and held to their limits.
  init(_ camera: GraphCamera, over bounds: Rect, in viewport: Viewport, under insets: Insets) {
    self.viewport = viewport
    self.insets = insets
    self.bounds = bounds
    (frame, left) = (camera.left, camera.left)
    hold()
  }

  // This camera brought to a seat (the web's `glideTo`): the seat at the centre of what the bars leave, no farther out
  // than the phone's working zoom, where a disc and its caption read.
  func centred(on seat: Point) -> GraphCamera {
    var camera = self
    camera.frame.zoom = max(frame.zoom, Theme.phoneWorkingZoom)
    camera.frame.x = seat.x + (insets.right - insets.left) / (2 * camera.frame.zoom)
    camera.frame.y = seat.y + (insets.bottom - insets.top) / (2 * camera.frame.zoom)
    camera.left = camera.frame
    return camera
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
    left = frame
  }

  // A pinch: the world point under `point` stays under it while the zoom changes.
  mutating func zoom(by factor: Double, about point: CGPoint) {
    let pinned = world(point)
    frame.zoom = min(Self.pinchCeiling, max(framing.minZoom, frame.zoom * factor))
    frame.x = pinned.x - (point.x - viewport.width / 2) / frame.zoom
    frame.y = pinned.y - (point.y - viewport.height / 2) / frame.zoom
    hold()
    left = frame
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

  // The transform that carries what the canvas drew under `drawn` to where this camera sees it.
  func carries(from drawn: GraphCamera) -> CGAffineTransform {
    let scale = frame.zoom / drawn.frame.zoom
    return CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: viewport.width / 2 * (1 - scale) + (drawn.frame.x - frame.x) * frame.zoom,
                             ty: viewport.height / 2 * (1 - scale) + (drawn.frame.y - frame.y) * frame.zoom)
  }

  // A step's body across, in points: the layout's body at this zoom, a crowned root's wider, and never under the floor
  // the layout keeps for each.
  func body(crowned: Bool) -> Double {
    max(Theme.bodyWU * (crowned ? Theme.rootBodyScale : 1) * frame.zoom, crowned ? Theme.minRootBodyPx : Theme.minBodyPx)
  }
}
