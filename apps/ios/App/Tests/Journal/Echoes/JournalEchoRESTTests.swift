import Foundation
import Testing
import Synchronization
import DomainKit
import JournalDomain
import SyncCore
import SyncEngine
import SyncSchema
import SyncStore
import SyncTesting
@testable import Windmill

nonisolated final class JournalEchoWireProtocol: URLProtocol, @unchecked Sendable {
  enum Reply: Sendable { case http(Int, String), failure(URLError.Code), stalled, partial }
  struct State: Sendable {
    var reply: Reply
    var requests: [URLRequest] = []
    var active: JournalEchoWireProtocol?
    var started: Set<ObjectIdentifier> = []
    var stopped = 0
    var stopWaiters: [CheckedContinuation<Void, Never>] = []
  }
  static let state = Mutex(State(reply: .stalled))
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let reply = Self.state.withLock { state in
      state.requests.append(request); state.active = self; state.started.insert(ObjectIdentifier(self))
      return state.reply
    }
    switch reply {
    case .http(let status, let body): respond(status, body)
    case .failure(let code): client?.urlProtocol(self, didFailWithError: URLError(code, userInfo: [NSLocalizedDescriptionKey: "private-marker"]))
    case .stalled: break
    case .partial:
      client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(#"{"pages":["#.utf8))
    }
  }
  func respond(_ status: Int, _ body: String) {
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                                       headerFields: ["Set-Cookie": "session=private-marker; Path=/", "Cache-Control": "max-age=600"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
  }
  // A load an earlier test started may stop late, after the state was reset; only this test's loads count.
  override func stopLoading() {
    let waiters = Self.state.withLock { state in
      guard state.started.contains(ObjectIdentifier(self)) else { return [CheckedContinuation<Void, Never>]() }
      state.stopped += 1; if state.active === self { state.active = nil }
      defer { state.stopWaiters = [] }
      return state.stopWaiters
    }
    for waiter in waiters { waiter.resume() }
  }
  // URLSession stops a cancelled load on the protocol's own thread, which may be after the caller holds its error.
  static func firstStop() async {
    await withCheckedContinuation { (stop: CheckedContinuation<Void, Never>) in
      let stopped = state.withLock { state in
        if state.stopped > 0 { return true }
        state.stopWaiters.append(stop); return false
      }
      if stopped { stop.resume() }
    }
  }
}

@Suite(.serialized) @MainActor struct JournalEchoRESTTests {
  struct Fixture {
    let rest: JournalEchoREST
    let runtime: AppRuntime
    let server: JournalModelTransport
    let network: SwitchedConnectivity
    let telemetry: TelemetryRecorder
  }

  func fixture(_ reply: JournalEchoWireProtocol.Reply, signedIn: Bool = true) async throws -> Fixture {
    let server = JournalModelTransport(), tokens = InMemoryTokenStore(), network = SwitchedConnectivity()
    let store = try Store.inMemory(registry: SyncSchema.registry, commandResultWrites: JournalWriting.resultWrites,
                                   pendingDeviceWork: JournalWriting.pendingWork)
    let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios, drivesLoops: false), store: store,
                                transport: server, tokens: tokens, forkGuard: InMemoryForkGuardStore(), clock: .system,
                                random: SeededRandomSource(seed: 17), connectivity: network)
    let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    let runtime = AppRuntime(settings: AppSettings(arguments: ["app", "-server", "https://echoes.invalid"]), store: store,
                             engine: engine, auth: NativeAuth(baseURL: nil, fake: server), runner: runner, tokens: tokens,
                             revocations: InMemoryTokenStore())
    if signedIn {
      let identity = server.identity(email: "echo-rest@example.com")
      _ = try await engine.signIn(account: identity.account, token: identity.token)
    }
    JournalEchoWireProtocol.state.withLock { $0 = JournalEchoWireProtocol.State(reply: reply) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [JournalEchoWireProtocol.self]
    let telemetry = TelemetryRecorder()
    let rest = JournalEchoREST(runtime: runtime, telemetry: telemetry, session: URLSession(configuration: configuration))
    return Fixture(rest: rest, runtime: runtime, server: server, network: network, telemetry: telemetry)
  }

  func activeRequest() async throws -> JournalEchoWireProtocol {
    for _ in 0..<100 where JournalEchoWireProtocol.state.withLock({ $0.active == nil }) {
      try await Task.sleep(for: .milliseconds(5))
    }
    return try #require(JournalEchoWireProtocol.state.withLock { $0.active })
  }

  func goOffline(_ fixture: Fixture) async throws {
    fixture.network.set(online: false)
    for _ in 0..<100 where fixture.runtime.engine.status.online { try await Task.sleep(for: .milliseconds(5)) }
    #expect(!fixture.runtime.engine.status.online)
  }

  @Test func listUsesRESTBearerAndPreservesOnlyTheWireHonestyMetadata() async throws {
    let fixture = try await fixture(.http(200, #"{"pages":[{"day":"2026-10-08","entitled":true,"offerRetired":false,"matches":[{"day":"2026-09-01","text":"Private complete passage.","isSelf":true,"source":"spoken","useful":true,"occurrenceHint":2,"withheldWords":0,"score":0.94}]}],"pagesWritten":12,"floorWaived":false,"firstEchoEver":true}"#))
    let response = try await fixture.rest.list(through: "2026-10-08")
    #expect(response == JournalEchoResponse(pages: [JournalEchoPage(day: "2026-10-08", matches: [
      JournalEchoMatch(day: "2026-09-01", text: "Private complete passage.", isSelf: true, source: "spoken", useful: true, occurrenceHint: 2)
    ])], pagesWritten: 12, floorWaived: false, firstEchoEver: true))
    let request = try #require(JournalEchoWireProtocol.state.withLock { $0.requests.first })
    let account = try #require(try fixture.runtime.account())
    let token = try #require(fixture.runtime.tokens.token(for: account))
    #expect(request.url?.absoluteString == "https://echoes.invalid/v1/journal/echoes?from=0001-01-01&to=2026-10-08")
    #expect(request.httpMethod == "GET" && request.httpBody == nil)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token.value)")
    #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
    #expect(request.value(forHTTPHeaderField: "Cache-Control") == "no-store")
    #expect(request.value(forHTTPHeaderField: "Cookie") == nil && !request.httpShouldHandleCookies)
    #expect(request.cachePolicy == .reloadIgnoringLocalAndRemoteCacheData && request.timeoutInterval == 15)
    let configuration = fixture.rest.session.configuration
    #expect(configuration.urlCache == nil && configuration.httpCookieStorage == nil && !configuration.httpShouldSetCookies)
    #expect(configuration.timeoutIntervalForRequest == 15 && configuration.timeoutIntervalForResource == 15 && !configuration.waitsForConnectivity)
    #expect(fixture.telemetry.entries.withLock { $0.isEmpty })
  }

  @Test func absentOptionalMetadataStaysAbsentAndEmptyJournalRemainsEmpty() async throws {
    let fixture = try await fixture(.http(200, #"{"pages":[{"day":"2026-10-08","matches":[{"day":"2026-09-01","text":"A full older passage."}]}]}"#))
    #expect(try await fixture.rest.list(through: "2026-10-08") == JournalEchoResponse(pages: [
      JournalEchoPage(day: "2026-10-08", matches: [JournalEchoMatch(day: "2026-09-01", text: "A full older passage.")])
    ]))
    JournalEchoWireProtocol.state.withLock { $0.reply = .http(200, #"{"pages":[],"pagesWritten":0,"floorWaived":false}"#) }
    #expect(try await fixture.rest.list(through: "2026-10-08") == JournalEchoResponse(pages: [], pagesWritten: 0, floorWaived: false))
  }

  @Test func signalsUseTheSamePairAndWholePageDoorsAsWebWithoutBodies() async throws {
    let fixture = try await fixture(.http(204, ""))
    for signal in [JournalEchoSignal.opened, .useful, .dismiss] {
      try await fixture.rest.signal(signal, triggerDay: "2026-10-08", matchDay: "2026-09-01")
    }
    try await fixture.rest.signal(.dismiss, triggerDay: "2026-10-08", matchDay: nil)
    let requests = JournalEchoWireProtocol.state.withLock { $0.requests }
    #expect(requests.map { $0.url?.path } == [
      "/v1/journal/echoes/2026-10-08/2026-09-01/opened", "/v1/journal/echoes/2026-10-08/2026-09-01/useful",
      "/v1/journal/echoes/2026-10-08/2026-09-01/dismiss", "/v1/journal/echoes/2026-10-08/dismiss"
    ])
    #expect(requests.allSatisfy { $0.httpMethod == "POST" && $0.httpBody == nil && $0.httpBodyStream == nil })
  }

  @Test func malformedDatesAndPairlessSignalsAreRejectedBeforeNetworking() async throws {
    let fixture = try await fixture(.http(204, ""))
    for day in ["2026-02-29", "0000-01-01", "2026-1-01", "2026-10-08/../dismiss", "private-marker"] {
      await #expect(throws: JournalEchoFailure.invalidDate) { try await fixture.rest.list(through: day) }
      await #expect(throws: JournalEchoFailure.invalidDate) { try await fixture.rest.signal(.dismiss, triggerDay: day, matchDay: nil) }
      await #expect(throws: JournalEchoFailure.invalidDate) { try await fixture.rest.signal(.opened, triggerDay: "2026-10-08", matchDay: day) }
    }
    for signal in [JournalEchoSignal.opened, .useful] {
      await #expect(throws: JournalEchoFailure.invalidSignal) { try await fixture.rest.signal(signal, triggerDay: "2026-10-08", matchDay: nil) }
    }
    #expect(JournalEchoWireProtocol.state.withLock { $0.requests.isEmpty })
    #expect(fixture.telemetry.entries.withLock { $0.isEmpty })
  }

  @Test func anonymousAndPausedAccountsDoNotSendRequests() async throws {
    let fixture = try await fixture(.http(200, #"{"pages":[]}"#), signedIn: false)
    await #expect(throws: JournalEchoFailure.unavailable) { try await fixture.rest.list(through: "2026-10-08") }
    let identity = fixture.server.identity(email: "echo-rest@example.com")
    _ = try await fixture.runtime.engine.signIn(account: identity.account, token: identity.token)
    try fixture.server.revoke(identity.token)
    await fixture.runtime.engine.start()
    for _ in 0..<100 where !fixture.runtime.engine.status.authPaused { try await Task.sleep(for: .milliseconds(5)) }
    #expect(fixture.runtime.engine.status.authPaused)
    await #expect(throws: JournalEchoFailure.unavailable) { try await fixture.rest.list(through: "2026-10-08") }
    #expect(JournalEchoWireProtocol.state.withLock { $0.requests.isEmpty })
    #expect(fixture.telemetry.entries.withLock { $0.isEmpty })
  }

  @Test func knownOfflineDoesNotMakeAnHTTPCallAndReportsOnlyTheCoarseMetric() async throws {
    let fixture = try await fixture(.http(200, #"{"pages":[]}"#))
    try await goOffline(fixture)
    await #expect(throws: URLError(.notConnectedToInternet)) { try await fixture.rest.list(through: "2026-10-08") }
    #expect(JournalEchoWireProtocol.state.withLock { $0.requests.isEmpty })
    let entries = fixture.telemetry.entries.withLock { $0 }
    #expect(entries.map(\.name) == ["api_request_failed"])
    #expect(entries.map(\.properties) == [["operation": "journal_echoes", "route": "/v1/journal", "method": "GET", "failure_kind": "offline"]])
  }

  @Test(arguments: [URLError.Code.notConnectedToInternet, .networkConnectionLost, .timedOut, .secureConnectionFailed, .cancelled])
  func transportFailuresAreClassifiedWithoutLeakingErrorMessages(code: URLError.Code) async throws {
    let fixture = try await fixture(.failure(code))
    await #expect(throws: URLError.self) { try await fixture.rest.list(through: "2026-10-08") }
    let entries = fixture.telemetry.entries.withLock { $0 }
    let kind = [.notConnectedToInternet, .networkConnectionLost].contains(code) ? "offline" : code == .timedOut ? "timeout" : "tls"
    #expect(entries.map(\.name) == (code == .cancelled ? [] : kind == "offline" ? ["api_request_failed"] : ["api_request_failed", "client_error"]))
    if code != .cancelled {
      #expect(entries.first?.properties == ["operation": "journal_echoes", "route": "/v1/journal", "method": "GET", "failure_kind": kind])
    }
    #expect(!entries.contains { $0.properties.values.contains { $0.contains("private-marker") } })
  }

  @Test(arguments: [400, 401, 403, 404, 409, 410, 422, 429, 408, 500, 503])
  func HTTPRefusalsNeverConsumeOrReportTheResponseBody(status: Int) async throws {
    let fixture = try await fixture(.http(status, #"{"error":"private-marker","text":"private journal passage"}"#))
    await #expect(throws: JournalEchoFailure.http(status)) {
      try await fixture.rest.signal(.dismiss, triggerDay: "2026-10-08", matchDay: nil)
    }
    let entries = fixture.telemetry.entries.withLock { $0 }
    let unexpected = [408, 500, 503].contains(status)
    #expect(entries.map(\.name) == (unexpected ? ["api_request_failed", "client_error"] : ["api_request_failed"]))
    #expect(entries.first?.properties == ["operation": "journal_echoes", "route": "/v1/journal", "method": "POST", "failure_kind": "http", "status": String(status)])
    #expect(!entries.contains { $0.properties.values.contains { $0.contains("private") || $0.contains("2026") } })
  }

  @Test(arguments: ["private-marker", "{}", #"{"pages":[{"day":"2026-02-29","matches":[]}]}"#,
                    #"{"pages":[{"day":"2026-10-08","matches":[{"day":"private-marker","text":"private-marker"}]}]}"#])
  func malformedResponsesReportStaticDecodeFailure(body: String) async throws {
    let fixture = try await fixture(.http(200, body))
    await #expect(throws: (any Error).self) { try await fixture.rest.list(through: "2026-10-08") }
    let entries = fixture.telemetry.entries.withLock { $0 }
    #expect(entries.map(\.name) == ["api_request_failed", "client_error"])
    #expect(entries.first?.properties == ["operation": "journal_echoes", "route": "/v1/journal", "method": "GET", "failure_kind": "decode", "status": "200"])
    #expect(entries.last?.properties == ["operation": "journal_echoes", "failure_kind": "decode"])
  }

  @Test(.timeLimit(.minutes(1))) func aPartialBodyCannotKeepAnEchoRequestAlivePastItsDeadline() async throws {
    let fixture = try await fixture(.partial)
    let started = ContinuousClock.now
    await #expect(throws: URLError(.timedOut)) { try await fixture.rest.list(through: "2026-10-08") }
    #expect(started.duration(to: .now) < .seconds(20))
    let entries = fixture.telemetry.entries.withLock { $0 }
    #expect(entries.map(\.name) == ["api_request_failed", "client_error"])
    #expect(entries.first?.properties == ["operation": "journal_echoes", "route": "/v1/journal", "method": "GET", "failure_kind": "timeout"])
    await JournalEchoWireProtocol.firstStop()
    #expect(JournalEchoWireProtocol.state.withLock { $0.stopped } == 1)
  }

  @Test(.timeLimit(.minutes(1))) func callerCancellationStopsStalledIOWithoutFailureTelemetry() async throws {
    let fixture = try await fixture(.stalled)
    let task = Task { try await fixture.rest.list(through: "2026-10-08") }
    _ = try await activeRequest()
    task.cancel()
    await #expect(throws: CancellationError.self) { try await task.value }
    await JournalEchoWireProtocol.firstStop()
    #expect(JournalEchoWireProtocol.state.withLock { $0.stopped } == 1)
    #expect(fixture.telemetry.entries.withLock { $0.isEmpty })
  }

  @Test(arguments: ["account", "token", "paused", "offline"])
  func inFlightEchoesCannotCompleteAfterTheirAccountOrConnectionChanges(change: String) async throws {
    let fixture = try await fixture(.stalled)
    let task = Task { try await fixture.rest.list(through: "2026-10-08") }
    let transport = try await activeRequest()
    let account = try #require(try fixture.runtime.account())
    switch change {
    case "account":
      let signOut = try await fixture.runtime.engine.signOut()
      _ = try await signOut.finish(.keep)
      let identity = fixture.server.identity(email: "other-echo-rest@example.com")
      _ = try await fixture.runtime.engine.signIn(account: identity.account, token: identity.token)
    case "token": try fixture.runtime.tokens.save(SessionToken("replacement-token"), for: account)
    case "paused":
      try fixture.server.revoke(try #require(fixture.runtime.tokens.token(for: account)))
      await fixture.runtime.engine.start()
      for _ in 0..<100 where !fixture.runtime.engine.status.authPaused { try await Task.sleep(for: .milliseconds(5)) }
      #expect(fixture.runtime.engine.status.authPaused)
    default: try await goOffline(fixture)
    }
    transport.respond(200, #"{"pages":[{"day":"2026-10-08","matches":[{"day":"2026-09-01","text":"private-marker"}]}]}"#)
    if change == "offline" {
      await #expect(throws: URLError(.notConnectedToInternet)) { try await task.value }
      #expect(fixture.telemetry.entries.withLock { $0.map(\.name) } == ["api_request_failed"])
    } else {
      await #expect(throws: CancellationError.self) { try await task.value }
      #expect(fixture.telemetry.entries.withLock { $0.isEmpty })
    }
  }
}
