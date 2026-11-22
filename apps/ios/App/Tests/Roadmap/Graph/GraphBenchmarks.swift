import Foundation
import SwiftUI
import Testing
import DomainKit
import DomainKitTesting
import RoadmapDomain
import RoadmapLayout
import SyncCore
import SyncModelServer
import SyncSchema
@testable import Windmill

// The Graph's budget (Roadmap on iOS §5) on the 5,000-step handbook of the layout's shared fixtures: the picture's
// time, which is the layout's and most of the first frame's, and at five cameras the part of a frame that is the
// room's own code, the captions placed and the canvas's drawing issued. Each measure prints one `bench` line beside
// its budget with the share of the budget it used, and fails when it passes it. The budgets are §5's own, a second and
// a frame at 60 a second, held here on the Mac that runs the simulator: the share says how wide the margin is for a
// phone, which is slower. What the system then does to put a frame on the screen is not in these; the screen's own
// benchmark, `RoadmapGraphBenchmarks`, measures the main actor's whole work in a frame. The suite runs only under
// WM_GRAPH_BENCH=1, which `Tools/graph_bench.sh` sets on a Release-configuration build.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["WM_GRAPH_BENCH"] == "1", "the Graph's benchmarks run under WM_GRAPH_BENCH=1"))
@MainActor struct GraphBenchmarks {
  // The handbook as the layout's fixture holds it, found by walking up from this file.
  func handbook(from file: String = #filePath) throws -> GraphPicture.Steps {
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
    var directory = URL(fileURLWithPath: file).deletingLastPathComponent()
    while directory.path != "/" && !FileManager.default.fileExists(atPath: directory.appending(path: "packages/api-contract/roadmap/layout/handbook.json").path) {
      directory = directory.deletingLastPathComponent()
    }
    let roadmap = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: directory.appending(path: "packages/api-contract/roadmap/layout/handbook.json"))).roadmap
    let done = Set(roadmap.done)
    return GraphPicture.Steps(
      seated: try roadmap.steps.map { (step: Fixture.Roadmap.Step) -> GraphPicture.Seated in
        GraphPicture.Seated(id: UTF16Text(step.id), label: UTF16Text(step.label), ord: UTF16Text(step.ord), born: try Stamp(step.born),
                            follows: step.follows.map { UTF16Text($0) }, hue: UTF16Text(step.color))
      },
      done: roadmap.steps.map { done.contains($0.id) })
  }

  func ms(_ duration: Duration) -> Double {
    Double(duration.components.seconds) * 1_000 + Double(duration.components.attoseconds) / 1e15
  }

  // One measure's line: its samples' spread and, where it has a budget, whether the median holds it and how much of
  // it the median used.
  func report(_ measure: String, _ samples: [Double], budgetMs: Double? = nil, _ note: String = "") -> Bool {
    let sorted = samples.sorted()
    let median = sorted[sorted.count / 2]
    let spread = String(format: "n=%d min=%.2fms p50=%.2fms p95=%.2fms max=%.2fms", sorted.count, sorted[0], median,
                        sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))], sorted[sorted.count - 1])
    guard let budgetMs else {
      print("bench [simulator] graph · \(measure): \(spread)\(note)")
      return true
    }
    print("bench [simulator] graph · \(measure): \(spread)\(note) | budget p50 ≤ \(String(format: "%.1fms", budgetMs)) → "
          + "\(median > budgetMs ? "OVER" : "under"), \(String(format: "%.0f%%", median / budgetMs * 100)) of it")
    return median <= budgetMs
  }

  // §5: the Graph's first frame, with its layout, is under a second. The picture is that frame's work but for the
  // domain's read and one draw: the layout's seats, the model, the bows and every caption wrapped under the canvas's
  // font.
  @Test func thePictureOfFiveThousandStepsIsMadeWithinTheFirstFramesSecond() async throws {
    let steps = try handbook()
    var whole: [Double] = []
    var seats: [Double] = []
    var marked: [Double] = []
    for _ in 0..<5 {
      let began = ContinuousClock.now
      let picture = try await GraphPicture(steps)
      whole.append(ms(ContinuousClock.now - began))
      #expect(picture.engine == .bubble && picture.model.nodes.count == 5_000 && picture.metrics.count == 5_000)

      let tree = try SkillTree(steps: picture.model.nodes.indices.map { (place: Int) -> SkillTree.Step in
        let step = steps.seated[place]
        return SkillTree.Step(id: step.id.text, label: step.label.text, ord: step.ord.text,
                              born: SkillTree.Stamp(ms: step.born.ms, counter: Int64(step.born.counter), actor: step.born.actor),
                              follows: step.follows.map(\.text), hue: step.hue.text, done: steps.done[place])
      })
      let seating = ContinuousClock.now
      _ = try Seating(of: tree)
      seats.append(ms(ContinuousClock.now - seating))

      // A step marked done moves no seat: the picture after it borrows the seats and the captions.
      var done = steps.done
      done[4_000] = true
      let marking = ContinuousClock.now
      _ = try await GraphPicture(GraphPicture.Steps(seated: steps.seated, done: done), after: picture)
      marked.append(ms(ContinuousClock.now - marking))
    }
    let held = [report("the picture, whole", whole, budgetMs: 1_000), report("the layout's seats alone", seats),
                report("the picture after a step is marked done", marked, budgetMs: 1_000)]
    #expect(held == [true, true, true])
  }

  // The other part of the first frame's work: the domain's read of the roadmap taken as the layout's steps, each with
  // what it follows. The handbook is planted through the domain on a phone in memory, as the simulator's board plants it.
  @Test func theDomainsReadOfFiveThousandStepsIsTakenForTheLayoutWithinTheFirstFramesSecond() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                        rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let id = try RoadmapFixture.plantHandbook(phone.runner).tree
    let tree = try RoadmapTree(id: id, listed: phone.runner.read(RoadmapEntry.scope) { try $0.repository(RoadmapEntry.self).record(id, in: .drawn) },
                               tree: phone.runner.read(id.tree) { try $0.records(in: .drawn) },
                               overlay: phone.runner.read(id.overlay) { try $0.records(in: .drawn) })
    let account = RoadmapAccount([tree])
    let listed = try #require(account.list().first)
    let read = try #require(account.graph(listed.id))
    var taking: [Double] = []
    for _ in 0..<5 {
      let began = ContinuousClock.now
      let steps = GraphPicture.Steps(of: read)
      taking.append(ms(ContinuousClock.now - began))
      #expect(steps.seated.count == 5_000 && steps.done.count { $0 } == 120)
    }
    #expect(report("the domain's read taken as the layout's steps", taking, budgetMs: 1_000))
  }

  // §5: the Graph pans and zooms at 60 frames a second. The room's own part of a frame is the captions placed at the
  // camera and the canvas's drawing issued: both are timed over sixty frames of a pan to and fro at each camera, with
  // the canvas rendered at an iPhone 17's size and scale. `render` is the whole offscreen render into a bitmap, which
  // takes hundreds of times the main actor's work in a frame of the same picture on a screen, so it carries no budget.
  @Test func aFramesCaptionsAndDrawingAtEachCameraTakeLessThanAFrame() async throws {
    let picture = try await GraphPicture(try handbook())
    let (viewport, insets) = (Viewport(width: 402, height: 874), Insets(top: 158, bottom: 140))
    let centre = CGPoint(x: 201, y: 437)
    let opening = GraphCamera(framing: picture.model.bounds, in: viewport, under: insets)
    var floor = opening
    floor.zoom(by: 0.001, about: centre)
    // The step the fixture selects, n2400, brought under the centre at the phone's working zoom and then to the pinch
    // ceiling; and the zoom at which connectors are first drawn, over the same step.
    let seat = picture.model.nodes[try #require(picture.placeOf[UTF16Text("n2400")])]
    var working = opening
    let from = working.screen(seat.x, seat.y)
    working.pan(by: CGSize(width: centre.x - from.x, height: centre.y - from.y))
    var threaded = working
    threaded.zoom(by: Theme.phoneWorkingZoom * GraphDrawing.thinnestConnector / GraphDrawing.connector / threaded.frame.zoom, about: centre)
    working.zoom(by: Theme.phoneWorkingZoom / working.frame.zoom, about: centre)
    var pinched = working
    pinched.zoom(by: 100, about: centre)

    var held: [Bool] = []
    for (name, start) in [("the zoom floor", floor), ("the opening frame, the whole roadmap", opening), ("connectors first drawn", threaded),
                          ("the working zoom", working), ("pinched in to the ceiling", pinched)] {
      var camera = start
      var placer = CaptionPlacer()
      placer.setModel(picture.model, picture.grid)
      placer.setMetrics(picture.metrics)
      placer.setInsets(insets, blocks: [])
      var (placing, drawing, rendering): ([Double], [Double], [Double]) = ([], [], [])
      var named = 0
      let bitmap = try #require(CGContext(data: nil, width: Int(viewport.width) * 3, height: Int(viewport.height) * 3, bitsPerComponent: 8, bytesPerRow: 0,
                                         space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      for frame in 0..<60 {
        camera.pan(by: frame % 2 == 0 ? CGSize(width: 3, height: 2) : CGSize(width: -3, height: -2))
        let placed = ContinuousClock.now
        let captions = placer.place(camera: camera.frame, viewport: viewport, now: Double(frame) * 1_000 / 60).captions
        placing.append(ms(ContinuousClock.now - placed))
        named = captions.count { $0.shown }

        let drawn = Drawn()
        let shot = camera
        let renderer = ImageRenderer(content: Canvas { context, _ in
          let began = ContinuousClock.now
          GraphDrawing(picture: picture, camera: shot, captions: captions, selected: nil).draw(in: &context)
          drawn.took = ContinuousClock.now - began
        }.frame(width: viewport.width, height: viewport.height).environment(\.colorScheme, .dark))
        let rendered = ContinuousClock.now
        renderer.render(rasterizationScale: 3) { _, render in render(bitmap) }
        rendering.append(ms(ContinuousClock.now - rendered))
        drawing.append(ms(drawn.took))
      }
      let box = camera.holds()
      let inView = picture.model.nodes.count { $0.x >= box.minX && $0.x <= box.maxX && $0.y >= box.minY && $0.y <= box.maxY }
      let note = String(format: " zoom=%.5f steps=%d captions=%d", camera.frame.zoom, inView, named)
      held.append(report("\(name) · captions placed and canvas drawn", zip(placing, drawing).map { $0 + $1 }, budgetMs: 1_000.0 / 60, note))
      _ = report("\(name) · captions placed", placing)
      _ = report("\(name) · canvas drawn", drawing)
      _ = report("\(name) · render, offscreen", rendering)
    }
    #expect(held == [true, true, true, true, true])
  }
}

// What one canvas's drawing took, written from inside its renderer.
final class Drawn {
  var took = Duration.zero
}
