import Foundation
import SwiftUI
import Observation
import DomainKit
import JournalDomain
import GymDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import SyncSchema
import SyncStore
import SyncIOS

@Observable @MainActor
final class AppModel {
  let runner: ActionRunner
  let telemetry: any Telemetry
  let preferences: UserDefaults
  let runtime: AppRuntime?
  let authRetryNow: () -> Date
  let journal: JournalModel
  let gym: GymModel
  // The room in front is the room the next launch opens, whichever door brought it forward.
  var selectedRoom: Room { didSet { preferences.set(selectedRoom.rawValue, forKey: "lastRoom") } }
  var welcome: Bool
  var error: String?
  var sheet: Sheet? {
    didSet { if sheet != nil, !welcome, selectedRoom == .journal { journal.liftInk() } }
  }
  var account: String?
  var keptWork = false
  var accountName = ""
  var keepDismissed: Bool
  var keepSheetPresented = false
  var email = ""
  var code = ""
  var codeSentAt: Date?
  var appleTicket: AppleTicket?
  var appleOrigin: Sheet = .keep
  var appleReceiptEmail = ""
  var appleLinkedReceipt = false
  @ObservationIgnored var appleAuthorization: ((SessionToken?) async throws -> AppleAuthResponse)?
  var pendingSignIn: PendingSignIn?
  var authRetryAt = Date.distantPast
  var signInMethods: [SignInMethod] = []
  var methodsGeneration = 0
  var accountEmail = ""
  var identityTaken = false
  var removingApple = false
  var authSuccess = 0
  var authSelection = 0
  var authBusyIndicator = false
  var working = false
  var accountTransition = false
  var signingOut = false { didSet { gym.accountChanging = signingOut || signOutSession != nil } }
  var syncStarted = false
  // Routines at its root, asked for from outside the app; GymRoom answers it.
  var routinesRequested = false
  var restoringSignIn = false
  var signInDeferred = false
  var resumingBackup = false
  var authGeneration = 0
  var signInSession: SignInSession?
  var signOutSession: SignOutSession? { didSet { gym.accountChanging = signingOut || signOutSession != nil } }
  // Why the last Sign out could not begin or be carried out; the next Sign out clears it.
  var signOutRefusal: String?
  var adoptionAnswers: [String: LineageAnswer] = [:]
  var appearance: Appearance
  var updateRequiredAtSignIn = false
  var updateAlert = false
  var updateOpenFailed = false
  @ObservationIgnored var updateAlertShown = false
  @ObservationIgnored var observationTask: Task<Void, Never>?
  @ObservationIgnored var timerTask: Task<Void, Never>?
  @ObservationIgnored var polledThrough: UInt64?
  @ObservationIgnored var backupTask: Task<Void, Never>?
  @ObservationIgnored var authTask: Task<Void, Never>?
  @ObservationIgnored var recoveryDue: ContinuousClock.Instant?
  @ObservationIgnored var recoveryDelayMs = Constants.backoffBaseMs

  enum Room: String, CaseIterable {
    case journal, gym
    var title: String { self == .journal ? "Journal" : "Gym" }
    var symbol: String { self == .journal ? "book.closed" : "dumbbell" }
  }
  enum Appearance: String, CaseIterable {
    case light, dark, system
    var title: String { rawValue.capitalized }
    init(preferences: UserDefaults) { self = Appearance(rawValue: preferences.string(forKey: "appearance") ?? "") ?? .system }
  }
  enum Sheet: String, Identifiable {
    case keep, address, code, you, adoption, discardAdoption
    case appleQuestion = "23a", appleAddress = "23b", appleAdded = "23c", appleNoAccount, appleExpired
    var id: String { rawValue }
    var telemetryName: String {
      switch self {
      case .discardAdoption: "discard_adoption"
      case .appleNoAccount: "apple_no_account"
      case .appleExpired: "apple_expired"
      default: rawValue
      }
    }
  }

  struct PendingSignIn {
    let identity: AuthIdentity
    let method: String
    let linked: Bool
    var needsAppleAttachment: Bool
    var receiptPending: Bool
  }

  init(runner: ActionRunner, preferences: UserDefaults, runtime: AppRuntime? = nil, telemetry: any Telemetry = NoopTelemetry(), authRetryNow: @escaping () -> Date = Date.init) throws {
    self.runner = runner; self.preferences = preferences; self.runtime = runtime; self.telemetry = telemetry; self.authRetryNow = authRetryNow
    journal = try JournalModel(runner: runner, preferences: preferences, runtime: runtime, telemetry: telemetry)
    gym = GymModel(runner: runner, runtime: runtime, telemetry: telemetry)
    selectedRoom = Room(rawValue: preferences.string(forKey: "lastRoom") ?? "") ?? .journal
    welcome = preferences.string(forKey: "lastRoom") == nil && (!preferences.bool(forKey: "journalOpened") || preferences.bool(forKey: "roomWelcomeRequired"))
    keepDismissed = preferences.bool(forKey: "keepDismissed")
    appearance = Appearance(preferences: preferences)
    journal.app = self
    refresh()
    if let account {
      accountEmail = preferences.string(forKey: "accountEmail:\(account)") ?? ""
      accountName = preferences.string(forKey: "accountName:\(account)") ?? ""
    }
    if account != nil || journal.room?.stance == .holding || gym.hasData { welcome = false }
    if let runtime, let pending = try runtime.store.read({ try $0.device().meta.pendingSignIn }), let token = runtime.tokens.token(for: pending) {
      let identity = AuthIdentity(account: pending, token: token, name: preferences.string(forKey: "accountName:\(pending)") ?? "",
                                email: preferences.string(forKey: "accountEmail:\(pending)") ?? "")
      pendingSignIn = PendingSignIn(identity: identity, method: preferences.string(forKey: "pendingAuthMethod") ?? "email", linked: preferences.bool(forKey: "pendingAuthLinked"), needsAppleAttachment: false, receiptPending: false)
      restoringSignIn = true; sheet = .you; welcome = false
    }
  }

