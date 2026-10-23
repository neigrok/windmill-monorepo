import Foundation
import Observation
import Security
import SyncEngine

nonisolated struct AiAllowance: Codable, Equatable, Sendable {
  let code: String
  let currency: String
  let period: String
  let tier: String
  let configured: Bool
  let limit: String?
  let used: String
  let reserved: String
  let remaining: String
  let resetsAtMs: Int64?
  let budgetResetsAtMs: Int64?
  static let refusalCodes: Set<String> = ["subject_exhausted", "free_month_exhausted", "free_day_exhausted",
    "concurrency_exhausted", "funding_required", "debt_outstanding", "unconfigured", "device_bound"]
}

protocol InstallationCredentialStore {
  func read() throws -> String?
  func write(_ credential: String) throws
}

struct KeychainInstallationCredentialStore: InstallationCredentialStore {
  let service: String
  var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
     kSecAttrAccount as String: "installation"]
  }
  func read() throws -> String? {
    var query = query
    query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
    var value: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &value)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainInstallationError() }
    guard let data = value as? Data, let credential = String(data: data, encoding: .utf8), Self.valid(credential) else {
      throw KeychainInstallationError()
    }
    return credential
  }
  func write(_ credential: String) throws {
    guard Self.valid(credential) else { throw KeychainInstallationError() }
    let fields: [String: Any] = [kSecValueData as String: Data(credential.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let updated = SecItemUpdate(query as CFDictionary, fields as CFDictionary)
    let status = updated == errSecItemNotFound ? SecItemAdd(query.merging(fields) { $1 } as CFDictionary, nil) : updated
    guard status == errSecSuccess else { throw KeychainInstallationError() }
  }
  static func valid(_ credential: String) -> Bool {
    credential.utf8.count == 43 && credential.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }
  }
}

struct KeychainInstallationError: Error {}

@Observable @MainActor final class AiInstallation {
  struct State: Decodable {
    let credential: String?
    let bound: Bool
    let allowance: AiAllowance
  }
  let baseURL: URL?
  let credentials: any InstallationCredentialStore
  let session: URLSession
  let telemetry: any Telemetry
  var resolvedAccount: String?
  var pendingCredential: String?
  var issue: Task<String, any Error>?

  init(baseURL: URL?, credentials: any InstallationCredentialStore, session: URLSession? = nil, telemetry: any Telemetry) {
    self.baseURL = baseURL; self.credentials = credentials; self.session = session ?? URLSession(configuration: NativeAuth.nativeSession().configuration, delegate: AiInstallationRedirects(), delegateQueue: nil); self.telemetry = telemetry
  }

  func credential() async throws -> String {
    if let pendingCredential { try saveCredential(pendingCredential); return pendingCredential }
    do {
      if let credential = try credentials.read() { return credential }
    } catch {
      telemetry.failure("keychain_read", kind: "keychain")
      throw AppFailure(message: "Coach couldn’t read this phone’s AI access. Try again after unlocking your phone.")
    }
    if let issue { return try await issue.value }
    resolvedAccount = nil
    let task = Task { [self] in
      let data = try await request("/v1/ai/installations", method: "POST", body: Data("{}".utf8))
      let state = try decodeState(data)
      guard let credential = state.credential, KeychainInstallationCredentialStore.valid(credential), !state.bound else { throw URLError(.badServerResponse) }
      pendingCredential = credential
      try saveCredential(credential)
      return credential
    }
    issue = task
    defer { issue = nil }
    return try await task.value
  }

  func bind(account: String, token: SessionToken) async throws {
    if let issue { _ = try await issue.value }
    if let pendingCredential { try saveCredential(pendingCredential) }
    if resolvedAccount == account { return }
    let credential: String?
    do { credential = try credentials.read() }
    catch { telemetry.failure("keychain_read", kind: "keychain"); throw error }
    guard let credential else { resolvedAccount = account; return }
    do {
      let data = try await request("/v1/ai/installations/bind", method: "POST", body: Data("{}".utf8), credential: credential, token: token)
      let state = try decodeState(data)
      guard state.bound else { throw URLError(.badServerResponse) }
      resolvedAccount = account
    } catch let failure as AiRequestFailure {
      let code = (try? JSONDecoder().decode(InstallationFailure.self, from: failure.body))?.code
      if failure.status == 409 && code == "installation_bound" || failure.status == 401 && code == "invalid_installation" {
        resolvedAccount = account; return
      }
      throw failure
    }
  }

  func saveCredential(_ credential: String) throws {
    do { try credentials.write(credential); pendingCredential = nil; resolvedAccount = nil }
    catch {
      telemetry.failure("keychain_save", kind: "keychain")
      throw AppFailure(message: "Coach couldn’t save this phone’s AI access. Try again.")
    }
  }

  func decodeState(_ data: Data) throws -> State {
    do { return try JSONDecoder().decode(State.self, from: data) }
    catch { telemetry.failure("ai_installation", kind: "decode"); throw error }
  }

  func request(_ path: String, method: String = "GET", body: Data? = nil, credential: String? = nil, token: SessionToken? = nil) async throws -> Data {
    guard let baseURL, ["/v1/ai/installations", "/v1/ai/installations/bind", "/v1/ai/installations/current"].contains(path) || path == "/v1/gym/coach/onboarding" || path.hasPrefix("/v1/gym/coach/onboarding/"),
          !path.contains(".."), let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
          url.host == baseURL.host, url.scheme == baseURL.scheme, url.port == baseURL.port else { throw URLError(.badURL) }
    var request = URLRequest(url: url)
    request.httpMethod = method; request.httpBody = body
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if let credential { request.setValue(credential, forHTTPHeaderField: "X-Windmill-Installation") }
    if let token { request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization") }
    do {
      let (data, response) = try await NativeAuth.data(for: request, session: session)
      guard let http = response as? HTTPURLResponse, data.count <= 2_000_000 else { throw URLError(.badServerResponse) }
      guard (200..<300).contains(http.statusCode) else {
        throw AiRequestFailure(status: http.statusCode, body: data)
      }
      return data
    } catch {
      if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
      let status = (error as? AiRequestFailure)?.status
      let kind = [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains((error as? URLError)?.code) ? "offline" : status == nil ? "transport" : "http"
      let operation = path.hasPrefix("/v1/ai/") ? "ai_installation" : "gym_rest"
      var properties = ["operation": operation, "route": path.hasPrefix("/v1/ai/") ? "/v1/ai" : "/v1/gym", "method": method, "failure_kind": kind]
      if let status { properties["status"] = String(status) }
      telemetry.event("api_request_failed", properties: properties)
      let failure = (error as? AiRequestFailure).flatMap { try? JSONDecoder().decode(InstallationFailure.self, from: $0.body) }
      let unavailable = status == 503 && (["anonymous_ai_unavailable", "unconfigured"].contains(failure?.code ?? "") || AiAllowance.refusalCodes.contains(failure?.code ?? ""))
      if kind != "offline", !unavailable, status == nil || status! >= 500 { telemetry.failure(operation, kind: kind, properties: properties) }
      throw error
    }
  }
}

nonisolated struct InstallationFailure: Decodable {
  let code: String?
  let allowance: AiAllowance?
}

nonisolated struct AiRequestFailure: Error {
  let status: Int
  let body: Data
}

nonisolated final class AiInstallationRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
