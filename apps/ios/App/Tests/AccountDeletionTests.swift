import Foundation
import Testing
import DomainKit
import JournalDomain
import GymDomain
import SyncEngine
import SyncStore
import SyncSchema
@testable import Windmill

@Suite @MainActor struct AccountDeletionTests {
  @Test func theTypedEmailConfirmsTrimmedInAnyCase() {
    #expect(AccountDeletion.confirms("  Sam@Example.com \n", email: "sam@example.com"))
    #expect(!AccountDeletion.confirms("sam@example.co", email: "sam@example.com"))
    #expect(!AccountDeletion.confirms("", email: ""))
  }

  @Test func theFactsSayWhatGoesAndWhenItCanComeBack() {
    #expect([0, 1, 3].map(AccountDeletion.unconfirmedLine) == [
      nil,
      "1 change on this phone hasn’t been confirmed by your account. It is deleted too.",
      "3 changes on this phone haven’t been confirmed by your account. They are deleted too.",
    ])
    let closes = try! Date("2026-11-21T12:00:00Z", strategy: .iso8601)
    #expect(AccountDeletion.returnLine(closes, locale: Locale(identifier: "en_US")) == "Sign in before Nov 21 to bring it back.")
  }

  // The request names the signed-in id; the account closes, its other sessions end, and this phone holds none of it.
  @Test func deletingClosesTheAccountEndsItsSessionsAndLeavesNothingOnThePhone() async throws {
    let server = JournalModelTransport(), recorder = TelemetryRecorder()
    let identity = server.identity(email: "leaving@example.com"), elsewhere = server.identity(email: "leaving@example.com")
    let model = try LineageFlowTests().fixture(server, telemetry: recorder)
    defer { model.gym.stop() }
    try await model.signIn(identity)
    model.journal.type("A page in the account."); model.journal.done()
    await model.runtime?.engine.start(); try await AppScenario.backedUp(model)
    let drafts = CoachDraftStore()
    try drafts.write(CoachSaved(), account: identity.account)
    model.preferences.set("first-workout", forKey: GymModel.keepReceipt)
    model.openAccountDeletion()
    await model.deleteAccount()
    guard case .deleted = model.deletion else { Issue.record("not deleted: \(String(describing: model.deletion))"); return }
    #expect(model.account == nil && model.welcome && model.accountEmail.isEmpty && model.discardOwed == nil)
    #expect(model.preferences.string(forKey: GymModel.keepReceipt) == "first-workout")
    #expect(server.state.withLock { $0.closedAccounts[identity.account] != nil && $0.sessions[elsewhere.token.value] == nil })
    #expect(try model.runner.read(Journal.scope) { try $0.repository(Page.self).all(in: .drawn).isEmpty })
    #expect(!FileManager.default.fileExists(atPath: drafts.file(identity.account).path))
    #expect(recorder.entries.withLock { $0.filter { $0.name == "account_delete" }.map(\.properties) } == [["state": "shown"], ["outcome": "ok"]])
  }

  @Test func aFailedDeleteKeepsTheAccountAndAsksToTryAgain() async throws {
    let server = JournalModelTransport(), recorder = TelemetryRecorder()
    let identity = server.identity(email: "staying@example.com")
    let model = try LineageFlowTests().fixture(server, telemetry: recorder)
    defer { model.gym.stop() }
    try await model.signIn(identity)
    server.state.withLock { $0.closeOffline = true }
    model.openAccountDeletion()
    await model.deleteAccount()
    #expect(model.deletion == .failed && model.account == identity.account && model.signOutSession == nil)
    #expect(server.state.withLock { $0.closedAccounts.isEmpty })
    model.cancelAccountDeletion()
    #expect(model.deletion == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "account_delete" }.map(\.properties) } ==
            [["state": "shown"], ["outcome": "failed"], ["outcome": "cancelled"]])
  }

  // Every door is held while the account is deleted, so the discard finds what the sign-out counted and lands.
  @Test func everyDoorWaitsWhileTheAccountIsDeleted() async throws {
    let server = JournalModelTransport(), recorder = TelemetryRecorder()
    let identity = server.identity(email: "busy@example.com")
    let model = try LineageFlowTests().fixture(server, telemetry: recorder)
    defer { model.gym.stop() }
    try await model.signIn(identity)
    var routine = Draft(new: Routine(id: model.runner.mint(Routine.self), name: "Full body A", entries: [RoutineEntry(exerciseId: ID("back-squat"))]))
    _ = model.gym.save(&routine)
    await model.runtime?.engine.start()
    server.state.withLock { $0.closeHeldSeconds = 0.2 }
    final class Writing: @unchecked Sendable { var on = true }
    let writing = Writing()
    let writer = Task { @MainActor in
      var tried = 0, taken = 0
      while writing.on {
        if model.deletion == .deleting {
          tried += 1
          let id = model.runner.mint(Session.self)
          if model.gym.run(StartSession(id: id, startedAt: Instant(Date()))) != nil { taken += 1 }
          model.perform(.start(routine.current.id, name: "Full body A"))
          model.journal.type("Written while the account goes.")
        }
        try? await Task.sleep(for: .milliseconds(5))
      }
      return (tried, taken)
    }
    model.openAccountDeletion()
    await model.deleteAccount()
    writing.on = false
    let (tried, taken) = await writer.value
    guard case .deleted = model.deletion else { Issue.record("not deleted: \(String(describing: model.deletion))"); return }
    #expect(tried > 0 && taken == 0)
    #expect(try model.runtime?.account() == nil && model.account == nil)
    #expect(try model.runner.read(Gym.scope) { try $0.repository(Session.self).all(in: .drawn).isEmpty && $0.repository(Routine.self).all(in: .drawn).isEmpty })
    #expect(recorder.entries.withLock { $0.filter { $0.name == "account_delete" || $0.name == "client_error" }.map(\.properties) } == [["state": "shown"], ["outcome": "ok"]])
  }

  // After the close the phone owes its discard: a failed one holds the rooms, tells Sentry, and Try again lands it.
  @Test func aDiscardThatFailsAfterTheCloseIsOwedUntilTryAgainLandsIt() async throws {
    let fault = GymStoreFault(), recorder = TelemetryRecorder(), server = JournalModelTransport()
    let model = try LineageFlowTests().fixture(server, crashPoints: CrashPoints { point in
      if fault.point.withLock({ $0 == point }) { throw AppFailure(message: "private-fault-marker") }
    }, telemetry: recorder)
    defer { model.gym.stop() }
    let identity = server.identity(email: "owed@example.com")
    try await model.signIn(identity)
    model.journal.type("A page in the account."); model.journal.done()
    await model.runtime?.engine.start(); try await AppScenario.backedUp(model)
    fault.point.withLock { $0 = .beforeCommit(.signOutFinish) }
    model.openAccountDeletion()
    await model.deleteAccount()
    #expect(model.deletion == .failed && model.account == identity.account && model.editorReadOnly && model.gym.accountTransition)
    #expect(server.state.withLock { $0.closedAccounts[identity.account] != nil })
    #expect(OwedDiscard(model.preferences)?.account == identity.account && OwedDiscard(model.preferences)?.closingOn != nil)
    fault.point.withLock { $0 = nil }
    await model.deleteAccount()
    guard case .deleted = model.deletion else { Issue.record("not deleted: \(String(describing: model.deletion))"); return }
    #expect(model.account == nil && OwedDiscard(model.preferences) == nil && !model.gym.accountTransition)
    #expect(try model.runner.read(Journal.scope) { try $0.repository(Page.self).all(in: .drawn).isEmpty })
    #expect(recorder.entries.withLock { $0.filter { $0.name == "account_delete" || $0.name == "client_error" }.map(\.properties) } == [
      ["state": "shown"], ["operation": "account_delete", "failure_kind": "unexpected"], ["outcome": "failed"], ["outcome": "ok"]])
  }

  // A discard still owed when the app closed lands at the next launch, before any room opens.
  @Test func aDiscardOwedAtLaunchLandsBeforeAnyRoomOpens() async throws {
    let fault = GymStoreFault(), server = JournalModelTransport()
    let model = try LineageFlowTests().fixture(server, crashPoints: CrashPoints { point in
      if fault.point.withLock({ $0 == point }) { throw AppFailure(message: "private-fault-marker") }
    })
    defer { model.gym.stop() }
    let identity = server.identity(email: "relaunch@example.com")
    try await model.signIn(identity)
    fault.point.withLock { $0 = .beforeCommit(.signOutFinish) }
    model.openAccountDeletion()
    await model.deleteAccount()
    fault.point.withLock { $0 = nil }
    let runtime = try #require(model.runtime)
    let relaunched = try AppModel(runner: runtime.runner, preferences: model.preferences, runtime: runtime)
    let owed = try #require(relaunched.discardOwed)
    #expect(relaunched.account == identity.account && relaunched.editorReadOnly && relaunched.gym.accountTransition)
    #expect(await relaunched.discard(owed))
    #expect(relaunched.account == nil && relaunched.welcome && relaunched.discardOwed == nil && OwedDiscard(model.preferences) == nil)
    #expect(try runtime.account() == nil && !relaunched.gym.accountTransition)
  }

  // A 401 once the person confirmed means the session is gone, perhaps with the account: the phone lets it go too.
  @Test func aLostAnswerThenTryAgainSignsThePhoneOut() async throws {
    let server = JournalModelTransport(), recorder = TelemetryRecorder()
    let identity = server.identity(email: "lost@example.com")
    let model = try LineageFlowTests().fixture(server, telemetry: recorder)
    defer { model.gym.stop() }
    try await model.signIn(identity)
    model.journal.type("A page in the account."); model.journal.done()
    await model.runtime?.engine.start(); try await AppScenario.backedUp(model)
    model.openAccountDeletion()
    _ = try server.closeAccount(identity.account, token: identity.token)
    await model.deleteAccount()
    #expect(model.deletion == nil && model.account == nil && model.welcome && model.discardOwed == nil)
    #expect(try model.runtime?.account() == nil)
    #expect(try model.runner.read(Journal.scope) { try $0.repository(Page.self).all(in: .drawn).isEmpty })
    #expect(recorder.entries.withLock { $0.filter { $0.name == "account_delete" || $0.name == "client_error" }.map(\.properties) } == [["state": "shown"], ["outcome": "failed"]])
  }

  @Test func aDeleteWhileAnotherAccountChangeRunsSaysItCouldNot() async throws {
    let server = JournalModelTransport(), recorder = TelemetryRecorder()
    let identity = server.identity(email: "busy-elsewhere@example.com")
    let model = try LineageFlowTests().fixture(server, telemetry: recorder)
    defer { model.gym.stop() }
    try await model.signIn(identity)
    model.openAccountDeletion()
    model.accountTransition = true
    await model.deleteAccount()
    #expect(model.deletion == .failed && model.account == identity.account && server.state.withLock { $0.closedAccounts.isEmpty })
    #expect(recorder.entries.withLock { $0.filter { $0.name == "account_delete" }.map(\.properties) } == [["state": "shown"], ["outcome": "failed"]])
  }

  // A room that cannot save first stops the delete before the server hears of it, and Sentry hears why.
  @Test func aRoomThatCannotSaveStopsTheDeleteBeforeTheServer() async throws {
    let server = JournalModelTransport(), recorder = TelemetryRecorder()
    let identity = server.identity(email: "unsaved@example.com")
    let model = try LineageFlowTests().fixture(server, telemetry: recorder)
    defer { model.gym.stop() }
    try await model.signIn(identity)
    model.journal.type(String(repeating: "a", count: 140_000))
    model.openAccountDeletion()
    await model.deleteAccount()
    #expect(model.deletion == .failed && model.account == identity.account && !model.gym.accountTransition)
    #expect(server.state.withLock { $0.closedAccounts.isEmpty })
    #expect(recorder.entries.withLock { $0.filter { $0.name == "account_delete" || $0.name == "client_error" }.map(\.properties) } == [
      ["state": "shown"], ["operation": "account_delete", "failure_kind": "flush"], ["outcome": "failed"]])
  }
}
