import Foundation
import SyncCore
import SyncEngine
import Synchronization
import Testing

// `HTTPTransport` against a stubbed URL loading system: what goes on the wire (§9.1–§9.4), and how each answer is
// classified (§9.6, design §6.2).

struct TransportTests {
  // Each test serves its own host, so tests running at once never share a route.
  final class Stub: URLProtocol, @unchecked Sendable {
    typealias Route = @Sendable (URLRequest, Data?) -> (status: Int, body: String)?

    static let routes = Mutex<[String: Route]>([:])
    static let seen = Mutex<[String: [(request: URLRequest, body: Data?)]]>([:])

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      let host = request.url!.host!
      let body = request.httpBodyStream.map(Self.drain)
      Self.seen.withLock { $0[host, default: []].append((request, body)) }
      guard let route = Self.routes.withLock({ $0[host] }), let answer = route(request, body) else {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        return
      }
      let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: nil)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func drain(_ stream: InputStream) -> Data {
      stream.open()
      defer { stream.close() }
      var data = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        guard count > 0 else { break }
        data.append(buffer, count: count)
      }
      return data
    }

    // A transport to `host`, served by `route`; nil from the route is no response at all.
    static func transport(_ host: String, _ route: @escaping Route) -> HTTPTransport {
      routes.withLock { $0[host] = route }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [Stub.self]
      return HTTPTransport(baseURL: URL(string: "https://\(host)/")!, schema: 3, configuration: configuration)
    }
  }

  static let request = PushRequest(
    replica: "rp_00000000000000000000000000000001", ackThrough: 4,
    intents: [Intent(n: 5, scope: .product("probe"), command: Command(name: "probe.end", args: ["runId": "run00001", "endedAt": 9]))])

  @Test func aPushGoesAsJCSWithItsHeadersAndItsAnswerIsParsed() async throws {
    let transport = Stub.transport("push.test") { _, _ in
      (200, #"{"serverTime": 1000, "epoch": "ep-1", "lastN": 5, "results": [{"n": 5, "s": "ok", "seq": 12, "write": []}]}"#)
    }
    let reply = await transport.push(Self.request, token: SessionToken("secret"))
    guard case .answered(.ok(let response)) = reply else { throw RigError("the push was not answered ok") }
    #expect((response.serverTime, response.epoch, response.lastN, response.retry) == (1000, "ep-1", 5, nil))
    #expect(response.results.map(\.n) == [5])
    let sent = try #require(Stub.seen.withLock { $0["push.test"] }?.first)
    #expect(sent.request.httpMethod == "POST")
    #expect(sent.request.url?.path == "/v1/sync/push")
    #expect(sent.request.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
    #expect(sent.request.value(forHTTPHeaderField: "Sync-Schema") == "3")
    #expect(sent.request.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(sent.body.map { String(decoding: $0, as: UTF8.self) } == Self.request.json.jcsText)
  }

  @Test func aFailureKeepsWhatItsBodyCarries() async throws {
    let transport = Stub.transport("failures.test") { request, _ in
      switch request.value(forHTTPHeaderField: "Authorization") {
      case "Bearer expired": (401, #"{"error": "unauthenticated", "serverTime": 2000, "epoch": "ep-1"}"#)
      case "Bearer busy": (503, #"{"error": "unavailable", "retryAfterMs": 750, "serverTime": 2001, "epoch": "ep-1"}"#)
      default: (502, "<html>bad gateway</html>")
      }
    }
    let answers = [
      await transport.push(Self.request, token: SessionToken("expired")),
      await transport.push(Self.request, token: SessionToken("busy")),
      await transport.push(Self.request, token: SessionToken("proxy")),
    ].map { reply -> HTTPFailure? in
      guard case .answered(.failed(let failure)) = reply else { return nil }
      return failure
    }
    #expect(answers == [
      HTTPFailure(status: 401, error: "unauthenticated", serverTime: 2000, epoch: "ep-1"),
      HTTPFailure(status: 503, error: "unavailable", serverTime: 2001, epoch: "ep-1", retryAfterMs: 750),
      HTTPFailure(status: 502),
    ])
  }

  // A 200 that is no push response, and no response at all, are both retried as the network is.
  @Test func anUnreadableAnswerAndNoAnswerAreUnreachable() async throws {
    let garbled = Stub.transport("garbled.test") { _, _ in (200, #"{"serverTime": 1000}"#) }
    let silent = Stub.transport("silent.test") { _, _ in nil }
    for reply in [await garbled.push(Self.request, token: SessionToken("t")), await silent.push(Self.request, token: SessionToken("t"))] {
      guard case .unreachable = reply else { throw RigError("\(reply) is not unreachable") }
    }
  }

  @Test func aHelloWithoutATokenCarriesNoAuthorization() async throws {
    let transport = Stub.transport("hello.test") { _, _ in (200, #"{"serverTime": 1000, "epoch": "ep-1", "schema": 3, "minSchema": 1}"#) }
    guard case .answered(.ok(let hello)) = await transport.hello(token: nil) else { throw RigError("the hello was not answered ok") }
    #expect((hello.schema, hello.minSchema, hello.holdsRecords) == (3, 1, nil))
    let sent = try #require(Stub.seen.withLock { $0["hello.test"] }?.first)
    #expect(sent.request.httpMethod == "GET")
    #expect(sent.request.url?.path == "/v1/sync/hello")
    #expect(sent.request.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(sent.body == nil)
  }
}
