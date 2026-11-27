import Foundation
import Synchronization
import Testing
import DomainKit
import RoadmapDomain
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

// The public gallery (Roadmap on iOS §3, §4; Roadmap · iOS 09.12a, 09.12b) over a phone's engine in step mode, with the
// backend's gallery and Fork faked: its pages in the server's order, what each row offers, a row opened as its link, Fork
// with what it needs and the copy opened; and the gallery's answer as the room reads it.
@Suite(.serialized) @MainActor struct PublicGalleryTests {
  final class Phone {
    var online = true
    var credential: SessionToken? = SessionToken("session-1")
    var followed: [ScopeRef] = []
  }

  // The backend's gallery and Fork, answering the pages a test sets, page by page, and keeping what was asked.
  final class Sharing: RoadmapSharing {
    var pages: [String: Result<GalleryPage, SharingFailure>] = [:]
    var copy: Result<String, SharingFailure> = .failure(.failed)
    var asked: [String] = []

    func progress(of tree: String) async throws(SharingFailure) -> OwnersProgress {
      asked.append("progress \(tree)")
      return OwnersProgress(marks: [])
    }

    func fork(_ tree: String, request: String, from mode: RoadmapFork.Mode) async throws(SharingFailure) -> String {
      asked.append("fork \(tree)")
      return try copy.get()
    }

    func gallery(after cursor: String?) async throws(SharingFailure) -> GalleryPage {
      asked.append("gallery \(cursor ?? "start")")
      return try (pages[cursor ?? "start"] ?? .failure(.offline)).get()
    }
  }

