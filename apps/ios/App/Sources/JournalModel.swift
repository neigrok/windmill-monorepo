import Foundation
import Observation
import DomainKit
import JournalDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import SyncSchema
import SyncStore
import SyncIOS

@Observable @MainActor
final class JournalModel {
  let runner: ActionRunner
  let telemetry: any Telemetry
  let preferences: UserDefaults
  let runtime: AppRuntime?
  @ObservationIgnored weak var app: AppModel?
  var invitationShown = false
  var keepInvitationShown = false
  var room: JournalRoom?
  var document = PageDocument()
  var editing = false
  var dirty = false
  var readFailed = false
  var error: String?
  var inkVisible = false
  private var firstOpenEligible: Bool
  var firstKept = false
  @ObservationIgnored var saveTask: Task<Void, Never>?
  var editorDay: LocalDay

  init(runner: ActionRunner, preferences: UserDefaults, runtime: AppRuntime? = nil, telemetry: any Telemetry = NoopTelemetry()) throws {
    self.telemetry = telemetry
    self.runner = runner; self.preferences = preferences; self.runtime = runtime
    firstOpenEligible = !preferences.bool(forKey: "journalOpened")
    editorDay = try runner.moment().today
    if let draft = try runner.read(Journal.scope, { try $0.device(EditorDraft.key).map(EditorDraft.init(json:)) }) {
      editorDay = draft.day; document = draft.document; dirty = true
    }
    refresh()
  }

  var account: String? { app?.account ?? (try? runtime?.account()) }
  var sheet: AppModel.Sheet? { app?.sheet }
  var authPaused: Bool { runtime?.engine.status.authPaused == true }
  var compactAccountSheet: Bool { app?.compactAccountSheet == true }
  var editorReadOnly: Bool { app?.editorReadOnly == true }
  var keepDismissed: Bool { app?.keepDismissed ?? preferences.bool(forKey: "keepDismissed") }
  var welcome: Bool { app?.welcome ?? !preferences.bool(forKey: "journalOpened") }
  var today: LocalDay { (try? runner.moment().today) ?? editorDay }
  var words: Int { document.body.split(whereSeparator: \.isWhitespace).filter { $0.contains { $0.isLetter || $0.isNumber } }.count }
  var showPrivacy: Bool { room?.firstRunKnown == true && room?.state.privacyLine == "pending" }
  var showPlaceholder: Bool { room?.firstRunKnown == true && room?.state.placeholder == "pending" && document.body.isEmpty }
  var scalesDue: Bool { !editing && room?.scaleInvitationDue == true }
  var keepDue: Bool { !editing && account == nil && room?.keepDue == true && !keepDismissed && !scalesDue }
  var backup: String {
    if authPaused { return "backup paused" }
    if dirty || readFailed { return "not saved" }
    guard document.isWritten else { return "" }
    if account == nil { return "saved" }
    guard let day = room?.days.first(where: { $0.day == editorDay }) else { return "not backed up yet" }
    switch day.backup {
    case .backedUp: return "backed up"
    case .refused: return "not saved"
    case .pending, .savedHere: return "not backed up yet"
    }
  }

  func openJournal() {
    if app == nil { choose("open_journal", screen: "welcome") }
    preferences.set(true, forKey: "journalOpened")
    refresh(); automaticallyShowInk()
  }

  func automaticallyShowInk() {
    guard app == nil || app?.selectedRoom == .journal,
          firstOpenEligible, room?.stance == .empty, room?.firstRunKnown == true, room?.days.isEmpty == true,
          !document.isWritten, !readFailed, !editing, !editorReadOnly, sheet == nil,
          !preferences.bool(forKey: "inkShown") else { return }
    firstOpenEligible = false
    preferences.set(true, forKey: "inkShown"); inkVisible = true; screenViewed("ink_notes")
  }

  func liftInk() {
    firstOpenEligible = false
    if inkVisible { choose("dismiss_ink", screen: "ink_notes") }
    inkVisible = false
  }

  func refresh() {
    do {
      if try transitionDay() { _ = save(); return }
      if !dirty {
        let pending = try runner.read(Journal.scope) { try $0.devices(prefix: "pendingClaim:").members.filter { $0.key != EditorDraft.key }.map { try PendingClaim(json: $0.value) } }
        for item in pending { _ = try runner.run(ReconcileClaim(day: item.day, claimId: item.claimId)) }
      }
      let value = try runner.read(Journal.scope, JournalRoom.init)
      room = value
      let hasHistory = value.stance == .holding || !value.days.isEmpty || value.state.firstPage == "retired" || document.isWritten
      if hasHistory { firstOpenEligible = false }
      let journalIsOpen = !welcome && (app == nil || app?.selectedRoom == .journal)
      if hasHistory || journalIsOpen, !preferences.bool(forKey: "journalOpened") { preferences.set(true, forKey: "journalOpened") }
      if readFailed { error = nil; readFailed = false }
      if !dirty && !editing { document = value.days.first(where: { $0.day == editorDay })?.document ?? PageDocument() }
      if value.days.contains(where: { if case .refused = $0.backup { return true }; return false }) {
        error = "Your writing is still on this phone. This page hasn't been backed up."
      }
    } catch {
      if !readFailed { reportBoundary("journal_read", error: error) }
      readFailed = true
      self.error = "Couldn't read the journal. Your current writing is kept here; try again."
    }
    recordInvitations()
  }

