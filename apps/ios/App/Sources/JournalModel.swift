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
  var invitationShown = false
  var keepInvitationShown = false
  let preferences: UserDefaults
  let runtime: AppRuntime?
  var room: JournalRoom?
  var document = PageDocument()
  var editing = false
  var dirty = false
  var readFailed = false
  var error: String?
  var inkVisible = false
  private var firstOpenEligible: Bool
  var sheet: Sheet?
  var account: String?
  var keptWork = false
  var accountName = "You"
  var firstKept = false
  var keepDismissed = false
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
  var syncStarted = false
  var restoringSignIn = false
  var signInSession: SignInSession?
  var signOutSession: SignOutSession?
  var welcome: Bool
  @ObservationIgnored var saveTask: Task<Void, Never>?
  @ObservationIgnored var observationTask: Task<Void, Never>?
  @ObservationIgnored var timerTask: Task<Void, Never>?
  @ObservationIgnored var recoveryDue: ContinuousClock.Instant?
  @ObservationIgnored var recoveryDelayMs = Constants.backoffBaseMs
  var editorDay: LocalDay

  enum Sheet: String, Identifiable {
    case keep, address, code, you, adoption, discardAdoption, signOut
    case appleQuestion = "23a", appleAddress = "23b", appleAdded = "23c", appleNoAccount, appleExpired, authPending
    var id: String { rawValue }
    var telemetryName: String {
      switch self {
      case .discardAdoption: "discard_adoption"
      case .signOut: "sign_out"
      case .appleNoAccount: "apple_no_account"
      case .appleExpired: "apple_expired"
      case .authPending: "auth_pending"
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

  init(runner: ActionRunner, preferences: UserDefaults, runtime: AppRuntime? = nil, telemetry: any Telemetry = NoopTelemetry()) throws {
    self.telemetry = telemetry
    self.runner = runner; self.preferences = preferences; self.runtime = runtime
    editorDay = try runner.moment().today
    if let draft = try runner.read(Journal.scope, { try $0.device(EditorDraft.key).map(EditorDraft.init(json:)) }) {
      editorDay = draft.day; document = draft.document; dirty = true
    }
    let firstOpen = !preferences.bool(forKey: "journalOpened")
    firstOpenEligible = firstOpen
    welcome = firstOpen
    keepDismissed = preferences.bool(forKey: "keepDismissed")
    refresh()
    if let account { accountEmail = preferences.string(forKey: "accountEmail:\(account)") ?? "" }
    if account != nil || room?.stance == .holding { welcome = false }
    if let runtime, let pending = try runtime.store.read({ try $0.device().meta.pendingSignIn }), let token = runtime.tokens.token(for: pending) {
      let identity = AuthIdentity(account: pending, token: token, name: accountName, email: preferences.string(forKey: "accountEmail:\(pending)") ?? "")
      pendingSignIn = PendingSignIn(identity: identity, method: preferences.string(forKey: "pendingAuthMethod") ?? "email", linked: preferences.bool(forKey: "pendingAuthLinked"), needsAppleAttachment: false, receiptPending: false)
      restoringSignIn = true
      sheet = .authPending; welcome = false
    }
  }

  var today: LocalDay { (try? runner.moment().today) ?? editorDay }
  var words: Int { document.body.split(whereSeparator: \.isWhitespace).filter { $0.contains { $0.isLetter || $0.isNumber } }.count }
  var showPrivacy: Bool { room?.firstRunKnown == true && room?.state.privacyLine == "pending" }
  var showPlaceholder: Bool { room?.firstRunKnown == true && room?.state.placeholder == "pending" && document.body.isEmpty }
  var scalesDue: Bool { !editing && room?.scaleInvitationDue == true }
  var keepDue: Bool { !editing && account == nil && room?.keepDue == true && !keepDismissed && !scalesDue }
  var canSignIn: Bool { runtime?.settings.baseURL != nil || runtime?.settings.modelServer == true }
  var authPaused: Bool { runtime?.engine.status.authPaused == true }
  var compactAccountSheet: Bool { [.keep, .appleQuestion, .appleNoAccount, .appleExpired].contains(sheet) }
  var editorReadOnly: Bool { working || accountTransition || pendingSignIn != nil || signInSession?.isComplete == false || signOutSession != nil }
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
    choose("open_journal", screen: "welcome")
    welcome = false; preferences.set(true, forKey: "journalOpened")
    refresh(); automaticallyShowInk()
  }

  func automaticallyShowInk() {
    guard firstOpenEligible, room?.stance == .empty, room?.firstRunKnown == true, room?.days.isEmpty == true,
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

  func start() async {
    guard let runtime else { return }
    let restoring = restoringSignIn
    if observationTask == nil {
      let events = runtime.engine.events()
      observationTask = Task { [weak self] in
        for await _ in events { self?.refresh() }
      }
    }
    await runtime.revokeSignedOutSessions(force: true)
    await resumeBackup()
    if timerTask == nil {
      timerTask = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: .milliseconds(350))
          guard let self, !Task.isCancelled else { return }
          self.refresh()
          self.expireAppleTicket()
          if !self.restoringSignIn, self.pendingSignIn != nil, !self.working, !self.accountTransition, self.authRetryAt <= Date() { await self.retryAuthenticatedSignIn() }
          if !self.syncStarted && !self.dirty { await self.resumeBackup() }
          await self.runtime?.revokeSignedOutSessions()
        }
      }
    }
    guard !Task.isCancelled else { return }
    refresh()
    runtime.updateTelemetryIdentity()
    if !syncStarted {
      let outcome = dirty ? (account == nil ? "anonymous" : authPaused ? "paused" : "signed_in") : "failed"
      telemetry.event("auth_restore", properties: ["outcome": outcome])
    }
    if !welcome && !restoring { automaticallyShowInk() }
  }

  func resumeBackup() async {
    guard !Task.isCancelled, !syncStarted, !accountTransition, !working,
          pendingSignIn == nil || restoringSignIn, let runtime else { return }
    if let recoveryDue, recoveryDue > ContinuousClock.now { return }
    accountTransition = true; editing = false
    defer { accountTransition = false }
    if dirty, !save() { return }
    await runtime.engine.start()
    guard !Task.isCancelled else { return }
    do {
      let resumed = try await runtime.engine.resumeSignIn()
      try Task.checkCancellation()
      signInSession = resumed
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
      if hasHistory || !welcome, !preferences.bool(forKey: "journalOpened") { preferences.set(true, forKey: "journalOpened") }
      if readFailed { error = nil; readFailed = false }
      if let runtime { account = try runtime.account(); keptWork = try runtime.hasKeptWork() }
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

  func keep() { choose("keep", screen: "journal"); done(); liftInk(); keepSheetPresented = true; sheet = .keep }
  func closeKeep() { choose("close", screen: "keep"); sheet = nil; dismissKeep() }
  func dismissKeep() {
    guard room?.keepDue == true else { return }
    keepDismissed = true; preferences.set(true, forKey: "keepDismissed")
  }
  func dismissSheet() {
    if keepSheetPresented { dismissKeep() }
    keepSheetPresented = false
    appleTicket = nil; appleLinkedReceipt = false; error = nil
    if pendingSignIn == nil { appleAuthorization = nil }
  }

  var appleSessionToken: SessionToken? {
    guard !authPaused, let account else { return nil }
    return runtime?.tokens.token(for: account)
  }

  func useAppleAccount() {
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
    if let refusal = failure as? AuthRefusal {
      if refusal.code == "apple-ticket-expired" { appleTicket = nil; appleAuthorization = nil; error = nil; sheet = .appleExpired; return }
      if refusal.code == "no-account" { error = nil; sheet = .appleNoAccount; return }
      if refusal.code == "identity-taken" { identityTaken = true; screenViewed("24d"); error = nil; return }
    }
    let offline = (failure as? AuthRefusal)?.code == "offline" || (failure as? URLError).map {
      [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost].contains($0.code)
    } == true
    error = offline && (appleFlow || appleTicket != nil) ? AuthRefusal.offline.message : failure.localizedDescription
  }

  func createAppleAccount() async {
    guard !working, pendingSignIn == nil, !expireAppleTicket(), let ticket = appleTicket, let auth = runtime?.auth else { return }
    guard account == nil else { error = "Sign in to the same account to resume backup. Your pages stay with this account."; return }
    choose("create_account", screen: sheet == .appleNoAccount ? "apple_no_account" : "23a"); authSelection += 1
    working = true; accountTransition = true; error = nil
    defer { working = false; accountTransition = false }
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
      screenViewed(methods.contains(where: { $0.kind == "apple" }) ? "24b" : "24a")
    } catch { if account == current, methodsGeneration == generation { showAuthError(error) } }
  }

  func removeApple() async {
    guard !working, let token = appleSessionToken, let auth = runtime?.auth else { return }
    choose("remove_apple", screen: "24c")
    methodsGeneration += 1
    working = true; error = nil
    defer { working = false }
    do { try await auth.removeApple(token: token); signInMethods.removeAll { $0.kind == "apple" }; screenViewed("24a") }
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
    working = true; error = nil
    defer { working = false }
    do {
      try await auth.requestCode(email: email)
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
    working = true; error = nil
    authBusyIndicator = false
    let indicator = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(800))
      if !Task.isCancelled { self?.authBusyIndicator = true }
    }
    defer { indicator.cancel(); authBusyIndicator = false; working = false }
    accountTransition = true; editing = false
    defer { accountTransition = false }
    let method = appleTicket == nil ? "email" : "apple"
    telemetry.event("auth_sign_in_started", properties: ["method": method])
    do {
      let reauthenticatingApple = appleTicket != nil && account != nil
      let identity = try await auth.verifyCode(email: email, code: code, appleTicket: reauthenticatingApple ? nil : appleTicket)
      try await acceptAuthenticatedSignIn(identity, method: method, attachApple: reauthenticatingApple)
    }
    catch { telemetry.event("auth_signed_in", properties: ["method": method, "outcome": "failed"]); showAuthError(error) }
  }

  func acceptAuthenticatedSignIn(_ identity: AuthIdentity, method: String, attachApple: Bool = false) async throws {
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

  func retryAuthenticatedSignIn() async {
    guard !working, !accountTransition, pendingSignIn != nil else { return }
    if restoringSignIn { recoveryDue = nil; await resumeBackup(); return }
    working = true; accountTransition = true; error = nil
    defer { working = false; accountTransition = false }
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
      telemetry.event("auth_signed_in", properties: ["method": pending.method, "outcome": "failed"])
      if let refusal = error as? AuthRefusal, pending.needsAppleAttachment, refusal.code != "offline" {
        pendingSignIn = nil; appleAuthorization = nil; sheet = .you; showAuthError(error)
        preferences.removeObject(forKey: "pendingAuthMethod"); preferences.removeObject(forKey: "pendingAuthLinked")
        return
      }
      authRetryAt = Date().addingTimeInterval(5); sheet = .authPending
      if (error as? EngineError) == .unreachable || (error as? AuthRefusal)?.code == "offline" || error is URLError {
        self.error = "Can't reach windmill.works. Your pages are safe on this phone. Try again to finish signing in."
      } else { self.error = error.localizedDescription }
    }
  }

  func signIn(_ identity: AuthIdentity, presentResult: Bool = true) async throws {
    guard let runtime else { return }
    accountTransition = true; editing = false
    defer { accountTransition = false }
    if dirty, !save() { throw AppFailure(message: "Save your writing before signing in. Try again.") }
    if let current = account, !current.utf8.elementsEqual(identity.account.utf8) {
      try? await runtime.auth.logout(token: identity.token)
      throw AppFailure(message: "Sign in to the same account to resume backup. Your pages stay with this account.")
    }
    accountName = identity.name
    accountEmail = identity.email.nilIfEmpty ?? email
    preferences.set(accountEmail, forKey: "accountEmail:\(identity.account)")
    signInMethods = []
    methodsGeneration += 1
    do { signInSession = try await runtime.engine.signIn(account: identity.account, token: identity.token) }
    catch { reportBoundary("auth_sign_in", error: error); throw error }
    runtime.updateTelemetryIdentity()
    if presentResult { presentSignInResult() }
  }

  func presentSignInResult() {
    if signInSession?.isComplete == false { sheet = .adoption }
    else { sheet = nil; welcome = false; refresh() }
  }

  var adoptionCount: Int { signInSession?.decisions.first(where: { $0.product == "journal" })?.counts["page"] ?? 0 }

  func adopt(_ answer: LineageAnswer) async {
    guard !accountTransition, var session = signInSession else { return }
    accountTransition = true; editing = false
    defer { accountTransition = false }
    do {
      if dirty {
        guard save() else { return }
        if let recounted = try await runtime?.engine.resumeSignIn() { session = recounted; signInSession = recounted }
        if answer == .discard { sheet = .adoption; error = "The pages changed. Choose again for the current pages."; return }
      }
      choose(answer == .add ? "add" : "discard", screen: "adoption")
      try await session.complete(Dictionary(uniqueKeysWithValues: session.decisions.map { ($0.product, answer) }))
      runtime?.updateTelemetryIdentity()
      document = PageDocument(); dirty = false; editing = false; signInSession = nil; sheet = nil; welcome = false; refresh()
    } catch EngineError.signInChanged {
      signInSession = try? await runtime?.engine.resumeSignIn(); error = "The pages changed. Choose again for the current pages."
    } catch { reportBoundary("auth_adopt", error: error); self.error = error.localizedDescription }
  }

  func beginSignOut() async {
    guard !accountTransition, let runtime else { return }
    accountTransition = true; editing = false
    defer { accountTransition = false }
    if dirty, !save() { return }
    choose("sign_out", screen: "you")
    do { signOutSession = try await runtime.engine.signOut(); sheet = .signOut }
    catch { reportBoundary("auth_sign_out", error: error); self.error = error.localizedDescription }
  }

  func finishSignOut(_ choice: SignOutChoice) async {
    guard !accountTransition, var session = signOutSession, let runtime else { return }
    accountTransition = true; editing = false
    defer { accountTransition = false }
    var revocation: String?
    do {
      if dirty {
        guard save() else { return }
        await session.cancel()
        session = try await runtime.engine.signOut(); signOutSession = session
        if choice == .discard { error = "Pending writing changed. Review the new count."; return }
      }
      revocation = try runtime.prepareRevocation(account: session.account)
      choose(choice == .keep ? "keep" : "discard", screen: "sign_out")
      _ = try await session.finish(choice)
      runtime.updateTelemetryIdentity()
      telemetry.event("auth_signed_out", properties: ["outcome": "ok"])
      signOutSession = nil; signInSession = nil
      sheet = nil; account = nil; document = PageDocument(); dirty = false; editing = false; error = nil
      appleTicket = nil; signInMethods = []; accountEmail = ""; appleLinkedReceipt = false
      inkVisible = false; keepDismissed = false; welcome = true; refresh()
      preferences.set(false, forKey: "keepDismissed")
      await runtime.revokeSignedOutSessions(force: true)
    } catch EngineError.signOutChanged {
      if let revocation { try? runtime.revocations.delete(for: revocation) }
      await session.cancel(); signOutSession = try? await runtime.engine.signOut(); error = "Pending writing changed. Review the new count."
    } catch { reportBoundary("auth_sign_out", error: error); if let revocation { try? runtime.revocations.delete(for: revocation) }; self.error = error.localizedDescription }
  }

  func authenticateApple(_ authorize: @escaping (SessionToken?) async throws -> AppleAuthResponse) async {
    guard !working, pendingSignIn == nil else { return }
    let attaching = appleSessionToken != nil
    appleTicket = nil; appleAuthorization = nil; appleLinkedReceipt = false
    if sheet == .keep || sheet == .you { appleOrigin = sheet ?? .keep }
    working = true; accountTransition = true; editing = false; error = nil
    defer { working = false; accountTransition = false }
    telemetry.event("auth_sign_in_started", properties: ["method": "apple"])
    do {
      switch try await authorize(appleSessionToken) {
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
        await loadSignInMethods(); authSuccess += 1; sheet = .you
        telemetry.event("auth_signed_in", properties: ["method": "apple", "outcome": "linked"])
      }
    }
    catch { telemetry.event("auth_signed_in", properties: ["method": "apple", "outcome": "failed"]); showAuthError(error, appleFlow: !attaching) }
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
    guard !welcome, !editing else { return }
    if scalesDue && !invitationShown { invitationShown = true; telemetry.event("scale_invitation_shown") }
    if keepDue && !keepInvitationShown { keepInvitationShown = true; screenViewed("keep") }
  }

  func cancelSignOut() async { choose("cancel", screen: "sign_out"); await signOutSession?.cancel(); signOutSession = nil; sheet = .you }
}
