import Foundation
import Synchronization
import SyncCore
import SyncEngine
import SyncSchema

// A phone seeded on the model server, then launched against a network that never answers it the same way twice.
enum OfflineFixture {
  // What a launch meets: no network path, a refused connection, or a request that never answers.
  enum Mode: String, CaseIterable, Sendable {
    case noNetwork = "no-network", unreachable, stalled
  }

  nonisolated static var argument: String? {
    #if DEBUG && targetEnvironment(simulator)
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "-offline-fixture"), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
    #else
    return nil
    #endif
  }

  static func install() {
    #if DEBUG && targetEnvironment(simulator)
    if let mode = argument.flatMap(Mode.init) { _ = URLProtocol.registerClass(mode.loader) }
    #endif
  }

  static func runtime(settings: AppSettings, telemetry: any Telemetry) throws -> AppRuntime? {
    guard let mode = argument.flatMap(Mode.init) else { return nil }
    return try runtime(mode, settings: settings, telemetry: telemetry)
  }

  static func runtime(_ mode: Mode, settings: AppSettings, telemetry: any Telemetry,
                      directory: URL? = nil, service: String? = nil) throws -> AppRuntime? {
    #if DEBUG && targetEnvironment(simulator)
    guard let baseURL = settings.baseURL else { return nil }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [mode.loader]
    configuration.httpCookieStorage = nil
    let transport = HTTPTransport(baseURL: baseURL, schema: SyncSchema.version, configuration: configuration, telemetry: telemetry)
    return try AppRuntime(settings: settings, telemetry: telemetry, directory: directory, service: service, syncTransport: transport,
                          connectivity: FixedConnectivity(isOnline: mode != .noNetwork),
                          authSession: URLSession(configuration: configuration))
    #else
    return nil
    #endif
  }

  static func prepare(_ model: AppModel) async throws {
    guard let argument, argument.hasPrefix("seed-") else { return }
    try await seed(model, signedIn: argument == "seed-signed-in")
  }

  // The page, and when signed in the account, that the offline launch after it must find on the phone.
  static func seed(_ model: AppModel, signedIn: Bool) async throws {
    #if DEBUG && targetEnvironment(simulator)
    if signedIn, let server = model.runtime?.auth.fake {
      try await model.signIn(server.identity(email: "offline-fixture@example.com"))
    }
    model.openJournal()
    model.journal.type("Saved on this phone.")
    guard model.journal.save() else { throw AppFailure(message: "Offline fixture could not save its local page.") }
    model.journal.done(); model.journal.dismissScales()
    model.keepDismissed = true; model.preferences.set(true, forKey: "keepDismissed")
    model.sheet = nil
    #endif
  }
}

#if DEBUG && targetEnvironment(simulator)
extension OfflineFixture.Mode {
  var loader: URLProtocol.Type {
    switch self {
    case .noNetwork: NoNetworkLoader.self
    case .unreachable: UnreachableLoader.self
    case .stalled: StalledLoader.self
    }
  }
}

// Each mode's loader answers every request to offline.invalid with its failure, or never, and keeps the path of every
// request it met, so a launch can be seen asking.
nonisolated class OfflineLoader: URLProtocol, @unchecked Sendable {
  static let asked = Mutex<[String]>([])
  class var failure: URLError.Code? { nil }
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "offline.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    OfflineLoader.asked.withLock { $0.append(request.url?.path ?? "") }
    if let failure = Self.failure { client?.urlProtocol(self, didFailWithError: URLError(failure)) }
  }
  override func stopLoading() {}
}

nonisolated final class NoNetworkLoader: OfflineLoader, @unchecked Sendable {
  override class var failure: URLError.Code? { .notConnectedToInternet }
}

nonisolated final class UnreachableLoader: OfflineLoader, @unchecked Sendable {
  override class var failure: URLError.Code? { .cannotConnectToHost }
}

nonisolated final class StalledLoader: OfflineLoader, @unchecked Sendable {}
#endif
