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

@Suite(.serialized) @MainActor struct NewRoadmapDraftTests {
  // A phone's engine in step mode on the model server, signed out, the runner roadmap's actions take, and what the phone
  // remembers.
  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: nil,
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "new-roadmap-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views; a band's time never ends unless a test ends it.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                 telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
  }

  func reads(_ model: RoadmapModel, on engine: SteppedEngine, until holds: (RoadmapModel) -> Bool) async {
    for _ in 0..<100 where !holds(model) {
      await engine.settleViews()
      model.observe()
    }
    #expect(holds(model))
  }

  // The open roadmap's Board as its rows tell it: its progress, then each group with its steps' labels in order.
  func board(_ model: RoadmapModel) -> [String] {
    guard let open = model.shown else { return [] }
    return ["\(open.listed.title ?? "") \(open.board.overall.done) of \(open.board.overall.total)"] + open.groups.map { (group: RoadmapModel.Group) -> String in
      "\(group.id.rawValue): " + group.rows.map(\.step.label).joined(separator: ", ")
    }
  }

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  // Roadmap · iOS 01.5 and 01.6: Cancel writes nothing; a name alone plants a blank roadmap with its one starting step,
  // named as the roadmap and kept, and the room opens it once the phone's copy holds it, in place of the one it had open.
  // The field holds no more of a name than the domain takes, and the engine keeps no Undo of a birth.
  @Test func aNameAlonePlantsOneStepNamedAsTheRoadmapAndTheRoomOpensIt() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await reads(model, on: engine) { if case .empty = $0.phase { true } else { false } }

    model.nameRoadmap(from: .empty)
    try #require(model.newRoadmap).cancel()
    #expect(model.newRoadmap == nil)

    model.nameRoadmap(from: .empty)
    let cook = try #require(model.newRoadmap)
    #expect(!cook.creates)
    cook.name = "  Learn to cook \n"
    cook.create()
    #expect(model.newRoadmap == nil && model.band == nil && engine.undoOffers().isEmpty)
    await reads(model, on: engine) { self.board($0) == ["Learn to cook 0 of 1", "upNext: Learn to cook"] }
    let start = try #require(model.shown?.groups.first?.rows.first)
    #expect(start.kind?.label == "Build" && start.step.icon == "sparkles" && start.completes && !start.deletes)
    #expect(memory.string(forKey: RoadmapModel.lastOpen) == model.shown?.listed.id)

    model.path = [.roadmaps]
    model.nameRoadmap(from: .list)
    let long = try #require(model.newRoadmap)
    long.name = String(repeating: "a", count: 201)
    #expect(long.name.count == 200)
    long.create()
    #expect(model.path.isEmpty)
    await reads(model, on: engine) { $0.shown?.listed.title == String(repeating: "a", count: 200) }
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_sheet door=empty step=new", "roadmap_board_create door=blank step=cancel", "roadmap_sheet door=empty step=new",
      "birth count=1 door=blank", "roadmap_sheet step=open", "roadmap_sheet door=list step=new", "birth count=1 door=blank",
    ])
  }

  // Roadmap · iOS 01.8 and 01.8b: a copied plan is read back before anything is planted, named by its first line, with
  // the grammar's counts and its steps in the states they will land in; Create plants its steps, links and kinds, marks
  // the steps it brings done, opens it and says what it planted, with no Undo.
  @Test func aCopiedPlanIsReadBackThenPlantedWithItsDoneMarks() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    model.nameRoadmap(from: .empty)
    let draft = try #require(model.newRoadmap)

    draft.read("Summer cruise\n- [x] Pick the week\n- [x] Book the boat\n  - Plan the route\n    Out by the north channel.\n## Sea\n- Cast off", from: .paste)
    let plan = try #require(draft.read?.plan)
    #expect(draft.name == "Summer cruise" && draft.creates)
    #expect([plan.readout.steps, plan.readout.branches, plan.readout.done, plan.imperfections.notes] as [Int] == [6, 1, 2, 1])
    #expect(draft.landing.map { "\($0.label) \($0.state.rawValue)" } == [
      "Summer cruise available", "Pick the week complete", "Book the boat complete", "Plan the route available", "Sea locked", "Cast off locked",
    ])

    draft.create()
    #expect(model.newRoadmap == nil && model.band?.says == RoadmapModel.Band.Says.planted(steps: 6, done: 2) && model.band?.undo == nil && engine.undoOffers().isEmpty)
    await reads(model, on: engine) { Array(self.board($0).prefix(3)) == ["Summer cruise 2 of 6", "upNext: Summer cruise, Plan the route", "locked: Sea, Cast off"] }
    let open = try #require(model.shown)
    #expect(Set(open.groups.last?.rows.map(\.step.label) ?? []) == ["Pick the week", "Book the boat"])
    #expect(open.tree.index.nodes.first { $0.label == "Plan the route" }?.description == "Out by the north channel.")
    #expect(open.legend.entries.map(\.name) == ["Sea", "Learn", "Milestone"])
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_sheet door=empty step=new", "roadmap_board_create door=import step=read", "birth count=6-20 door=import",
    ])
  }

  // A name typed before the plan arrives names the roadmap and the step that stands for the plan's own; Clear returns to
  // Start from and takes back only a name the plan gave.
  @Test func aTypedNameNamesThePlanAndClearTakesBackOnlyThePlansName() throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.nameRoadmap(from: .menu)
    let draft = try #require(model.newRoadmap)
    draft.name = "My trip"
    draft.read("Summer cruise\n- Cast off", from: .paste)
    #expect(draft.name == "My trip" && draft.planting?.creation.title == "My trip" && draft.landing.map(\.label) == ["My trip", "Cast off"])
    draft.clear()
    #expect(draft.read == nil && draft.name == "My trip")

    draft.name = ""
    draft.read("- Cast off\n- Raise the sail", from: .paste)
    #expect(draft.name == "" && !draft.creates && draft.landing.map(\.label) == ["", "Cast off", "Raise the sail"])
    draft.read("Summer cruise", from: .paste)
    draft.clear()
    #expect(draft.name == "" && !draft.creates)
    #expect(told(telemetry) == [
      "roadmap_sheet door=menu step=new", "roadmap_board_create door=import step=read", "roadmap_board_create door=import step=clear",
      "roadmap_board_create door=import step=read", "roadmap_board_create door=import step=read", "roadmap_board_create door=import step=clear",
    ])
    _ = engine
  }

  // Roadmap · iOS 01.8c: a file is read as the web reads one, its byte order mark dropped; one that cannot be opened is
  // said in Start from's footer by its name, reads nothing, and reports with no name.
  @Test func aFileIsReadAsTheWebReadsOneAndOneThatCannotBeOpenedIsSaid() throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.nameRoadmap(from: .menu)
    let draft = try #require(model.newRoadmap)
    let folder = URL.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }

    draft.read(file: .success(folder.appending(path: "Sailing plan.md")))
    #expect(draft.read == nil && draft.unread == "Sailing plan.md")
    let file = folder.appending(path: "plan.md")
    try Data([0xEF, 0xBB, 0xBF] + Array("# Sailing\n- Rig the boat\n- Read the wind \u{FF}".utf8) + [0xFF]).write(to: file)
    draft.read(file: .success(file))
    #expect(draft.unread == nil && draft.read?.source == .file && draft.name == "Sailing")
    #expect(draft.landing.map(\.label) == ["Sailing", "Rig the boat", "Read the wind \u{FF}\u{FFFD}"])
    #expect(told(telemetry) == [
      "roadmap_sheet door=menu step=new", "roadmap_board_create door=file step=unread", "client_error failure_kind=unexpected operation=roadmap_file",
      "roadmap_board_create door=file step=read",
    ])
    _ = engine
  }
}
