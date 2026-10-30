import CryptoKit
import Foundation

@main struct AppStoreBuildStatusChecks {
  static func main() async throws {
    let key = P256.Signing.PrivateKey()
    let api = AppStoreConnect(key: key, keyID: "test-key", issuerID: "test-issuer", session: .shared)
    let request = try api.request("/v1/builds", query: ["filter[version]": "19", "filter[app]": "test-app"], now: Date(timeIntervalSince1970: 1_000))
    precondition(request.httpMethod == "GET")
    precondition(request.url?.scheme == "https" && request.url?.host == "api.appstoreconnect.apple.com")
    let parts = request.value(forHTTPHeaderField: "Authorization")!.dropFirst("Bearer ".count).split(separator: ".").map(String.init)
    func decoded(_ text: String) -> Data {
      let base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
      return Data(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4))!
    }
    let header = try JSONSerialization.jsonObject(with: decoded(parts[0])) as! [String: String]
    precondition(header == ["alg": "ES256", "kid": "test-key", "typ": "JWT"])
    let claims = try JSONSerialization.jsonObject(with: decoded(parts[1])) as! NSDictionary
    let exactPath = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.percentEncodedQuery!
    precondition(claims == ["iss": "test-issuer", "iat": 1_000, "exp": 1_120, "aud": "appstoreconnect-v1",
      "scope": ["GET /v1/builds?" + exactPath]] as NSDictionary)
    let signature = try P256.Signing.ECDSASignature(rawRepresentation: decoded(parts[2]))
    precondition(key.publicKey.isValidSignature(signature, for: Data((parts[0] + "." + parts[1]).utf8)))
    do { _ = try api.request("/v1/betaTesters", query: [:]); preconditionFailure("Unexpected endpoint allowed") }
    catch AppStoreStatusFailure.configuration {}

