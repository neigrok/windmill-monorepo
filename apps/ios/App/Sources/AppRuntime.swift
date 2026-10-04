import Foundation
import DomainKit
import JournalDomain
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
  let modelServer: Bool
  let fakeApple: Bool
  let appleEnabled: Bool
  let report: String?
  let scenario: String?
  let codeFile: String?
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
    modelServer = arguments.contains("-model-server") || arguments.contains("-fake-apple") || board != nil
    fakeApple = modelServer
    scenario = argument("scenario")
    report = argument("report")
    codeFile = argument("code-file")
    #else
    board = nil; modelServer = false; fakeApple = false; scenario = nil; report = nil; codeFile = nil
    #endif
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
  let runner: ActionRunner
  let auth: NativeAuth
  let lifecycle: AppLifecycle
  let tokens: any TokenStore
  let revocations: any TokenStore
  var revoking = false
  var lastRevocationAttempt = Date.distantPast
  var revocationOnline = false

  init(settings: AppSettings, telemetry: any Telemetry = NoopTelemetry()) throws {
    self.settings = settings; self.telemetry = telemetry
    let telemetry: any Telemetry = telemetry is NoopTelemetry ? telemetry : BoundedTelemetry(telemetry)
    let directory = URL.applicationSupportDirectory.appending(path: settings.board.map { "JournalBoards/\($0)" } ?? settings.scenario.map { "JournalVerification/\($0)" } ?? "WindmillSync")
    if settings.board != nil || settings.scenario != nil { try? FileManager.default.removeItem(at: directory) }
    let storage = try ProtectedStorage(directory: directory, telemetry: telemetry)
    do {
      store = try Store(path: storage.databasePath, registry: SyncSchema.registry,
                        commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    } catch {
      telemetry.failure("storage_open", kind: Store.failureKind(error) ?? "storage")
      throw error
    }
    let transport: any SyncTransport
    #if DEBUG
    if settings.modelServer {
      let model = JournalModelTransport(boardClock: settings.board != nil)
      transport = model
      auth = NativeAuth(baseURL: nil, fake: model, telemetry: telemetry)
    } else {
      transport = HTTPTransport(baseURL: settings.baseURL ?? URL(string: "http://127.0.0.1:1")!, schema: SyncSchema.version, telemetry: telemetry)
      auth = NativeAuth(baseURL: settings.baseURL, telemetry: telemetry)
    }
    #else
    transport = HTTPTransport(baseURL: settings.baseURL ?? URL(string: "http://127.0.0.1:1")!, schema: SyncSchema.version, telemetry: telemetry)
    auth = NativeAuth(baseURL: settings.baseURL, telemetry: telemetry)
    #endif
    let service = settings.board.map { "works.windmill.boards.\($0)" } ?? settings.scenario.map { "works.windmill.scenarios.\($0)" } ?? "works.windmill.app"
    tokens = KeychainTokenStore(service: service, telemetry: telemetry)
    revocations = KeychainTokenStore(service: service + ".signed-out-sessions", telemetry: telemetry)
    engine = try SyncEngine(config: EngineConfig(appVersion: "0.2.0", surface: .ios), store: store, transport: transport,
                            tokens: tokens,
                            forkGuard: storage.forkGuard, clock: EngineClock(wall: settings.board != nil ? BoardClock() : SystemClock(), sleeper: ContinuousClock()), random: SystemRandom(), connectivity: PathConnectivity(), telemetry: telemetry)
    runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: DeviceZone())
    lifecycle = AppLifecycle(engine: engine, signals: .application, time: ApplicationBackgroundTime())
    updateTelemetryIdentity()
  }

  init(settings: AppSettings, store: Store, engine: SyncEngine, auth: NativeAuth, runner: ActionRunner, tokens: any TokenStore, revocations: any TokenStore, telemetry: any Telemetry = NoopTelemetry()) {
    self.telemetry = telemetry
    self.settings = settings; self.store = store; self.engine = engine; self.auth = auth; self.runner = runner
    self.tokens = tokens; self.revocations = revocations
    lifecycle = AppLifecycle(engine: engine, signals: .application, time: ApplicationBackgroundTime())
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
}

nonisolated struct AppFailure: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

final class NativeAuth {
  let baseURL: URL?
  let telemetry: any Telemetry
  let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil
    return URLSession(configuration: configuration)
  }()
  #if DEBUG
  let fake: JournalModelTransport?
  init(baseURL: URL?, fake: JournalModelTransport? = nil, telemetry: any Telemetry = NoopTelemetry()) { self.baseURL = baseURL; self.fake = fake; self.telemetry = telemetry }
  #else
  init(baseURL: URL?, telemetry: any Telemetry = NoopTelemetry()) { self.baseURL = baseURL; self.telemetry = telemetry }
  #endif

  func requestCode(email: String) async throws {
    #if DEBUG
    if fake != nil { return }
    #endif
    _ = try await exchange("v1/auth/magic-link", operation: "auth_request_code", body: ["email": email, "door": "app"]) { $0 }
  }

  func verifyCode(email: String, code: String) async throws -> AuthIdentity {
    #if DEBUG
    if let fake {
      guard code == "482913" else { throw AppFailure(message: "That code has expired. Request a new code.") }
      return fake.identity(email: email)
    }
    #endif
    return try await exchange("v1/auth/verify-code", operation: "auth_verify_code", body: ["email": email, "code": code, "sessionTransport": "bearer"]) { try self.identity($0) }
  }

  func apple(identityToken: String, nonce: String, name: String) async throws -> AuthIdentity {
    return try await exchange("v1/auth/apple/native", operation: "auth_apple", body: ["identityToken": identityToken, "nonce": nonce, "name": name]) { try self.identity($0) }
  }

  func fakeApple() throws -> AuthIdentity {
    #if DEBUG
    if let fake { return fake.identity(email: "apple@example.com") }
    #endif
    throw AppFailure(message: "Simulator Apple sign-in requires the local model server.")
  }

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
    return AuthIdentity(account: id, token: SessionToken(token), name: (user["name"] as? String)?.nilIfEmpty ?? (user["email"] as? String)?.nilIfEmpty ?? "You")
  }

  func exchange<T>(_ path: String, operation: String, body: [String: String]?, token: SessionToken? = nil,
                   allowUnauthorized: Bool = false, decode: ([String: Any]) throws -> T) async throws -> T {
    let start = ContinuousClock.now
    var kind = "encode"
    var status: Int?
    do {
      guard let baseURL else { kind = "offline"; throw AppFailure(message: "Backup is not connected in this build. Your pages are saved on this phone.") }
      var request = URLRequest(url: baseURL.appending(path: path))
      request.httpMethod = "POST"
      if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
      if let token { request.setValue("Bearer " + token.value, forHTTPHeaderField: "Authorization") }
      kind = "transport"
      let (data, response) = try await session.data(for: request)
      guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
      status = response.statusCode
      if allowUnauthorized && (response.statusCode == 401 || response.statusCode == 204) { return try decode([:]) }
      guard (200..<300).contains(response.statusCode) else {
        kind = "http"
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
      var properties = ["method": "POST", "route": "/v1/auth", "operation": operation, "failure_kind": kind]
      if let status { properties["status"] = String(status) }
      telemetry.event("api_request_failed", properties: properties, durationMs: ms)
      if kind != "offline" && ![400, 401, 403, 404, 409, 422, 429].contains(status ?? 0) {
        telemetry.failure(operation, kind: kind, properties: properties, durationMs: ms)
      }
      throw error
    }
  }

}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
