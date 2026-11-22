import CoreGraphics
import Testing
import RoadmapLayout
@testable import Windmill

@Suite struct GraphCameraTests {
  // Roadmap · iOS 04.1 and 04.4, on the phone canvas of the layout's fixtures: an iPhone 17 with 158 points of bars
  // over the top and 140 over the foot, and the box around *Learn to sail*'s seats. The opening frame and the zoom
  // floor are `learn-to-sail.json`'s `fit` and `floor`.
  @Test func theCameraOpensWhereTheLayoutFramesTheRoadmapAndStaysInsideItsFraming() {
    let bounds = Rect(minX: -56, maxX: 342.37030535759345, minY: -272.5490019647696, maxY: 242.33549663746913)
    let opening = GraphCamera(framing: bounds, in: Viewport(width: 402, height: 874), under: Insets(top: 158, bottom: 140))
    #expect(opening.frame == Frame(x: 143.18515267879673, y: -25.69075266365024, zoom: 0.8503401360544218))
    #expect(abs(opening.body(crowned: false) - 40) < 1e-9 && abs(opening.body(crowned: true) - 62) < 1e-9)

    // A pinch zooms about its point: the world point under the fingers stays under them.
    let fingers = CGPoint(x: 260, y: 520)
    var pinched = opening
    pinched.zoom(by: 1.5, about: fingers)
    #expect(pinched.frame.zoom == 0.8503401360544218 * 1.5)
    #expect(abs(pinched.world(fingers).x - opening.world(fingers).x) < 1e-9 && abs(pinched.world(fingers).y - opening.world(fingers).y) < 1e-9)

    // No pinch passes the web's ceiling, nor goes under the layout's floor, where a disc keeps its smallest size.
    pinched.zoom(by: 1_000, about: fingers)
    #expect(pinched.frame.zoom == 2.5)
    pinched.zoom(by: 0.000_1, about: fingers)
    #expect(pinched.frame.zoom == 0.4251700680272109)
    var farthest = GraphCamera(framing: Rect(minX: -138_886, maxX: 138_444, minY: -185_136, maxY: 156_437), in: Viewport(width: 402, height: 874),
                               under: Insets(top: 158, bottom: 140))
    farthest.zoom(by: 0.000_1, about: fingers)
    #expect(farthest.body(crowned: false) == 6 && farthest.body(crowned: true) == 9)

    // One finger moves the picture with it, and no drag takes the roadmap's box out of what the bars leave: its
    // corner stops at the centre of that area.
    var panned = opening
    panned.pan(by: CGSize(width: 30, height: -20))
    #expect(abs(panned.screen(0, 0).x - opening.screen(0, 0).x - 30) < 1e-9 && abs(panned.screen(0, 0).y - opening.screen(0, 0).y + 20) < 1e-9)
    panned.pan(by: CGSize(width: 10_000, height: 10_000))
    let middle = panned.world(CGPoint(x: 201, y: 446))
    #expect(abs(middle.x - bounds.minX) < 1e-9 && abs(middle.y - bounds.minY) < 1e-9)

    // The same place over a taller foot: the camera stands where it was.
    let barred = GraphCamera(opening, over: bounds, in: Viewport(width: 402, height: 874), under: Insets(top: 158, bottom: 196))
    #expect(barred.frame == opening.frame)
  }

  // What the canvas drew under one camera is carried to another by one transform: every point of the picture lands
  // where the other camera sees it, and a drawing under the camera itself is left where it is.
  @Test func aDrawingIsCarriedFromTheCameraItWasDrawnUnderToWhereAnotherSeesIt() {
    let drawn = GraphCamera(framing: Rect(minX: -56, maxX: 342.37030535759345, minY: -272.5490019647696, maxY: 242.33549663746913),
                            in: Viewport(width: 402, height: 874), under: Insets(top: 158, bottom: 140))
    var camera = drawn
    camera.zoom(by: 1.3, about: CGPoint(x: 260, y: 520))
    camera.pan(by: CGSize(width: -24, height: 10))
    let carried = camera.carries(from: drawn)
    let apart = [Point(x: 0, y: 0), Point(x: 300, y: -200), Point(x: -50, y: 240)].map { (seat: Point) -> Double in
      let (from, to) = (drawn.screen(seat.x, seat.y).applying(carried), camera.screen(seat.x, seat.y))
      return Double(hypot(from.x - to.x, from.y - to.y))
    }
    #expect(apart.allSatisfy { $0 < 1e-9 })
    #expect(camera.carries(from: camera) == .identity)
  }

