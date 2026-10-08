import Foundation
import Testing
import DomainKit
import DomainKitTesting
import JournalDomain
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@MainActor final class JournalEchoServiceFake: JournalEchoServing {
  struct Signal: Equatable {
    let kind: JournalEchoSignal
    let trigger: String
    let match: String?
  }
  var response = JournalEchoResponse(pages: [])
  var listError: (any Error)?
  var signalError: (any Error)?
  var holdLists = false
  var holdSignals = false
  var lists: [String] = []
  var signals: [Signal] = []
  var finishedSignals: Set<Int> = []
  var cancelledLists: Set<Int> = []
  var cancelledSignals: Set<Int> = []
  var pendingLists: [Int: CheckedContinuation<JournalEchoResponse, any Error>] = [:]
  var pendingSignals: [Int: CheckedContinuation<Void, any Error>] = [:]

  func list(through day: String) async throws -> JournalEchoResponse {
    let index = lists.count
    lists.append(day)
    defer { if Task.isCancelled { cancelledLists.insert(index) } }
    if holdLists { return try await withCheckedThrowingContinuation { pendingLists[index] = $0 } }
    if let listError { throw listError }
    return response
  }

  func signal(_ signal: JournalEchoSignal, triggerDay: String, matchDay: String?) async throws {
    let index = signals.count
    signals.append(Signal(kind: signal, trigger: triggerDay, match: matchDay))
    defer { finishedSignals.insert(index); if Task.isCancelled { cancelledSignals.insert(index) } }
    if holdSignals { return try await withCheckedThrowingContinuation { pendingSignals[index] = $0 } }
    if let signalError { throw signalError }
  }

  func finishList(_ index: Int, _ result: Result<JournalEchoResponse, any Error>) {
    pendingLists.removeValue(forKey: index)?.resume(with: result)
  }

  func finishSignal(_ index: Int, _ result: Result<Void, any Error>) {
    pendingSignals.removeValue(forKey: index)?.resume(with: result)
  }

  func finishPending() {
    for index in Array(pendingLists.keys) { finishList(index, .failure(CancellationError())) }
    for index in Array(pendingSignals.keys) { finishSignal(index, .failure(CancellationError())) }
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct JournalEchoesTests {
  static let today = "2026-10-08"
  static let recent = JournalEchoMatch(day: "2026-09-01", text: "I walked until my shoulders dropped.")
  static let older = JournalEchoMatch(day: "2026-04-12", text: "The same worry felt smaller after a walk.")
  static let bodies = [today: "A long walk made room for today.", recent.day: "Earlier. \(recent.text) Later.",
                       older.day: "Before. \(older.text) After."]
  static let response = JournalEchoResponse(pages: [JournalEchoPage(day: today, matches: [recent, older])], pagesWritten: 24)

  @MainActor final class Fixture {
    let service = JournalEchoServiceFake()
    let recorder = TelemetryRecorder()
    let suite = "journal-echo-tests.\(UUID())"
    let preferences: UserDefaults
    let model: JournalEchoes

    init() {
      preferences = UserDefaults(suiteName: suite)!
      model = JournalEchoes(service: service, preferences: preferences, telemetry: recorder)
      service.response = JournalEchoesTests.response
      model.activate(JournalEchoAccess(account: "account-a", today: JournalEchoesTests.today, available: true))
      model.updateBodies(JournalEchoesTests.bodies)
    }

    func close() {
      model.suspend(); service.finishPending()
      preferences.removePersistentDomain(forName: suite)
    }
  }

  func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<1_000 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(1))
    }
    try #require(condition(), "The controlled REST request did not reach its continuation")
  }

  @Test func quoteLocatorUsesExactUTF16RangesAndTreatsOccurrenceAsAHint() {
    let text = "🌙 cafe\u{301}", body = "Start \(text), then \(text)."
    let first = (body as NSString).range(of: text, options: .literal)
    let nextStart = NSMaxRange(first)
    let second = (body as NSString).range(of: text, options: .literal,
                                         range: NSRange(location: nextStart, length: body.utf16.count - nextStart))
    #expect(JournalEchoMatch(day: Self.recent.day, text: text).range(in: body) == first)
    #expect(JournalEchoMatch(day: Self.recent.day, text: text, occurrenceHint: 1).range(in: body) == second)
    for hint in [-1, 2, Int.max] {
      #expect(JournalEchoMatch(day: Self.recent.day, text: text, occurrenceHint: hint).range(in: body) == first)
    }
    #expect(JournalEchoMatch(day: Self.recent.day, text: "🌙 café").range(in: body) == nil)
    #expect(JournalEchoMatch(day: Self.recent.day, text: "").range(in: body) == nil)
    #expect(JournalEchoMatch(day: Self.recent.day, text: "not on this page").range(in: body) == nil)
  }

  @Test func processingFloorRequiresTwentyPagesUnlessWaivedAndLegacyMetadataStaysUsable() async {
    let fixture = Fixture(); defer { fixture.close() }
    for (count, waived, visible) in [(19 as Int?, false, false), (20, false, true), (0, true, true), (nil, false, true)] {
      fixture.service.response = JournalEchoResponse(pages: Self.response.pages, pagesWritten: count, floorWaived: waived)
      await fixture.model.reload()
      #expect(fixture.model.pages == (visible ? [Self.today: Self.response.pages[0]] : [:]))
    }
  }

  @Test func onlyExistingOlderVerbatimPassagesAppearOncePerSourceDay() async {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.response = JournalEchoResponse(pages: [
      JournalEchoPage(day: Self.today, matches: [
        Self.older, JournalEchoMatch(day: Self.today, text: Self.bodies[Self.today]!),
        JournalEchoMatch(day: "2026-10-09", text: "future"), JournalEchoMatch(day: "2026-02-30", text: "invalid date"),
        JournalEchoMatch(day: Self.recent.day, text: "invented words"), Self.recent,
        JournalEchoMatch(day: Self.recent.day, text: "Earlier."), JournalEchoMatch(day: "2026-03-01", text: "missing page")
      ]),
      JournalEchoPage(day: "2026-10-09", matches: [Self.recent]),
      JournalEchoPage(day: "2026-10-07", matches: [Self.recent])
    ], pagesWritten: 20)
    await fixture.model.reload()
    #expect(fixture.model.pages == [Self.today: Self.response.pages[0]])
    #expect(fixture.recorder.entries.withLock { $0.isEmpty })
  }

  @Test func copiedAndSpokenProvenanceDoesNotAttributeSomeoneElsesWordsToTheWriter() {
    #expect(JournalEchoMatch(day: Self.recent.day, text: "Copied words", isSelf: false, source: "spoken").provenance == "something you copied down")
    #expect(JournalEchoMatch(day: Self.recent.day, text: "Spoken words", isSelf: true, source: "spoken").provenance == "from your voice note")
    #expect(Self.recent.provenance == nil)
  }

  @Test(arguments: [false, true]) func localSourceEditOrRemovalRetractsTheQuoteAndOpenPresentation(remove: Bool) async throws {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.response = JournalEchoResponse(pages: [JournalEchoPage(day: Self.today, matches: [Self.recent])])
    await fixture.model.reload()
    fixture.model.walk(from: Self.today, to: Self.recent)
    fixture.model.open(Self.today)
    var bodies = Self.bodies
    bodies[Self.recent.day] = remove ? nil : "The old quoted passage was edited away."
    fixture.model.updateBodies(bodies)
    #expect(fixture.model.pages.isEmpty && fixture.model.openDay == nil && fixture.model.destination == nil)
    fixture.model.walk(from: Self.today, to: Self.recent)
    #expect(fixture.model.destination == nil)
    try await waitUntil { fixture.service.signals.count == 1 }
  }

  @Test func missingOrBlankTriggerRetractsItsEchoWithoutSubstituteContent() async {
    let fixture = Fixture(); defer { fixture.close() }
    await fixture.model.reload()
    var bodies = Self.bodies
    bodies.removeValue(forKey: Self.today)
    fixture.model.updateBodies(bodies)
    #expect(fixture.model.pages.isEmpty)
    bodies[Self.today] = " \n "
    fixture.model.updateBodies(bodies)
    #expect(fixture.model.pages.isEmpty)
  }

  @Test func emptyAnonymousAndUnavailableJournalsNeverRequestEchoes() async {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.model.updateBodies([:])
    await fixture.model.reload()
    fixture.model.updateBodies(Self.bodies)
    fixture.model.activate(JournalEchoAccess(account: nil, today: Self.today, available: true))
    await fixture.model.reload()
    fixture.model.activate(JournalEchoAccess(account: "account-a", today: Self.today, available: false))
    await fixture.model.reload()
    #expect(fixture.service.lists.isEmpty && fixture.service.signals.isEmpty)
    #expect(fixture.model.pages.isEmpty && fixture.model.openDay == nil)
    #expect(fixture.recorder.entries.withLock { $0.isEmpty })
  }

  @Test func failedOfflineReadClearsEchoesSheetAndTrail() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    await fixture.model.reload()
    fixture.model.walk(from: Self.today, to: Self.recent)
    fixture.model.open(Self.today)
    fixture.service.listError = URLError(.notConnectedToInternet)
    await fixture.model.reload()
    #expect(fixture.model.pages.isEmpty && fixture.model.openDay == nil && fixture.model.arrivalDay == nil)
    #expect(fixture.model.hops.isEmpty && fixture.model.destination == nil)
    try await waitUntil { fixture.service.signals.count == 1 }
  }

  @Test func suspensionCancelsAnOpenSheetsWorkAndRejectsLateReplies() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    await fixture.model.reload()
    fixture.service.holdLists = true; fixture.service.holdSignals = true
    let reading = Task { await fixture.model.reload() }
    defer { reading.cancel() }
    try await waitUntil { fixture.service.pendingLists[1] != nil }
    fixture.model.walk(from: Self.today, to: Self.recent)
    fixture.model.open(Self.today)
    try await waitUntil { fixture.service.pendingSignals[0] != nil }
    fixture.model.suspend()
    #expect(!fixture.model.access.available && fixture.model.pages.isEmpty && fixture.model.openDay == nil)
    #expect(fixture.model.hops.isEmpty && fixture.model.destination == nil && fixture.model.pendingDays.isEmpty)
    fixture.service.finishList(1, .success(Self.response)); fixture.service.finishSignal(0, .success(()))
    await reading.value
    try await waitUntil { fixture.service.cancelledSignals == [0] }
    #expect(fixture.service.cancelledLists == [1])
    #expect(fixture.model.pages.isEmpty && fixture.model.openDay == nil)
  }

  @Test func aLateAccountAReadCannotReplaceAccountBOrSurviveSignOut() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.holdLists = true
    let accountA = Task { await fixture.model.reload() }
    defer { accountA.cancel() }
    try await waitUntil { fixture.service.pendingLists[0] != nil }
    fixture.model.activate(JournalEchoAccess(account: "account-b", today: Self.today, available: true))
    fixture.model.updateBodies([Self.today: "Account B today.", Self.older.day: Self.older.text])
    let accountB = Task { await fixture.model.reload() }
    defer { accountB.cancel() }
    try await waitUntil { fixture.service.pendingLists[1] != nil }
    let responseB = JournalEchoResponse(pages: [JournalEchoPage(day: Self.today, matches: [Self.older])])
    fixture.service.finishList(1, .success(responseB)); await accountB.value
    fixture.service.finishList(0, .success(Self.response)); await accountA.value
    #expect(fixture.model.pages == [Self.today: responseB.pages[0]])
    #expect(fixture.model.access.account == "account-b")
    fixture.model.activate(JournalEchoAccess(account: nil, today: Self.today, available: false))
    await fixture.model.reload()
    #expect(fixture.model.pages.isEmpty && fixture.service.lists.count == 2)
  }

  @Test func signOutCannotRestoreAnOptimisticallyDismissedAccountPageFromALateFailure() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    await fixture.model.reload(); fixture.service.holdSignals = true
    let answering = Task { await fixture.model.answer(.dismiss, day: Self.today) }
    defer { answering.cancel() }
    try await waitUntil { fixture.service.pendingSignals[0] != nil }
    #expect(fixture.model.pages.isEmpty && fixture.model.pendingDays == [Self.today])
    fixture.model.activate(JournalEchoAccess(account: nil, today: Self.today, available: false))
    fixture.service.finishSignal(0, .failure(JournalEchoFailure.http(503))); await answering.value
    #expect(fixture.model.pages.isEmpty && fixture.model.pendingDays.isEmpty && fixture.model.openDay == nil)
    #expect(fixture.service.cancelledSignals == [0])
  }

  @Test func pollingIsSingleFlightAndAPreMutationReadCannotUndoAVerdict() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    await fixture.model.reload(); fixture.service.holdLists = true; fixture.service.holdSignals = true
    let staleRead = Task { await fixture.model.reload() }
    defer { staleRead.cancel() }
    try await waitUntil { fixture.service.pendingLists[1] != nil }
    await fixture.model.reload()
    #expect(fixture.service.lists.count == 2)
    let answering = Task { await fixture.model.answer(.dismiss, day: Self.today, matchDay: Self.recent.day) }
    defer { answering.cancel() }
    try await waitUntil { fixture.service.pendingSignals[0] != nil }
    await fixture.model.reload()
    #expect(fixture.service.lists.count == 2)
    fixture.service.finishList(1, .success(Self.response)); await staleRead.value
    #expect(fixture.model.pages[Self.today]?.matches == [Self.older])
    fixture.service.finishSignal(0, .success(())); await answering.value
    #expect(fixture.model.pages[Self.today]?.matches == [Self.older] && fixture.model.pendingDays.isEmpty)
    #expect(fixture.service.cancelledLists == [1])
  }

  @Test func usefulIsOptimisticAndRollsBackWithoutRetryingOrDoubleSending() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    await fixture.model.reload(); fixture.service.holdSignals = true
    let answering = Task { await fixture.model.answer(.useful, day: Self.today, matchDay: Self.recent.day) }
    defer { answering.cancel() }
    try await waitUntil { fixture.service.pendingSignals[0] != nil }
    #expect(fixture.model.pages[Self.today]?.matches.first?.useful == true)
    await fixture.model.answer(.useful, day: Self.today, matchDay: Self.recent.day)
    #expect(fixture.service.signals == [.init(kind: .useful, trigger: Self.today, match: Self.recent.day)])
    fixture.service.finishSignal(0, .failure(JournalEchoFailure.http(503))); await answering.value
    #expect(fixture.model.pages == [Self.today: Self.response.pages[0]] && fixture.model.pendingDays.isEmpty)
    await fixture.model.reload()
    #expect(fixture.service.signals.count == 1)
  }

  @Test(arguments: [false, true]) func pairAndPageDismissalRollBackWithoutARetryQueue(wholePage: Bool) async throws {
    let fixture = Fixture(); defer { fixture.close() }
    await fixture.model.reload(); fixture.model.open(Self.today); fixture.service.holdSignals = true
    let match = wholePage ? nil : Self.recent.day
    let answering = Task { await fixture.model.answer(.dismiss, day: Self.today, matchDay: match) }
    defer { answering.cancel() }
    try await waitUntil { fixture.service.pendingSignals[0] != nil }
    #expect(fixture.model.pages[Self.today]?.matches == (wholePage ? nil : [Self.older]))
    #expect(fixture.service.signals == [.init(kind: .dismiss, trigger: Self.today, match: match)])
    fixture.service.finishSignal(0, .failure(JournalEchoFailure.http(500))); await answering.value
    #expect(fixture.model.pages == [Self.today: Self.response.pages[0]] && fixture.model.pendingDays.isEmpty)
    await fixture.model.reload()
    #expect(fixture.service.signals.count == 1)
  }

  @Test(arguments: [JournalEchoSignal.useful, .dismiss]) func offlineVerdictsClearExtraSurfacesAndAreNotQueued(signal: JournalEchoSignal) async throws {
    let fixture = Fixture(); defer { fixture.close() }
    await fixture.model.reload()
    fixture.model.walk(from: Self.today, to: Self.recent)
    try await waitUntil { fixture.service.signals.count == 1 }
    fixture.model.open(Self.today); fixture.service.signalError = URLError(.networkConnectionLost)
    await fixture.model.answer(signal, day: Self.today, matchDay: Self.recent.day)
    #expect(fixture.model.pages.isEmpty && fixture.model.openDay == nil && fixture.model.pendingDays.isEmpty)
    #expect(fixture.model.hops.isEmpty && fixture.model.destination == nil)
    await fixture.model.reload()
    #expect(fixture.service.signals.count == 2)
  }

  @Test func sourceNavigationCompletesBeforeItsOpenedSignalAndSurvivesSignalFailure() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    await fixture.model.reload(); fixture.model.open(Self.today); fixture.service.holdSignals = true
    fixture.model.walk(from: Self.today, to: Self.recent)
    #expect(fixture.model.openDay == nil && fixture.model.hops == [Self.today, Self.recent.day])
    #expect(fixture.model.destination?.day == Self.recent.day && fixture.model.destination?.text == Self.recent.text)
    let destination = fixture.model.destination
    try await waitUntil { fixture.service.pendingSignals[0] != nil }
    #expect(fixture.service.signals == [.init(kind: .opened, trigger: Self.today, match: Self.recent.day)])
    fixture.service.finishSignal(0, .failure(JournalEchoFailure.http(503)))
    try await waitUntil { fixture.service.finishedSignals == [0] }
    #expect(fixture.model.destination == destination && fixture.model.hops == [Self.today, Self.recent.day])
  }

  @Test func immediateOpenedOfflineFailureKeepsTheLocalDestinationAndClearsEchoSurfaces() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.response.pages[0].matches = [Self.recent]
    await fixture.model.reload()
    fixture.service.response = Self.response
    await fixture.model.reload()
    #expect(fixture.model.arrivalDay == Self.today)
    fixture.model.open(Self.today)
    fixture.service.signalError = URLError(.notConnectedToInternet)
    fixture.model.walk(from: Self.today, to: Self.recent)
    let destination = try #require(fixture.model.destination)
    #expect(destination.day == Self.recent.day && destination.text == Self.recent.text)
    try await waitUntil { fixture.service.finishedSignals == [0] }
    #expect(fixture.service.signals == [.init(kind: .opened, trigger: Self.today, match: Self.recent.day)])
    #expect(fixture.model.destination == destination)
    #expect(fixture.model.pages.isEmpty && fixture.model.openDay == nil && fixture.model.hops.isEmpty && fixture.model.arrivalDay == nil)
  }

  @Test func followingAnEarlierPassageFoldsLoopsAndReturningToTonightClearsTheTrail() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.response.pages.append(JournalEchoPage(day: Self.recent.day, matches: [Self.older]))
    await fixture.model.reload()
    fixture.model.walk(from: Self.today, to: Self.recent)
    fixture.model.walk(from: Self.recent.day, to: Self.older)
    #expect(fixture.model.hops == [Self.today, Self.recent.day, Self.older.day])
    fixture.model.walk(from: Self.today, to: Self.recent)
    #expect(fixture.model.hops == [Self.today, Self.recent.day])
    fixture.model.stand(on: "2025-01-01")
    #expect(fixture.model.destination?.day == Self.recent.day)
    fixture.model.stand(on: Self.today)
    #expect(fixture.model.hops.isEmpty && fixture.model.destination?.day == Self.today && fixture.model.destination?.text == nil)
    try await waitUntil { fixture.service.signals.count == 3 }
  }

  @Test func coldReadsStayStillAndOnlyANewVerifiedPassageAnnouncesArrival() async {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.response.pages[0].matches = [Self.recent]
    await fixture.model.reload()
    #expect(fixture.model.arrivalDay == nil)
    await fixture.model.reload()
    #expect(fixture.model.arrivalDay == nil)
    fixture.service.response = Self.response
    await fixture.model.reload()
    #expect(fixture.model.arrivalDay == Self.today)
    fixture.model.settleArrival(Self.recent.day)
    #expect(fixture.model.arrivalDay == Self.today)
    fixture.model.settleArrival(Self.today)
    #expect(fixture.model.arrivalDay == nil)
  }

  @Test func disappearingAndRecoveredPassagesDoNotRearmArrival() async {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.response.pages[0].matches = [Self.recent]
    await fixture.model.reload()
    fixture.service.response = Self.response
    await fixture.model.reload()
    #expect(fixture.model.arrivalDay == Self.today)
    fixture.model.settleArrival(Self.today)
    fixture.service.response.pages = []
    await fixture.model.reload()
    #expect(fixture.model.pages.isEmpty && fixture.model.arrivalDay == nil)
    fixture.service.response = Self.response
    await fixture.model.reload()
    #expect(fixture.model.pages == [Self.today: Self.response.pages[0]] && fixture.model.arrivalDay == nil)
    fixture.service.listError = URLError(.notConnectedToInternet)
    await fixture.model.reload()
    #expect(fixture.model.pages.isEmpty && fixture.model.arrivalDay == nil)
    fixture.service.listError = nil
    await fixture.model.reload()
    #expect(fixture.model.pages == [Self.today: Self.response.pages[0]] && fixture.model.arrivalDay == nil)
  }

  @Test func arrivalsInAnOpenPageStayQuietWhenItCloses() async {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.response.pages[0].matches = [Self.recent]
    await fixture.model.reload()
    fixture.model.open(Self.today)
    fixture.service.response = Self.response
    await fixture.model.reload()
    #expect(fixture.model.pages == [Self.today: Self.response.pages[0]] && fixture.model.openDay == Self.today)
    #expect(fixture.model.arrivalDay == nil && !fixture.model.claimArrivalAnnouncement(Self.today))
    fixture.model.openDay = nil
    await fixture.model.reload()
    #expect(fixture.model.arrivalDay == nil && !fixture.model.claimArrivalAnnouncement(Self.today))
  }

  @Test func arrivalAnnouncementCanBeClaimedOnceUntilAnotherNewPassageArrives() async {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.response.pages[0].matches = [Self.recent]
    await fixture.model.reload()
    #expect(!fixture.model.claimArrivalAnnouncement(Self.today))
    fixture.service.response = Self.response
    await fixture.model.reload()
    #expect(!fixture.model.claimArrivalAnnouncement(Self.recent.day))
    #expect(fixture.model.claimArrivalAnnouncement(Self.today))
    #expect(!fixture.model.claimArrivalAnnouncement(Self.today))
    await fixture.model.reload()
    #expect(fixture.model.arrivalDay == Self.today && !fixture.model.claimArrivalAnnouncement(Self.today))
    fixture.model.settleArrival(Self.today)
    #expect(!fixture.model.claimArrivalAnnouncement(Self.today))
    let oldest = JournalEchoMatch(day: "2026-01-02", text: "I have felt this ease after walking before.")
    var bodies = Self.bodies
    bodies[oldest.day] = oldest.text
    fixture.model.updateBodies(bodies)
    fixture.service.response.pages[0].matches.append(oldest)
    await fixture.model.reload()
    #expect(fixture.model.arrivalDay == Self.today && fixture.model.claimArrivalAnnouncement(Self.today))
    #expect(!fixture.model.claimArrivalAnnouncement(Self.today))
  }

  @Test func firstEchoClaimRequiresServerFlagAndVisibleClaim() async {
    let fixture = Fixture(); defer { fixture.close() }
    await fixture.model.reload()
    #expect(!fixture.model.pages.isEmpty && fixture.model.firstEchoDay == nil)
    fixture.model.claimFirstEcho()
    #expect(!fixture.preferences.bool(forKey: "journalFirstEchoSeen"))
    fixture.service.response.firstEchoEver = true
    await fixture.model.reload()
    #expect(fixture.model.firstEchoDay == Self.today)
    fixture.model.open(Self.today); fixture.model.openDay = nil
    #expect(fixture.model.firstEchoDay == Self.today && !fixture.preferences.bool(forKey: "journalFirstEchoSeen"))
    fixture.model.shown(Self.today)
    fixture.model.claimFirstEcho()
    #expect(fixture.preferences.bool(forKey: "journalFirstEchoSeen"))
    await fixture.model.reload()
    #expect(fixture.model.firstEchoDay == nil && !fixture.model.pages.isEmpty)
    #expect(fixture.service.signals.isEmpty)
  }

  @Test func firstEchoOnAnOlderTriggerCannotConsumeTodaysIntroduction() async {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.response = JournalEchoResponse(pages: [JournalEchoPage(day: Self.recent.day, matches: [Self.older])],
                                                   firstEchoEver: true)
    await fixture.model.reload()
    #expect(fixture.model.firstEchoDay == Self.recent.day)
    fixture.model.shown(Self.recent.day); fixture.model.open(Self.recent.day)
    fixture.model.claimFirstEcho()
    #expect(!fixture.preferences.bool(forKey: "journalFirstEchoSeen"))
    fixture.service.response.pages.append(JournalEchoPage(day: Self.today, matches: [Self.recent]))
    await fixture.model.reload()
    #expect(fixture.model.firstEchoDay == Self.today)
    fixture.model.shown(Self.today); fixture.model.claimFirstEcho()
    #expect(fixture.preferences.bool(forKey: "journalFirstEchoSeen"))
  }

  @Test func visibleEchoEventsContainNoPropertiesAndSheetClosureDoesNotDismiss() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    fixture.service.response.firstEchoEver = true
    await fixture.model.reload()
    #expect(fixture.recorder.entries.withLock { $0.isEmpty })
    #expect(fixture.model.firstEchoDay == Self.today)
    fixture.model.shown(Self.today); fixture.model.shown(Self.today); fixture.model.shown("2026-10-07")
    fixture.model.claimFirstEcho()
    fixture.model.open(Self.today); fixture.model.openDay = nil
    #expect(fixture.service.signals.isEmpty && fixture.preferences.bool(forKey: "journalFirstEchoSeen"))
    fixture.model.walk(from: Self.today, to: Self.recent)
    await fixture.model.answer(.useful, day: Self.today, matchDay: Self.recent.day)
    await fixture.model.answer(.dismiss, day: Self.today, matchDay: Self.older.day)
    #expect(fixture.recorder.entries.withLock { $0.map(\.name) } == [
      "journal_echo_shown", "journal_echo_shown", "journal_echo_opened", "journal_echo_useful", "journal_echo_dismissed"
    ])
    #expect(fixture.recorder.entries.withLock { $0.allSatisfy { $0.properties.isEmpty } })
    try await waitUntil { fixture.service.signals.count == 3 }
    fixture.model.suspend()
    fixture.model.activate(JournalEchoAccess(account: "account-a", today: Self.today, available: true))
    await fixture.model.reload(); fixture.model.shown(Self.today)
    #expect(fixture.model.firstEchoDay == nil)
    #expect(fixture.recorder.entries.withLock { $0.filter { $0.name == "journal_echo_shown" }.count } == 4)
  }

  @Test func anEmptyJournalDoesNotFetchAndAStalledEchoReadNeverBlocksTypingOrSaving() async throws {
    let fixture = Fixture(); defer { fixture.close() }
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let journal = try JournalModel(runner: harness.runner, preferences: fixture.preferences, echoService: fixture.service)
    defer { journal.saveTask?.cancel(); journal.echoes.suspend() }
    journal.echoes.activate(JournalEchoAccess(account: "account-a", today: journal.today.text, available: true))
    journal.echoes.updateBodies(journal.echoBodies)
    await journal.echoes.reload()
    #expect(fixture.service.lists.isEmpty && journal.echoes.pages.isEmpty)
    journal.type("First private line."); #expect(journal.save())
    journal.echoes.updateBodies(journal.echoBodies); fixture.service.holdLists = true
    let reading = Task { await journal.echoes.reload() }
    defer { reading.cancel() }
    try await waitUntil { fixture.service.pendingLists[0] != nil }
    journal.type("First private line. Writing continues while echoes wait.")
    #expect(journal.save() && !journal.dirty && journal.error == nil)
    #expect(fixture.service.pendingLists[0] != nil)
    let room = try harness.runner.read(Journal.scope, JournalRoom.init)
    #expect(room.days.first(where: { $0.day == journal.today })?.document.body == "First private line. Writing continues while echoes wait.")
    fixture.service.finishList(0, .failure(URLError(.notConnectedToInternet))); await reading.value
    #expect(journal.document.body == "First private line. Writing continues while echoes wait.")
    #expect(journal.error == nil && journal.backup == "saved" && journal.echoes.pages.isEmpty)
  }
}
