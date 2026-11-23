import Foundation
import Observation
import Testing
import Synchronization
import DomainKit
import RoadmapDomain
import RoadmapLayout
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct RoadmapBoardTests {
  // Whether an observation was told that what it read changed.
  final class Seen: Sendable {
    let changed = Mutex(false)
  }

  // A phone never signed in: its engine in step mode, the runner roadmap's actions take, and what the phone remembers.
  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: nil,
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-board-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views, with a Graph on an iPhone 17's canvas under the room's bars and Reduce
  // Motion on, so a step brought into view stands there at once. Neither a band's time nor a caption's ends.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) -> RoadmapModel {
    let graph = RoadmapGraph(telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) }, reducesMotion: { true })
    graph.resize(Viewport(width: 402, height: 874), under: Insets(top: 158, bottom: 140))
    return RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                        telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) }, graph: graph)
  }

  func reads(_ model: RoadmapModel, on engine: SteppedEngine, until holds: (RoadmapModel) -> Bool) async {
    for _ in 0..<1_000 where !holds(model) {
      await engine.settleViews()
      model.observe()
      try? await Task.sleep(for: .milliseconds(10))
    }
    #expect(holds(model))
  }

  func step(_ label: String, in model: RoadmapModel) throws -> String {
    try #require(model.shown?.tree.index.nodes.first { $0.label == label }?.id)
  }

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  // Roadmap · iOS 02.4 and 03.7: Open in Graph, from a Board row's menu or a step's page, shows the Graph with the step
  // selected and, once the picture is laid out, at the centre of what the bars leave; Edit from a row's menu raises the
  // step's form.
  @Test func openInGraphSelectsTheStepAndBringsItToTheCentreOnceThePictureIsLaid() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    try RoadmapFixture.plantLearnToSail(runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 8 }
    let solo = try step("Sail solo", in: model)
    #expect(model.graph.picture == nil)

    model.openInGraph(solo, from: .menu)
    #expect(model.lens == .graph && model.selected == solo)
    await reads(model, on: engine) { $0.graph.picture != nil && $0.graph.camera != nil }
    let picture = try #require(model.graph.picture), camera = try #require(model.graph.camera)
    let seat = try #require(picture.placeOf[UTF16Text(solo)])
    let centred = camera.screen(picture.model.nodes[seat].x, picture.model.nodes[seat].y)
    #expect(abs(centred.x - 201) < 1e-6 && abs(centred.y - 446) < 1e-6)

    let tie = try step("Tie a bowline", in: model)
    model.show(.board)
    model.path = [.step(tie, by: .card)]
    model.openInGraph(tie, from: .page)
    #expect(model.path.isEmpty && model.lens == .graph && model.selected == tie)
    model.show(.board)
    model.edit(try #require(model.shown?.page(of: tie)), from: .menu)
    #expect(model.draft?.door == .menu && model.draft?.isNew == false)
    #expect(told(telemetry).filter { $0.contains("openInGraph") || $0.hasPrefix("roadmap_step_edit") } == [
      "roadmap_board_step_action action=openInGraph surface=board", "roadmap_board_step_action action=openInGraph surface=document",
      "roadmap_step_edit door=menu step=open",
    ])
  }

  // 10.6a: a roadmap holding the steps the registry lets it hold refuses New Step where it is tapped: the band says so
  // and no form opens. Another roadmap's New Step opens the form, named as Find's words where Find asked.
  @Test func aFullRoadmapRefusesNewStepWhereItIsTapped() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner).tree
    let cap = try #require(SyncSchema.registry.type(RoadmapStep.type)?.cap)
    let steps = (0..<cap).map { (place: Int) -> ImportedStep in ImportedStep(key: String(place), RoadmapStep.Changes(label: "Harbour \(place)")) }
    guard case .committed(let harbours, _) = try runner.runAct(CreateRoadmap(title: "Every harbour", steps: ImportedSteps(steps: steps))) else {
      Issue.record("Every harbour was not planted")
      return
    }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await reads(model, on: engine) { $0.roadmaps.count == 2 }
    model.open(harbours.tree.description, from: .menu)
    await reads(model, on: engine) { $0.shown?.board.overall.total == cap }

    model.newStep(from: .foot)
    #expect(model.draft == nil && model.band?.says == .refused(.full) && model.band?.undo == nil)
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_write_refused") || $0.hasPrefix("roadmap_board_create") } == [
      "roadmap_write_refused refusal=full write=CreateNode",
    ])

    model.open(sail.description, from: .menu)
    await reads(model, on: engine) { $0.shown?.listed.title == "Learn to sail" }
    model.newStep(from: .find, named: "Heave to")
    #expect(model.draft?.name == "Heave to" && model.draft?.door == .find && model.draft?.isNew == true)
  }

  // Find's words change at every key, and the steps chosen at every tap: neither rebuilds the room around the Board,
  // whose own list alone reads them.
  @Test func typingInFindOrChoosingAStepRebuildsNothingOfTheRoom() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    try RoadmapFixture.plantLearnToSail(runner)
    let model = room(engine, runner, memory)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 8 }
    let open = try #require(model.shown)
    let room = RoadmapRoom(roadmap: model, app: try AppModel(runner: runner, preferences: memory))
    let rebuilds = { (change: () -> Void) -> Bool in
      let seen = Seen()
      withObservationTracking { _ = room.views(of: open) } onChange: { seen.changed.withLock { $0 = true } }
      change()
      return seen.changed.withLock { $0 }
    }

    model.reading.finds = true
    let typed: [Bool] = [rebuilds { model.reading.finding = "s" }, rebuilds { model.reading.finding = "sa" }, rebuilds { model.reading.finding = "" }]
    model.reading.finds = false
    model.startSelecting(try step("Tie a bowline", in: model), from: .menu)
    let selection = try #require(model.selection)
    let chosen: [Bool] = [rebuilds { selection.steps.insert(open.groups[0].rows[0].id) }, rebuilds { selection.steps = [] }]
    #expect(typed == [false, false, false] && chosen == [false, false])
  }
}
