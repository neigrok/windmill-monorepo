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
    precondition(paths.count == 6)
    let groupQuery = URLComponents(string: "https://api.appstoreconnect.apple.com" + paths[1])!.queryItems!
    precondition(Dictionary(uniqueKeysWithValues: groupQuery.map { ($0.name, $0.value!) }) ==
      ["filter[app]": "app-id", "fields[betaGroups]": "isInternalGroup,hasAccessToAllBuilds", "limit": "200"])
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
    let external = oneGroup.replacingOccurrences(of: "isInternalGroup\":true", with: "isInternalGroup\":false")
    StatusProtocol.state.set([valid, external])
    let externalOnly = try await fixture.betaAccess(app: "app-id", bundle: "works.windmill.app", targetBuild: "candidate-id",
      targetStatus: ready, referenceVersion: "0.2.0", referenceBuild: "19")
    precondition(externalOnly == AppStoreBetaAccess(status: "NO_ESTABLISHED_GROUP", groups: []))
    precondition(StatusProtocol.state.paths().count == 2)
    StatusProtocol.state.set([valid, groups, #"{"data":[{"type":"builds","id":"candidate-id"}]}"#, builds, testers])
    let establishedOnly = try await fixture.betaAccess(app: "app-id", bundle: "works.windmill.app", targetBuild: "candidate-id",
      targetStatus: ready, referenceVersion: "0.2.0", referenceBuild: "19")
    precondition(establishedOnly == AppStoreBetaAccess(status: "VERIFIED",
      groups: [.init(index: 1, hasAccessToAllBuilds: false, buildAssigned: true, testerCount: 1)]))
    precondition(StatusProtocol.state.paths().count == 5)
    precondition(!StatusProtocol.state.paths().contains(where: { $0.contains("group-a/relationships/betaTesters") }))
    StatusProtocol.state.set([valid, oneGroup.replacingOccurrences(of: "betaGroups", with: "unexpected")])
    do { _ = try await fixture.betaAccess(app: "app-id", bundle: "works.windmill.app", targetBuild: "candidate-id", targetStatus: ready,
      referenceVersion: "0.2.0", referenceBuild: "19"); preconditionFailure("Unexpected group resource accepted") }
    catch AppStoreStatusFailure.response {}

    let refused = #"{"errors":[{"code":"PARAMETER_ERROR.INVALID","title":"private-title-canary","detail":"private-detail-canary","source":{"parameter":"filter[builds]"}}]}"#
    StatusProtocol.state.set([refused], status: 400)
    do { _ = try await fixture.get("/v1/betaGroups", query: ["filter[app]": "app-id"]); preconditionFailure("HTTP error accepted") }
    catch let failure as AppStoreStatusFailure {
      precondition(failure.code == "http_400")
      precondition(failure.diagnostics == " route=beta_groups apple_code=PARAMETER_ERROR.INVALID parameter=filter[builds]")
    }
    for body in [#"{"errors":[{"code":"private-code-canary","source":{"parameter":"private-parameter-canary"}}]}"#,
                 "private-invalid-json-canary", String(repeating: "x", count: 1_048_577)] {
      let failure = AppStoreStatusFailure.request(status: 400, path: "/v1/betaGroups/private-group-canary/relationships/betaTesters", data: Data(body.utf8))
      precondition(failure.code == "http_400")
      precondition(failure.diagnostics == " route=beta_group_testers apple_code=unreported parameter=unreported")
    }
    for path in ["/v1/betaGroups", "/v1/betaGroups/group-a/relationships/builds", "/v1/betaGroups/group-a/relationships/betaTesters"] {
      let signed = try fixture.request(path, query: ["limit": "200"])
      let token = signed.value(forHTTPHeaderField: "Authorization")!.dropFirst("Bearer ".count).split(separator: ".")
      let body = try JSONSerialization.jsonObject(with: decoded(String(token[1]))) as! [String: Any]
      precondition(body["scope"] as? [String] == ["GET " + path + "?limit=200"])
    }
    print("App Store status checks passed: signed GET scope, exact archive match, literal beta states, pending/failure and bounded output.")
  }
}

final class StatusProtocol: URLProtocol, @unchecked Sendable {
  final class State: @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [String] = []
    private var requests: [String] = []
    private var status = 200
    func set(_ values: [String], status: Int = 200) {
      lock.lock(); defer { lock.unlock() }; responses = values; requests = []; self.status = status
    }
    func paths() -> [String] { lock.lock(); defer { lock.unlock() }; return requests }
    func next(_ request: URLRequest) -> (status: Int, body: String) {
      lock.lock(); defer { lock.unlock() }
      precondition(request.httpMethod == "GET" && request.url?.host == "api.appstoreconnect.apple.com")
      precondition(request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true)
      requests.append(request.url!.path + "?" + (request.url!.query ?? ""))
      precondition(!responses.isEmpty)
      return (status, responses.removeFirst())
    }
  }
  static let state = State()
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let body = Self.state.next(request)
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: body.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.body.utf8)); client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
