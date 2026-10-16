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
  func model(account: String? = nil) throws -> AppModel {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: account,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    return try AppModel(runner: harness.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!)
  }

  @Test func firstColdLaunchIsConsumedBeforeExitOrProcessDeath() throws {
    let first = try model()
    #expect(try OnboardingLaunch.shouldPresent(model: first, deepLink: false))
    #expect(first.preferences.bool(forKey: OnboardingLaunch.shownKey))
    let relaunched = try AppModel(runner: first.runner, preferences: first.preferences)
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
    #expect(first.journal.document.body.isEmpty)
    #expect(try !OnboardingLaunch.shouldPresent(model: first, deepLink: false))
  }

  @Test func savedRoomNeverShowsEvenWithoutOldPreference() throws {
    let first = try model()
    first.journal.type("A line already here."); #expect(first.journal.save())
    first.preferences.removeObject(forKey: "journalOpened")
    first.welcome = true
    #expect(try !OnboardingLaunch.shouldPresent(model: first, deepLink: false))
  }

  @Test func draftAndFailedReadNeverHideExistingWork() throws {
    let first = try model()
    first.journal.type("An unfinished line.")
    first.journal.saveTask?.cancel()
    #expect(try !OnboardingLaunch.shouldPresent(model: first, deepLink: false))
    let unreadable = try model()
    unreadable.journal.readFailed = true
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
    #expect(OnboardingPage.allCases.map(\.location) == [nil, "On the web", "In this app", "In this app"])
  }

  // The text is never clipped: the glimpse keeps its full height only while the page holds it and the whole text block.
  @Test func theGlimpseShrinksBeforeTheTextIsClippedAndOnlyAPageThatStillOverflowsScrolls() {
    let pages: [(OnboardingPage, CGFloat, CGFloat)] = [(.gym, 546, 158), (.gym, 545.5, 158), (.gym, 466, 158), (.gym, 465, 158),
                                                      (.windmill, 478, 100), (.windmill, 477, 100), (.windmill, .infinity, 0)]
    #expect(pages.map { page, height, text in
      let layout = page.layout(height: height, textBlock: text)
      return "\(Int(layout.glimpse)) \(layout.scrolls ? "scrolls" : "holds")"
    } == ["340 holds", "260 holds", "260 holds", "260 scrolls", "320 holds", "260 holds", "320 holds"])
  }
}
