import Foundation
import DomainKit
import JournalDomain
import GymDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncIOS
import SyncReplica
import SyncSchema
import SyncStore

nonisolated struct BoardClock: WallClock {
  func nowMs() -> Int64 { 1_790_424_000_000 }
  func reading() -> ClockReading {
    let live = SystemClock().reading()
    return ClockReading(wall: nowMs(), mono: live.mono, boot: live.boot)
  }
}

nonisolated struct DeviceZone: Zone {
  func offsetSeconds(at instant: Instant) -> Int {
    TimeZone.autoupdatingCurrent.secondsFromGMT(for: Date(timeIntervalSince1970: Double(instant.ms) / 1000))
  }
}

struct AppSettings {
  let baseURL: URL?
  let board: String?
  let restoreBoard: Bool
  let modelServer: Bool
  let fakeApple: Bool
  let appleFixture: String?
  let appleEnabled: Bool
  let report: String?
  let scenario: String?
  let codeFile: String?
  let automated: Bool
  let telemetryInfo: [String: Any]
  init(arguments: [String] = ProcessInfo.processInfo.arguments, bundle: Bundle = .main) {
    func argument(_ name: String) -> String? {
      guard let index = arguments.firstIndex(of: "-" + name), index + 1 < arguments.count else { return nil }
      return arguments[index + 1]
    }
    let configured = argument("server") ?? (bundle.object(forInfoDictionaryKey: "WMServerBaseURL") as? String ?? "")
    baseURL = configured.isEmpty ? nil : URL(string: configured)
    #if DEBUG && targetEnvironment(simulator)
    board = argument("board")
    restoreBoard = arguments.contains("-restore-board")
    modelServer = arguments.contains("-model-server") || arguments.contains("-fake-apple") || board != nil
    fakeApple = modelServer
    appleFixture = argument("apple-fixture")
    scenario = argument("scenario")
    report = argument("report")
    codeFile = argument("code-file")
    #else
    board = nil; restoreBoard = false; modelServer = false; fakeApple = false; appleFixture = nil; scenario = nil; report = nil; codeFile = nil
    #endif
    automated = modelServer || scenario != nil
    var info = bundle.infoDictionary ?? [:]
    #if DEBUG && targetEnvironment(simulator)
    if arguments.contains("-telemetry") { info["WMDebugTelemetry"] = "YES" }
    if let dsn = argument("sentry-dsn") { info["WMSentryDSN"] = dsn }
    if arguments.contains("-telemetry") { info["WMTelemetryEnvironment"] = "test" }
    #endif
    telemetryInfo = info
    appleEnabled = fakeApple || (baseURL != nil && bundle.object(forInfoDictionaryKey: "WMAppleSignInEnabled") as? String == "YES")
  }
}

final class AppRuntime {
  let settings: AppSettings
  let telemetry: any Telemetry
  let store: Store
  let engine: SyncEngine
  let gymBinding: GymBinding
  let runner: ActionRunner
  let auth: NativeAuth
  let lifecycle: AppLifecycle
  let tokens: any TokenStore
  let revocations: any TokenStore
  let hadInstallHistory: Bool
  let connectivity: (any Connectivity)?
  var revoking = false
  var lastRevocationAttempt = Date.distantPast
  var revocationOnline = false