  var canSignIn: Bool { runtime?.settings.baseURL != nil || runtime?.settings.modelServer == true }
  var authPaused: Bool { runtime?.engine.status.authPaused == true }
  // A sign-in the server has verified but the engine has not finished: You carries it until it lands or is given up.
  var signInPending: Bool { pendingSignIn != nil || signInSession?.isComplete == false }
  var compactAccountSheet: Bool { [.keep, .appleQuestion, .appleNoAccount, .appleExpired].contains(sheet) }
  var editorReadOnly: Bool { working || accountTransition || (!signInDeferred && signInPending) || signOutSession != nil }
  var appleSessionToken: SessionToken? {
    guard !authPaused, let account else { return nil }
    return runtime?.tokens.token(for: account)
  }

  func reportBoundary(_ operation: String, error: any Error) {
    guard Store.failureKind(error) == nil, !(error is KeychainError), !(error is CancellationError),
          (error as? EngineError) != .unreachable, (error as? EngineError) != .upgradeRequired else { return }
    telemetry.failure(operation, kind: "unexpected")
  }
  func screenViewed(_ screen: String) { telemetry.event("first_run_screen_viewed", properties: ["screen": screen]) }
  func choose(_ action: String, screen: String) { telemetry.event("first_run_choice", properties: ["screen": screen, "action": action]) }

  func chooseAppearance(_ next: Appearance) {
    guard next != appearance else { return }
    appearance = next; preferences.set(next.rawValue, forKey: "appearance")
    telemetry.event("appearance_chosen", properties: ["appearance": next.rawValue])
  }

  // The server needs a newer app: the engine's flag, or a 426 at sign-in.
  var updateRequired: Bool { runtime?.engine.status.upgradeRequired == true || updateRequiredAtSignIn }
  var updateTrigger: String { updateRequiredAtSignIn ? "sign_in" : "sync" }
  // Signed out nothing syncs: the update unlocks the sign-in.
  var updateMessage: String {
    account == nil ? "Update Windmill to sign in. Your work is saved on this phone." : "Update Windmill to keep syncing. Your work is saved on this phone."
  }

  // Once per launch while the flag holds; a sign-in refused for it asks again, as that attempt's answer.
  func noticeUpdateRequired() {
    guard updateRequired, !updateAlertShown else { return }
    askForUpdate()
  }

  func requireUpdateAtSignIn() {
    updateRequiredAtSignIn = true; error = nil
    askForUpdate()
  }

  // The alert is asked for here and recorded by `updateAlertPresented` once it is on screen, which the introduction or
  // another alert may delay.
  func askForUpdate() {
    updateAlertShown = true; updateAlert = true
  }

  func updateAlertPresented() {
    telemetry.event("client_update_required", properties: ["state": "shown", "status": "426", "trigger": updateTrigger])
  }

  func keepWorkingWithoutUpdate() {
    updateAlert = false
    telemetry.event("client_update_required", properties: ["action": "keep", "trigger": updateTrigger])
  }

  // Get the update, from the alert or You; the caller opens the destination and reports whether it could.
  func getUpdate() {
    updateAlert = false
    telemetry.event("client_update_required", properties: ["action": "update", "trigger": updateTrigger])
  }

  func updateOpened(_ accepted: Bool) {
    updateOpenFailed = !accepted
    if !accepted { telemetry.event("client_update_required", properties: ["action": "update", "outcome": "failed", "trigger": updateTrigger]) }
  }

  func dismissUpdateFailure() { updateOpenFailed = false }

  var adoptionCount: Int { currentAdoption?.counts["page"] ?? 0 }
  var adoptionIsSingle: Bool { currentAdoption?.counts.filter { $0.key != "journalState" }.values.reduce(0, +) == 1 }

  func openJournal() { openRoom(.journal) }
  func openYou() { journal.done(); sheet = .you }

  // You's identity: the name, or the email when no name is set, and the account's one status.
  var identityTitle: String { account == nil ? "Not signed in" : accountName.nilIfEmpty ?? accountEmail }
  var identityStatus: String? {
    if updateRequired, account != nil || signInPending { return "Syncing paused · update Windmill" }
    guard account != nil else { return nil }
    if authPaused { return "Syncing paused · sign in again" }
    let unsent = (runtime?.engine.status.ready ?? 0) + (runtime?.engine.status.sent ?? 0)
    return unsent == 0 ? "Backed up" : "Not backed up yet"
  }
  // The address is said once: How you sign in's Email row carries it only while the identity shows a name.
  var emailMethodValue: String? { accountName.isEmpty ? nil : accountEmail }

  // What each room keeps on this phone while signed out, one line for each room that holds something.
  var phoneHoldings: [(room: Room, summary: String)] {
    let pages = journal.room?.days.filter { $0.document.isWritten }.count ?? 0
    let journalSummary = pages == 0 ? nil : "\(pages) \(pages == 1 ? "page" : "pages")"
    return [(Room.journal, journalSummary), (Room.gym, gym.phoneSummary)].compactMap { room, summary in summary.map { (room, $0) } }
  }
  func openRoom(_ room: Room) {
    guard !editorReadOnly else { return }
    if !welcome, selectedRoom == .journal { journal.liftInk() }
    journal.done()
    selectedRoom = room; welcome = false; preferences.set(false, forKey: "roomWelcomeRequired")
    choose(room == .journal ? "open_journal" : "open_gym", screen: "welcome")
    if room == .journal { journal.openJournal() }
    refresh()
  }

