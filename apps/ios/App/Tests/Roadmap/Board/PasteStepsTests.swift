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

@Suite(.serialized) @MainActor struct PasteStepsTests {
  // A phone's engine in step mode on the model server, the runner roadmap's actions take, and what the phone remembers.
  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "paste-steps-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views with a clipboard that holds `copied`, or holds text it will not hand over
  // where `allowed` is false; a band's time never ends unless a test ends it.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry, copied: String?,
            allowed: Bool = true) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                 telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) },
                 clipboard: Clipboard(holdsText: { copied != nil }, text: { allowed ? copied : nil }))
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

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  // Roadmap · iOS 02.16b and 02.16c: a clipboard with no text says so, and the room asks the system for nothing; a read
  // the person did not allow says so with Settings. Neither reads anything back.
  @Test func aClipboardWithNoTextAndAPasteNotAllowedAreSaidInTheBand() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let empty = room(engine, runner, memory, telemetry: telemetry, copied: nil)
    try await learnToSail(empty, on: engine, runner)
    await empty.pasteSteps()
    #expect(empty.pasting == nil && empty.band?.says == .noText && empty.band?.undo == nil)
    let whitespace = room(engine, runner, memory, telemetry: telemetry, copied: " \n\t")
    whitespace.roomOpened()
    await reads(whitespace, on: engine) { $0.shown != nil }
    await whitespace.pasteSteps()
    #expect(whitespace.pasting == nil && whitespace.band?.says == .noText)

    let refused = room(engine, runner, memory, telemetry: telemetry, copied: "- Rig the boat", allowed: false)
    refused.roomOpened()
    await reads(refused, on: engine) { $0.shown != nil }
    await refused.pasteSteps()
    #expect(refused.pasting == nil && refused.band?.says == .pasteRefused)
    refused.openedSettings()
    #expect(refused.band == nil)
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_board_create") } == [
      "roadmap_board_create door=paste reason=empty step=unread", "roadmap_board_create door=paste reason=empty step=unread",
      "roadmap_board_create door=paste reason=denied step=unread", "roadmap_board_create door=paste step=settings",
    ])
  }

  // Roadmap · iOS 02.17 and 02.18, R-15: the copied list is read back under the roadmap's starting step in the states
  // its steps will land in; Add writes them, with the marks the list brings done and the kind its heading adds, as one
  // act whose Undo takes the whole paste back; Cancel writes nothing.
  @Test func pastedStepsAreReadBackThenAddedWithTheirMarksAndOneUndoTakesThemBack() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry, copied: "## Day sail\n- [x] Check the forecast\n- Plan the passage\n  - Pack the boat")
    try await learnToSail(model, on: engine, runner)

    await model.pasteSteps()
    try #require(model.pasting).cancel()
    #expect(model.pasting == nil && model.shown?.board.overall.total == 8)

    await model.pasteSteps()
    let pasted = try #require(model.pasting)
    #expect(pasted.landing.map { "\($0.label) \($0.state.rawValue)" } == [
      "Day sail available", "Check the forecast complete", "Plan the passage locked", "Pack the boat locked",
    ])
    #expect([pasted.plan.readout.branches, pasted.graft.done.count, pasted.plan.imperfections.notes] as [Int] == [1, 1, 0])
    pasted.add()
    #expect(model.pasting == nil && model.band?.says == RoadmapModel.Band.Says.added(steps: 4) && model.band?.undo != nil && model.band?.arrived.count == 4)
    await reads(model, on: engine) { $0.shown?.board.overall.total == 12 && $0.shown?.board.overall.done == 4 }
    let open = try #require(model.shown)
    let start = try #require(open.tree.index.nodes.first { $0.label == "Choose a sailing course" })
    let day = try #require(open.tree.index.nodes.first { $0.label == "Day sail" })
    #expect(open.graph.followed(day.id).map(\.id) == [start.id])
    #expect(open.legend.entries.first { $0.hue == day.color }?.name == "Day sail")

    model.undo()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 8 && $0.shown?.board.overall.done == 3 }
    #expect(model.shown?.legend.entries.contains { $0.name == "Day sail" } == false)
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_board_create") || $0.hasPrefix("roadmap_board_undo") } == [
      "roadmap_board_create door=paste step=open view=board", "roadmap_board_create door=paste step=cancel",
      "roadmap_board_create door=paste step=open view=board", "roadmap_board_create count=2-5 door=paste step=saved view=board",
      "roadmap_board_undo act=graft outcome=ok",
    ])
  }

  // An Add the domain refuses leaves the read-back open and says why in the room's words: here the steps are read under
  // a step the roadmap does not hold, as a step gone since the read would be. Add is not offered again, and the refusal is
  // told.
  @Test func anAddTheDomainRefusesKeepsTheReadBackOpenAndSaysWhy() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry, copied: nil)
    try await learnToSail(model, on: engine, runner)
    let open = try #require(model.shown)
    let plan = RoadmapPlan(reading: "- Check the forecast\n- Plan the passage", over: [], into: true)
    let graft = try #require(plan.graft(under: "zz", held: open.tree.nodes.map(\.id), liveKinds: []))
    let pasted = PastedSteps(plan, grafted: graft, into: open, in: model)
    model.pasting = pasted

    pasted.add()
    #expect(model.pasting === pasted && pasted.refusal?.label == "gone" && model.band == nil)
    #expect(pasted.refusal?.pasteWords == "This roadmap changed elsewhere.")
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_board_create") || $0.hasPrefix("roadmap_write_refused") } == [
      "roadmap_write_refused refusal=gone write=ImportSubgraph", "roadmap_board_create door=paste refusal=gone step=refused",
    ])
    pasted.cancel()
    #expect(model.pasting == nil)
  }
}
