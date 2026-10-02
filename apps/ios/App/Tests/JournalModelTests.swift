import Foundation
import Testing
import DomainKit
import DomainKitTesting
import JournalDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
import SyncStore
import Synchronization
@testable import Windmill

@Suite @MainActor struct JournalModelTests {
  func fixture(account: String? = nil) throws -> (Harness, JournalModel) {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: account,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let preferences = UserDefaults(suiteName: UUID().uuidString)!
    return (harness, try JournalModel(runner: harness.runner, preferences: preferences))
  }

  @Test func firstOpenHasOptionalScalesAndPrivacy() throws {
    let (_, model) = try fixture()
    #expect(model.showPrivacy && model.showPlaceholder)
    #expect(model.document.mood == nil && model.document.energy == nil)
    #expect(!model.scalesDue && !model.keepDue)
  }

  @Test func inkShownOncePerInstallAndCanBeReopened() throws {
    let (_, model) = try fixture()
    model.openJournal(); #expect(model.inkVisible)
    model.liftInk(); model.automaticallyShowInk(); #expect(!model.inkVisible)
    model.showInk(); #expect(model.inkVisible)
    model.type("a"); #expect(!model.inkVisible && model.document.body == "a")
    model.saveTask?.cancel()
  }

  @Test func firstInputRetiresPlaceholderEvenWhenDeleted() throws {
    let (_, model) = try fixture()
    model.type("a"); model.type("")
    #expect(!model.showPlaceholder)
    model.saveTask?.cancel()
    #expect(model.showPrivacy)
  }

  @Test func durableFirstPageRetiresCopyAndInvitesScales() throws {
    let (_, model) = try fixture()
    model.type("One line."); #expect(model.save()); model.done()
    #expect(!model.showPrivacy && model.firstKept && model.scalesDue)
    #expect(!model.keepDue && model.backup == "saved")
  }

  @Test func failedSaveRetainsWritingAndDoesNotRetireFirstPage() throws {
    let (harness, model) = try fixture()
    model.type("Still mine"); harness.failNextCommit()
    #expect(!model.save())
    #expect(model.document.body == "Still mine" && model.dirty && model.error != nil)
    #expect(model.room?.state.firstPage == "pending" && model.backup == "not saved")
    model.refresh(); #expect(model.document.body == "Still mine")
    #expect(model.save()); #expect(!model.dirty)
  }

  @Test func zeroAnswersScaleAndClearKeepsNullDistinct() throws {
    let (_, model) = try fixture()
    model.type("A"); model.save(); model.done()
    model.setScale("mood", 0)
    #expect(model.document.mood == 0 && !model.scalesDue && model.keepDue)
    model.setScale("mood", nil)
    #expect(model.document.mood == nil && model.keepDue)
  }

  @Test func dismissScalesUnlocksQuietKeep() throws {
    let (_, model) = try fixture()
    model.type("A"); model.save(); model.done(); model.dismissScales()
    #expect(!model.scalesDue && model.keepDue)
    model.keep(); #expect(model.sheet == .keep)
    model.closeKeep(); #expect(!model.keepDue)
  }

  @Test func editingSuppressesInvitations() throws {
    let (_, model) = try fixture()
    model.type("A"); model.save(); model.editing = true
    #expect(!model.scalesDue && !model.keepDue)
    model.done(); #expect(model.scalesDue)
  }

  @Test func signedInPagesNeverOfferKeepAndBackupWaitsForSync() throws {
    let (harness, model) = try fixture(account: "account-a")
    model.account = "account-a"
    harness.sync(); model.refresh()
    model.type("Bound writing"); model.save(); model.done(); model.dismissScales()
    #expect(!model.keepDue && model.backup == "not backed up yet")
    harness.sync(); model.refresh()
    #expect(model.backup == "backed up" && !model.keepDue)
  }

  @Test func anonymousSnapshotCoalescesAndSurvivesModelRecreation() throws {
    let (_, model) = try fixture()
    model.type("Old"); model.save(); model.type("Latest"); model.save()
    let recreated = try JournalModel(runner: model.runner, preferences: model.preferences)
    #expect(recreated.document.body == "Latest" && !recreated.showPrivacy)
    #expect(!recreated.welcome)
    let commands = try model.runner.read(Journal.scope) { try $0.commands() }
    #expect(commands.filter { $0.command.name == Journal.Commands.claimPage }.count == 1)
  }

  @Test func invalidScaleRetainsDocumentAsUnsaved() throws {
    let (_, model) = try fixture()
    model.setScale("energy", 11)
    #expect(model.dirty && model.error != nil && model.document.energy == 11)
    #expect(model.room?.days.isEmpty == true)
  }

  @Test func pastDayDomainWriteRemainsReadOnly() throws {
    let (_, model) = try fixture()
    let result = try model.runner.run(SavePage(day: model.today.adding(days: -1), document: PageDocument(body: "Past")))
    #expect(result.refusal != nil && model.room?.days.isEmpty == true)
  }

