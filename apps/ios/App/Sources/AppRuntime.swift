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
    appleEnabled = fakeApple || (baseURL != nil && bundle.object(forInfoDictionaryKey: "WMAppleSignInEnabled") as? String == "YES")
  }
}

final class AppRuntime {
  let settings: AppSettings
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

  init(settings: AppSettings) throws {
    self.settings = settings
    let directory = URL.applicationSupportDirectory.appending(path: settings.board.map { "JournalBoards/\($0)" } ?? settings.scenario.map { "JournalVerification/\($0)" } ?? "WindmillSync")
    if settings.board != nil || settings.scenario != nil { try? FileManager.default.removeItem(at: directory) }
    let storage = try ProtectedStorage(directory: directory)
    store = try Store(path: storage.databasePath, registry: SyncSchema.registry,
                      commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let transport: any SyncTransport
    #if DEBUG
    if settings.modelServer {
      let model = JournalModelTransport(boardClock: settings.board != nil)
      transport = model
      auth = NativeAuth(baseURL: nil, fake: model)
    } else {
      transport = HTTPTransport(baseURL: settings.baseURL ?? URL(string: "http://127.0.0.1:1")!, schema: SyncSchema.version)
      auth = NativeAuth(baseURL: settings.baseURL)
    }
    #else
    transport = HTTPTransport(baseURL: settings.baseURL ?? URL(string: "http://127.0.0.1:1")!, schema: SyncSchema.version)
    auth = NativeAuth(baseURL: settings.baseURL)
    #endif
    let service = settings.board.map { "works.windmill.boards.\($0)" } ?? settings.scenario.map { "works.windmill.scenarios.\($0)" } ?? "works.windmill.app"
    tokens = KeychainTokenStore(service: service)
    revocations = KeychainTokenStore(service: service + ".signed-out-sessions")
    engine = try SyncEngine(config: EngineConfig(appVersion: "0.2.0", surface: .ios), store: store, transport: transport,
                            tokens: tokens,
                            forkGuard: storage.forkGuard, clock: EngineClock(wall: settings.board != nil ? BoardClock() : SystemClock(), sleeper: ContinuousClock()), random: SystemRandom(), connectivity: PathConnectivity())
    runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: DeviceZone())
    lifecycle = AppLifecycle(engine: engine, signals: .application, time: ApplicationBackgroundTime())
  }

  init(settings: AppSettings, store: Store, engine: SyncEngine, auth: NativeAuth, runner: ActionRunner, tokens: any TokenStore, revocations: any TokenStore) {
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

  func account() throws -> String? {
    try store.read { tx in
      let replica = try tx.device().activeReplica
      return replica.meta.state == .bound ? replica.meta.account : nil
    }
  }

  func hasKeptWork() throws -> Bool {
    try store.read { tx in
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
  let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil
    return URLSession(configuration: configuration)
  }()
  #if DEBUG
  let fake: JournalModelTransport?
  init(baseURL: URL?, fake: JournalModelTransport? = nil) { self.baseURL = baseURL; self.fake = fake }
  #else
  init(baseURL: URL?) { self.baseURL = baseURL }
  #endif

  func requestCode(email: String) async throws {
    #if DEBUG
    if fake != nil { return }
    #endif
    _ = try await post("v1/auth/magic-link", ["email": email, "door": "app"])
  }

  func verifyCode(email: String, code: String) async throws -> AuthIdentity {
    #if DEBUG
    if let fake {
      guard code == "482913" else { throw AppFailure(message: "That code has expired. Request a new code.") }
      return fake.identity(email: email)
    }
    #endif
    return try identity(await post("v1/auth/verify-code", ["email": email, "code": code, "sessionTransport": "bearer"]))
  }

  func apple(identityToken: String, nonce: String, name: String) async throws -> AuthIdentity {
    return try identity(await post("v1/auth/apple/native", ["identityToken": identityToken, "nonce": nonce, "name": name]))
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
    guard let baseURL else { throw AppFailure(message: "Session revocation is waiting for a network connection.") }
    var request = URLRequest(url: baseURL.appending(path: "v1/auth/logout"))
    request.httpMethod = "POST"; request.setValue("Bearer " + token.value, forHTTPHeaderField: "Authorization")
    let (_, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) || response.statusCode == 401 else {
      throw AppFailure(message: "Session revocation is waiting for a network connection.")
    }
  }

  func identity(_ body: [String: Any]) throws -> AuthIdentity {
    guard let user = body["user"] as? [String: Any], let id = user["id"] as? String,
          let token = body["session"] as? String, !token.isEmpty else {
      throw AppFailure(message: "Sign-in did not return a native session. Your pages are still on this phone.")
    }
    return AuthIdentity(account: id, token: SessionToken(token), name: (user["name"] as? String)?.nilIfEmpty ?? (user["email"] as? String)?.nilIfEmpty ?? "You")
  }

  func post(_ path: String, _ body: [String: String]) async throws -> [String: Any] {
    guard let baseURL else { throw AppFailure(message: "Backup is not connected in this build. Your pages are saved on this phone.") }
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await session.data(for: request)
    let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
      throw AppFailure(message: [result["error"], result["detail"]].compactMap { $0 as? String }.joined(separator: " ").nilIfEmpty ?? "Can't reach windmill.works. Your writing is still on this phone.")
    }
    return result
  }
}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
