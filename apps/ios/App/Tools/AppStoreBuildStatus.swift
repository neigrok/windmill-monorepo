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
      let isInternalGroup: Bool?
      let hasAccessToAllBuilds: Bool?
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
  struct Links: Decodable { let next: String? }
  let data: [Resource]
  let included: [Resource]?
  let links: Links?
}

struct AppStoreBetaAccess: Codable, Equatable {
  struct Group: Codable, Equatable {
    let index: Int
    let hasAccessToAllBuilds: Bool
    let buildAssigned: Bool
    let testerCount: Int
  }
  let status: String
  let groups: [Group]
  static let unverified = Self(status: "UNVERIFIED", groups: [])
}

struct AppStoreBuildStatus: Codable, Equatable {
  let bundleId: String
  let version: String
  let build: String
  let processingState: String
  let internalBuildState: String
  let externalBuildState: String
  var betaAccess = AppStoreBetaAccess.unverified
  var sourceRevision: String?
  var workflowRunID: String?
  var infoPlistSHA256: String?
  var referenceVersion: String?
  var referenceBuild: String?

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
  let deadline: Date = Date().addingTimeInterval(600)

  func request(_ path: String, query: [String: String], now: Date = Date()) throws -> URLRequest {
    guard ["/v1/apps", "/v1/builds", "/v1/betaGroups"].contains(path) ||
      path.range(of: "^/v1/betaGroups/[A-Za-z0-9-]{1,128}/relationships/(builds|betaTesters)$", options: .regularExpression) != nil else {
      throw AppStoreStatusFailure.configuration
    }
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
    guard Date() < deadline else { throw AppStoreStatusFailure.response }
    let (data, response) = try await session.data(for: request(path, query: query))
    guard let response = response as? HTTPURLResponse else { throw AppStoreStatusFailure.response }
    guard response.statusCode == 200 else { throw AppStoreStatusFailure.http(response.statusCode) }
    guard data.count <= 1_048_576 else { throw AppStoreStatusFailure.response }
    return try JSONDecoder().decode(AppStoreResources.self, from: data)
  }

  func buildQuery(app: String, version: String, build: String) -> [String: String] {
    ["filter[app]": app, "filter[version]": build, "filter[preReleaseVersion.version]": version,
     "filter[preReleaseVersion.platform]": "IOS", "include": "preReleaseVersion,buildBetaDetail", "limit": "2",
     "fields[builds]": "version,processingState,preReleaseVersion,buildBetaDetail",
     "fields[preReleaseVersions]": "version", "fields[buildBetaDetails]": "internalBuildState,externalBuildState"]
  }

