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
// mode, with the engine's following of a scope and the backend's sharing requests faked; and the requests themselves over
// a session whose loader answers each status a test names.
@Suite(.serialized) @MainActor struct RoadmapCoverTests {
  // What a cover asks of the phone, as the fake records it.
  final class Phone {
    var followed: [ScopeRef] = []
    var letGo: [ScopeRef] = []
    var online = true
    var credential: SessionToken? = SessionToken("session-1")
    // The engine cannot make the views of a shared roadmap's tree scope.
    var copyBroken = false
  }

  // The backend's sharing requests, answering what a test sets and keeping what was asked.
  @MainActor final class Sharing: RoadmapSharing {
    var progress: Result<OwnersProgress, SharingFailure> = .success(OwnersProgress(marks: []))
    var copy: Result<String, SharingFailure> = .failure(.failed)
    var asked: [String] = []

    func progress(of tree: String) async throws(SharingFailure) -> OwnersProgress {
      asked.append("progress \(tree)")
      return try progress.get()
    }

    func fork(_ tree: String, request: String) async throws(SharingFailure) -> String {
      asked.append("fork \(tree) \(request)")
      return try copy.get()
    }

    func gallery(after cursor: String?) async throws(SharingFailure) -> GalleryPage { throw .offline }
  }

  func room(_ engine: SteppedEngine, _ memory: UserDefaults, phone: Phone, sharing: Sharing, telemetry: TelemetryRecorder,
            records: RoadmapModel.Records? = nil) -> RoadmapModel {
    let runner = ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    let sources = RoadmapCover.Sources(follow: { phone.followed.append($0); return .subscribed }, letGo: { phone.letGo.append($0) },
                                       online: { phone.online }, signedIn: { phone.credential != nil }, credential: { phone.credential },
                                       requests: sharing, site: URL(string: "https://windmill.works"))
    return RoadmapModel(records: records ?? { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner,
                        phone: memory, telemetry: telemetry, wait: { _ in try await Task.sleep(for: .seconds(3_600)) },
                        role: .owner(RoadmapLinks(sources: sources)))
  }

  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-cover-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  func link(_ address: String) throws -> ClaimedLink { ClaimedLink(try #require(URL(string: "https://windmill.works" + address))) }

  // A cover over the owner's room for a link, standing as the room's own.
  func cover(_ address: String, over owner: RoadmapModel) throws -> RoadmapCover {
    let links = try #require(owner.links)
    let cover = RoadmapCover(try link(address), over: owner, links: links)
    links.cover = cover
    return cover
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
    let links = try #require(model.links)
    model.roomOpened()
    await settle(engine, [model]) { model.shown != nil }
    let wind = try #require(model.shown?.tree.nodes.first { $0.label == "Read the wind" }?.id)
    let other = "t_00000000000000aa"

    links.follow(try link("/#/app/\(sail.tree)?step=\(wind)"), in: model)
    #expect(model.path == [.step(wind, by: .link)])
    links.follow(try link("/t/\(sail.tree)"), in: model)
    #expect(model.path == [] && links.cover == nil && model.shown?.listed.id == sail.tree.description)

    links.follow(try link("/t/\(other)#?step=wind"), in: model)
    let cover = try #require(links.cover)
    await settle(engine, []) { !sharing.asked.isEmpty }
    #expect(cover.address == RoadmapAddress(tree: other, step: "wind"))
    #expect(phone.followed == [ID<RoadmapEntry>(RecordID(other)).tree])
    #expect(sharing.asked == ["progress \(other)"])
    links.follow(try link("/t/\(other)"), in: model)
    #expect(links.cover === cover)

    links.follow(try link("/t/not-a-roadmap"), in: model)
    #expect(model.path == [.roadmaps] && links.cover == nil && cover.closed)
    #expect(phone.letGo == [ID<RoadmapEntry>(RecordID(other)).tree])
    #expect(told(telemetry, ["roadmap_cover"]).last == "roadmap_cover reason=replaced step=close")
    #expect(told(telemetry, ["roadmap_link_opened", "roadmap_board_step_open"]) == [
      "roadmap_link_opened address=app mine=true target=step",
      "roadmap_board_step_open column=upNext door=link surface=document",
      "roadmap_link_opened address=share mine=true target=roadmap",
      "roadmap_link_opened address=share mine=false target=step",
      "roadmap_link_opened address=share mine=false target=roadmap",
      "roadmap_link_opened address=share target=none",
    ])
  }

  @Test func aLinkThatComesBeforeTheFirstReadIsFollowedOnceTheRoomHasReadThePhonesCopy() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let model = room(engine, memory, phone: Phone(), sharing: Sharing(), telemetry: TelemetryRecorder())
    let links = try #require(model.links)
    links.follow(try link("/t/\(sail.tree)"), in: model)
    #expect(links.pending != nil)
    model.roomOpened()
    await settle(engine, [model]) { links.pending == nil }
    #expect(model.shown?.listed.id == sail.tree.description && links.cover == nil)
  }

