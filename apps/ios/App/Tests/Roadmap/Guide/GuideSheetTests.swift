import Foundation
import Testing
import DomainKit
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct GuideSheetTests {
  // A phone's engine in step mode on the model server, the runner roadmap's actions take, and what the phone remembers.
  func phone(account: String? = "acct-1") -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: account,
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "guide-sheet-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views and its runner; a band's time never ends.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                 telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
  }

  // *Learn to sail* with the guide given, the roadmap the room opens.
  func learnToSail(guide: String?, on engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults) throws -> CreateRoadmap.Result {
    let planted = try RoadmapFixture.plantLearnToSail(runner)
    if let guide { try RoadmapFixture.write(guide, on: planted.tree, by: runner) }
    memory.set(planted.tree.description, forKey: RoadmapModel.lastOpen)
    engine.sync()
    return planted
  }

  // The model reads again once the views hold every change committed so far, until the open roadmap's guide is the one
  // expected.
  func shows(_ model: RoadmapModel, guide expected: String, on engine: SteppedEngine) async {
    for _ in 0..<100 where model.shown?.tree.meta?.guide != expected {
      await engine.settleViews()
      model.observe()
    }
    #expect(model.shown?.tree.meta?.guide == expected)
  }

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  // Roadmap · iOS 08.5: the guides of the roadmaps above stand under the roadmap's own, nearest first, and the title menu
  // counts them; the farther one opens the nearer, which opens *Learn to sail*.
  @Test func aGuideIsReadWithTheGuidesAboveNearestFirstAndTheMenuCountsThem() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(guide: RoadmapFixture.Guides.sail, on: engine, runner, memory)
    let skipper = try RoadmapFixture.plant(RoadmapFixture.others[1], opening: sail.tree, by: runner)
    try RoadmapFixture.write(RoadmapFixture.Guides.skipper, on: skipper.tree, by: runner)
    let spanish = try RoadmapFixture.plant(RoadmapFixture.others[0], opening: sail.tree, by: runner)
    try RoadmapFixture.write("Order dinner in Spanish by May.", on: spanish.tree, by: runner)
    guard case .committed = try runner.runAct(PointStep.set(tree: spanish.tree, step: spanish.steps[0].id, opens: skipper.tree)) else {
      Issue.record("Spanish B1's step does not open Become a day skipper")
      return
    }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, guide: RoadmapFixture.Guides.sail, on: engine)
    let open = try #require(model.shown)
    #expect(open.guidesAbove.map { "\($0.title): \($0.text)" } == [
      "Become a day skipper: \(RoadmapFixture.Guides.skipper)", "Spanish B1: Order dinner in Spanish by May.",
    ])
    #expect(GuideSheet.menuTitle(above: open.guidesAbove.count) == "Guide · +2 from above")

    model.openGuide()
    let sheet = try #require(model.guide)
    #expect(sheet.written && sheet.text == RoadmapFixture.Guides.sail && sheet.draft == nil)
    #expect(sheet.above.map(\.title) == ["Become a day skipper", "Spanish B1"])

    // Another roadmap opening closes the sheet.
    model.open(skipper.tree.description, from: .menu)
    await shows(model, guide: RoadmapFixture.Guides.skipper, on: engine)
    #expect(model.guide == nil)
    #expect(model.shown.map { GuideSheet.menuTitle(above: $0.guidesAbove.count) } == "Guide · +1 from above")
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_guide above=some door=menu step=open view=board", "roadmap_sheet door=menu step=switch",
    ])
  }

  // Roadmap · iOS 08.2 and 08.3: a roadmap with no guide opens on Add Guide, whose draft writes nothing until it holds
  // words; Save writes the guide once, the sheet reads it, the account's other phone has it, and the band's Undo takes it
  // back. Saved blank, a guide is removed.
  @Test func aGuideIsAddedSavedOnceWithUndoAndRemovedWhenSavedBlank() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(guide: nil, on: engine, runner, memory)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, guide: "", on: engine)
    #expect(model.shown.map { GuideSheet.menuTitle(above: $0.guidesAbove.count) } == "Guide")

    model.openGuide()
    let sheet = try #require(model.guide)
    #expect(!sheet.written && sheet.above.isEmpty)
    sheet.edit(via: .add)
    sheet.type("  \n ")
    #expect(sheet.draft?.changed == false && sheet.draft?.count == nil)
    sheet.save()
    #expect(sheet.draft != nil && model.band == nil)
    sheet.type("Sail on Sundays.")
    #expect(sheet.draft?.changed == true && sheet.draft?.fits == true)
    sheet.save()
    #expect(sheet.draft == nil && model.guide === sheet)
    let band = try #require(model.band)
    #expect(band.says == .savedGuide(cleared: false) && band.undo?.act == .step("guide") && band.undo?.held == false && band.lasts == .seconds(6))
    await shows(model, guide: "Sail on Sundays.", on: engine)
    #expect(sheet.written && sheet.text == "Sail on Sundays.")

    let other = engine.device()
    let elsewhere = room(other, ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)), memory)
    engine.sync()
    elsewhere.roomOpened()
    await shows(elsewhere, guide: "Sail on Sundays.", on: other)

    model.undo()
    #expect(model.band == nil)
    await shows(model, guide: "", on: engine)
    engine.sync()
    await shows(elsewhere, guide: "", on: other)

    sheet.edit(via: .add)
    sheet.type("Sail on Sundays.")
    sheet.save()
    await shows(model, guide: "Sail on Sundays.", on: engine)
    sheet.edit(via: .edit)
    sheet.type(" \n")
    #expect(sheet.draft?.changed == true && sheet.draft?.saved == "")
    sheet.save()
    #expect(model.band?.says == .savedGuide(cleared: true))
    await shows(model, guide: "", on: engine)
    #expect(!sheet.written)
    #expect(try runner.read(sail.tree.tree) { try $0.repository(RoadmapMeta.self).find(RoadmapMeta.singleton, in: .drawn)?.guide } == "")
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_guide above=none door=menu step=open view=board", "roadmap_guide step=edit via=add",
      "roadmap_guide length=1-500 outcome=saved step=save", "roadmap_board_undo act=guide outcome=ok", "roadmap_guide step=edit via=add",
      "roadmap_guide length=1-500 outcome=saved step=save", "roadmap_guide step=edit via=edit", "roadmap_guide length=0 outcome=cleared step=save",
    ])
  }

  // Roadmap · iOS 08.3 and 08.4: the counter shows from 4,500 characters; past 5,000 the draft keeps every character,
  // counts the excess and is refused once as it goes over, and Save writes nothing until the text fits again.
  @Test func pastFiveThousandCharactersTheDraftIsKeptCountedOverAndSaveWaits() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let long = RoadmapFixture.Guides.long
    #expect(RoadmapSpecs.guide.measure(long) == 4_985)
    _ = try learnToSail(guide: long, on: engine, runner, memory)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, guide: long, on: engine)
    model.openGuide()
    let sheet = try #require(model.guide)
    sheet.edit(via: .edit)
    #expect(sheet.draft?.count == "15 left" && sheet.draft?.fits == true)

    let over = long + ", then tie up without help."
    sheet.type(over)
    #expect(sheet.draft?.text == over && sheet.draft?.count == "12 over" && sheet.draft?.fits == false && sheet.draft?.changed == true)
    sheet.save()
    #expect(sheet.draft?.text == over && model.band == nil)
    sheet.type(over + "!")
    #expect(sheet.draft?.count == "13 over")
    sheet.type(long + ", then tie up.")
    #expect(sheet.draft?.count == "1 left")
    sheet.type(long + ", then tie up without help 🌊")
    #expect(sheet.draft?.count == "13 over")
    sheet.type(String(long.prefix(4_499)))
    #expect(sheet.draft?.count == nil)
    sheet.type(long + ", then tie up.")
    sheet.save()
    #expect(sheet.draft == nil && model.band?.says == .savedGuide(cleared: false))
    await shows(model, guide: long + ", then tie up.", on: engine)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_guide above=none door=menu step=open view=board", "roadmap_guide step=edit via=edit",
      "roadmap_write_refused refusal=tooLong write=guide", "roadmap_write_refused refusal=tooLong write=guide",
      "roadmap_guide length=4501-5000 outcome=saved step=save",
    ])
  }

  // Roadmap · iOS 08.3: Cancel leaves an unchanged draft at once and asks before discarding a changed one. A draft with no
  // change follows the guide another phone writes; one with a change keeps the person's words. A commit that fails keeps
  // the draft as it was typed.
  @Test func cancelAsksOnAChangedDraftAndOnlyAnUnchangedDraftFollowsTheGuideWrittenElsewhere() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(guide: RoadmapFixture.Guides.sail, on: engine, runner, memory)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, guide: RoadmapFixture.Guides.sail, on: engine)
    model.openGuide()
    let sheet = try #require(model.guide)

    sheet.edit(via: .edit)
    sheet.cancel()
    #expect(sheet.draft == nil && !sheet.asksDiscard)
    sheet.edit(via: .edit)
    sheet.type("Sundays only.")
    sheet.cancel()
    #expect(sheet.asksDiscard && sheet.draft?.text == "Sundays only.")
    sheet.discard()
    #expect(sheet.draft == nil)
    await shows(model, guide: RoadmapFixture.Guides.sail, on: engine)

    let other = engine.device()
    let elsewhere = ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    engine.sync()
    sheet.edit(via: .edit)
    try RoadmapFixture.write("Written on the other phone.", on: sail.tree, by: elsewhere)
    engine.sync()
    await shows(model, guide: "Written on the other phone.", on: engine)
    #expect(sheet.draft == GuideDraft("Written on the other phone."))
    sheet.type("Mine.")
    try RoadmapFixture.write("Written there again.", on: sail.tree, by: elsewhere)
    engine.sync()
    await shows(model, guide: "Written there again.", on: engine)
    #expect(sheet.draft?.text == "Mine." && sheet.draft?.base == "Written on the other phone.")

    engine.failNextCommit()
    sheet.save()
    #expect(sheet.draft?.text == "Mine." && model.band == nil)
    sheet.save()
    #expect(sheet.draft == nil)
    await shows(model, guide: "Mine.", on: engine)
    model.endBand()
    sheet.edit(via: .edit)
    model.closeGuide()
    #expect(model.guide == nil)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_guide above=none door=menu step=open view=board", "roadmap_guide step=edit via=edit",
      "roadmap_guide step=cancel", "roadmap_guide step=edit via=edit", "roadmap_guide step=discard", "roadmap_guide step=edit via=edit",
      "client_error failure_kind=storage operation=roadmap_write", "roadmap_guide length=1-500 outcome=saved step=save",
      "roadmap_guide step=edit via=edit", "roadmap_guide step=cancel",
    ])
  }

  // What a draft counts and saves, as the domain counts a guide: the code points of the text as typed, so an accent typed
  // apart counts too, and blanks are no guide.
  @Test func aDraftCountsTheCodePointsTypedAndBlanksAreNoGuide() {
    var draft = GuideDraft("")
    draft.text = String(repeating: "e\u{301}", count: 2_250)
    #expect(draft.length == 4_500 && draft.count == "500 left" && draft.lengthBucket == "2001-4500")
    draft.text = String(repeating: "🌊", count: 5_001)
    #expect(draft.length == 5_001 && draft.count == "1 over" && !draft.fits)
    draft.text = " \u{3000}\n"
    #expect(!draft.changed && draft.saved == "" && draft.lengthBucket == "0")
    #expect(GuideDraft("Sail").changed == false)
    var cleared = GuideDraft("Sail")
    cleared.text = "\t"
    #expect(cleared.changed && cleared.saved == "")
  }
}