  init(settings: AppSettings, telemetry: any Telemetry = NoopTelemetry(), directory: URL? = nil,
       service: String? = nil, syncTransport: (any SyncTransport)? = nil,
       connectivity: any Connectivity = PathConnectivity(), authSession: URLSession? = nil) throws {
    self.settings = settings; self.telemetry = telemetry
    gymBinding = GymBinding()
    self.connectivity = connectivity
    let telemetry: any Telemetry = telemetry is NoopTelemetry ? telemetry : BoundedTelemetry(telemetry)
    let storageDirectory = directory ?? URL.applicationSupportDirectory.appending(path: settings.board.map { "JournalBoards/\($0)" } ?? settings.scenario.map { "JournalVerification/\($0)" } ?? "WindmillSync")
    if directory == nil && ((settings.board != nil || settings.scenario != nil) && !settings.restoreBoard) { try? FileManager.default.removeItem(at: storageDirectory) }
    let keychainService = service ?? settings.board.map { "works.windmill.boards.\($0)" } ?? settings.scenario.map { "works.windmill.scenarios.\($0)" } ?? "works.windmill.app"
    tokens = KeychainTokenStore(service: keychainService, telemetry: telemetry)
    revocations = KeychainTokenStore(service: keychainService + ".signed-out-sessions", telemetry: telemetry)
    // Engine launch can prune credentials; preserve the phone's history before it mutates anything.
    hadInstallHistory = FileManager.default.fileExists(atPath: storageDirectory.path) ||
      !tokens.accounts().isEmpty || !revocations.accounts().isEmpty
    let storage = try ProtectedStorage(directory: storageDirectory, telemetry: telemetry)
    do {
      store = try Store(path: storage.databasePath, registry: SyncSchema.registry,
                        commandResultWrites: Self.commandResultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    } catch {
      telemetry.failure("storage_open", kind: Store.failureKind(error) ?? "storage")
      throw error
    }
    let transport: any SyncTransport
    let boardClock = settings.board != nil && settings.board?.hasPrefix("workout-live-activity") != true
    #if DEBUG
    if settings.modelServer {
      let snapshotURL = settings.scenario == "gym-e2e-conflict" ? storageDirectory.appending(path: "model-server.json") : nil
      let model = JournalModelTransport(boardClock: boardClock, snapshotURL: snapshotURL)
      if snapshotURL != nil, settings.restoreBoard { try model.restore() }
      model.state.withLock { state in
        if settings.appleFixture != nil || settings.board?.hasPrefix("23") == true || settings.board?.hasPrefix("24") == true {
          state.appleEmail = "sam@privaterelay.appleid.com"
        }
        if settings.appleFixture == "expired" { state.ticketLifetime = -1 }
        if settings.appleFixture == "offline" { state.offlineAfterApple = true }
        if settings.appleFixture == "hello-failure" { state.failHelloAfterApple = true }
        if settings.appleFixture == "taken" || settings.appleFixture == "empty" {
          state.emails["other@example.com"] = "model-other@example.com"
          state.appleDoors[state.appleSubject] = "model-other@example.com"
          state.appleEmails[state.appleSubject] = state.appleEmail
          if settings.appleFixture == "taken" { state.dataAccounts.insert("model-other@example.com") }
        }
      }
      transport = model
      auth = NativeAuth(baseURL: nil, fake: model, telemetry: telemetry)
    } else {
      transport = HTTPTransport(baseURL: settings.baseURL ?? URL(string: "http://127.0.0.1:1")!, schema: SyncSchema.version, telemetry: telemetry)
      auth = NativeAuth(baseURL: settings.baseURL, telemetry: telemetry, session: authSession)
    }
    #else
    transport = HTTPTransport(baseURL: settings.baseURL ?? URL(string: "http://127.0.0.1:1")!, schema: SyncSchema.version, telemetry: telemetry)
    auth = NativeAuth(baseURL: settings.baseURL, telemetry: telemetry, session: authSession)
    #endif
    engine = try SyncEngine(config: EngineConfig(appVersion: "0.2.0", surface: .ios), bindings: [gymBinding], store: store, transport: syncTransport ?? transport,
                            tokens: tokens,
                            forkGuard: storage.forkGuard, clock: EngineClock(wall: boardClock ? BoardClock() : SystemClock(), sleeper: ContinuousClock()), random: SystemRandom(), connectivity: connectivity, telemetry: telemetry)
    runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: DeviceZone())
    lifecycle = AppLifecycle(engine: engine, signals: .application, time: ApplicationBackgroundTime())
    updateTelemetryIdentity()
  }

