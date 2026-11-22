import Foundation
import Observation
import QuartzCore
import UIKit
import RoadmapDomain
import RoadmapLayout
import SyncEngine

// The Graph of the open roadmap (Roadmap · iOS 04.1 to 04.5): its picture, laid out off the main actor as the phone's
// copy reads; the camera a person moves, which also glides to a step and to the whole roadmap; and the captions the
// layout names at that camera. The canvas draws what this holds and decides nothing. It also holds the Graph to §5's
// budget: the first frame after the tap that showed it and the frames a gesture or a glide is given are measured, and
// a miss is reported once a launch.
@Observable @MainActor
final class RoadmapGraph {
  // What the Graph measures of itself against §5's budget, in milliseconds, each on a roadmap of this many steps.
  enum Measure: Equatable, Sendable {
    // From the tap that made the Graph the room's view to the first frame that draws its picture, and the layout's
    // share of it.
    case firstFrame(ms: Double, layoutMs: Double, steps: Int)
    // The gaps between the frames the main actor was given while a gesture or a glide moved the camera, how long it
    // worked between each two of them, and the zoom the camera was left at.
    case frames(gapsMs: [Double], workMs: [Double], zoom: Double, steps: Int)
  }

  typealias Wait = @Sendable (Duration) async throws -> Void

  // §5's budget is measured at this many steps; a larger roadmap that misses it reports nothing.
  static let budgetSteps = 5_000
  static let firstFrameBudgetMs = 1_000.0
  // A frame is late once its gap passes one and a half frames at 60 a second. A gesture of half a second or more
  // misses the budget when more than a tenth of its frames were late.
  static let lateFrameMs = 1_500.0 / 60
  static let judgedFrames = 30

  let telemetry: any Telemetry
  // The layout that seats a roadmap; one it refuses is seated by the fallback.
  let layout: any LayoutEngine
  // The seconds since some fixed moment, and how the Graph waits out a caption's time.
  let now: () -> TimeInterval
  let wait: Wait
  // Where a measure goes beside the budget's own report: the benchmark's file, on a simulator launch that names one.
  let measured: ((Measure) -> Void)?
  // How the canvas keeps a pinch's frames, and the count of steps in view past which it does.
  let pinch: GraphPinch
  let crowd: Int
  // Whether the camera goes to a place at once, with no glide: the system's Reduce Motion.
  let reducesMotion: () -> Bool
  // The roadmap's picture as last laid out; none until the first layout ends, or where the steps cannot be seated.
  private(set) var picture: GraphPicture?
  private(set) var unseated = false
  // None until both the picture and the canvas's size are known.
  private(set) var camera: GraphCamera?
  private(set) var captions: [Caption] = []
  // The pinch under way, from its first report to the fingers' leaving or the first drag after it; and the pinch a
  // glide is, while it moves the camera.
  private(set) var pinched: GraphCamera.Pinched?
  // Fit stands (04.5): the room shows the whole roadmap and nothing else, and the camera frames it anew whenever the
  // canvas or what covers it changes.
  private(set) var fitted = false
  // The roadmap this Graph shows, and its latest read still waiting for the layout.
  @ObservationIgnored var roadmap: String?
  @ObservationIgnored var awaiting: FollowGraph?
  @ObservationIgnored var laying = false
  @ObservationIgnored var laidInMs = 0.0
  @ObservationIgnored var viewport: Viewport?
  @ObservationIgnored var insets = Insets()
  @ObservationIgnored var placer = CaptionPlacer()
  // The pass that places the captions again once the next of them is due to appear or to go.
  @ObservationIgnored var naming: Task<Void, Never>?
  @ObservationIgnored var opening: TimeInterval?
  // The glide under way, and the moment it began.
  @ObservationIgnored var glide: (course: GraphCamera.Glide, began: TimeInterval)?
  @ObservationIgnored let frames = GraphFrames()
  @ObservationIgnored var reported: Set<String> = []