  func switchRoom(_ room: Room) {
    guard !editorReadOnly else { return }
    if selectedRoom == .journal { journal.liftInk() }
    guard room != selectedRoom else { return }
    journal.done()
    selectedRoom = room
    telemetry.event("room_switched", properties: ["room": room.rawValue])
    refresh()
    if room == .journal {
      preferences.set(true, forKey: "journalOpened")
      journal.automaticallyShowInk()
    }
  }

  func refresh() {
    poll(); gym.refresh()
  }

  // The clock re-reads the journal, the account and the connection once the store moves; the gym observes its own records.
  func poll() {
    polledThrough = runtime?.engine.lastChange
    journal.refresh()
    if runtime?.connectivity?.isOnline == false {
      telemetry.event("api_request_failed", properties: ["operation": "sync_hello", "route": "/v1/sync", "method": "GET", "failure_kind": "offline"])
    }
    do {
      // Set only when they changed, so a poll that changes nothing redraws nothing (GymModel.publish).
      if let runtime {
        let polled = try runtime.account(), kept = try runtime.hasKeptWork()
        if account != polled { account = polled }
        if keptWork != kept { keptWork = kept }
      }
    } catch {
      polledThrough = nil
      reportBoundary("auth_restore", error: error); self.error = "Couldn't read the account. Your work stays on this phone. Try again."
    }
  }

  // Since the last poll the store moved, the journal's day turned, or a read failed.
  var pollDue: Bool {
    runtime?.engine.lastChange != polledThrough || journal.editorDay != journal.today || journal.readFailed
  }

  func scenePhaseChanged(_ phase: ScenePhase) {
    switch phase {
    case .inactive: if journal.dirty { _ = journal.preserveDraft() }
    case .background: background()
    case .active: refresh()
    @unknown default: if journal.dirty { _ = journal.preserveDraft() }
    }
  }

  func background() { journal.background(); gym.background() }

  @discardableResult func flushRooms() -> Bool {
    if journal.dirty && !journal.save() { error = journal.error; return false }
    guard gym.flush() else { error = gym.error; return false }
    return true
  }

