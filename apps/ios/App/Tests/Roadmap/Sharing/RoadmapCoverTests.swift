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

// A roadmap's link and a shared roadmap's cover (Roadmap on iOS §3, §4; Roadmap · iOS 09.4 to 09.11): the room's routing
// table, the cover's read of a roadmap someone else owns with its owner's progress, and Fork, over a phone's engine in step
// mode, with the engine's following of a scope and the backend's sharing requests faked.
@Suite(.serialized) @MainActor struct RoadmapCoverTests {
  // What a cover asks of the phone, as the fake records it.
  final class Phone {
    var followed: [ScopeRef] = []
    var letGo: [ScopeRef] = []
    var online = true
    var signedIn = true
  }

  // The backend's sharing requests, answering what a test sets and keeping what was asked.
  final class Sharing: RoadmapSharing {
    var marks: Result<[RoadmapTree.Mark], SharingFailure> = .success([])
    var copy: Result<String, SharingFailure> = .failure(.failed)
    var asked: [String] = []

    func progress(of tree: String) async throws(SharingFailure) -> [RoadmapTree.Mark] {
      asked.append("progress \(tree)")
      return try marks.get()
    }

    func fork(_ tree: String, request: String) async throws(SharingFailure) -> String {
      asked.append("fork \(tree) \(request)")
      return try copy.get()
    }
  }

