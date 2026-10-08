import Foundation
import SyncCore
import SyncEngine
import SyncSchema

enum OfflineFixture {
  nonisolated static var mode: String? {
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
    if let mode, !mode.hasPrefix("seed-"), mode != "black-hole" { _ = URLProtocol.registerClass(OfflineFixtureProtocol.self) }
    #endif
  }

  static func runtime(settings: AppSettings, telemetry: any Telemetry) throws -> AppRuntime? {
    #if DEBUG && targetEnvironment(simulator)
    guard let mode, !mode.hasPrefix("seed-"), mode != "black-hole", let baseURL = settings.baseURL else { return nil }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [OfflineFixtureProtocol.self]
    configuration.httpCookieStorage = nil
    let transport = HTTPTransport(baseURL: baseURL, schema: SyncSchema.version, configuration: configuration, telemetry: telemetry)
    return try AppRuntime(settings: settings, telemetry: telemetry, syncTransport: transport,
                          connectivity: OfflineFixtureConnectivity(isOnline: mode != "no-network"),
                          authSession: URLSession(configuration: configuration))
    #else
    return nil
    #endif
  }

  static func prepare(_ model: AppModel) async throws {
    #if DEBUG && targetEnvironment(simulator)
    guard let mode, mode.hasPrefix("seed-") else { return }
    if mode == "seed-signed-in", let server = model.runtime?.auth.fake {
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
nonisolated struct OfflineFixtureConnectivity: Connectivity {
  let isOnline: Bool
  func onChange(_ handler: @escaping @Sendable (Bool) -> Void) {}
}

nonisolated final class OfflineFixtureProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "offline.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    switch OfflineFixture.mode {
    case "no-network": client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    case "unreachable": client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    case "stalled": break
    default: client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
    }
  }
  override func stopLoading() {}
}
#endif
