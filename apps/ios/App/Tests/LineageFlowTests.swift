import Foundation
import Testing
import DomainKit
import JournalDomain
import SyncCore
import SyncAPI
import SyncReplica
import SyncEngine
import SyncSchema
import SyncStore
import SyncTesting
import Synchronization
@testable import Windmill

@Suite @MainActor struct LineageFlowTests {
  func fixture(_ transport: JournalModelTransport, syncTransport: (any SyncTransport)? = nil, tokens: InMemoryTokenStore = InMemoryTokenStore(), revocations: InMemoryTokenStore = InMemoryTokenStore(), auth: NativeAuth? = nil) throws -> JournalModel {
    let store = try Store.inMemory(registry: SyncSchema.registry, commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios), store: store,
                                transport: syncTransport ?? transport, tokens: tokens, forkGuard: InMemoryForkGuardStore(),
                                clock: .system, random: SeededRandomSource(seed: 17), connectivity: SwitchedConnectivity())
    let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    let runtime = AppRuntime(settings: AppSettings(arguments: ["app", "-model-server"]), store: store, engine: engine, auth: auth ?? NativeAuth(baseURL: nil, fake: transport), runner: runner, tokens: tokens, revocations: revocations)
    return try JournalModel(runner: runner, preferences: UserDefaults(suiteName: UUID().uuidString)!, runtime: runtime)
  }

  @Test func emptyAccountAdoptsSilently() async throws {
    let transport = JournalModelTransport(), model = try fixture(transport)
    model.type("Local"); model.save(); model.done(); model.dismissScales()
    try await model.signIn(transport.identity(email: "empty@example.com"))
    #expect(model.account == "model-empty@example.com" && model.sheet == nil)
    #expect(model.document.body == "Local" && !model.keepDue && model.backup != "backed up")
  }

  @Test(arguments: [true, false]) func occupiedAccountRequiresExplicitDecision(add: Bool) async throws {
    let transport = JournalModelTransport(), existing = try fixture(transport)
    let identity = transport.identity(email: "occupied@example.com")
    try await existing.signIn(identity)
    existing.type("Account"); existing.save(); existing.done()
    await existing.beginSignOut(); await existing.finishSignOut(.keep)
    let model = try fixture(transport)
    model.type("Local"); model.save(); model.done()
    try await model.signIn(transport.identity(email: "occupied@example.com"))
    #expect(model.sheet == .adoption && model.account == nil && model.adoptionCount == 1)
    #expect(model.document.body == "Local")
    await model.adopt(add ? .add : .discard)
    #expect(model.account == identity.account && model.sheet == nil)
    let pending = try model.runner.read(Journal.scope) { try $0.devices(prefix: "pendingClaim:").members.count }
    #expect(pending == (add ? 1 : 0))
  }

  @Test func changedAdoptionWorkRequiresNewQuestion() async throws {
    let transport = JournalModelTransport(), existing = try fixture(transport)
    let identity = transport.identity(email: "occupied@example.com")
    try await existing.signIn(identity); existing.type("Account"); existing.save(); existing.done()
    await existing.beginSignOut(); await existing.finishSignOut(.keep)
    let model = try fixture(transport)
    model.type("One"); model.save(); model.done(); try await model.signIn(transport.identity(email: identity.account.replacingOccurrences(of: "model-", with: "")))
    model.document.body = "Changed after question"; model.dirty = true
    await model.adopt(.discard)
    #expect(model.account == nil && model.sheet == .adoption && model.error != nil)
    #expect(model.document.body == "Changed after question")
  }

  @Test func keepSignOutPreservesPendingEditsOnlyForSameAccount() async throws {
    let transport = JournalModelTransport(), model = try fixture(transport)
    let identity = transport.identity(email: "owner@example.com")
    model.type("Frozen"); model.save(); model.done(); try await model.signIn(transport.identity(email: identity.account.replacingOccurrences(of: "model-", with: "")))
    model.type("Latest"); model.save(); model.done()
    await model.beginSignOut()
    #expect((model.signOutSession?.pending ?? 0) > 0)
    await model.finishSignOut(.keep)
    #expect(model.account == nil && model.document.body.isEmpty && model.keptWork)
    try await model.signIn(transport.identity(email: "other@example.com"))
    #expect(model.document.body.isEmpty)
    await model.beginSignOut(); await model.finishSignOut(.keep)
    try await model.signIn(transport.identity(email: identity.account.replacingOccurrences(of: "model-", with: "")))
    #expect(model.document.body == "Latest")
  }

  @Test func discardSignOutRemovesRetainedEdits() async throws {
    let transport = JournalModelTransport(), model = try fixture(transport)
    let identity = transport.identity(email: "owner@example.com")
    model.type("Frozen"); model.save(); model.done(); try await model.signIn(transport.identity(email: identity.account.replacingOccurrences(of: "model-", with: "")))
    model.type("Latest"); model.save(); model.done(); await model.beginSignOut(); await model.finishSignOut(.discard)
    try await model.signIn(transport.identity(email: identity.account.replacingOccurrences(of: "model-", with: "")))
    let pending = try model.runner.read(Journal.scope) { try $0.devices(prefix: "pendingClaim:").members.count }
    #expect(pending == 0)
  }

  @Test func signOutCancelKeepsAccountAndWriting() async throws {
    let transport = JournalModelTransport(), model = try fixture(transport)
    try await model.signIn(transport.identity(email: "owner@example.com"))
    model.type("Writing"); model.save(); model.done(); await model.beginSignOut(); await model.cancelSignOut()
    #expect(model.account != nil && model.document.body == "Writing" && model.sheet == .you)
  }

  @Test func nativeResponseRequiresBodyToken() throws {
    let auth = NativeAuth(baseURL: nil)
    let identity = try auth.identity(["user": ["id": "a", "name": "Person"], "session": "body-token"])
    #expect(identity.account == "a" && identity.token.value == "body-token")
    #expect(try auth.identity(["user": ["id": "a", "name": "", "email": "person@example.com"], "session": "body-token"]).name == "person@example.com")
    #expect(throws: AppFailure.self) { try auth.identity(["user": ["id": "a"]]) }
  }
  @Test func adoptionFlushesDirtyBufferBeforeAdd() async throws {
    let transport = JournalModelTransport(), existing = try fixture(transport)
    let owner = transport.identity(email: "adoption-buffer@example.com")
    try await existing.signIn(owner); existing.type("Account"); existing.save(); existing.done()
    await existing.beginSignOut(); await existing.finishSignOut(.keep)
    let model = try fixture(transport)
    model.type("Persisted"); model.save(); model.done()
    try await model.signIn(transport.identity(email: "adoption-buffer@example.com"))
    model.document.body = "Newest before autosave"; model.dirty = true; model.saveTask?.cancel()
    await model.adopt(.add)
    if model.sheet == .adoption { await model.adopt(.add) }
    #expect(model.account == owner.account)
    #expect(model.document.body == "Newest before autosave")
  }

  @Test func signOutKeepFlushesDirtyBufferBeforeClearingEditor() async throws {
    let transport = JournalModelTransport(), model = try fixture(transport)
    try await model.signIn(transport.identity(email: "keep-buffer@example.com"))
    model.type("Persisted"); model.save(); model.done(); await model.beginSignOut()
    model.document.body = "Newest before autosave"; model.dirty = true; model.saveTask?.cancel()
    await model.finishSignOut(.keep)
    try await model.signIn(transport.identity(email: "keep-buffer@example.com"))
    await model.runtime?.engine.start(); try await AppScenario.backedUp(model)
    #expect(model.document.body == "Newest before autosave")
  }

  @Test func revokedSessionShowsPausedBackupAndSameAccountSignInKeepsLineage() async throws {
    let transport = JournalModelTransport(), model = try fixture(transport)
    let identity = transport.identity(email: "paused@example.com")
    try await model.signIn(identity); model.type("Keep this replica"); model.save(); model.done()
    let runtime = try #require(model.runtime)
    let before = try runtime.store.read { try $0.device().activeReplica.meta.replica }
    transport.state.withLock { $0.sessions[identity.token.value] = nil }
    await runtime.engine.start(); model.refresh()
    #expect(model.backup == "backup paused")
    try await model.signIn(transport.identity(email: "paused@example.com")); model.refresh()
    let after = try runtime.store.read { try $0.device().activeReplica.meta.replica }
    #expect(after == before && model.account == identity.account && model.document.body == "Keep this replica")
    for _ in 0..<100 where model.authPaused { try await Task.sleep(for: .milliseconds(5)) }
    #expect(model.backup != "backup paused")
  }

  @Test(arguments: [SignOutChoice.keep, .discard]) func confirmedSignOutRevokesNativeSession(choice: SignOutChoice) async throws {
    let transport = JournalModelTransport(), model = try fixture(transport)
    let identity = transport.identity(email: "logout@example.com")
    try await model.signIn(identity); await model.beginSignOut(); await model.finishSignOut(choice)
    let replay = await transport.hello(token: identity.token)
    if case .answered(.failed(let failure)) = replay { #expect(failure.status == 401) }
    else { Issue.record("Signed-out token still authenticates") }
  }

  @Test func delayedSignInLocksEditorAndAdoptsAllPreAutosaveWriting() async throws {
    let server = JournalModelTransport(), existing = try fixture(server)
    try await existing.signIn(server.identity(email: "delayed-add@example.com"))
    existing.type("Account"); existing.done(); await existing.beginSignOut(); await existing.finishSignOut(.keep)
    let delayed = DelayedJournalTransport(base: server, delayHello: true)
    let model = try fixture(server, syncTransport: delayed)
    model.type("Before autosave"); model.saveTask?.cancel()
    model.email = "delayed-add@example.com"; model.code = "482913"
    let signIn = Task { await model.verifyCode() }
    await delayed.gate.untilWaiting()
    #expect(model.editorReadOnly && model.working)
    model.type("Writing during account transition")
    #expect(model.document.body == "Before autosave")
    await delayed.gate.release(); await signIn.value
    #expect(model.sheet == .adoption && model.editorReadOnly)
    await model.adopt(.add)
    #expect(model.document.body == "Before autosave" && !model.dirty && !model.editorReadOnly)
  }

  @Test func delayedSignOutLocksEditorAndKeepsPreAutosaveWriting() async throws {
    let server = JournalModelTransport(), delayed = DelayedJournalTransport(base: server, delayHello: false)
    let model = try fixture(server, syncTransport: delayed)
    try await model.signIn(server.identity(email: "delayed-keep@example.com"))
    model.type("Before autosave"); model.saveTask?.cancel()
    let signOut = Task { await model.beginSignOut() }
    await delayed.gate.untilWaiting()
    #expect(model.editorReadOnly)
    model.type("Writing during sign-out")
    #expect(model.document.body == "Before autosave")
    await delayed.gate.release(); await signOut.value
    await model.finishSignOut(.keep)
    try await model.signIn(server.identity(email: "delayed-keep@example.com"))
    await model.runtime?.engine.start(); try await AppScenario.backedUp(model)
    #expect(model.document.body == "Before autosave")
  }

  @Test func offlineSignOutQueuesEveryCredentialAndNextRuntimeRevokesBoth() async throws {
    let server = JournalModelTransport(), tokens = InMemoryTokenStore(), queue = InMemoryTokenStore()
    let model = try fixture(server, tokens: tokens, revocations: queue)
    server.state.withLock { $0.logoutOnline = false }
    let first = server.identity(email: "offline@example.com")
    try await model.signIn(first); await model.beginSignOut(); await model.finishSignOut(.keep)
    let second = server.identity(email: "offline@example.com")
    try await model.signIn(second); await model.beginSignOut(); await model.finishSignOut(.discard)
    #expect(queue.accounts().count == 2)
    server.state.withLock { $0.logoutOnline = true }
    let recreated = try fixture(server, tokens: tokens, revocations: queue)
    await recreated.runtime?.revokeSignedOutSessions(force: true)
    #expect(queue.accounts().isEmpty)
    for token in [first.token, second.token] {
      if case .answered(.failed(let failure)) = await server.hello(token: token) { #expect(failure.status == 401) }
      else { Issue.record("Offline logout token survived launch retry") }
    }
  }

  @Test func canceledSignOutNeverRevokesAndPreparedCurrentCredentialWaits() async throws {
    let server = JournalModelTransport(), model = try fixture(server)
    let identity = server.identity(email: "cancel-revocation@example.com")
    try await model.signIn(identity); await model.beginSignOut(); await model.cancelSignOut()
    let runtime = try #require(model.runtime)
    #expect(runtime.revocations.accounts().isEmpty)
    let key = try #require(try runtime.prepareRevocation(account: identity.account))
    await runtime.revokeSignedOutSessions(force: true)
    if case .answered(.ok) = await server.hello(token: identity.token) {} else { Issue.record("Unconfirmed sign-out revoked current credential") }
    #expect(runtime.revocations.accounts() == [key])
  }

  @Test func restoredBoundDatabaseWithoutTokenOffersSameAccountReauthentication() async throws {
    let server = JournalModelTransport(), tokens = InMemoryTokenStore(), model = try fixture(server, tokens: tokens)
    let identity = server.identity(email: "restore@example.com")
    try await model.signIn(identity)
    let runtime = try #require(model.runtime), store = runtime.store
    let replica = try store.read { try $0.device().activeReplica.meta.replica }
    tokens.delete(for: identity.account)
    let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios, drivesLoops: false), store: store, transport: server,
                                tokens: tokens, forkGuard: InMemoryForkGuardStore(try store.read { try $0.device().meta.forkGuard }),
                                clock: .system, random: SeededRandomSource(seed: 31), connectivity: SwitchedConnectivity())
    let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    let restoredRuntime = AppRuntime(settings: runtime.settings, store: store, engine: engine, auth: runtime.auth, runner: runner, tokens: tokens, revocations: runtime.revocations)
    let restored = try JournalModel(runner: runner, preferences: model.preferences, runtime: restoredRuntime)
    #expect(restored.account == identity.account && restored.authPaused && restored.backup == "backup paused")
    restored.email = "restore@example.com"; restored.code = "482913"; await restored.verifyCode()
    for _ in 0..<100 where restored.authPaused { try await Task.sleep(for: .milliseconds(5)) }
    #expect(!restored.authPaused && restored.account == identity.account)
    #expect(try store.read { try $0.device().activeReplica.meta.replica } == replica)
    let other = server.identity(email: "different@example.com")
    do { try await restored.signIn(other); Issue.record("Different account reauthenticated") } catch {}
    #expect(restored.account == identity.account)
    #expect(try store.read { try $0.device().activeReplica.meta.replica } == replica)
  }

  @Test func shorteningRestoredOversizedDraftStartsBackupWithoutRelaunch() async throws {
    let server = JournalModelTransport(), model = try fixture(server)
    model.type(String(repeating: "x", count: 131_073)); model.saveTask?.cancel()
    let restored = try JournalModel(runner: model.runner, preferences: model.preferences, runtime: model.runtime)
    await restored.start()
    #expect(restored.dirty && !restored.syncStarted && restored.timerTask != nil)
    restored.type("Now it fits"); #expect(restored.save())
    for _ in 0..<100 where !restored.syncStarted { try await Task.sleep(for: .milliseconds(10)) }
    #expect(restored.syncStarted)
    restored.timerTask?.cancel(); restored.observationTask?.cancel()
  }

  @Test func pausedAppleReauthenticationLocksEditorAndRetainsReplica() async throws {
    let server = JournalModelTransport(), model = try fixture(server)
    let runtime = try #require(model.runtime), original = try runtime.auth.fakeApple()
    try await model.signIn(original); model.type("Apple account writing"); model.save()
    let replica = try runtime.store.read { try $0.device().activeReplica.meta.replica }
    try await runtime.auth.logout(token: original.token); await runtime.engine.start()
    #expect(model.authPaused)
    let gate = TransportGate()
    let reauthentication = Task {
      await model.authenticateApple { _ in await gate.wait(); return .signedIn(try runtime.auth.fakeApple()) }
    }
    await gate.untilWaiting(); model.type("During Apple verification")
    #expect(model.editorReadOnly && model.document.body == "Apple account writing")
    await gate.release(); await reauthentication.value
    for _ in 0..<100 where model.authPaused { try await Task.sleep(for: .milliseconds(5)) }
    #expect(!model.authPaused && model.account == original.account && !model.editorReadOnly)
    #expect(try runtime.store.read { try $0.device().activeReplica.meta.replica } == replica)
  }

}

actor TransportGate {
  var waiting = false
  var released = false
  var continuation: CheckedContinuation<Void, Never>?
  func wait() async {
    guard !released else { return }
    waiting = true
    await withCheckedContinuation { continuation = $0 }
  }
  func untilWaiting() async { while !waiting { await Task.yield() } }
  func release() { released = true; continuation?.resume(); continuation = nil }
}

nonisolated final class DelayedJournalTransport: SyncTransport {
  let base: JournalModelTransport
  let delayHello: Bool
  let gate = TransportGate()
  init(base: JournalModelTransport, delayHello: Bool) { self.base = base; self.delayHello = delayHello }
  func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    if delayHello { await gate.wait() }
    return await base.hello(token: token)
  }
  func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    if !delayHello { await gate.wait() }
    return await base.push(request, token: token)
  }
  func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> { await base.pull(request, token: token) }
  func openLive(token: SessionToken) async -> Reply<any LiveConnection> { .unreachable }
}