  @Test func aCoverShowsAnotherOwnersRoadmapOnItsGraphWithTheirProgressItsNamedStepAndOffersNoAct() async throws {
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
    let wind = try #require(sail.steps.first { $0.key == "read" }?.id.description)
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    sharing.progress = .success(OwnersProgress(marks: owners))
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    let cover = try cover("/t/\(sail.tree)#?step=\(wind)", over: owner)
    cover.open()
    await settle(engine, [cover.room]) { cover.state == .open }

    #expect(cover.state == .open && !cover.room.owns && cover.room.lens == .graph && cover.forks)
    #expect(board(cover.room) == [
      "Learn to sail 2 of 8",
      "upNext: Rig the boat", "upNext: Read the wind", "upNext: Tie a bowline",
      "locked: Leave the dock", "locked: Sail a triangle", "locked: Sail solo",
      "done: Name the boat parts", "done: Choose a sailing course",
    ])
    #expect(cover.room.path == [.step(wind, by: .link)])
    #expect(cover.shared == URL(string: "https://windmill.works/t/\(sail.tree)"))
    #expect(phone.followed == [sail.tree.tree])

    // Every act of the reader's room refuses at the model, the controls the boards leave out aside.
    let row = try #require(cover.room.shown?.step(wind))
    cover.room.complete(row, by: .swipe)
    #expect(cover.room.write(MarkStep.complete(tree: sail.tree, step: ID(RecordID(wind))), as: "mark").committed == nil)
    #expect(try RoadmapTree(id: sail.tree, listed: nil, tree: [], overlay: engine.drawn(sail.tree.overlay, StepMark.type)).marks.count == 2)

    cover.close(.closed)
    #expect(phone.letGo == [sail.tree.tree] && cover.closed)
    #expect(told(telemetry, ["roadmap_cover"]) == ["roadmap_cover read=loaded step=open", "roadmap_cover reason=closed step=close"])
  }

  @Test func aCoverSaysItNeedsAConnectionThatItCannotOpenARoadmapAndThatItShowsSeedsWhereTheProgressFailed() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)

    (phone.online, sharing.progress) = (false, .failure(.offline))
    let offline = try cover("/t/t_00000000000000aa", over: owner)
    offline.open()
    await settle(engine, [offline.room]) { offline.state != .reading }
    #expect(offline.state == .needsConnection)
    phone.online = true
    sharing.progress = .failure(.refused)
    offline.retry()
    await settle(engine, [offline.room]) { offline.state != .reading && sharing.asked.count == 2 }
    #expect(offline.state == .unopenable)
    #expect(sharing.asked == ["progress t_00000000000000aa", "progress t_00000000000000aa"])

    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    sharing.progress = .failure(.failed)
    let seeded = try cover("/t/\(sail.tree)", over: owner)
    seeded.open()
    await settle(engine, [seeded.room]) { seeded.state == .open }
    #expect(seeded.room.shown?.board.overall.done == 0)
    #expect(told(telemetry, ["roadmap_cover"]) == ["roadmap_cover read=offline step=open", "roadmap_cover read=seeds step=open"])
  }

  @Test func aCoverWhoseCopyCannotBeReadSaysSoAndTryAgainReadsItAnew() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    phone.copyBroken = true
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry, records: { scope, type in
      if phone.copyBroken && scope == sail.tree.tree { throw AppFailure(message: "The view cannot be made.") }
      return try engine.records(scope, type, .drawn, visibleOnly: false)
    })
    let cover = try cover("/t/\(sail.tree)", over: owner)
    cover.open()
    await settle(engine, [cover.room]) { cover.state != .reading }
    #expect(cover.state == .failed)
    phone.copyBroken = false
    cover.retry()
    await settle(engine, [cover.room]) { cover.state == .open }
    #expect(cover.state == .open)
    #expect(told(telemetry, ["roadmap_cover", "client_error"]) == [
      "roadmap_cover read=failed step=open", "client_error failure_kind=unexpected operation=roadmap_read",
    ])
  }

  // The reviewer's case: a session the server no longer takes asks for a sign-in, and closing it with no fresh session
  // ends the fork, with one request.
  @Test func aForkTheServerAnswersSignedOutAsksOnceAndASignInClosedWithNoFreshSessionEndsIt() async throws {
    let (engine, _, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    let cover = try cover("/t/t_00000000000000aa", over: owner)
    sharing.copy = .failure(.signedOut)
    cover.fork()
    await settle(engine, []) { cover.forking.state != .running }
    #expect(cover.signingIn == .fork && cover.forking.state == .idle)
    cover.signInEnded()
    #expect(cover.signingIn == nil && cover.forking.state == .idle)
    #expect(sharing.asked == ["fork t_00000000000000aa \(cover.forking.request)"])
    #expect(told(telemetry, ["fork_attempt"]) == ["fork_attempt mode=instant", "fork_attempt mode=instant outcome=unauthenticated"])
  }

  @Test func forkSignedOutRunsOnceAFreshSignInFindsTheRoadmapSomeoneElsesAndItsCopyOpensOnItsBoard() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    owner.roomOpened()
    await settle(engine, [owner]) { owner.shown != nil }
    let cover = try cover("/t/t_00000000000000aa", over: owner)

    phone.credential = nil
    cover.fork()
    #expect(cover.signingIn == .fork && sharing.asked.isEmpty)
    cover.signInEnded()
    #expect(cover.signingIn == nil && sharing.asked.isEmpty)

    // The server's copy is a roadmap of two steps the person's account comes to hold by sync.
    let steps = ImportedSteps(steps: [ImportedStep(key: "a", RoadmapStep.Changes(label: "Read a chart")),
                                      ImportedStep(key: "b", RoadmapStep.Changes(label: "Plot a course"))])
    guard case .committed(let copy, _) = try runner.runAct(CreateRoadmap(title: "Coastal navigation", steps: steps)) else {
      Issue.record("the copy was not planted")
      return
    }
    engine.sync()
    sharing.copy = .success(copy.tree.description)
    cover.fork()
    phone.credential = SessionToken("session-2")
    cover.signInEnded()
    #expect(cover.forking.state == .running)
    await settle(engine, [owner]) { cover.closed }

    #expect(cover.closed && owner.links?.cover == nil)
    #expect(owner.shown?.listed.id == copy.tree.description && owner.lens == .board)
    #expect(owner.band?.says == .forked(steps: 2) && owner.band?.undo == nil)
    #expect(sharing.asked == ["fork t_00000000000000aa \(cover.forking.request)"])
    #expect(owner.roadmaps.map(\.id).contains(sail.tree.description))
    #expect(told(telemetry, ["fork_attempt", "fork_claim", "roadmap_cover"]) == [
      "fork_attempt mode=instant", "fork_attempt mode=instant outcome=signed_out", "fork_attempt mode=instant",
      "fork_attempt mode=instant outcome=signed_out", "fork_attempt mode=instant", "fork_claim mode=instant",
      "roadmap_cover reason=forked step=close",
    ])
  }

  @Test func forkSignedOutOnTheirOwnRoadmapOpensItOnceTheSignInFindsItTheirs() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    owner.roomOpened()
    await settle(engine, [owner]) { owner.shown != nil }
    let cover = try cover("/t/\(sail.tree)", over: owner)
    phone.credential = nil
    cover.fork()
    phone.credential = SessionToken("session-2")
    cover.signInEnded()
    #expect(cover.closed && owner.links?.cover == nil && owner.shown?.listed.id == sail.tree.description)
    #expect(!sharing.asked.contains { $0.hasPrefix("fork") })
  }

  @Test func aForkTheServerRefusesFailsOrFindsBusySaysSoAndAskedAgainNamesTheSameFork() async throws {
    let (engine, _, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    let cover = try cover("/t/t_00000000000000aa", over: owner)

    for answer: SharingFailure in [.refused, .busy] {
      sharing.copy = .failure(answer)
      cover.fork()
      await settle(engine, []) { cover.forking.state != .running }
      #expect(cover.forking.state == .failed)
    }
    phone.online = false
    cover.fork()
    #expect(sharing.asked == ["fork t_00000000000000aa \(cover.forking.request)", "fork t_00000000000000aa \(cover.forking.request)"])
    #expect(told(telemetry, ["fork_attempt"]) == [
      "fork_attempt mode=instant", "fork_attempt mode=instant outcome=refused", "fork_attempt mode=instant", "fork_attempt mode=instant outcome=busy",
    ])
  }

  // The cover follows no subtree, so a step that owns one stands as the server's progress answer says its subtree has come
  // to: Done, dated by the step's own mark as the server dated it, once every step inside is done, as the web's cover has
  // it; and not Done while one is left, its mark set aside.
  @Test func aCoverCountsEachSubtreeAsTheOwnersProgressTellsIt() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner, done: [])
    let wind = try #require(sail.steps.first { $0.key == "read" }?.id)
    guard case .committed(let made, _) = try runner.runAct(CreateSubtree(tree: sail.tree, step: wind)) else {
      Issue.record("the subtree was not made")
      return
    }
    for step in ["choose", "parts"] {
      engine.advance(ms: 60_000)
      try RoadmapFixture.complete(step, of: sail, by: runner)
    }
    engine.sync()
    let owners = try RoadmapTree(id: sail.tree, listed: nil, tree: [], overlay: engine.drawn(sail.tree.overlay, StepMark.type)).marks
    let derived = RoadmapTree.Mark(node: wind.description, status: "complete", outOfOrder: false, recordedAt: Instant(ms: 1_790_424_180_000),
                                   deviceAt: Instant(ms: 0), stamp: .unset)
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)

    sharing.progress = .success(OwnersProgress(marks: owners + [derived], subtrees: [RoadmapAccount.Told(tree: made.subtree.description, counts: Counts(done: 2, total: 2))]))
    let done = try cover("/t/\(sail.tree)", over: owner)
    done.open()
    await settle(engine, [done.room]) { done.state == .open }
    #expect(phone.followed == [sail.tree.tree])
    #expect(board(done.room) == [
      "Learn to sail 3 of 8",
      "upNext: Rig the boat", "upNext: Tie a bowline",
      "locked: Leave the dock", "locked: Sail a triangle", "locked: Sail solo",
      "done: Read the wind", "done: Name the boat parts", "done: Choose a sailing course",
    ])
    let opening = try #require(done.room.account.openings(of: sail.tree.description).first)
    #expect([opening.opening.tree, opening.opening.status.rawValue, String(opening.complete), "\(opening.counts?.done ?? -1) of \(opening.counts?.total ?? -1)"]
      == [made.subtree.description, "unknown", "true", "2 of 2"])
    done.close(.closed)

    sharing.progress = .success(OwnersProgress(marks: owners + [derived], subtrees: [RoadmapAccount.Told(tree: made.subtree.description, counts: Counts(done: 1, total: 2))]))
    let open = try cover("/t/\(sail.tree)", over: owner)
    open.open()
    await settle(engine, [open.room]) { open.state == .open }
    #expect(board(open.room) == [
      "Learn to sail 2 of 8",
      "upNext: Rig the boat", "upNext: Read the wind", "upNext: Tie a bowline",
      "locked: Leave the dock", "locked: Sail a triangle", "locked: Sail solo",
      "done: Name the boat parts", "done: Choose a sailing course",
    ])
  }

  @Test func aSubtreesCoverOffersNoFork() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    let wind = try #require(sail.steps.first { $0.key == "read" }?.id)
    guard case .committed(let made, _) = try runner.runAct(CreateSubtree(tree: sail.tree, step: wind)) else {
      Issue.record("the subtree was not made")
      return
    }
    engine.sync()
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let owner = room(engine, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    let cover = try cover("/t/\(made.subtree)", over: owner)
    cover.open()
    await settle(engine, [cover.room]) { cover.state == .open }
    #expect(cover.state == .open && !cover.forks)
    #expect(phone.followed == [made.subtree.tree, sail.tree.tree])
    cover.fork()
    #expect(!sharing.asked.contains { $0.hasPrefix("fork") })
  }

  // The requests over HTTP: a status the server answers on purpose is told and not reported, a busy server neither, and a
  // request its asker gave up tells nothing.
  @Test func theRequestsTellEachFailureAndReportOnlyWhatNobodyExpects() async throws {
    let telemetry = TelemetryRecorder()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StatusLoader.self, StalledLoader.self]
    let requests = { (base: String) -> SharingRequests in
      SharingRequests(baseURL: URL(string: base), credential: { SessionToken("session-1") }, online: { true }, telemetry: telemetry,
                      session: URLSession(configuration: configuration))
    }
    for (status, expected): (Int, SharingFailure) in [(401, .signedOut), (404, .refused), (503, .busy), (500, .failed)] {
      do throws(SharingFailure) {
        _ = try await requests("https://status.invalid/\(status)/").fork("t_00000000000000aa", request: "r")
        Issue.record("a \(status) forked")
      } catch {
        #expect(error == expected)
      }
    }
    let stalled = Task { try await requests("https://offline.invalid/").progress(of: "t_00000000000000aa") }
    try await Task.sleep(for: .milliseconds(200))
    stalled.cancel()
    guard case .failure(let given) = await stalled.result else {
      Issue.record("a request given up answered")
      return
    }
    #expect(given as? SharingFailure == .cancelled)
    #expect(told(telemetry, ["api_request_failed", "client_error"]) == [
      "api_request_failed failure_kind=http method=POST operation=roadmap_fork route=/v1/trees status=401",
      "api_request_failed failure_kind=http method=POST operation=roadmap_fork route=/v1/trees status=404",
      "api_request_failed failure_kind=http method=POST operation=roadmap_fork route=/v1/trees status=503",
      "api_request_failed failure_kind=http method=POST operation=roadmap_fork route=/v1/trees status=500",
      "client_error failure_kind=http operation=roadmap_fork",
    ])
  }

  @Test func theOwnersProgressIsReadFromTheServersAnswerEachMarkDatedAsThePhoneDatesOneEachSubtreeCountedAndARowItCannotReadLeftOut() throws {
    let answer = """
      {"marks": [
        {"node": "wind", "status": "complete", "at": "1790424000000:0:r_a", "markedAt": 1790424005000},
        {"node": "dock", "status": "none", "at": "1790424001000:2:r_a", "markedAt": 1790424006000, "outOfOrder": true},
        {"node": "night", "status": "complete", "at": "0:0:", "markedAt": 1790424007000},
        {"node": "tie", "status": "complete", "at": "not a stamp"},
        {"status": "complete", "at": "1790424002000:0:r_a"}
      ], "subtrees": [
        {"node": "night", "tree": "t_00000000000000b1", "done": 5, "total": 5},
        {"node": "solo", "tree": "t_00000000000000b2", "done": 0, "total": 0},
        {"node": "tri", "tree": "t_00000000000000b3", "done": 3},
        {"node": "leave", "done": 1, "total": 2}
      ]}
      """
    let read = try OwnersProgress(answer: Data(answer.utf8))
    #expect(read.unread == 4)
    #expect(read.marks.map { "\($0.node) \($0.status) \($0.outOfOrder) \($0.deviceAt?.ms ?? 0) \($0.recordedAt?.ms ?? 0) \($0.stamp?.description ?? "")" } == [
      "wind complete false 1790424000000 1790424005000 1790424000000:0:r_a",
      "dock none true 1790424001000 1790424006000 1790424001000:2:r_a",
      "night complete false 0 1790424007000 0:0:",
    ])
    #expect(read.subtrees.map { "\($0.tree) \($0.counts.done) of \($0.counts.total)" } == ["t_00000000000000b1 5 of 5", "t_00000000000000b2 0 of 0"])
    // An answer of a server that counts no subtree reads with none.
    #expect(try OwnersProgress(answer: Data(#"{"marks": []}"#.utf8)).subtrees.isEmpty)
    #expect(throws: (any Error).self) { try OwnersProgress(answer: Data("[]".utf8)) }
  }
}

// Answers every request to status.invalid with the status its path's first part names, and an empty object.
nonisolated final class StatusLoader: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "status.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url, let status = Int(url.pathComponents.dropFirst().first ?? ""),
          let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil) else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("{}".utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
