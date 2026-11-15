import Foundation
import Testing
import Agent
import SyncCore
@testable import WindmillPlatform

@Suite @MainActor struct AiWireTests {
  @Test func allSharedTextEventsParseAcrossEveryUTF8ByteBoundary() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let fixtures = try JSON(parsing: Array(Data(contentsOf: root.appending(path: "packages/api-contract/ai/wire/fixtures.json"))))
    let values = try fixtures.field("textEvents").array + fixtures.field("textTerminals").asObject().members.map(\.value)
    for value in values {
      var parser = AiEventParser()
      let bytes = Array("id: 1\nevent: \(try value.field("event").string)\ndata: \(value.field("data").jcsText)\n\n".utf8)
      var parsed: [AiEvent] = []
      for byte in bytes { parsed += try parser.append([byte]) }
      #expect(parsed.count == 1)
      #expect(parsed[0].id == 1)
      #expect(try parsed[0].name == value.field("event").string)
      #expect(parsed[0].data == value.field("data"))
      try ServiceAiClient.validate(parsed[0])
    }
    var parser = AiEventParser()
    let bytes = Array("id: 3\nevent: text\ndata: {\"delta\":\"é🙂\"}\n\n".utf8)
    var parsed: [AiEvent] = []
    for byte in bytes { parsed += try parser.append([byte]) }
    #expect(parsed.map(\.data) == [["delta": "é🙂"]])
  }

  @Test func transportPinsOriginAndDisablesAmbientCredentials() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [FixtureURLProtocol.self]
    config.httpAdditionalHeaders = ["Cookie": "ambient", "Authorization": "ambient"]
    let transport = try AiURLSessionTransport(origin: URL(string: "https://coach.invalid")!, configuration: config)
    let response = try await transport.send(AiRequest(method: "GET", path: "/v1/allowance", headers: ["Authorization": "Bearer pass"]))
    var bytes: [UInt8] = []
    for try await chunk in response.bytes { bytes += chunk }
    #expect(try JSON(parsing: bytes) == ["ok": true])
    #expect(throws: AiTransportFailure.self) { try AiURLSessionTransport(origin: URL(string: "http://other.invalid")!, allowLoopbackHTTP: true) }
    #expect(throws: AiTransportFailure.self) { try AiURLSessionTransport(origin: URL(string: "http://localhost")!, allowLoopbackHTTP: true) }
    #expect(throws: AiTransportFailure.self) { try AiURLSessionTransport(origin: URL(string: "https://coach.invalid/path")!) }
    #expect(throws: AiTransportFailure.self) { try AiURLSessionTransport(origin: URL(string: "http://127.0.0.1")!) }
    _ = try AiURLSessionTransport(origin: URL(string: "http://127.0.0.1:19462")!, allowLoopbackHTTP: true)
    await #expect(throws: AiTransportFailure.self) { try await transport.send(AiRequest(method: "GET", path: "//other.invalid/v1/allowance", headers: [:])) }
  }

  @Test func leaseLivesThroughTheTurnAndExpiresOnce() async throws {
    let lease = TestWorkLease()
    let clock = AiSystemClock()
    let runtime = CoachRuntime(clock: clock, lease: lease) { lease.expirations += 1 }
    try await runtime.acquire()
    try await runtime.acquire()
    #expect(lease.acquisitions == 1)
    let ids = try (0..<100).map { _ in try runtime.callID() }
    #expect(Set(ids).count == 100)
    #expect(ids.allSatisfy(ServiceAiClient.validID))
    lease.expired?()
    runtime.release()
    #expect(lease.releases == 1)
    #expect(lease.expirations == 1)
  }
}

final class FixtureURLProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard request.value(forHTTPHeaderField: "Cookie") == nil,
          request.value(forHTTPHeaderField: "Authorization") == "Bearer pass",
          request.value(forHTTPHeaderField: "X-Windmill-Installation") == nil else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("{\"ok\":true}".utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor final class TestWorkLease: CoachWorkLease {
  var acquisitions = 0
  var releases = 0
  var expirations = 0
  var expired: (@MainActor () -> Void)?
  func acquire(expired: @escaping @MainActor () -> Void) { acquisitions += 1; self.expired = expired }
  func release() { releases += 1 }
}
