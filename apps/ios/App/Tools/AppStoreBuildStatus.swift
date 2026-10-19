import CryptoKit
import Foundation

enum AppStoreStatusFailure: Error {
  case configuration, response, appLookup, buildMismatch, http(Int)
  var code: String {
    switch self {
    case .configuration: "configuration"
    case .response: "response"
    case .appLookup: "app_lookup"
    case .buildMismatch: "build_mismatch"
    case .http(let status): "http_\(status)"
    }
  }
}

struct AppStoreResources: Decodable {
  struct Resource: Decodable {
    struct Attributes: Decodable {
      let bundleId: String?
      let version: String?
      let processingState: String?
      let internalBuildState: String?
      let externalBuildState: String?
    }
    struct Relationship: Decodable {
      struct Link: Decodable { let id: String; let type: String }
      let data: Link?
    }
    let id: String
    let type: String
    let attributes: Attributes?
    let relationships: [String: Relationship]?
  }
  let data: [Resource]
  let included: [Resource]?
}

struct AppStoreBuildStatus: Codable, Equatable {
  let bundleId: String
  let version: String
  let build: String
  let processingState: String
  let internalBuildState: String
  let externalBuildState: String

  var failed: Bool { ["FAILED", "INVALID"].contains(processingState) }
  var pending: Bool {
    ["NOT_FOUND", "PROCESSING"].contains(processingState) ||
      ["UNKNOWN", "PROCESSING"].contains(internalBuildState) ||
      ["UNKNOWN", "PROCESSING"].contains(externalBuildState)
  }

  init(bundleId: String, version: String, build: String, resources: AppStoreResources) throws {
    self.bundleId = bundleId; self.version = version; self.build = build
    guard !resources.data.isEmpty else {
      processingState = "NOT_FOUND"; internalBuildState = "UNKNOWN"; externalBuildState = "UNKNOWN"
      return
    }
    guard resources.data.count == 1, let value = resources.data.first, value.type == "builds",
          value.attributes?.version == build,
          let release = value.relationships?["preReleaseVersion"]?.data,
          resources.included?.contains(where: { $0.type == "preReleaseVersions" && $0.id == release.id && $0.attributes?.version == version }) == true,
          let state = value.attributes?.processingState, ["PROCESSING", "FAILED", "INVALID", "VALID"].contains(state) else {
      throw AppStoreStatusFailure.buildMismatch
    }
    processingState = state
    let detailID = value.relationships?["buildBetaDetail"]?.data?.id
    let detail = resources.included?.first { $0.type == "buildBetaDetails" && $0.id == detailID }?.attributes
    let internalState = detail?.internalBuildState ?? "UNKNOWN"
    let externalState = detail?.externalBuildState ?? "UNKNOWN"
    guard [internalState, externalState].allSatisfy({ $0.range(of: "^[A-Z_]{1,64}$", options: .regularExpression) != nil }) else {
      throw AppStoreStatusFailure.response
    }
    internalBuildState = internalState; externalBuildState = externalState
  }
}

struct AppStoreConnect {
  let key: P256.Signing.PrivateKey
  let keyID: String
  let issuerID: String
  let session: URLSession

  func request(_ path: String, query: [String: String], now: Date = Date()) throws -> URLRequest {
    guard ["/v1/apps", "/v1/builds"].contains(path) else { throw AppStoreStatusFailure.configuration }
    var components = URLComponents(string: "https://api.appstoreconnect.apple.com")!
    components.path = path
    components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
    let header = try JSONSerialization.data(withJSONObject: ["alg": "ES256", "kid": keyID, "typ": "JWT"])
    let issued = Int(now.timeIntervalSince1970)
    let claims = try JSONSerialization.data(withJSONObject: ["iss": issuerID, "iat": issued, "exp": issued + 120,
      "aud": "appstoreconnect-v1", "scope": ["GET " + path + "?" + (components.percentEncodedQuery ?? "")]])
    let input = header.base64URL + "." + claims.base64URL
    let signature = try key.signature(for: Data(input.utf8)).rawRepresentation.base64URL
    var request = URLRequest(url: components.url!)
    request.httpMethod = "GET"
    request.setValue("Bearer " + input + "." + signature, forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }

  func get(_ path: String, query: [String: String]) async throws -> AppStoreResources {
    let (data, response) = try await session.data(for: request(path, query: query))
    guard let response = response as? HTTPURLResponse else { throw AppStoreStatusFailure.response }
    guard response.statusCode == 200 else { throw AppStoreStatusFailure.http(response.statusCode) }
    guard data.count <= 1_048_576 else { throw AppStoreStatusFailure.response }
    return try JSONDecoder().decode(AppStoreResources.self, from: data)
  }
}

extension Data {
  var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}

#if !APP_STORE_STATUS_TESTING
@main struct AppStoreBuildStatusCommand {
  static func main() async {
    do {
      let environment = ProcessInfo.processInfo.environment
      guard CommandLine.arguments.count == 3,
            let keyPath = environment["ASC_KEY_PATH"], let keyID = environment["ASC_KEY_ID"],
            let issuer = environment["ASC_ISSUER_ID"], !keyID.isEmpty, !issuer.isEmpty,
            let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])), format: nil) as? [String: Any],
            let bundle = info["CFBundleIdentifier"] as? String,
            let version = info["CFBundleShortVersionString"] as? String,
            let build = info["CFBundleVersion"] as? String else { throw AppStoreStatusFailure.configuration }
      let key = try P256.Signing.PrivateKey(pemRepresentation: String(contentsOfFile: keyPath, encoding: .utf8))
      let readTimeout: TimeInterval = 30
      let configuration = URLSessionConfiguration.ephemeral
      configuration.timeoutIntervalForRequest = readTimeout; configuration.timeoutIntervalForResource = readTimeout
      let api = AppStoreConnect(key: key, keyID: keyID, issuerID: issuer, session: URLSession(configuration: configuration))
      let deadline = Date().addingTimeInterval(600 - readTimeout)
      let apps = try await api.get("/v1/apps", query: ["filter[bundleId]": bundle, "fields[apps]": "bundleId", "limit": "2"])
      guard apps.data.count == 1, let app = apps.data.first, app.type == "apps", app.attributes?.bundleId == bundle else {
        throw AppStoreStatusFailure.appLookup
      }
      let query = ["filter[app]": app.id, "filter[version]": build, "filter[preReleaseVersion.version]": version,
        "filter[preReleaseVersion.platform]": "IOS", "include": "preReleaseVersion,buildBetaDetail", "limit": "2",
        "fields[builds]": "version,processingState,preReleaseVersion,buildBetaDetail",
        "fields[preReleaseVersions]": "version", "fields[buildBetaDetails]": "internalBuildState,externalBuildState"]
      while true {
        if Date() >= deadline {
          print("::warning::Apple processing or beta availability remains pending. The upload already exists; do not upload a duplicate.")
          return
        }
        let resources = try await api.get("/v1/builds", query: query)
        let status = try AppStoreBuildStatus(bundleId: bundle, version: version, build: build, resources: resources)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(status).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
        print("app_store_status processing=\(status.processingState) internal=\(status.internalBuildState) external=\(status.externalBuildState)")
        if status.failed { print("::error::Apple rejected build processing. The upload already exists; do not upload a duplicate."); exit(1) }
        if !status.pending { return }
        try await Task.sleep(for: .seconds(30))
      }
    } catch {
      let code = (error as? AppStoreStatusFailure)?.code ?? "unavailable"
      print("::error::app_store_status outcome=unverified code=\(code). The upload already exists; do not upload a duplicate.")
      exit(1)
    }
  }
}
#endif
