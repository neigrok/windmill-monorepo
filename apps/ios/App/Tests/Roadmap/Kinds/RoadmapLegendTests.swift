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

@Suite(.serialized) @MainActor struct RoadmapLegendTests {
  // A phone never signed in: its engine in step mode, the runner roadmap's actions take, and what the phone remembers.
  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: nil,
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-legend-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views, with *Learn to sail* open; a band's time never ends unless a test ends it.
  func learnToSail(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) async throws -> RoadmapModel {
    try RoadmapFixture.plantLearnToSail(runner)
    let model = RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                             telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
    model.roomOpened()
    await reads(model, on: engine) { $0.shown?.board.overall.total == 8 }
    return model
  }

  func reads(_ model: RoadmapModel, on engine: SteppedEngine, until holds: (RoadmapModel) -> Bool) async {
    for _ in 0..<100 where !holds(model) {
      await engine.settleViews()
      model.observe()
    }
    #expect(holds(model))
  }

  // The legend as the Kinds sheet lists it: each entry's name, hue, description and how many steps wear it.
  func entries(_ model: RoadmapModel) -> [String] {
    model.shown?.legend.entries.map { "\($0.name) \($0.hue) \($0.steps)\($0.description.isEmpty ? "" : " · " + $0.description)" } ?? []
  }