  init(telemetry: any Telemetry = NoopTelemetry(), layout: any LayoutEngine = BubbleLayoutEngine(),
       now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
       wait: @escaping Wait = { try await Task.sleep(for: $0) }, measured: ((Measure) -> Void)? = nil, pinch: GraphPinch = .room,
       crowd: Int = GraphPinch.crowd, reducesMotion: @escaping () -> Bool = { UIAccessibility.isReduceMotionEnabled }) {
    self.telemetry = telemetry; self.layout = layout; self.now = now; self.wait = wait; self.measured = measured
    self.pinch = pinch; self.crowd = crowd; self.reducesMotion = reducesMotion
    frames.each = { [weak self] in self?.glided() }
  }

  // A tap made the Graph what the room shows: the time to its first frame runs from here.
  func opened() {
    opening = now()
  }

  // The canvas left the screen: a first frame still to come is not that tap's, no gesture or glide is under way, and
  // Fit, which only a tap on the canvas ends, stands no longer.
  func closed() {
    opening = nil
    (glide, pinched, fitted) = (nil, nil, false)
    _ = frames.end()
  }

  // The Graph shows this roadmap as the phone's copy now reads it. One layout runs at a time, off the main actor; a
  // read that arrives meanwhile waits, and only the latest is laid out next. Another roadmap starts from nothing.
  func follow(_ read: FollowGraph, of roadmap: String) {
    if self.roadmap.map({ !$0.utf8.elementsEqual(roadmap.utf8) }) ?? true {
      self.roadmap = roadmap
      (picture, unseated, camera, captions, placer) = (nil, false, nil, [], CaptionPlacer())
      (glide, pinched, fitted) = (nil, nil, false)
      placer.setInsets(insets, blocks: [])
      naming?.cancel()
    }
    awaiting = read
    if !laying { lay() }
  }

  // Lays out the read that waits. A picture that reads as the one drawn stands; a roadmap whose steps cannot be seated
  // shows none and is reported, and one the fallback seated is drawn and reported, each once a launch.
  func lay() {
    guard let read = awaiting, let roadmap else { return }
    awaiting = nil
    laying = true
    let (drawn, layout, started) = (picture, layout, now())
    Task {
      let laid = await Task.detached(priority: .userInitiated) { () -> Result<GraphPicture?, any Error> in
        let steps = GraphPicture.Steps(of: read)
        if let drawn, drawn.steps == steps { return .success(nil) }
        do { return .success(try await GraphPicture(steps, after: drawn, by: layout)) } catch { return .failure(error) }
      }.value
      laying = false
      if self.roadmap.map({ $0.utf8.elementsEqual(roadmap.utf8) }) ?? false {
        switch laid {
        case .success(nil): break
        case .success(let picture?):
          laidInMs = (now() - started) * 1_000
          (self.picture, unseated) = (picture, false)
          placer.setModel(picture.model, picture.grid)
          placer.setMetrics(picture.metrics)
          if picture.engine == .radial, reported.insert("fallback").inserted { telemetry.failure("roadmap_layout", kind: "fallback") }
          frame()
        case .failure:
          (picture, unseated, camera, captions) = (nil, true, nil, [])
          (glide, pinched, fitted) = (nil, nil, false)
          if reported.insert("unseated").inserted { telemetry.failure("roadmap_layout", kind: "unseated") }
        }
      }
      lay()
    }
  }

  // The canvas's size and the points the room's bars cover on each side of it.
  func resize(_ viewport: Viewport, under insets: Insets) {
    guard viewport != self.viewport || insets != self.insets else { return }
    (self.viewport, self.insets) = (viewport, insets)
    placer.setInsets(insets, blocks: [])
    frame()
  }

