import Foundation
import Testing
import Synchronization
import DomainKit
import DomainKitTesting
import GymDomain
import JournalDomain
import SyncAPI
import SyncCore
import SyncEngine
import enum SyncEngine.Reply
import SyncModelServer
import SyncSchema
import SyncStore
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct GymModelTests {
  func fixture() -> (Harness, GymModel) {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    return (harness, GymModel(runner: harness.runner))
  }

  func runtime(failing: GymStoreFault = GymStoreFault(), telemetry: any Telemetry = NoopTelemetry(), transport: any SyncTransport = JournalModelTransport(), drivesLoops: Bool = false) throws -> AppRuntime {
    let store = try Store.inMemory(registry: SyncSchema.registry, crashPoints: CrashPoints { point in
      if failing.point.withLock({ $0 == point }) { throw AppFailure(message: "private injected storage detail") }
    }, commandResultWrites: AppRuntime.commandResultWrites)
    let tokens = InMemoryTokenStore()
    let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios, drivesLoops: drivesLoops), store: store,
                                transport: transport, tokens: tokens, forkGuard: InMemoryForkGuardStore(),
                                clock: .system, random: SeededRandomSource(seed: 17), connectivity: SwitchedConnectivity(), telemetry: telemetry)
    let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    return AppRuntime(settings: AppSettings(arguments: ["app", "-server", "https://gym.invalid"]), store: store, engine: engine,
                      auth: NativeAuth(baseURL: URL(string: "https://gym.invalid")), runner: runner,
                      tokens: tokens, revocations: InMemoryTokenStore(), telemetry: telemetry)
  }

  @Test func anonymousGymUsesEngineAndNeverPushes() throws {
    let (harness, gym) = fixture()
    let id = gym.runner.mint(Note.self)
    #expect(gym.isAnonymous && gym.account == nil && !gym.authPaused && !gym.readFailed)
    #expect(gym.catalogue.exercises.count == SeedExercises.all.count)
    #expect(gym.run(SaveNoteCall(Note(id: id, title: "Local", body: "Private")))?.receipt != nil)
    harness.sync(); gym.refresh()
    #expect(gym.notes.map(\.id) == [id])
    #expect(harness.server.rows(Gym.scope, of: nil).isEmpty)
    let reopened = GymModel(runner: harness.runner)
    #expect(reopened.notes.map(\.title) == ["Local"] && reopened.isAnonymous)
  }

  @Test func sessionStateFollowsStartAndFinishPredictions() throws {
    let (_, gym) = fixture(), id = gym.runner.mint(Session.self)
    #expect(gym.run(StartSession(id: id))?.receipt != nil)
    #expect(gym.openSession?.id == id && gym.sessions.count == 1)
    #expect(gym.run(FinishSession(id: id))?.receipt != nil)
    #expect(gym.openSession == nil && gym.sessions.first?.closedBy == "finish")
  }

  @Test func refusalsRemainTypedAndShowBoundedCopy() throws {
    let (_, gym) = fixture()
    let invalid = Note(id: gym.runner.mint(Note.self), title: String(repeating: "Private title", count: 100))
    let outcome = gym.run(SaveNoteCall(invalid))
    guard case .invalid = outcome?.refusal else { Issue.record("Expected a validation refusal"); return }
    #expect(gym.refusal == outcome?.refusal && gym.error == "Check the values and try again.")
    #expect(gym.notes.isEmpty)
    let missing = gym.runner.mint(Session.self)
    #expect(gym.run(FinishSession(id: missing))?.refusal == .gone(missing.ref, .predicted))
    #expect(gym.error == "This is no longer available.")
  }

  @Test func failedCommitKeepsStateAndAllowsRetry() throws {
    let (harness, gym) = fixture()
    let action = SaveNoteCall(Note(id: gym.runner.mint(Note.self), title: "Still mine"))
    harness.failNextCommit()
    #expect(gym.run(action) == nil && gym.notes.isEmpty && gym.refusal == nil)
    #expect(gym.error == "Gym could not save this change. Try again.")
    #expect(gym.run(action)?.receipt != nil && gym.notes.map(\.title) == ["Still mine"] && gym.error == nil)
  }

  @Test func heldDeleteUndoRestoresTheEngineState() throws {
    let (harness, gym) = fixture(), id = gym.runner.mint(Note.self)
    gym.run(SaveNoteCall(Note(id: id, title: "Kept")))
    let receipt = try #require(gym.run(DeleteNote(id))?.receipt)
    #expect(gym.notes.isEmpty && gym.undoOffers.map(\.id) == [receipt.gestureId])
    #expect(try harness.stored(Note.self).map(\.id) == [id])
    #expect(gym.undo(receipt.gestureId))
    #expect(gym.notes.map(\.id) == [id] && gym.undoOffers.isEmpty)
  }

  @Test func expiredDeleteCannotBeUndone() throws {
    let (harness, gym) = fixture(), id = gym.runner.mint(Note.self)
    gym.run(SaveNoteCall(Note(id: id, title: "Gone")))
    let receipt = try #require(gym.run(DeleteNote(id))?.receipt)
    harness.advance(ms: Constants.holdMs + 1); gym.refresh()
    #expect(gym.undoOffers.isEmpty && !gym.undo(receipt.gestureId) && gym.notes.isEmpty)
  }

  @Test func accountTransitionBlocksActionsSavesAndUndo() throws {
    let (_, gym) = fixture()
    var draft = Draft(new: Note(id: gym.runner.mint(Note.self), title: "Pending"))
    gym.accountChanging = true
    #expect(gym.rest.blocked)
    #expect(gym.run(SaveNoteCall(draft.current)) == nil)
    guard case .failed = gym.save(&draft) else { Issue.record("Expected account transition to block draft save"); return }
    #expect(draft.isNew && gym.notes.isEmpty && !gym.undo("unknown"))
    gym.accountChanging = false
    #expect(!gym.rest.blocked)
    guard case .saved = gym.save(&draft) else { Issue.record("Expected draft save after transition"); return }
    #expect(!draft.isNew && gym.notes.map(\.title) == ["Pending"])
  }

  @Test func inactiveThenActivePreservesLiveConnectionUndoAndPersistsDraft() async throws {
    let transport = GymLifecycleTransport(), runtime = try runtime(transport: transport, drivesLoops: true)
    let identity = transport.base.identity(email: "gym-inactive@example.com")
    #expect(try await runtime.engine.signIn(account: identity.account, token: identity.token).isComplete)
    let suite = "gym-inactive-\(UUID().uuidString)", preferences = UserDefaults(suiteName: suite)!
    defer { preferences.removePersistentDomain(forName: suite) }
    let model = try AppModel(runner: runtime.runner, preferences: preferences, runtime: runtime)
    let gym = model.gym, id = gym.runner.mint(Note.self)
    gym.start()
    await runtime.engine.start()
    for _ in 0..<100 where transport.socket.sent.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
    #expect(!transport.socket.sent.isEmpty && !transport.socket.isClosed)
    gym.run(SaveNoteCall(Note(id: id, title: "Keep undo")))
    let receipt = try #require(gym.run(DeleteNote(id))?.receipt)
    model.journal.type("Saved during the interruption")
    model.journal.saveTask?.cancel()
    #expect(model.journal.dirty && gym.undoOffers.map(\.id) == [receipt.gestureId])
    let restGeneration = gym.rest.generation
    let journalCommands = try runtime.runner.read(Journal.scope) { Set(try $0.commands().map(\.gestureId)) }
    model.scenePhaseChanged(.inactive)
    let remainingJournalCommands = try runtime.runner.read(Journal.scope) { Set(try $0.commands().map(\.gestureId)) }
    #expect(remainingJournalCommands.isSubset(of: journalCommands))
    let storedDraft = try runtime.runner.read(Journal.scope) { try $0.device(EditorDraft.key).map(EditorDraft.init(json:)) }
    let draft = try #require(storedDraft)
    #expect(draft.document == model.journal.document && draft.day == model.journal.editorDay)
    let restored = try JournalModel(runner: runtime.runner, preferences: preferences, runtime: runtime)
    #expect(restored.dirty && restored.document == draft.document)
    try await Task.sleep(for: .milliseconds(20))
    #expect(model.journal.dirty)
    #expect(!transport.socket.isClosed && transport.opens.withLock { $0 } == 1)
    #expect(gym.rest.generation == restGeneration)
    #expect(gym.undoOffers.map(\.id) == [receipt.gestureId])
    #expect(try runtime.store.read { try $0.device().activeReplica.outbox.filter { $0.gestureId == receipt.gestureId }.allSatisfy { $0.state == .held } })
    model.scenePhaseChanged(.active)
    #expect(!transport.socket.isClosed && transport.opens.withLock { $0 } == 1)
    #expect(gym.undo(receipt.gestureId) && gym.notes.map(\.id) == [id])
    model.scenePhaseChanged(.background)
    await runtime.engine.flushOnLeave()
    #expect(transport.socket.isClosed)
    gym.stop()
  }

  @Test func backgroundReleasesHeldDeletesDurably() throws {
    let runtime = try runtime(), gym = GymModel(runner: runtime.runner, runtime: runtime)
    let id = gym.runner.mint(Note.self)
    gym.run(SaveNoteCall(Note(id: id, title: "Gone")))
    let receipt = try #require(gym.run(DeleteNote(id))?.receipt)
    gym.background()
    #expect(gym.undoOffers.isEmpty && !gym.undo(receipt.gestureId))
    #expect(try runtime.store.read { try $0.device().activeReplica.outbox.allSatisfy { $0.state != .held } })
    #expect(GymModel(runner: runtime.runner, runtime: runtime).notes.isEmpty)
  }

  @Test func failedReleaseRetainsUndoAndCanRetry() throws {
    let fault = GymStoreFault(), runtime = try runtime(failing: fault)
    let gym = GymModel(runner: runtime.runner, runtime: runtime), id = gym.runner.mint(Note.self)
    gym.run(SaveNoteCall(Note(id: id, title: "Pending delete")))
    let receipt = try #require(gym.run(DeleteNote(id))?.receipt)
    fault.point.withLock { $0 = .beforeCommit(.release) }
    #expect(!gym.flush() && gym.undoOffers.map(\.id) == [receipt.gestureId])
    #expect(gym.error == "Gym could not keep pending changes. Try again.")
    fault.point.withLock { $0 = nil }
    #expect(gym.flush() && gym.undoOffers.isEmpty && !gym.undo(receipt.gestureId))
  }

  @Test func failedReadPreservesLastStateAndReportsOnlyBoundedFailure() throws {
    let fault = GymStoreFault(), telemetry = TelemetryRecorder()
    let runtime = try runtime(failing: fault, telemetry: telemetry)
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry), id = gym.runner.mint(Note.self)
    gym.run(SaveNoteCall(Note(id: id, title: "Private title")))
    fault.point.withLock { $0 = .read }; gym.refresh()
    #expect(gym.readFailed && gym.notes.map(\.id) == [id])
    #expect(gym.error == "Gym could not be read from this phone. Try again.")
    #expect(telemetry.entries.withLock { entries in entries.allSatisfy { !$0.properties.values.contains(where: { $0.contains("private") || $0.contains("Private") }) } })
    fault.point.withLock { $0 = nil }; gym.refresh()
    #expect(!gym.readFailed && gym.notes.map(\.id) == [id])
  }

  @Test func observesGymChangesFromTheSharedRuntime() async throws {
    let runtime = try runtime(), gym = GymModel(runner: runtime.runner, runtime: runtime), id = runtime.runner.mint(Note.self)
    gym.start()
    _ = try runtime.runner.run(SaveNoteCall(Note(id: id, title: "Observed")))
    for _ in 0..<100 where gym.notes.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
    #expect(gym.notes.map(\.id) == [id])
    gym.stop(); #expect(gym.observationTask == nil)
  }

  @Test func restRejectsAnonymousRequestsWithoutNetwork() async throws {
    let runtime = try runtime(), rest = GymRESTClient(runtime: runtime, telemetry: NoopTelemetry())
    await #expect(throws: AppFailure.self) { try await rest.request("/v1/gym/coach/threads") }
    #expect(rest.tasks.isEmpty)
  }

  @Test func serverRefusalRemainsVisibleUntilDismissed() async throws {
    let transport = JournalModelTransport(), runtime = try runtime(transport: transport)
    let identity = transport.identity(email: "gym-owner@example.com")
    let signIn = try await runtime.engine.signIn(account: identity.account, token: identity.token)
    #expect(signIn.isComplete)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    transport.state.withLock { $0.server.refuse(code: .cap, detail: ["type": .string(Note.type), "cap": 10]) }
    gym.run(SaveNoteCall(Note(id: gym.runner.mint(Note.self), title: "Refused by server")))
    await runtime.engine.flushOnLeave(); gym.refresh()
    #expect(gym.notices.count == 1 && gym.refusal == .full(type: Note.type, cap: 10, .notice))
    #expect(gym.error == "There is room for 10. Remove one before adding another.")
    #expect(gym.notes.isEmpty)
    gym.dismissNotice(try #require(gym.notices.first?.id))
    #expect(gym.notices.isEmpty && gym.refusal == nil && gym.error == nil)
  }

  func rest(_ reply: GymWireProtocol.Reply, telemetry: TelemetryRecorder) async throws -> (GymRESTClient, AppRuntime) {
    let transport = JournalModelTransport(), runtime = try runtime(telemetry: telemetry, transport: transport)
    let identity = transport.identity(email: "gym-rest@example.com")
    _ = try await runtime.engine.signIn(account: identity.account, token: identity.token)
    GymWireProtocol.state.withLock { $0 = GymWireProtocol.State(reply: reply) }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [GymWireProtocol.self]; config.httpShouldSetCookies = false; config.httpCookieStorage = nil
    return (GymRESTClient(runtime: runtime, telemetry: telemetry, session: URLSession(configuration: config)), runtime)
  }

  @Test func restUsesCurrentBearerAndKeepsRefusalPayloadOutOfTelemetry() async throws {
    let telemetry = TelemetryRecorder()
    let body = #"{"code":"ask-generation-active","error":"Private refusal detail","generation":{"status":"running"}}"#
    let (rest, runtime) = try await rest(.http(409, body), telemetry: telemetry)
    do {
      _ = try await rest.request("/v1/gym/ask", method: "POST", body: Data(#"{"question":"private question"}"#.utf8))
      Issue.record("Expected REST refusal")
    } catch let refusal as GymRESTFailure {
      #expect(refusal.status == 409 && refusal.body == Data(body.utf8) && refusal.message == "Private refusal detail")
    }
    let token = try #require(try runtime.account().flatMap { runtime.tokens.token(for: $0) })
    #expect(GymWireProtocol.state.withLock { $0.requests.map(\.authorization) } == ["Bearer \(token.value)"])
    let entries = telemetry.entries.withLock { $0.filter { $0.properties["operation"] == "gym_rest" } }
    #expect(entries.map(\.name) == ["api_request_failed"])
    #expect(entries[0].properties == ["method": "POST", "route": "/v1/gym", "operation": "gym_rest", "failure_kind": "http", "status": "409"])
  }

  @Test(arguments: [URLError.Code.notConnectedToInternet, .timedOut])
  func restClassifiesOfflineAndTimeoutWithoutContent(code: URLError.Code) async throws {
    let telemetry = TelemetryRecorder(), (rest, _) = try await rest(.failure(code), telemetry: telemetry)
    await #expect(throws: URLError.self) { try await rest.request("/v1/gym/threads") }
    let entries = telemetry.entries.withLock { $0.filter { $0.properties["operation"] == "gym_rest" } }
    #expect(entries.map(\.name) == (code == .notConnectedToInternet ? ["api_request_failed"] : ["api_request_failed", "client_error"]))
    #expect(entries.first?.properties["failure_kind"] == (code == .notConnectedToInternet ? "offline" : "timeout"))
    #expect(rest.tasks.isEmpty)
  }

  @Test func restReportsHTTP408AsUnexpected() async throws {
    let telemetry = TelemetryRecorder(), (rest, _) = try await rest(.http(408, #"{"error":"private timeout detail"}"#), telemetry: telemetry)
    await #expect(throws: GymRESTFailure.self) { try await rest.request("/v1/gym/threads") }
    let entries = telemetry.entries.withLock { $0.filter { $0.properties["operation"] == "gym_rest" } }
    #expect(entries.map(\.name) == ["api_request_failed", "client_error"])
    #expect(entries.first?.properties == ["method": "GET", "route": "/v1/gym", "operation": "gym_rest", "failure_kind": "http", "status": "408"])
  }

  @Test func cancelStopsStalledRestWorkAndEmitsNoFailure() async throws {
    let telemetry = TelemetryRecorder(), (rest, _) = try await rest(.stalled, telemetry: telemetry)
    let request = Task { try await rest.request("/v1/gym/threads") }
    for _ in 0..<100 where GymWireProtocol.state.withLock({ $0.requests.isEmpty }) { try await Task.sleep(for: .milliseconds(5)) }
    #expect(GymWireProtocol.state.withLock { $0.requests.count } == 1)
    rest.cancel()
    await #expect(throws: (any Error).self) { try await request.value }
    #expect(rest.tasks.isEmpty && telemetry.entries.withLock { $0.filter { $0.properties["operation"] == "gym_rest" }.isEmpty })
  }

  @Test func lateSuccessIsRejectedAfterRequestGenerationChanges() async throws {
    let telemetry = TelemetryRecorder(), (rest, _) = try await rest(.stalled, telemetry: telemetry)
    let request = Task { try await rest.request("/v1/gym/threads") }
    for _ in 0..<100 where GymWireProtocol.state.withLock({ $0.active == nil }) { try await Task.sleep(for: .milliseconds(5)) }
    let transport = try #require(GymWireProtocol.state.withLock { $0.active })
    // A transport completing during cancellation can deliver success; the captured generation must still refuse it.
    rest.generation += 1
    transport.respond(200, #"{"threads":["private old account"]}"#)
    await #expect(throws: CancellationError.self) { try await request.value }
    #expect(rest.tasks.isEmpty && telemetry.entries.withLock { $0.filter { $0.properties["operation"] == "gym_rest" }.isEmpty })
  }
}

nonisolated final class GymStoreFault: Sendable {
  let point = Mutex<CrashPoint?>(nil)
}

nonisolated final class GymWireProtocol: URLProtocol, @unchecked Sendable {
  enum Reply: Sendable { case http(Int, String), failure(URLError.Code), stalled }
  struct Request: Sendable { let authorization: String? }
  struct State: Sendable { var reply: Reply; var requests: [Request] = []; var active: GymWireProtocol? }
  static let state = Mutex(State(reply: .stalled))
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let reply = Self.state.withLock { state in
      state.requests.append(Request(authorization: request.value(forHTTPHeaderField: "Authorization")))
      state.active = self
      return state.reply
    }
    switch reply {
    case .http(let status, let body): respond(status, body)
    case .failure(let code): client?.urlProtocol(self, didFailWithError: URLError(code))
    case .stalled: break
    }
  }
  func respond(_ status: Int, _ body: String) {
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() { Self.state.withLock { if $0.active === self { $0.active = nil } } }
}

nonisolated final class GymLifecycleTransport: SyncTransport {
  let base = JournalModelTransport()
  let socket = FakeLiveConnection()
  let opens = Mutex(0)
  func hello(token: SessionToken?) async -> Reply<HelloResponse> { await base.hello(token: token) }
  func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> { await base.push(request, token: token) }
  func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> { await base.pull(request, token: token) }
  func openLive(token: SessionToken) async -> Reply<any LiveConnection> {
    opens.withLock { $0 += 1 }
    return .answered(.ok(socket))
  }
}
