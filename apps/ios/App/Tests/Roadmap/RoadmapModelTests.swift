import Foundation
import Testing
import Synchronization
import DomainKit
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct RoadmapModelTests {
  // A phone's engine in step mode on the model server, the runner roadmap's actions take, and what the phone remembers.
  func phone(account: String? = "acct-1") -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: account,
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-model-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room's model over the engine's views of every record and its runner, as the app gives them; a band's time never
  // ends unless a test ends it.
  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry(),
            wait: @escaping RoadmapModel.Wait = { _ in try await Task.sleep(for: .seconds(3_600)) }) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                 telemetry: telemetry, wait: wait)
  }

  // *Learn to sail* with the named steps completed a minute apart, each received before the next is made, so Done,
  // newest first, has an order; the phone's next act comes a minute after the last.
  func learnToSail(on engine: SteppedEngine, _ runner: ActionRunner, done: [String] = ["choose", "parts", "rig"]) throws -> CreateRoadmap.Result {
    let planted = try RoadmapFixture.plantLearnToSail(runner, done: [])
    for step in done {
      engine.advance(ms: 60_000)
      try RoadmapFixture.complete(step, of: planted, by: runner)
      engine.sync()
    }
    engine.advance(ms: 60_000)
    return planted
  }

  func name(_ phase: RoadmapModel.Phase) -> String {
    switch phase {
    case .unread: "unread"
    case .empty: "empty"
    case .open(let open): "open \(open.listed.title ?? "")"
    case .failed: "failed"
    }
  }

  // The test bundle's copy of the engine notifies no observer in the app's, so each read is asked for; AppRuntimeTests observes.
  func shows(_ model: RoadmapModel, _ expected: String, on engine: SteppedEngine) async {
    for _ in 0..<100 where name(model.phase) != expected {
      await engine.settleViews()
      model.observe()
    }
    #expect(name(model.phase) == expected)
  }

  // The open roadmap's Board as its rows tell it: its progress, then each group with its steps' labels in order.
  func board(_ model: RoadmapModel) -> [String] {
    guard case .open(let open) = model.phase else { return [name(model.phase)] }
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

  func told(_ telemetry: TelemetryRecorder) -> [String] {
    telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
  }

  @Test func theRoomListsThePersonsRoadmapsNewestFirstAndOpensTheNewestOrTheOneLastOpen() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let basics = ImportedSteps(steps: [ImportedStep(key: "first", RoadmapStep.Changes(label: "Basics"))])
    guard case .committed(let older, _) = try runner.runAct(CreateRoadmap(title: "Learn Rust", steps: basics)) else {
      Issue.record("Learn Rust was not created")
      return
    }
    engine.sync()
    engine.advance(ms: 60_000)
    let newer = try RoadmapFixture.plantLearnToSail(runner).tree
    engine.sync()

    let model = room(engine, runner, memory)
    model.roomOpened()
    await shows(model, "open Learn to sail", on: engine)
    let listed = model.roadmaps.map { (roadmap: ListedRoadmap) -> String in
      "\(roadmap.id) \(roadmap.title ?? "") \(roadmap.counts.map { "\($0.done) of \($0.total)" } ?? "")"
    }
    #expect(listed == ["\(newer) Learn to sail 3 of 8", "\(older.tree) Learn Rust 0 of 1"])
    #expect(memory.string(forKey: RoadmapModel.lastOpen) == newer.description)

    memory.set(older.tree.description, forKey: RoadmapModel.lastOpen)
    let reopened = room(engine, runner, memory)
    reopened.roomOpened()
    await shows(reopened, "open Learn Rust", on: engine)
    #expect(reopened.roadmaps.map(\.id) == [newer.description, older.tree.description])
  }

  // The Board is the domain's read of the open roadmap: its groups, what a Locked step needs and what an Up next step
  // unlocks, each row with the kind that names its colour and what the room offers on it.
  @Test func theOpenRoadmapsBoardIsTheDomainsReadOfLearnToSail() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let tree = try learnToSail(on: engine, runner).tree
    let model = room(engine, runner, memory)
    model.roomOpened()
    await shows(model, "open Learn to sail", on: engine)
    guard case .open(let open) = model.phase else { return }
    #expect(open.listed.id == tree.description)
    #expect("\(open.board.overall.done) of \(open.board.overall.total)" == "3 of 8")

    let label = { (step: String) -> String in open.tree.step(step)?.label ?? "" }
    let rows = open.groups.flatMap { (group: RoadmapModel.Group) -> [String] in
      group.rows.map { (row: RoadmapModel.Row) -> String in
        let needs = row.card.needs.map { " needs \(label($0.first)) and \($0.extra) more with \($0.toGo) to go" } ?? ""
        let unlocks = row.card.unlocks.map { " unlocks \(label($0.first)) and \($0.extra) more" } ?? ""
        return "\(group.id.rawValue): \(row.step.label) [\(row.kind?.label ?? row.step.color)]\(needs)\(unlocks)\(row.completes ? " completes" : "")\(row.deletes ? " deletes" : "")"
      }
    }
    #expect(rows == [
      "upNext: Read the wind [sky] unlocks Leave the dock and 0 more completes deletes",
      "upNext: Tie a bowline [Learn] completes deletes",
      "locked: Leave the dock [Build] needs Read the wind and 0 more with 1 to go deletes",
      "locked: Sail a triangle [Learn] needs Leave the dock and 0 more with 2 to go deletes",
      "locked: Sail solo [Milestone] needs Sail a triangle and 1 more with 4 to go deletes",
      "done: Rig the boat [Build] deletes",
      "done: Name the boat parts [sky] deletes",
      "done: Choose a sailing course [Build]",
    ])
    #expect(open.keptStep == open.tree.nodes.first { $0.label == "Choose a sailing course" }?.id)
    let followers = ["Name the boat parts", "Read the wind", "Sail solo"].map { (step: String) -> Int in
      open.followers(of: open.tree.nodes.first { $0.label == step }?.id ?? "")
    }
    #expect(followers == [3, 1, 0])
  }

  @Test func aPhoneWithNoRoadmapSaysSoOnlyOnceItsListIsWhole() async throws {
    let (signedOut, localRunner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    let local = room(signedOut, localRunner, memory)
    local.roomOpened()
    await shows(local, "empty", on: signedOut)
    #expect(local.roadmaps.isEmpty)

    let (signedIn, accountRunner, _, _) = phone()
    let account = room(signedIn, accountRunner, memory)
    account.roomOpened()
    await signedIn.settleViews()
    account.observe()
    #expect(name(account.phase) == "unread" && account.views.values.allSatisfy { $0.state != .loading })
    signedIn.sync()
    await shows(account, "empty", on: signedIn)
  }

  @Test func aReadTheRoomCannotMakeStopsItReportsOnceAndTryAgainReadsAnew() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    struct Unreadable: Error {}
    let telemetry = TelemetryRecorder()
    let unreadable = Mutex(true)
    let model = RoadmapModel(records: { scope, type in
      if unreadable.withLock({ $0 }) { throw Unreadable() }
      return try engine.records(scope, type, .drawn, visibleOnly: false)
    }, runner: runner, phone: memory, telemetry: telemetry)
    model.roomOpened()
    #expect(name(model.phase) == "failed")
    model.retry()
    #expect(name(model.phase) == "failed")
    #expect(told(telemetry) == ["roadmap_room_opened ", "client_error failure_kind=unexpected operation=roadmap_read"])

    unreadable.withLock { $0 = false }
    model.retry()
    await shows(model, "empty", on: engine)
  }

  // Roadmap · iOS 02.2: the step moves to Done, what it unlocked comes up next first, and the band's Undo is the kit's
  // Undo of the act, which the account's other phone follows both ways.
  @Test func completingAStepRegroupsTheBoardAndUndoTakesItBack() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try learnToSail(on: engine, runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)

    let leave = try row("Leave the dock", in: model).id
    model.complete(try row("Read the wind", in: model), by: .swipe)
    let band = try #require(model.band)
    #expect(band.says == .completed(step: "Read the wind", upNext: ["Leave the dock"]))
    #expect(band.arrived == [leave] && band.lasts == .seconds(6) && band.undo?.held == false && band.undo?.act == "complete")
    let completed = ["4 of 8", "upNext: Leave the dock, Tie a bowline", "locked: Sail a triangle, Sail solo",
                     "done: Read the wind, Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: completed, on: engine)
    #expect(model.folded == [.done])

    let other = engine.device()
    let elsewhere = room(other, ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)), memory)
    engine.sync()
    elsewhere.roomOpened()
    await shows(elsewhere, board: completed, on: other)

    model.undo()
    #expect(model.band == nil)
    await shows(model, board: atRest, on: engine)
    engine.sync()
    await shows(model, board: atRest, on: engine)
    await shows(elsewhere, board: atRest, on: other)
    #expect(told(telemetry) == ["roadmap_room_opened ", "roadmap_board_complete door=swipe", "roadmap_board_undo act=complete outcome=ok"])
  }

  // Signed out nothing is sent, and a completion is taken back the same way.
  @Test func aCompletionMadeSignedOutIsTakenBackOnThePhone() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try learnToSail(on: engine, runner)
    let model = room(engine, runner, memory)
    model.roomOpened()
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)

    model.complete(try row("Tie a bowline", in: model), by: .menu)
    #expect(model.band?.says == .completed(step: "Tie a bowline", upNext: []))
    await shows(model, board: ["4 of 8", "upNext: Read the wind", "locked: Leave the dock, Sail a triangle, Sail solo",
                               "done: Tie a bowline, Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)
    model.undo()
    await shows(model, board: atRest, on: engine)
  }

  // Roadmap · iOS 02.3 and 03.9: the step alone goes, held by the engine with Undo; Undo in the hold brings it back
  // whole, and once the hold ends the delete stands, on the account's other phone too.
  @Test func deletingAStepHoldsItWithUndoAndStandsOnceTheHoldEnds() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try learnToSail(on: engine, runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    let atRest = ["3 of 8", "upNext: Read the wind, Tie a bowline", "locked: Leave the dock, Sail a triangle, Sail solo",
                  "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: atRest, on: engine)

    model.delete(try row("Read the wind", in: model), by: .swipe)
    let held = try #require(model.band)
    #expect(held.says == .deleted(step: "Read the wind") && held.lasts == .milliseconds(9_000) && held.arrived.isEmpty)
    #expect(held.undo.map { [$0.gesture] } == engine.undoOffers().map(\.id) && held.undo?.held == true)
    let deleted = ["3 of 7", "upNext: Leave the dock, Tie a bowline", "locked: Sail a triangle, Sail solo",
                   "done: Rig the boat, Name the boat parts, Choose a sailing course"]
    await shows(model, board: deleted, on: engine)

    model.undo()
    #expect(model.band == nil && engine.undoOffers().isEmpty)
    await shows(model, board: atRest, on: engine)

    model.delete(try row("Read the wind", in: model), by: .menu)
    await shows(model, board: deleted, on: engine)
    engine.advance(ms: Constants.holdMs)
    #expect(engine.undoOffers().isEmpty)
    model.endBand()
    engine.sync()
    let other = engine.device()
    let elsewhere = room(other, ActionRunner(replica: other.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)), memory)
    engine.sync()
    elsewhere.roomOpened()
    await shows(elsewhere, board: deleted, on: other)
    await shows(model, board: deleted, on: engine)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_board_delete door=swipe step=held view=board", "roadmap_board_undo act=delete outcome=ok",
      "roadmap_board_delete door=menu step=held view=board",
    ])
  }

  // An Undo asked after the hold ended finds nothing held: the delete stands, and the room says so in its event alone.
  @Test func anUndoAskedAfterTheHoldEndedLeavesTheDeleteStanding() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    _ = try learnToSail(on: engine, runner)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, "open Learn to sail", on: engine)
    model.delete(try row("Tie a bowline", in: model), by: .swipe)
    engine.advance(ms: Constants.holdMs)
    model.undo()
    #expect(model.band == nil)
    await shows(model, board: ["3 of 7", "upNext: Read the wind", "locked: Leave the dock, Sail a triangle, Sail solo",
                               "done: Rig the boat, Name the boat parts, Choose a sailing course"], on: engine)
    #expect(told(telemetry).last == "roadmap_board_undo act=delete outcome=unavailable")
  }

  // Roadmap · iOS 02.12's rule at the room's door: the one step that follows nothing is kept, and the band says why.
  @Test func aRoadmapKeepsItsOneStartingStep() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, "open Learn to sail", on: engine)
    let atRest = board(model)

    model.delete(try row("Choose a sailing course", in: model), by: .menu)
    #expect(model.band == RoadmapModel.Band(refused: .keepsStartingStep))
    #expect(engine.undoOffers().isEmpty)
    await shows(model, board: atRest, on: engine)
    #expect(told(telemetry) == ["roadmap_room_opened ", "roadmap_write_refused refusal=startingStep write=DeleteNode"])
  }

  // What the domain refuses is told with its kind and shows nothing; a commit that fails is reported and shows nothing.
  @Test func aWriteTheDomainRefusesOrTheStoreFailsLeavesTheBoardAsItWas() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    guard case .committed(let harbour, _) = try runner.runAct(CreateRoadmap(title: "Harbour days", steps: ImportedSteps(steps: [ImportedStep(key: "berth", RoadmapStep.Changes(label: "Find a berth"))]))),
          let tie = sail.steps.first(where: { $0.key == "tie" })?.id,
          case .committed = try runner.runAct(PointStep.set(tree: sail.tree, step: tie, opens: harbour.tree)) else {
      Issue.record("the roadmaps were not planted")
      return
    }
    memory.set(sail.tree.description, forKey: RoadmapModel.lastOpen)
    let telemetry = TelemetryRecorder()
    let model = room(engine, runner, memory, telemetry: telemetry)
    model.roomOpened()
    await shows(model, "open Learn to sail", on: engine)
    let atRest = board(model)

    let opens = try row("Tie a bowline", in: model)
    #expect(opens.opensStanding && !opens.completes && opens.deletes)
    model.complete(opens, by: .menu)
    #expect(model.band == nil)

    let read = try row("Read the wind", in: model)
    engine.failNextCommit()
    model.complete(read, by: .swipe)
    #expect(model.band == nil)

    memory.set(harbour.tree.description, forKey: RoadmapModel.lastOpen)
    await shows(model, "open Harbour days", on: engine)
    model.complete(read, by: .swipe)
    #expect(model.band == nil)

    memory.set(sail.tree.description, forKey: RoadmapModel.lastOpen)
    await shows(model, "open Learn to sail", on: engine)
    await shows(model, board: atRest, on: engine)
    #expect(told(telemetry) == [
      "roadmap_room_opened ", "roadmap_write_refused refusal=invalid write=mark", "client_error failure_kind=storage operation=roadmap_write",
      "roadmap_write_refused refusal=gone write=mark",
    ])
  }

  // Roadmap · iOS 02.15 and 01.12: a roadmap with no step has no group, and once every step is done Done opens by itself.
  @Test func theBoardAtItsEndsHasNoGroupOrDoneOpenByItself() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    guard case .committed = try runner.runAct(CreateRoadmap(title: "Night sailing")) else {
      Issue.record("Night sailing was not planted")
      return
    }
    let model = room(engine, runner, memory)
    model.roomOpened()
    await shows(model, board: ["0 of 0"], on: engine)
    guard case .open(let empty) = model.phase else { return }
    #expect(!empty.everyStepDone && empty.keptStep == nil)

    engine.advance(ms: 60_000)
    _ = try learnToSail(on: engine, runner, done: ["choose", "parts", "rig", "read", "tie", "leave", "tri"])
    memory.removeObject(forKey: RoadmapModel.lastOpen)
    let done = "Sail a triangle, Leave the dock, Tie a bowline, Read the wind, Rig the boat, Name the boat parts, Choose a sailing course"
    await shows(model, board: ["7 of 8", "upNext: Sail solo", "done: \(done)"], on: engine)
    #expect(model.folded == [.done])

    model.complete(try row("Sail solo", in: model), by: .swipe)
    await shows(model, board: ["8 of 8", "done: Sail solo, \(done)"], on: engine)
    guard case .open(let finished) = model.phase else { return }
    #expect(finished.everyStepDone && model.folded.isEmpty)

    model.undo()
    await shows(model, board: ["7 of 8", "upNext: Sail solo", "done: \(done)"], on: engine)
    #expect(model.folded == [.done])
  }

  // One band: a newer receipt replaces the one showing, whose act the engine then keeps no Undo of, and a band leaves
  // once its time is over.
  @Test func aNewerBandReplacesTheOneShowingAndABandLeavesWhenItsTimeIsOver() async throws {
    let (engine, runner, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    try RoadmapFixture.plantLearnToSail(runner)
    let time = Mutex<[CheckedContinuation<Void, Never>]>([])
    let model = room(engine, runner, memory) { _ in await withCheckedContinuation { waiting in time.withLock { $0.append(waiting) } } }
    model.roomOpened()
    await shows(model, "open Learn to sail", on: engine)

    model.complete(try row("Read the wind", in: model), by: .swipe)
    let first = try #require(model.band?.undo?.gesture)
    model.complete(try row("Tie a bowline", in: model), by: .swipe)
    #expect(model.band?.says == .completed(step: "Tie a bowline", upNext: []))
    #expect(try runner.undo(first) == .unavailable(requestId: nil, reason: "not-reversible"))

    for _ in 0..<1_000 where time.withLock({ $0.count }) < 2 { await Task.yield() }
    for waiting in time.withLock({ $0 }) { waiting.resume() }
    for _ in 0..<1_000 where model.band != nil { await Task.yield() }
    #expect(model.band == nil)
  }
}
