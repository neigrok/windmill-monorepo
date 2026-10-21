import CryptoKit
import Foundation

@main struct AppStoreBuildStatusChecks {
  static func main() throws {
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
    do { _ = try api.request("/v1/betaGroups", query: [:]); preconditionFailure("Unexpected endpoint allowed") }
    catch AppStoreStatusFailure.configuration {}

    let valid = #"{"data":[{"type":"builds","id":"build-id","attributes":{"version":"19","processingState":"VALID"},"relationships":{"preReleaseVersion":{"data":{"type":"preReleaseVersions","id":"release-id"}},"buildBetaDetail":{"data":{"type":"buildBetaDetails","id":"detail-id"}}}}],"included":[{"type":"preReleaseVersions","id":"release-id","attributes":{"version":"0.2.0"}},{"type":"buildBetaDetails","id":"detail-id","attributes":{"internalBuildState":"IN_BETA_TESTING","externalBuildState":"READY_FOR_BETA_TESTING"}}]}"#
    func status(_ json: String) throws -> AppStoreBuildStatus {
      try AppStoreBuildStatus(bundleId: "works.windmill.app", version: "0.2.0", build: "19",
        resources: JSONDecoder().decode(AppStoreResources.self, from: Data(json.utf8)))
    }
    let ready = try status(valid)
    precondition(!ready.failed && !ready.pending)
    let report = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ready)) as! [String: String]
    precondition(report == ["bundleId": "works.windmill.app", "version": "0.2.0", "build": "19", "processingState": "VALID",
      "internalBuildState": "IN_BETA_TESTING", "externalBuildState": "READY_FOR_BETA_TESTING"])
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
    print("App Store status checks passed: signed GET scope, exact archive match, literal beta states, pending/failure and bounded output.")
  }
}
