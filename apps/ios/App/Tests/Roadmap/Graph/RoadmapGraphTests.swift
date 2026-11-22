import Foundation
import Testing
import Synchronization
import DomainKit
import RoadmapDomain
import RoadmapLayout
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct RoadmapGraphTests {
  // What the Graph and its room tell: each event and each report by name, with its labels.
  final class Told: Telemetry {
    let lines = Mutex<[String]>([])

    func event(_ name: String, properties: [String: String], durationMs: Int64?) {
      lines.withLock { $0.append(([name] + properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }).joined(separator: " ")) }
    }

    func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?) {
      event("report \(operation) \(kind)", properties: properties, durationMs: durationMs)
    }
  }

  // A clock a test moves, in seconds.
  final class Clock: Sendable {
    let seconds = Mutex(0.0)
  }

  // The measures a Graph handed over, in order.
  final class Kept: Sendable {
    let measures = Mutex<[RoadmapGraph.Measure]>([])
  }

  // A phone's engine in step mode on the model server, the runner roadmap's actions take, and what the phone remembers.
  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-graph-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views, with a Graph on an iPhone 17's canvas under the room's bars. Neither a
  // band's time nor a caption's ends unless a test ends it.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry(),
            clock: Clock = Clock()) -> RoadmapModel {
    let graph = RoadmapGraph(telemetry: telemetry, now: { clock.seconds.withLock { $0 } }, wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
    graph.resize(Viewport(width: 402, height: 874), under: Insets(top: 158, bottom: 140))
    return RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                        telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) }, graph: graph)
  }

  // The test bundle's copy of the engine notifies no observer in the app's, so each read is asked for, until the room
  // has the roadmap open whose title is given.
  func opens(_ model: RoadmapModel, _ title: String, on engine: SteppedEngine) async {
    for _ in 0..<100 where model.shown?.listed.title != title {
      await engine.settleViews()
      model.observe()
    }
    #expect(model.shown?.listed.title == title)
  }

  // The room reads again and the Graph lays out off the main actor: both are given their turn until the picture is the
  // one asked for, for ten seconds at most.
  func draws(_ model: RoadmapModel, on engine: SteppedEngine, _ asked: (GraphPicture) -> Bool) async -> Bool {
    for _ in 0..<1_000 where !(model.graph.picture.map(asked) ?? false) {
      await engine.settleViews()
      model.observe()
      try? await Task.sleep(for: .milliseconds(10))
    }
    return model.graph.picture.map(asked) ?? false
  }

  // A step's place in the picture, by its name.
  func place(_ label: String, in picture: GraphPicture) throws -> Int {
    try #require(picture.model.nodes.firstIndex { $0.label == label })
  }

  func row(_ label: String, in model: RoadmapModel) throws -> RoadmapModel.Row {
    try #require(model.shown?.groups.flatMap(\.rows).first { $0.step.label == label })
  }

  // Roadmap · iOS 04.1: the switch shows the Graph, which draws the roadmap as the layout frames it. The choice is the
  // roadmap's on this phone: another roadmap opens on its Board, and this one on its Graph again, at the next launch too.
  @Test func theSwitchShowsTheGraphAsTheLayoutFramesItAndTheChoiceIsKeptForTheRoadmap() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    guard case .committed(let rust, _) = try runner.runAct(CreateRoadmap(title: "Learn Rust", steps: ImportedSteps(steps: [
      ImportedStep(key: "first", RoadmapStep.Changes(label: "Basics")),
    ]))) else {
      Issue.record("Learn Rust was not created")
      return
    }
    engine.sync()
    engine.advance(ms: 60_000)
    let sail = try RoadmapFixture.plantLearnToSail(runner).tree
    engine.sync()
    let telemetry = Told()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await opens(model, "Learn to sail", on: engine)
    #expect(model.lens == .board && model.graph.picture == nil)

    model.show(.graph)
    #expect(await draws(model, on: engine) { $0.model.nodes.count == 8 })
    #expect(model.lens == .graph && model.graph.picture?.engine == .bubble)
    #expect(model.graph.camera?.frame == Frame(x: 143.18515267879673, y: -25.69075266365024, zoom: 0.8503401360544218))
    model.show(.graph)
    #expect(telemetry.lines.withLock { $0 } == ["roadmap_room_opened", "roadmap_view_switch view=graph"])

    model.open(rust.tree.description, from: .menu)
    await opens(model, "Learn Rust", on: engine)
    #expect(model.lens == .board)
    model.open(sail.description, from: .menu)
    await opens(model, "Learn to sail", on: engine)
    #expect(model.lens == .graph)

    let relaunched = room(engine, runner, memory)
    relaunched.roomOpened()
    await opens(relaunched, "Learn to sail", on: engine)
    #expect(relaunched.lens == .graph)
    #expect(await draws(relaunched, on: engine) { $0.model.nodes.count == 8 })
    relaunched.show(.board)
    let again = room(engine, runner, memory)
    again.roomOpened()
    await opens(again, "Learn to sail", on: engine)
    #expect(again.lens == .board)
  }

  // The Graph follows the phone's copy without losing the person's place: a step completed keeps every seat and the
  // camera where it was left, and a step made is seated while the camera stays.
  @Test func theGraphFollowsThePhonesCopyAndKeepsTheCameraWhereItWasLeft() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let planted = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let model = room(engine, runner, memory)
    model.roomOpened()
    await opens(model, "Learn to sail", on: engine)
    model.show(.graph)
    #expect(await draws(model, on: engine) { $0.model.nodes.count == 8 })

    model.graph.zoom(by: 1.4, about: CGPoint(x: 240, y: 500))
    model.graph.pan(by: CGSize(width: -40, height: 30))
    let (left, seats) = (try #require(model.graph.camera), try #require(model.graph.picture).seats)
    #expect(left.frame.zoom == 0.8503401360544218 * 1.4)

    model.complete(try row("Read the wind", in: model), by: .swipe)
    #expect(await draws(model, on: engine) { $0.model.nodes.contains { $0.label == "Leave the dock" && $0.tier == .available } })
    let completed = try #require(model.graph.picture)
    #expect(completed.model.nodes[try place("Read the wind", in: completed)].tier == .complete)
    #expect(completed.seats == seats && model.graph.camera == left)

    let read = try #require(planted.steps.first { $0.key == "read" }).id
    guard case .committed = try runner.runAct(CreateStep(tree: planted.tree, step: RoadmapStep.Changes(label: "Reef the mainsail", color: "sky"),
                                                         prerequisites: [read])) else {
      Issue.record("Reef the mainsail was not created")
      return
    }
    #expect(await draws(model, on: engine) { $0.model.nodes.count == 9 })
    #expect(model.graph.camera?.frame == left.frame)
  }

  // Roadmap · iOS 04.2 and 04.4: a tap takes the nearest step whose disc holds it, or whose 44 pt target does where
  // the disc is smaller, at any zoom. The step selected leads the captions at once, a step opened from the Graph says
  // so, and a selected step that goes is selected no longer.
  @Test func aTapSelectsTheStepWithinItsTargetAndTheSelectedStepLeadsTheCaptions() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (telemetry, clock) = (Told(), Clock())
    let model = room(engine, runner, memory, telemetry: telemetry, clock: clock)
    model.roomOpened()
    await opens(model, "Learn to sail", on: engine)
    model.show(.graph)
    #expect(await draws(model, on: engine) { $0.model.nodes.count == 8 })
    let graph = model.graph
    let picture = try #require(graph.picture)
    let seat = { (label: String) throws -> CGPoint in
      let node = picture.model.nodes[try place(label, in: picture)]
      return try #require(graph.camera).screen(node.x, node.y)
    }
    let taken = { (label: String, right: Double) throws -> String? in
      let point = try seat(label)
      return graph.step(at: CGPoint(x: point.x + right, y: point.y)).flatMap { model.shown?.step($0)?.step.label }
    }

    // At the opening zoom a disc is 40 points across and its target 44; the root's disc is 62.
    #expect(try [taken("Read the wind", 0), taken("Read the wind", 21.9), taken("Read the wind", 22.1)] == ["Read the wind", "Read the wind", nil])
    #expect(try [taken("Choose a sailing course", -30.9), taken("Choose a sailing course", -31.1)] == ["Choose a sailing course", nil])
    // Pinched out to the floor a disc is 20 points across, and its target still 44.
    graph.zoom(by: 0.001, about: CGPoint(x: 201, y: 446))
    #expect(try [taken("Read the wind", 21.9), taken("Read the wind", 22.1)] == ["Read the wind", nil])
    // Between two steps, the nearer takes the tap.
    let (rig, parts) = (try seat("Rig the boat"), try seat("Name the boat parts"))
    let between = { (share: Double) -> String? in
      graph.step(at: CGPoint(x: rig.x + (parts.x - rig.x) * share, y: rig.y + (parts.y - rig.y) * share)).flatMap { model.shown?.step($0)?.step.label }
    }
    #expect([between(0.45), between(0.55)] == ["Rig the boat", "Name the boat parts"])
    graph.zoom(by: 2, about: CGPoint(x: 201, y: 446))

    // No caption is past its wait until a fifth of a second has gone; the selected step's is, at once, and leads.
    #expect(!graph.captions.isEmpty && graph.captions.allSatisfy { !$0.shown })
    let read = try row("Read the wind", in: model).id
    model.select(graph.step(at: try seat("Read the wind")))
    #expect(model.selected == read)
    #expect(graph.captions.first.map { "\($0.id.text == read) \($0.shown) \($0.lines)" } == "true true [\"Read the wind\"]")
    #expect(graph.captions.dropFirst().allSatisfy { !$0.shown })
    clock.seconds.withLock { $0 += 0.25 }
    model.select(read)
    #expect(graph.captions.count > 1 && graph.captions.allSatisfy(\.shown))

    model.path = [.step(read, by: .graph)]
    model.path = []
    model.select(nil)
    #expect(model.selected == nil)
    #expect(telemetry.lines.withLock { $0 } == [
      "roadmap_room_opened", "roadmap_view_switch view=graph", "roadmap_graph_select column=upNext",
      "roadmap_board_step_open column=upNext door=graph surface=document",
    ])

    model.select(read)
    model.delete(try row("Read the wind", in: model), by: .page)
    #expect(await draws(model, on: engine) { $0.model.nodes.count == 7 })
    #expect(model.selected == nil)
  }

  // §5 and §11: a roadmap the bubble layout refuses is drawn by the fallback and reported once a launch, and so is a
  // first frame that came later than a second after the tap; each measure goes to whoever keeps them.
  @Test func aLayoutThatFellBackAndAFirstFrameOverBudgetAreEachReportedOnce() async throws {
    struct Refusing: LayoutEngine {
      let name = LayoutName.bubble
      func layout(_ tree: SkillTree) throws -> [Point] { [Point(x: try Arithmetic.cos(Arithmetic.reducibleBelow), y: 0)] }
    }
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (telemetry, clock, kept) = (Told(), Clock(), Kept())
    let graph = RoadmapGraph(telemetry: telemetry, layout: Refusing(), now: { clock.seconds.withLock { $0 } },
                             wait: { _ in try await Task.sleep(for: .seconds(3_600)) }, measured: { measure in kept.measures.withLock { $0.append(measure) } })
    graph.resize(Viewport(width: 402, height: 874), under: Insets(top: 158, bottom: 140))
    let model = RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                             telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) }, graph: graph)
    model.roomOpened()
    await opens(model, "Learn to sail", on: engine)

    model.show(.graph)
    #expect(await draws(model, on: engine) { $0.model.nodes.count == 8 })
    #expect(graph.picture?.engine == .radial && graph.camera != nil)
    clock.seconds.withLock { $0 = 1.2 }
    graph.drew()
    graph.drew()
    #expect(kept.measures.withLock { $0 } == [.firstFrame(ms: 1_200, layoutMs: 0, steps: 8)])

    // The same again in the same launch: measured, and reported no second time.
    model.show(.board)
    model.show(.graph)
    model.complete(try row("Read the wind", in: model), by: .swipe)
    #expect(await draws(model, on: engine) { $0.model.nodes.contains { $0.label == "Read the wind" && $0.tier == .complete } })
    clock.seconds.withLock { $0 = 3 }
    graph.drew()
    #expect(kept.measures.withLock { $0 } == [.firstFrame(ms: 1_200, layoutMs: 0, steps: 8), .firstFrame(ms: 1_800, layoutMs: 0, steps: 8)])
    #expect(telemetry.lines.withLock { $0 }.filter { $0.hasPrefix("report") } == [
      "report roadmap_layout fallback", "report roadmap_canvas budget budget=first_frame steps=1-100",
    ])

    // A canvas that left the screen before its first frame measures none.
    model.show(.board)
    model.show(.graph)
    graph.closed()
    clock.seconds.withLock { $0 = 9 }
    graph.drew()
    #expect(kept.measures.withLock { $0 }.count == 2)
  }

  // §5: the Graph pans and zooms at 60 frames a second. A gesture's frames miss that once more than a tenth of them
  // came later than a frame and a half, over half a second or more.
  @Test func aGestureMissesTheBudgetWhenMoreThanATenthOfItsFramesAreLate() {
    let frames = { (late: Int, of: Int) -> [Double] in [Double](repeating: 33.4, count: late) + [Double](repeating: 16.7, count: of - late) }
    #expect([RoadmapGraph.misses(frames(0, 120)), RoadmapGraph.misses(frames(12, 120)), RoadmapGraph.misses(frames(13, 120)),
             RoadmapGraph.misses(frames(29, 29)), RoadmapGraph.misses(frames(4, 30)), RoadmapGraph.misses([])]
            == [false, false, true, false, true, false])
    #expect([RoadmapGraph.bucket(8), RoadmapGraph.bucket(100), RoadmapGraph.bucket(101), RoadmapGraph.bucket(1_000), RoadmapGraph.bucket(5_000)]
            == ["1-100", "1-100", "101-1000", "101-1000", "1001-5000"])
  }
}
