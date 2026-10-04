import Foundation
import Testing
import DomainKit
import DomainKitTesting
import JournalDomain
import SyncCore
import SyncModelServer
import SyncSchema
@testable import Windmill

@Suite @MainActor struct OnboardingLaunchTests {
  func model(account: String? = nil) throws -> JournalModel {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: account,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    return try JournalModel(runner: harness.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!)
  }

  @Test func firstColdLaunchIsConsumedBeforeExitOrProcessDeath() throws {
    let first = try model()
    #expect(try OnboardingLaunch.shouldPresent(model: first, deepLink: false))
    #expect(first.preferences.bool(forKey: OnboardingLaunch.shownKey))
    let relaunched = try JournalModel(runner: first.runner, preferences: first.preferences)
    #expect(try !OnboardingLaunch.shouldPresent(model: relaunched, deepLink: false))
  }

  @Test func deepLinkConsumesFirstLaunchWithoutShowing() throws {
    let first = try model()
    #expect(try !OnboardingLaunch.shouldPresent(model: first, deepLink: true))
    #expect(try !OnboardingLaunch.shouldPresent(model: first, deepLink: false))
  }

  @Test func roomHistoryWithNoWritingNeverShows() throws {
    let first = try model()
    first.openJournal()
    first.preferences.removeObject(forKey: OnboardingLaunch.shownKey)
    #expect(first.document.body.isEmpty)
    #expect(try !OnboardingLaunch.shouldPresent(model: first, deepLink: false))
  }

  @Test func savedRoomNeverShowsEvenWithoutOldPreference() throws {
    let first = try model()
    first.type("A line already here."); #expect(first.save())
    first.preferences.removeObject(forKey: "journalOpened")
    first.welcome = true
    #expect(try !OnboardingLaunch.shouldPresent(model: first, deepLink: false))
  }

  @Test func draftAndFailedReadNeverHideExistingWork() throws {
    let first = try model()
    first.type("An unfinished line.")
    first.saveTask?.cancel()
    #expect(try !OnboardingLaunch.shouldPresent(model: first, deepLink: false))
    let unreadable = try model()
    unreadable.readFailed = true
    #expect(try !OnboardingLaunch.shouldPresent(model: unreadable, deepLink: false))
  }

  @Test func signedInAndPostSignOutRetainDeviceFlag() throws {
    let first = try model(account: "account-a")
    first.account = "account-a"
    #expect(try !OnboardingLaunch.shouldPresent(model: first, deepLink: false))
    first.account = nil; first.welcome = true
    #expect(try !OnboardingLaunch.shouldPresent(model: first, deepLink: false))
  }

  @Test func locationsAreTheCurrentIPhoneTruthTable() {
    #expect(OnboardingPage.allCases.map(\.location) == [nil, "On the web", "In this app", "On the web and Android"])
  }
}