  func start() async {
    guard let runtime else { return }
    if let backupTask {
      await withTaskCancellationHandler { await backupTask.value } onCancel: { backupTask.cancel() }
      return
    }
    let restoring = restoringSignIn
    if observationTask == nil {
      let events = runtime.engine.events()
      observationTask = Task { [weak self] in
        for await _ in events { self?.refresh() }
      }
    }
    gym.start()
    Task { await runtime.revokeSignedOutSessions(force: true) }
    if timerTask == nil {
      timerTask = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: .milliseconds(350))
          guard let self, !Task.isCancelled else { return }
          if self.pollDue { self.poll() }
          self.noticeUpdateRequired()
          self.expireAppleTicket()
          if !self.signInDeferred, !self.restoringSignIn, self.pendingSignIn != nil, !self.working, !self.accountTransition, self.authRetryAt <= self.authRetryNow() {
            self.performAuthentication { await self.retryAuthenticatedSignIn() }
          }
          if !self.signInDeferred, !self.syncStarted, self.backupTask == nil, !self.journal.dirty {
            _ = self.startBackup()
          }
          Task { await self.runtime?.revokeSignedOutSessions() }
        }
      }
    }
    let backup = startBackup()
    await withTaskCancellationHandler { await backup.value } onCancel: { backup.cancel() }
    guard !Task.isCancelled, !backup.isCancelled else { return }
    refresh()
    runtime.updateTelemetryIdentity()
    if !syncStarted {
      let outcome = journal.dirty ? (account == nil ? "anonymous" : authPaused ? "paused" : "signed_in") : "failed"
      telemetry.event("auth_restore", properties: ["outcome": outcome])
    }
    if !welcome, !restoring, selectedRoom == .journal { journal.automaticallyShowInk() }
  }

  func startBackup() -> Task<Void, Never> {
    if let backupTask { return backupTask }
    let task = Task { await self.resumeBackup(); self.backupTask = nil }
    backupTask = task
    return task
  }

  func resumeBackup() async {
    guard !Task.isCancelled, !syncStarted, !resumingBackup, !accountTransition, !working,
          signOutSession == nil, signInSession?.isComplete != false || restoringSignIn,
          pendingSignIn == nil || restoringSignIn, let runtime else { return }
    if let recoveryDue, recoveryDue > ContinuousClock.now { return }
    let generation = authGeneration
    let restoring = restoringSignIn
    resumingBackup = true
    defer { resumingBackup = false }
    accountTransition = restoring
    if restoring { journal.editing = false }
    defer { if authGeneration == generation { accountTransition = false } }
    if !flushRooms() { return }
    await runtime.engine.start()
    guard !Task.isCancelled, authGeneration == generation else { return }
    do {
      let resumed = restoring ? try await runtime.engine.resumeSignIn() : nil
      try Task.checkCancellation()
      setSignInSession(resumed)
      if let resumed, !resumed.isComplete, currentAdoption == nil { try await completeAdoption(resumed) }
      syncStarted = true
      recoveryDue = nil; recoveryDelayMs = Constants.backoffBaseMs
      refresh()
      runtime.updateTelemetryIdentity()
      if restoringSignIn {
        if let pending = pendingSignIn, preferences.string(forKey: "pendingAuthMethod") != nil {
          telemetry.event("auth_signed_in", properties: ["method": pending.method, "outcome": pending.linked ? "linked" : "ok"])
        }
        pendingSignIn = nil; restoringSignIn = false
        preferences.removeObject(forKey: "pendingAuthMethod"); preferences.removeObject(forKey: "pendingAuthLinked")
        presentSignInResult()
      } else if signInSession?.isComplete == false { sheet = .adoption }
      telemetry.event("auth_restore", properties: ["outcome": account == nil ? "anonymous" : authPaused ? "paused" : "signed_in"])
    } catch {
      guard !Task.isCancelled, !(error is CancellationError) else { return }
      let delayMs = Int64.random(in: Constants.backoffBaseMs...recoveryDelayMs)
      recoveryDue = ContinuousClock.now.advanced(by: .milliseconds(delayMs))
      recoveryDelayMs = min(recoveryDelayMs * 2, Constants.backoffLiveCeilingMs)
      guard !(error is EngineError) else { return }
      reportBoundary("auth_restore", error: error)
    }
  }

  func keep() { choose("keep", screen: selectedRoom.rawValue); journal.done(); keepSheetPresented = true; sheet = .keep }

  func closeKeep() { choose("close", screen: "keep"); sheet = nil; dismissKeep() }

  func dismissKeep() {
    guard journal.room?.keepDue == true else { return }
    keepDismissed = true; preferences.set(true, forKey: "keepDismissed")
  }

  func dismissSheet() {
    cancelAuthentication()
    if keepSheetPresented { dismissKeep() }
    keepSheetPresented = false
    appleTicket = nil; appleLinkedReceipt = false; error = nil
    if pendingSignIn == nil { appleAuthorization = nil }
  }

  func cancelAuthentication() {
    authGeneration += 1
    authTask?.cancel(); authTask = nil
    if pendingSignIn != nil || signInSession?.isComplete == false { signInDeferred = true; backupTask?.cancel() }
    working = false; accountTransition = false; signingOut = false; authBusyIndicator = false
  }

  func performAuthentication(_ operation: @escaping @MainActor () async -> Void) {
    guard authTask == nil, !working, !accountTransition else { return }
    if !restoringSignIn { backupTask?.cancel() }
    authGeneration += 1
    let generation = authGeneration
    authTask = Task {
      guard !Task.isCancelled, self.authGeneration == generation else { return }
      await operation()
      if self.authGeneration == generation { self.authTask = nil }
    }
  }

  func useAppleAccount() {
    cancelAuthentication()
    guard !expireAppleTicket() else { return }
    choose("use_account", screen: "23a"); authSelection += 1
    code = ""; error = nil; sheet = .appleAddress
  }

  func closeAppleStep() {
    choose("close", screen: sheet?.telemetryName ?? "23a")
    appleTicket = nil; appleAuthorization = nil; error = nil; sheet = appleOrigin
  }

  @discardableResult func expireAppleTicket() -> Bool {
    guard !working, pendingSignIn == nil, let ticket = appleTicket, ticket.expiresAt <= Date() else { return false }
    appleTicket = nil; appleAuthorization = nil; error = nil; sheet = .appleExpired
    return true
  }

  func showAuthError(_ failure: any Error, appleFlow: Bool = false) {
    if (failure as? EngineError) == .upgradeRequired || (failure as? AuthRefusal)?.code == AuthRefusal.updateRequired.code {
      requireUpdateAtSignIn(); return
    }
    if let refusal = failure as? AuthRefusal {
      if refusal.code == "apple-ticket-expired" { appleTicket = nil; appleAuthorization = nil; error = nil; sheet = .appleExpired; return }
      if refusal.code == "no-account" { error = nil; sheet = .appleNoAccount; return }
      if refusal.code == "identity-taken" { identityTaken = true; screenViewed("24d"); error = nil; return }
    }
    let offline = (failure as? AuthRefusal)?.code == "offline" || (failure as? URLError).map {
      [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost, .timedOut].contains($0.code)
    } == true
    if failure is CancellationError || (failure as? URLError)?.code == .cancelled { return }
    error = offline ? AuthRefusal.offline.message : failure.localizedDescription
  }

  func createAppleAccount() async {
    guard !working, pendingSignIn == nil, !expireAppleTicket(), let ticket = appleTicket, let auth = runtime?.auth else { return }
    guard account == nil else { error = "Sign in to the same account to resume backup. Your pages stay with this account."; return }
    choose("create_account", screen: sheet == .appleNoAccount ? "apple_no_account" : "23a"); authSelection += 1
    let generation = authGeneration
    working = true; accountTransition = true; error = nil
    defer { if authGeneration == generation { working = false; accountTransition = false } }
    do {
      let identity = try await auth.createApple(ticket: ticket)
      appleLinkedReceipt = false
      try await acceptAuthenticatedSignIn(identity, method: "apple")
    } catch { telemetry.event("auth_signed_in", properties: ["method": "apple", "outcome": "failed"]); showAuthError(error) }
  }

  func loadSignInMethods() async {
    guard let token = appleSessionToken, let auth = runtime?.auth else { return }
    let current = account
    methodsGeneration += 1
    let generation = methodsGeneration
    do {
      let methods = try await auth.signInMethods(token: token)
      guard account == current, methodsGeneration == generation else { return }
      signInMethods = methods
      accountEmail = methods.first(where: { $0.kind == "email" })?.email ?? accountEmail
      if let account { preferences.set(accountEmail, forKey: "accountEmail:\(account)") }
    } catch { if account == current, methodsGeneration == generation { showAuthError(error) } }
  }

  func askToRemoveApple() { removingApple = true; screenViewed("24c") }
  func confirmAppleRemoval() { removingApple = false; performAuthentication { await self.removeApple() } }
  // Leaving the question any way but Remove Apple counts as Cancel, as the iOS 26 dialog has no Cancel button.
  func cancelAppleRemoval() {
    guard removingApple else { return }
    removingApple = false; choose("cancel", screen: "24c")
  }
  func removeApple() async {
    guard !working, let token = appleSessionToken, let auth = runtime?.auth else { return }
    choose("remove_apple", screen: "24c")
    methodsGeneration += 1
    let generation = authGeneration
    working = true; error = nil
    defer { if authGeneration == generation { working = false } }
    do { try await auth.removeApple(token: token); signInMethods.removeAll { $0.kind == "apple" } }
    catch { showAuthError(error) }
  }

  func sendCode() async {
    guard !working, pendingSignIn == nil, let auth = runtime?.auth else { return }
    if expireAppleTicket() { return }
    if appleTicket != nil, account != nil, !accountEmail.isEmpty, email.lowercased() != accountEmail.lowercased() {
      error = "Sign in to the same account to resume backup. Your pages stay with this account."; return
    }
    if sheet == .code, let sent = codeSentAt, Date().timeIntervalSince(sent) < 30 { return }
    if sheet == .code { choose("resend", screen: "code") }
    telemetry.event("auth_code_requested", properties: ["method": "email"])
    let generation = authGeneration
    working = true; error = nil
    defer { if authGeneration == generation { working = false } }
    do {
      try await auth.requestCode(email: email)
      try Task.checkCancellation()
      telemetry.event("auth_code_sent", properties: ["method": "email", "outcome": "ok"])
      codeSentAt = Date(); code = ""; sheet = .code
    } catch { telemetry.event("auth_code_sent", properties: ["method": "email", "outcome": "failed"]); showAuthError(error) }
  }

  func verifyCode() async {
    guard !working, pendingSignIn == nil, code.count == 6, let auth = runtime?.auth else { return }
    if expireAppleTicket() { return }
    if appleTicket != nil, account != nil, !accountEmail.isEmpty, email.lowercased() != accountEmail.lowercased() {
      error = "Sign in to the same account to resume backup. Your pages stay with this account."; return
    }
    let generation = authGeneration
    working = true; error = nil
    authBusyIndicator = false
    let indicator = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(800))
      if !Task.isCancelled { self?.authBusyIndicator = true }
    }
    defer { indicator.cancel(); if authGeneration == generation { authBusyIndicator = false; working = false } }
    accountTransition = true; journal.editing = false
    defer { if authGeneration == generation { accountTransition = false } }
    let method = appleTicket == nil ? "email" : "apple"
    telemetry.event("auth_sign_in_started", properties: ["method": method])
    do {
      let reauthenticatingApple = appleTicket != nil && account != nil
      let identity = try await auth.verifyCode(email: email, code: code, appleTicket: reauthenticatingApple ? nil : appleTicket)
      try Task.checkCancellation()
      try await acceptAuthenticatedSignIn(identity, method: method, attachApple: reauthenticatingApple)
    }
    catch { telemetry.event("auth_signed_in", properties: ["method": method, "outcome": "failed"]); showAuthError(error) }
  }

  func acceptAuthenticatedSignIn(_ identity: AuthIdentity, method: String, attachApple: Bool = false) async throws {
    try Task.checkCancellation()
    if let current = account, !current.utf8.elementsEqual(identity.account.utf8) {
      try? await runtime?.auth.logout(token: identity.token)
      throw AppFailure(message: "Sign in to the same account to resume backup. Your pages stay with this account.")
    }
    pendingSignIn = PendingSignIn(identity: identity, method: method, linked: identity.appleAttached || attachApple, needsAppleAttachment: attachApple, receiptPending: identity.appleAttached || attachApple)
    preferences.set(method, forKey: "pendingAuthMethod")
    preferences.set(identity.appleAttached || attachApple, forKey: "pendingAuthLinked")
    appleTicket = nil
    await continueAuthenticatedSignIn()
  }

  func verifyLink(_ link: String) async {
    guard !working, pendingSignIn == nil, appleTicket == nil, let auth = runtime?.auth else { return }
    let generation = authGeneration
    working = true; accountTransition = true; error = nil; journal.done()
    defer { if authGeneration == generation { working = false; accountTransition = false } }
    telemetry.event("auth_sign_in_started", properties: ["method": "email"])
    do { try await acceptAuthenticatedSignIn(auth.verifyLink(link), method: "email") }
    catch { telemetry.event("auth_signed_in", properties: ["method": "email", "outcome": "failed"]); showAuthError(error) }
  }

  func retryAuthenticatedSignIn() async {
    guard !working, !accountTransition else { return }
    signInDeferred = false
    if pendingSignIn == nil, signInSession?.isComplete == false { sheet = .adoption; return }
    guard pendingSignIn != nil else { return }
    if restoringSignIn { recoveryDue = nil; await resumeBackup(); return }
    let generation = authGeneration
    working = true; accountTransition = true; error = nil
    defer { if authGeneration == generation { working = false; accountTransition = false } }
    await continueAuthenticatedSignIn()
  }

  func continueAuthenticatedSignIn() async {
    guard var pending = pendingSignIn else { return }
    let reauthenticating = pending.needsAppleAttachment
    do {
      if pending.needsAppleAttachment {
        try await signIn(pending.identity, presentResult: false)
        guard let authorize = appleAuthorization, case .attached = try await authorize(pending.identity.token) else { throw URLError(.cannotParseResponse) }
        pending.needsAppleAttachment = false; pendingSignIn = pending; appleAuthorization = nil
      }
      if pending.receiptPending {
        pending.receiptPending = false; pendingSignIn = pending
        appleReceiptEmail = pending.identity.email.nilIfEmpty ?? email
        appleLinkedReceipt = true; sheet = .appleAdded; authSuccess += 1
        try await Task.sleep(for: .milliseconds(1200))
      }
      if reauthenticating { presentSignInResult() }
      else { try await signIn(pending.identity) }
      pendingSignIn = nil; appleAuthorization = nil; error = nil
      preferences.removeObject(forKey: "pendingAuthMethod"); preferences.removeObject(forKey: "pendingAuthLinked")
      telemetry.event("auth_signed_in", properties: ["method": pending.method, "outcome": pending.linked ? "linked" : "ok"])
    } catch {
      guard !Task.isCancelled else { return }
      telemetry.event("auth_signed_in", properties: ["method": pending.method, "outcome": "failed"])
      if (error as? EngineError) == .upgradeRequired {
        // The sign-in waits for the update; the rooms stay open meanwhile.
        signInDeferred = true; sheet = .you; requireUpdateAtSignIn(); return
      }
      if let refusal = error as? AuthRefusal, pending.needsAppleAttachment, refusal.code != "offline" {
        pendingSignIn = nil; appleAuthorization = nil; sheet = .you; showAuthError(error)
        preferences.removeObject(forKey: "pendingAuthMethod"); preferences.removeObject(forKey: "pendingAuthLinked")
        return
      }
      // You's Finish signing in section says a connection is needed; only another refusal has words of its own.
      authRetryAt = authRetryNow().addingTimeInterval(5); sheet = .you
      let offline = (error as? EngineError) == .unreachable || (error as? AuthRefusal)?.code == "offline" || error is URLError
      self.error = offline ? nil : error.localizedDescription
    }
  }

  // The pending sign-in given up: the phone stays signed out with its work, the verified session is revoked, and nothing
  // resumes at the next launch.
  func cancelSignIn() {
    guard signInPending, !working, !accountTransition, let runtime else { return }
    let account = pendingSignIn?.identity.account ?? signInSession?.account
    let method = pendingSignIn?.method ?? preferences.string(forKey: "pendingAuthMethod") ?? "email"
    cancelAuthentication()
    choose("cancel", screen: "auth_pending")
    do {
      if let account { _ = try runtime.prepareRevocation(account: account) }
      try runtime.engine.cancelSignIn()
    } catch { reportBoundary("auth_sign_in", error: error); self.error = "Couldn't cancel the sign-in. Try again."; return }
    pendingSignIn = nil; signInSession = nil; appleAuthorization = nil
    restoringSignIn = false; signInDeferred = false; updateRequiredAtSignIn = false; error = nil
    preferences.removeObject(forKey: "pendingAuthMethod"); preferences.removeObject(forKey: "pendingAuthLinked")
    clearAdoptionAnswers()
    telemetry.event("auth_signed_in", properties: ["method": method, "outcome": "cancelled"])
    Task { await runtime.revokeSignedOutSessions(force: true) }
    refresh()
  }

  func signIn(_ identity: AuthIdentity, presentResult: Bool = true) async throws {
    guard let runtime else { return }
    let generation = authGeneration
    accountTransition = true; journal.editing = false
    defer { if authGeneration == generation { accountTransition = false } }
    if !flushRooms() { throw AppFailure(message: "Save your work before signing in. Try again.") }
    if let current = account, !current.utf8.elementsEqual(identity.account.utf8) {
      try? await runtime.auth.logout(token: identity.token)
      throw AppFailure(message: "Sign in to the same account to resume backup. Your pages stay with this account.")
    }
    accountName = identity.name
    accountEmail = identity.email.nilIfEmpty ?? email
    preferences.set(accountEmail, forKey: "accountEmail:\(identity.account)")
    preferences.set(accountName, forKey: "accountName:\(identity.account)")
    signInMethods = []
    methodsGeneration += 1
    do {
      setSignInSession(try await runtime.engine.signIn(account: identity.account, token: identity.token))
    }
    catch { reportBoundary("auth_sign_in", error: error); throw error }
    runtime.updateTelemetryIdentity()
    if presentResult { presentSignInResult() }
  }

  func presentSignInResult() {
    if signInSession?.isComplete == false { sheet = .adoption }
    else { sheet = nil; welcome = false; refresh() }
  }

  func beginSignOut() async {
    guard !accountTransition, let runtime else { return }
    let generation = authGeneration
    journal.liftInk()
    signOutRefusal = nil
    accountTransition = true; signingOut = true; journal.editing = false
    defer { if authGeneration == generation { accountTransition = false; signingOut = false } }
    choose("sign_out", screen: "you")
    guard flushRooms() else { await refuseSignOut(error ?? Self.signOutFailed); return }
    do {
      let session = try await runtime.engine.signOut()
      guard !Task.isCancelled else { await session.cancel(); return }
      signOutSession = session
    } catch {
      guard !Task.isCancelled else { return }
      reportBoundary("auth_sign_out", error: error)
      await refuseSignOut(Self.signOutFailed)
    }
  }

  func finishSignOut(_ choice: SignOutChoice) async {
    guard !accountTransition, var session = signOutSession, let runtime else { return }
    accountTransition = true; signingOut = true; journal.editing = false
    defer { accountTransition = false; signingOut = false }
    let changed = "Something changed while you chose. Sign out again."
    var revocation: String?
    do {
      if journal.dirty {
        guard flushRooms() else { await refuseSignOut(error ?? Self.signOutFailed); return }
        await session.cancel()
        guard choice == .keep else { await refuseSignOut(changed); return }
        session = try await runtime.engine.signOut(); signOutSession = session
      }
      revocation = try runtime.prepareRevocation(account: session.account)
      choose(choice == .keep ? "keep" : "discard", screen: "you")
      _ = try await session.finish(choice)
      runtime.updateTelemetryIdentity()
      telemetry.event("auth_signed_out", properties: ["outcome": "ok"])
      signOutSession = nil; signInSession = nil
      preferences.removeObject(forKey: "accountName:\(session.account)"); preferences.removeObject(forKey: "accountEmail:\(session.account)")
      journal.liftInk()
      sheet = nil; account = nil; journal.document = PageDocument(); journal.dirty = false; journal.editing = false; error = nil
      appleTicket = nil; signInMethods = []; accountEmail = ""; accountName = ""; appleLinkedReceipt = false
      keepDismissed = false; welcome = true; preferences.set(true, forKey: "roomWelcomeRequired"); preferences.removeObject(forKey: "lastRoom"); clearAdoptionAnswers(); refresh()
      preferences.set(false, forKey: "keepDismissed")
      Task { await runtime.revokeSignedOutSessions(force: true) }
    } catch EngineError.signOutChanged {
      if let revocation { try? runtime.revocations.delete(for: revocation) }
      await refuseSignOut(changed)
    } catch {
      reportBoundary("auth_sign_out", error: error); if let revocation { try? runtime.revocations.delete(for: revocation) }
      await refuseSignOut(Self.signOutFailed)
    }
  }

  // A sign-out that could not begin, or an answer it could not carry out, ends the held sign-out and leaves the account
  // signed in; its reason waits under Sign out, never in the sign-in steps' error.
  func refuseSignOut(_ reason: String) async {
    await signOutSession?.cancel(); signOutSession = nil; signOutRefusal = reason; error = nil
    telemetry.event("auth_signed_out", properties: ["outcome": "refused"])
  }

  func authenticateApple(_ authorize: @escaping (SessionToken?) async throws -> AppleAuthResponse) async {
    guard !working, pendingSignIn == nil else { return }
    let attaching = appleSessionToken != nil
    appleTicket = nil; appleAuthorization = nil; appleLinkedReceipt = false
    if sheet == .keep || sheet == .you { appleOrigin = sheet ?? .keep }
    let generation = authGeneration
    working = true; accountTransition = true; journal.editing = false; error = nil
    defer { if authGeneration == generation { working = false; accountTransition = false } }
    telemetry.event("auth_sign_in_started", properties: ["method": "apple"])
    do {
      let response = try await authorize(appleSessionToken)
      try Task.checkCancellation()
      switch response {
      case .ticket(let ticket):
        guard !attaching else { throw URLError(.cannotParseResponse) }
        appleTicket = ticket; error = nil
        if account != nil { appleAuthorization = authorize; email = accountEmail; sheet = .appleAddress }
        else { sheet = .appleQuestion }
      case .signedIn(let identity):
        guard !attaching else { throw URLError(.cannotParseResponse) }
        try await acceptAuthenticatedSignIn(identity, method: "apple")
      case .attached:
        guard attaching else { throw URLError(.cannotParseResponse) }
        await loadSignInMethods()
        try Task.checkCancellation()
        guard authGeneration == generation else { return }
        authSuccess += 1; sheet = .you
        telemetry.event("auth_signed_in", properties: ["method": "apple", "outcome": "linked"])
      }
    }
    catch { telemetry.event("auth_signed_in", properties: ["method": "apple", "outcome": "failed"]); showAuthError(error, appleFlow: !attaching) }
  }

  func cancelSignOut() async {
    guard !accountTransition else { return }
    choose("cancel", screen: "you"); await signOutSession?.cancel(); signOutSession = nil; sheet = .you
  }

  // Why Sign out did nothing when the phone itself failed it; a room that cannot save says so in its own words instead.
  static let signOutFailed = "Couldn't sign out. Try again."

  // superapp-flow.md §7: one question, and when the account has not confirmed some changes it says how many.
  static func signOutMessage(unsent count: Int) -> String {
    if count == 0 { return "Your pages and log stay in your account and leave this phone." }
    let changes = count == 1 ? "1 change hasn't" : "\(count) changes haven't"
    let them = count == 1 ? "it" : "them"
    return "\(changes) been confirmed by your account yet. Keep \(them) on this phone until you sign back in, or discard \(them) from this phone. Everything else is in your account and leaves this phone."
  }

  struct SavedAdoption: Codable {
    let account: String
    let counted: [String: [String]]
    let counts: [String: [String: Int]]
    let answers: [String: String]
  }

  var currentAdoption: SignedOutDecision? {
    let decisions = signInSession?.decisions ?? []
    return Room.allCases.compactMap { room in decisions.first { $0.product == room.rawValue && adoptionAnswers[$0.product] == nil } }.first
  }

  var adoptionSummary: String {
    guard let decision = currentAdoption else { return "" }
    return Self.summary(decision.counts)
  }

  static func summary(_ counts: [String: Int]) -> String {
    let kinds = [(Page.type, "page", "pages"), (Session.type, "workout", "workouts"), (Routine.type, "routine", "routines"),
      (TrainingSet.type, "set", "sets"), (WeighIn.type, "weigh-in", "weigh-ins"), (Note.type, "note", "notes"),
      (Exercise.type, "movement", "movements"), (ExerciseName.type, "movement name", "movement names"),
      (GymPreferences.type, "training preference", "training preferences"), (Proposal.type, "proposal", "proposals")]
    return kinds.compactMap { kind in
      guard let count = counts[kind.0], count > 0 else { return nil }
      return "\(count) \(count == 1 ? kind.1 : kind.2)"
    }.joined(separator: " · ")
  }

  var adoptionAlertTitle: String { identityTaken ? "Apple ID already in use" : sheet == .discardAdoption ? "Discard \(adoptionSummary)?" : "Add to your account?" }
  var adoptionAlertMessage: String {
    if identityTaken { return AuthRefusal.identityTaken.message }
    if sheet == .discardAdoption { return "They never reached an account, and deleting them from this phone can't be undone." }
    guard let decision = currentAdoption else { return "Your choices are kept. Try Add again to finish signing in." }
    let room = decision.product == "journal" ? "Journal" : "Gym"
    let accountData = decision.product == "journal" ? "pages" : "training"
    let one = adoptionIsSingle
    return "\(room) · \(adoptionSummary) from before you signed in \(one ? "is" : "are") only on this phone, and your account already has \(accountData). Add \(one ? "it" : "them"), or discard \(one ? "it" : "them") for good."
  }

  func setSignInSession(_ session: SignInSession?) {
    signInSession = session
    adoptionAnswers = [:]
    guard let session, !session.isComplete else { clearAdoptionAnswers(); return }
    guard let data = preferences.data(forKey: "roomAdoption"),
      let saved = try? JSONDecoder().decode(SavedAdoption.self, from: data), saved.account == session.account else { return }
    for decision in session.decisions {
      if saved.counted[decision.product] == decision.counted && saved.counts[decision.product] == decision.counts,
        let value = saved.answers[decision.product], let answer = LineageAnswer(rawValue: value) {
        adoptionAnswers[decision.product] = answer
      }
    }
  }

  func clearAdoptionAnswers() {
    adoptionAnswers = [:]; preferences.removeObject(forKey: "roomAdoption")
  }

  func saveAdoptionAnswers(_ answers: [String: LineageAnswer], session: SignInSession) throws {
    let saved = SavedAdoption(account: session.account,
      counted: Dictionary(uniqueKeysWithValues: session.decisions.map { ($0.product, $0.counted) }),
      counts: Dictionary(uniqueKeysWithValues: session.decisions.map { ($0.product, $0.counts) }),
      answers: answers.mapValues(\.rawValue))
    preferences.set(try JSONEncoder().encode(saved), forKey: "roomAdoption")
    adoptionAnswers = answers
  }

  func completeAdoption(_ session: SignInSession) async throws {
    try await session.complete(adoptionAnswers)
    runtime?.updateTelemetryIdentity()
    journal.document = PageDocument(); journal.dirty = false; journal.editing = false
    signInSession = nil; clearAdoptionAnswers(); sheet = nil; welcome = false; refresh()
  }

  func adopt(_ answer: LineageAnswer) async {
    guard !accountTransition, var session = signInSession else { return }
    let generation = authGeneration
    if currentAdoption == nil {
      accountTransition = true
      defer { if authGeneration == generation { accountTransition = false } }
      guard flushRooms() else { return }
      do { try await completeAdoption(session) }
      catch EngineError.signInChanged { await recountAdoption() }
      catch { if !Task.isCancelled { reportBoundary("auth_adopt", error: error); self.error = "Couldn't finish adding your work. Try again." } }
      return
    }
    guard let decision = currentAdoption else { return }
    accountTransition = true; journal.editing = false
    defer { if authGeneration == generation { accountTransition = false } }
    do {
      if journal.dirty {
        guard flushRooms() else { return }
        if let recounted = try await runtime?.engine.resumeSignIn() {
          try Task.checkCancellation()
          session = recounted; setSignInSession(recounted)
        }
        if answer == .discard { sheet = .adoption; error = "The work changed. Choose again for the current counts."; return }
      }
      guard currentAdoption == decision else { sheet = .adoption; error = "The work changed. Choose again for the current counts."; return }
      var answers = adoptionAnswers; answers[decision.product] = answer
      try saveAdoptionAnswers(answers, session: session)
      telemetry.event("room_adoption_answered", properties: ["room": decision.product, "action": answer.rawValue])
      choose(answer == .add ? "add" : "discard", screen: "adoption")
      error = nil
      if currentAdoption != nil { sheet = .adoption; return }
      try await completeAdoption(session)
    } catch EngineError.signInChanged {
      await recountAdoption()
    } catch { if !Task.isCancelled { reportBoundary("auth_adopt", error: error); self.error = "Couldn't finish adding your work. Your choices are kept; try again." } }
  }

  func recountAdoption() async {
    do {
      let resumed = try await runtime?.engine.resumeSignIn()
      try Task.checkCancellation()
      if let resumed { setSignInSession(resumed) }
      sheet = .adoption; error = "The work changed. Choose again for the current counts."
    } catch {
      guard !Task.isCancelled else { return }
      reportBoundary("auth_adopt", error: error)
      sheet = .you
      self.error = (error as? EngineError) == .unreachable ? nil : "Couldn't refresh your choices. Your work stays on this phone."
    }
  }
}
