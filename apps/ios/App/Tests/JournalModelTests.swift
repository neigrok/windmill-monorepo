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
  func fixture(account: String? = nil, telemetry: any Telemetry = NoopTelemetry()) throws -> (Harness, AppModel) {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: account,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let preferences = UserDefaults(suiteName: UUID().uuidString)!
    return (harness, try AppModel(runner: harness.runner, preferences: preferences, telemetry: telemetry))
  }

  func inkFixture(account: String? = nil, telemetry: any Telemetry = NoopTelemetry()) throws -> (Harness, JournalModel) {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: account,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    return (harness, try JournalModel(runner: harness.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!, telemetry: telemetry))
  }

  @Test func firstOpenHasOptionalScalesAndPrivacy() throws {
    let (_, model) = try fixture()
    #expect(model.journal.showPrivacy && model.journal.showPlaceholder)
    #expect(model.journal.document.mood == nil && model.journal.document.energy == nil)
    #expect(!model.journal.scalesDue && !model.journal.keepDue)
  }

  @Test func firstJournalOpenShowsInkAndConsumesItAtPresentation() throws {
    let recorder = TelemetryRecorder()
    let (_, model) = try inkFixture(telemetry: recorder)
    #expect(!model.inkVisible && !model.preferences.bool(forKey: "inkShown"))
    model.openJournal()
    #expect(model.inkVisible && model.preferences.bool(forKey: "inkShown"))
    #expect(!model.welcome && !model.editing && model.document.body.isEmpty)
    model.automaticallyShowInk()
    #expect(recorder.entries.withLock { $0.map(\.name) } == ["first_run_choice", "first_run_screen_viewed"])
    #expect(recorder.entries.withLock { $0.map(\.properties) } == [
      ["screen": "welcome", "action": "open_journal"], ["screen": "ink_notes"]
    ])
  }

  @Test(arguments: [false, true]) func previouslyOpenedInstallNeverShowsInkWithoutPresentationPreference(clearOpenedMarker: Bool) throws {
    let (harness, _) = try inkFixture()
    let suite = "journal-ink-upgrade-tests.\(UUID())", preferences = UserDefaults(suiteName: suite)!
    defer { preferences.removePersistentDomain(forName: suite) }
    preferences.set(true, forKey: "journalOpened")
    #expect(preferences.object(forKey: "inkShown") == nil)
    let recorder = TelemetryRecorder()
    let model = try JournalModel(runner: harness.runner, preferences: preferences, telemetry: recorder)
    #expect(!model.welcome && model.room?.firstRunKnown == true && model.room?.stance == .empty && model.room?.days.isEmpty == true)
    if clearOpenedMarker { preferences.removeObject(forKey: "journalOpened") }
    model.automaticallyShowInk(); model.openJournal()
    #expect(!model.inkVisible && preferences.object(forKey: "inkShown") == nil)
    #expect(recorder.entries.withLock { $0.map(\.properties) } == [["screen": "welcome", "action": "open_journal"]])
  }

  @Test(arguments: [false, true]) func emptyAuthEntryRecordsVisitWithoutRearmingInkOnRelaunch(showBeforeExit: Bool) throws {
    let (harness, _) = try inkFixture(account: "empty-auth-account")
    harness.sync()
    let suite = "journal-ink-auth-entry-tests.\(UUID())", preferences = UserDefaults(suiteName: suite)!
    defer { preferences.removePersistentDomain(forName: suite) }
    let recorder = TelemetryRecorder()
    let app = try AppModel(runner: harness.runner, preferences: preferences, telemetry: recorder)
    let first = app.journal
    #expect(app.welcome && preferences.object(forKey: "journalOpened") == nil && preferences.object(forKey: "inkShown") == nil)
    #expect(first.room?.firstRunKnown == true && first.room?.stance == .empty && first.room?.days.isEmpty == true && first.room?.isAnonymous == false)
    app.sheet = .code
    app.presentSignInResult()
    #expect(!first.welcome && first.sheet == nil && preferences.bool(forKey: "journalOpened") && preferences.object(forKey: "inkShown") == nil)
    if showBeforeExit {
      first.automaticallyShowInk()
      #expect(first.inkVisible && preferences.bool(forKey: "inkShown"))
    }
    let reopened = try JournalModel(runner: harness.runner, preferences: UserDefaults(suiteName: suite)!, telemetry: recorder)
    reopened.automaticallyShowInk(); reopened.openJournal()
    #expect(!reopened.welcome && !reopened.inkVisible && preferences.bool(forKey: "inkShown") == showBeforeExit)
    if !showBeforeExit { #expect(preferences.object(forKey: "inkShown") == nil) }
    #expect(recorder.entries.withLock { $0.filter { $0.properties["screen"] == "ink_notes" }.map(\.properties) } ==
            (showBeforeExit ? [["screen": "ink_notes"]] : []))
  }

  @Test func priorWritingRetiresInkEligibilityEvenAfterHistoryIsClearedAndFlagsAreAbsent() throws {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: nil,
                              rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                              commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let runner = ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    let pending = PendingClaim(day: try runner.moment().today, claimId: "prior-ink-history", document: PageDocument(body: "Earlier writing."), retirements: [:])
    _ = try engine.replica.commit(Journal.scope, Gesture(changes: [], local: [DeviceWrite(key: pending.key, value: pending.json)]))
    let suite = "journal-ink-history-tests.\(UUID())", preferences = UserDefaults(suiteName: suite)!
    defer { preferences.removePersistentDomain(forName: suite) }
    #expect(preferences.object(forKey: "journalOpened") == nil && preferences.object(forKey: "inkShown") == nil)
    let recorder = TelemetryRecorder()
    let model = try JournalModel(runner: runner, preferences: preferences, telemetry: recorder)
    #expect(preferences.bool(forKey: "journalOpened") && preferences.object(forKey: "inkShown") == nil)
    #expect(model.room?.days.count == 1 && model.document.body == "Earlier writing.")
    _ = try engine.replica.commit(Journal.scope, Gesture(changes: [], local: [DeviceWrite(key: pending.key, value: nil)]))
    model.refresh(); model.refresh()
    #expect(model.room?.stance == .empty && model.room?.days.isEmpty == true && model.room?.state.firstPage == "pending" && !model.document.isWritten)
    let reopened = try JournalModel(runner: runner, preferences: UserDefaults(suiteName: suite)!, telemetry: recorder)
    #expect(!reopened.welcome && reopened.room?.days.isEmpty == true && !reopened.document.isWritten)
    reopened.automaticallyShowInk(); reopened.openJournal()
    #expect(!reopened.inkVisible && preferences.object(forKey: "inkShown") == nil)
    model.automaticallyShowInk(); model.openJournal()
    #expect(!model.inkVisible && preferences.object(forKey: "inkShown") == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.properties["screen"] == "ink_notes" }.isEmpty })
  }

  @Test func retiredFirstPageSuppressesInkInEmptyRoomWithoutInstallFlags() throws {
    let (harness, _) = try inkFixture()
    _ = try harness.runner.run(RetireJournalInvitation("firstPage"))
    let suite = "journal-ink-retired-tests.\(UUID())", preferences = UserDefaults(suiteName: suite)!
    defer { preferences.removePersistentDomain(forName: suite) }
    #expect(preferences.object(forKey: "journalOpened") == nil && preferences.object(forKey: "inkShown") == nil)
    let recorder = TelemetryRecorder()
    let model = try JournalModel(runner: harness.runner, preferences: preferences, telemetry: recorder)
    #expect(preferences.bool(forKey: "journalOpened") && preferences.object(forKey: "inkShown") == nil)
    #expect(model.room?.stance == .empty && model.room?.days.isEmpty == true && model.room?.state.firstPage == "retired" && !model.document.isWritten)
    model.automaticallyShowInk(); model.openJournal()
    #expect(!model.inkVisible && preferences.object(forKey: "inkShown") == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.properties["screen"] == "ink_notes" }.isEmpty })
  }

  @Test(arguments: [false, true]) func inkNeverReturnsAcrossPreferencesAndModelRecreation(dismissBeforeExit: Bool) throws {
    let (harness, _) = try inkFixture()
    let suite = "journal-ink-tests.\(UUID())", preferences = UserDefaults(suiteName: suite)!
    defer { preferences.removePersistentDomain(forName: suite) }
    let first = try JournalModel(runner: harness.runner, preferences: preferences)
    first.openJournal()
    #expect(first.inkVisible)
    if dismissBeforeExit { first.liftInk() }
    let restoredPreferences = UserDefaults(suiteName: suite)!
    #expect(restoredPreferences.bool(forKey: "inkShown"))
    let reopened = try JournalModel(runner: harness.runner, preferences: restoredPreferences)
    reopened.automaticallyShowInk(); reopened.openJournal()
    #expect(!reopened.inkVisible && !reopened.welcome && reopened.document.body.isEmpty)
  }

  @Test(arguments: [false, true]) func writingAndTapLiftInkOnce(writing: Bool) throws {
    let recorder = TelemetryRecorder()
    let (_, model) = try inkFixture(telemetry: recorder)
    model.openJournal()
    if writing { model.type("A line.") } else { model.liftInk() }
    #expect(!model.inkVisible && model.document.body == (writing ? "A line." : ""))
    model.liftInk(); model.automaticallyShowInk(); model.type("")
    model.saveTask?.cancel()
    #expect(!model.inkVisible && model.document.body.isEmpty)
    #expect(recorder.entries.withLock { $0.filter { $0.properties["screen"] == "ink_notes" }.map(\.name) } ==
            ["first_run_screen_viewed", "first_run_choice"])
    #expect(recorder.entries.withLock { $0.filter { $0.properties["screen"] == "ink_notes" }.map(\.properties) } ==
            [["screen": "ink_notes"], ["screen": "ink_notes", "action": "dismiss_ink"]])
  }

  @Test(arguments: [false, true]) func inputWhileInkIsDeferredPreventsLatePresentation(writeThenDelete: Bool) throws {
    let recorder = TelemetryRecorder()
    let (_, model) = try inkFixture(telemetry: recorder)
    model.readFailed = true
    model.automaticallyShowInk()
    #expect(!model.inkVisible && model.preferences.object(forKey: "inkShown") == nil)
    if writeThenDelete {
      model.type("Temporary writing."); model.type("")
      model.saveTask?.cancel()
    } else { model.liftInk() }
    #expect(model.readFailed && !model.document.isWritten)
    model.readFailed = false
    model.refresh()
    #expect(model.room?.firstRunKnown == true && model.room?.stance == .empty && model.room?.days.isEmpty == true && model.room?.state.firstPage == "pending")
    model.automaticallyShowInk(); model.openJournal()
    #expect(!model.inkVisible && model.preferences.object(forKey: "inkShown") == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.properties["screen"] == "ink_notes" }.isEmpty })
  }

  @Test func inkWaitsForKnownEmptyRoom() throws {
    let (harness, model) = try inkFixture(account: "new-account")
    #expect(model.room?.firstRunKnown == false && model.room?.stance == .unknown)
    model.automaticallyShowInk()
    #expect(!model.inkVisible && !model.preferences.bool(forKey: "inkShown"))
    harness.sync(); model.refresh(); model.automaticallyShowInk()
    #expect(model.room?.firstRunKnown == true && model.room?.stance == .empty)
    #expect(model.inkVisible && model.preferences.bool(forKey: "inkShown"))
  }

  @Test(arguments: [false, true]) func existingAnonymousWritingNeverShowsInkWhenPreferenceIsAbsent(saved: Bool) throws {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, account: nil,
                              rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                              commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let runner = ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    let model = try JournalModel(runner: runner, preferences: UserDefaults(suiteName: UUID().uuidString)!)
    model.preferences.set(true, forKey: "journalOpened")
    if saved {
      let pending = PendingClaim(day: model.today, claimId: "ink-existing-claim", document: PageDocument(body: "Writing already on this phone."),
                                 retirements: ["placeholder": "retired", "privacyLine": "retired", "firstPage": "retired"])
      let command = try ClaimPageCommand(day: pending.day, document: pending.base, claimId: pending.claimId)
      _ = try engine.replica.commit(Journal.scope, Gesture(changes: [],
        command: Command(name: ClaimPageCommand.name, args: .object(JSON.Object(uniqueKeysWithValues: command.args.map { ($0.key, $0.value) }))),
        local: [DeviceWrite(key: pending.key, value: pending.json)]))
    } else {
      model.type("Writing already on this phone.")
      model.saveTask?.cancel()
    }
    #expect(!model.preferences.bool(forKey: "inkShown"))
    let reopened = try JournalModel(runner: runner, preferences: model.preferences)
    #expect(reopened.document.body == "Writing already on this phone.")
    #expect(reopened.dirty == !saved && reopened.room?.stance == .empty)
    if saved { #expect(reopened.room?.days.count == 1) }
    reopened.automaticallyShowInk(); reopened.openJournal()
    #expect(!reopened.inkVisible && !reopened.preferences.bool(forKey: "inkShown"))
    #expect(reopened.document.body == "Writing already on this phone.")
  }

  @Test func failedReadDoesNotConsumeInkFromPreviouslyKnownEmptyRoom() throws {
    let recorder = TelemetryRecorder()
    let (_, model) = try inkFixture(telemetry: recorder)
    #expect(model.room?.firstRunKnown == true && model.room?.stance == .empty)
    model.readFailed = true
    model.automaticallyShowInk()
    #expect(!model.inkVisible && !model.preferences.bool(forKey: "inkShown"))
    #expect(recorder.entries.withLock { $0.isEmpty })
    model.readFailed = false
    model.automaticallyShowInk()
    #expect(model.inkVisible && model.preferences.bool(forKey: "inkShown"))
    #expect(recorder.entries.withLock { $0.map(\.properties) } == [["screen": "ink_notes"]])
  }

  @Test func gymFirstVisitLeavesInkForTheFirstExplicitJournalVisit() throws {
    let recorder = TelemetryRecorder()
    let (_, app) = try fixture(telemetry: recorder)
    app.openRoom(.gym)
    app.refresh(); app.journal.automaticallyShowInk()
    #expect(app.selectedRoom == .gym && !app.welcome && !app.journal.inkVisible)
    #expect(app.preferences.object(forKey: "journalOpened") == nil && app.preferences.object(forKey: "inkShown") == nil)
    #expect(recorder.entries.withLock { $0.filter { $0.properties["screen"] == "ink_notes" }.isEmpty })
    app.switchRoom(.journal)
    #expect(app.selectedRoom == .journal && app.journal.inkVisible)
    #expect(app.preferences.bool(forKey: "journalOpened") && app.preferences.bool(forKey: "inkShown"))
    #expect(recorder.entries.withLock { $0.filter { $0.properties["screen"] == "ink_notes" }.map(\.properties) } == [["screen": "ink_notes"]])
  }

  @Test func choosingTheJournalAgainInTheRoomMenuLiftsItsInk() throws {
    let (_, app) = try fixture(telemetry: TelemetryRecorder())
    app.openJournal()
    #expect(app.journal.inkVisible)
    app.switchRoom(.journal)
    #expect(app.selectedRoom == .journal && !app.journal.inkVisible)
  }

  @Test(arguments: [false, true]) func journalInkNeverReplaysAfterAccountOrRoomNavigation(accountDoor: Bool) throws {
    let recorder = TelemetryRecorder()
    let (_, app) = try fixture(telemetry: recorder)
    app.openJournal()
    #expect(app.journal.inkVisible)
    if accountDoor { app.sheet = .you; app.sheet = nil }
    else { app.switchRoom(.gym); app.switchRoom(.journal) }
    #expect(!app.journal.inkVisible && !app.journal.editing && app.journal.document.body.isEmpty)
    app.journal.automaticallyShowInk(); app.openJournal(); app.refresh()
    #expect(!app.journal.inkVisible && app.preferences.bool(forKey: "inkShown"))
    #expect(recorder.entries.withLock { $0.filter { $0.properties["screen"] == "ink_notes" }.map(\.properties) } == [
      ["screen": "ink_notes"], ["screen": "ink_notes", "action": "dismiss_ink"]
    ])
  }

  @Test func firstInputRetiresPlaceholderEvenWhenDeleted() throws {
    let (_, model) = try fixture()
    model.journal.type("a"); model.journal.type("")
    #expect(!model.journal.showPlaceholder)
    model.journal.saveTask?.cancel()
    #expect(model.journal.showPrivacy)
  }

  @Test func durableFirstPageRetiresCopyAndInvitesScales() throws {
    let (_, model) = try fixture()
    model.journal.type("One line."); #expect(model.journal.save()); model.journal.done()
    #expect(!model.journal.showPrivacy && model.journal.firstKept && model.journal.scalesDue)
    #expect(!model.journal.keepDue && model.journal.backup == "saved")
  }

  @Test func failedSaveRetainsWritingAndDoesNotRetireFirstPage() throws {
    let (harness, model) = try fixture()
    model.journal.type("Still mine"); harness.failNextCommit()
    #expect(!model.journal.save())
    #expect(model.journal.document.body == "Still mine" && model.journal.dirty && model.journal.error != nil)
    #expect(model.journal.room?.state.firstPage == "pending" && model.journal.backup == "not saved")
    model.refresh(); #expect(model.journal.document.body == "Still mine")
    #expect(model.journal.save()); #expect(!model.journal.dirty)
  }

  @Test func zeroAnswersScaleAndClearKeepsNullDistinct() throws {
    let (_, model) = try fixture()
    model.journal.type("A"); model.journal.save(); model.journal.done()
    model.journal.setScale("mood", 0)
    #expect(model.journal.document.mood == 0 && !model.journal.scalesDue && model.journal.keepDue)
    model.journal.setScale("mood", nil)
    #expect(model.journal.document.mood == nil && model.journal.keepDue)
  }

  @Test func dismissScalesUnlocksQuietKeep() throws {
    let (_, model) = try fixture()
    model.journal.type("A"); model.journal.save(); model.journal.done(); model.journal.dismissScales()
    #expect(!model.journal.scalesDue && model.journal.keepDue)
    model.keep(); #expect(model.sheet == .keep)
    model.closeKeep(); #expect(!model.journal.keepDue)
  }

  @Test func editingSuppressesInvitations() throws {
    let (_, model) = try fixture()
    model.journal.type("A"); model.journal.save(); model.journal.editing = true
    #expect(!model.journal.scalesDue && !model.journal.keepDue)
    model.journal.done(); #expect(model.journal.scalesDue)
  }

  @Test func signedInPagesNeverOfferKeepAndBackupWaitsForSync() throws {
    let (harness, model) = try fixture(account: "account-a")
    model.account = "account-a"
    harness.sync(); model.refresh()
    model.journal.type("Bound writing"); model.journal.save(); model.journal.done(); model.journal.dismissScales()
    #expect(!model.journal.keepDue && model.journal.backup == "not backed up yet")
    harness.sync(); model.refresh()
    #expect(model.journal.backup == "backed up" && !model.journal.keepDue)
  }

  @Test func anonymousSnapshotCoalescesAndSurvivesModelRecreation() throws {
    let (_, model) = try fixture()
    model.journal.type("Old"); model.journal.save(); model.journal.type("Latest"); model.journal.save()
    let recreated = try AppModel(runner: model.runner, preferences: model.preferences)
    #expect(recreated.journal.document.body == "Latest" && !recreated.journal.showPrivacy)
    #expect(!recreated.welcome)
    let commands = try model.runner.read(Journal.scope) { try $0.commands() }
    #expect(commands.filter { $0.command.name == Journal.Commands.claimPage }.count == 1)
  }

  @Test func invalidScaleRetainsDocumentAsUnsaved() throws {
    let (_, model) = try fixture()
    model.journal.setScale("energy", 11)
    #expect(model.journal.dirty && model.journal.error != nil && model.journal.document.energy == 11)
    #expect(model.journal.room?.days.isEmpty == true)
  }

  @Test func pastDayDomainWriteRemainsReadOnly() throws {
    let (_, model) = try fixture()
    let result = try model.runner.run(SavePage(day: model.journal.today.adding(days: -1), document: PageDocument(body: "Past")))
    #expect(result.refusal != nil && model.journal.room?.days.isEmpty == true)
  }

  @Test func accountWithPagesHasNoReonboarding() throws {
    let (harness, model) = try fixture(account: "returning")
    harness.sync()
    _ = try harness.runner.run(SavePage(day: model.journal.today, document: PageDocument(body: "Existing"), retiring: ["scales"]))
    harness.sync()
    let reopened = try AppModel(runner: harness.runner, preferences: model.preferences)
    #expect(!reopened.journal.showPlaceholder && !reopened.journal.showPrivacy && !reopened.journal.scalesDue)
  }

  @Test func wordCountUsesCurrentWriting() throws {
    let (_, model) = try fixture()
    model.journal.type("One\n—\ntwo three.")
    #expect(model.journal.words == 3)
    model.journal.saveTask?.cancel()
  }

  @Test func closingYouDoesNotDismissTheKeepInvitation() throws {
    let (_, model) = try fixture()
    model.journal.type("A page"); model.journal.save(); model.journal.done(); model.journal.dismissScales()
    model.sheet = .you; model.sheet = nil; model.dismissSheet()
    #expect(model.journal.keepDue)
    model.keep(); model.closeKeep(); model.dismissSheet()
    #expect(!model.journal.keepDue)
  }
  @Test func midnightCarriesOpenDraftDurablyAndLeavesYesterdayReadOnly() throws {
    let (harness, model) = try fixture()
    model.journal.type("Saved prefix"); model.journal.save(); model.journal.editing = true
    let yesterday = model.journal.editorDay
    harness.advance(ms: 43_199_000)
    model.journal.type("Saved prefix plus unsaved words"); model.journal.saveTask?.cancel()
    harness.advance(ms: 2_000); model.refresh()
    #expect(model.journal.editorDay == model.journal.today && !model.journal.dirty)
    #expect(model.journal.document.body == "Saved prefix plus unsaved words")
    #expect(model.journal.room?.days.first(where: { $0.day == yesterday })?.document.body == "Saved prefix")
    let reopened = try AppModel(runner: model.runner, preferences: model.preferences)
    #expect(reopened.journal.document.body == "Saved prefix plus unsaved words")
  }

  @Test func timezoneChangeCombinesOpenDraftWithDestinationAndBackgroundSaveSurvivesRelaunch() throws {
    let zone = ChangingZone()
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), zone: zone, account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let model = try AppModel(runner: harness.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!)
    model.journal.type("Destination page"); model.journal.save()
    zone.seconds.withLock { $0 = 14 * 3_600 }; model.refresh()
    model.journal.editing = true; model.journal.type("Draft before zone change"); model.journal.saveTask?.cancel()
    zone.seconds.withLock { $0 = 0 }
    model.background()
    #expect(!model.journal.dirty)
    let reopened = try AppModel(runner: model.runner, preferences: model.preferences)
    #expect(reopened.journal.document.body == "Destination page\n\nDraft before zone change")
    #expect(!reopened.journal.dirty && reopened.journal.editorDay == reopened.journal.today)
  }

  @Test(arguments: [false, true]) func diskDraftSurvivesTerminationAcrossMidnightAndBackground(background: Bool) throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let clock = SimClock(wallMs: 1_790_424_000_000), tokens = InMemoryTokenStore(), guardStore = InMemoryForkGuardStore()
    let preferences = UserDefaults(suiteName: UUID().uuidString)!
    func reopen() throws -> AppModel {
      let store = try Store(path: directory.appending(path: "sync.sqlite").path, registry: SyncSchema.registry,
                            commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
      let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios, drivesLoops: false), store: store, transport: JournalModelTransport(),
                                  tokens: tokens, forkGuard: guardStore, clock: EngineClock(wall: clock, sleeper: ContinuousClock()),
                                  random: SeededRandomSource(seed: 71), connectivity: SwitchedConnectivity())
      return try AppModel(runner: ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0)), preferences: preferences)
    }
    var model: AppModel? = try reopen()
    model?.journal.editing = true; model?.journal.type("Not yet autosaved"); model?.journal.saveTask?.cancel()
    clock.advance(ms: 86_400_000)
    if background { model?.background() }
    model = nil
    let restored = try reopen()
    #expect(restored.journal.document.body == "Not yet autosaved" && restored.journal.editorDay == restored.journal.today && !restored.journal.dirty)
  }

  @Test func oversizedDayCarryKeepsBothTextsDurablyUntilShortened() throws {
    let zone = ChangingZone()
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), zone: zone, account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let model = try AppModel(runner: harness.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!)
    let destination = String(repeating: "A", count: 80_000), draft = String(repeating: "B", count: 80_000)
    model.journal.type(destination); model.journal.save()
    zone.seconds.withLock { $0 = 14 * 3_600 }; model.refresh()
    model.journal.editing = true; model.journal.type(draft); model.journal.saveTask?.cancel()
    zone.seconds.withLock { $0 = 0 }; model.background()
    #expect(model.journal.dirty && model.journal.error != nil)
    let reopened = try AppModel(runner: model.runner, preferences: model.preferences)
    #expect(reopened.journal.document.body == destination + "\n\n" + draft && reopened.journal.dirty)
    reopened.journal.type("Shortened with both memories"); #expect(reopened.journal.save())
    #expect(try reopened.runner.read(Journal.scope) { try $0.device(EditorDraft.key) } == nil)
  }

}

nonisolated final class ChangingZone: Zone {
  let seconds = Mutex(0)
  func offsetSeconds(at instant: Instant) -> Int { seconds.withLock { $0 } }
}
