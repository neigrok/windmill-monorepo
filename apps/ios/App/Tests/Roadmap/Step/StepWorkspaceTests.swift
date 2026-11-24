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

@Suite(.serialized) @MainActor struct StepWorkspaceTests {
  // A phone's engine in step mode on the model server, the runner roadmap's actions take, and what the phone remembers.
  func phone(account: String? = "acct-1") -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: account,
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "step-workspace-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views and its runner; a band's time never ends.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                 telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
  }

  func step(_ label: String, in model: RoadmapModel) throws -> String {
    guard case .open(let open) = model.phase else { throw AppFailure(message: "no roadmap is open") }
    return try #require(open.tree.nodes.first { $0.label == label }).id
  }

  func workspace(of label: String, in model: RoadmapModel) throws -> StepWorkspace {
    guard case .open(let open) = model.phase else { throw AppFailure(message: "no roadmap is open") }
    return try #require(open.page(of: try step(label, in: model))).workspace
  }

  // A step's workspace as its page reads it: its subtasks in their order, each checked or not, its note's text, and
  // its links, each by the title its row says, its host and the address it opens.
  func read(_ label: String, in model: RoadmapModel) -> [String] {
    guard let workspace = try? workspace(of: label, in: model) else { return ["no page"] }
    let subtasks: [String] = workspace.subtasks.map { (subtask: Subtask) -> String in "\(subtask.done ? "[x]" : "[ ]") \(subtask.label)" }
    let links: [String] = workspace.links.map { (link: StepWorkspace.Link) -> String in
      "\(link.title) | \(link.address.host ?? "") | \(link.address.url.absoluteString)"
    }
    let tally = "subtasks \(workspace.done) of \(workspace.subtasks.count)\(workspace.allDone ? ", all done" : ""): "
    return [tally + subtasks.joined(separator: ", "), "note: \(workspace.note?.text ?? "none")", "links: " + links.joined(separator: ", ")]
  }

  // The model reads again once the views hold every change committed so far, until the step's workspace is the one expected.
  func shows(_ model: RoadmapModel, _ label: String, _ expected: [String], on engine: SteppedEngine) async {
    for _ in 0..<100 {
      await engine.settleViews()
      model.observe()
      if read(label, in: model) == expected { break }
    }
    #expect(read(label, in: model) == expected)
  }

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  // Roadmap · iOS 03.2, 03.3, 03.5 and 03.14, on a phone never signed in: an empty workspace, subtasks added at the
  // bottom of the list, one checked with the web's Undo for six seconds, every one checked leaving the step where it
  // stands, and one removed, held by the engine with Undo for the hold. Every write is the overlay's: the roadmap's
  // shared scope holds none of it, and no event carries a word of it.
  @Test func subtasksAreAddedCheckedAndRemovedInThePersonsOverlayWithUndoWhereTheBandOffersIt() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    let planted = try RoadmapFixture.plantLearnToSail(runner)
    let shared = { () throws -> [String] in
      try runner.read(planted.tree.tree) { try $0.records(in: .drawn) }.map { "\($0.type) \($0.id) \($0.stamps.count)" }
    }
    let before = try shared()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, "Read the wind", ["subtasks 0 of 0: ", "note: none", "links: "], on: engine)
    let wind = try step("Read the wind", in: model)

    #expect(!model.addSubtask("  \n ", to: wind))
    #expect(model.addSubtask("  Watch the telltales for ten minutes ", to: wind) && model.addSubtask("Check the harbour flag", to: wind))
    #expect(model.band == nil)
    await shows(model, "Read the wind", ["subtasks 0 of 2: [ ] Watch the telltales for ten minutes, [ ] Check the harbour flag", "note: none", "links: "],
                on: engine)

    var telltales = try #require(try workspace(of: "Read the wind", in: model).subtasks.first)
    model.toggle(telltales)
    var band = try #require(model.band)
    #expect(band.says == .checked(telltales.id, label: "Watch the telltales for ten minutes") && band.says.words == "Watch the telltales for ten minutes checked")
    #expect(band.lasts == .seconds(6) && band.undo?.held == false && band.undo?.act == .workspace("subtaskToggle"))
    let oneChecked = ["subtasks 1 of 2: [x] Watch the telltales for ten minutes, [ ] Check the harbour flag", "note: none", "links: "]
    await shows(model, "Read the wind", oneChecked, on: engine)

    model.undo()
    #expect(model.band == nil)
    let noneChecked = ["subtasks 0 of 2: [ ] Watch the telltales for ten minutes, [ ] Check the harbour flag", "note: none", "links: "]
    await shows(model, "Read the wind", noneChecked, on: engine)

    // Unchecked, the band that said it was checked leaves, and no other is offered.
    telltales = try #require(try workspace(of: "Read the wind", in: model).subtasks.first)
    model.toggle(telltales)
    await shows(model, "Read the wind", oneChecked, on: engine)
    telltales = try #require(try workspace(of: "Read the wind", in: model).subtasks.first)
    model.toggle(telltales)
    #expect(model.band == nil)
    await shows(model, "Read the wind", noneChecked, on: engine)

    // Every subtask checked says so and completes nothing: the step stands Up next.
    for subtask in try workspace(of: "Read the wind", in: model).subtasks { model.toggle(subtask) }
    await shows(model, "Read the wind", ["subtasks 2 of 2, all done: [x] Watch the telltales for ten minutes, [x] Check the harbour flag", "note: none", "links: "],
                on: engine)
    #expect(model.shown?.step(wind)?.card.column == .upNext && model.shown?.board.overall.done == 3)

    let flag = try #require(try workspace(of: "Read the wind", in: model).subtasks.last)
    model.remove(flag)
    band = try #require(model.band)
    #expect(band.says == .deletedFromWorkspace("Check the harbour flag") && band.says.words == "Check the harbour flag deleted")
    #expect(band.lasts == .milliseconds(Constants.holdMs) && band.undo?.held == true && band.undo?.act == .workspace("subtaskDelete"))
    await shows(model, "Read the wind", ["subtasks 1 of 1, all done: [x] Watch the telltales for ten minutes", "note: none", "links: "], on: engine)
    model.undo()
    await shows(model, "Read the wind", ["subtasks 2 of 2, all done: [x] Watch the telltales for ten minutes, [x] Check the harbour flag", "note: none", "links: "],
                on: engine)

    #expect(try shared() == before)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_workspace action=subtaskAdd", "roadmap_board_workspace action=subtaskAdd",
      "roadmap_board_workspace action=subtaskToggle", "roadmap_board_workspace act=subtaskToggle action=undo outcome=ok",
      "roadmap_board_workspace action=subtaskToggle", "roadmap_board_workspace action=subtaskToggle",
      "roadmap_board_workspace action=subtaskToggle", "roadmap_board_workspace action=subtaskToggle",
      "roadmap_board_workspace action=subtaskDelete", "roadmap_board_workspace act=subtaskDelete action=undo outcome=ok",
    ])
  }

  // Roadmap · iOS 03.2 and 03.11: an address a person types is a link once the phone can open it, with https where it
  // names no scheme; a link is added under its title or, with none, under its host; a link the page cannot open is
  // not listed; and a link's removal is held with Undo.
  @Test func aLinkIsAddedUnderItsTitleOrItsHostAndRemovedWithUndo() async throws {
    let typed = ["rya.org.uk/telltales", "  https://www.metoffice.gov.uk/weather ", "HTTP://Example.com", "localhost:8080/tides", "", "   ", "not a link",
                 "ftp://rya.org.uk/file", "mailto:crew@example.com", "javascript:alert(1)", "https://"].map {
      LinkAddress(typed: $0).map { "\($0.url.absoluteString) | \($0.host ?? "")" } ?? "nil"
    }
    #expect(typed == ["https://rya.org.uk/telltales | rya.org.uk", "https://www.metoffice.gov.uk/weather | metoffice.gov.uk", "HTTP://Example.com | Example.com",
                      "https://localhost:8080/tides | localhost", "nil", "nil", "nil", "nil", "https://mailto:crew@example.com | example.com", "nil", "nil"])
    let held = ["https://rya.org.uk", "mailto:crew@example.com", "MAILTO:crew@example.com", "javascript:alert(1)", "rya.org.uk", ""].map {
      LinkAddress($0).map { "\($0.url.absoluteString) | \($0.host ?? "")" } ?? "nil"
    }
    #expect(held == ["https://rya.org.uk | rya.org.uk", "mailto:crew@example.com | ", "MAILTO:crew@example.com | ", "nil", "nil", "nil"])

    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    let planted = try RoadmapFixture.plantLearnToSail(runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, "Read the wind", ["subtasks 0 of 0: ", "note: none", "links: "], on: engine)
    let wind = try step("Read the wind", in: model)

    model.linkFormOpened()
    model.linkFormCancelled()
    model.linkFormOpened()
    #expect(model.addLink(try #require(LinkAddress(typed: "rya.org.uk/telltales")), titled: " Telltale guide ", to: wind))
    #expect(model.addLink(try #require(LinkAddress(typed: "https://www.metoffice.gov.uk/weather")), titled: "", to: wind))
    #expect(model.band == nil)
    // A link another surface wrote with an address no page opens stays in the overlay and off the page.
    guard case .committed = try runner.runAct(AddStepLink(tree: planted.tree, step: ID(RecordID(wind)), item: WorkspaceLink.Changes(url: "javascript:alert(1)", title: "Run"))) else {
      Issue.record("the unopenable link was not written")
      return
    }
    let both = ["subtasks 0 of 0: ", "note: none",
                "links: Telltale guide | rya.org.uk | https://rya.org.uk/telltales, metoffice.gov.uk | metoffice.gov.uk | https://www.metoffice.gov.uk/weather"]
    await shows(model, "Read the wind", both, on: engine)

    let guide = try #require(try workspace(of: "Read the wind", in: model).links.first)
    model.remove(guide)
    let band = try #require(model.band)
    #expect(band.says == .deletedFromWorkspace("Telltale guide") && band.undo?.held == true && band.undo?.act == .workspace("linkDelete"))
    await shows(model, "Read the wind", ["subtasks 0 of 0: ", "note: none", "links: metoffice.gov.uk | metoffice.gov.uk | https://www.metoffice.gov.uk/weather"],
                on: engine)
    model.undo()
    await shows(model, "Read the wind", both, on: engine)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_workspace action=linkOpen", "roadmap_board_workspace action=linkCancel",
      "roadmap_board_workspace action=linkOpen", "roadmap_board_workspace action=linkAdd", "roadmap_board_workspace action=linkAdd",
      "roadmap_board_workspace action=linkDelete", "roadmap_board_workspace act=linkDelete action=undo outcome=ok",
    ])
  }

  // Roadmap · iOS 03.10: the note's screen opens on one draft, of what the overlay draws or new; leaving the screen
  // saves it once through the door, which keeps no Undo of it; an untouched note writes nothing; and the app leaving
  // saves a note still open. The draft keeps no more than the domain takes.
  @Test func aNoteIsOneDraftSavedOnceAsItsScreenLeaves() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try RoadmapFixture.plantLearnToSail(runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, "Read the wind", ["subtasks 0 of 0: ", "note: none", "links: "], on: engine)
    let wind = try step("Read the wind", in: model)
    let page = RoadmapModel.Visit.step(wind, by: .card)

    model.path = [page]
    model.path.append(.note(of: wind))
    var draft = try #require(model.note)
    #expect(draft.text == "")
    draft.text = "Gusts show as **dark patches** on the water."
    await shows(model, "Read the wind", ["subtasks 0 of 0: ", "note: none", "links: "], on: engine)
    model.path = [page]
    #expect(model.note == nil && model.band == nil)
    await shows(model, "Read the wind", ["subtasks 0 of 0: ", "note: Gusts show as **dark patches** on the water.", "links: "], on: engine)

    // Opened and left untouched, it writes nothing.
    model.path.append(.note(of: wind))
    draft = try #require(model.note)
    #expect(draft.text == "Gusts show as **dark patches** on the water.")
    model.path = [page]

    // The app leaving saves the note as it stands, and the screen leaving after it saves only what changed since.
    model.path.append(.note(of: wind))
    draft = try #require(model.note)
    draft.text += "\n\nLook upwind."
    model.flush()
    await shows(model, "Read the wind", ["subtasks 0 of 0: ", "note: Gusts show as **dark patches** on the water.\n\nLook upwind.", "links: "], on: engine)
    #expect(model.note === draft && draft.text == "Gusts show as **dark patches** on the water.\n\nLook upwind.")
    model.path = [page]
    #expect(model.note == nil)

    // A note emptied is a note no longer drawn, and its section is its add row again.
    model.path.append(.note(of: wind))
    draft = try #require(model.note)
    draft.text = String(repeating: "é", count: 16_001)
    #expect(draft.text == String(repeating: "é", count: 16_000))
    draft.text = ""
    model.path = [page]
    await shows(model, "Read the wind", ["subtasks 0 of 0: ", "note: none", "links: "], on: engine)

    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_step_open column=upNext door=card surface=document", "roadmap_board_step_action action=editNote surface=document",
      "roadmap_board_workspace action=noteSave", "roadmap_board_step_action action=editNote surface=document",
      "roadmap_board_step_action action=editNote surface=document", "roadmap_board_workspace action=noteSave",
      "roadmap_board_step_action action=editNote surface=document", "roadmap_board_workspace action=noteSave",
    ])
  }

  // Contract: a second phone's change to the same step's workspace arrives on an open page, a note open and untouched
  // shows what the other phone wrote, one being written keeps the person's words and is merged with theirs at its save,
  // and a write to a subtask that is gone is refused and told by its kind.
  @Test func aSecondPhonesChangesArriveOnAnOpenPageAndInAnOpenNote() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let planted = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, "Read the wind", ["subtasks 0 of 0: ", "note: none", "links: "], on: engine)
    let wind = try step("Read the wind", in: model)
    let page = RoadmapModel.Visit.step(wind, by: .card)
    model.path = [page]

    let other = engine.device()
    engine.sync()
    let elsewhere = room(other, ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0), holdRemovals: false), memory)
    elsewhere.roomOpened()
    await shows(elsewhere, "Read the wind", ["subtasks 0 of 0: ", "note: none", "links: "], on: other)
    #expect(elsewhere.addSubtask("Ask about the tide table", to: wind))
    #expect(elsewhere.addLink(try #require(LinkAddress(typed: "rya.org.uk/telltales")), titled: "Telltale guide", to: wind))
    elsewhere.path = [page, .note(of: wind)]
    try #require(elsewhere.note).text = "Gusts show as dark patches."
    elsewhere.path = [page]
    engine.sync()
    let arrived = ["subtasks 0 of 1: [ ] Ask about the tide table", "note: Gusts show as dark patches.", "links: Telltale guide | rya.org.uk | https://rya.org.uk/telltales"]
    await shows(model, "Read the wind", arrived, on: engine)
    #expect(model.path == [page])

    // The note open and untouched follows the other phone; once written in, it keeps the person's words.
    model.path.append(.note(of: wind))
    let draft = try #require(model.note)
    #expect(draft.text == "Gusts show as dark patches.")
    elsewhere.path = [page, .note(of: wind)]
    try #require(elsewhere.note).text = "Gusts show as dark patches. Look upwind."
    elsewhere.path = [page]
    engine.sync()
    await shows(model, "Read the wind", [arrived[0], "note: Gusts show as dark patches. Look upwind.", arrived[2]], on: engine)
    #expect(draft.text == "Gusts show as dark patches. Look upwind.")
    draft.text = "Reef early. Gusts show as dark patches. Look upwind."
    elsewhere.path = [page, .note(of: wind)]
    try #require(elsewhere.note).text = "Gusts show as dark patches. Look upwind. Then go."
    elsewhere.path = [page]
    engine.sync()
    await shows(model, "Read the wind", [arrived[0], "note: Gusts show as dark patches. Look upwind. Then go.", arrived[2]], on: engine)
    #expect(draft.text == "Reef early. Gusts show as dark patches. Look upwind.")
    model.path = [page]
    engine.sync()
    let merged = [arrived[0], "note: Reef early. Gusts show as dark patches. Look upwind. Then go.", arrived[2]]
    await shows(model, "Read the wind", merged, on: engine)
    await shows(elsewhere, "Read the wind", merged, on: other)

    // The other phone removes the subtask; a tap this phone made on what it still showed is refused, and told.
    let tide = try #require(try workspace(of: "Read the wind", in: model).subtasks.first)
    elsewhere.remove(try #require(try workspace(of: "Read the wind", in: elsewhere).subtasks.first))
    engine.sync()
    await engine.settleViews()
    model.toggle(tide)
    #expect(model.band == nil)
    await shows(model, "Read the wind", ["subtasks 0 of 0: ", merged[1], merged[2]], on: engine)
    #expect(Array(told(telemetry).suffix(2)) == ["roadmap_board_workspace action=noteSave", "roadmap_write_refused refusal=gone write=workspace"])

    // Nothing of the workspace is in the roadmap's shared scope: every record of it is the overlay's.
    let types = Set(try runner.read(planted.tree.tree) { try $0.records(in: .drawn) }.map(\.type))
    #expect(types.isDisjoint(with: [Subtask.type, WorkspaceLink.type, StepNote.type]))
    let owned = Set(try runner.read(planted.tree.overlay) { try $0.records(in: .drawn) }.map(\.type))
    #expect(owned.isSuperset(of: [WorkspaceLink.type, StepNote.type]))
  }
}
