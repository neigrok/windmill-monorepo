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

// A step that opens a roadmap (Roadmap on iOS §6; Roadmap · iOS 04.6, 07.1 to 07.11b): what the room shows of it on the
// Board, the step's page and the Graph, the odd ends, going in and back on the room's one stack, attaching, changing and
// detaching with Undo, and the step form's Roadmap row, over a phone's engine in step mode on the model server.
@Suite(.serialized) @MainActor struct NestedRoadmapsTests {
  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-nested-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // *Learn to sail* with three steps done, and *Become a day skipper*, whose first step is done and whose second, *Learn to
  // sail*, opens it; the room opens on *Become a day skipper*.
  func skipper(on engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults,
               telemetry: any Telemetry = NoopTelemetry()) async throws -> (model: RoadmapModel, sail: CreateRoadmap.Result, skipper: ID<RoadmapEntry>) {
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    let skipper = try RoadmapFixture.plant(RoadmapFixture.others[1], opening: sail.tree, by: runner).tree
    engine.sync()
    memory.set(skipper.description, forKey: RoadmapModel.lastOpen)
    let model = RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner,
                             phone: memory, telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
    model.roomOpened()
    await settle(model, on: engine) { $0.shown?.listed.title == "Become a day skipper" }
    return (model, sail, skipper)
  }

  // The test bundle's copy of the engine notifies no observer in the app's, so each read is asked for, until `done` holds.
  func settle(_ model: RoadmapModel, on engine: SteppedEngine, until done: (RoadmapModel) -> Bool) async {
    for _ in 0..<100 where !done(model) {
      await engine.settleViews()
      model.observe()
    }
    #expect(done(model))
  }

