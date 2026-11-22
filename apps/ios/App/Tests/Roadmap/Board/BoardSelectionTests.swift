import Foundation
import Testing
import DomainKit
import RoadmapDomain
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct BoardSelectionTests {
  // A phone's engine in step mode on the model server, the runner roadmap's actions take, and what the phone remembers.
  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "board-selection-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views; a band's time never ends unless a test ends it.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                 telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
  }

  // *Learn to sail* as it opens on the Board, three steps done a minute apart.
  func learnToSail(_ model: RoadmapModel, on engine: SteppedEngine, _ runner: ActionRunner) async throws {
    let planted = try RoadmapFixture.plantLearnToSail(runner, done: [])
    for step in ["choose", "parts", "rig"] {
      engine.advance(ms: 60_000)
      try RoadmapFixture.complete(step, of: planted, by: runner)
      engine.sync()
    }
    engine.advance(ms: 60_000)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 8 }
  }

  func reads(_ model: RoadmapModel, on engine: SteppedEngine, until holds: (RoadmapModel) -> Bool) async {
    for _ in 0..<100 where !holds(model) {
      await engine.settleViews()
      model.observe()
    }
    #expect(holds(model))
  }

  func step(_ label: String, in model: RoadmapModel) throws -> String {
    try #require(model.shown?.tree.index.nodes.first { $0.label == label }?.id)
  }

  // Each step's name with the hue it wears, in the roadmap's order.
  func hues(_ model: RoadmapModel) -> [String] {
    model.shown?.tree.index.nodes.map { "\($0.label) \($0.color)" } ?? []
  }

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  // Roadmap · iOS 02.10, 02.11 and 02.11b: Select in a row's menu starts with that row chosen; Recolor moves every step
  // chosen to the kind picked in one gesture, the selection ends, and the band holds its Undo for six seconds, which
  // takes the whole gesture back. A pick every step chosen wears already writes nothing and keeps the selection.
  @Test func recolorMovesEveryStepChosenInOneGestureWithItsUndo() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    try await learnToSail(model, on: engine, runner)
    let (tie, triangle) = (try step("Tie a bowline", in: model), try step("Sail a triangle", in: model))

    model.startSelecting(tie, from: .menu)
    let selection = try #require(model.selection)
    selection.steps.insert(triangle)
    selection.recolor("olive")
    #expect(model.selection === selection && model.band == nil)

    selection.recolor("sky")
    #expect(model.selection == nil)
    #expect(model.band?.says == .recolored(count: 2) && model.band?.undo?.held == false && model.band?.lasts == .seconds(6))
    #expect(RoadmapModel.Band.Says.recolored(count: 2).words == "2 steps recolored")
    await reads(model, on: engine) { $0.shown?.step(tie)?.step.color == "sky" }
    #expect(hues(model).filter { $0.hasPrefix("Tie") || $0.hasPrefix("Sail a") }.sorted() == ["Sail a triangle sky", "Tie a bowline sky"])

    model.undo()
    await reads(model, on: engine) { $0.shown?.step(tie)?.step.color == "olive" }
    #expect(hues(model).filter { $0.hasPrefix("Tie") || $0.hasPrefix("Sail a") }.sorted() == ["Sail a triangle olive", "Tie a bowline olive"])
    #expect(told(telemetry).filter { $0.contains("select") || $0.contains("bulk") || $0.hasPrefix("roadmap_board_undo") } == [
      "roadmap_board_select door=menu step=start", "roadmap_board_bulk count=2-5 step=recolor", "roadmap_board_select step=end via=act",
      "roadmap_board_undo act=recolor outcome=ok",
    ])
  }

  // 02.10b and 02.10c: Delete N Steps asks once with what it costs, the steps outside the choice that follow one in it;
  // answered, the steps go in one gesture the engine holds, the selection ends, and Undo brings every one back. Closed
  // unanswered, nothing goes and the selection stays.
  @Test func deleteNStepsAsksWithItsCostAndHoldsTheStepsWithOneUndo() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    try await learnToSail(model, on: engine, runner)
    let (tie, triangle) = (try step("Tie a bowline", in: model), try step("Sail a triangle", in: model))
    model.startSelecting(nil, from: .tool)
    let selection = try #require(model.selection)
    selection.steps = [triangle, tie]

    selection.askDelete()
    guard case .steps(let rows, let followers)? = model.question else {
      Issue.record("Delete N Steps asked nothing")
      return
    }
    #expect(rows.map(\.step.label).sorted() == ["Sail a triangle", "Tie a bowline"] && followers == 1)
    #expect(DeleteStepsQuestion.cost(steps: 2, followers: 1) == "Removes 2 steps · 1 branch resplices")
    model.answer(delete: false)
    #expect(model.question == nil && model.selection === selection && model.shown?.board.overall.total == 8)

    selection.askDelete()
    model.answer(delete: true)
    #expect(model.selection == nil && model.band?.says == .deletedSteps(count: 2) && model.band?.undo?.held == true)
    await reads(model, on: engine) { $0.shown?.board.overall.total == 6 }
    #expect(model.shown?.groups.map { "\($0.id.rawValue): " + $0.rows.map(\.step.label).joined(separator: ", ") } == [
      "upNext: Read the wind", "locked: Leave the dock, Sail solo", "done: Rig the boat, Name the boat parts, Choose a sailing course",
    ])
    model.undo()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 8 }
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_board_delete") || $0.hasPrefix("roadmap_board_bulk") || $0.hasPrefix("roadmap_board_undo") } == [
      "roadmap_board_delete step=cancel view=board", "roadmap_board_delete step=confirm view=board",
      "roadmap_board_delete door=bulk step=held view=board", "roadmap_board_bulk count=2-5 step=delete", "roadmap_board_undo act=delete outcome=ok",
    ])
  }

  // 02.12: a choice that holds the roadmap's one starting step cannot be deleted, which the band says once as the
  // choice comes to hold it; Recolor still works.
  @Test func aChoiceHoldingTheStartingStepCanBeRecoloredAndNotDeleted() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    try await learnToSail(model, on: engine, runner)
    let every = Set(try #require(model.shown).groups.flatMap { $0.rows.map(\.id) })
    model.startSelecting(try step("Read the wind", in: model), from: .menu)
    let selection = try #require(model.selection)

    selection.steps = every
    #expect(selection.takesEveryStart && model.band?.says == .refused(.keepsStartingStep) && model.band?.undo == nil)
    selection.steps.remove(try step("Sail solo", in: model))
    selection.askDelete()
    #expect(model.question == nil)
    selection.recolor("plum")
    await reads(model, on: engine) { $0.shown?.tree.index.nodes.first?.color == "plum" }
    #expect(hues(model).filter { !$0.hasSuffix(" plum") } == ["Sail solo gold"])
    #expect(told(telemetry).filter { $0.contains("delete_refused") } == ["roadmap_board_bulk reason=last_root step=delete_refused"])
  }

  // 02.12: a selection that starts on the roadmap's one starting step says at once why Delete is dimmed, once.
  @Test func aSelectionStartedOnTheOnlyStartingStepSaysWhyDeleteIsDimmed() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    try await learnToSail(model, on: engine, runner)
    let start = try #require(model.shown?.keptStep)

    model.startSelecting(start, from: .menu)
    #expect(model.selection?.takesEveryStart == true && model.band?.says == .refused(.keepsStartingStep) && model.band?.undo == nil)
    model.selection?.steps.insert(try step("Read the wind", in: model))
    #expect(told(telemetry).filter { $0.contains("roadmap_board_select") || $0.contains("delete_refused") } == [
      "roadmap_board_select door=menu step=start", "roadmap_board_bulk reason=last_root step=delete_refused",
    ])
  }

  // Select All takes the steps whose rows the Board shows: Done, folded at rest, keeps its steps out of it, as the web's
  // selection takes only the cards its columns show; once Done is open it takes them too. Deselect All chooses none.
  @Test func selectAllTakesTheStepsWhoseRowsTheBoardShows() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let model = room(engine, runner, memory)
    try await learnToSail(model, on: engine, runner)
    let labels = { (steps: Set<String>) -> [String] in
      (model.shown?.tree.index.nodes ?? []).filter { steps.contains($0.id) }.map { $0.label }
    }
    model.startSelecting(nil, from: .tool)
    let selection = try #require(model.selection)

    selection.selectAll()
    #expect(labels(selection.steps).sorted() == ["Leave the dock", "Read the wind", "Sail a triangle", "Sail solo", "Tie a bowline"])
    #expect(selection.holdsEveryShown && !selection.takesEveryStart)
    selection.selectAll()
    #expect(selection.steps.isEmpty)
    model.folded.remove(.done)
    selection.selectAll()
    #expect(selection.steps.count == 8 && selection.takesEveryStart)
  }

  // The steps chosen are what the Board shows: a step it stops showing is chosen no longer, and the selection ends once
  // another roadmap opens.
  @Test func aStepTheBoardStopsShowingLeavesTheSelection() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let model = room(engine, runner, memory)
    try await learnToSail(model, on: engine, runner)
    let (tie, wind) = (try step("Tie a bowline", in: model), try step("Read the wind", in: model))
    model.startSelecting(tie, from: .menu)
    let selection = try #require(model.selection)
    selection.steps.insert(wind)
    model.reading.toggle("olive")
    let open = try #require(model.shown)
    selection.keep(Set(model.reading.shown(in: open).groups.flatMap { $0.rows.map(\.id) }))
    #expect(selection.steps == [tie])

    guard case .committed(let other, _) = try runner.runAct(CreateRoadmap(title: "Learn Rust")) else {
      Issue.record("Learn Rust was not created")
      return
    }
    await reads(model, on: engine) { $0.roadmaps.count == 2 }
    model.open(other.tree.description, from: .menu)
    await reads(model, on: engine) { $0.shown?.listed.title == "Learn Rust" }
    #expect(model.selection == nil)
  }
}
