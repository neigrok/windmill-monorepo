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

@Suite(.serialized) @MainActor struct BoardReadingTests {
  // A phone's engine in step mode on the model server, the runner roadmap's actions take, and what the phone remembers.
  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "board-reading-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                 telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
  }

  // *Learn to sail* with three steps completed a minute apart, so Done, newest first, has an order.
  func learnToSail(on engine: SteppedEngine, _ runner: ActionRunner) throws -> CreateRoadmap.Result {
    let planted = try RoadmapFixture.plantLearnToSail(runner, done: [])
    for step in ["choose", "parts", "rig"] {
      engine.advance(ms: 60_000)
      try RoadmapFixture.complete(step, of: planted, by: runner)
      engine.sync()
    }
    engine.advance(ms: 60_000)
    return planted
  }

  // The model reads again until the room holds what `holds` asks of it.
  func reads(_ model: RoadmapModel, on engine: SteppedEngine, until holds: (RoadmapModel) -> Bool) async {
    for _ in 0..<100 where !holds(model) {
      await engine.settleViews()
      model.observe()
    }
    #expect(holds(model))
  }

  // The Board as the reading keeps it: its first rows, each group by its steps' labels in order, or what it says when
  // nothing is left.
  func board(_ model: RoadmapModel) -> [String] {
    guard let open = model.shown else { return ["nothing open"] }
    let shown = model.reading.shown(in: open)
    let rows = (shown.branch.map { ["branch \($0.step.label)"] } ?? []) + (shown.kinds.isEmpty ? [] : ["showing " + shown.kinds.joined(separator: ", ")])
    let groups = shown.groups.map { (group: RoadmapModel.Group) -> String in
      "\(group.id.rawValue): " + group.rows.map(\.step.label).joined(separator: ", ")
    }
    return rows + groups + (shown.groups.isEmpty ? ["nothing matches by \(shown.recovery?.rawValue ?? "nothing")"] : [])
  }

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  func step(_ label: String, in model: RoadmapModel) throws -> String {
    try #require(model.shown?.tree.index.nodes.first { $0.label == label }?.id)
  }

  // Roadmap · iOS 02.7: the order of Up next and Locked is the domain's, Roadmap Order at rest and the newest or the
  // oldest made first once chosen, steps made in one moment in the roadmap's order; Done stays newest completed first.
  // Each choice is told, and the tool's symbol fills while another order stands.
  @Test func theSortOrdersUpNextAndLockedAndLeavesDoneNewestCompletedFirst() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(on: engine, runner)
    let id = { (key: String) -> ID<RoadmapStep> in sail.steps.first { $0.key == key }!.id }
    guard case .committed = try runner.runAct(CreateStep(tree: sail.tree, step: RoadmapStep.Changes(label: "Heave to"), prerequisites: [id("parts")])) else {
      Issue.record("Heave to was not made")
      return
    }
    engine.advance(ms: 60_000)
    guard case .committed = try runner.runAct(CreateStep(tree: sail.tree, step: RoadmapStep.Changes(label: "Reef the main"), prerequisites: [id("read")])) else {
      Issue.record("Reef the main was not made")
      return
    }
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 10 }
    let done = "done: Rig the boat, Name the boat parts, Choose a sailing course"
    // The steps planted in one moment stand in the roadmap's order, as the domain's stable sort leaves them.
    let authored = { (labels: [String]) -> String in
      (model.shown?.tree.index.nodes.map(\.label) ?? []).filter { labels.contains($0) }.joined(separator: ", ")
    }
    let (planted, lockedPlanted) = (authored(["Read the wind", "Tie a bowline"]), authored(["Leave the dock", "Sail a triangle", "Sail solo"]))

    #expect(board(model) == ["upNext: Read the wind, Tie a bowline, Heave to", "locked: Leave the dock, Reef the main, Sail a triangle, Sail solo", done])
    #expect(!model.reading.narrows)
    model.reading.pick(.newest)
    #expect(board(model) == ["upNext: Heave to, " + planted, "locked: Reef the main, " + lockedPlanted, done])
    #expect(model.reading.narrows)
    model.reading.pick(.oldest)
    #expect(board(model) == ["upNext: \(planted), Heave to", "locked: \(lockedPlanted), Reef the main", done])
    model.reading.pick(.oldest)
    model.reading.pick(.roadmap)
    #expect(!model.reading.narrows)
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_board_sort") } == [
      "roadmap_board_sort sort=newest", "roadmap_board_sort sort=oldest", "roadmap_board_sort sort=roadmap",
    ])
  }

  // 02.7, 02.8 and 02.6b: the filter offers the kinds steps wear, and a kind shown keeps its steps in their groups, each
  // counting its own, a group with none left out, while the roadmap's progress stays whole. A kind no step wears any
  // more leaves the menu and stays shown, so the Board says it shows nothing until the filter is cleared.
  @Test func aKindFilterNarrowsTheGroupsAndNeverTheProgressAndOneLeftEmptySaysSo() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(on: engine, runner)
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 8 }
    let open = try #require(model.shown)
    #expect(open.legend.inUse.map { "\($0.name) \($0.hue)" } == ["Build terracotta", "Learn olive", "Milestone gold", "Sky sky"])

    model.reading.toggle("olive")
    #expect(board(model) == ["showing Learn", "upNext: Tie a bowline", "locked: Sail a triangle"])
    #expect(model.reading.narrows && "\(open.board.overall.done) of \(open.board.overall.total)" == "3 of 8")
    model.reading.toggle("sky")
    #expect(board(model) == ["showing Learn, Sky", "upNext: Read the wind, Tie a bowline", "locked: Sail a triangle", "done: Name the boat parts"])
    model.reading.clearKinds(from: .row)
    model.reading.toggle("gold")
    #expect(board(model) == ["showing Milestone", "locked: Sail solo"])

    let solo = sail.steps.first { $0.key == "solo" }!.id
    guard case .committed = try runner.runAct(ChangeStep(tree: sail.tree, step: solo, changes: RoadmapStep.Changes(color: "olive"))) else {
      Issue.record("Sail solo was not changed")
      return
    }
    await reads(model, on: engine) { $0.shown?.legend.inUse.count == 3 }
    #expect(board(model) == ["showing Milestone", "nothing matches by kinds"])
    #expect(model.shown?.legend.inUse.map(\.name) == ["Build", "Learn", "Sky"])
    model.reading.clearKinds(from: .empty)
    #expect(board(model) == ["upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                             "done: Rig the boat, Name the boat parts, Choose a sailing course"])
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_board_filter") || $0.hasPrefix("roadmap_board_clear") } == [
      "roadmap_board_filter count=1", "roadmap_board_filter count=2-5", "roadmap_board_clear from=row what=kinds", "roadmap_board_filter count=1",
      "roadmap_board_clear from=empty what=kinds",
    ])
  }

  // 02.5 and 02.6: Find keeps the steps whose name or description holds the words, in any case and without the blanks
  // around them, in their groups; words no step holds leave the Board with nothing, which offers a step of that name.
  // A search is told once, by no word of it, and closing Find looks for nothing.
  @Test func findKeepsMatchesInTheirGroupsAndTellsASearchOnce() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try learnToSail(on: engine, runner)
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 8 }

    model.reading.finds = true
    model.reading.finding = "SAIL "
    #expect(board(model) == ["locked: Sail a triangle, Sail solo", "done: Choose a sailing course"])
    #expect(model.reading.shown(in: try #require(model.shown)).finding)
    model.reading.finding = "telltales"
    #expect(board(model) == ["upNext: Read the wind"])
    model.reading.searched()
    model.reading.searched()
    model.reading.finding = "reef"
    #expect(board(model) == ["nothing matches by search"])
    #expect(model.reading.needle == "reef")
    model.reading.searched()
    model.reading.finds = false
    #expect(model.reading.finding.isEmpty && board(model).count == 3)
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_board_search") } == ["roadmap_board_search ", "roadmap_board_search "])
  }

  // 02.9: View Branch on a step's page returns to the Board, which stays in the step, what it needs and what it opens,
  // under a first row that names it; Clear leaves the branch, and a branch whose step is gone narrows nothing.
  @Test func viewBranchNarrowsTheBoardToTheStepAndWhatItNeedsAndOpens() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(on: engine, runner)
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 8 }
    let wind = try step("Read the wind", in: model)
    model.show(.graph)
    model.path = [.step(wind, by: .card)]

    model.viewBranch(of: wind)
    #expect(model.path.isEmpty && model.lens == .board)
    #expect(board(model) == ["branch Read the wind", "upNext: Read the wind", "locked: Leave the dock, Sail a triangle, Sail solo",
                             "done: Name the boat parts, Choose a sailing course"])
    #expect(!model.reading.narrows)
    model.reading.clearBranch()
    #expect(board(model).count == 3)

    model.viewBranch(of: wind)
    guard case .committed = try runner.runAct(DeleteStep(tree: sail.tree, step: ID(RecordID(wind)))) else {
      Issue.record("Read the wind was not deleted")
      return
    }
    await reads(model, on: engine) { $0.shown?.board.overall.total == 7 }
    #expect(board(model) == ["upNext: Leave the dock, Tie a bowline", "locked: Sail a triangle, Sail solo",
                             "done: Rig the boat, Name the boat parts, Choose a sailing course"])
    #expect(told(telemetry).filter { $0.contains("viewBranch") || $0.hasPrefix("roadmap_board_branch") } == [
      "roadmap_board_step_action action=viewBranch surface=document", "roadmap_board_branch action=clear",
      "roadmap_board_step_action action=viewBranch surface=document",
    ])
  }

  // The query lasts the visit, as the web's room keeps it: another roadmap opening asks nothing of it.
  @Test func anotherRoadmapOpeningStartsTheQueryOver() async throws {
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
    _ = try learnToSail(on: engine, runner)
    engine.sync()
    let model = room(engine, runner, memory)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.listed.title == "Learn to sail" }
    model.reading.pick(.newest)
    model.reading.toggle("olive")
    model.reading.view(branch: try step("Tie a bowline", in: model))
    model.reading.finds = true
    model.reading.finding = "tie"

    model.open(rust.tree.description, from: .menu)
    await reads(model, on: engine) { $0.shown?.listed.title == "Learn Rust" }
    #expect(model.reading.sort == .roadmap && model.reading.kinds.isEmpty && model.reading.branch == nil)
    #expect(!model.reading.finds && model.reading.finding.isEmpty && board(model) == ["upNext: Basics"])
  }

  // A step the form made that the query hides is shown: the kind filter that hides it is cleared, and Find's words that
  // hold it stay, as the web's room reveals a step.
  @Test func aStepMadeUnderAQueryThatHidesItIsRevealed() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(on: engine, runner)
    engine.sync()
    let model = room(engine, runner, memory)
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 8 }
    model.reading.toggle("olive")
    model.reading.finds = true
    model.reading.finding = "reef"
    guard case .committed(let reef, _) = try runner.runAct(CreateStep(tree: sail.tree, step: RoadmapStep.Changes(label: "Reef the main", color: "sky"))) else {
      Issue.record("Reef the main was not made")
      return
    }
    await reads(model, on: engine) { $0.shown?.board.overall.total == 9 }

    model.reading.reveal(reef.description, in: try #require(model.shown))
    #expect(model.reading.kinds.isEmpty && model.reading.finding == "reef")
    #expect(board(model) == ["upNext: Reef the main"])
  }
}