  func phone() -> (engine: SteppedEngine, runner: ActionRunner, memory: UserDefaults, suite: String) {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let suite = "roadmap-gallery-\(UUID().uuidString)"
    return (engine, ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)),
            UserDefaults(suiteName: suite)!, suite)
  }

  func room(_ engine: SteppedEngine, _ runner: ActionRunner, _ memory: UserDefaults, phone: Phone, sharing: Sharing,
            telemetry: TelemetryRecorder) -> RoadmapModel {
    let sources = RoadmapCover.Sources(follow: { phone.followed.append($0); return .subscribed }, letGo: { _ in }, online: { phone.online },
                                       signedIn: { phone.credential != nil }, credential: { phone.credential }, requests: sharing,
                                       site: URL(string: "https://windmill.works"))
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

  func told(_ telemetry: TelemetryRecorder, _ names: Set<String>) -> [String] {
    telemetry.entries.withLock {
      $0.filter { names.contains($0.name) }.map { "\($0.name) \($0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))" }
    }
  }

  func row(_ index: Int, _ title: String, steps: Int = 5, mine: Bool = false) -> GalleryPage.Row {
    GalleryPage.Row(id: "t_00000000000000\(String(format: "%02x", index))", title: title, steps: steps, mine: mine)
  }

  func shown(_ gallery: PublicGallery) -> [String] {
    gallery.rows.map { row in
      let offer = switch gallery.offer(for: row) {
      case .mine: "Listed by you"
      case .copy(let copy): "Open Your Copy \(copy)"
      case .fork: "Fork"
      }
      return "\(row.title) · \(row.steps) steps · \(offer)"
    }
  }

  // Pages arrive in the server's order, a later one as the list's last row comes on screen, a row the list shows already
  // never twice, until the last page; one that came to nothing keeps the rows and is asked again by Try Again.
  @Test func theGalleryIsReadAPageAtATimeInTheServersOrder() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    sharing.pages = ["start": .success(GalleryPage(rows: [row(1, "Run a 10k", steps: 14), row(2, "Rust from zero", steps: 24)], next: "2")),
                     "2": .failure(.busy)]
    model.path = [.gallery]
    let gallery = PublicGallery(room: model)
    #expect(gallery.state == .reading)
    gallery.open()
    await settle(engine, model) { gallery.state != .reading }
    #expect(shown(gallery) == ["Run a 10k · 14 steps · Fork", "Rust from zero · 24 steps · Fork"])

    gallery.more()
    await settle(engine, model) { !gallery.paging }
    #expect(gallery.pageFailed && gallery.rows.count == 2 && gallery.state == .rows)
    sharing.pages["2"] = .success(GalleryPage(rows: [row(2, "Rust from zero", steps: 24), row(3, "Room makeover", steps: 11)]))
    gallery.retry()
    await settle(engine, model) { !gallery.paging }
    #expect(shown(gallery) == ["Run a 10k · 14 steps · Fork", "Rust from zero · 24 steps · Fork", "Room makeover · 11 steps · Fork"])
    gallery.more()
    #expect(sharing.asked == ["gallery start", "gallery 2", "gallery 2"])
    #expect(told(telemetry, ["roadmap_gallery"]) == [
      "roadmap_gallery step=open",
      "roadmap_gallery outcome=available step=load",
      "roadmap_gallery outcome=failed step=page",
      "roadmap_gallery step=retry",
      "roadmap_gallery outcome=available step=page",
    ])
  }

  // 09.12b: a gallery that cannot be reached says so, and Try Again reads it from its start; an empty one says so.
  @Test func aGalleryThatCannotBeReachedIsAskedAgainAndAnEmptyOneSaysSo() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    let gallery = PublicGallery(room: model)
    gallery.open()
    await settle(engine, model) { gallery.state != .reading }
    #expect(gallery.state == .unreachable)
    sharing.pages["start"] = .success(GalleryPage(rows: []))
    gallery.retry()
    #expect(gallery.state == .reading)
    await settle(engine, model) { gallery.state != .reading }
    #expect(gallery.state == .empty && gallery.rows.isEmpty)
    #expect(told(telemetry, ["roadmap_gallery"]) == [
      "roadmap_gallery outcome=failed step=load", "roadmap_gallery step=retry", "roadmap_gallery outcome=empty step=load",
    ])
  }

  // What a row offers: nothing on the person's own roadmap; their copy where a roadmap of their list was forked from the row's,
  // the first in the list's order; else Fork.
  @Test func aRowOffersThePersonsCopyWhereTheirListHoldsOneAndFiresNoForkOnTheirOwn() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    let (source, older, newer) = ("t_0000000000000003", "t_00000000000000c1", "t_00000000000000c2")
    let copy = { (id: String, at: Int64) in
      RoadmapTree(id: id, own: true, updatedAt: Instant(ms: at), meta: RoadmapTree.Metadata(title: "Room makeover", root: id, forkedFrom: source))
    }
    model.account = RoadmapAccount([copy(older, 1_000), copy(newer, 2_000)])
    sharing.pages["start"] = .success(GalleryPage(rows: [row(1, "Spanish B1", steps: 40, mine: true), row(3, "Room makeover", steps: 11),
                                                         row(4, "Learn watercolor", steps: 15)]))
    let gallery = PublicGallery(room: model)
    gallery.open()
    // The room reads no copy here, so the account set stands.
    for _ in 0..<200 where gallery.state == .reading { await Task.yield() }
    #expect(shown(gallery) == ["Spanish B1 · 40 steps · Listed by you", "Room makeover · 11 steps · Open Your Copy \(newer)",
                               "Learn watercolor · 15 steps · Fork"])
    gallery.fork(gallery.rows[0])
    gallery.fork(gallery.rows[1])
    #expect(!sharing.asked.contains { $0.hasPrefix("fork") })
  }

  // Fork on a row (09.12a): signed out it asks for a sign-in and forks once one ends with a fresh session, the row then
  // offering the copy the server answered, which opens on its Board once the person's list holds it. With no connection,
  // or a fork that came to nothing, the band says so.
  @Test func forkOnARowAsksWhatItNeedsAndItsCopyOpensOnItsBoard() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    model.roomOpened()
    await settle(engine, model) { model.shown != nil }
    sharing.pages["start"] = .success(GalleryPage(rows: [row(3, "Room makeover", steps: 2), row(4, "Learn watercolor", steps: 15)]))
    model.path = [.roadmaps, .gallery]
    let gallery = PublicGallery(room: model)
    gallery.open()
    await settle(engine, model) { gallery.state != .reading }
    let (makeover, watercolor) = (gallery.rows[0], gallery.rows[1])

    phone.online = false
    gallery.fork(watercolor)
    #expect(model.band?.says == .unforked(offline: true))
    phone.online = true
    gallery.fork(watercolor)
    await settle(engine, model) { gallery.forks[watercolor.id]?.state == .failed }
    #expect(model.band?.says == .unforked(offline: false) && gallery.offer(for: watercolor) == .fork)

    phone.credential = nil
    gallery.fork(makeover)
    #expect(gallery.signingIn?.id == makeover.id)
    gallery.signInEnded()
    #expect(gallery.signingIn == nil && !sharing.asked.contains("fork \(makeover.id)"))

    // The server's copy, made on another phone of the account, which reaches this one by sync.
    let server = engine.device()
    let steps = ImportedSteps(steps: [ImportedStep(key: "a", RoadmapStep.Changes(label: "Pick a palette")),
                                      ImportedStep(key: "b", RoadmapStep.Changes(label: "Paint the walls"))])
    let copier = ActionRunner(replica: server.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    guard case .committed(let made, _) = try copier.runAct(CreateRoadmap(title: "Room makeover", steps: steps)) else {
      Issue.record("the copy was not planted")
      return
    }
    sharing.copy = .success(made.tree.description)
    gallery.fork(makeover)
    // A fresh session reads the gallery again before the fork goes ahead.
    phone.credential = SessionToken("session-2")
    gallery.signInEnded()
    await settle(engine, model) { gallery.offer(for: makeover) != .fork }
    #expect(gallery.offer(for: makeover) == .copy(made.tree.description))
    #expect(sharing.asked.filter { $0.hasPrefix("gallery") } == ["gallery start", "gallery start"])

    gallery.openCopy(made.tree.description)
    #expect(model.path == [])
    engine.sync()
    await settle(engine, model) { model.shown?.id == made.tree }
    #expect(model.shown?.listed.title == "Room makeover" && model.band?.says == .forked(steps: 2))
    #expect(model.roadmaps.map(\.id).contains(sail.tree.description))
    #expect(told(telemetry, ["fork_attempt", "fork_claim", "roadmap_gallery"]) == [
      "roadmap_gallery step=open",
      "roadmap_gallery outcome=available step=load",
      "fork_attempt mode=browse", "fork_attempt mode=browse outcome=offline",
      "fork_attempt mode=browse", "fork_attempt mode=browse outcome=failed",
      "fork_attempt mode=browse", "fork_attempt mode=browse outcome=signed_out",
      "fork_attempt mode=browse", "fork_attempt mode=browse outcome=signed_out",
      "roadmap_gallery outcome=available step=load",
      "fork_attempt mode=browse", "fork_claim mode=browse",
      "roadmap_gallery step=copy",
    ])
  }

  // A row opens its roadmap as its link does: the person's own in the room, anyone else's on a cover over the gallery.
  @Test func aRowOpensItsRoadmapAsItsLinkDoes() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    model.roomOpened()
    await settle(engine, model) { model.shown != nil }
    let theirs = row(3, "Room makeover", steps: 11)
    sharing.pages["start"] = .success(GalleryPage(rows: [theirs, GalleryPage.Row(id: sail.tree.description, title: "Learn to sail", steps: 8, mine: true)]))
    model.path = [.roadmaps, .gallery]
    let gallery = PublicGallery(room: model)
    gallery.open()
    await settle(engine, model) { gallery.state != .reading }

    gallery.open(theirs)
    let cover = try #require(model.links?.cover)
    #expect(cover.address == RoadmapAddress(tree: theirs.id) && model.path == [.roadmaps, .gallery])
    cover.close(.closed)
    gallery.open(gallery.rows[1])
    #expect(model.path == [] && model.links?.cover == nil && model.shown?.id == sail.tree)
    #expect(told(telemetry, ["roadmap_gallery", "roadmap_link_opened"]) == [
      "roadmap_gallery step=open",
      "roadmap_gallery outcome=available step=load",
      "roadmap_gallery mine=false step=row",
      "roadmap_gallery mine=true step=row",
    ])
  }

  // P1, review: a page read signed out says no row is the person's own. A row's Fork asks for a sign-in; once a fresh
  // session ends it, the gallery is read again under that session, and a row the page now says is theirs forks nothing:
  // it opens as its link does. A roadmap the phone holds as theirs offers no Fork at all.
  @Test func aForkAfterASignInForksNothingOnWhatTheSignedOutPageSaid() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let sail = try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    model.roomOpened()
    await settle(engine, model) { model.shown != nil }
    phone.credential = nil
    let theirs = row(5, "Coastal navigation")
    sharing.pages["start"] = .success(GalleryPage(rows: [theirs, GalleryPage.Row(id: sail.tree.description, title: "Learn to sail", steps: 8, mine: false)]))
    model.path = [.roadmaps, .gallery]
    let gallery = PublicGallery(room: model)
    gallery.open()
    await settle(engine, model) { gallery.state != .reading }
    #expect(gallery.offer(for: gallery.rows[1]) == .mine)
    gallery.fork(gallery.rows[0])
    #expect(gallery.signingIn == theirs)
    phone.credential = SessionToken("session-2")
    sharing.pages["start"] = .success(GalleryPage(rows: [GalleryPage.Row(id: theirs.id, title: theirs.title, steps: theirs.steps, mine: true)]))
    gallery.signInEnded()
    await settle(engine, model) { model.links?.cover != nil && sharing.asked.count > 2 }
    #expect(sharing.asked == ["gallery start", "gallery start", "progress \(theirs.id)"])
    #expect(gallery.rows.map(\.id) == [theirs.id] && gallery.offer(for: gallery.rows[0]) == .mine)
    #expect(model.links?.cover?.address == RoadmapAddress(tree: theirs.id))
    #expect(told(telemetry, ["fork_attempt", "fork_claim", "roadmap_gallery"]) == [
      "roadmap_gallery step=open", "roadmap_gallery outcome=available step=load",
      "fork_attempt mode=browse", "fork_attempt mode=browse outcome=signed_out",
      "roadmap_gallery outcome=available step=load", "roadmap_gallery mine=false step=row",
    ])
  }

  // S3, review: a later page whose cursor the server refuses (`400 unknown-cursor`) is never asked for again. The gallery is
  // read from its start, the rows on screen kept in their order and the new ones after them, and goes on from the new
  // cursor.
  @Test func aLaterPageWhoseCursorTheServerRefusesIsReadAgainFromTheStart() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    sharing.pages = ["start": .success(GalleryPage(rows: [row(1, "Run a 10k"), row(2, "Rust from zero")], next: "c1")), "c1": .failure(.refused)]
    let gallery = PublicGallery(room: model)
    gallery.open()
    for _ in 0..<200 where gallery.state == .reading { await Task.yield() }
    sharing.pages["start"] = .success(GalleryPage(rows: [row(3, "Room makeover"), row(1, "Run a 10k"), row(2, "Rust from zero")], next: "c2"))
    sharing.pages["c2"] = .success(GalleryPage(rows: [row(4, "Learn watercolor")]))
    gallery.more()
    for _ in 0..<200 where sharing.asked.count < 3 || gallery.paging { await Task.yield() }
    #expect(gallery.rows.map(\.title) == ["Run a 10k", "Rust from zero", "Room makeover"] && !gallery.pageFailed)
    gallery.more()
    for _ in 0..<200 where gallery.paging { await Task.yield() }
    gallery.more()
    gallery.retry()
    for _ in 0..<200 where gallery.paging { await Task.yield() }
    #expect(gallery.rows.map(\.title) == ["Run a 10k", "Rust from zero", "Room makeover", "Learn watercolor"])
    #expect(sharing.asked == ["gallery start", "gallery c1", "gallery start", "gallery c2", "gallery start"])
    #expect(told(telemetry, ["roadmap_gallery"]) == [
      "roadmap_gallery outcome=available step=load", "roadmap_gallery outcome=failed step=page",
      "roadmap_gallery outcome=available step=load", "roadmap_gallery outcome=available step=page",
      "roadmap_gallery step=retry", "roadmap_gallery outcome=available step=load",
    ])
  }

  // N2, review: a fork whose request finds no connection says so in the band, as a fork tapped with none does.
  @Test func aForkWhoseRequestFindsNoConnectionSaysItNeedsOne() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    sharing.pages["start"] = .success(GalleryPage(rows: [row(1, "Run a 10k")]))
    sharing.copy = .failure(.offline)
    let gallery = PublicGallery(room: model)
    gallery.open()
    for _ in 0..<200 where gallery.state == .reading { await Task.yield() }
    gallery.fork(gallery.rows[0])
    for _ in 0..<200 where gallery.forks[gallery.rows[0].id]?.state == .running { await Task.yield() }
    #expect(gallery.forks[gallery.rows[0].id]?.state == .offline && model.band?.says == .unforked(offline: true))
  }

  // A copy a row's fork answered is offered while it is on its way and once it stands in the person's list; deleted, the
  // row offers Fork again, and so does a session change, which drops what the forks answered.
  @Test func aCopyThatNoLongerStandsOffersForkAgain() async throws {
    let (engine, runner, memory, suite) = phone()
    defer { memory.removePersistentDomain(forName: suite) }
    try RoadmapFixture.plantLearnToSail(runner)
    engine.sync()
    let (phone, sharing, telemetry) = (Phone(), Sharing(), TelemetryRecorder())
    let model = room(engine, runner, memory, phone: phone, sharing: sharing, telemetry: telemetry)
    model.roomOpened()
    await settle(engine, model) { model.shown != nil }
    sharing.pages["start"] = .success(GalleryPage(rows: [row(3, "Room makeover", steps: 1)]))
    let gallery = PublicGallery(room: model)
    gallery.open()
    await settle(engine, model) { gallery.state != .reading }
    let makeover = gallery.rows[0]
    let server = engine.device()
    let copier = ActionRunner(replica: server.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    guard case .committed(let made, _) = try copier.runAct(CreateRoadmap(title: "Room makeover")) else {
      Issue.record("the copy was not planted")
      return
    }
    sharing.copy = .success(made.tree.description)
    gallery.fork(makeover)
    await settle(engine, model) { gallery.copies[makeover.id] != nil }
    #expect(gallery.offer(for: makeover) == .copy(made.tree.description))
    engine.sync()
    await settle(engine, model) { model.roadmaps.contains { $0.id == made.tree.description } }
    gallery.listed()
    #expect(gallery.copies[makeover.id]?.arrived == true && gallery.offer(for: makeover) == .copy(made.tree.description))
    guard case .committed = try runner.runAct(DeleteRoadmap(tree: made.tree)) else {
      Issue.record("the copy was not deleted")
      return
    }
    await settle(engine, model) { !model.roadmaps.contains { $0.id == made.tree.description } }
    gallery.listed()
    #expect(gallery.offer(for: makeover) == .fork)

    gallery.fork(makeover)
    await settle(engine, model) { gallery.offer(for: makeover) != .fork }
    phone.credential = SessionToken("session-2")
    gallery.sessionChanged()
    #expect(gallery.copies.isEmpty && gallery.rows.isEmpty && gallery.state == .reading)
    await settle(engine, model) { gallery.state != .reading }
    #expect(gallery.rows == [makeover] && gallery.offer(for: makeover) == .fork)
  }

  // The gallery asks no account: a session the server no longer takes is told as its 401, and the page is asked again with
  // none, which the room reads.
  @Test func theGalleryIsAskedAgainWithNoSessionWhereTheServerTakesNoneAndAnUnreadRowReportsOnce() async throws {
    let telemetry = TelemetryRecorder()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StaleSessionLoader.self]
    let requests = SharingRequests(baseURL: URL(string: "https://gallery.invalid/"), credential: { SessionToken("session-1") }, online: { true },
                                   telemetry: telemetry, session: URLSession(configuration: configuration))
    StaleSessionLoader.seen.withLock { $0 = [] }
    for _ in 0..<2 {
      let page = try await requests.gallery(after: nil)
      #expect(page.rows == [GalleryPage.Row(id: "t_00000000000000a1", title: "Run a 10k", steps: 14, mine: false)] && page.next == nil && page.unread == 1)
    }
    #expect(StaleSessionLoader.seen.withLock { $0 } == [
      "/v1/gallery?limit=24 auth=Bearer session-1", "/v1/gallery?limit=24 auth=none",
      "/v1/gallery?limit=24 auth=Bearer session-1", "/v1/gallery?limit=24 auth=none",
    ])
    #expect(told(telemetry, ["api_request_failed", "client_error"]) == [
      "api_request_failed failure_kind=http method=GET operation=roadmap_gallery route=/v1/gallery status=401",
      "client_error failure_kind=decode operation=roadmap_gallery",
      "api_request_failed failure_kind=http method=GET operation=roadmap_gallery route=/v1/gallery status=401",
    ])
  }

  // The server's answer as the room reads it: each row's id, title, step count and whether it is the person's own, where
  // the next page starts, and a row it cannot read left out and counted.
  @Test func theGallerysAnswerIsReadRowByRowAndARowItCannotReadIsLeftOut() throws {
    let answer = """
      {"entries": [
        {"id": "t_00000000000000a1", "title": "Run a 10k", "total": 14, "done": 3, "forks": 2, "mine": false, "forked": true,
         "dominantKind": "terracotta", "updatedAt": 1790424000000, "sourceTitle": "Couch to 5k"},
        {"id": "t_00000000000000a2", "title": "Spanish B1", "total": 40, "mine": true, "forked": false},
        {"id": "t_00000000000000a3", "total": 3},
        {"id": "not a roadmap", "title": "Odd", "total": 3},
        {"id": "t_00000000000000a5", "title": "No count"}
      ], "count": 30, "nextCursor": "t_00000000000000a5"}
      """
    let page = try GalleryPage(answer: Data(answer.utf8))
    #expect(page.rows == [
      GalleryPage.Row(id: "t_00000000000000a1", title: "Run a 10k", steps: 14, mine: false),
      GalleryPage.Row(id: "t_00000000000000a2", title: "Spanish B1", steps: 40, mine: true),
      GalleryPage.Row(id: "t_00000000000000a3", title: "", steps: 3, mine: false),
    ])
    #expect(page.next == "t_00000000000000a5" && page.unread == 2)
    #expect(try GalleryPage(answer: Data(#"{"entries": [], "count": 0}"#.utf8)) == GalleryPage(rows: []))
    #expect(throws: (any Error).self) { try GalleryPage(answer: Data("[]".utf8)) }
  }
}

// Answers the gallery at gallery.invalid: 401 to a session, and to none a page of one row it reads and one it cannot.
nonisolated final class StaleSessionLoader: URLProtocol, @unchecked Sendable {
  static let seen = Mutex<[String]>([])
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "gallery.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url else { return }
    let auth = request.value(forHTTPHeaderField: "Authorization") ?? "none"
    Self.seen.withLock { $0.append("\(url.path)?\(url.query ?? "") auth=\(auth)") }
    let (status, body) = auth == "none"
      ? (200, #"{"entries":[{"id":"t_00000000000000a1","title":"Run a 10k","total":14},{"id":"bad","total":1}],"count":2}"#)
      : (401, #"{"error":"unauthenticated"}"#)
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