  func type(_ text: String) {
    guard !editorReadOnly else { return }
    liftInk()
    if !text.isEmpty && room?.state.placeholder == "pending" {
      do { _ = try runner.run(RetireJournalInvitation("placeholder")); room = try runner.read(Journal.scope, JournalRoom.init) }
      catch { reportBoundary("journal_choice", error: error); self.error = "Couldn't save on this phone. Your writing stays in the editor." }
    }
    document.body = text; dirty = true; error = nil
    preserveDraft()
    if editorDay != today { _ = save(); return }
    saveTask?.cancel()
    saveTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(600))
      guard !Task.isCancelled else { return }
      self?.save()
    }
  }

  @discardableResult func save(retiring: [String] = []) -> Bool {
    saveTask?.cancel()
    do {
      _ = try transitionDay()
      if document.body.utf8.count > 131_072 {
        error = "Your draft is kept on this phone. Shorten this page before it can be backed up."; dirty = true; return false
      }
      let previousBody = room?.days.first(where: { $0.day == editorDay })?.document.body ?? ""
      let wasFirst = room?.state.firstPage == "pending"
      switch try runner.run(SavePage(day: editorDay, document: document, retiring: retiring)) {
      case .committed, .unchanged:
        if document.isWritten && editorDay == today && document.body != previousBody { telemetry.event("journal_line_saved", properties: ["day_kind": "today"]) }
        dirty = false; error = nil
        if wasFirst && document.isWritten { firstKept = true }
        refresh(); return true
      case .refused:
        error = "This page couldn't be saved. Your writing stays in the editor."; dirty = true; return false
      }
    } catch {
      reportBoundary("journal_save", error: error)
      self.error = "Couldn't save on this phone. Your writing stays in the editor. Try again."; dirty = true; return false
    }
  }

  @discardableResult func preserveDraft() -> Bool {
    do {
      switch try runner.run(PreserveEditorDraft(day: editorDay, document: document)) {
      case .committed, .unchanged: return true
      case .refused: break
      }
    } catch { reportBoundary("journal_draft", error: error) }
    error = "Couldn't keep the draft on this phone. Your writing stays in the editor. Try saving again."
    return false
  }

  func transitionDay() throws -> Bool {
    let current = try runner.moment().today
    guard editorDay != current else { return false }
    let destination = try runner.read(Journal.scope, JournalRoom.init).days.first(where: { $0.day == current })?.document ?? PageDocument()
    if dirty || (editing && document.isWritten) {
      document.body = JournalWriting.claimBody(destination.body, document.body)
      document.mood = document.mood ?? destination.mood; document.energy = document.energy ?? destination.energy
      editorDay = current; dirty = true; preserveDraft()
      return true
    }
    editorDay = current; document = destination
    return false
  }

  func background() { if dirty || editorDay != today { _ = save() } }

  func done() { if dirty { _ = save() }; editing = false; refresh() }

  func setScale(_ name: String, _ value: Int?) {
    guard !editorReadOnly else { return }
    liftInk()
    let answeringInvitation = room?.scaleInvitationDue == true && value != nil
    if name == "mood" { document.mood = value } else { document.energy = value }
    dirty = true; preserveDraft(); if save(retiring: value == nil ? [] : ["scales"]), answeringInvitation { telemetry.event("scale_invitation_answered", properties: ["action": "answered"]) }
  }

  func dismissScales() {
    do {
      switch try runner.run(RetireJournalInvitation("scales")) {
      case .committed, .unchanged: telemetry.event("scale_invitation_answered", properties: ["action": "declined"]); refresh()
      case .refused: error = "Couldn't save this choice. Try again."
      }
    } catch { reportBoundary("journal_choice", error: error); self.error = "Couldn't save this choice. Try again." }
  }

  func reportBoundary(_ operation: String, error: any Error) {
    guard Store.failureKind(error) == nil, !(error is KeychainError) else { return }
    telemetry.failure(operation, kind: "unexpected")
  }

  func screenViewed(_ screen: String) { telemetry.event("first_run_screen_viewed", properties: ["screen": screen]) }

  func choose(_ action: String, screen: String) { telemetry.event("first_run_choice", properties: ["screen": screen, "action": action]) }

  func recordInvitations() {
    if room?.scaleInvitationDue != true { invitationShown = false }
    if room?.keepDue != true { keepInvitationShown = false }
    guard !welcome, !editing, app == nil || app?.selectedRoom == .journal else { return }
    if scalesDue && !invitationShown { invitationShown = true; telemetry.event("scale_invitation_shown") }
    if keepDue && !keepInvitationShown { keepInvitationShown = true; screenViewed("keep") }
  }

  func keep() { app?.keep() }
}