  @Test func accountWithPagesHasNoReonboarding() throws {
    let (harness, model) = try fixture(account: "returning")
    harness.sync()
    _ = try harness.runner.run(SavePage(day: model.today, document: PageDocument(body: "Existing"), retiring: ["scales"]))
    harness.sync()
    let reopened = try JournalModel(runner: harness.runner, preferences: model.preferences)
    #expect(!reopened.showPlaceholder && !reopened.showPrivacy && !reopened.scalesDue)
    reopened.openJournal(); #expect(!reopened.inkVisible)
  }

  @Test func wordCountUsesCurrentWriting() throws {
    let (_, model) = try fixture()
    model.type("One\n—\ntwo three.")
    #expect(model.words == 3)
    model.saveTask?.cancel()
  }

  @Test func closingYouDoesNotDismissTheKeepInvitation() throws {
    let (_, model) = try fixture()
    model.type("A page"); model.save(); model.done(); model.dismissScales()
    model.sheet = .you; model.sheet = nil; model.dismissSheet()
    #expect(model.keepDue)
    model.keep(); model.closeKeep(); model.dismissSheet()
    #expect(!model.keepDue)
  }
  @Test func midnightCarriesOpenDraftDurablyAndLeavesYesterdayReadOnly() throws {
    let (harness, model) = try fixture()
    model.type("Saved prefix"); model.save(); model.editing = true
    let yesterday = model.editorDay
    harness.advance(ms: 43_199_000)
    model.type("Saved prefix plus unsaved words"); model.saveTask?.cancel()
    harness.advance(ms: 2_000); model.refresh()
    #expect(model.editorDay == model.today && !model.dirty)
    #expect(model.document.body == "Saved prefix plus unsaved words")
    #expect(model.room?.days.first(where: { $0.day == yesterday })?.document.body == "Saved prefix")
    let reopened = try JournalModel(runner: model.runner, preferences: model.preferences)
    #expect(reopened.document.body == "Saved prefix plus unsaved words")
  }

  @Test func timezoneChangeCombinesOpenDraftWithDestinationAndBackgroundSaveSurvivesRelaunch() throws {
    let zone = ChangingZone()
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), zone: zone, account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let model = try JournalModel(runner: harness.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!)
    model.type("Destination page"); model.save()
    zone.seconds.withLock { $0 = 14 * 3_600 }; model.refresh()
    model.editing = true; model.type("Draft before zone change"); model.saveTask?.cancel()
    zone.seconds.withLock { $0 = 0 }
    model.background()
    #expect(!model.dirty)
    let reopened = try JournalModel(runner: model.runner, preferences: model.preferences)
    #expect(reopened.document.body == "Destination page\n\nDraft before zone change")
    #expect(!reopened.dirty && reopened.editorDay == reopened.today)
  }

  @Test(arguments: [false, true]) func diskDraftSurvivesTerminationAcrossMidnightAndBackground(background: Bool) throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let clock = SimClock(wallMs: 1_790_424_000_000), tokens = InMemoryTokenStore(), guardStore = InMemoryForkGuardStore()
    let preferences = UserDefaults(suiteName: UUID().uuidString)!
    func reopen() throws -> JournalModel {
      let store = try Store(path: directory.appending(path: "sync.sqlite").path, registry: SyncSchema.registry,
                            commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
      let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios, drivesLoops: false), store: store, transport: JournalModelTransport(),
                                  tokens: tokens, forkGuard: guardStore, clock: EngineClock(wall: clock, sleeper: ContinuousClock()),
                                  random: SeededRandomSource(seed: 71), connectivity: SwitchedConnectivity())
      return try JournalModel(runner: ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)), preferences: preferences)
    }
    var model: JournalModel? = try reopen()
    model?.editing = true; model?.type("Not yet autosaved"); model?.saveTask?.cancel()
    clock.advance(ms: 86_400_000)
    if background { model?.background() }
    model = nil
    let restored = try reopen()
    #expect(restored.document.body == "Not yet autosaved" && restored.editorDay == restored.today && !restored.dirty)
  }

  @Test func oversizedDayCarryKeepsBothTextsDurablyUntilShortened() throws {
    let zone = ChangingZone()
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), zone: zone, account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let model = try JournalModel(runner: harness.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!)
    let destination = String(repeating: "A", count: 80_000), draft = String(repeating: "B", count: 80_000)
    model.type(destination); model.save()
    zone.seconds.withLock { $0 = 14 * 3_600 }; model.refresh()
    model.editing = true; model.type(draft); model.saveTask?.cancel()
    zone.seconds.withLock { $0 = 0 }; model.background()
    #expect(model.dirty && model.error != nil)
    let reopened = try JournalModel(runner: model.runner, preferences: model.preferences)
    #expect(reopened.document.body == destination + "\n\n" + draft && reopened.dirty)
    reopened.type("Shortened with both memories"); #expect(reopened.save())
    #expect(try reopened.runner.read(Journal.scope) { try $0.device(EditorDraft.key) } == nil)
  }

}

nonisolated final class ChangingZone: Zone {
  let seconds = Mutex(0)
  func offsetSeconds(at instant: Instant) -> Int { seconds.withLock { $0 } }
}
