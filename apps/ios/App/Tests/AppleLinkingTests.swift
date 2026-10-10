import Foundation
import Testing
import UIKit
import SyncReplica
import Synchronization
@testable import Windmill

@Suite @MainActor struct AppleLinkingTests {
  func fixture(_ server: JournalModelTransport, authRetryNow: @escaping () -> Date = Date.init) throws -> AppModel {
    try LineageFlowTests().fixture(server, authRetryNow: authRetryNow)
  }

  @Test(arguments: [nil, false, true] as [Bool?])
  func confirmationDismissalRunsItsActionExactlyOnce(coordinatorAccepts: Bool?) {
    let controller = ConfirmationController()
    controller.coordinator = coordinatorAccepts.map(ConfirmationTransition.init)
    let presenter = AccountConfirmation.Presenter()
    var actions = 0
    presenter.afterDismissal(of: controller) { actions += 1 }
    #expect(actions == 0)
    #expect(controller.dismissals == (coordinatorAccepts == true ? 0 : 1))
    controller.dismissalCompletion?()
    #expect(actions == (coordinatorAccepts == true ? 0 : 1))
    controller.coordinator?.completion?(controller.coordinator!)
    #expect(actions == 1)
    controller.dismissalCompletion?()
    controller.coordinator?.completion?(controller.coordinator!)
    #expect(actions == 1)
  }

  final class ConfirmationController: UIViewController {
    var coordinator: ConfirmationTransition?
    var dismissals = 0
    var dismissalCompletion: (() -> Void)?
    override var transitionCoordinator: (any UIViewControllerTransitionCoordinator)? { coordinator }
    override func dismiss(animated flag: Bool, completion: (() -> Void)? = nil) {
      dismissals += 1; dismissalCompletion = completion
    }
  }

  final class ConfirmationTransition: NSObject, UIViewControllerTransitionCoordinator {
    typealias Completion = (any UIViewControllerTransitionCoordinatorContext) -> Void
    let accepts: Bool
    var completion: Completion?
    init(accepts: Bool) { self.accepts = accepts }
    func animate(alongsideTransition animation: Completion?, completion: Completion?) -> Bool {
      self.completion = completion; return accepts
    }
    func animateAlongsideTransition(in view: UIView?, animation: Completion?, completion: Completion?) -> Bool {
      animate(alongsideTransition: animation, completion: completion)
    }
    func notifyWhenInteractionChanges(_ handler: @escaping Completion) {}
    func notifyWhenInteractionEnds(_ handler: @escaping Completion) {}
    func viewController(forKey key: UITransitionContextViewControllerKey) -> UIViewController? { nil }
    func view(forKey key: UITransitionContextViewKey) -> UIView? { nil }
    let isAnimated = true, initiallyInteractive = false, isInterruptible = true, isInteractive = false, isCancelled = false
    let presentationStyle = UIModalPresentationStyle.overFullScreen
    let transitionDuration: TimeInterval = 0
    let percentComplete: CGFloat = 1, completionVelocity: CGFloat = 0
    let completionCurve = UIView.AnimationCurve.easeInOut
    let containerView = UIView(), targetTransform = CGAffineTransform.identity
  }

  @Test func ticketCreatesNothingAndDismissalPreservesLocalWriting() async throws {
    let server = JournalModelTransport(), model = try fixture(server)
    model.journal.type("Local page"); model.journal.done(); model.sheet = .keep
    let before = server.state.withLock { $0.server.state }
    await model.authenticateApple { [auth = model.runtime!.auth] token in try auth.authorizeFakeApple(token: token) }
    #expect(model.sheet == .appleQuestion && model.account == nil && model.signInSession == nil)
    #expect(model.appleTicket != nil && model.journal.document.body == "Local page")
    #expect(server.state.withLock { $0.emails.isEmpty && $0.sessions.isEmpty && $0.appleDoors.isEmpty && $0.server.state == before })
    let ticket = try #require(model.appleTicket)
    #expect(!server.state.withLock { $0.tickets.keys.contains(ticket.secret) })
    model.closeAppleStep()
    #expect(model.sheet == .keep && model.appleTicket == nil && model.journal.document.body == "Local page")
    await model.authenticateApple { [auth = model.runtime!.auth] token in try auth.authorizeFakeApple(token: token) }
    #expect(model.appleTicket?.secret != ticket.secret)
    model.dismissSheet()
    #expect(model.appleTicket == nil)
  }

