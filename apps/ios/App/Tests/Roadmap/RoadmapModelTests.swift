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

  // The room's model over the engine's views of every record, as the app gives them.
  func room(_ engine: SteppedEngine, _ memory: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) -> RoadmapModel {
    RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, phone: memory, telemetry: telemetry)
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
    let newer = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()

    let model = room(engine, memory)
    model.roomOpened()
    await shows(model, "open Learn to sail", on: engine)
    let listed = model.roadmaps.map { (roadmap: ListedRoadmap) -> String in
      "\(roadmap.id) \(roadmap.title ?? "") \(roadmap.counts.map { "\($0.done) of \($0.total)" } ?? "")"
    }
    #expect(listed == ["\(newer) Learn to sail 3 of 8", "\(older.tree) Learn Rust 0 of 1"])
    #expect(memory.string(forKey: RoadmapModel.lastOpen) == newer.description)

    memory.set(older.tree.description, forKey: RoadmapModel.lastOpen)
    let reopened = room(engine, memory)
    reopened.roomOpened()
    await shows(reopened, "open Learn Rust", on: engine)
    #expect(reopened.roadmaps.map(\.id) == [newer.description, older.tree.description])
  }

  // The Board is the domain's read of the open roadmap: its groups, what a Locked step needs and what an Up next step unlocks.
  @Test func theOpenRoadmapsBoardIsTheDomainsReadOfLearnToSail() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let tree = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let model = room(engine, memory)
    model.roomOpened()
    await shows(model, "open Learn to sail", on: engine)
    guard case .open(let open) = model.phase else { return }
    #expect(open.listed.id == tree.description)
    #expect("\(open.board.overall.done) of \(open.board.overall.total)" == "3 of 8")

    let label = { (step: String) -> String in open.tree.step(step)?.label ?? "" }
    let groups = open.board.columns.map { (column: BoardRead.Column) -> String in
      let steps = column.ids.map { (step: String) -> String in
        let card = open.board.cards.first { $0.id == step }
        let needs = card?.needs.map { " needs \(label($0.first)) and \($0.extra) more with \($0.toGo) to go" } ?? ""
        let unlocks = card?.unlocks.map { " unlocks \(label($0.first)) and \($0.extra) more" } ?? ""
        return label(step) + needs + unlocks
      }
      return "\(column.name.rawValue): " + steps.joined(separator: "; ")
    }
    #expect(groups == [
      "locked: Leave the dock needs Read the wind and 0 more with 1 to go; Sail a triangle needs Leave the dock and 0 more with 2 to go; "
        + "Sail solo needs Sail a triangle and 1 more with 4 to go",
      "upNext: Read the wind unlocks Leave the dock and 0 more; Tie a bowline",
      "done: Rig the boat; Choose a sailing course; Name the boat parts",
    ])
  }

  @Test func aPhoneWithNoRoadmapSaysSoOnlyOnceItsListIsWhole() async throws {
    let (signedOut, _, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    let local = room(signedOut, memory)
    local.roomOpened()
    await shows(local, "empty", on: signedOut)
    #expect(local.roadmaps.isEmpty)

    let (signedIn, _, _, _) = phone()
    let account = room(signedIn, memory)
    account.roomOpened()
    await signedIn.settleViews()
    account.observe()
    #expect(name(account.phase) == "unread" && account.views.values.allSatisfy { $0.state != .loading })
    signedIn.sync()
    await shows(account, "empty", on: signedIn)
  }

  @Test func aReadTheRoomCannotMakeStopsItReportsOnceAndTryAgainReadsAnew() async throws {
    let (engine, _, memory, suite) = phone(account: nil)
    defer { memory.removePersistentDomain(forName: suite) }
    struct Unreadable: Error {}
    let telemetry = TelemetryRecorder()
    let unreadable = Mutex(true)
    let model = RoadmapModel(records: { scope, type in
      if unreadable.withLock({ $0 }) { throw Unreadable() }
      return try engine.records(scope, type, .drawn, visibleOnly: false)
    }, phone: memory, telemetry: telemetry)
    model.roomOpened()
    #expect(name(model.phase) == "failed")
    model.retry()
    #expect(name(model.phase) == "failed")
    let told = telemetry.entries.withLock { $0.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" } }
    #expect(told == ["roadmap_room_opened ", "client_error failure_kind=unexpected operation=roadmap_read"])

    unreadable.withLock { $0 = false }
    model.retry()
    await shows(model, "empty", on: engine)
  }
}
