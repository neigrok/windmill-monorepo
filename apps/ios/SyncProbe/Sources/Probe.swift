import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncIOS
import SyncReplica
import SyncStore

// The probe app's composition (design §10): the real engine and every SyncIOS adapter (Keychain tokens, the protected
// store and fork guard, the app lifecycle) over the probe product alone, the registry `windmill_server_probe` serves,
// talking HTTP to the local backend through the faults in front of the network and the device clock. The log records
// what the transport and the lifecycle's background time did.
final class Probe {
  let settings: LaunchSettings
  let registry: Registry
  let storage: ProtectedStorage
  let store: Store
  let clock: FaultClock
  let log = ProbeLog()
  let transport: FaultInjectingTransport
  let tokens: KeychainTokenStore
  let engine: SyncEngine
  let lifecycle: AppLifecycle
  let events: EventRecorder

  init(settings: LaunchSettings) throws {
    self.settings = settings
    registry = try Self.probeRegistry()
    storage = try ProtectedStorage.standard()
    store = try Store(path: storage.databasePath, registry: registry, limits: Limits(holdMs: settings.holdMs))
    clock = FaultClock(skewMs: settings.skewMs)
    transport = FaultInjectingTransport(HTTPTransport(baseURL: settings.backend, schema: registry.version), log: log)
    tokens = KeychainTokenStore()
    engine = try SyncEngine(
      config: EngineConfig(appVersion: "probe", surface: .ios), store: store, transport: transport, tokens: tokens,
      forkGuard: storage.forkGuard, clock: EngineClock(wall: clock, sleeper: ContinuousClock()), random: SystemRandom(),
      connectivity: transport.connectivity)
    lifecycle = AppLifecycle(engine: engine, signals: .application, time: RecordedBackgroundTime(ApplicationBackgroundTime(), log: log))
    events = EventRecorder(engine.events())
    try reauthenticate()
  }

  // The registry the app carries as a resource: probe.registry.json from the sync contract.
  static func probeRegistry() throws -> Registry {
    guard let url = Bundle.main.url(forResource: "probe.registry", withExtension: "json") else {
      throw ProbeError("the app carries no probe.registry.json")
    }
    return try Registry(json: JSON(parsing: [UInt8](try Data(contentsOf: url))))
  }

  // Dev sign-in by launch arguments: a replica bound to `-account` takes `-token` as its session token, which clears a
  // pause a 401 set. A replica signed out waits for `signIn()`, so a scenario chooses when.
  func reauthenticate() throws {
    let bound = try boundAccount()
    log.record([
      "kind": "launch", "account": settings.account.map(JSON.string) ?? .null, "token": .bool(settings.token != nil),
      "bound": bound.map(JSON.string) ?? .null,
    ])
    guard let account = settings.account, let token = settings.token, bound == account else { return }
    try engine.reauthenticate(token: SessionToken(token))
  }

  func signIn() async throws -> SignInSession {
    guard let account = settings.account, let token = settings.token else { throw ProbeError("no -account and -token to sign in with") }
    return try await engine.signIn(account: account, token: SessionToken(token))
  }

  // MARK: The store as it stands

  // Every replica, whole: meta, outbox, rows, cursors, known scopes and notices.
  func snapshot() throws -> LoadedDevice {
    try store.read { try $0.device(rows: true) }
  }

  func active() throws -> LoadedReplica {
    try snapshot().activeReplica
  }

  func boundAccount() throws -> String? {
    let meta = try active().meta
    return meta.state == .bound ? meta.account : nil
  }
}

// What the app was launched with: `-name value` pairs. Each name takes the argument after it verbatim, since a session
// token may begin with "-", which UserDefaults' argument domain would read as the next name. `-foreignToken` is another
// account's session token, which a scenario holds as `-account`'s.
struct LaunchSettings {
  let scenario: String?
  let report: URL?
  let signals: URL?
  let account: String?
  let token: String?
  let foreignToken: String?
  let backend: URL
  let skewMs: Int64
  let holdMs: Int64

  init(arguments: [String] = ProcessInfo.processInfo.arguments) {
    var values: [String: String] = [:]
    var index = 1
    while index + 1 < arguments.count {
      guard arguments[index].hasPrefix("-") else {
        index += 1
        continue
      }
      values[String(arguments[index].dropFirst())] = arguments[index + 1]
      index += 2
    }
    scenario = values["scenario"]
    report = values["report"].map { URL(fileURLWithPath: $0) }
    signals = values["signals"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? report?.deletingLastPathComponent()
    account = values["account"]
    token = values["token"]
    foreignToken = values["foreignToken"]
    backend = values["backend"].flatMap(URL.init(string:)) ?? URL(string: "http://127.0.0.1:8089")!
    skewMs = values["skewMs"].flatMap { Int64($0) } ?? 0
    holdMs = values["holdMs"].flatMap { Int64($0) } ?? Constants.holdMs
  }
}

// Every event the engine publishes from launch on, in order: terminal outcomes and telemetry.
final class EventRecorder {
  private(set) var events: [JSON] = []

  init(_ stream: AsyncStream<EngineEvent>) {
    Task { [weak self] in
      for await event in stream { self?.events.append(event.json) }
    }
  }
}

struct ProbeError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}