  init(settings: AppSettings, store: Store, engine: SyncEngine, auth: NativeAuth, runner: ActionRunner, tokens: any TokenStore, revocations: any TokenStore, telemetry: any Telemetry = NoopTelemetry(), gymBinding: GymBinding = GymBinding()) {
    self.telemetry = telemetry
    self.gymBinding = gymBinding
    connectivity = nil
    self.settings = settings; self.store = store; self.engine = engine; self.auth = auth; self.runner = runner
    self.tokens = tokens; self.revocations = revocations
    hadInstallHistory = true
    lifecycle = AppLifecycle(engine: engine, signals: .application, time: ApplicationBackgroundTime())
  }

  nonisolated static let commandResultWrites: CommandResultDeviceWrites = { command, result, epoch, rows in
    JournalWriting.resultWrites(command, result, epoch, rows) + RoutineRemovalReceipt.resultWrites(command, result, epoch, rows)
  }

  func prepareRevocation(account: String) throws -> String? {
    guard let token = tokens.token(for: account) else { return nil }
    let key = UUID().uuidString
    let data = try JSONSerialization.data(withJSONObject: ["account": account, "token": token.value])
    try revocations.save(SessionToken(String(decoding: data, as: UTF8.self)), for: key)
    return key
  }

  func revokeSignedOutSessions(force: Bool = false) async {
    let online = engine.status.online
    defer { revocationOnline = online }
    guard !revoking, online, !revocations.accounts().isEmpty else { return }
    guard force || !revocationOnline || Date().timeIntervalSince(lastRevocationAttempt) >= 30 else { return }
    lastRevocationAttempt = Date()
    revoking = true
    defer { revoking = false }
    for key in revocations.accounts() {
      do {
        guard let saved = revocations.token(for: key),
              let item = try JSONSerialization.jsonObject(with: Data(saved.value.utf8)) as? [String: String],
              let account = item["account"], let value = item["token"] else { continue }
        let token = SessionToken(value)
        if try self.account() == account && tokens.token(for: account) == token { continue }
        try await auth.logout(token: token); try revocations.delete(for: key)
      } catch {}
    }
  }

  func updateTelemetryIdentity() {
    guard let telemetry = telemetry as? AppTelemetry else { return }
    do {
      let account = try account()
      telemetry.setIdentity(account: account, token: account.flatMap { tokens.token(for: $0) })
    } catch {
      telemetry.setIdentity(account: nil, token: nil)
      self.telemetry.event("auth_restore", properties: ["outcome": "failed"])
      if Store.failureKind(error) == nil { self.telemetry.failure("auth_restore", kind: "unexpected") }
    }
  }

  func storageRead<Value>(_ body: (StoreTransaction) throws -> Value) throws -> Value {
    do { return try store.read(body) }
    catch {
      if let kind = Store.failureKind(error) { telemetry.failure("storage_read", kind: kind) }
      throw error
    }
  }

  func account() throws -> String? {
    try storageRead { tx in
      let replica = try tx.device().activeReplica
      return replica.meta.state == .bound ? replica.meta.account : nil
    }
  }

  func hasKeptWork() throws -> Bool {
    try storageRead { tx in
      try tx.device().replicas.contains { replica in
        replica.meta.state == .dormant && (!replica.outbox.isEmpty || !store.pendingWork(in: replica).isEmpty)
      }
    }
  }
}

nonisolated struct AuthIdentity: Sendable {
  let account: String
  let token: SessionToken
  let name: String
  var email = ""
  var appleAttached = false
}

nonisolated struct AppleTicket: Sendable, Equatable {
  let secret: String
  let expiresAt: Date
}

nonisolated enum AppleAuthResponse: Sendable {
  case signedIn(AuthIdentity)
  case ticket(AppleTicket)
  case attached
}

nonisolated struct SignInMethod: Sendable, Equatable {
  let kind: String
  let email: String
  var relay = false
}

