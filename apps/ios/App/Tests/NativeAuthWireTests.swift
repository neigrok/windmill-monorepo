import Foundation
import Testing
import Synchronization
import SyncReplica
import SyncCore
import SyncEngine
@testable import Windmill

nonisolated final class AuthWireProtocol: URLProtocol, @unchecked Sendable {
  struct Request: Sendable { let path: String; let method: String; let authorization: String?; let body: Data? }
  struct State: Sendable { var replies: [(Int, String)] = []; var requests: [Request] = []; var stalled = false; var stopped = 0 }
  static let state = Mutex(State())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var body = request.httpBody
    if body == nil, let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(contentsOf: buffer.prefix(count)) }
      body = data
    }
    let captured = Request(path: request.url!.path, method: request.httpMethod!, authorization: request.value(forHTTPHeaderField: "Authorization"), body: body)
    let reply = Self.state.withLock { state -> (Int, String)? in
      state.requests.append(captured)
      return state.stalled ? nil : state.replies.removeFirst()
    }
    guard let reply else { return }
    let response = HTTPURLResponse(url: request.url!, statusCode: reply.0, httpVersion: nil, headerFields: ["Set-Cookie": "session=never-retain; Path=/"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(reply.1.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() { Self.state.withLock { $0.stopped += 1 } }
}

@Suite(.serialized) @MainActor struct NativeAuthWireTests {
  @Test func repeatedSubmitCannotReplaceTheRequestCancelledByClose() async throws {
    AuthWireProtocol.state.withLock { $0 = AuthWireProtocol.State(stalled: true) }
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [AuthWireProtocol.self]
    let auth = NativeAuth(baseURL: URL(string: "https://auth.invalid")!, session: URLSession(configuration: config))
    let model = try LineageFlowTests().fixture(JournalModelTransport(), auth: auth)
    model.sheet = .address; model.email = "offline@example.com"
    model.performAuthentication { await model.sendCode() }
    let first = try #require(model.authTask)
    while AuthWireProtocol.state.withLock({ $0.requests.isEmpty }) { await Task.yield() }
    model.performAuthentication { await model.sendCode() }
    model.cancelAuthentication(); model.sheet = nil
    await first.value
    for _ in 0..<100 {
      if AuthWireProtocol.state.withLock({ $0.stopped > 0 }) { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(AuthWireProtocol.state.withLock { $0.requests.count } == 1)
    #expect(AuthWireProtocol.state.withLock { $0.stopped } == 1)
    #expect(model.sheet == nil && !model.editorReadOnly && model.codeSentAt == nil && model.authTask == nil)
  }

  @Test(arguments: [false, true]) func unansweredAuthenticationTimesOutOrCancelsWithoutAStaleSheet(cancel: Bool) async throws {
    AuthWireProtocol.state.withLock { $0 = AuthWireProtocol.State(stalled: true) }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [AuthWireProtocol.self]
    config.timeoutIntervalForResource = cancel ? 10 : 0.05
    let auth = NativeAuth(baseURL: URL(string: "https://auth.invalid")!, session: URLSession(configuration: config))
    let model = try LineageFlowTests().fixture(JournalModelTransport(), auth: auth)
    model.sheet = .address; model.email = "private-marker@example.com"
    let started = ContinuousClock.now
    let request = Task { await model.sendCode() }
    model.authTask = request
    while AuthWireProtocol.state.withLock({ $0.requests.isEmpty }) { await Task.yield() }
    if cancel { model.cancelAuthentication(); model.sheet = nil }
    await request.value
    #expect(started.duration(to: .now) < .seconds(1))
    #expect(!model.working && !model.editorReadOnly && model.codeSentAt == nil)
    #expect(model.sheet == (cancel ? nil : .address))
    #expect(model.error == (cancel ? nil : AuthRefusal.offline.message))
    for _ in 0..<100 {
      if AuthWireProtocol.state.withLock({ $0.stopped > 0 }) { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(AuthWireProtocol.state.withLock { $0.stopped } == 1)
  }

  func auth(replies: [(Int, String)], telemetry: TelemetryRecorder = TelemetryRecorder()) -> NativeAuth {
    AuthWireProtocol.state.withLock { $0 = AuthWireProtocol.State(replies: replies) }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [AuthWireProtocol.self]; config.httpShouldSetCookies = false; config.httpCookieStorage = nil
    return NativeAuth(baseURL: URL(string: "https://auth.invalid")!, telemetry: telemetry, session: URLSession(configuration: config))
  }

  @Test func pastedLinkAndTokenUseNativeBearerDoorAndPreserveExpiryRefusal() async throws {
    let wire = auth(replies: [(200, #"{"user":{"id":"account","email":"sam@example.com"},"session":"native-secret"}"#), (410, #"{"code":"expired","error":"That link has expired","detail":"Links work once and last 15 minutes."}"#)])
    #expect(try NativeAuth.linkToken(" https://windmill.works/auth/verify?token=abc_123 ") == "abc_123")
    #expect(try NativeAuth.linkToken("abc-123") == "abc-123")
    #expect(throws: AppFailure.self) { try NativeAuth.linkToken("https://windmill.works/?email=private") }
    #expect(throws: AppFailure.self) { try NativeAuth.linkToken("abc secret") }
    #expect(try await wire.verifyLink("https://windmill.works/auth/verify?token=abc_123").token == SessionToken("native-secret"))
    do { _ = try await wire.verifyLink("abc_123"); Issue.record("Accepted spent link") }
    catch let failure as AuthRefusal { #expect(failure.code == "expired" && failure.message == "That link has expired. Links work once and last 15 minutes.") }
    let requests = AuthWireProtocol.state.withLock { $0.requests }
    #expect(requests.map(\.path) == ["/v1/auth/verify", "/v1/auth/verify"])
    #expect(try JSONSerialization.jsonObject(with: requests[0].body!) as? [String: String] == ["token": "abc_123", "sessionTransport": "bearer"])
  }

  @Test func ticketCreateCodeAttachMeAndDeleteUsePinnedWireAndBearer() async throws {
    let success = #"{"user":{"id":"account","email":"sam@example.com","name":"Sam"},"session":"body-session","created":true}"#
    let linked = #"{"user":{"id":"account","email":"sam@example.com","name":"Sam"},"session":"linked-session","appleAttached":true}"#
    let auth = auth(replies: [(200, #"{"appleTicket":"memory-secret","expiresAt":1790000000000}"#), (200, success), (200, linked), (200, #"{"attached":true}"#), (200, #"{"signInMethods":[{"kind":"email","email":"sam@example.com"},{"kind":"apple","email":"relay@privaterelay.appleid.com","relay":true}]}"#), (204, "")])
    guard case .ticket(let ticket) = try await auth.apple(identityToken: "identity-secret", nonce: "nonce-secret", name: "Sam") else { Issue.record("Expected ticket"); return }
    #expect(ticket.secret == "memory-secret" && ticket.expiresAt == Date(timeIntervalSince1970: 1790000000))
    #expect(try await auth.createApple(ticket: ticket).account == "account")
    let identity = try await auth.verifyCode(email: "sam@example.com", code: "482913", appleTicket: ticket)
    #expect(identity.appleAttached && identity.email == "sam@example.com")
    guard case .attached = try await auth.apple(identityToken: "identity-secret", nonce: "nonce-secret", name: "Sam", token: identity.token) else { Issue.record("Expected attached"); return }
    #expect(try await auth.signInMethods(token: identity.token) == [SignInMethod(kind: "email", email: "sam@example.com"), SignInMethod(kind: "apple", email: "relay@privaterelay.appleid.com", relay: true)])
    try await auth.removeApple(token: identity.token)
    let requests = AuthWireProtocol.state.withLock { $0.requests }
    #expect(requests.map(\.path) == ["/v1/auth/apple/native", "/v1/auth/apple/create", "/v1/auth/verify-code", "/v1/auth/apple/native", "/v1/me", "/v1/me/sign-in-methods/apple"])
    #expect(requests.map(\.method) == ["POST", "POST", "POST", "POST", "GET", "DELETE"])
    #expect(requests.map(\.authorization) == [nil, nil, nil, "Bearer linked-session", "Bearer linked-session", "Bearer linked-session"])
    #expect(try JSONSerialization.jsonObject(with: requests[1].body!) as? [String: String] == ["appleTicket": "memory-secret"])
    #expect(try JSONSerialization.jsonObject(with: requests[2].body!) as? [String: String] == ["appleTicket": "memory-secret", "email": "sam@example.com", "code": "482913", "sessionTransport": "bearer"])
    #expect(auth.session.configuration.httpCookieStorage == nil && !auth.session.configuration.httpShouldSetCookies)
  }

  @Test func expectedRefusalsUseSpecificCopyAndSafeMetricsOnly() async throws {
    let recorder = TelemetryRecorder()
    let auth = auth(replies: [(410, #"{"code":"apple-ticket-expired","error":"secret-marker"}"#), (409, #"{"code":"identity-taken","error":"secret-marker"}"#), (400, #"{"error":"secret-marker"}"#), (404, #"{"code":"no-account","error":"secret-marker"}"#), (429, #"{"error":"Too many attempts","detail":"Try again later"}"#)], telemetry: recorder)
    let ticket = AppleTicket(secret: "secret-marker", expiresAt: .distantFuture)
    do { _ = try await auth.createApple(ticket: ticket); Issue.record("Accepted expired ticket") }
    catch let failure as AuthRefusal { #expect(failure == .expired) }
    do { _ = try await auth.apple(identityToken: "secret-marker", nonce: "secret-marker", name: "secret-marker", token: SessionToken("secret-marker")); Issue.record("Accepted taken identity") }
    catch let failure as AuthRefusal { #expect(failure == .identityTaken) }
    do { _ = try await auth.verifyCode(email: "secret-marker", code: "123456", appleTicket: ticket); Issue.record("Accepted code") }
    catch let failure as AuthRefusal { #expect(failure == .wrongCode) }
    do { _ = try await auth.verifyCode(email: "secret-marker", code: "482913", appleTicket: ticket); Issue.record("Created account") }
    catch let failure as AuthRefusal { #expect(failure.code == "no-account") }
    do { try await auth.requestCode(email: "secret-marker"); Issue.record("Accepted rate limit") }
    catch let failure as AuthRefusal { #expect(failure.message == "Too many attempts. Try again later") }
    let entries = recorder.entries.withLock { $0 }
    #expect(entries.map(\.name) == Array(repeating: "api_request_failed", count: 5))
    #expect(entries.map { $0.properties["status"] } == ["410", "409", "400", "404", "429"])
    #expect(!entries.contains { $0.properties.values.contains { $0.contains("secret-marker") } })
  }

  @Test(arguments: ["true", "\"true\"", "null"]) func legacyCreatedAppleSessionIsRefusedBeforeEngineOrAdoption(created: String) async throws {
    let server = JournalModelTransport(), recorder = TelemetryRecorder()
    let wire = auth(replies: [(200, "{\"user\":{\"id\":\"legacy-account\",\"email\":\"relay@privaterelay.appleid.com\",\"name\":\"Sam\"},\"session\":\"legacy-secret\",\"created\":\(created)}")], telemetry: recorder)
    let model = try LineageFlowTests().fixture(server)
    model.journal.type("Keep this local page"); model.journal.done(); model.sheet = .keep
    let before = server.state.withLock { $0.server.state }
    await model.authenticateApple { token in try await wire.apple(identityToken: "identity-secret", nonce: "nonce", name: "Sam", token: token) }
    #expect(model.account == nil && model.pendingSignIn == nil && model.signInSession == nil && model.sheet == .keep)
    #expect(model.appleTicket == nil && model.journal.document.body == "Keep this local page" && model.error != nil)
    #expect(try model.runtime!.store.read { try $0.device().meta.pendingSignIn } == nil)
    #expect(server.state.withLock { $0.server.state == before && $0.sessions.isEmpty && $0.appleDoors.isEmpty })
    #expect(recorder.entries.withLock { !$0.isEmpty && !$0.contains { $0.properties.values.contains { $0.contains("secret") } } })
  }

  @Test func appleDoorAcceptsRealMatchedAndTicketShapes() async throws {
    let wire = auth(replies: [
      (200, #"{"user":{"id":"matched","email":"sam@example.com"},"session":"matched-session","created":false}"#),
      (200, #"{"user":{"id":"matched","email":"sam@example.com"},"session":"matched-session"}"#),
      (200, #"{"appleTicket":"unmatched-ticket","expiresAt":1790000000000}"#)
    ])
    for _ in 0..<2 {
      guard case .signedIn(let identity) = try await wire.apple(identityToken: "identity", nonce: "nonce", name: "") else { Issue.record("Matched account refused"); return }
      #expect(identity.account == "matched" && identity.token.value == "matched-session")
    }
    guard case .ticket(let ticket) = try await wire.apple(identityToken: "identity", nonce: "nonce", name: "") else { Issue.record("Unmatched account did not return ticket"); return }
    #expect(ticket.secret == "unmatched-ticket")
  }

  @Test func removal404IsAlreadyRemovedEvenWithoutAJSONBody() async throws {
    let wire = auth(replies: [(404, ""), (404, #"{"error":"Apple is not linked"}"#), (204, "")])
    for _ in 0..<3 { try await wire.removeApple(token: SessionToken("caller")) }
    #expect(AuthWireProtocol.state.withLock { $0.requests.allSatisfy { $0.method == "DELETE" && $0.authorization == "Bearer caller" } })
  }

  @Test func restoredPausedAccountWithoutEmailVerifiesIDBeforeBearerAttach() async throws {
    let server = JournalModelTransport(), owner = server.identity(email: "sam@example.com")
    let wire = auth(replies: [
      (200, #"{"appleTicket":"memory-ticket","expiresAt":1990000000000}"#),
      (200, "{}"),
      (200, #"{"user":{"id":"model-other@example.com","email":"other@example.com"},"session":"wrong-session","created":false}"#),
      (204, ""), (200, "{}"),
      (200, #"{"user":{"id":"model-sam@example.com","email":"sam@example.com"},"session":"verified-caller","created":false}"#),
      (200, #"{"attached":true}"#)
    ])
    let original = try LineageFlowTests().fixture(server, auth: wire)
    try await original.signIn(owner); original.journal.type("Account writing"); original.journal.done()
    let runtime = try #require(original.runtime)
    try server.revoke(owner.token); await runtime.engine.start()
    original.preferences.removeObject(forKey: "accountEmail:\(owner.account)")
    let model = try AppModel(runner: runtime.runner, preferences: original.preferences, runtime: runtime)
    let replica = try runtime.store.read { try $0.device().activeReplica.meta.replica }
    #expect(model.authPaused && model.accountEmail.isEmpty)
    model.sheet = .you
    await model.authenticateApple { token in try await wire.apple(identityToken: "identity", nonce: "nonce", name: "", token: token) }
    model.email = "other@example.com"; await model.sendCode(); model.code = "482913"; await model.verifyCode()
    #expect(model.account == owner.account && model.pendingSignIn == nil && model.appleTicket != nil && model.error != nil)
    #expect(server.state.withLock { $0.appleDoors.isEmpty })
    #expect(AuthWireProtocol.state.withLock { $0.requests.count == 4 && $0.requests.last?.path == "/v1/auth/logout" })
    server.state.withLock { $0.sessions["verified-caller"] = owner.account }
    model.sheet = .appleAddress; model.email = "sam@example.com"
    await model.sendCode(); model.code = "482913"; await model.verifyCode()
    #expect(model.account == owner.account && model.sheet == nil && model.appleTicket == nil && model.pendingSignIn == nil)
    #expect(try runtime.store.read { try $0.device().activeReplica.meta.replica } == replica)
    let requests = AuthWireProtocol.state.withLock { $0.requests }
    for index in [2, 5] {
      let body = try #require(try JSONSerialization.jsonObject(with: requests[index].body!) as? [String: String])
      #expect(body["appleTicket"] == nil && body["sessionTransport"] == "bearer")
    }
    #expect(requests[6].path == "/v1/auth/apple/native" && requests[6].authorization == "Bearer verified-caller")
  }
}