  func row(_ label: String, in model: RoadmapModel) throws -> RoadmapModel.Row { try #require(find(label, in: model)) }

  func arriving(_ label: String, in model: RoadmapModel) async throws -> RoadmapModel.Row {
    for _ in 0..<800 where find(label, in: model) == nil { try await Task.sleep(for: .milliseconds(10)) }
    return try row(label, in: model)
  }

  // A step's row while a read is awaited, which may not hold it yet.
  func find(_ label: String, in model: RoadmapModel) -> RoadmapModel.Row? { model.shown?.rows.values.first { $0.step.label == label } }

  // A row as the room shows it: its group, its pill, what its page's status row and Roadmap footer say, and its foot.
  func shown(_ label: String, in model: RoadmapModel) throws -> String {
    let row = try row(label, in: model)
    let open = try #require(model.shown)
    let page = try #require(open.page(of: row.id))
    let opening = try #require(row.opening)
    let footer = [opening.rule(of: row, in: open, detaches: model.owns), row.marked ? RoadmapModel.Opened.markAside(relocks: open.graph.unlocks(row.id).count) : nil]
    return [row.card.column.rawValue, opening.face.rawValue, opening.pill ?? "-", opening.progress ?? "-", RoadmapStepPage.detail(of: page, in: open),
            footer.compactMap { $0 }.joined(separator: " "), row.completes ? "completes" : opening.primary].joined(separator: " | ")
  }

  func told(_ telemetry: TelemetryRecorder, _ names: Set<String>) -> [String] {
    telemetry.entries.withLock {
      $0.filter { names.contains($0.name) }.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" }
    }
  }

  @Test func aStepThatOpensARoadmapShowsWhatItComesToOnTheBoardItsPageAndTheGraph() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (model, sail, _) = try await skipper(on: engine, runner, memory)
    let learn = try row("Learn to sail", in: model)
    let opening = try #require(learn.opening)
    #expect([opening.tree, String(opening.owned), opening.face.rawValue, opening.title ?? "", "\(opening.done) of \(opening.total)"]
      == [sail.tree.description, "false", "open", "Learn to sail", "3 of 8"])
    #expect(!learn.completes && !learn.resets && !learn.marked && learn.opensStanding)
    #expect(try shown("Learn to sail", in: model) == [
      "upNext", "open", "Learn to sail · 3 of 8", "3 of 8 done", "Build · 5 to go in Learn to sail",
      "Done when every step in Learn to sail is done.", "Open Roadmap",
    ].joined(separator: " | "))
    #expect(learn.opening?.gauge == 3.0 / 8 && learn.opening?.line == "3 of 8")
    #expect(model.shown?.graphLines == [learn.id: "3 of 8"])
    #expect(try row("Crew a weekend", in: model).opening == nil)

    // Every step inside done, the step is Done by its roadmap: no Reset, and the footer says why.
    for step in ["read", "tie", "leave", "tri", "solo"] { try RoadmapFixture.complete(step, of: sail, by: runner) }
    engine.sync()
    await settle(model, on: engine) { self.find("Learn to sail", in: $0)?.card.column == .done }
    #expect(try shown("Learn to sail", in: model) == [
      "done", "complete", "Learn to sail · 8 of 8", "8 of 8 done", "Build", "Done because every step in Learn to sail is done.", "Open Roadmap",
    ].joined(separator: " | "))
  }

  @Test func theOddEndsReadAsTheBoardsDrawThem() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (model, sail, skipper) = try await skipper(on: engine, runner, memory)
    guard case .committed(let night, _) = try runner.runAct(CreateRoadmap(title: "Night sailing")) else {
      Issue.record("Night sailing was not planted")
      return
    }
    let steps = try #require(model.shown?.tree.nodes)
    let (crew, day) = (try #require(steps.first { $0.label == "Crew a weekend" }?.id), try #require(steps.first { $0.label == "Skipper a day sail" }?.id))
    let solo = try #require(sail.steps.first { $0.key == "solo" }?.id)
    let writes: [AnyActAction<RoadmapRefusal>] = [
      AnyActAction(PointStep.set(tree: skipper, step: ID(RecordID(crew)), opens: night.tree)),
      AnyActAction(PointStep.set(tree: skipper, step: ID(RecordID(day)), opens: ID(RecordID("t_00000000000000ff")))),
      AnyActAction(PointStep.set(tree: sail.tree, step: solo, opens: skipper)),
    ]
    guard case .committed = try runner.runComposed(writes) else {
      Issue.record("the pointers were not set")
      return
    }
    engine.sync()
    await settle(model, on: engine) { self.find("Skipper a day sail", in: $0)?.opening != nil }

    // A roadmap with no step (07.5a), and the step's Done mark set aside while it opens one.
    #expect(try shown("Crew a weekend", in: model) == [
      "upNext", "empty", "Night sailing · No steps", "No steps", "Build · Can’t complete yet",
      "A roadmap with no steps isn’t done. Add its first. Your Done mark is set aside while it opens a roadmap, so 1 step locks again.", "Open Roadmap",
    ].joined(separator: " | "))
    // A loop (07.5b): Learn to sail's last step opens Become a day skipper back.
    #expect(try shown("Learn to sail", in: model) == [
      "locked", "loop", "Loops back", "3 of 8 done · Loops back", "Build · Needs Crew a weekend · 1 to go",
      "A loop with Become a day skipper: this never completes. Detach one side.", "Open Roadmap",
    ].joined(separator: " | "))
    // A roadmap the phone holds no copy of, and one that is not the person's (07.5c).
    #expect(try shown("Skipper a day sail", in: model) == [
      "locked", "missing", "Not found", "-", "Build · Needs Learn to sail · 2 to go",
      "This roadmap can’t be found. Choose another, or detach it.", "Choose Roadmap",
    ].joined(separator: " | "))
    #expect(try row("Skipper a day sail", in: model).opening?.leads == false)
    #expect(model.name(of: "t_00000000000000ff") == nil && model.name(of: night.tree.description) == "Night sailing")

    // Round the loop once: inside Learn to sail, the step that opens Become a day skipper, which the stack stands in
    // already, goes no deeper.
    model.goIn(try row("Learn to sail", in: model), by: .foot)
    let inside = try #require(model.inside)
    let back = try row("Sail solo", in: inside)
    #expect(back.opening?.face == .loop && back.opening.map(inside.goesIn) == false)
    inside.goIn(back, by: .foot)
    #expect(inside.inside == nil && inside.path.isEmpty)
  }

  @Test func aSubtreeIsNamedByItsStepAndOffersNoChange() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (model, _, skipper) = try await skipper(on: engine, runner, memory)
    let day = try row("Skipper a day sail", in: model).id
    guard case .committed(let made, _) = try runner.runAct(CreateSubtree(tree: skipper, step: ID(RecordID(day)))) else {
      Issue.record("the subtree was not made")
      return
    }
    engine.sync()
    await settle(model, on: engine) { self.find("Skipper a day sail", in: $0)?.opening != nil }
    #expect(try row("Skipper a day sail", in: model).opening?.tree == made.subtree.description)
    #expect(try shown("Skipper a day sail", in: model) == [
      "locked", "empty", "Skipper a day sail · No steps", "No steps yet", "Build · Needs Learn to sail · 1 to go",
      "A roadmap with no steps isn’t done. Add its first.", "Open Subtree",
    ].joined(separator: " | "))
    let draft = StepDraft(editing: try #require(model.shown?.page(of: day)), of: skipper, by: .page, in: model)
    #expect(draft.subtree?.name == "Skipper a day sail" && draft.roadmap == nil)

    // A link to the subtree names one of the person's own, as a link to its root does; one the phone does not hold, none.
    #expect([made.subtree.description, skipper.description, "t_00000000000000ff"].map { model.ownRoot(of: $0) }
      == [skipper.description, skipper.description, nil])
  }

  @Test func goingInPushesTheRoadmapsRoomOnTheOneStackAndBackLetsItGo() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let (model, sail, _) = try await skipper(on: engine, runner, memory, telemetry: telemetry)
    let learn = try row("Learn to sail", in: model)
    model.path = [.step(learn.id, by: .card)]
    model.goIn(learn, by: .foot)
    let inside = try #require(model.inside)
    #expect(model.path == [.step(learn.id, by: .card), .roadmap(sail.tree.description, by: .foot)])
    #expect(inside.depth == 1 && inside.owns && inside.outside === model && inside.links == nil)
    #expect(inside.shown?.listed.title == "Learn to sail" && inside.shown?.board.overall.done == 3)

    // A step's page inside the roadmap gone into stands after the visit that went in, a room deeper.
    let wind = try row("Read the wind", in: inside).id
    inside.path = [.step(wind, by: .card)]
    #expect(model.stack == [RoadmapModel.Stacked(depth: 0, visit: .step(learn.id, by: .card)),
                            RoadmapModel.Stacked(depth: 0, visit: .roadmap(sail.tree.description, by: .foot)),
                            RoadmapModel.Stacked(depth: 1, visit: .step(wind, by: .card))])
    #expect(model.room(at: 1) === inside && model.room(at: 2) == nil)

    // What is done inside is the copy's, and the step that opens the roadmap reads it at once.
    inside.complete(try row("Read the wind", in: inside), by: .page)
    engine.sync()
    await settle(model, on: engine) { self.find("Learn to sail", in: $0)?.opening?.done == 4 }
    #expect(inside.shown?.board.overall.done == 4 && inside.band?.says == .completed(step: "Read the wind", upNext: ["Leave the dock"], inPlace: true))

    // The system's Back pops the step's page, then the roadmap: its room goes, and the band stands on with its Undo.
    model.stack = Array(model.stack.prefix(2))
    #expect(inside.path == [] && model.inside === inside)
    model.stack = Array(model.stack.prefix(1))
    #expect(model.inside == nil && model.path == [.step(learn.id, by: .card)])
    #expect(model.band?.says == .completed(step: "Read the wind", upNext: ["Leave the dock"], inPlace: true))
    #expect(told(telemetry, ["roadmap_tree_open", "roadmap_tree_back"]) == ["roadmap_tree_open door=foot view=board", "roadmap_tree_back "])
    model.undo()
    engine.sync()
    await settle(model, on: engine) { self.find("Learn to sail", in: $0)?.opening?.done == 3 }

    // Going in by the swipe, and the roadmap's room leaving with the roadmap switched.
    model.goIn(learn, by: .swipe)
    #expect(model.inside != nil)
    model.path = []
    #expect(model.inside == nil)
  }

  // *Spanish B1* beside them, which *Learn to sail*'s *Read the wind* opens, so a roadmap stands two rooms deep.
  func spanish(under sail: CreateRoadmap.Result, by runner: ActionRunner) throws -> CreateRoadmap.Result {
    let spanish = try RoadmapFixture.plant(RoadmapFixture.others[0], opening: sail.tree, by: runner)
    let wind = try #require(sail.steps.first { $0.key == "read" }?.id)
    guard case .committed = try runner.runAct(PointStep.set(tree: sail.tree, step: wind, opens: spanish.tree)) else {
      throw AppFailure(message: "Read the wind opens no roadmap.")
    }
    return spanish
  }

  // Into *Learn to sail* from its step, and on into *Spanish B1* from *Read the wind*'s page, where *Order at a café*'s note
  // stands open: the room two deep.
  // A room gone into reads its roadmap at once on the stepped engine and a moment later on the app's live one.
  func twoDeep(_ model: RoadmapModel) async throws -> (inside: RoadmapModel, deepest: RoadmapModel) {
    let learn = try row("Learn to sail", in: model)
    model.path = [.step(learn.id, by: .card)]
    model.goIn(learn, by: .foot)
    let inside = try #require(model.inside)
    let wind = try await arriving("Read the wind", in: inside)
    inside.path = [.step(wind.id, by: .card)]
    inside.goIn(wind, by: .foot)
    let deepest = try #require(inside.inside)
    let order = try await arriving("Order at a café", in: deepest).id
    deepest.path = [.step(order, by: .card), .note(of: order)]
    return (inside, deepest)
  }

  @Test func backAcrossTwoRoomsLetsEachGoTheDeepestFirstWithItsNoteSavedAndTheBandStanding() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let (model, sail, _) = try await skipper(on: engine, runner, memory, telemetry: telemetry)
    let spanish = try spanish(under: sail, by: runner)
    engine.sync()
    await settle(model, on: engine) { $0.roadmaps.count == 3 && self.find("Learn to sail", in: $0)?.opening != nil }
    let (inside, deepest) = try await twoDeep(model)
    #expect(deepest.depth == 2 && model.deepest === deepest && inside.deepest === deepest && deepest.root === model)

    // An act two rooms deep shows its band on the stack's one band, and the note's words wait in its draft.
    deepest.complete(try row("Talk about last weekend", in: deepest), by: .page)
    #expect(model.band?.says == .completed(step: "Talk about last weekend", upNext: ["Tell a story"], inPlace: true))
    try #require(deepest.note).text = "Practise at the market"

    // The system's Back to the root's step page, past both rooms at once.
    model.stack = Array(model.stack.prefix(1))
    #expect(model.inside == nil && inside.inside == nil && inside.path.isEmpty && deepest.path.isEmpty && deepest.note == nil)
    #expect(try runner.read(spanish.tree.overlay) { try $0.repository(StepNote.self).all(in: .drawn) }.map(\.text) == ["Practise at the market"])
    #expect(told(telemetry, ["roadmap_tree_open", "roadmap_tree_back", "roadmap_board_workspace"]) == [
      "roadmap_tree_open door=foot view=board", "roadmap_tree_open door=foot view=board",
      "roadmap_board_workspace action=noteSave", "roadmap_tree_back ", "roadmap_tree_back ",
    ])

    // The band stood through Back, and its Undo still takes the act back.
    #expect(model.band?.says == .completed(step: "Talk about last weekend", upNext: ["Tell a story"], inPlace: true))
    model.undo()
    engine.sync()
    await settle(model, on: engine) { $0.roadmaps.first { $0.title == "Spanish B1" }?.counts?.done == 2 }
  }

  // The app leaving the front, and an account change, save a note open two rooms deep as the root's room saves its own.
  @Test func aNoteTwoRoomsDeepIsSavedAsTheAppLeavesTheFrontAndAsTheAccountChanges() async throws {
    let server = JournalModelTransport()
    let app = try LineageFlowTests().fixture(server)
    defer { app.gym.stop() }
    try await app.signIn(server.identity(email: "roadmap-nested@example.com"))
    let model = try #require(app.roadmap)
    let runner = try #require(app.runtime).roadmapRunner
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    let skipper = try RoadmapFixture.plant(RoadmapFixture.others[1], opening: sail.tree, by: runner).tree
    let spanish = try spanish(under: sail, by: runner)
    app.preferences.set(skipper.description, forKey: RoadmapModel.lastOpen)
    await app.runtime?.engine.start()
    model.roomOpened()
    for _ in 0..<800 where model.roadmaps.count < 3 || find("Learn to sail", in: model)?.opening == nil { try await Task.sleep(for: .milliseconds(10)) }
    let deepest = try await twoDeep(model).deepest
    let note = try #require(deepest.note)
    let saved = { () throws -> [String] in try runner.read(spanish.tree.overlay) { try $0.repository(StepNote.self).all(in: .drawn) }.map(\.text) }

    note.text = "Practise at the market"
    app.background()
    #expect(try saved() == ["Practise at the market"])
    note.text = "Practise at the market, twice"
    app.beforeAccountChange()
    #expect(try saved() == ["Practise at the market, twice"])
  }

  @Test func attachingChangingAndDetachingEachTakeUndoAndADoneMarkIsSetAsideNotLost() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let (model, sail, _) = try await skipper(on: engine, runner, memory, telemetry: telemetry)
    guard case .committed(let spanish, _) = try runner.runAct(CreateRoadmap(title: "Spanish B1",
                                                                            steps: ImportedSteps(steps: [ImportedStep(key: "a", RoadmapStep.Changes(label: "Order at a café"))]))) else {
      Issue.record("Spanish B1 was not planted")
      return
    }
    engine.sync()
    await settle(model, on: engine) { $0.roadmaps.count == 3 }

    // Crew a weekend is Done by hand: attaching sets the mark aside, and Learn to sail locks again.
    #expect(model.attach(sail.tree.description, to: try row("Crew a weekend", in: model)).committed != nil)
    #expect(model.band?.says == .attached && model.band?.undo?.act == .step("attach") && model.band?.lasts == .seconds(6))
    await settle(model, on: engine) { self.find("Crew a weekend", in: $0)?.opening != nil }
    #expect(try shown("Crew a weekend", in: model) == [
      "upNext", "open", "Learn to sail · 3 of 8", "3 of 8 done", "Build · 5 to go in Learn to sail",
      "Done when every step in Learn to sail is done. Your Done mark is set aside while it opens a roadmap, so 1 step locks again.", "Open Roadmap",
    ].joined(separator: " | "))
    #expect(try row("Learn to sail", in: model).card.column == .locked)
    model.undo()
    await settle(model, on: engine) { self.find("Crew a weekend", in: $0)?.opening == nil }
    #expect(try row("Crew a weekend", in: model).card.column == .done)

    // Change: Learn to sail's step opens Spanish B1, and Undo returns it to Learn to sail.
    #expect(model.attach(spanish.tree.description, to: try row("Learn to sail", in: model)).committed != nil)
    await settle(model, on: engine) { self.find("Learn to sail", in: $0)?.opening?.tree == spanish.tree.description }
    model.undo()
    await settle(model, on: engine) { self.find("Learn to sail", in: $0)?.opening?.tree == sail.tree.description }

    // Detach asks nothing; the step is ordinary again, and Undo attaches it back.
    model.detach(try row("Learn to sail", in: model))
    #expect(model.band?.says == .detached(markBack: false))
    await settle(model, on: engine) { self.find("Learn to sail", in: $0)?.opening == nil }
    #expect(try row("Learn to sail", in: model).completes)
    model.undo()
    await settle(model, on: engine) { self.find("Learn to sail", in: $0)?.opening != nil }
    #expect(told(telemetry, ["roadmap_tree_attach", "roadmap_board_undo"]) == [
      "roadmap_tree_attach mark=kept step=attach", "roadmap_board_undo act=attach outcome=ok",
      "roadmap_tree_attach mark=none step=change", "roadmap_board_undo act=change outcome=ok",
      "roadmap_tree_attach mark=none step=detach", "roadmap_board_undo act=detach outcome=ok",
    ])
  }

  // A roadmap detached and attached again in one push reads as that roadmap at every read, never as one not found.
  @Test func aRoadmapDetachedAndAttachedAgainIsReadAsItselfThroughout() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (model, sail, _) = try await skipper(on: engine, runner, memory)
    model.detach(try row("Learn to sail", in: model))
    await settle(model, on: engine) { self.find("Learn to sail", in: $0)?.opening == nil }
    #expect(model.attach(sail.tree.description, to: try row("Learn to sail", in: model)).committed != nil)
    var faces: [String] = []
    let overlay = try #require(model.shown?.id).overlay
    let pointers = { () throws -> [String] in
      try engine.drawn(overlay, StepPointer.type).map { "\($0.id) life=\(String(describing: $0.life)) values=\($0.values) pending=\($0.isPending)" }
    }
    var before: [String] = []
    for _ in 0..<20 {
      faces.append(find("Learn to sail", in: model)?.opening?.face.rawValue ?? "none")
      await engine.settleViews()
      model.observe()
      if faces.count == 10 {
        before = try pointers()
        engine.sync()
      }
    }
    let after = try pointers()
    #expect(Set(faces.dropFirst()) == ["open"], "\(faces) before \(before) after \(after)")
  }

  @Test func theFormsRoadmapRowIsWrittenWithTheStepInOneSave() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let telemetry = TelemetryRecorder()
    let (model, sail, skipper) = try await skipper(on: engine, runner, memory, telemetry: telemetry)

    // A new step that opens Learn to sail, made and attached in one save with one Undo.
    model.newStep(from: .foot)
    let made = try #require(model.draft)
    made.name = "Sail at night"
    made.roadmap = sail.tree.description
    #expect(made.isChanged && made.commits)
    made.save()
    #expect(model.draft == nil && model.band?.says == .created(step: "Sail at night", in: .upNext))
    await settle(model, on: engine) { self.find("Sail at night", in: $0)?.opening?.tree == sail.tree.description }

    // Edited to None, the step is ordinary again.
    let night = try row("Sail at night", in: model)
    let edit = StepDraft(editing: try #require(model.shown?.page(of: night.id)), of: skipper, by: .page, in: model)
    #expect(edit.roadmap == sail.tree.description && !edit.isChanged)
    edit.roadmap = nil
    #expect(edit.isChanged)
    edit.save()
    await settle(model, on: engine) { self.find("Sail at night", in: $0)?.opening == nil }
    model.undo()
    await settle(model, on: engine) { self.find("Sail at night", in: $0)?.opening != nil }
    #expect(told(telemetry, ["roadmap_tree_attach"]) == ["roadmap_tree_attach door=form step=attach", "roadmap_tree_attach door=form step=detach"])
  }
}
