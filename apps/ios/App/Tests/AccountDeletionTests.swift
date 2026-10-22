import Foundation
import Testing
import DomainKit
import JournalDomain
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
    model.openAccountDeletion()
    await model.deleteAccount()
    guard case .deleted = model.deletion else { Issue.record("not deleted: \(String(describing: model.deletion))"); return }
    #expect(model.account == nil && model.welcome && model.accountEmail.isEmpty)
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
}
