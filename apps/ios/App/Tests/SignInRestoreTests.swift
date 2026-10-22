import Foundation
import Testing
import SyncCore
import DomainKit
import GymDomain
@testable import Windmill

@Suite @MainActor struct SignInRestoreTests {
  @Test func theRoomLastWrittenToOpensAndTheCountsSayWhatHasLanded() throws {
    let start = Date(timeIntervalSince1970: 1_000)
    var restore = try #require(SignInRestore(method: "apple", holdings: [
      "journal": .init(count: 142, lastWrittenAt: 1_000), "gym": .init(count: 38, lastWrittenAt: 2_000),
    ], at: start))
    #expect(restore.rooms == [.journal, .gym] && restore.opening == .gym)
    #expect([restore.eyebrow, restore.line] == ["SIGNED IN WITH APPLE", "Opening Gym as soon as it’s ready."])
    restore.land([.journal: 64, .gym: 31], arrived: [.journal], at: start)
    #expect([restore.count(.journal), restore.count(.gym)] == ["64 of 142 pages", "31 of 38 workouts"])
    #expect(restore.step(at: start, reachable: true) == nil)
    restore.land([.journal: 142, .gym: 40], arrived: [.journal, .gym], at: start)
    #expect(restore.count(.gym) == "38 of 38 workouts")
    #expect(restore.step(at: start, reachable: true) == .open(.gym))
    restore.opened = true
    restore.land([.journal: 142, .gym: 38], arrived: [.gym], at: start)
    #expect(restore.step(at: start, reachable: true) == nil)
    restore.land([.journal: 142, .gym: 38], arrived: [.gym, .journal], at: start)
    #expect(restore.step(at: start, reachable: true) == .complete)
  }

  // A hung pull or a server backing off lands nothing: after ten still seconds the room opens, as out of reach does at once.
  @Test func theRoomOpensWhenNothingLandsForTenSecondsOrTheServerIsOutOfReach() throws {
    let start = Date(timeIntervalSince1970: 1_000)
    var restore = try #require(SignInRestore(method: "email", holdings: [
      "journal": .init(count: 142, lastWrittenAt: 3_000), "gym": .init(count: 38, lastWrittenAt: 2_000),
    ], at: start))
    #expect(restore.step(at: start, reachable: false) == .open(.journal))
    restore.land([.journal: 7, .gym: 12], arrived: [], at: start.addingTimeInterval(6))
    #expect(restore.step(at: start.addingTimeInterval(12), reachable: true) == nil)
    restore.land([.journal: 7, .gym: 12], arrived: [], at: start.addingTimeInterval(14))
    #expect(restore.movedAt == start.addingTimeInterval(6))
    #expect(restore.step(at: start.addingTimeInterval(15.9), reachable: true) == nil)
    #expect(restore.step(at: start.addingTimeInterval(16), reachable: true) == .open(.journal))
  }

  @Test func aRoomTheAccountHoldsNothingInIsLeftOutAndNothingAtAllBringsNothingBack() throws {
    let restore = try #require(SignInRestore(method: "email", holdings: [
      "journal": .init(count: 1, lastWrittenAt: 5), "gym": .init(count: 0, lastWrittenAt: nil),
    ], at: Date()))
    #expect(restore.rooms == [.journal] && restore.opening == .journal)
    #expect([restore.eyebrow, restore.line, restore.count(.journal)]
            == ["SIGNED IN WITH EMAIL", "Opening Journal as soon as it’s ready.", "0 of 1 page"])
    #expect(SignInRestore(method: "email", holdings: ["journal": .init(count: 0, lastWrittenAt: nil), "gym": .init(count: 0, lastWrittenAt: nil)], at: Date()) == nil)
    #expect(SignInRestore(method: "email", holdings: [:], at: Date()) == nil)
  }

  // The page is made before the workout and written again after it, so the journal is the room last written to.
  @Test func aSignInFromWhereToStartBringsTheRoomsBackAndOpensTheRoomLastWrittenTo() async throws {
    let server = JournalModelTransport(), remote = try LineageFlowTests().fixture(server)
    try await remote.signIn(server.identity(email: "returning@example.com"))
    remote.journal.type("A page in the account."); remote.journal.done()
    await remote.runtime?.engine.start(); try await AppScenario.backedUp(remote)
    try await Task.sleep(for: .milliseconds(20))
    let workout = remote.runner.mint(Session.self)
    _ = try remote.runner.run(StartSession(id: workout, startedAt: Instant(Date())))
    try await AppModelTests().workoutSettled(remote, workout)
    try await Task.sleep(for: .milliseconds(20))
    remote.journal.type("A page in the account, written again after the workout."); remote.journal.done()
    let remoteStore = try #require(remote.runtime).store
    for _ in 0..<200 where try remoteStore.read({ try !$0.device().activeReplica.outbox.isEmpty }) {
      try await Task.sleep(for: .milliseconds(25))
    }
    remote.gym.stop()

    let recorder = TelemetryRecorder()
    let model = try LineageFlowTests().fixture(server, seed: 31, telemetry: recorder)
    defer { model.gym.stop() }
    model.welcome = true
    try await model.signIn(server.identity(email: "returning@example.com"))
    #expect(model.restore?.totals == [.journal: 1, .gym: 1] && model.restore?.opening == .journal && model.welcome == false)
    await model.runtime?.engine.start()
    for _ in 0..<200 where model.restore != nil {
      model.refresh()
      try await Task.sleep(for: .milliseconds(25))
    }
    #expect(model.restore == nil && model.selectedRoom == .journal)
    let account = try #require(model.account), holdings = try #require(model.runtime).engine.holdings(of: account)
    #expect(model.restoreLanded(.journal) == holdings["journal"]?.count && model.restoreLanded(.gym) == holdings["gym"]?.count)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "sign_in_restore" }.map(\.properties) } ==
            [["stage": "started"], ["stage": "room_opened"], ["stage": "complete"]])
    #expect(TelemetryPrivacy.properties(["stage": "complete", "count": "142", "room": "gym"]) == ["stage": .label("complete"), "room": .label("gym")])
  }
}
