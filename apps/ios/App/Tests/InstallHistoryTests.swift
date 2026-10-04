import Foundation
import Testing
import SyncEngine
import SyncIOS
@testable import Windmill

@Suite @MainActor struct InstallHistoryTests {
  func launch(prior: (URL, KeychainTokenStore, KeychainTokenStore) throws -> Void,
              history: Bool, shown: Bool) throws {
    let directory = URL.temporaryDirectory.appending(path: UUID().uuidString)
    let service = "works.windmill.install-tests.\(UUID())"
    let tokens = KeychainTokenStore(service: service)
    let revocations = KeychainTokenStore(service: service + ".signed-out-sessions")
    let preferences = UserDefaults(suiteName: service)!
    // Simulator disposal clears the temporary DBs after the engine hub releases SQLite asynchronously.
    defer {
      for account in tokens.accounts() { try? tokens.delete(for: account) }
      for account in revocations.accounts() { try? revocations.delete(for: account) }
      preferences.removePersistentDomain(forName: service)
    }
    try prior(directory, tokens, revocations)
    let runtime = try AppRuntime(settings: AppSettings(arguments: ["app", "-model-server"]),
                                 directory: directory, service: service)
    let model = try JournalModel(runner: runtime.runner, preferences: preferences, runtime: runtime)
    #expect(runtime.hadInstallHistory == history)
    #expect(try runtime.account() == nil)
    #expect(runtime.tokens.accounts().isEmpty)
    #expect(try OnboardingLaunch.shouldPresent(model: model, deepLink: false) == shown)
    #expect(preferences.bool(forKey: OnboardingLaunch.shownKey))
  }

  @Test func reinstallWithRetainedCredentialsAndAbsentDatabaseNeverShows() throws {
    try launch(prior: { directory, tokens, _ in
      #expect(!FileManager.default.fileExists(atPath: directory.path))
      try tokens.save(SessionToken("retained-session"), for: "prior-account")
      #expect(tokens.accounts() == ["prior-account"])
    }, history: true, shown: false)
  }

  @Test func retainedSignedOutSessionIsPriorHistory() throws {
    try launch(prior: { _, _, revocations in
      try revocations.save(SessionToken("queued-revocation"), for: "prior-session")
    }, history: true, shown: false)
  }

  @Test func priorStorageWithoutCredentialsOrDefaultsNeverShows() throws {
    try launch(prior: { directory, _, _ in
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }, history: true, shown: false)
  }

  @Test func freshInstallWithoutStorageCredentialsOrDefaultsShows() throws {
    try launch(prior: { _, _, _ in }, history: false, shown: true)
  }
}
