import Foundation
import DomainKit
import SyncEngine

nonisolated struct JournalEchoMatch: Codable, Equatable, Sendable {
  let day: String
  let text: String
  var isSelf: Bool? = nil
  var source: String? = nil
  var useful: Bool? = nil
  var occurrenceHint: Int? = nil
}

nonisolated struct JournalEchoPage: Codable, Equatable, Sendable {
  let day: String
  var matches: [JournalEchoMatch]
}

nonisolated struct JournalEchoResponse: Codable, Equatable, Sendable {
  var pages: [JournalEchoPage]
  var pagesWritten: Int? = nil
  var floorWaived: Bool? = nil
  var firstEchoEver: Bool? = nil
}

nonisolated enum JournalEchoSignal: String, Sendable { case opened, useful, dismiss }

@MainActor protocol JournalEchoServing {
  func list(through day: String) async throws -> JournalEchoResponse
  func signal(_ signal: JournalEchoSignal, triggerDay: String, matchDay: String?) async throws
}

nonisolated enum JournalEchoFailure: Error, Equatable {
  case unavailable, invalidDate, invalidSignal, invalidResponse
  case http(Int)
}

@MainActor final class JournalEchoREST: JournalEchoServing {
  let runtime: AppRuntime?
  let telemetry: any Telemetry
  let session: URLSession

  init(runtime: AppRuntime?, telemetry: any Telemetry = NoopTelemetry(), session: URLSession? = nil) {
    self.runtime = runtime; self.telemetry = telemetry
    let configuration = session?.configuration ?? URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil
    configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.waitsForConnectivity = false
    configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 15
    self.session = URLSession(configuration: configuration)
  }

  deinit { session.invalidateAndCancel() }

  func list(through day: String) async throws -> JournalEchoResponse {
    guard LocalDay(day) != nil else { throw JournalEchoFailure.invalidDate }
    return try await request("/v1/journal/echoes?from=0001-01-01&to=\(day)", method: "GET") { data in
      let response = try JSONDecoder().decode(JournalEchoResponse.self, from: data)
      guard response.pages.allSatisfy({ page in
        LocalDay(page.day) != nil && page.matches.allSatisfy { LocalDay($0.day) != nil }
      }) else { throw JournalEchoFailure.invalidResponse }
      return response
    }
  }

  func signal(_ signal: JournalEchoSignal, triggerDay: String, matchDay: String?) async throws {
    guard LocalDay(triggerDay) != nil, matchDay.map({ LocalDay($0) != nil }) ?? true else {
      throw JournalEchoFailure.invalidDate
    }
    guard matchDay != nil || signal == .dismiss else { throw JournalEchoFailure.invalidSignal }
    let match = matchDay.map { "/\($0)" } ?? ""
    try await request("/v1/journal/echoes/\(triggerDay)\(match)/\(signal.rawValue)", method: "POST") { _ in () }
  }

  private func request<Value>(_ path: String, method: String, decode: (Data) throws -> Value) async throws -> Value {
    try Task.checkCancellation()
    guard let runtime, let baseURL = runtime.settings.baseURL,
          let account = try runtime.account(), !runtime.engine.status.authPaused,
          let token = runtime.tokens.token(for: account) else { throw JournalEchoFailure.unavailable }
    guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
          url.host == baseURL.host, url.scheme == baseURL.scheme, url.port == baseURL.port else {
      throw JournalEchoFailure.unavailable
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)
    request.httpMethod = method; request.httpShouldHandleCookies = false
    request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
    let started = ContinuousClock.now
    var kind = "transport"
    var status: Int?
    do {
      guard runtime.engine.status.online else { throw URLError(.notConnectedToInternet) }
      let (data, response) = try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
        group.addTask { [session, request] in try await session.data(for: request) }
        group.addTask {
          try await Task.sleep(for: .seconds(15))
          throw URLError(.timedOut)
        }
        defer { group.cancelAll() }
        return try await group.next()!
      }
      try Task.checkCancellation()
      guard try runtime.account() == account, runtime.tokens.token(for: account) == token,
            !runtime.engine.status.authPaused else { throw CancellationError() }
      guard runtime.engine.status.online else { throw URLError(.notConnectedToInternet) }
      guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
      status = response.statusCode
      guard (200..<300).contains(response.statusCode) else {
        kind = "http"
        throw JournalEchoFailure.http(response.statusCode)
      }
      kind = "decode"
      return try decode(data)
    } catch {
      try Task.checkCancellation()
      if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
      guard try runtime.account() == account, runtime.tokens.token(for: account) == token,
            !runtime.engine.status.authPaused else { throw CancellationError() }
      if let failure = error as? URLError {
        if [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost].contains(failure.code) { kind = "offline" }
        if failure.code == .timedOut { kind = "timeout" }
        if [.secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired].contains(failure.code) { kind = "tls" }
      }
      let elapsed = started.duration(to: .now).components
      let ms = elapsed.seconds * 1_000 + elapsed.attoseconds / 1_000_000_000_000_000
      var properties = ["method": method, "route": "/v1/journal", "operation": "journal_echoes", "failure_kind": kind]
      if let status { properties["status"] = String(status) }
      telemetry.event("api_request_failed", properties: properties, durationMs: ms)
      if kind != "offline", ![400, 401, 403, 404, 409, 410, 422, 429].contains(status ?? 0) {
        telemetry.failure("journal_echoes", kind: kind, properties: properties, durationMs: ms)
      }
      throw error
    }
  }
}
