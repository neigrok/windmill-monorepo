import Foundation
import Network
import SyncCore
import SyncEngine
import Synchronization
import Testing

// `HTTPTransport` against a stubbed URL loading system: what goes on the wire (§9.1–§9.4), and how each answer is
// classified (§9.6, design §6.2). Its live socket against servers on the loopback: a WebSocket server, and one that
// answers the upgrade with a plain HTTP status.

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

  // MARK: The live socket (§9.5)

  // A listener on the loopback, told apart from the tests' other servers by its queue: `start` returns its port once it
  // is ready, and `stop` returns once it is cancelled and its port closed.
  final class Loopback: Sendable {
    let listener: NWListener
    let queue: DispatchQueue

    init(using parameters: NWParameters, on queue: DispatchQueue) throws {
      listener = try NWListener(using: parameters, on: .any)
      self.queue = queue
    }

    func start() async throws -> UInt16 {
      try await withCheckedThrowingContinuation { continuation in
        listener.stateUpdateHandler = { [listener] state in
          switch state {
          case .ready:
            listener.stateUpdateHandler = nil
            continuation.resume(returning: listener.port!.rawValue)
          case .failed(let error):
            listener.stateUpdateHandler = nil
            continuation.resume(throwing: error)
          default:
            break
          }
        }
        listener.start(queue: queue)
      }
    }

    func stop() async {
      await withCheckedContinuation { continuation in
        listener.stateUpdateHandler = { state in
          if case .cancelled = state { continuation.resume() }
        }
        listener.cancel()
      }
    }

    deinit {
      listener.cancel()
    }
  }

  // What a loopback server saw, shared with its handlers: each request's head, each text message, and the last
  // connection.
  final class Seen: Sendable {
    struct State {
      var heads: [String] = []
      var received: [String] = []
      var receivers: [(count: Int, continuation: CheckedContinuation<[String], Never>)] = []
      var connection: NWConnection?
    }

    let state = Mutex(State())
  }

  // A WebSocket server on the loopback: it keeps every text message it receives, and sends what the test hands it.
  final class SocketServer: Sendable {
    let loopback: Loopback
    let seen = Seen()

    init() throws {
      let queue = DispatchQueue(label: "windmill.test.socket-server")
      let options = NWProtocolWebSocket.Options()
      options.setClientRequestHandler(queue) { _, _ in NWProtocolWebSocket.Response(status: .accept, subprotocol: nil) }
      let parameters = NWParameters.tcp
      parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
      loopback = try Loopback(using: parameters, on: queue)
      loopback.listener.newConnectionHandler = { [seen] connection in
        seen.state.withLock { $0.connection = connection }
        connection.start(queue: queue)
        Self.receive(on: connection, into: seen)
      }
    }

    static func receive(on connection: NWConnection, into seen: Seen) {
      connection.receiveMessage { content, _, _, error in
        guard error == nil else { return }
        if let content {
          let answered = seen.state.withLock { state -> [(CheckedContinuation<[String], Never>, [String])] in
            state.received.append(String(decoding: content, as: UTF8.self))
            let count = state.received.count
            defer { state.receivers.removeAll { $0.count <= count } }
            return state.receivers.filter { $0.count <= count }.map { ($0.continuation, state.received) }
          }
          for (receiver, received) in answered { receiver.resume(returning: received) }
        }
        Self.receive(on: connection, into: seen)
      }
    }

    // The text messages received, once there are `count` of them or more.
    func received(_ count: Int) async -> [String] {
      await withCheckedContinuation { continuation in
        let received = seen.state.withLock { state -> [String]? in
          guard state.received.count < count else { return state.received }
          state.receivers.append((count, continuation))
          return nil
        }
        if let received { continuation.resume(returning: received) }
      }
    }

    func send(_ text: String) {
      let context = NWConnection.ContentContext(identifier: "text", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
      seen.state.withLock(\.connection)?.send(content: Data(text.utf8), contentContext: context, completion: .idempotent)
    }
  }

  // A server that reads each request's head, keeps it, and answers with `status` and no upgrade.
  final class RefusingServer: Sendable {
    let loopback: Loopback
    let seen = Seen()

    init(status: Int) throws {
      let queue = DispatchQueue(label: "windmill.test.refusing-server")
      loopback = try Loopback(using: .tcp, on: queue)
      loopback.listener.newConnectionHandler = { [seen] connection in
        connection.start(queue: queue)
        Self.answer(connection, status: status, after: Data(), into: seen)
      }
    }

    // Reads until the head's blank line, keeps the head, then answers and closes.
    static func answer(_ connection: NWConnection, status: Int, after read: Data, into seen: Seen) {
      connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { content, _, isComplete, error in
        let head = read + (content ?? Data())
        guard head.range(of: Data("\r\n\r\n".utf8)) != nil || isComplete || error != nil else {
          return Self.answer(connection, status: status, after: head, into: seen)
        }
        seen.state.withLock { $0.heads.append(String(decoding: head, as: UTF8.self)) }
        let answer = "HTTP/1.1 \(status) Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(answer.utf8), completion: .contentProcessed { _ in connection.cancel() })
      }
    }
  }

  // §9.1, §9.5: the upgrade is `GET /v1/sync/live?schema=<version>`, the version in the query where every surface can
  // put it and in no header, and the token in `Authorization` as every other request carries it.
  @Test(.timeLimit(.minutes(1))) func theUpgradeCarriesTheSchemaInItsQueryAndTheToken() async throws {
    let server = try RefusingServer(status: 426)
    let port = try await server.loopback.start()
    let transport = HTTPTransport(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, schema: 3)
    _ = await transport.openLive(token: SessionToken("secret"))
    let head = try #require(server.seen.state.withLock(\.heads).first)
    let lines = head.components(separatedBy: "\r\n")
    let headers = Dictionary(lines.dropFirst().compactMap { line -> (String, String)? in
      guard let colon = line.firstIndex(of: ":") else { return nil }
      return (line[..<colon].lowercased(), line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
    }, uniquingKeysWith: { first, _ in first })
    #expect(lines.first == "GET /v1/sync/live?schema=3 HTTP/1.1")
    #expect(headers["authorization"] == "Bearer secret")
    #expect(headers["sync-schema"] == nil)
  }

  // Requests go as JCS text, and frames come back parsed.
  @Test(.timeLimit(.minutes(1))) func aLiveSocketSpeaksJCS() async throws {
    let server = try SocketServer()
    let port = try await server.loopback.start()
    let transport = HTTPTransport(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, schema: 3)
    guard case .answered(.ok(let connection)) = await transport.openLive(token: SessionToken("secret")) else {
      throw RigError("the socket did not open")
    }
    try await connection.send(.sub([.product("probe")]))
    try await connection.send(.ping)
    #expect(await server.received(2) == [#"{"op":"sub","scopes":["self/probe"]}"#, #"{"op":"ping"}"#])
    server.send(#"{"op": "pong"}"#)
    server.send(#"{"op": "not-found", "scope": "tree/b_00000001"}"#)
    #expect(try await connection.receive() == .pong)
    #expect(try await connection.receive() == .notFound(.tree("b_00000001")))
    connection.close()
  }

  // A frame above LIVE_FRAME_BYTES fails the socket.
  @Test(.timeLimit(.minutes(1))) func aFrameAboveTheLimitFailsTheSocket() async throws {
    let server = try SocketServer()
    let port = try await server.loopback.start()
    let transport = HTTPTransport(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, schema: 3)
    guard case .answered(.ok(let connection)) = await transport.openLive(token: SessionToken("secret")) else {
      throw RigError("the socket did not open")
    }
    server.send(#"{"op": "other", "pad": ""# + String(repeating: "x", count: Constants.liveFrameBytes) + #""}"#)
    await #expect(throws: (any Error).self) { _ = try await connection.receive() }
  }

  // An upgrade answered with a status opens no socket, and answers that status.
  @Test(.timeLimit(.minutes(1)), arguments: [401, 426])
  func aRefusedUpgradeAnswersItsStatus(_ status: Int) async throws {
    let server = try RefusingServer(status: status)
    let port = try await server.loopback.start()
    let transport = HTTPTransport(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, schema: 3)
    guard case .answered(.failed(let failure)) = await transport.openLive(token: SessionToken("secret")) else {
      throw RigError("the refused upgrade was not answered with its status")
    }
    #expect(failure == HTTPFailure(status: status))
  }

  // A port no server listens on any more answers nothing.
  @Test(.timeLimit(.minutes(1))) func noServerIsUnreachable() async throws {
    let server = try RefusingServer(status: 401)
    let port = try await server.loopback.start()
    await server.loopback.stop()
    let transport = HTTPTransport(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, schema: 3)
    guard case .unreachable = await transport.openLive(token: SessionToken("secret")) else {
      throw RigError("a closed port was not unreachable")
    }
  }
}