  func pages(_ path: String, query: [String: String]) async throws -> [AppStoreResources.Resource] {
    var current = query
    var seen = Set<String>()
    var cursors = Set<String>()
    var result: [AppStoreResources.Resource] = []
    for _ in 0..<20 {
      let page = try await get(path, query: current)
      for resource in page.data {
        guard resource.id.range(of: "^[A-Za-z0-9-]{1,128}$", options: .regularExpression) != nil,
              seen.insert(resource.type + ":" + resource.id).inserted else { throw AppStoreStatusFailure.response }
        result.append(resource)
      }
      guard let next = page.links?.next else { return result }
      guard let url = URLComponents(string: next), url.scheme == "https", url.host == "api.appstoreconnect.apple.com",
            url.port == nil, url.user == nil, url.password == nil, url.fragment == nil, url.path == path,
            let items = url.queryItems, Set(items.map(\.name)).count == items.count,
            items.allSatisfy({ $0.value != nil && (query[$0.name] != nil || $0.name == "cursor") }) else {
        throw AppStoreStatusFailure.response
      }
      let nextQuery = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value!) })
      guard query.allSatisfy({ nextQuery[$0.key] == $0.value }),
            let cursor = nextQuery["cursor"], !cursor.isEmpty, cursor.utf8.count <= 2048,
            cursors.insert(cursor).inserted else { throw AppStoreStatusFailure.response }
      current = nextQuery
    }
    throw AppStoreStatusFailure.response
  }

  func betaAccess(app: String, bundle: String, targetBuild: String, targetStatus: AppStoreBuildStatus, referenceVersion: String,
                  referenceBuild: String) async throws -> AppStoreBetaAccess {
    let reference = try await get("/v1/builds", query: buildQuery(app: app, version: referenceVersion, build: referenceBuild))
    let status = try AppStoreBuildStatus(bundleId: bundle, version: referenceVersion, build: referenceBuild, resources: reference)
    guard status.processingState == "VALID", let referenceID = reference.data.first?.id else { return .unverified }
    let groups = try await pages("/v1/betaGroups", query: ["filter[app]": app, "filter[builds]": referenceID,
      "filter[isInternalGroup]": "true", "fields[betaGroups]": "isInternalGroup,hasAccessToAllBuilds", "limit": "200"])
    guard !groups.isEmpty else { return AppStoreBetaAccess(status: "NO_ESTABLISHED_GROUP", groups: []) }
    guard groups.count <= 20 else { throw AppStoreStatusFailure.response }
    var access: [AppStoreBetaAccess.Group] = []
    for (index, group) in groups.sorted(by: { $0.id < $1.id }).enumerated() {
      guard group.type == "betaGroups", group.attributes?.isInternalGroup == true,
            let allBuilds = group.attributes?.hasAccessToAllBuilds else { throw AppStoreStatusFailure.response }
      let builds = try await pages("/v1/betaGroups/" + group.id + "/relationships/builds", query: ["limit": "200"])
      guard builds.allSatisfy({ $0.type == "builds" }), builds.contains(where: { $0.id == referenceID }) else {
        throw AppStoreStatusFailure.response
      }
      let testers = try await pages("/v1/betaGroups/" + group.id + "/relationships/betaTesters", query: ["limit": "200"])
      guard testers.allSatisfy({ $0.type == "betaTesters" }) else { throw AppStoreStatusFailure.response }
      access.append(.init(index: index + 1, hasAccessToAllBuilds: allBuilds,
        buildAssigned: builds.contains(where: { $0.id == targetBuild }), testerCount: testers.count))
    }
    let verified = targetStatus.processingState == "VALID" &&
      ["READY_FOR_BETA_TESTING", "IN_BETA_TESTING"].contains(targetStatus.internalBuildState) &&
      access.allSatisfy { $0.buildAssigned && $0.testerCount > 0 }
    return AppStoreBetaAccess(status: verified ? "VERIFIED" : "INCOMPLETE", groups: access)
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
            let build = info["CFBundleVersion"] as? String,
            version.range(of: "^[0-9]{1,4}(\\.[0-9]{1,4}){0,2}$", options: .regularExpression) != nil,
            build.range(of: "^[1-9][0-9]{0,9}$", options: .regularExpression) != nil else { throw AppStoreStatusFailure.configuration }
      let referenceVersion = environment["ASC_REFERENCE_VERSION"].flatMap { $0.isEmpty ? nil : $0 }
      let referenceBuild = environment["ASC_REFERENCE_BUILD"].flatMap { $0.isEmpty ? nil : $0 }
      guard (referenceVersion == nil) == (referenceBuild == nil),
            referenceVersion == nil || referenceVersion!.range(of: "^[0-9]{1,4}(\\.[0-9]{1,4}){0,2}$", options: .regularExpression) != nil,
            referenceBuild == nil || referenceBuild!.range(of: "^[1-9][0-9]{0,9}$", options: .regularExpression) != nil else {
        throw AppStoreStatusFailure.configuration
      }
      let source = environment["GITHUB_SHA"]
      let run = environment["GITHUB_RUN_ID"]
      guard source == nil || source!.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
            run == nil || run!.range(of: "^[1-9][0-9]{0,19}$", options: .regularExpression) != nil else {
        throw AppStoreStatusFailure.configuration
      }
      let plistHash = SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))).map { String(format: "%02x", $0) }.joined()
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
      let query = api.buildQuery(app: app.id, version: version, build: build)
      while true {
        if Date() >= deadline {
          print("::warning::Apple processing or beta availability remains pending. The upload already exists; do not upload a duplicate.")
          return
        }
        let resources = try await api.get("/v1/builds", query: query)
        var status = try AppStoreBuildStatus(bundleId: bundle, version: version, build: build, resources: resources)
        status.sourceRevision = source; status.workflowRunID = run; status.infoPlistSHA256 = plistHash
        status.referenceVersion = referenceVersion; status.referenceBuild = referenceBuild
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(status).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
        print("app_store_status processing=\(status.processingState) internal=\(status.internalBuildState) external=\(status.externalBuildState)")
        if status.failed { print("::error::Apple rejected build processing. The upload already exists; do not upload a duplicate."); exit(1) }
        if !status.pending {
          if status.processingState == "VALID", let target = resources.data.first?.id,
             let referenceVersion, let referenceBuild {
            status.betaAccess = try await api.betaAccess(app: app.id, bundle: bundle, targetBuild: target, targetStatus: status,
              referenceVersion: referenceVersion, referenceBuild: referenceBuild)
            try encoder.encode(status).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
          }
          print("app_store_distribution status=\(status.betaAccess.status) groups=\(status.betaAccess.groups.count)")
          if status.betaAccess.status != "VERIFIED" {
            print("::warning::Internal group membership and tester presence remain unverified or incomplete. No distribution was changed.")
          }
          return
        }
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