  func room(_ engine: SteppedEngine, _ memory: UserDefaults, phone: Phone, sharing: Sharing, telemetry: TelemetryRecorder) -> RoadmapModel {
    let runner = ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    let sources = RoadmapCover.Sources(follow: { phone.followed.append($0); return .subscribed }, letGo: { phone.letGo.append($0) },
                                       online: { phone.online }, signedIn: { phone.signedIn }, requests: sharing,
                                       site: URL(string: "https://windmill.works"))
    return RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner, phone: memory,
                        telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) }, sources: sources)
  }

  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-cover-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  // The room and a cover read again once the views hold every change and each task has run, until `done` holds.
  func settle(_ engine: SteppedEngine, _ models: [RoadmapModel], until done: () -> Bool) async {
    for _ in 0..<200 where !done() {
      await engine.settleViews()
      for model in models { model.observe() }
      await Task.yield()
    }
  }

  func told(_ telemetry: TelemetryRecorder, _ names: Set<String>) -> [String] {
    telemetry.entries.withLock {
      $0.filter { names.contains($0.name) }.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" }
    }
  }

  func board(_ model: RoadmapModel) -> [String] {
    guard let open = model.shown else { return [] }
    return ["\(open.listed.title ?? "") \(open.board.overall.done) of \(open.board.overall.total)"] + open.groups.flatMap { group in
      group.rows.map { "\(group.id.rawValue): \($0.step.label)\($0.completes ? " completes" : "")\($0.resets ? " resets" : "")\($0.deletes ? " deletes" : "")" }
    }
  }

  @Test func aLinkOpensThePersonsOwnRoadmapOrItsStepAnyOtherOnACoverAndOneOfNoRoadmapAllRoadmaps() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let model = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    model.roomOpened()
    await settle(engine, [model]) { model.shown != nil }
    let wind = try #require(model.shown?.tree.nodes.first { $0.label == "Read the wind" }?.id)
    let other = "t_00000000000000aa"

    model.follow(ClaimedLink(try #require(URL(string: "https://windmill.works/#/app/\(sail.tree)?step=\(wind)"))))
    #expect(model.path == [.step(wind, by: .link)])
    model.follow(ClaimedLink(try #require(URL(string: "https://windmill.works/t/\(sail.tree)"))))
    #expect(model.path == [] && model.sharedCover == nil && model.shown?.listed.id == sail.tree.description)

    model.follow(ClaimedLink(try #require(URL(string: "https://windmill.works/t/\(other)#?step=wind"))))
    let cover = try #require(model.sharedCover)
    await settle(engine, []) { !sharing.asked.isEmpty }
    #expect(cover.address == RoadmapAddress(tree: other, step: "wind"))
    #expect(phone.followed == [ID<RoadmapEntry>(RecordID(other)).tree])
    #expect(sharing.asked == ["progress \(other)"])

    model.follow(ClaimedLink(try #require(URL(string: "https://windmill.works/t/not-a-roadmap"))))
    #expect(model.path == [.roadmaps] && model.sharedCover == nil && cover.closed)
    #expect(phone.letGo == [ID<RoadmapEntry>(RecordID(other)).tree])
    #expect(told(telemetry, ["roadmap_link_opened", "roadmap_board_step_open"]) == [
      "roadmap_link_opened address=app mine=true target=step",
      "roadmap_board_step_open column=upNext door=link surface=document",
      "roadmap_link_opened address=share mine=true target=roadmap",
      "roadmap_link_opened address=share mine=false target=step",
      "roadmap_link_opened address=share target=none",
    ])
  }

  @Test func aLinkThatComesBeforeTheFirstReadIsFollowedOnceTheRoomHasReadThePhonesCopy() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let model = room(engine, memory, phone: Phone(), sharing: Sharing(), telemetry: TelemetryRecorder())
    model.follow(ClaimedLink(try #require(URL(string: "https://windmill.works/t/\(sail.tree)"))))
    #expect(model.linked != nil)
    model.roomOpened()
    await settle(engine, [model]) { model.linked == nil }
    #expect(model.shown?.listed.id == sail.tree.description && model.sharedCover == nil)
  }

  @Test func aCoverShowsAnotherOwnersRoadmapOnItsGraphWithTheirProgressAndOffersNoActUntilItCloses() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    // The owner completed two steps a minute apart, which the server reads them; the phone holds none of the marks a reader sees.
    let sail = try RoadmapFixture.plantLearnToSail(runner, done: [])
    for step in ["choose", "parts"] {
      engine.advance(ms: 60_000)
      try RoadmapFixture.complete(step, of: sail, by: runner)
      engine.sync()
    }
    let owners = try RoadmapTree(id: sail.tree, listed: nil, tree: [], overlay: engine.drawn(sail.tree.overlay, StepMark.type)).marks
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    sharing.marks = .success(owners)
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    let cover = RoadmapCover(try #require(RoadmapAddress(tree: sail.tree.description)), over: owner, sources: try #require(owner.sources))
    cover.open()
    await settle(engine, [cover.room]) { cover.state == .open }

    #expect(cover.state == .open && cover.room.role == .reader && cover.room.lens == .graph)
    #expect(board(cover.room) == [
      "Learn to sail 2 of 8",
      "upNext: Rig the boat", "upNext: Read the wind", "upNext: Tie a bowline",
      "locked: Leave the dock", "locked: Sail a triangle", "locked: Sail solo",
      "done: Name the boat parts", "done: Choose a sailing course",
    ])
    #expect(cover.link == URL(string: "https://windmill.works/t/\(sail.tree)"))
    #expect(phone.followed == [sail.tree.tree])

    cover.close()
    #expect(phone.letGo == [sail.tree.tree] && cover.closed)
    #expect(told(telemetry, ["roadmap_cover"]) == ["roadmap_cover read=loaded step=open", "roadmap_cover step=close"])
  }

  @Test func aCoverSaysItNeedsAConnectionWhereThePhoneHoldsNoCopyAndThatItCannotOpenOneThePhoneCannotRead() async throws {
    let (engine, _, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    let address = try #require(RoadmapAddress(tree: "t_00000000000000aa"))

    (phone.online, sharing.marks) = (false, .failure(.offline))
    let offline = RoadmapCover(address, over: owner, sources: try #require(owner.sources))
    offline.open()
    await settle(engine, [offline.room]) { offline.state != .reading }
    #expect(offline.state == .needsConnection)

    phone.online = true
    sharing.marks = .failure(.refused)
    offline.retry()
    await settle(engine, [offline.room]) { offline.state != .needsConnection && sharing.asked.count == 2 }
    #expect(offline.state == .unopenable)
    #expect(sharing.asked == ["progress t_00000000000000aa", "progress t_00000000000000aa"])
    #expect(told(telemetry, ["roadmap_cover"]) == ["roadmap_cover read=offline step=open"])
  }

  @Test func forkSignedOutWaitsForTheSignInThenTheServersCopyArrivesOpensOnItsBoardAndTheCoverCloses() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    owner.roomOpened()
    let cover = RoadmapCover(try #require(RoadmapAddress(tree: "t_00000000000000aa")), over: owner, sources: try #require(owner.sources))
    owner.sharedCover = cover

    phone.signedIn = false
    cover.fork()
    #expect(cover.forking == .signingIn && sharing.asked.isEmpty)
    cover.signInEnded()
    #expect(cover.forking == .idle && sharing.asked.isEmpty)

    // The server's copy is a roadmap of two steps the person's account comes to hold by sync.
    let steps = ImportedSteps(steps: [ImportedStep(key: "a", RoadmapStep.Changes(label: "Read a chart")),
                                      ImportedStep(key: "b", RoadmapStep.Changes(label: "Plot a course"))])
    guard case .committed(let copy, _) = try runner.runAct(CreateRoadmap(title: "Coastal navigation", steps: steps)) else {
      Issue.record("the copy was not planted")
      return
    }
    sharing.copy = .success(copy.tree.description)
    cover.fork()
    #expect(cover.forking == .signingIn && sharing.asked.isEmpty)
    phone.signedIn = true
    cover.signInEnded()
    #expect(cover.forking == .running)
    engine.sync()
    await settle(engine, [owner]) { cover.closed }

    #expect(cover.closed && owner.sharedCover == nil)
    #expect(owner.shown?.listed.id == copy.tree.description && owner.lens == .board)
    #expect(owner.band?.says == .forked(steps: 2) && owner.band?.undo == nil)
    #expect(sharing.asked == ["fork t_00000000000000aa \(cover.forkRequest)"])
    #expect(owner.roadmaps.map(\.id).contains(sail.tree.description))
    #expect(told(telemetry, ["fork_attempt", "fork_claim"]) == [
      "fork_attempt mode=instant", "fork_attempt mode=instant outcome=signed_out", "fork_attempt mode=instant",
      "fork_attempt mode=instant outcome=signed_out", "fork_attempt mode=instant", "fork_claim mode=instant",
    ])
  }

  @Test func aForkTheServerRefusesOrThatFailsSaysSoAndAskedAgainNamesTheSameFork() async throws {
    let (engine, _, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    let cover = RoadmapCover(try #require(RoadmapAddress(tree: "t_00000000000000aa")), over: owner, sources: try #require(owner.sources))

    sharing.copy = .failure(.refused)
    cover.fork()
    await settle(engine, []) { cover.forking != .running }
    #expect(cover.forking == .failed)
    sharing.copy = .failure(.failed)
    cover.fork()
    await settle(engine, []) { cover.forking != .running }
    phone.online = false
    cover.fork()
    #expect(sharing.asked == ["fork t_00000000000000aa \(cover.forkRequest)", "fork t_00000000000000aa \(cover.forkRequest)"])
    #expect(told(telemetry, ["fork_attempt", "fork_claim"]) == [
      "fork_attempt mode=instant", "fork_attempt mode=instant outcome=refused", "fork_attempt mode=instant", "fork_attempt mode=instant outcome=failed",
    ])
  }

  @Test func theOwnersProgressIsReadFromTheServersAnswerEachMarkDatedAsThePhoneDatesOneAndARowItCannotReadLeftOut() throws {
    let answer = """
      {"marks": [
        {"node": "wind", "status": "complete", "at": "1790424000000:0:r_a", "markedAt": 1790424005000},
        {"node": "dock", "status": "none", "at": "1790424001000:2:r_a", "markedAt": 1790424006000, "outOfOrder": true},
        {"node": "tie", "status": "complete", "at": "not a stamp"},
        {"status": "complete", "at": "1790424002000:0:r_a"}
      ], "subtrees": []}
      """
    let read = try RoadmapTree.Mark.owners(Data(answer.utf8))
    #expect(read.unread == 2)
    #expect(read.read.map { "\($0.node) \($0.status) \($0.outOfOrder) \($0.deviceAt?.ms ?? 0) \($0.recordedAt?.ms ?? 0) \($0.stamp?.description ?? "")" } == [
      "wind complete false 1790424000000 1790424005000 1790424000000:0:r_a",
      "dock none true 1790424001000 1790424006000 1790424001000:2:r_a",
    ])
    #expect(throws: (any Error).self) { try RoadmapTree.Mark.owners(Data("[]".utf8)) }
  }
}