  // The camera over the picture and the canvas as they now are: where the layout frames the roadmap the first time,
  // and afterwards where the person left it, held to what the new picture and canvas allow. While Fit stands it goes
  // to the whole roadmap as the layout now frames it, and a glide under way goes on to where it was going.
  func frame() {
    guard let picture, let viewport else { return }
    let whole = GraphCamera(framing: picture.model.bounds, in: viewport, under: insets)
    let bound = fitted ? whole : glide.map { GraphCamera($0.course.to, over: picture.model.bounds, in: viewport, under: insets) }
    camera = camera.map { GraphCamera($0, over: picture.model.bounds, in: viewport, under: insets) } ?? whole
    move(to: bound ?? camera)
  }

  // The camera goes to a place: by a glide the display's link moves each frame, or at once under Reduce Motion and
  // where it stands there already.
  func move(to place: GraphCamera?) {
    guard let place, let camera else { return }
    guard !reducesMotion(), place != camera else {
      self.camera = place
      name()
      if glide != nil { rest() }
      return
    }
    let course = GraphCamera.Glide(from: camera, to: place)
    (glide, pinched) = ((course, now()), course.pinched)
    frames.begin()
  }

  // One frame of the glide under way: the camera where the glide has it by now, and at its end the glide's frames
  // measured as a gesture's are.
  func glided() {
    guard let glide else { return }
    let elapsed = now() - glide.began
    camera = glide.course.camera(after: elapsed)
    name()
    if elapsed >= glide.course.seconds { rest() }
  }

  // A step brought into view (04.3): its seat at the centre of what the bars leave, at a zoom where it reads.
  func bring(_ step: String) {
    guard let picture, let place = picture.placeOf[UTF16Text(step)] else { return }
    move(to: camera?.centred(on: Point(x: picture.model.nodes[place].x, y: picture.model.nodes[place].y)))
  }

  // Fit (04.5): the whole roadmap as the layout frames it, kept so while Fit stands.
  func fit() {
    guard let picture, let viewport else { return }
    fitted = true
    move(to: GraphCamera(framing: picture.model.bounds, in: viewport, under: insets))
  }

  // Fit ends, and the camera stays where it left it.
  func unfit() {
    fitted = false
  }

  // The captions the layout names at the camera now, and again once the next of them is due to appear or to go.
  func name() {
    guard let camera else { return }
    let clock = now() * 1_000
    let placed = placer.place(camera: camera.frame, viewport: camera.viewport, now: clock)
    captions = placed.captions
    naming?.cancel()
    naming = placed.nextDeadline.map { (due: Double) -> Task<Void, Never> in
      Task { [weak self, wait] in
        guard (try? await wait(.microseconds(Int64(max(0, due - clock) * 1_000) + 1_000))) != nil, !Task.isCancelled else { return }
        self?.name()
      }
    }
  }

  // The selected step leads the captions, and its trunk parent and children follow it.
  func attend(to step: String?) {
    placer.setContext(selected: step.map { UTF16Text($0) }, hovered: nil)
    name()
  }

  // One finger's drag, which no pinch is under way with and which ends a glide where it has come to.
  func pan(by translation: CGSize) {
    frames.begin()
    (glide, pinched) = (nil, nil)
    camera?.pan(by: translation)
    name()
  }

  // A pinch about the point it began at, which ends a glide where it has come to.
  func zoom(by factor: Double, about point: CGPoint) {
    frames.begin()
    if glide != nil { (glide, pinched) = (nil, nil) }
    pinched = pinched ?? camera.map { GraphCamera.Pinched(from: $0, about: point) }
    camera?.zoom(by: factor, about: point)
    name()
  }

  // The fingers left, or a glide ended: the frames the camera's move was given are measured against the budget.
  func rest() {
    (glide, pinched) = (nil, nil)
    let (gaps, work) = frames.end()
    guard let steps = picture?.steps.done.count, let camera, !gaps.isEmpty else { return }
    measured?(.frames(gapsMs: gaps, workMs: work, zoom: camera.frame.zoom, steps: steps))
    guard steps <= Self.budgetSteps, Self.misses(gaps), reported.insert("frames").inserted else { return }
    telemetry.failure("roadmap_canvas", kind: "budget", properties: ["budget": "frames", "steps": Self.bucket(steps)])
  }

