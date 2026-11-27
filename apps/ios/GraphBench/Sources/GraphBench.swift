import Observation
import QuartzCore
import SwiftUI
import UIKit
import RoadmapLayout
import SyncCore

// The Graph of the layout's 5,000-step handbook on a screen, held as the Roadmap room's `RoadmapGraph` holds a
// roadmap's: the picture made off the main actor, the camera, the captions the layout names at it, and the pinch under
// way. A script moves the camera where the room has fingers, and measures the Graph against its budget (Roadmap on iOS
// §5) on the device it runs on: the picture's making, the first frame, and at each camera the frames a pan and a pinch
// are given. Each measure is one `bench` line on standard output, and the screen shows them all once the run is done.
@Observable @MainActor
final class GraphBench {
  // The script pans in a circle of this radius, in points, and pinches to this many times the camera's zoom and back;
  // each lasts `seconds`, a turn of either `period`.
  static let radius = 60.0
  static let pinch = 2.0
  static let seconds = 3.0
  static let period = 1.5
  // §5's budgets, as `RoadmapGraph` holds them: a second to the first frame, and a frame late once its gap passes one
  // and a half frames at 60 a second. A stretch is also owed nine tenths of its frames at 60 a second: a display link
  // that fires less often hides the frames that would have been late.
  static let firstFrameBudgetMs = 1_000.0
  static let frameMs = 1_000.0 / 60
  static let lateFrameMs = 1_500.0 / 60
  static let owedFrames = Int(seconds * 60)

  enum Stopped: Error {
    case noSteps
    case noSuchPinch
    case theCanvasNeverDrew
  }

  // What the launch asks for: `-steps <count>` takes the first steps of the handbook's order where the whole is 5,000,
  // `-pinch <way>` names how the surface keeps a pinch's frames where the room's own way is the default, `-short YES`
  // runs the first two cameras alone, and `-quits YES` ends the process once the run has said it is done.
  let steps: Int?
  // None where the launch names a way that is none of `GraphPinch`'s.
  let pinch: GraphPinch?
  let short: Bool
  let quits: Bool
  private(set) var picture: GraphPicture?
  private(set) var camera: GraphCamera?
  private(set) var captions: [Caption] = []
  // The script's pinch, while it is under way.
  private(set) var pinched: GraphCamera.Pinched?
  // The run's lines, once it is done.
  private(set) var said: [String]?
  @ObservationIgnored let frames = BenchFrames()
  @ObservationIgnored var viewport: Viewport?
  @ObservationIgnored var insets = Insets()
  @ObservationIgnored var placer = CaptionPlacer()
  // The pass that places the captions again once the next of them is due to appear or to go.
  @ObservationIgnored var naming: Task<Void, Never>?
  @ObservationIgnored var lines: [String] = []
  @ObservationIgnored var tag = "bench graph · "

  init(asked: UserDefaults = .standard) {
    steps = asked.object(forKey: "steps").map { _ in asked.integer(forKey: "steps") }
    pinch = asked.string(forKey: "pinch").map { GraphPinch(rawValue: $0) } ?? .room
    short = asked.bool(forKey: "short")
    quits = asked.bool(forKey: "quits")
  }

  // The canvas's size and the points the screen's own edges cover on each side of it, where the room has its bars.
  func resize(_ viewport: Viewport, under insets: Insets) {
    guard viewport != self.viewport || insets != self.insets else { return }
    (self.viewport, self.insets) = (viewport, insets)
    placer.setInsets(insets, blocks: [])
    frame()
  }

  // The camera over the picture and the canvas as they now are: where the layout frames the roadmap the first time.
  func frame() {
    guard let picture, let viewport else { return }
    camera = camera.map { GraphCamera($0, over: picture.model.bounds, in: viewport, under: insets) }
      ?? GraphCamera(framing: picture.model.bounds, in: viewport, under: insets)
    name()
  }

  // The captions the layout names at the camera now, and again once the next of them is due to appear or to go.
  func name() {
    guard let camera else { return }
    let clock = ProcessInfo.processInfo.systemUptime * 1_000
    let placed = placer.place(camera: camera.frame, viewport: camera.viewport, now: clock)
    captions = placed.captions
    naming?.cancel()
    naming = placed.nextDeadline.map { (due: Double) -> Task<Void, Never> in
      Task { [weak self] in
        guard (try? await Task.sleep(for: .microseconds(Int64(max(0, due - clock) * 1_000) + 1_000))) != nil, !Task.isCancelled else { return }
        self?.name()
      }
    }
  }

  func say(_ line: String) {
    lines.append(tag + line)
    print(tag + line)
  }

