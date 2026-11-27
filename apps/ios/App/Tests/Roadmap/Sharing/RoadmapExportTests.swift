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

// Export (Roadmap on iOS §7.3; Roadmap · iOS 09.3, 07.11b) over a phone's engine in step mode: the open roadmap written as
// the room shows it, the file the exporter is handed, what the exporter came to, and a file written where a launch names it,
// which New Roadmap's grammar reads back to the same steps.
@Suite(.serialized) @MainActor struct RoadmapExportTests {
  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-export-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: TelemetryRecorder,
            exportFile: @escaping @MainActor () -> URL? = { nil }) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                 telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) }, exportFile: exportFile)
  }

  func settle(_ engine: SteppedEngine, _ model: RoadmapModel, until done: () -> Bool) async {
    for _ in 0..<200 where !done() {
      await engine.settleViews()
      model.observe()
      await Task.yield()
    }
  }

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock {
      $0.filter { ["roadmap_export", "client_error"].contains($0.name) }
        .map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" }
    }
  }

  // The boards' *Learn to sail*, three steps done, its *Read the wind* sharing a link: the file the exporter is handed is
  // named as the roadmap and holds every step under the first it follows, its kind, description, link and mark.
  @Test func exportHandsTheExporterTheOpenRoadmapAsTheRoomShowsItAndTellsWhatTheExporterCameTo() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    try RoadmapFixture.write("Sundays with Maya.", on: sail.tree, by: runner)
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await settle(engine, model) { model.shown != nil }

    model.export(from: .menu)
    let file = try #require(model.exporting)
    #expect(file.name == "Learn to sail" && file.door == .menu)
    #expect(file.text == """
      # Learn to sail
      <!-- windmill:roadmap 2 -->
      <!-- windmill:guide -->
      > Sundays with Maya.
      <!-- /windmill:guide -->
      - [x] Choose a sailing course <!-- windmill:kind terracotta Build -->
        > Pick a beginner course near you.
        - [x] Name the boat parts <!-- windmill:kind sky -->
          > Hull, mast, boom, sheets and tiller.
          - [x] Rig the boat <!-- windmill:kind terracotta Build -->
            > Step the mast and run the sheets.
            - Leave the dock
              > Cast off safely and steer clear of the dock.
              > needs also: Read the wind
              - Sail a triangle <!-- windmill:kind olive Learn -->
                > Practise reaching, tacking and returning to start.
                - Sail solo <!-- windmill:kind gold Milestone -->
                  > Plan and sail a short route on your own.
                  > needs also: Tie a bowline
          - Read the wind <!-- windmill:kind sky -->
            > Learn to spot shifts in wind direction from the water, the telltales and the flag.
            <https://metoffice.gov.uk/weather/guides/coast-and-sea/beaufort-scale>
          - Tie a bowline <!-- windmill:kind olive Learn -->
            > Tie a secure loop that is easy to undo, then practise it with your eyes closed.
      """)
    model.exported(.success(URL(fileURLWithPath: "/saved/Learn to sail.md")))
    #expect(model.exporting == nil)
    model.export(from: .menu)
    model.exported(nil)
    model.export(from: .menu)
    model.exported(.failure(CocoaError(.fileWriteOutOfSpace)))
    model.exported(nil)
    #expect(told(telemetry) == [
      "roadmap_export door=menu step=open", "roadmap_export door=menu outcome=saved",
      "roadmap_export door=menu step=open", "roadmap_export door=menu outcome=cancelled",
      "roadmap_export door=menu step=open", "roadmap_export door=menu outcome=failed",
      "client_error failure_kind=storage operation=roadmap_export",
    ])
  }

  // A launch that names the file writes it there, and the plan grammar reads it back to the roadmap's steps and marks. A
  // roadmap gone into, a step's subtree, exports its own steps from its … menu, under its step's name.
  @Test func aFileWrittenWhereALaunchNamesItReadsBackToTheSameStepsAndASubtreeExportsItsOwn() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    let wind = try #require(sail.steps.first { $0.key == "read" }?.id)
    guard case .committed(let made, _) = try runner.runAct(CreateSubtree(tree: sail.tree, step: wind)),
          case .committed = try runner.runAct(CreateStep(tree: made.subtree, step: RoadmapStep.Changes(label: "Watch the telltales"))),
          case .committed = try runner.runAct(CreateStep(tree: made.subtree, step: RoadmapStep.Changes(label: "Feel the gusts"))) else {
      Issue.record("the subtree was not made")
      return
    }
    engine.sync()
    let named = URL.temporaryDirectory.appending(path: "export-\(UUID().uuidString).md")
    defer { try? FileManager.default.removeItem(at: named) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry, exportFile: { named })
    model.roomOpened()
    await settle(engine, model) { model.shown != nil }

    model.export(from: .menu)
    #expect(model.exporting == nil)
    let plan = RoadmapPlan(reading: try String(contentsOf: named, encoding: .utf8), over: [])
    #expect(plan.title == "Learn to sail")
    #expect(plan.nodes.map { "\($0.label)\($0.done ? " done" : "")" } == [
      "Choose a sailing course done", "Name the boat parts done", "Rig the boat done", "Leave the dock", "Sail a triangle", "Sail solo",
      "Read the wind", "Tie a bowline",
    ])

    let row = try #require(model.shown?.step(wind.description))
    model.goIn(row, by: .step)
    let inside = try #require(model.inside)
    await settle(engine, inside) { inside.shown != nil }
    #expect(inside.shown?.id == made.subtree)
    inside.export(from: .more)
    let subtree = RoadmapPlan(reading: try String(contentsOf: named, encoding: .utf8), over: [])
    #expect(inside.shown?.tree.index.nodes.map(\.label) == ["Watch the telltales", "Feel the gusts"])
    #expect(subtree.title == "Read the wind" && subtree.nodes.map(\.label) == ["Watch the telltales", "Feel the gusts"])
    #expect(told(telemetry) == [
      "roadmap_export door=menu step=open", "roadmap_export door=menu outcome=saved",
      "roadmap_export door=more step=open", "roadmap_export door=more outcome=saved",
    ])
  }
}