  @Test func createConsumesTicketAndAdoptsIntoEmptyAccount() async throws {
    let server = JournalModelTransport(), model = try fixture(server)
    model.journal.type("Local page"); model.journal.done(); model.sheet = .keep
    await model.authenticateApple { [auth = model.runtime!.auth] token in try auth.authorizeFakeApple(token: token) }
    let ticket = try #require(model.appleTicket)
    await model.createAppleAccount()
    #expect(model.account == "model-apple@example.com" && model.sheet == nil && model.appleTicket == nil)
    #expect(model.journal.document.body == "Local page")
    #expect(throws: AuthRefusal.expired) { try server.createApple(ticket: ticket) }
  }

  @Test(arguments: [true, false]) func linkingUsesReceiptThenExistingAdoption(add: Bool) async throws {
    let server = JournalModelTransport(), existing = try fixture(server)
    try await existing.signIn(server.identity(email: "sam@example.com"))
    existing.journal.type("Account page"); existing.journal.done(); await existing.beginSignOut(); await existing.finishSignOut(.keep)
    let model = try fixture(server)
    model.journal.type("Local page"); model.journal.done(); model.sheet = .keep
    await model.authenticateApple { [auth = model.runtime!.auth] token in try auth.authorizeFakeApple(token: token) }
    model.useAppleAccount(); model.email = "sam@example.com"; await model.sendCode(); model.code = "482913"
    let verification = Task { await model.verifyCode() }
    for _ in 0..<100 where model.sheet != .appleAdded { try await Task.sleep(for: .milliseconds(5)) }
    #expect(model.sheet == .appleAdded && model.account == nil && model.signInSession == nil)
    #expect(model.appleReceiptEmail == "sam@example.com" && model.appleTicket == nil && model.editorReadOnly)
    await verification.value
    #expect(model.sheet == .adoption && model.adoptionCount == 1)
    #expect(model.adoptionAlertMessage == "Journal · 1 page from before you signed in is only on this phone, and your account already has pages. Add it, or discard it for good.")
    if !add {
      model.sheet = .discardAdoption
      #expect(model.adoptionAlertTitle == "Discard 1 page?")
    }
    await model.adopt(add ? .add : .discard)
    #expect(model.account == "model-sam@example.com" && model.sheet == nil)
    #expect(server.state.withLock { $0.appleDoors["fake-apple"] == "model-sam@example.com" })
  }

