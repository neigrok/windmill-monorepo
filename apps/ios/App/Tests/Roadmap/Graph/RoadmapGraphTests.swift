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
            clock: Clock = Clock(), pinch: GraphPinch = .room, crowd: Int = GraphPinch.crowd, reducesMotion: Bool = false) -> RoadmapModel {
    let graph = RoadmapGraph(telemetry: telemetry, now: { clock.seconds.withLock { $0 } }, wait: { _ in try await Task.sleep(for: .seconds(3_600)) },
                             pinch: pinch, crowd: crowd, reducesMotion: { reducesMotion })
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
  // The Graph's coming up is told once each time, by the switch or by a roadmap opening on it, with the roadmap's size
  // as a bucket (§11), and not as the phone's copy is read again.
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
    #expect(telemetry.lines.withLock { $0 } == ["roadmap_room_opened", "roadmap_view_switch steps=1-100 view=graph"])

    model.open(rust.tree.description, from: .menu)
    await opens(model, "Learn Rust", on: engine)
    #expect(model.lens == .board)
    model.open(sail.description, from: .menu)
    await opens(model, "Learn to sail", on: engine)
    #expect(model.lens == .graph)
    #expect(await draws(model, on: engine) { $0.model.nodes.count == 8 })
    #expect(telemetry.lines.withLock { $0 } == [
      "roadmap_room_opened", "roadmap_view_switch steps=1-100 view=graph", "roadmap_sheet door=menu step=switch", "roadmap_sheet door=menu step=switch",
      "roadmap_view_switch steps=1-100 view=graph",
    ])

    let told = Told()
    let relaunched = room(engine, runner, memory, telemetry: told)
    relaunched.roomOpened()
    await opens(relaunched, "Learn to sail", on: engine)
    #expect(relaunched.lens == .graph)
    #expect(await draws(relaunched, on: engine) { $0.model.nodes.count == 8 })
    relaunched.show(.board)
    #expect(told.lines.withLock { $0 } == ["roadmap_room_opened", "roadmap_view_switch steps=1-100 view=graph", "roadmap_view_switch view=board"])
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
      "roadmap_room_opened", "roadmap_view_switch steps=1-100 view=graph", "roadmap_graph_select column=upNext",
      "roadmap_board_step_open column=upNext door=graph surface=document",
    ])

    model.select(read)
    model.delete(try row("Read the wind", in: model), by: .page)
    #expect(await draws(model, on: engine) { $0.model.nodes.count == 7 })
    #expect(model.selected == nil)
  }

  // §5: however the Graph keeps a pinch's frames, the surface is given at rest what `live` is given at that camera, and
  // a tap then takes the step the camera holds under it. While the pinch moves a crowd, `held` gives the surface the
  // pinch's nearest stop without its captions, which the camera carries to where a person sees it, and `coarse` the
  // camera itself with its discs squared. The pinch is under way from its first report to the fingers' leaving.
  @Test func howeverAPinchsFramesAreKeptTheSurfaceIsGivenAtRestWhatLiveIsGiven() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    var moved: [String] = []
    for way in GraphPinch.allCases {
      let model = room(engine, runner, memory, pinch: way, crowd: 2)
      model.roomOpened()
      await opens(model, "Learn to sail", on: engine)
      model.show(.graph)
      #expect(await draws(model, on: engine) { $0.model.nodes.count == 8 })
      let graph = model.graph
      let picture = try #require(graph.picture)
      let given = { () throws -> GraphDrawing in
        GraphDrawing(picture: picture, camera: try #require(graph.camera), captions: graph.captions, selected: nil, pinched: graph.pinched, by: way,
                     crowd: graph.crowd)
      }
      let live = { () throws -> GraphDrawing in GraphDrawing(picture: picture, camera: try #require(graph.camera), captions: graph.captions, selected: nil) }
      let (opening, fingers) = (try #require(graph.camera), CGPoint(x: 240, y: 500))
      #expect(try given() == live() && graph.pinched == nil)

      graph.zoom(by: 1.1, about: fingers)
      graph.zoom(by: 1.3 / 1.1, about: fingers)
      #expect(graph.pinched == GraphCamera.Pinched(from: opening, about: fingers) && !graph.captions.isEmpty)
      let (pinched, camera) = (try given(), try #require(graph.camera))
      let read = picture.model.nodes[try place("Read the wind", in: picture)]
      let (seen, seat) = (pinched.camera.screen(read.x, read.y).applying(camera.carries(from: pinched.camera)), camera.screen(read.x, read.y))
      let astray: Bool = hypot(seen.x - seat.x, seen.y - seat.y) >= 1e-9
      let zooms: String = String(format: "%@: zoom %.2f of %.2f", way.rawValue, pinched.camera.frame.zoom / opening.frame.zoom,
                                 camera.frame.zoom / opening.frame.zoom)
      moved.append([zooms, pinched.captions.isEmpty ? ", no caption" : "", pinched.squared ? ", squared" : "", astray ? ", astray" : ""].joined())

      graph.rest()
      #expect(try given() == live() && graph.pinched == nil)
      #expect(graph.step(at: seat).flatMap { model.shown?.step($0)?.step.label } == "Read the wind")
    }
    #expect(moved == ["live: zoom 1.30 of 1.30", "held: zoom 1.50 of 1.30, no caption", "coarse: zoom 1.30 of 1.30, squared", "layered: zoom 1.30 of 1.30"])
  }

  // Roadmap · iOS 04.3: *Next* leads with the first Up next step in Roadmap Order and lists them all. A step picked is
  // selected and the camera glides to it, by a pinch where it must come nearer, and ends with the step's seat at the
  // centre of what the bars leave at the working zoom; a drag ends a glide where it has come to, and under Reduce
  // Motion the camera is there at once. The menu's opening and each pick are told as the web's What's next.
  @Test func nextListsTheUpNextStepsInRoadmapOrderAndAStepPickedIsSelectedAndBroughtToTheCentre() async throws {
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
    let next = try #require(model.shown).upNext
    #expect(next.map(\.name) == ["Read the wind", "Tie a bowline"])
    let seat = { (label: String) throws -> Point in
      let node = picture.model.nodes[try place(label, in: picture)]
      return Point(x: node.x, y: node.y)
    }

    graph.zoom(by: 0.001, about: CGPoint(x: 201, y: 446))
    graph.rest()
    let floor = try #require(graph.camera)
    model.nextOpened()
    model.pick(next[1])
    #expect(model.selected == next[1].id && graph.camera == floor && graph.pinched?.from == floor)
    clock.seconds.withLock { $0 += 0.05 }
    graph.glided()
    let nearer = try #require(graph.camera).frame.zoom
    #expect(nearer > floor.frame.zoom && nearer < 0.8503401360544218 && graph.pinched?.from == floor)
    clock.seconds.withLock { $0 += 1 }
    graph.glided()
    let landed = try #require(graph.camera)
    let tie = try seat("Tie a bowline")
    #expect(landed == floor.centred(on: tie) && graph.pinched == nil && landed.frame.zoom == 0.8503401360544218)
    #expect(abs(landed.screen(tie.x, tie.y).x - 201) < 1e-9 && abs(landed.screen(tie.x, tie.y).y - 446) < 1e-9)

    model.pick(next[0])
    clock.seconds.withLock { $0 += 0.05 }
    graph.glided()
    graph.pan(by: CGSize(width: 10, height: 0))
    let stopped = try #require(graph.camera)
    clock.seconds.withLock { $0 += 1 }
    graph.glided()
    let read = try seat("Read the wind")
    #expect(graph.camera == stopped && stopped != landed.centred(on: read) && model.selected == next[0].id)
    graph.rest()

    let still = room(engine, runner, memory, reducesMotion: true)
    still.roomOpened()
    await opens(still, "Learn to sail", on: engine)
    #expect(await draws(still, on: engine) { $0.model.nodes.count == 8 })
    let opening = try #require(still.graph.camera)
    still.pick(next[1])
    #expect(still.graph.camera == opening.centred(on: tie) && still.graph.camera != opening && still.graph.pinched == nil)

    #expect(telemetry.lines.withLock { $0 } == [
      "roadmap_room_opened", "roadmap_view_switch steps=1-100 view=graph", "roadmap_whats_next count=2-5 step=open",
      "roadmap_whats_next count=2-5 step=pick", "roadmap_whats_next count=2-5 step=pick",
    ])
    #expect([0, 1, 2, 5, 6, 20, 21, 5_000].map(RoadmapModel.bucket) == ["0", "1", "2-5", "2-5", "6-20", "6-20", "21+", "21+"])
  }

  // Roadmap · iOS 04.5: Fit glides the camera to the whole roadmap as the layout frames it, and frames it anew as the
  // bars leave the canvas. Fit stands until it is ended, through a pinch too; once it is, the camera stays where Fit
  // left it as the bars come back. A canvas that leaves the screen ends it.
  @Test func fitFramesTheWholeRoadmapAsTheBarsLeaveAndTheCameraStaysWhereFitLeftIt() async throws {
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
    let (canvas, barred, bare) = (Viewport(width: 402, height: 874), Insets(top: 158, bottom: 140), Insets(top: 62, bottom: 34))
    let whole = { (insets: Insets) -> GraphCamera in GraphCamera(framing: picture.model.bounds, in: canvas, under: insets) }

    graph.zoom(by: 2, about: CGPoint(x: 120, y: 300))
    graph.rest()
    let close = try #require(graph.camera)
    model.fit()
    #expect(graph.fitted && graph.camera == close && graph.pinched?.from == close)
    clock.seconds.withLock { $0 += 0.05 }
    graph.glided()
    graph.resize(canvas, under: bare)
    #expect(graph.camera != whole(bare) && graph.pinched != nil)
    clock.seconds.withLock { $0 += 1 }
    graph.glided()
    #expect(graph.camera == whole(bare) && graph.camera != whole(barred) && graph.pinched == nil && graph.fitted)

    graph.zoom(by: 1.5, about: CGPoint(x: 201, y: 437))
    graph.rest()
    #expect(graph.fitted && graph.camera != whole(bare))
    graph.resize(Viewport(width: 402, height: 800), under: bare)
    clock.seconds.withLock { $0 += 1 }
    graph.glided()
    #expect(graph.camera == GraphCamera(framing: picture.model.bounds, in: Viewport(width: 402, height: 800), under: bare))
    graph.resize(canvas, under: bare)
    clock.seconds.withLock { $0 += 1 }
    graph.glided()

    model.unfit()
    let left = try #require(graph.camera)
    graph.resize(canvas, under: barred)
    let kept = try #require(graph.camera)
    #expect(!graph.fitted && left == whole(bare) && kept.frame.zoom == left.frame.zoom && abs(kept.frame.x - left.frame.x) < 1e-9
            && abs(kept.frame.y - left.frame.y) < 1e-9)

    model.fit()
    graph.closed()
    #expect(!graph.fitted && graph.pinched == nil)
    #expect(telemetry.lines.withLock { $0 } == [
      "roadmap_room_opened", "roadmap_view_switch steps=1-100 view=graph", "roadmap_graph_fit step=open", "roadmap_graph_fit step=close",
      "roadmap_graph_fit step=open",
    ])
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
