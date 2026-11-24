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

// What the room tells once of a change that met one made elsewhere, and the one list of what could not land (Roadmap on
// the sync engine §6; Roadmap · iOS 10.2 to 10.5c), over two phones of one account on the model server. A phone is
// offline while it neither sends nor pulls: what the other phone sends meanwhile reaches the server first.
@Suite(.serialized) @MainActor struct RoadmapLandingTests {
  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-landing-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model as the app makes it, reading roadmap's notices and dismissing them through the phone's engine, and
  // standing before the person; a band's time never ends unless a test ends it.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry(),
            copied: TelemetryBuffer<[String]>? = nil) -> RoadmapModel {
    let sync = RoadmapModel.Sync(online: { true }, notices: { try engine.notices("roadmap") }, dismiss: { try engine.replica.dismissNotice($0) })
    let model = RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                             telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) }, sync: sync,
                             clipboard: Clipboard(holdsText: { false }, text: { nil }, copy: { text in copied?.withLock { $0.append(text) } }))
    model.roomOpened()
    model.faces = true
    return model
  }

  // *Learn to sail* with its three steps done a minute apart; the phone's next act comes a minute after the last.
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

  // The other phone's runner, whose removals the engine holds not at all, as a phone that has left its band behind.
  func elsewhere(_ other: SteppedEngine) -> ActionRunner {
    ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0), holdRemovals: false)
  }

  func board(_ model: RoadmapModel) -> [String] {
    guard case .open(let open) = model.phase else { return ["not open"] }
    return ["\(open.board.overall.done) of \(open.board.overall.total)"] + open.groups.map { (group: RoadmapModel.Group) -> String in
      "\(group.id.rawValue): " + group.rows.map(\.step.label).joined(separator: ", ")
    }
  }

  // The test bundle's copy of the engine notifies no observer in the app's, so each read is asked for.
  func shows(_ model: RoadmapModel, board expected: [String], on engine: SteppedEngine) async {
    for _ in 0..<100 where board(model) != expected {
      await engine.settleViews()
      model.observe()
    }
    #expect(board(model) == expected)
  }

  // The model reads again once the views hold every change committed so far, until it holds what is asked of it.
  func reads(_ model: RoadmapModel, on engine: SteppedEngine, until held: () -> Bool) async {
    for _ in 0..<100 where !held() {
      await engine.settleViews()
      model.observe()
    }
  }

  func row(_ label: String, in model: RoadmapModel) throws -> RoadmapModel.Row {
    guard case .open(let open) = model.phase else { throw AppFailure(message: "no roadmap is open") }
    return try #require(open.groups.flatMap(\.rows).first { $0.step.label == label })
  }

  // The line the band tells, where it tells one.
  func told(_ model: RoadmapModel) -> RoadmapModel.LandingLine? {
    guard case .landed(let line)? = model.band?.says else { return nil }
    return line
  }

  func events(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  // Roadmap · iOS 10.1 to 10.3. Offline, the phone makes Reefing basics after Read the wind, and the account's other phone
  // deletes Read the wind, the server taking its delete first. Once the phone syncs, the step lands and follows Name the
  // boat parts past the deleted step, so it stands Up next. The band says so once, with Show, which opens its page, whose
  // footer says when the phone made it and why it follows what it follows. The phone's note lets the line go, so the
  // next visit tells nothing.
  @Test func aStepMadeOfflineInARoadmapChangedElsewhereIsToldOnceByTheBandAndOneFooter() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let planted = try learnToSail(on: engine, runner)
    let other = engine.device()
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    await shows(model, board: ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                               "done: Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)
    let wind = try #require(planted.steps.first { $0.key == "read" }?.id)
    guard case .committed = try elsewhere(other).runAct(DeleteStep(tree: planted.tree, step: wind)) else {
      Issue.record("the other phone did not delete Read the wind")
      return
    }
    other.leave()

    model.newStep(from: .foot)
    let draft = try #require(model.draft)
    draft.name = "Reefing basics"
    draft.kind = "olive"
    draft.toggle(try row("Read the wind", in: model), in: .requires)
    draft.toggle(try row("Leave the dock", in: model), in: .opens)
    draft.save()
    #expect(model.band?.says == .created(step: "Reefing basics", in: .locked))
    await shows(model, board: ["3 of 9", "upNext: Read the wind, Tie a bowline", "locked: Reefing basics, Leave the dock, Sail a triangle, Sail solo",
                               "done: Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)
    #expect(told(model) == nil)
    model.sendBandAway()

    engine.sync()
    await shows(model, board: ["3 of 8", "upNext: Reefing basics, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                               "done: Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)
    let step = draft.step.description
    let line = try #require(told(model))
    #expect(model.band?.says.words == "Reefing basics synced · it now follows Name the boat parts")
    #expect(model.band?.arrived == [step] && model.band?.undo == nil && model.band?.lasts == .seconds(6))
    let made = try #require(model.shown?.tree.step(step)?.createdAt).date.formatted(.dateTime.day().month(.abbreviated))
    #expect(model.landed(on: step)?.footer
            == "Made on this phone on \(made). Read the wind was deleted on another device before it synced, so this step now follows Name the boat parts.")

    model.showLanded(line)
    #expect(model.path == [.step(step, by: .band)] && model.band == nil)
    #expect(model.landed(on: step) == line)

    let next = room(engine, runner, memory)
    await shows(next, board: board(model), on: engine)
    #expect(next.band == nil && next.landed(on: step) == nil)
    #expect(events(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_create door=foot step=open view=board", "roadmap_board_create column=locked step=saved",
      "roadmap_landing place=band rule=follows", "roadmap_board_step_open column=upNext door=band surface=document",
    ])
  }

  // Roadmap · iOS 10.4. Offline, the phone gives Tie a bowline a description while the account's other phone deletes it,
  // the server taking the delete first. The edit is the person's own work, so once the phone syncs the step stands again
  // with it on both phones. The phone held the step as it changed it, so nothing is told (Roadmap on the sync engine §6).
  // A change the phone makes once the delete has reached it, as an edit saved over a read made before, brings its step
  // back too, and that is told once: the band, and the same words under the step's status row.
  @Test func aStepEditedOfflineAgainstADeleteComesBack() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let planted = try learnToSail(on: engine, runner)
    let other = engine.device()
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)
    let (tie, triangle) = (try #require(planted.steps.first { $0.key == "tie" }?.id), try #require(planted.steps.first { $0.key == "tri" }?.id))
    guard case .committed = try elsewhere(other).runAct(DeleteStep(tree: planted.tree, step: tie)) else {
      Issue.record("the other phone did not delete Tie a bowline")
      return
    }
    other.leave()

    model.edit(try #require(model.shown?.page(of: tie.description)))
    let draft = try #require(model.draft)
    draft.description = "A loop that holds, tied with my eyes closed."
    draft.save()
    model.sendBandAway()
    engine.sync()
    let edited = { (room: RoadmapModel) -> Bool in room.shown?.tree.step(tie.description)?.description == "A loop that holds, tied with my eyes closed." }
    await reads(model, on: engine) { edited(model) }
    #expect(edited(model) && board(model) == atRest)
    let elsewhereRoom = room(other, elsewhere(other), memory)
    await reads(elsewhereRoom, on: other) { edited(elsewhereRoom) }
    #expect(edited(elsewhereRoom) && board(elsewhereRoom) == atRest)
    #expect(model.band == nil && model.landed(on: tie.description) == nil)

    guard case .committed = try elsewhere(other).runAct(DeleteStep(tree: planted.tree, step: triangle)) else {
      Issue.record("the other phone did not delete Sail a triangle")
      return
    }
    engine.sync()
    await shows(model, board: ["3 of 7", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail solo",
                               "done: Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)
    let changed = model.write(ChangeStep(tree: planted.tree, step: triangle, changes: RoadmapStep.Changes(description: "Reach, tack and return.")),
                              as: "EditNode")
    #expect(changed.committed != nil)
    engine.sync()
    await reads(model, on: engine) { told(model) != nil }
    #expect(board(model) == atRest)
    let line = try #require(told(model))
    #expect(line.rule == .cameBack && model.band?.arrived == [triangle.description])
    #expect(model.band?.says.words == "Sail a triangle is back · you edited it while it was removed elsewhere")
    #expect(model.landed(on: triangle.description)?.footer == "Sail a triangle is back · you edited it while it was removed elsewhere")
    let back = { (room: RoadmapModel) -> Bool in room.shown?.tree.step(triangle.description)?.description == "Reach, tack and return." }
    await reads(elsewhereRoom, on: other) { back(elsewhereRoom) }
    #expect(back(elsewhereRoom) && board(elsewhereRoom) == atRest && elsewhereRoom.band == nil)
    #expect(events(telemetry) == [
      "roadmap_room_opened ", "roadmap_step_edit door=page step=open",
      "roadmap_board_edit description=true kind=false links=false name=false opens=false prerequisites=false roadmap=false step=saved",
      "roadmap_landing place=band rule=cameBack",
    ])
  }

  // Roadmap · iOS 10.5a to 10.5c. Offline, the phone adds Anchor at night to Winter refit and writes the note of its Plan
  // the watch rota, while the account's other phone deletes the roadmap. Neither can land: once the phone syncs, both are
  // listed in Set Aside under Winter refit, with why, as the room last read their names, and the title menu counts them.
  // Copy puts a change's words on the pasteboard; Discard takes one from the phone asking nothing; Discard All asks once
  // and takes the rest, and the list closes. Each change that cannot land is told once.
  @Test func aChangeToARoadmapDeletedElsewhereIsSetAsideWithCopyAndDiscard() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try learnToSail(on: engine, runner)
    let steps = ImportedSteps(steps: [ImportedStep(key: "rota", RoadmapStep.Changes(label: "Plan the watch rota"))])
    guard case .committed(let refit, _) = try runner.runAct(CreateRoadmap(title: "Winter refit", steps: steps)) else {
      Issue.record("Winter refit was not planted")
      return
    }
    let rota = try #require(refit.steps.first?.id)
    memory.set(sail.tree.description, forKey: RoadmapModel.lastOpen)
    let other = engine.device()
    engine.sync()
    let telemetry = TelemetryRecorder()
    let copied = TelemetryBuffer<[String]>([])
    let model = room(engine, runner, memory, telemetry: telemetry, copied: copied)
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)
    #expect(model.roadmaps.map { $0.title ?? "" }.sorted() == ["Learn to sail", "Winter refit"])
    guard case .committed = try elsewhere(other).runAct(DeleteRoadmap(tree: refit.tree)) else {
      Issue.record("the other phone did not delete Winter refit")
      return
    }
    other.leave()

    let anchor = CreateStep(tree: refit.tree, step: RoadmapStep.Changes(label: "Anchor at night", description: "Drop the hook in the lee of the island."),
                            prerequisites: [rota])
    guard case .committed = try runner.runAct(anchor) else {
      Issue.record("Anchor at night was not made")
      return
    }
    var note = Draft(new: StepNote(id: DomainKit.ID(rota.record)), in: refit.tree.overlay)
    note.current.text = "Two on, two off, from dusk."
    guard case .saved = runner.save(&note, SaveStepNote.self) else {
      Issue.record("Plan the watch rota's note was not written")
      return
    }
    engine.sync()
    for _ in 0..<100 where model.setAside.changes.count < 2 || model.roadmaps.count > 1 {
      await engine.settleViews()
      model.observe()
    }
    #expect(model.roadmaps.map { $0.title ?? "" } == ["Learn to sail"])
    let listed = model.setAside.groups.map { (group: SetAside.Group) -> [String] in
      ["\(group.name ?? "none"): \(group.reason.words)"] + group.changes.map { "\($0.title) · \($0.line) · \($0.text)" }
    }
    #expect(listed == [[
      "Winter refit: The roadmap was deleted elsewhere.",
      "Anchor at night · New step · Anchor at night\n\nDrop the hook in the lee of the island.",
      "Plan the watch rota · Note edited · Two on, two off, from dusk.",
    ]])

    model.openSetAside()
    #expect(model.setAsideOpen)
    let (made, written) = (model.setAside.changes[0], model.setAside.changes[1])
    model.copy(made, by: .menu)
    #expect(copied.withLock { $0 } == ["Anchor at night\n\nDrop the hook in the lee of the island."])
    model.discard(made, by: .swipe)
    #expect(model.setAside.changes == [written] && model.setAsideOpen)
    #expect(try engine.notices("roadmap").map(\.id) == [written.id])

    model.askDiscardAll()
    #expect(model.asksDiscardAll)
    model.answerDiscardAll(false)
    #expect(model.setAside.changes == [written])
    model.askDiscardAll()
    model.answerDiscardAll(true)
    #expect(model.setAside.groups.isEmpty && !model.setAsideOpen && !model.asksDiscardAll)
    #expect(try engine.notices("roadmap").isEmpty)
    model.observe()
    #expect(model.setAside.groups.isEmpty)
    #expect(events(telemetry) == [
      "roadmap_room_opened ", "roadmap_write_cannot_land reason=roadmapDeleted", "roadmap_write_cannot_land reason=roadmapDeleted",
      "roadmap_kept count=2-5 step=open", "roadmap_kept door=menu outcome=copied reason=roadmapDeleted step=copy",
      "roadmap_kept door=swipe reason=roadmapDeleted step=discard", "roadmap_kept count=1 step=ask", "roadmap_kept step=cancel",
      "roadmap_kept count=1 step=ask", "roadmap_kept count=1 step=discardAll",
    ])
  }
}