  // The whole run: the picture, the first frame, and the cameras in turn.
  func run() async {
    setvbuf(stdout, nil, _IOLBF, 0)
    UIApplication.shared.isIdleTimerDisabled = true
    let thermal = { () -> String in ["nominal", "fair", "serious", "critical"][ProcessInfo.processInfo.thermalState.rawValue] }
    let lowPower = { () -> String in ProcessInfo.processInfo.isLowPowerModeEnabled ? "on" : "off" }
    do {
      // The launch's own work is over before anything is timed.
      _ = await frames.drive { $0 < 1 }
      let handbook = try GraphPicture.Steps(handbook: Data(contentsOf: Bundle.main.bundleURL.appending(path: "handbook.json")), first: steps)
      guard !handbook.seated.isEmpty else { throw Stopped.noSteps }
      guard let pinch else { throw Stopped.noSuchPinch }
      var system = utsname()
      uname(&system)
      let machine = withUnsafeBytes(of: &system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
      let model = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"].map { "simulator \($0)" } ?? machine
      tag = "bench [\(model)] graph · steps=\(handbook.seated.count) pinch=\(pinch.rawValue) · "
      let screen = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first
      say(String(format: "the run: ios=%@ screen=%.0fx%.0f@%.0fx maximum=%dHz lowPower=%@ thermal=%@", UIDevice.current.systemVersion,
                 Double(screen?.bounds.width ?? 0), Double(screen?.bounds.height ?? 0), Double(screen?.scale ?? 0), screen?.maximumFramesPerSecond ?? 0,
                 lowPower(), thermal()))

      // The first frame, as the room times it from the tap that shows the Graph: the picture made off the main actor,
      // then the first draw of it.
      let opened = CACurrentMediaTime()
      let (made, makingMs) = try await Task.detached(priority: .userInitiated) { () -> (GraphPicture, Double) in
        let began = CACurrentMediaTime()
        let picture = try await GraphPicture(handbook)
        return (picture, (CACurrentMediaTime() - began) * 1_000)
      }.value
      picture = made
      placer.setModel(made.model, made.grid)
      placer.setMetrics(made.metrics)
      frame()
      _ = await frames.drive { elapsed in self.frames.first == nil && elapsed < 10 }
      guard let first = frames.first, let opening = camera, let viewport else { throw Stopped.theCanvasNeverDrew }
      let firstMs = (first - opened) * 1_000
      say(String(format: "the picture: made=%.1fms engine=%@", makingMs, made.engine.rawValue))
      say(String(format: "the first frame: ms=%.1f | budget ≤ %.0fms → %@, %.0f%% of it", firstMs, Self.firstFrameBudgetMs,
                 firstMs > Self.firstFrameBudgetMs ? "OVER" : "under", firstMs / Self.firstFrameBudgetMs * 100))
      say(String(format: "the canvas: viewport=%.0fx%.0f insets top=%.0f bottom=%.0f", viewport.width, viewport.height, insets.top, insets.bottom))

      // The whole roadmap as the layout frames it; then the step in the middle of the roadmap's order brought under the
      // centre of the canvas, at three zooms and at the pinch ceiling. A short run stops after the first of those.
      let centre = CGPoint(x: viewport.width / 2, y: viewport.height / 2)
      let seat = made.model.nodes[made.model.nodes.count / 2]
      var over = opening
      let from = over.screen(seat.x, seat.y)
      over.pan(by: CGSize(width: centre.x - from.x, height: centre.y - from.y))
      let closer = [0.011, 0.085, 0.65, GraphCamera.pinchCeiling].map { (zoom: Double) -> (String, GraphCamera) in
        var camera = over
        camera.zoom(by: zoom / camera.frame.zoom, about: centre)
        return (zoom == GraphCamera.pinchCeiling ? "the pinch ceiling" : String(format: "zoom %g", zoom), camera)
      }
      for (name, start) in ([("the whole roadmap", opening)] + closer).prefix(short ? 2 : 5) {
        camera = start
        self.name()
        // The captions' waits pass before the camera moves.
        _ = await frames.drive { $0 < 0.5 }
        let held = start.holds()
        let threaded = GraphDrawing.connector * start.frame.zoom / Theme.phoneWorkingZoom >= GraphDrawing.thinnestConnector
        say(String(format: "%@: zoom=%.5f stepsInView=%d linksInView=%d captions=%d", name, start.frame.zoom, made.steps(in: held),
                   threaded ? made.bows.count { $0.box.maxX >= held.minX && $0.box.minX <= held.maxX && $0.box.maxY >= held.minY && $0.box.minY <= held.maxY } : 0,
                   captions.count { $0.shown }))

        var finger = CGSize.zero
        let panned = await frames.drive { elapsed in
          guard elapsed < Self.seconds else { return false }
          let angle = 2 * Double.pi * elapsed / Self.period
          let at = CGSize(width: Self.radius * (cos(angle) - 1), height: Self.radius * sin(angle))
          self.camera?.pan(by: CGSize(width: at.width - finger.width, height: at.height - finger.height))
          self.name()
          finger = at
          return true
        }
        // The fingers part and come back; at the ceiling they close and part again. The pinch is under way from its
        // first move to its last, as the room's is from a finger's first report to its leaving.
        var spread = 1.0
        let inward = start.frame.zoom * Self.pinch <= GraphCamera.pinchCeiling ? 1.0 : -1.0
        let pinched = await frames.drive { elapsed in
          guard elapsed < Self.seconds else {
            self.pinched = nil
            return false
          }
          let to = pow(Self.pinch, inward * (1 - cos(2 * Double.pi * elapsed / Self.period)) / 2)
          self.pinched = self.pinched ?? self.camera.map { GraphCamera.Pinched(from: $0, about: centre) }
          self.camera?.zoom(by: to / spread, about: centre)
          self.name()
          spread = to
          return true
        }
        for (motion, stretch) in [("pan", panned), ("pinch", pinched)] {
          let (given, late) = (stretch.gapsMs.count, stretch.gapsMs.count { $0 > Self.lateFrameMs })
          say(String(format: "%@ · %@ · frame gaps: frames=%d of %d p50=%.2fms p95=%.2fms p99=%.2fms max=%.2fms late=%d link=%.1fHz | budget frames ≥ nine tenths, late ≤ a tenth → %@",
                     name, motion, given, Self.owedFrames, stretch.gapsMs.at(0.5), stretch.gapsMs.at(0.95), stretch.gapsMs.at(0.99), stretch.gapsMs.at(1), late,
                     stretch.linkHz, given * 10 < Self.owedFrames * 9 || late * 10 > given ? "OVER" : "under"))
          say(String(format: "%@ · %@ · main actor: work p50=%.2fms p95=%.2fms max=%.2fms · tick p50=%.2fms p95=%.2fms max=%.2fms · draw p50=%.2fms p95=%.2fms max=%.2fms draws=%d | budget work p50 ≤ %.1fms → %@, %.0f%% of it",
                     name, motion, stretch.workMs.at(0.5), stretch.workMs.at(0.95), stretch.workMs.at(1), stretch.tickMs.at(0.5), stretch.tickMs.at(0.95),
                     stretch.tickMs.at(1), stretch.drawMs.at(0.5), stretch.drawMs.at(0.95), stretch.drawMs.at(1), stretch.draws,
                     Self.frameMs, stretch.workMs.at(0.5) > Self.frameMs ? "OVER" : "under", stretch.workMs.at(0.5) / Self.frameMs * 100))
        }
      }
    } catch {
      say("failed: \(error)")
    }
    say("done: lowPower=\(lowPower()) thermal=\(thermal()) active=\(UIApplication.shared.applicationState == .active ? "yes" : "no")")
    said = lines
    // The lines stand on the screen for a moment before a launch that asked for it ends.
    _ = await frames.drive { $0 < 1 }
    if quits { exit(0) }
  }
}

// The handbook as the layout's fixture holds it (`packages/api-contract/roadmap/layout/handbook.json`), or the first
// `count` steps of its order, each following what it follows among them.
extension GraphPicture.Steps {
  init(handbook: Data, first count: Int?) throws {
    struct Fixture: Decodable {
      struct Roadmap: Decodable {
        struct Step: Decodable {
          let id: String
          let label: String
          let ord: String
          let born: String
          let color: String
          let follows: [String]
        }

        let steps: [Step]
        let done: [String]
      }

      let roadmap: Roadmap
    }
    let roadmap = try JSONDecoder().decode(Fixture.self, from: handbook).roadmap
    let steps = roadmap.steps.prefix(count ?? roadmap.steps.count)
    let among = Set(steps.map(\.id))
    let done = Set(roadmap.done)
    self.init(
      seated: try steps.map { (step: Fixture.Roadmap.Step) -> GraphPicture.Seated in
        GraphPicture.Seated(id: UTF16Text(step.id), label: UTF16Text(step.label), ord: UTF16Text(step.ord), born: try Stamp(step.born),
                            follows: step.follows.filter { among.contains($0) }.map { UTF16Text($0) }, hue: UTF16Text(step.color))
      },
      done: steps.map { done.contains($0.id) })
  }
}

// A measure's samples read at a share of their order: the median at a half, the largest at the whole.
extension [Double] {
  func at(_ share: Double) -> Double {
    isEmpty ? .nan : sorted()[Swift.min(count - 1, Int(Double(count) * share))]
  }
}