    let valid = #"{"data":[{"type":"builds","id":"build-id","attributes":{"version":"19","processingState":"VALID"},"relationships":{"preReleaseVersion":{"data":{"type":"preReleaseVersions","id":"release-id"}},"buildBetaDetail":{"data":{"type":"buildBetaDetails","id":"detail-id"}}}}],"included":[{"type":"preReleaseVersions","id":"release-id","attributes":{"version":"0.2.0"}},{"type":"buildBetaDetails","id":"detail-id","attributes":{"internalBuildState":"IN_BETA_TESTING","externalBuildState":"READY_FOR_BETA_TESTING"}}]}"#
    func status(_ json: String) throws -> AppStoreBuildStatus {
      try AppStoreBuildStatus(bundleId: "works.windmill.app", version: "0.2.0", build: "19",
        resources: JSONDecoder().decode(AppStoreResources.self, from: Data(json.utf8)))
    }
    let ready = try status(valid)
    precondition(!ready.failed && !ready.pending)
    let report = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ready)) as! NSDictionary
    precondition(report == ["bundleId": "works.windmill.app", "version": "0.2.0", "build": "19", "processingState": "VALID",
      "internalBuildState": "IN_BETA_TESTING", "externalBuildState": "READY_FOR_BETA_TESTING", "betaAccess": ["status": "UNVERIFIED", "groups": []]] as NSDictionary)
    let absent = try status(#"{"data":[]}"#)
    precondition(absent.pending && !absent.failed && absent.processingState == "NOT_FOUND")
    let pending = try status(valid.replacingOccurrences(of: "VALID", with: "PROCESSING"))
    precondition(pending.pending && !pending.failed)
    for state in ["FAILED", "INVALID"] {
      let refused = try status(valid.replacingOccurrences(of: "VALID", with: state))
      precondition(refused.failed)
    }
    for text in [valid.replacingOccurrences(of: "0.2.0", with: "0.1.0"), valid.replacingOccurrences(of: "\"19\"", with: "\"18\"")] {
      do { _ = try status(text); preconditionFailure("Wrong archive build accepted") }
      catch AppStoreStatusFailure.buildMismatch {}
    }
    do { _ = try status(valid.replacingOccurrences(of: "IN_BETA_TESTING", with: "private provider message")); preconditionFailure("Unbounded state accepted") }
    catch AppStoreStatusFailure.response {}
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StatusProtocol.self]
    let fixture = AppStoreConnect(key: key, keyID: "test-key", issuerID: "test-issuer", session: URLSession(configuration: configuration))
    let groups = #"{"data":[{"type":"betaGroups","id":"group-b","attributes":{"isInternalGroup":true,"hasAccessToAllBuilds":false}},{"type":"betaGroups","id":"group-a","attributes":{"isInternalGroup":true,"hasAccessToAllBuilds":true}}]}"#
    let builds = #"{"data":[{"type":"builds","id":"build-id"},{"type":"builds","id":"candidate-id"}]}"#
    let testers = #"{"data":[{"type":"betaTesters","id":"private-tester-canary"}]}"#
    StatusProtocol.state.set([valid, groups, builds, testers, builds, testers])
    let access = try await fixture.betaAccess(app: "app-id", bundle: "works.windmill.app", targetBuild: "candidate-id", targetStatus: ready, referenceVersion: "0.2.0", referenceBuild: "19")
    precondition(access == AppStoreBetaAccess(status: "VERIFIED", groups: [
      .init(index: 1, hasAccessToAllBuilds: true, buildAssigned: true, testerCount: 1),
      .init(index: 2, hasAccessToAllBuilds: false, buildAssigned: true, testerCount: 1)]))
    let safe = String(data: try JSONEncoder().encode(access), encoding: .utf8)!
    precondition(!safe.contains("private-tester-canary") && !safe.contains("group-a") && !safe.contains("group-b"))
    let paths = StatusProtocol.state.paths()
    precondition(paths.count == 6 && paths[1].contains("filter%5Bbuilds%5D=build-id"))
    precondition(paths[2].hasPrefix("/v1/betaGroups/group-a/relationships/builds?"))
    precondition(paths[3].hasPrefix("/v1/betaGroups/group-a/relationships/betaTesters?"))
    precondition(paths.allSatisfy { !$0.contains("email") && !$0.contains("firstName") && !$0.contains("lastName") })
    let oneGroup = #"{"data":[{"type":"betaGroups","id":"group-a","attributes":{"isInternalGroup":true,"hasAccessToAllBuilds":true}}]}"#
    for state in ["READY_FOR_BETA_TESTING", "IN_BETA_TESTING", "PROCESSING", "PROCESSING_EXCEPTION",
                  "MISSING_EXPORT_COMPLIANCE", "EXPIRED", "IN_EXPORT_COMPLIANCE_REVIEW", "UNKNOWN", "FUTURE_STATE"] {
      let target = try status(valid.replacingOccurrences(of: "IN_BETA_TESTING", with: state))
      StatusProtocol.state.set([valid, oneGroup, builds, testers])
      let result = try await fixture.betaAccess(app: "app-id", bundle: "works.windmill.app", targetBuild: "candidate-id",
        targetStatus: target, referenceVersion: "0.2.0", referenceBuild: "19")
      let expected = ["READY_FOR_BETA_TESTING", "IN_BETA_TESTING"].contains(state) ? "VERIFIED" : "INCOMPLETE"
      precondition(result == AppStoreBetaAccess(status: expected,
        groups: [.init(index: 1, hasAccessToAllBuilds: true, buildAssigned: true, testerCount: 1)]))
    }
    for state in ["PROCESSING", "FAILED", "INVALID"] {
      let target = try status(valid.replacingOccurrences(of: "VALID", with: state))
      StatusProtocol.state.set([valid, oneGroup, builds, testers])
      let result = try await fixture.betaAccess(app: "app-id", bundle: "works.windmill.app", targetBuild: "candidate-id",
        targetStatus: target, referenceVersion: "0.2.0", referenceBuild: "19")
      precondition(result.status == "INCOMPLETE")
    }
    StatusProtocol.state.set([valid, oneGroup, #"{"data":[{"type":"builds","id":"build-id"}]}"#, #"{"data":[]}"#])
    let incomplete = try await fixture.betaAccess(app: "app-id", bundle: "works.windmill.app", targetBuild: "candidate-id", targetStatus: ready, referenceVersion: "0.2.0", referenceBuild: "19")
    precondition(incomplete == AppStoreBetaAccess(status: "INCOMPLETE", groups: [.init(index: 1, hasAccessToAllBuilds: true, buildAssigned: false, testerCount: 0)]))
    StatusProtocol.state.set([valid, #"{"data":[]}"#])
    let none = try await fixture.betaAccess(app: "app-id", bundle: "works.windmill.app", targetBuild: "candidate-id", targetStatus: ready, referenceVersion: "0.2.0", referenceBuild: "19")
    precondition(none == AppStoreBetaAccess(status: "NO_ESTABLISHED_GROUP", groups: []))
    let firstPage = #"{"data":[{"type":"betaTesters","id":"private-first"}],"links":{"next":"https://api.appstoreconnect.apple.com/v1/betaGroups/group-a/relationships/betaTesters?limit=200&cursor=next"}}"#
    StatusProtocol.state.set([firstPage, testers])
    let paged = try await fixture.pages("/v1/betaGroups/group-a/relationships/betaTesters", query: ["limit": "200"])
    precondition(paged.count == 2 && StatusProtocol.state.paths().count == 2)
    for invalid in [firstPage.replacingOccurrences(of: "api.appstoreconnect.apple.com", with: "elsewhere.invalid"),
                    firstPage.replacingOccurrences(of: "/relationships/betaTesters?", with: "/betaTesters?"),
                    firstPage.replacingOccurrences(of: "limit=200", with: "limit=1"),
                    firstPage.replacingOccurrences(of: "cursor=next", with: "cursor=next&email=private"),
                    firstPage.replacingOccurrences(of: "private-first", with: "")] {
      StatusProtocol.state.set([invalid])
      do { _ = try await fixture.pages("/v1/betaGroups/group-a/relationships/betaTesters", query: ["limit": "200"]); preconditionFailure("Unsafe page accepted") }
      catch AppStoreStatusFailure.response {}
      precondition(StatusProtocol.state.paths().count == 1)
    }
    StatusProtocol.state.set([firstPage, firstPage])
    do { _ = try await fixture.pages("/v1/betaGroups/group-a/relationships/betaTesters", query: ["limit": "200"]); preconditionFailure("Repeated page accepted") }
    catch AppStoreStatusFailure.response {}
    StatusProtocol.state.set([valid, oneGroup.replacingOccurrences(of: "isInternalGroup\":true", with: "isInternalGroup\":false")])
    do { _ = try await fixture.betaAccess(app: "app-id", bundle: "works.windmill.app", targetBuild: "candidate-id", targetStatus: ready, referenceVersion: "0.2.0", referenceBuild: "19"); preconditionFailure("External group accepted") }
    catch AppStoreStatusFailure.response {}
    print("App Store status checks passed: signed GET scope, exact archive match, literal beta states, pending/failure and bounded output.")
  }
}

final class StatusProtocol: URLProtocol, @unchecked Sendable {
  final class State: @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [String] = []
    private var requests: [String] = []
    func set(_ values: [String]) { lock.lock(); defer { lock.unlock() }; responses = values; requests = [] }
    func paths() -> [String] { lock.lock(); defer { lock.unlock() }; return requests }
    func next(_ request: URLRequest) -> String {
      lock.lock(); defer { lock.unlock() }
      precondition(request.httpMethod == "GET" && request.url?.host == "api.appstoreconnect.apple.com")
      precondition(request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true)
      requests.append(request.url!.path + "?" + (request.url!.query ?? ""))
      precondition(!responses.isEmpty)
      return responses.removeFirst()
    }
  }
  static let state = State()
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let body = Self.state.next(request)
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