  // The canvas drew the picture: the first frame since the tap that showed the Graph is measured against the budget.
  func drew() {
    guard let opening, let steps = picture?.steps.done.count else { return }
    self.opening = nil
    let took = (now() - opening) * 1_000
    measured?(.firstFrame(ms: took, layoutMs: laidInMs, steps: steps))
    guard steps <= Self.budgetSteps, took > Self.firstFrameBudgetMs, reported.insert("first_frame").inserted else { return }
    telemetry.failure("roadmap_canvas", kind: "budget", properties: ["budget": "first_frame", "steps": Self.bucket(steps)])
  }

  // The step a tap at `point` takes: the nearest one whose disc holds the point, or whose 44 pt target does where the
  // disc is drawn smaller.
  func step(at point: CGPoint) -> String? {
    guard let picture, let camera else { return nil }
    var nearest: (place: Int, distance: CGFloat)?
    for (place, node) in picture.model.nodes.enumerated() {
      let seat = camera.screen(node.x, node.y)
      let distance = hypot(seat.x - point.x, seat.y - point.y)
      guard distance <= max(camera.body(crowned: node.crowned), RoomSpace.minimumTarget) / 2, distance < nearest?.distance ?? .infinity else { continue }
      nearest = (place, distance)
    }
    return nearest.map { picture.steps.seated[$0.place].id.text }
  }

  // Whether a gesture's frames miss the budget: one long enough to judge, with more than a tenth of its frames late.
  static func misses(_ gapsMs: [Double]) -> Bool {
    gapsMs.count >= judgedFrames && gapsMs.count { $0 > lateFrameMs } * 10 > gapsMs.count
  }

  // A roadmap's size as a report carries it.
  static func bucket(_ steps: Int) -> String {
    if steps <= 100 { return "1-100" }
    if steps <= 1_000 { return "101-1000" }
    return "1001-5000"
  }
}

// The frames the main actor was given while a gesture or a glide moved the camera, as the display's own link saw them:
// a frame the canvas held the main actor through arrives late, and its gap says by how much. Beside each gap stands how
// long the main actor worked in it, from its run loop waking to its resting again, its commit to the screen included:
// what a frame cost, which a gap on time does not say. Each frame it tells whoever moves the camera by the clock.
@MainActor
final class GraphFrames: NSObject {
  var each: (() -> Void)?
  var link: CADisplayLink?
  var watching: [CFRunLoopObserver] = []
  var stamps: [CFTimeInterval] = []
  var work: [Double] = []
  var woke: CFTimeInterval?
  var worked = 0.0

  // A gesture's first move starts the link; its later moves find it running.
  func begin() {
    guard link == nil else { return }
    (stamps, work, worked, woke) = ([], [], 0, CACurrentMediaTime())
    link = CADisplayLink(target: self, selector: #selector(tick))
    link?.add(to: .main, forMode: .common)
    // The run loop is seen waking before anything else is, and resting after everything else has, the commit too.
    let waking = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue, true, .min) { [weak self] _, _ in
      MainActor.assumeIsolated { self?.woke = CACurrentMediaTime() }
    }
    let resting = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, .max) { [weak self] _, _ in
      MainActor.assumeIsolated {
        guard let self, let woke = self.woke else { return }
        (self.worked, self.woke) = (self.worked + (CACurrentMediaTime() - woke) * 1_000, nil)
      }
    }
    watching = [waking, resting].compactMap { $0 }
    for observer in watching { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
  }

  @objc func tick(_ link: CADisplayLink) {
    stamps.append(link.timestamp)
    work.append(worked)
    worked = 0
    each?()
  }

  // The gaps between the frames since `begin` and the main actor's work in each, in milliseconds; none where no
  // gesture ran.
  func end() -> (gaps: [Double], work: [Double]) {
    link?.invalidate()
    link = nil
    for observer in watching { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
    watching = []
    return (zip(stamps.dropFirst(), stamps).map { ($0 - $1) * 1_000 }, Array(work.dropFirst()))
  }
}