  // Roadmap · iOS 04.3: a step is brought to the centre of what the bars leave, no farther out than the phone's
  // working zoom and no nearer than the camera already is. The camera glides there in the web's three lengths, by a
  // pinch about the one point both ends show the same place at, so that point stands still while the zoom runs from
  // one end to the other; between two ends at one zoom the glide is a pan.
  @Test func theCameraGlidesToAStepByAPinchAboutThePointBothEndsShare() throws {
    let bounds = Rect(minX: -56, maxX: 342.37030535759345, minY: -272.5490019647696, maxY: 242.33549663746913)
    let opening = GraphCamera(framing: bounds, in: Viewport(width: 402, height: 874), under: Insets(top: 158, bottom: 140))
    let seat = Point(x: 286, y: 47)
    let middle = CGPoint(x: 201, y: 446)
    var far = opening
    far.zoom(by: 0.001, about: middle)
    var near = opening
    near.zoom(by: 2, about: middle)
    #expect([opening.centred(on: seat).frame.zoom, far.centred(on: seat).frame.zoom, near.centred(on: seat).frame.zoom]
            == [opening.frame.zoom, opening.frame.zoom, near.frame.zoom])
    #expect([opening, far, near].allSatisfy { (camera: GraphCamera) -> Bool in
      let landed = camera.centred(on: seat).screen(seat.x, seat.y)
      return hypot(landed.x - middle.x, landed.y - middle.y) < 1e-9
    })

    // From the floor to the step at the working zoom: a pinch, whose point holds one place of the roadmap throughout.
    let glide = GraphCamera.Glide(from: far, to: far.centred(on: seat))
    let pinched = try #require(glide.pinched)
    let held = far.world(pinched.about)
    let along = [0, 0.05, 0.1, 0.2, 0.4].map { glide.camera(after: $0) }
    #expect(pinched.from == far && glide.camera(after: glide.seconds) == glide.to && glide.camera(after: 9) == glide.to)
    #expect(along.allSatisfy { hypot($0.world(pinched.about).x - held.x, $0.world(pinched.about).y - held.y) < 1e-6 })
    #expect(abs(along[0].frame.zoom - far.frame.zoom) < 1e-12 && along.map(\.frame.zoom) == along.map(\.frame.zoom).sorted()
            && along[4].frame.zoom < glide.to.frame.zoom)
    // The web's easing runs most of the way early: past nine tenths of the zoom's ratio by the glide's midpoint.
    #expect(log(glide.camera(after: glide.seconds / 2).frame.zoom / far.frame.zoom) > 0.9 * log(glide.to.frame.zoom / far.frame.zoom))

    // At one zoom the glide is a pan along the line between its ends, and a glide's length follows how far the
    // camera's centre travels beside the shorter side of what the bars leave.
    var beside = near
    beside.pan(by: CGSize(width: -100, height: 0))
    var away = near
    away.pan(by: CGSize(width: -250, height: 0))
    let pan = GraphCamera.Glide(from: near, to: beside)
    let early = pan.camera(after: 0.1)
    #expect(pan.pinched == nil && pan.camera(after: pan.seconds) == beside)
    #expect(abs(early.frame.y - near.frame.y) < 1e-9 && early.frame.x > near.frame.x && early.frame.x < beside.frame.x && early.frame.zoom == near.frame.zoom)
    var across = opening
    across.zoom(by: 2.9, about: middle)
    #expect([pan.seconds, GraphCamera.Glide(from: near, to: away).seconds, glide.seconds,
             GraphCamera.Glide(from: across, to: across.centred(on: Point(x: -56, y: -272))).seconds] == [0.48, 0.6, 0.48, 0.72])
  }
}
