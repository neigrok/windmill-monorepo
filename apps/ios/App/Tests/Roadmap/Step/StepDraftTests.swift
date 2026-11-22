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

@Suite(.serialized) @MainActor struct StepDraftTests {
  // A phone's engine in step mode on the model server, the runner roadmap's actions take, and what the phone remembers.
  func phone(account: String? = "acct-1") -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: account,
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "step-draft-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views and its runner; a band's time never ends.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                 telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
  }

  // *Learn to sail* with its first three steps completed a minute apart, each received before the next, so Done has an order.
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

  // The open roadmap's Board as its rows tell it: its progress, then each group with its steps' labels in order.
  func board(_ model: RoadmapModel) -> [String] {
    guard case .open(let open) = model.phase else { return ["no roadmap is open"] }
    return ["\(open.board.overall.done) of \(open.board.overall.total)"] + open.groups.map { (group: RoadmapModel.Group) -> String in
      "\(group.id.rawValue): " + group.rows.map(\.step.label).joined(separator: ", ")
    }
  }

  // The model reads again once the views hold every change committed so far, until its Board is the one expected.
  func shows(_ model: RoadmapModel, board expected: [String], on engine: SteppedEngine) async {
    for _ in 0..<100 {
      await engine.settleViews()
      model.observe()
      if board(model) == expected { break }
    }
    #expect(board(model) == expected)
  }

  func row(_ label: String, in model: RoadmapModel) throws -> RoadmapModel.Row {
    guard case .open(let open) = model.phase else { throw AppFailure(message: "no roadmap is open") }
    return try #require(open.groups.flatMap(\.rows).first { $0.step.label == label })
  }

  // A step's page as its parts tell it: its row with its kind and group, and the steps it requires and the steps it
  // opens by name: the fixture's steps were made in one moment, so the roadmap's order among them is not fixed.
  func page(_ label: String, in model: RoadmapModel) throws -> [String] {
    guard case .open(let open) = model.phase else { throw AppFailure(message: "no roadmap is open") }
    let page = try #require(open.page(of: try row(label, in: model).id))
    return ["\(page.row.step.label) \(page.row.card.column.rawValue) [\(page.row.kind?.label ?? page.row.step.color)] \(page.row.step.description)",
            "requires: " + page.requires.map(\.step.label).sorted().joined(separator: ", "),
            "opens: " + page.opens.map(\.step.label).sorted().joined(separator: ", ")]
  }

  // The model reads again until a step's page is the one expected.
  func shows(_ model: RoadmapModel, page label: String, _ expected: [String], on engine: SteppedEngine) async {
    for _ in 0..<100 where (try? page(label, in: model)) != expected {
      await engine.settleViews()
      model.observe()
    }
    #expect((try? page(label, in: model)) == expected)
  }

  // A list as it groups its steps: each group's names in the order of the states it lists, done, up next, then locked,
  // and by name within a state, where the fixture fixes no order.
  func listed(_ choices: StepDraft.Choices) -> [String] {
    let names = { (rows: [RoadmapModel.Row]) -> String in
      var runs: [(column: BoardRead.Column.Name, names: [String])] = []
      for row in rows {
        if runs.last?.column == row.card.column { runs[runs.count - 1].names.append(row.name) } else { runs.append((row.card.column, [row.name])) }
      }
      return runs.flatMap { $0.names.sorted() }.joined(separator: ", ")
    }
    return ["selected: " + names(choices.selected), "all: " + names(choices.all), "blocked: " + names(choices.blocked)]
  }

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  // Roadmap · iOS 05.1 and 05.7: a new draft starts on Sky with nothing to commit; named, it lands where what it requires
  // puts it; Create writes the step, what it requires and what it opens as one gesture, closes the form, opens the
  // step's group and holds Undo for six seconds; and Undo takes all of it back, on the account's other phone too.
  @Test func aNewStepIsWrittenInOneGestureShownOnTheBoardAndTakenBackByUndo() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try learnToSail(on: engine, runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)
    model.folded = [.locked, .done]

    model.newStep(from: .foot)
    let draft = try #require(model.draft)
    #expect(draft.isNew && draft.kind == "sky" && !draft.commits && !draft.isChanged && draft.refusal == nil)
    #expect(draft.moves && draft.placement == "Lands in Up next" && draft.offersSteps)
    draft.name = "  Reefing basics "
    draft.description = "How to reduce sail area safely in stronger wind."
    draft.kind = "olive"
    draft.toggle(try row("Read the wind", in: model), in: .requires)
    draft.toggle(try row("Leave the dock", in: model), in: .opens)
    #expect(draft.commits && draft.isChanged && draft.group == .locked && draft.placement == "Lands in Locked · Read the wind isn’t done")
    #expect(draft.names(.requires) == ["Read the wind"] && draft.names(.opens) == ["Leave the dock"])

    draft.save()
    #expect(model.draft == nil && model.folded == [.done])
    let band = try #require(model.band)
    #expect(band.says == .created(step: "Reefing basics", in: .locked))
    #expect(band.arrived == [draft.step.description] && band.lasts == .seconds(6) && band.undo?.held == false && band.undo?.act == .step("create"))
    let made = ["3 of 9", "upNext: Read the wind, Tie a bowline", "locked: Reefing basics, Leave the dock, Sail a triangle, Sail solo",
                "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: made, on: engine)
    #expect(try page("Reefing basics", in: model) == [
      "Reefing basics locked [Learn] How to reduce sail area safely in stronger wind.", "requires: Read the wind", "opens: Leave the dock",
    ])
    #expect(try row("Reefing basics", in: model).id == draft.step.description)

    let other = engine.device()
    let elsewhere = room(other, ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)), memory)
    engine.sync()
    elsewhere.roomOpened()
    await shows(elsewhere, board: made, on: other)

    model.undo()
    #expect(model.band == nil)
    await shows(model, board: atRest, on: engine)
    engine.sync()
    await shows(model, board: atRest, on: engine)
    await shows(elsewhere, board: atRest, on: other)
    #expect(try page("Leave the dock", in: model) == [
      "Leave the dock locked [Build] Cast off safely and steer clear of the dock.", "requires: Read the wind, Rig the boat", "opens: Sail a triangle",
    ])
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_create door=foot step=open view=board", "roadmap_board_create column=locked step=saved",
      "roadmap_board_undo act=create outcome=ok",
    ])
  }

  // Roadmap · iOS 02.15, signed out: a roadmap with no step offers no step to require or to open, and its first step
  // lands Up next.
  @Test func aRoadmapsFirstStepIsMadeSignedOutWithNoStepToChooseFrom() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    guard case .committed = try runner.runAct(CreateRoadmap(title: "Night sailing")) else {
      Issue.record("Night sailing was not planted")
      return
    }
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, board: ["0 of 0"], on: engine)

    model.newStep(from: .empty)
    let draft = try #require(model.draft)
    #expect(!draft.offersSteps && draft.names(.requires).isEmpty && draft.names(.opens).isEmpty)
    #expect(listed(draft.choices(of: .requires, chosenAtOpening: [], finding: "")) == ["selected: ", "all: ", "blocked: "])
    draft.name = "Sail after dark"
    draft.save()
    #expect(model.band?.says == .created(step: "Sail after dark", in: .upNext))
    await shows(model, board: ["0 of 1", "upNext: Sail after dark"], on: engine)
    #expect(try page("Sail after dark", in: model) == ["Sail after dark upNext [sky] ", "requires: ", "opens: "])
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_create door=empty step=open view=board", "roadmap_board_create column=upNext step=saved",
    ])
  }

  // Roadmap · iOS 05.8: a draft of a step starts from what its page shows, with nothing to save; its name, its kind, what
  // it requires and what it opens are written as one gesture, the page staying under the band; and Undo takes every
  // part of it back, on the account's other phone too.
  @Test func aStepIsEditedInOneGestureAndUndoTakesAllOfItBack() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try learnToSail(on: engine, runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)
    let asItWas = ["Tie a bowline upNext [Learn] Tie a secure loop that is easy to undo, then practise it with your eyes closed.",
                   "requires: Name the boat parts", "opens: Sail solo"]
    #expect(try page("Tie a bowline", in: model) == asItWas)

    guard case .open(let open) = model.phase else { return }
    let tie = try row("Tie a bowline", in: model)
    model.path = [.step(tie.id, by: .card)]
    model.edit(try #require(open.page(of: tie.id)))
    let draft = try #require(model.draft)
    #expect(!draft.isNew && draft.step.description == tie.id && draft.name == "Tie a bowline" && draft.kind == "olive")
    #expect(draft.names(.requires) == ["Name the boat parts"] && draft.names(.opens) == ["Sail solo"])
    #expect(!draft.isChanged && !draft.commits && !draft.moves)

    draft.name = "Tie two knots"
    draft.kind = "plum"
    draft.toggle(try row("Name the boat parts", in: model), in: .requires)
    draft.toggle(try row("Read the wind", in: model), in: .requires)
    draft.toggle(try row("Sail solo", in: model), in: .opens)
    draft.toggle(try row("Leave the dock", in: model), in: .opens)
    #expect(draft.commits && draft.moves && draft.placement == "Lands in Locked · Read the wind isn’t done")

    draft.save()
    #expect(model.draft == nil && model.path == [.step(tie.id, by: .card)])
    let band = try #require(model.band)
    #expect(band.says == .saved(step: "Tie two knots") && band.arrived.isEmpty && band.lasts == .seconds(6))
    #expect(band.undo?.held == false && band.undo?.act == .step("edit"))
    let edited = ["3 of 8", "upNext: Read the wind", "locked: Tie two knots, Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: edited, on: engine)
    let asEdited = ["Tie two knots locked [plum] Tie a secure loop that is easy to undo, then practise it with your eyes closed.",
                    "requires: Read the wind", "opens: Leave the dock"]
    #expect(try page("Tie two knots", in: model) == asEdited)

    let other = engine.device()
    let elsewhere = room(other, ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)), memory)
    engine.sync()
    elsewhere.roomOpened()
    await shows(elsewhere, board: edited, on: other)
    #expect(try page("Tie two knots", in: elsewhere) == asEdited)

    model.undo()
    await shows(model, board: atRest, on: engine)
    #expect(try page("Tie a bowline", in: model) == asItWas)
    engine.sync()
    await shows(elsewhere, board: atRest, on: other)
    #expect(try page("Tie a bowline", in: elsewhere) == asItWas)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_step_open column=upNext door=card surface=document", "roadmap_step_edit door=page step=open",
      "roadmap_board_edit description=false kind=true name=true opens=true prerequisites=true step=saved",
      "roadmap_board_undo act=edit outcome=ok",
    ])
  }

  // Roadmap · iOS 05.3, 05.4, 05.6b and 10.6c: a list heads with what was chosen as it opened, then every step it may
  // take, done first, and dims the steps that would close a loop over the links the draft holds: what comes after the
  // steps it opens cannot be required, and what comes before the steps it requires cannot be opened. A tap on a dimmed
  // step changes nothing and names it; a step taken, or the list left, clears that. A search never hides the chosen.
  @Test func aListDimsTheStepsThatWouldCloseALoopAndATapOnOneNamesIt() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try learnToSail(on: engine, runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, board: ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                               "done: Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)

    model.newStep(from: .foot)
    let draft = try #require(model.draft)
    draft.name = "Reefing basics"
    #expect(listed(draft.choices(of: .requires, chosenAtOpening: [], finding: "")) == [
      "selected: ", "all: Choose a sailing course, Name the boat parts, Rig the boat, Read the wind, Tie a bowline, Leave the dock, Sail a triangle, Sail solo",
      "blocked: ",
    ])
    draft.toggle(try row("Read the wind", in: model), in: .requires)
    draft.toggle(try row("Leave the dock", in: model), in: .opens)
    #expect(listed(draft.choices(of: .requires, chosenAtOpening: draft.chosen(.requires), finding: "")) == [
      "selected: Read the wind", "all: Choose a sailing course, Name the boat parts, Rig the boat, Tie a bowline",
      "blocked: Leave the dock, Sail a triangle, Sail solo",
    ])
    #expect(listed(draft.choices(of: .opens, chosenAtOpening: draft.chosen(.opens), finding: "")) == [
      "selected: Leave the dock", "all: Rig the boat, Tie a bowline, Sail a triangle, Sail solo",
      "blocked: Choose a sailing course, Name the boat parts, Read the wind",
    ])

    let leave = try row("Leave the dock", in: model)
    draft.toggle(leave, in: .requires)
    #expect(draft.refusal == .loop(StepDraft.StepID(RecordID(leave.id)), .requires) && draft.refusalWords == "Leave the dock comes after this step.")
    #expect(draft.names(.requires) == ["Read the wind"])
    draft.toggle(try row("Name the boat parts", in: model), in: .opens)
    #expect(draft.refusalWords == "Name the boat parts comes before this step." && draft.names(.opens) == ["Leave the dock"])
    draft.listClosed()
    #expect(draft.refusal == nil)
    draft.toggle(leave, in: .requires)
    draft.toggle(try row("Tie a bowline", in: model), in: .requires)
    #expect(draft.refusal == nil && draft.names(.requires) == ["Read the wind", "Tie a bowline"])

    // The list open since Read the wind alone was chosen keeps it under Selected, and a search hides none of it.
    let opened = [StepDraft.StepID(RecordID(try row("Read the wind", in: model).id))]
    #expect(listed(draft.choices(of: .requires, chosenAtOpening: opened, finding: "  THE ")) == [
      "selected: Read the wind", "all: Name the boat parts, Rig the boat", "blocked: Leave the dock",
    ])
    #expect(listed(draft.choices(of: .requires, chosenAtOpening: draft.chosen(.requires), finding: "")) == [
      "selected: Read the wind, Tie a bowline", "all: Choose a sailing course, Name the boat parts, Rig the boat",
      "blocked: Leave the dock, Sail a triangle, Sail solo",
    ])
    draft.discard()

    // A draft of a step leaves the step out of its own lists, and reads what comes after it from the steps it opens.
    guard case .open(let open) = model.phase else { return }
    model.edit(try #require(open.page(of: leave.id)))
    let editing = try #require(model.draft)
    #expect(listed(editing.choices(of: .requires, chosenAtOpening: editing.chosen(.requires), finding: "")) == [
      "selected: Rig the boat, Read the wind", "all: Choose a sailing course, Name the boat parts, Tie a bowline", "blocked: Sail a triangle, Sail solo",
    ])
    #expect(listed(editing.choices(of: .opens, chosenAtOpening: editing.chosen(.opens), finding: "")) == [
      "selected: Sail a triangle", "all: Tie a bowline, Sail solo", "blocked: Choose a sailing course, Name the boat parts, Rig the boat, Read the wind",
    ])
    // Once the draft opens Sail a triangle no more, the step may require it: the save lets go of it before it takes it.
    let triangle = try row("Sail a triangle", in: model)
    editing.toggle(triangle, in: .opens)
    editing.toggle(triangle, in: .requires)
    #expect(editing.refusal == nil && editing.placement == "Lands in Locked · Read the wind and Sail a triangle aren’t done")
    editing.save()
    #expect(model.band?.says == .saved(step: "Leave the dock"))
    await shows(model, page: "Leave the dock", [
      "Leave the dock locked [Build] Cast off safely and steer clear of the dock.", "requires: Read the wind, Rig the boat, Sail a triangle", "opens: ",
    ], on: engine)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_create door=foot step=open view=board", "roadmap_write_refused refusal=loop write=CreateNode",
      "roadmap_write_refused refusal=loop write=CreateNode", "roadmap_write_refused refusal=loop write=CreateNode",
      "roadmap_board_create door=foot step=discard", "roadmap_step_edit door=page step=open",
      "roadmap_board_edit description=false kind=false name=false opens=true prerequisites=true step=saved",
    ])
  }

  // Roadmap · iOS 05.6a and 05.1: a new form opens on no refusal; a name typed and cleared is refused in its footer,
  // which leaves at the first character; a name of blanks alone is no name; and a field holds no more than the domain
  // takes. Where the step lands is said by what it requires that is not done.
  @Test func aNameTypedAndClearedIsRefusedAndAFieldHoldsNoMoreThanTheDomainTakes() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try learnToSail(on: engine, runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)

    model.newStep(from: .foot)
    let draft = try #require(model.draft)
    draft.name = "   "
    #expect(draft.refusal == nil && !draft.commits && !draft.isChanged)
    draft.name = "R"
    #expect(draft.refusal == nil && draft.commits)
    draft.name = ""
    #expect(draft.refusal == .name && draft.refusalWords == "Enter a name for this step." && !draft.commits)
    draft.save()
    #expect(model.draft != nil && model.band == nil)
    draft.name = " "
    #expect(draft.refusal == .name)
    draft.name = " Re"
    #expect(draft.refusal == nil && draft.label == "Re" && draft.commits)

    draft.name = String(repeating: "n", count: 250)
    draft.description = String(repeating: "d", count: 16_001)
    #expect(draft.name.count == 200 && draft.description.count == 16_000)

    draft.toggle(try row("Rig the boat", in: model), in: .requires)
    #expect(draft.group == .upNext && draft.placement == "Lands in Up next")
    for (step, placement) in [("Read the wind", "Lands in Locked · Read the wind isn’t done"),
                              ("Tie a bowline", "Lands in Locked · Read the wind and Tie a bowline aren’t done"),
                              ("Leave the dock", "Lands in Locked · Read the wind and 2 more aren’t done")] {
      draft.toggle(try row(step, in: model), in: .requires)
      #expect(draft.group == .locked && draft.placement == placement)
    }
    await shows(model, board: atRest, on: engine)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_create door=foot step=open view=board", "roadmap_write_refused refusal=noName write=CreateNode",
    ])
  }

  // Roadmap · iOS 05.5: Cancel closes an unchanged draft at once and asks once on a changed one, where Discard closes it;
  // nothing is written either way, for a new step or for a draft of one.
  @Test func cancelClosesAnUnchangedDraftAndAsksOnAChangedOne() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try learnToSail(on: engine, runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)

    model.newStep(from: .foot)
    try #require(model.draft).cancel()
    #expect(model.draft == nil)

    model.newStep(from: .foot)
    let changed = try #require(model.draft)
    changed.kind = "gold"
    changed.cancel()
    #expect(changed.asksDiscard && model.draft === changed)
    changed.discard()
    #expect(model.draft == nil)

    guard case .open(let open) = model.phase else { return }
    let read = try row("Read the wind", in: model)
    model.edit(try #require(open.page(of: read.id)))
    let editing = try #require(model.draft)
    editing.description = "Feel it on your cheek."
    editing.cancel()
    #expect(editing.asksDiscard && model.draft === editing)
    editing.description = read.step.description
    editing.cancel()
    #expect(model.draft == nil && model.band == nil)
    await shows(model, board: atRest, on: engine)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_create door=foot step=open view=board", "roadmap_board_create door=foot step=cancel",
      "roadmap_board_create door=foot step=open view=board", "roadmap_board_create door=foot step=discard",
      "roadmap_step_edit door=page step=open", "roadmap_step_edit door=page step=cancel",
    ])
  }

  // Roadmap · iOS 05.2: always six kinds, the ones the roadmap names first with their descriptions, then the hues no
  // kind names, by the hue's own name.
  @Test func theKindsAreTheRoadmapsNamedKindsThenTheHuesNoKindNames() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(on: engine, runner)
    let model = room(engine, runner, memory)
    model.roomOpened()
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)
    model.newStep(from: .foot)
    let draft = try #require(model.draft)
    let kinds = { () -> [String] in draft.kinds.map { "\($0.hue) \($0.name) \($0.description)" } }
    #expect(kinds() == ["terracotta Build Things you make", "olive Learn Things you figure out", "gold Milestone Moments that matter",
                        "brick Brick ", "sky Sky ", "plum Plum "])

    guard case .committed = try runner.runAct(DeleteKind(tree: sail.tree, kind: ID("learn"))) else {
      Issue.record("Learn was not removed")
      return
    }
    for _ in 0..<100 where draft.kinds.count == 6 && draft.kinds[1].hue == "olive" {
      await engine.settleViews()
      model.observe()
    }
    #expect(kinds() == ["terracotta Build Things you make", "gold Milestone Moments that matter", "olive Olive ", "brick Brick ", "sky Sky ", "plum Plum "])
  }

  // A save the domain refuses writes nothing and keeps the form: a loop it finds over links made since the lists were
  // read is named by the first step chosen that closes it. A commit that fails keeps the form too, and is reported.
  @Test func aSaveTheDomainRefusesOrTheStoreFailsKeepsTheFormAndWritesNothing() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(on: engine, runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, board: ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                               "done: Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)

    model.newStep(from: .foot)
    let draft = try #require(model.draft)
    draft.name = "Reefing basics"
    let tie = try row("Tie a bowline", in: model), read = try row("Read the wind", in: model)
    draft.toggle(tie, in: .requires)
    draft.toggle(read, in: .opens)
    #expect(draft.refusal == nil)

    // Tie a bowline now requires Read the wind, so the step would stand between them both ways.
    guard case .committed = try runner.runAct(ChangePrerequisites(tree: sail.tree, step: ID(RecordID(tie.id)), add: [ID(RecordID(read.id))])) else {
      Issue.record("the link was not made")
      return
    }
    let linked = ["3 of 8", "upNext: Read the wind", "locked: Leave the dock, Tie a bowline, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: linked, on: engine)
    draft.save()
    #expect(model.draft === draft && model.band == nil)
    #expect(draft.refusal == .loop(StepDraft.StepID(RecordID(tie.id)), .requires) && draft.refusalWords == "Tie a bowline comes after this step.")

    draft.toggle(tie, in: .requires)
    #expect(draft.refusal == nil)
    engine.failNextCommit()
    draft.save()
    #expect(model.draft === draft && model.band == nil)
    await shows(model, board: linked, on: engine)

    draft.save()
    #expect(model.draft == nil && model.band?.says == .created(step: "Reefing basics", in: .upNext))
    await shows(model, board: ["3 of 9", "upNext: Reefing basics", "locked: Read the wind, Leave the dock, Tie a bowline, Sail a triangle, Sail solo",
                               "done: Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_create door=foot step=open view=board", "roadmap_write_refused refusal=invalid write=CreateNode",
      "client_error failure_kind=storage operation=roadmap_write", "roadmap_board_create column=upNext step=saved",
    ])
  }

  // Roadmap · iOS 05.8 and 03.8: Delete Step in a step's form asks there with what the delete costs; answered, the
  // step is held with Undo, the form is closed and the room stands on the Board. A form closes too once the step it
  // edits is gone, or its roadmap is not the open one.
  @Test func deleteStepInTheFormAsksThereAndAFormLeavesWithItsStepOrItsRoadmap() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(on: engine, runner)
    guard case .committed(let harbour, _) = try runner.runAct(CreateRoadmap(title: "Harbour days", steps: ImportedSteps(steps: [ImportedStep(key: "berth", RoadmapStep.Changes(label: "Find a berth"))]))) else {
      Issue.record("Harbour days was not planted")
      return
    }
    memory.set(sail.tree.description, forKey: RoadmapModel.lastOpen)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)

    guard case .open(let open) = model.phase else { return }
    let read = try row("Read the wind", in: model)
    model.path = [.step(read.id, by: .card)]
    model.edit(try #require(open.page(of: read.id)))
    model.askDelete(read, by: .form)
    guard case .step(let asked, let door, let followers) = model.question else {
      Issue.record("the delete was not asked")
      return
    }
    #expect(asked.id == read.id && door == .form && followers == 1)
    model.answer(delete: true)
    #expect(model.draft == nil && model.path.isEmpty && model.band?.says == .deleted(step: "Read the wind") && model.band?.undo?.held == true)
    await shows(model, board: ["3 of 7", "upNext: Leave the dock, Tie a bowline", "locked: Sail a triangle, Sail solo",
                               "done: Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)
    model.undo()
    await shows(model, board: atRest, on: engine)

    guard case .open(let standing) = model.phase else { return }
    let tie = try row("Tie a bowline", in: model)
    model.edit(try #require(standing.page(of: tie.id)))
    #expect(model.draft != nil)
    guard case .committed = try runner.runAct(DeleteStep(tree: sail.tree, step: ID(RecordID(tie.id)))) else {
      Issue.record("Tie a bowline was not deleted")
      return
    }
    await shows(model, board: ["3 of 7", "upNext: Read the wind", "locked: Leave the dock, Sail a triangle, Sail solo",
                               "done: Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)
    #expect(model.draft == nil)

    model.newStep(from: .foot)
    #expect(model.draft != nil)
    model.open(harbour.tree.description, from: .menu)
    await shows(model, board: ["0 of 1", "upNext: Find a berth"], on: engine)
    #expect(model.draft == nil)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_step_open column=upNext door=card surface=document", "roadmap_step_edit door=page step=open",
      "roadmap_board_delete step=confirm view=board", "roadmap_board_delete door=form step=held view=board", "roadmap_board_undo act=delete outcome=ok",
      "roadmap_step_edit door=page step=open", "roadmap_board_create door=foot step=open view=board", "roadmap_sheet door=menu step=switch",
    ])
  }
}