  @Test func refusalOrderNoAccountDoesNotCreateAndKeepsTicket() async throws {
    let server = JournalModelTransport()
    guard case .ticket(let ticket) = try server.apple(token: nil) else { Issue.record("Expected ticket"); return }
    try server.requestCode(email: "sam@icloud.com")
    #expect(throws: AuthRefusal.wrongCode) { try server.verifyCode(email: "sam@icloud.com", code: "123456", ticket: ticket) }
    #expect(server.state.withLock { $0.codes.contains("sam@icloud.com") && $0.emails.isEmpty })
    do { _ = try server.verifyCode(email: "sam@icloud.com", code: "482913", ticket: ticket); Issue.record("Created account") }
    catch let failure as AuthRefusal { #expect(failure.code == "no-account") }
    #expect(server.state.withLock { !$0.codes.contains("sam@icloud.com") && $0.emails.isEmpty && $0.sessions.isEmpty && $0.tickets.count == 1 })
    #expect(throws: AuthRefusal.wrongCode) { try server.verifyCode(email: "sam@icloud.com", code: "482913", ticket: ticket) }
    #expect(try server.createApple(ticket: ticket).email == "apple@example.com")
  }

  @Test func expiredTicketIsCheckedBeforeCodeAndIsNotReportable() async throws {
    let server = JournalModelTransport(), recorder = TelemetryRecorder()
    let auth = NativeAuth(baseURL: nil, fake: server, telemetry: recorder)
    guard case .ticket(let ticket) = try auth.authorizeFakeApple() else { Issue.record("Expected ticket"); return }
    try server.requestCode(email: "sam@example.com")
    server.state.withLock { state in
      let digest = server.digest(ticket.secret), value = state.tickets[digest]!
      state.tickets[digest] = JournalModelTransport.Ticket(subject: value.subject, email: value.email, expires: Date().addingTimeInterval(-1))
    }
    do { _ = try await auth.verifyCode(email: "sam@example.com", code: "482913", appleTicket: ticket); Issue.record("Expired ticket accepted") }
    catch let failure as AuthRefusal { #expect(failure.code == "apple-ticket-expired") }
    #expect(server.state.withLock { $0.codes.contains("sam@example.com") && $0.emails.isEmpty })
    #expect(recorder.entries.withLock { $0.count == 1 && $0[0].name == "api_request_failed" && $0[0].properties["status"] == "410" })
    #expect(throws: AuthRefusal.expired) { try server.createApple(ticket: AppleTicket(secret: "unknown", expiresAt: .distantFuture)) }
  }

  @Test func offlineAndLocalExpiryRetainPagesAndNeverSignIn() async throws {
    let server = JournalModelTransport(), model = try fixture(server)
    model.journal.type("Local"); model.journal.done(); model.sheet = .keep
    await model.authenticateApple { _ in throw URLError(.notConnectedToInternet) }
    #expect(model.error == AuthRefusal.offline.message && model.sheet == .keep && model.appleTicket == nil && model.account == nil)
    await model.authenticateApple { [auth = model.runtime!.auth] token in try auth.authorizeFakeApple(token: token) }
    server.state.withLock { $0.authOnline = false }
    await model.createAppleAccount()
    #expect(model.error == AuthRefusal.offline.message && model.sheet == .appleQuestion && model.account == nil)
    let ticket = try #require(model.appleTicket)
    model.appleTicket = AppleTicket(secret: ticket.secret, expiresAt: .distantPast)
    #expect(model.expireAppleTicket())
    #expect(model.sheet == .appleExpired && model.appleTicket == nil && model.journal.document.body == "Local")
  }

  @Test(arguments: [false, true]) func signedInAttachMovesOnlyEmptyOwner(withData: Bool) async throws {
    let server = JournalModelTransport(), caller = server.identity(email: "sam@example.com"), owner = server.identity(email: "other@example.com")
    server.state.withLock {
      $0.appleDoors["fake-apple"] = owner.account
      if withData { $0.dataAccounts.insert(owner.account) }
    }
    if withData {
      #expect(throws: AuthRefusal.identityTaken) { try server.apple(token: caller.token) }
      #expect(server.state.withLock { $0.sessions[owner.token.value] == owner.account && $0.appleDoors["fake-apple"] == owner.account })
    } else {
      guard case .attached = try server.apple(token: caller.token) else { Issue.record("Expected attach"); return }
      #expect(server.state.withLock { $0.sessions[owner.token.value] == nil && $0.emails["other@example.com"] == nil && $0.appleDoors["fake-apple"] == caller.account })
      #expect(try server.signInMethods(token: caller.token) == [SignInMethod(kind: "email", email: "sam@example.com"), SignInMethod(kind: "apple", email: "apple@example.com")])
      try server.removeApple(token: caller.token)
      #expect(try server.signInMethods(token: caller.token) == [SignInMethod(kind: "email", email: "sam@example.com")])
      #expect(server.state.withLock { $0.sessions[caller.token.value] == caller.account })
    }
  }

  @Test func raceCannotMoveAnAlreadyBoundSubjectDuringCodeVerification() throws {
    let server = JournalModelTransport()
    guard case .ticket(let ticket) = try server.apple(token: nil) else { Issue.record("Expected ticket"); return }
    _ = server.identity(email: "sam@example.com"); let other = server.identity(email: "other@example.com")
    server.state.withLock { $0.appleDoors["fake-apple"] = other.account }
    try server.requestCode(email: "sam@example.com")
    #expect(throws: AuthRefusal.identityTaken) { try server.verifyCode(email: "sam@example.com", code: "482913", ticket: ticket) }
    #expect(server.state.withLock { $0.appleDoors["fake-apple"] == other.account && $0.tickets.count == 1 })
  }

  @Test func subjectAndVerifiedEmailMatchesBypassQuestion() throws {
    let server = JournalModelTransport(), existing = server.identity(email: "apple@example.com")
    guard case .signedIn(let emailMatch) = try server.apple(token: nil) else { Issue.record("Expected sign-in"); return }
    #expect(emailMatch.account == existing.account)
    server.state.withLock { $0.appleEmail = "different@privaterelay.appleid.com" }
    guard case .signedIn(let subjectMatch) = try server.apple(token: nil) else { Issue.record("Expected sign-in"); return }
    #expect(subjectMatch.account == existing.account && server.state.withLock { $0.tickets.isEmpty })
  }

  @Test func pausedAccountSkipsQuestionWithItsAddressAndKeepsReplica() async throws {
    let server = JournalModelTransport(), model = try fixture(server)
    let identity = server.identity(email: "sam@example.com")
    try await model.signIn(identity); model.journal.type("Account writing"); model.journal.done()
    let runtime = try #require(model.runtime), replica = try runtime.store.read { try $0.device().activeReplica.meta.replica }
    try await runtime.auth.logout(token: identity.token); await runtime.engine.start()
    #expect(model.authPaused)
    model.sheet = .you
    await model.authenticateApple { token in try runtime.auth.authorizeFakeApple(token: token) }
    #expect(model.sheet == .appleAddress && model.email == "sam@example.com")
    model.email = "other@example.com"; await model.sendCode()
    #expect(model.sheet == .appleAddress && model.error != nil)
    model.email = "sam@example.com"; await model.sendCode(); model.code = "482913"; await model.verifyCode()
    #expect(model.sheet == nil && model.account == identity.account)
    #expect(try runtime.store.read { try $0.device().activeReplica.meta.replica } == replica)
  }

  @Test func telemetryAllowsBoardsAndLinkedButRejectsSecrets() throws {
    for screen in ["23a", "23b", "23c", "24a", "24b", "24c", "24d"] {
      #expect(TelemetryPrivacy.properties(["screen": screen, "ticket": "secret", "email": "private", "subject": "secret", "token": "secret"]) == ["screen": .label(screen)])
    }
    #expect(TelemetryPrivacy.properties(["method": "apple", "outcome": "linked"]) == ["method": .label("apple"), "outcome": .label("linked")])
  }

  @Test(arguments: [false, true]) func authenticatedHelloFailureRetriesWithoutConsumedTicket(link: Bool) async throws {
    let server = JournalModelTransport()
    if link {
      let existing = try fixture(server)
      try await existing.signIn(server.identity(email: "sam@example.com"))
      existing.journal.type("Account page"); existing.journal.done(); await existing.beginSignOut(); await existing.finishSignOut(.keep)
    }
    let now = Date(timeIntervalSince1970: 1_790_424_000)
    let model = try fixture(server, authRetryNow: { now })
    model.journal.type("Local page"); model.journal.done(); model.sheet = .keep
    await model.authenticateApple { [auth = model.runtime!.auth] token in try auth.authorizeFakeApple(token: token) }
    let ticket = try #require(model.appleTicket)
    server.state.withLock { $0.helloOnline = false }
    if link {
      model.useAppleAccount(); model.email = "sam@example.com"; await model.sendCode(); model.code = "482913"; await model.verifyCode()
    } else { await model.createAppleAccount() }
    #expect(model.sheet == .authPending && model.account == nil && model.appleTicket == nil && model.pendingSignIn != nil && model.editorReadOnly)
    #expect(model.authRetryAt == now.addingTimeInterval(5))
    #expect(model.journal.document.body == "Local page")
    #expect(throws: AuthRefusal.expired) { try server.createApple(ticket: ticket) }
    let sessions = server.state.withLock { $0.sessions }
    await model.retryAuthenticatedSignIn()
    #expect(model.sheet == .authPending && server.state.withLock { $0.sessions == sessions })
    server.state.withLock { $0.helloOnline = true; $0.authOnline = false }
    await model.retryAuthenticatedSignIn()
    #expect(model.pendingSignIn == nil && server.state.withLock { $0.sessions == sessions })
    if link {
      #expect(model.sheet == .adoption && model.adoptionCount == 1)
      await model.adopt(.add)
    }
    #expect(model.account == (link ? "model-sam@example.com" : "model-apple@example.com") && model.sheet == nil)
    await model.runtime?.engine.start(); try await AppScenario.backedUp(model)
    #expect(model.journal.document.body == (link ? "Account page\n\nLocal page" : "Local page"))
  }

  @Test func pendingEngineSignInRestoresAndTimerRecoversWithoutAuth() async throws {
    let server = JournalModelTransport(), model = try fixture(server)
    model.journal.type("Survives the failed hello"); model.journal.done(); model.sheet = .keep
    await model.authenticateApple { [auth = model.runtime!.auth] token in try auth.authorizeFakeApple(token: token) }
    server.state.withLock { $0.helloOnline = false }
    await model.createAppleAccount()
    let runtime = try #require(model.runtime), sessions = server.state.withLock { $0.sessions }
    let recorder = TelemetryRecorder()
    let restored = try AppModel(runner: runtime.runner, preferences: model.preferences, runtime: runtime, telemetry: recorder)
    #expect(restored.pendingSignIn != nil && restored.sheet == .authPending && restored.appleTicket == nil)
    server.state.withLock { $0.helloOnline = true; $0.authOnline = false }
    await restored.start()
    defer { restored.timerTask?.cancel(); restored.observationTask?.cancel() }
    for _ in 0..<200 where restored.pendingSignIn != nil { try await Task.sleep(for: .milliseconds(10)) }
    #expect(restored.pendingSignIn == nil && restored.account == "model-apple@example.com" && restored.sheet == nil)
    #expect(restored.journal.document.body == "Survives the failed hello" && server.state.withLock { $0.sessions == sessions })
    #expect(recorder.entries.withLock { $0.filter { $0.name == "auth_signed_in" }.map(\.properties) } == [["method": "apple", "outcome": "ok"]])
    #expect(restored.preferences.string(forKey: "pendingAuthMethod") == nil && !restored.restoringSignIn)
  }

  @Test func lostRemovalResponseThen404ClearsStaleAppleRow() async throws {
    let server = JournalModelTransport(), model = try fixture(server)
    try await model.signIn(server.identity(email: "sam@example.com"))
    model.journal.type("Account page"); model.journal.done(); model.sheet = .you
    await model.authenticateApple { [auth = model.runtime!.auth] token in try auth.authorizeFakeApple(token: token) }
    #expect(model.signInMethods.contains { $0.kind == "apple" })
    server.state.withLock { $0.loseRemovalResponse = true }
    await model.removeApple()
    #expect(model.error != nil && model.signInMethods.contains { $0.kind == "apple" })
    #expect(server.state.withLock { $0.appleDoors.isEmpty })
    await model.removeApple()
    #expect(model.signInMethods == [SignInMethod(kind: "email", email: "sam@example.com")] && model.error == nil)
    #expect(model.account == "model-sam@example.com" && model.journal.document.body == "Account page")
  }
}
