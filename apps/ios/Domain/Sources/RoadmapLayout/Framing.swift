// Where a camera sits to show a roadmap or one step of it, the web's `scene/framing.js`: the fit, the floor no zoom
// passes and the centre the chrome leaves.

private let maxZoom: Double = 6
// The zoom floor sits this far below the whole roadmap's fit: a pinch can back off from the fit, never lose the roadmap.
private let floorBelowFit = 0.5
private let minZoomWithoutModel = 0.006
private let fitPadding = 0.9
// The air a focused step's family keeps inside the frame.
private let familyFramePad = Theme.nodeSize * 2

public struct Viewport: Sendable, Equatable {
  public var width: Double
  public var height: Double

  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
  }
}

// The px the chrome covers on each side of a viewport.
public struct Insets: Sendable, Equatable {
  public var top: Double
  public var right: Double
  public var bottom: Double
  public var left: Double

  public init(top: Double = 0, right: Double = 0, bottom: Double = 0, left: Double = 0) {
    self.top = top
    self.right = right
    self.bottom = bottom
    self.left = left
  }
}

// A camera: the world point at the centre of the viewport, and the zoom.
public struct Frame: Sendable, Equatable {
  public var x: Double
  public var y: Double
  public var zoom: Double

  public init(x: Double, y: Double, zoom: Double) {
    self.x = x
    self.y = y
    self.zoom = zoom
  }
}

// A camera's own facts: its viewport, the chrome over it, its working zoom and the bounds its floor is measured from.
public struct GraphCanvas: Sendable {
  public var viewport: Viewport
  public var insets: Insets
  public var workingZoom: Double
  public var fitBounds: Rect?

  public init(viewport: Viewport, insets: Insets, workingZoom: Double, fitBounds: Rect?) {
    self.viewport = viewport
    self.insets = insets
    self.workingZoom = workingZoom
    self.fitBounds = fitBounds
  }

  // The zoom that shows all of `bounds` inside the visible area, uncapped.
  func fitZoomFor(_ bounds: Rect, _ padding: Double) -> Double {
    let boundsWidth = Math.max(bounds.maxX - bounds.minX, 1)
    let boundsHeight = Math.max(bounds.maxY - bounds.minY, 1)
    let visibleWidth = Math.max(1, viewport.width - insets.left - insets.right)
    let visibleHeight = Math.max(1, viewport.height - insets.top - insets.bottom)
    return Math.min(visibleWidth / boundsWidth, visibleHeight / boundsHeight) * padding
  }

  // The lowest zoom.
  public var minZoom: Double {
    guard let fitBounds else { return minZoomWithoutModel }
    return Math.min(fitZoomFor(fitBounds, fitPadding), workingZoom) * floorBelowFit
  }

  func clampZoom(_ zoom: Double, _ ceiling: Double) -> Double {
    Math.min(ceiling, Math.max(minZoom, zoom))
  }

  // The world-space size of the area the chrome leaves visible, at `zoom`.
  func visibleSpanAt(_ zoom: Double) -> (width: Double, height: Double) {
    (
      Math.max(1, viewport.width - insets.left - insets.right) / zoom,
      Math.max(1, viewport.height - insets.top - insets.bottom) / zoom
    )
  }

  // Where the camera must sit for a world point to land at the centre of the visible area at `zoom`.
  func centreFor(_ x: Double, _ y: Double, _ zoom: Double) -> Point {
    Point(x: x + (insets.right - insets.left) / (2 * zoom), y: y + (insets.bottom - insets.top) / (2 * zoom))
  }

  // The camera that shows all of `bounds` inside the visible area; the working zoom keeps a tiny roadmap from filling it.
  public func fitFrame(_ bounds: Rect) -> Frame {
    let zoom = clampZoom(fitZoomFor(bounds, fitPadding), workingZoom)
    let centre = centreFor((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, zoom)
    return Frame(x: centre.x, y: centre.y, zoom: zoom)
  }

  // What a focus frames: the box holding the step, its trunk parent and its trunk children when that box fits the
  // visible area at `zoom`, so a step at the edge of its family never opens on half a screen of empty canvas; else the step.
  func familyCentre(_ model: RenderModel, _ node: Int, _ zoom: Double) -> Point {
    let seat = model.nodes[node]
    var minX = seat.x
    var maxX = seat.x
    var minY = seat.y
    var maxY = seat.y
    for link in model.links where link.kind == .trunk && (link.to == node || link.from == node) {
      let relative = model.nodes[link.to == node ? link.from : link.to]
      minX = Math.min(minX, relative.x)
      maxX = Math.max(maxX, relative.x)
      minY = Math.min(minY, relative.y)
      maxY = Math.max(maxY, relative.y)
    }
    let span = visibleSpanAt(zoom)
    if maxX - minX + familyFramePad * 2 > span.width || maxY - minY + familyFramePad * 2 > span.height {
      return Point(x: seat.x, y: seat.y)
    }
    return Point(x: (minX + maxX) / 2, y: (minY + maxY) / 2)
  }

  // The camera that lands on a step: its trunk family at the working zoom, centred in the visible area.
  public func focusFrame(_ model: RenderModel, _ node: Int) -> Frame {
    let target = familyCentre(model, node, workingZoom)
    let centre = centreFor(target.x, target.y, workingZoom)
    return Frame(x: centre.x, y: centre.y, zoom: clampZoom(workingZoom, maxZoom))
  }
}
