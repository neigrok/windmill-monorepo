import SwiftUI
import RoadmapLayout

// One frame of the Graph (Roadmap · iOS 04.1, 04.2, 04.4 and the kit's Graph node): the picture's connectors, discs
// and captions as the camera holds them. Every seat, bow and caption box is the layout's; the forms are the kit's,
// each a share of the body the layout gives a step, so discs, rings and connectors grow with the zoom together. It
// draws only what the camera holds: a connector whose curve's box and a disc whose reach miss the canvas are left out,
// and each form is one path a colour, filled once. Two frames are equal when they draw the same.
nonisolated struct GraphDrawing: Equatable {
  // The kit's node is 42 pt across at the phone's working zoom, the layout's body there: a Done disc fills it, an Up
  // next disc is 38 inside a 54 halo, a Locked disc is its 38 fill inside a ring to 42, the dot is 12, and the
  // selection ring is 2.5 wide around 52.
  static let inner = 38.0 / 42
  static let halo = 54.0 / 42
  static let dot = 12.0 / 42
  static let ringInside = 52.0 / 42
  static let ringStroke = 2.5 / 42
  // The selection ring is drawn at any zoom: never thinner than this, nor closer to its disc.
  static let thinnestRing = 1.5
  static let nearestRing = 3.0
  // A connector is 2 pt wide at the phone's working zoom. One thinner than a fifth of a point is not drawn: at that
  // width the web's ribbon leaves no pixel either.
  static let connector = 2.0
  static let thinnestConnector = 0.2
  static let captionFont = Font.system(size: GraphPicture.captionSize, weight: .semibold)

  let picture: GraphPicture
  // The camera the picture is drawn under: the one a person moves, or the stop a held pinch keeps.
  let camera: GraphCamera
  let captions: [Caption]
  // The selected step, by its place.
  let selected: Int?
  // Each disc drawn as one square of its colour, in place of the kit's forms.
  let squared: Bool
  // The canvas composited through the system's `drawingGroup`.
  let layered: Bool

  // The frame `pinch` has the canvas draw at `camera`: the picture as it is at rest, unless a pinch is under way with
  // more than `crowd` steps in view. Then `held` draws the nearest of the pinch's stops, without captions, since the
  // layout seats them for the camera a person moves; `coarse` squares the discs; and `layered` composites the canvas.
  init(picture: GraphPicture, camera: GraphCamera, captions: [Caption], selected: Int?, pinched: GraphCamera.Pinched? = nil,
       by pinch: GraphPinch = .live, crowd: Int = GraphPinch.crowd) {
    self.picture = picture
    self.selected = selected
    let way: GraphPinch = pinched != nil && pinch != .live && picture.steps(in: camera.holds()) > crowd ? pinch : .live
    (squared, layered) = (way == .coarse, way == .layered)
    guard way == .held, let pinched else {
      (self.camera, self.captions) = (camera, captions)
      return
    }
    var stop = pinched.from
    stop.zoom(by: pow(GraphPinch.reach, (log(camera.frame.zoom / pinched.from.frame.zoom) / log(GraphPinch.reach)).rounded()), about: pinched.about)
    (self.camera, self.captions) = (stop, [])
  }

  // A picture is what its steps make it, and a caption what it says and where.
  static func == (one: GraphDrawing, other: GraphDrawing) -> Bool {
    one.camera == other.camera && one.selected == other.selected && one.squared == other.squared && one.layered == other.layered
      && one.picture.steps == other.picture.steps
      && one.captions.elementsEqual(other.captions) { (a: Caption, b: Caption) -> Bool in
        a.id == b.id && a.left == b.left && a.top == b.top && a.width == b.width && a.shown == b.shown && a.lines == b.lines
      }
  }

  func draw(in context: inout GraphicsContext) {
    let nodes = picture.model.nodes
    let stroke = Self.connector * camera.frame.zoom / Theme.phoneWorkingZoom
    if stroke >= Self.thinnestConnector {
      let held = camera.holds(margin: stroke)
      var (lit, unlit) = (Path(), Path())
      for bow in picture.bows where bow.box.maxX >= held.minX && bow.box.minX <= held.maxX && bow.box.maxY >= held.minY && bow.box.minY <= held.maxY {
        let (from, to, control) = (camera.screen(nodes[bow.from].x, nodes[bow.from].y), camera.screen(nodes[bow.to].x, nodes[bow.to].y),
                                   camera.screen(bow.control.x, bow.control.y))
        if bow.lit {
          lit.move(to: from)
          lit.addQuadCurve(to: to, control: control)
        } else {
          unlit.move(to: from)
          unlit.addQuadCurve(to: to, control: control)
        }
      }
      context.stroke(unlit, with: .color(RoadmapPalette.connector), style: StrokeStyle(lineWidth: stroke, lineCap: .round))
      context.stroke(lit, with: .color(RoadmapPalette.connectorLit), style: StrokeStyle(lineWidth: stroke, lineCap: .round))
    }

    // The farthest any part of a step is drawn from its seat: a crowned root's selection ring.
    let reach = max(camera.body(crowned: true) * (Self.ringInside / 2 + Self.ringStroke), camera.body(crowned: true) / 2 + Self.nearestRing + Self.thinnestRing)
    let held = camera.holds(margin: reach)
    let blank = [Path](repeating: Path(), count: picture.hues.count)
    var (halos, dots, done, upNext, lockedRings, lockedFills, lockedDots) = (Path(), Path(), blank, blank, blank, blank, blank)
    for (place, node) in nodes.enumerated() where node.x >= held.minX && node.x <= held.maxX && node.y >= held.minY && node.y <= held.maxY {
      let (centre, body, hue) = (camera.screen(node.x, node.y), camera.body(crowned: node.crowned), picture.hueOf[place])
      let disc = { (across: Double) -> CGRect in CGRect(x: centre.x - across / 2, y: centre.y - across / 2, width: across, height: across) }
      // A squared step is one square as wide as its body: a Locked one in its kind's locked fill, any other in its kind's colour.
      if squared {
        if node.tier == .locked { lockedFills[hue].addRect(disc(body)) } else { done[hue].addRect(disc(body)) }
        continue
      }
      switch node.tier {
      case .complete:
        done[hue].addEllipse(in: disc(body))
        dots.addEllipse(in: disc(body * Self.dot))
      case .available:
        if place != selected { halos.addEllipse(in: disc(body * Self.halo)) }
        upNext[hue].addEllipse(in: disc(body * Self.inner))
        dots.addEllipse(in: disc(body * Self.dot))
      case .locked:
        lockedRings[hue].addEllipse(in: disc(body))
        lockedFills[hue].addEllipse(in: disc(body * Self.inner))
        lockedDots[hue].addEllipse(in: disc(body * Self.dot))
      }
    }
    context.fill(halos, with: .color(RoadmapPalette.accentSoft))
    for (hue, name) in picture.hues.enumerated() {
      let locked = RoadmapPalette.locked(name)
      context.fill(lockedRings[hue], with: .color(locked.ring))
      context.fill(lockedFills[hue], with: .color(locked.fill))
      context.fill(lockedDots[hue], with: .color(locked.glyph))
      context.fill(upNext[hue], with: .color(RoadmapPalette.kind(name)))
      context.fill(done[hue], with: .color(RoadmapPalette.kind(name)))
    }
    context.fill(dots, with: .color(RoadmapPalette.canvas))

    if let selected {
      let (node, body) = (nodes[selected], camera.body(crowned: nodes[selected].crowned))
      let (width, inside) = (max(body * Self.ringStroke, Self.thinnestRing), max(body * Self.ringInside, body + Self.nearestRing * 2))
      let (centre, across) = (camera.screen(node.x, node.y), inside + width)
      context.stroke(Path(ellipseIn: CGRect(x: centre.x - across / 2, y: centre.y - across / 2, width: across, height: across)),
                     with: .color(RoadmapPalette.ink), lineWidth: width)
    }

    // A caption is drawn in the box the layout gave it, a line to each 20 pt, once it is past its wait.
    for caption in captions where caption.shown {
      guard let place = picture.placeOf[caption.id] else { continue }
      let ink = nodes[place].tier == .locked ? RoadmapPalette.inkDim : RoadmapPalette.ink
      for (line, text) in caption.lines.enumerated() {
        context.draw(Text(verbatim: text).font(Self.captionFont).foregroundStyle(ink),
                     at: CGPoint(x: caption.left + caption.width / 2, y: caption.top + (Double(line) + 0.5) * Theme.Caption.linePx))
      }
    }
  }
}
