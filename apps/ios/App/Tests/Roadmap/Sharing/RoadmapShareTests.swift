import Foundation
import Testing
import UIKit
import DomainKit
import RoadmapDomain
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

// Share (Roadmap on iOS §7.4; Roadmap · iOS 09.1a to 09.2b) over a phone's engine in step mode, with the server's rules,
// so the switch's write reaches the server, which writes the roadmap's reach: the switch on a root alone, what it needs,
// the sentence true now, the address it hands out and what each step tells.
@Suite(.serialized) @MainActor struct RoadmapShareTests {
  // Whether the phone is signed in and has a connection, as a test sets them.
  final class Phone {
    var online = true
    var credential: SessionToken? = SessionToken("session-1")
  }

  final class Sharing: RoadmapSharing {
    func progress(of tree: String) async throws(SharingFailure) -> OwnersProgress { throw .failed }
    func fork(_ tree: String, request: String, from mode: RoadmapFork.Mode) async throws(SharingFailure) -> String { throw .failed }
    func gallery(after cursor: String?) async throws(SharingFailure) -> GalleryPage { throw .failed }
  }

  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-share-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, phone: Phone, telemetry: TelemetryRecorder) -> RoadmapModel {
    let sources = RoadmapCover.Sources(follow: { _ in .subscribed }, letGo: { _ in }, online: { phone.online }, signedIn: { phone.credential != nil },
                                       credential: { phone.credential }, requests: Sharing(), site: URL(string: "https://windmill.works"))
    return RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                        telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) }, role: .owner(RoadmapLinks(sources: sources)))
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
      $0.filter { $0.name == "roadmap_verb" }.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" }
    }
  }

  @Test func theSwitchMakesARootPublicAndPrivateAndWhilePublicTheSheetHandsOutItsAddress() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (phone, telemetry) = (Phone(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, telemetry: telemetry)
    model.roomOpened()
    await settle(engine, model) { model.shown != nil }

    model.openShare()
    let share = try #require(model.share)
    #expect(share.tree == sail.tree && !share.isPublic && share.address == nil && !share.subtrees)
    #expect(share.footer == "Only you can view this roadmap.")
    share.copy()

    // The switch shows the choice at once, and turned again before the copy is read again it writes and tells nothing.
    share.turn(public: true)
    #expect(share.isPublic)
    share.turn(public: true)
    await settle(engine, model) { share.held }
    #expect(share.turned == nil)
    let address = "https://windmill.works/t/\(sail.tree)"
    #expect(share.isPublic && share.address?.absoluteString == address)
    #expect(share.footer == "Anyone with this link can view and fork this roadmap, and it can appear in the public gallery.")
    #expect(model.band == nil)
    engine.sync()
    #expect(try engine.drawn(sail.tree.tree, RoadmapMeta.type).first.map { (try RoadmapMeta(Fields($0))).reach } == "public")
    share.shared()
    share.copy()
    #expect(UIPasteboard.general.url?.absoluteString == address)
    // Turned to where it stands, nothing is written.
    share.turn(public: true)

    share.turn(public: false)
    await settle(engine, model) { !share.isPublic }
    #expect(!share.isPublic && share.address == nil)
    #expect(told(telemetry) == [
      "roadmap_verb step=open verb=share",
      "roadmap_verb outcome=ok step=publish verb=share",
      "roadmap_verb step=link verb=share",
      "roadmap_verb step=copy verb=share",
      "roadmap_verb outcome=ok step=private verb=share",
    ])
  }

  // 09.1c: a step that owns a subtree is named in the sentence, which goes public with the roadmap.
  @Test func aRootWhoseStepOwnsASubtreeSaysSoUnderTheSwitch() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    let wind = try #require(sail.steps.first { $0.key == "read" }?.id)
    guard case .committed = try runner.runAct(CreateSubtree(tree: sail.tree, step: wind)),
          case .committed = try runner.runAct(SetVisibility(tree: sail.tree, visibility: "public")) else {
      Issue.record("the subtree was not made public")
      return
    }
    engine.sync()
    let (phone, telemetry) = (Phone(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, telemetry: telemetry)
    model.roomOpened()
    await settle(engine, model) { model.shown != nil }
    model.openShare()
    let share = try #require(model.share)
    #expect(share.subtrees && share.isPublic)
    #expect(share.footer == "Anyone with this link can view and fork this roadmap, subtrees included, and it can appear in the public gallery.")
  }

  // 09.2a, 09.2b: signed out, or with no connection, the switch waits and the sentence says why; a public roadmap keeps its
  // address offline. Sign In tells it was opened from the sheet.
  @Test func signedOutOrOfflineTheSwitchWaitsAndAPublicRoadmapKeepsItsAddress() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    guard case .committed = try runner.runAct(SetVisibility(tree: sail.tree, visibility: "public")) else {
      Issue.record("the roadmap was not made public")
      return
    }
    engine.sync()
    let (phone, telemetry) = (Phone(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, telemetry: telemetry)
    model.roomOpened()
    await settle(engine, model) { model.shown != nil }
    model.openShare()
    let share = try #require(model.share)

    phone.online = false
    #expect(share.footer == "Sharing needs a connection." && share.address != nil)
    share.turn(public: false)
    await settle(engine, model) { !share.isPublic }
    #expect(share.isPublic)

    phone.credential = nil
    #expect(share.footer == "Sign in to share a roadmap.")
    share.signIn()
    #expect(told(telemetry) == ["roadmap_verb step=open verb=share", "roadmap_verb step=sign_in verb=share"])
  }

  // The sheet stands while the phone's copy is read again and goes once another roadmap is open; a roadmap gone into has
  // no Share.
  @Test func theSheetGoesWithItsRoadmapAndARoadmapGoneIntoHasNone() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    let other = try RoadmapFixture.plant(RoadmapFixture.others[0], opening: sail.tree, by: runner)
    engine.sync()
    let (phone, telemetry) = (Phone(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, telemetry: telemetry)
    memory.set(sail.tree.description, forKey: RoadmapModel.lastOpen)
    model.roomOpened()
    await settle(engine, model) { model.shown != nil }
    model.openShare()
    #expect(model.share != nil)
    model.retry()
    #expect(model.share != nil)
    await settle(engine, model) { model.shown != nil }
    model.open(other.tree.description, from: .menu)
    await settle(engine, model) { model.shown?.id == other.tree }
    #expect(model.share == nil)

    let inside = RoadmapModel(records: model.records, runner: runner, phone: memory, role: .inside(sail.tree.description, subtree: false))
    inside.outside = model
    inside.observe()
    inside.openShare()
    #expect(inside.share == nil)
  }
}
