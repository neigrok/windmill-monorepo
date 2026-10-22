import Foundation
import Testing
import SyncCore
import DomainKit
import GymDomain
@testable import Windmill

@Suite @MainActor struct SignInRestoreTests {
  @Test func theRoomWithTheNewestRecordOpensAndTheCountsSayWhatHasLanded() throws {
    let restore = try #require(SignInRestore(method: "apple", holdings: [
      "journal": .init(count: 142, newestAt: 1_000), "gym": .init(count: 38, newestAt: 2_000),
    ]))
    #expect(restore.rooms == [.journal, .gym] && restore.opening == .gym)
    #expect([restore.eyebrow, restore.line] == ["SIGNED IN WITH APPLE", "Opening Gym as soon as it’s ready."])
    #expect([restore.count(.journal, landed: 64), restore.count(.gym, landed: 31), restore.count(.gym, landed: 40)]
            == ["64 of 142 pages", "31 of 38 workouts", "38 of 38 workouts"])
    #expect(restore.step(arrived: [.journal]) == nil)
    #expect(restore.step(arrived: [.gym]) == .open(.gym))
    var opened = restore
    opened.opened = true
    #expect(opened.step(arrived: [.gym]) == nil)
    #expect(opened.step(arrived: [.gym, .journal]) == .complete)
  }

  @Test func aRoomTheAccountHoldsNothingInIsLeftOutAndNothingAtAllBringsNothingBack() throws {
    let restore = try #require(SignInRestore(method: "email", holdings: [
      "journal": .init(count: 1, newestAt: 5), "gym": .init(count: 0, newestAt: nil),
    ]))
    #expect(restore.rooms == [.journal] && restore.opening == .journal)
    #expect([restore.eyebrow, restore.line, restore.count(.journal, landed: 0)]
            == ["SIGNED IN WITH EMAIL", "Opening Journal as soon as it’s ready.", "0 of 1 page"])
    #expect(SignInRestore(method: "email", holdings: ["journal": .init(count: 0, newestAt: nil), "gym": .init(count: 0, newestAt: nil)]) == nil)
    #expect(SignInRestore(method: "email", holdings: [:]) == nil)
  }

  @Test func aSignInFromWhereToStartBringsTheRoomsBackAndOpensTheNewest() async throws {
    let server = JournalModelTransport(), remote = try LineageFlowTests().fixture(server)
    try await remote.signIn(server.identity(email: "returning@example.com"))
    remote.journal.type("A page in the account."); remote.journal.done()
    await remote.runtime?.engine.start(); try await AppScenario.backedUp(remote)
    try await Task.sleep(for: .milliseconds(20))
    let workout = remote.runner.mint(Session.self)
    _ = try remote.runner.run(StartSession(id: workout, startedAt: Instant(Date())))
    try await AppModelTests().workoutSettled(remote, workout)
    remote.gym.stop()

    let recorder = TelemetryRecorder()
    let model = try LineageFlowTests().fixture(server, seed: 31, telemetry: recorder)
    defer { model.gym.stop() }
    model.welcome = true
    try await model.signIn(server.identity(email: "returning@example.com"))
    #expect(model.restore?.totals == [.journal: 1, .gym: 1] && model.restore?.opening == .gym && model.welcome == false)
    await model.runtime?.engine.start()
    for _ in 0..<200 where model.restore != nil {
      model.refresh()
      try await Task.sleep(for: .milliseconds(25))
    }
    #expect(model.restore == nil && model.selectedRoom == .gym)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "sign_in_restore" }.map(\.properties) } ==
            [["stage": "started"], ["stage": "room_opened"], ["stage": "complete"]])
    #expect(TelemetryPrivacy.properties(["stage": "complete", "count": "142", "room": "gym"]) == ["stage": .label("complete"), "room": .label("gym")])
  }
}