nonisolated struct AuthRefusal: Error, LocalizedError, Equatable {
  let code: String
  let message: String
  var errorDescription: String? { message }
  static let expired = AuthRefusal(code: "apple-ticket-expired", message: "Apple's sign-in lasts 15 minutes, and this one ran out. Nothing was created.")
  static let wrongCode = AuthRefusal(code: "invalid-code", message: "That code didn't work. Check the digits, or send a fresh one.")
  static let identityTaken = AuthRefusal(code: "identity-taken", message: "It opens another Windmill account with its own data. Windmill doesn't merge accounts. Remove Apple there first.")
  static let offline = AuthRefusal(code: "offline", message: "Sign-in needs a connection. Your work stays on this phone.")
}

nonisolated struct AppFailure: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

final class NativeAuth {
  let baseURL: URL?
  let telemetry: any Telemetry
  let session: URLSession
  static func nativeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil
    configuration.waitsForConnectivity = false
    configuration.timeoutIntervalForRequest = 8
    configuration.timeoutIntervalForResource = 15
    return URLSession(configuration: configuration)
  }

  nonisolated static func data(for request: URLRequest, session: URLSession) async throws -> (Data, URLResponse) {
    let operation = Task { try await session.data(for: request) }
    let deadline = Task {
      try await Task.sleep(for: .seconds(session.configuration.timeoutIntervalForResource))
      operation.cancel()
    }
    defer { deadline.cancel() }
    do {
      let response = try await withTaskCancellationHandler { try await operation.value } onCancel: { operation.cancel() }
      try Task.checkCancellation()
      return response
    } catch {
      try Task.checkCancellation()
      if operation.isCancelled { throw URLError(.timedOut) }
      throw error
    }
  }
  #if DEBUG
  let fake: JournalModelTransport?
  init(baseURL: URL?, fake: JournalModelTransport? = nil, telemetry: any Telemetry = NoopTelemetry(), session: URLSession? = nil) { self.baseURL = baseURL; self.fake = fake; self.telemetry = telemetry; self.session = session ?? Self.nativeSession() }
  #else
  init(baseURL: URL?, telemetry: any Telemetry = NoopTelemetry(), session: URLSession? = nil) { self.baseURL = baseURL; self.telemetry = telemetry; self.session = session ?? Self.nativeSession() }
  #endif

  func requestCode(email: String) async throws {
    #if DEBUG
    if let fake { try modelExchange("auth_request_code") { try fake.requestCode(email: email) }; return }
    #endif
    _ = try await exchange("v1/auth/magic-link", operation: "auth_request_code", body: ["email": email, "door": "app"]) { $0 }
  }

  func verifyCode(email: String, code: String, appleTicket: AppleTicket? = nil) async throws -> AuthIdentity {
    #if DEBUG
    if let fake { return try modelExchange("auth_verify_code") { try fake.verifyCode(email: email, code: code, ticket: appleTicket) } }
    #endif
    var body = ["email": email, "code": code, "sessionTransport": "bearer"]
    if let appleTicket { body["appleTicket"] = appleTicket.secret }
    return try await exchange("v1/auth/verify-code", operation: "auth_verify_code", body: body) {
      if appleTicket != nil, $0["appleAttached"] as? Bool != true { throw URLError(.cannotParseResponse) }
      return try self.identity($0)
    }
  }

  static func linkToken(_ input: String) throws -> String {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    let token: String
    if trimmed.contains("://") {
      guard let link = URLComponents(string: trimmed), ["https", "http"].contains(link.scheme),
            let value = link.queryItems?.first(where: { $0.name == "token" })?.value else {
        throw AppFailure(message: "Paste the full sign-in link or its token.")
      }
      token = value
    } else { token = trimmed }
    guard !token.isEmpty, token.count <= 1024,
          token.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-_".contains($0)) }) else {
      throw AppFailure(message: "Paste the full sign-in link or its token.")
    }
    return token
  }

  func verifyLink(_ input: String) async throws -> AuthIdentity {
    let token = try Self.linkToken(input)
    return try await exchange("v1/auth/verify", operation: "auth_verify_code",
                              body: ["token": token, "sessionTransport": "bearer"]) { try self.identity($0) }
  }

  func apple(identityToken: String, nonce: String, name: String, token: SessionToken? = nil) async throws -> AppleAuthResponse {
    return try await exchange("v1/auth/apple/native", operation: "auth_apple", body: ["identityToken": identityToken, "nonce": nonce, "name": name], token: token) { try self.appleResponse($0, attaching: token != nil) }
  }

  func authorizeFakeApple(token: SessionToken? = nil) throws -> AppleAuthResponse {
    #if DEBUG
    if let fake { return try modelExchange("auth_apple") { try fake.apple(token: token) } }
    #endif
    throw AppFailure(message: "Simulator Apple sign-in requires the local model server.")
  }

  // Existing lineage fixtures need an already-created Apple account.
  func fakeApple() throws -> AuthIdentity {
    #if DEBUG
    if let fake { return fake.identity(email: "apple@example.com") }
    #endif
    throw AppFailure(message: "Simulator Apple sign-in requires the local model server.")
  }

  func createApple(ticket: AppleTicket) async throws -> AuthIdentity {
    #if DEBUG
    if let fake { return try modelExchange("auth_apple_create") { try fake.createApple(ticket: ticket) } }
    #endif
    return try await exchange("v1/auth/apple/create", operation: "auth_apple_create", body: ["appleTicket": ticket.secret]) {
      guard $0["created"] as? Bool == true else { throw URLError(.cannotParseResponse) }
      return try self.identity($0)
    }
  }

  func signInMethods(token: SessionToken) async throws -> [SignInMethod] {
    #if DEBUG
    if let fake { return try modelExchange("auth_methods", method: "GET") { try fake.signInMethods(token: token) } }
    #endif
    return try await exchange("v1/me", operation: "auth_methods", body: nil, token: token, method: "GET") { body in
      guard let methods = body["signInMethods"] as? [[String: Any]] else { throw URLError(.cannotParseResponse) }
      return try methods.map { item in
        guard let kind = item["kind"] as? String, let email = item["email"] as? String else { throw URLError(.cannotParseResponse) }
        return SignInMethod(kind: kind, email: email, relay: item["relay"] as? Bool ?? false)
      }
    }
  }

  func removeApple(token: SessionToken) async throws {
    #if DEBUG
    if let fake {
      do { try modelExchange("auth_apple_remove", method: "DELETE") { try fake.removeApple(token: token) } }
      catch let refusal as AuthRefusal where refusal.code == "not-found" { return }
      return
    }
    #endif
    _ = try await exchange("v1/me/sign-in-methods/apple", operation: "auth_apple_remove", body: nil, token: token, allowNotFound: true, method: "DELETE") { $0 }
  }

  func appleResponse(_ body: [String: Any], attaching: Bool) throws -> AppleAuthResponse {
    guard body["created"] == nil || body["created"] as? Bool == false else {
      throw AppFailure(message: "Couldn't continue with Apple. Use email instead. Your pages stay on this phone.")
    }
    if attaching {
      guard body["attached"] as? Bool == true else { throw URLError(.cannotParseResponse) }
      return .attached
    }
    if let secret = body["appleTicket"] as? String, !secret.isEmpty, let expires = body["expiresAt"] as? NSNumber {
      return .ticket(AppleTicket(secret: secret, expiresAt: Date(timeIntervalSince1970: expires.doubleValue / 1000)))
    }
    return .signedIn(try identity(body))
  }

  #if DEBUG
  func modelExchange<Value>(_ operation: String, method: String = "POST", perform: () throws -> Value) throws -> Value {
    do { return try perform() }
    catch {
      let code = (error as? AuthRefusal)?.code ?? ""
      let status: Int? = switch code {
      case "apple-ticket-expired": 410
      case "identity-taken": 409
      case "no-account", "not-found": 404
      case "invalid-code", "unverified-email": 400
      case "unauthorized": 401
      default: nil
      }
      let kind = code == "offline" ? "offline" : status == nil ? "unexpected" : "http"
      var properties = ["operation": operation, "method": method, "route": operation == "auth_methods" || operation == "auth_apple_remove" ? "/v1/me" : "/v1/auth", "failure_kind": kind]
      if let status { properties["status"] = String(status) }
      telemetry.event("api_request_failed", properties: properties)
      if kind == "unexpected" { telemetry.failure(operation, kind: kind, properties: properties) }
      throw error
    }
  }
  #endif

  func logout(token: SessionToken) async throws {
    #if DEBUG
    if let fake { try fake.revoke(token); return }
    #endif
    _ = try await exchange("v1/auth/logout", operation: "auth_logout", body: nil, token: token, allowUnauthorized: true) { $0 }
  }

  func identity(_ body: [String: Any]) throws -> AuthIdentity {
    guard let user = body["user"] as? [String: Any], let id = user["id"] as? String,
          let token = body["session"] as? String, !token.isEmpty else {
      throw AppFailure(message: "Sign-in did not return a native session. Your pages are still on this phone.")
    }
    return AuthIdentity(account: id, token: SessionToken(token), name: (user["name"] as? String)?.nilIfEmpty ?? (user["email"] as? String)?.nilIfEmpty ?? "You", email: user["email"] as? String ?? "", appleAttached: body["appleAttached"] as? Bool ?? false)
  }

  func exchange<T>(_ path: String, operation: String, body: [String: String]?, token: SessionToken? = nil,
                   allowUnauthorized: Bool = false, allowNotFound: Bool = false, method: String = "POST", decode: ([String: Any]) throws -> T) async throws -> T {
    let start = ContinuousClock.now
    var kind = "encode"
    var status: Int?
    do {
      guard let baseURL else { kind = "offline"; throw AppFailure(message: "Backup is not connected in this build. Your pages are saved on this phone.") }
      var request = URLRequest(url: baseURL.appending(path: path))
      request.httpMethod = method
      if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
      if let token { request.setValue("Bearer " + token.value, forHTTPHeaderField: "Authorization") }
      kind = "transport"
      let (data, response) = try await Self.data(for: request, session: session)
      guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
      status = response.statusCode
      if response.statusCode == 204 || (allowUnauthorized && response.statusCode == 401) || (allowNotFound && response.statusCode == 404) { return try decode([:]) }
      guard (200..<300).contains(response.statusCode) else {
        kind = "http"
        let refusal = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let code = refusal["code"] as? String ?? ""
        if code == "apple-ticket-expired" { throw AuthRefusal.expired }
        if code == "identity-taken" { throw AuthRefusal.identityTaken }
        if code == "no-account" { throw AuthRefusal(code: code, message: "No account at this email") }
        if path == "v1/auth/verify-code", [400, 401, 422].contains(response.statusCode) { throw AuthRefusal.wrongCode }
        if let message = refusal["error"] as? String, !message.isEmpty {
          let detail = refusal["detail"] as? String ?? ""
          throw AuthRefusal(code: code, message: message + (detail.isEmpty ? "" : ". " + detail))
        }
        throw AppFailure(message: "Can't complete sign-in right now. Your writing is still on this phone.")
      }
      kind = "decode"
      guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw URLError(.cannotParseResponse) }
      return try decode(result)
    } catch {
      if error is CancellationError { throw error }
      if let failure = error as? URLError {
        if failure.code == .cancelled { throw error }
        if [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost].contains(failure.code) { kind = "offline" }
        if failure.code == .timedOut { kind = "timeout" }
        if [.secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired].contains(failure.code) { kind = "tls" }
      }
      let elapsed = start.duration(to: .now).components
      let ms = elapsed.seconds * 1_000 + elapsed.attoseconds / 1_000_000_000_000_000
      var properties = ["method": method, "route": path.hasPrefix("v1/me") ? "/v1/me" : "/v1/auth", "operation": operation, "failure_kind": kind]
      if let status { properties["status"] = String(status) }
      telemetry.event("api_request_failed", properties: properties, durationMs: ms)
      if kind != "offline" && ![400, 401, 403, 404, 409, 410, 422, 429].contains(status ?? 0) {
        telemetry.failure(operation, kind: kind, properties: properties, durationMs: ms)
      }
      throw error
    }
  }

}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