  func entry(_ name: String, in model: RoadmapModel) throws -> RoadmapLegend.Entry {
    try #require(model.shown?.legend.entries.first { $0.name == name })
  }

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  // Roadmap · iOS 06.1, 05.2 and 02.7: the legend is read once with the roadmap: the kinds that own their hues in the
  // roadmap's order, then the hue steps wear that no kind names, each with how many steps wear it. The step form's six
  // kinds, Recolor's and the filter's kinds in use are that one value, and the form's Kind list reads it.
  @Test func theLegendIsTheKindsThenTheHuesStepsWearUnnamedWithTheirSteps() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let model = try await learnToSail(engine, runner, memory)
    let legend = try #require(model.shown?.legend)
    #expect(entries(model) == ["Build terracotta 3 · Things you make", "Learn olive 2 · Things you figure out", "Milestone gold 1 · Moments that matter",
                               "Sky sky 2"])
    #expect(legend.entries.map(\.id) == [.kind("build"), .kind("learn"), .kind("milestone"), .hue("sky")])
    #expect(legend.choices.map(\.name) == ["Build", "Learn", "Milestone", "Brick", "Sky", "Plum"])
    #expect(legend.inUse.map(\.name) == ["Build", "Learn", "Milestone", "Sky"] && legend.freeHue == "brick")
    #expect(legend.entries.map(\.removable) == [false, false, false, false])

    model.newStep(from: .foot)
    #expect(try #require(model.draft).kinds.map(\.name) == legend.choices.map(\.name))
  }

  // 06.3, 06.4 and 10.6b: Add Kind makes a kind at once on the next free hue, called by its hue until it is named; a name
  // and a description are written as their field leaves them, as far as the domain takes them; once every hue is had
  // there is no free hue, and a hue another entry has cannot be taken.
  @Test func addKindTakesTheNextFreeHueUntilEveryHueIsHad() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = try await learnToSail(engine, runner, memory, telemetry: telemetry)

    let practice = try #require(model.addKind())
    await reads(model, on: engine) { $0.shown?.legend.entries.count == 5 }
    #expect(entries(model) == ["Build terracotta 3 · Things you make", "Learn olive 2 · Things you figure out", "Milestone gold 1 · Moments that matter",
                               "Brick brick 0", "Sky sky 2"])
    let named = model.name(practice, "Practice on the water every day")
    await reads(model, on: engine) { $0.shown?.legend.entry(named)?.name != "Brick" }
    #expect(named == practice)
    _ = model.describe(practice, "Hours on the water")
    _ = model.describe(practice, "Hours on the water")
    await reads(model, on: engine) { $0.shown?.legend.entry(practice)?.description == "Hours on the water" }
    #expect(entries(model)[3] == "Practice on the water ev brick 0 · Hours on the water")

    let safety = try #require(model.addKind())
    await reads(model, on: engine) { $0.shown?.legend.entries.count == 6 }
    #expect(model.shown?.legend.entry(safety)?.hue == "plum" && model.shown?.legend.freeHue == nil)
    #expect(model.addKind() == nil)
    #expect(model.recolour(.kind("learn"), to: "brick") == .kind("learn"))
    await engine.settleViews()
    model.observe()
    #expect(try entry("Learn", in: model).hue == "olive")
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_board_edit") } == [
      "roadmap_board_edit legend=add step=saved", "roadmap_board_edit legend=rename step=saved", "roadmap_board_edit legend=describe step=saved",
      "roadmap_board_edit legend=add step=saved",
    ])
  }

  // 06.2 and 06.6: a free hue chosen for a kind recolors the kind and every step that wore it, with no band; a hue no
  // kind names moves its steps to the new hue; and a name given to such a hue makes it a kind wearing that hue.
  @Test func aFreeHueRecolorsTheKindAndEveryStepThatWearsIt() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let model = try await learnToSail(engine, runner, memory)
    let steps = { () -> [String] in model.shown?.tree.index.nodes.map { "\($0.label) \($0.color)" } ?? [] }

    #expect(model.recolour(.kind("learn"), to: "plum") == .kind("learn"))
    await reads(model, on: engine) { $0.shown?.legend.entry(.kind("learn"))?.hue == "plum" }
    #expect(model.band == nil)
    #expect(steps().filter { $0.hasSuffix("plum") }.sorted() == ["Sail a triangle plum", "Tie a bowline plum"])
    #expect(model.shown?.step(model.shown?.tree.index.nodes.first { $0.label == "Tie a bowline" }?.id ?? "")?.colour == "Learn")

    #expect(model.recolour(.hue("sky"), to: "olive") == .hue("olive"))
    await reads(model, on: engine) { $0.shown?.legend.entry(.hue("olive")) != nil }
    #expect(steps().filter { $0.hasSuffix("olive") }.sorted() == ["Name the boat parts olive", "Read the wind olive"])
    let weather = model.name(.hue("olive"), "Weather")
    await reads(model, on: engine) { $0.shown?.legend.entry(weather)?.name == "Weather" }
    #expect(entries(model) == ["Build terracotta 3 · Things you make", "Learn plum 2 · Things you figure out", "Milestone gold 1 · Moments that matter",
                               "Weather olive 2"])
  }

  // 06.5 and 06.5b: only a kind no step wears is removed, at once with no question, and the band says so with Undo for
  // six seconds, which brings it back.
  @Test func onlyAKindNoStepWearsIsRemovedAndUndoBringsItBack() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = try await learnToSail(engine, runner, memory, telemetry: telemetry)
    let practice = try #require(model.addKind())
    await reads(model, on: engine) { $0.shown?.legend.entries.count == 5 }
    _ = model.name(practice, "Practice")
    await reads(model, on: engine) { $0.shown?.legend.entry(practice)?.name == "Practice" }

    #expect(!model.remove(.kind("build")) && model.band == nil)
    #expect(model.remove(practice))
    #expect(model.band?.says == .removedKind("Practice") && model.band?.undo?.held == false && model.band?.lasts == .seconds(6))
    #expect(RoadmapModel.Band.Says.removedKind("Practice").words == "Practice removed")
    await reads(model, on: engine) { $0.shown?.legend.entries.count == 4 }
    model.undo()
    await reads(model, on: engine) { $0.shown?.legend.entries.count == 5 }
    #expect(entries(model)[3] == "Practice brick 0")
    #expect(told(telemetry).filter { $0.contains("legend=remove") || $0.hasPrefix("roadmap_board_undo") } == [
      "roadmap_board_edit legend=remove step=saved", "roadmap_board_undo act=removeKind outcome=ok",
    ])
  }

  // 06.5 against a screen drawn a moment before: a kind a step has come to wear is not removed, as the web's legend reads
  // its live steps against a stale click, and the sheet keeps the row of a removal that wrote nothing.
  @Test func aRemoveOfAKindAStepHasComeToWearIsRefused() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = try await learnToSail(engine, runner, memory, telemetry: telemetry)
    let brick = try #require(model.addKind())
    await reads(model, on: engine) { $0.shown?.legend.entry(brick)?.removable == true }
    let open = try #require(model.shown)
    let tie = try #require(open.tree.index.nodes.first { $0.label == "Tie a bowline" })
    guard case .committed = try runner.runAct(ChangeStep(tree: open.id, step: ID(RecordID(tie.id)), changes: RoadmapStep.Changes(color: "brick"))) else {
      Issue.record("Tie a bowline was not recolored")
      return
    }
    await reads(model, on: engine) { $0.shown?.legend.entry(brick)?.steps == 1 }

    #expect(!model.remove(brick))
    #expect(model.band == nil && entries(model).contains("Brick brick 1"))
    #expect(told(telemetry).filter { $0.contains("legend=remove") }.isEmpty)
  }

  // 06.2 and 06.6: a name or a colour given to a hue no kind names moves its page to an entry the legend holds only once
  // the phone's copy is read again; until then the page draws the entry it read last, so its form and the keyboard stay.
  @Test func aKindsPageDrawsTheEntryItReadUntilTheLegendHoldsTheOneItMovedTo() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let model = try await learnToSail(engine, runner, memory)
    let page = RoadmapKindPage.LastRead()
    var subject = RoadmapLegend.Subject.hue("sky")
    #expect(page.read(model.shown?.legend.entry(subject))?.name == "Sky")

    subject = model.name(subject, "Weather")
    #expect(model.shown?.legend.entry(subject) == nil)
    #expect(page.read(model.shown?.legend.entry(subject)).map { "\($0.id) \($0.name)" } == "hue(\"sky\") Sky")
    await reads(model, on: engine) { $0.shown?.legend.entry(subject) != nil }
    #expect(page.read(model.shown?.legend.entry(subject)).map { "\($0.id) \($0.name)" } == "\(subject) Weather")

    subject = model.recolour(subject, to: "plum")
    #expect(page.read(model.shown?.legend.entry(subject))?.hue == "sky")
    await reads(model, on: engine) { $0.shown?.legend.entry(subject)?.hue == "plum" }
    #expect(page.read(model.shown?.legend.entry(subject))?.hue == "plum")
  }

  // Add Kind ends the band standing over the sheet first, so the Undo of a kind removed a moment before cannot bring it
  // back onto the hue Add Kind takes, leaving two kinds on one hue.
  @Test func addKindEndsTheUndoOfAKindRemovedBeforeIt() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let model = try await learnToSail(engine, runner, memory)
    let practice = try #require(model.addKind())
    await reads(model, on: engine) { $0.shown?.legend.entries.count == 5 }
    _ = model.name(practice, "Practice")
    await reads(model, on: engine) { $0.shown?.legend.entry(practice)?.name == "Practice" }
    #expect(model.remove(practice) && model.band?.undo != nil)
    await reads(model, on: engine) { $0.shown?.legend.entries.count == 4 }

    let added = try #require(model.addKind())
    #expect(model.band == nil)
    await reads(model, on: engine) { $0.shown?.legend.entry(added) != nil }
    model.undo()
    await engine.settleViews()
    model.observe()
    #expect(entries(model) == ["Build terracotta 3 · Things you make", "Learn olive 2 · Things you figure out", "Milestone gold 1 · Moments that matter",
                               "Brick brick 0", "Sky sky 2"])
    #expect(model.shown?.legend.entry(added)?.hue == "brick")
  }

  // 01.3 and 05.2: the sheet opens from the title menu or the form's Edit Kinds, each told, and closes once.
  @Test func theKindsSheetOpensFromTheMenuOrTheFormAndIsToldEachWay() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let model = try await learnToSail(engine, runner, memory, telemetry: telemetry)
    model.openKinds(from: .menu)
    #expect(model.kindsDoor == .menu)
    model.kindOpened()
    model.closeKinds()
    model.closeKinds()
    model.openKinds(from: .form)
    #expect(model.kindsDoor == .form)
    #expect(told(telemetry).filter { $0.hasPrefix("roadmap_kinds") } == [
      "roadmap_kinds door=menu step=open", "roadmap_kinds step=kind", "roadmap_kinds step=close", "roadmap_kinds door=form step=open",
    ])
  }
}
