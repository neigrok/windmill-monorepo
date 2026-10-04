import Foundation
import SyncCore
import Synchronization

// The wire to the sync server (§9): the `SyncTransport` port with its live socket, and their `URLSession`
// implementations. A transport only encodes, sends, decodes and classifies; the engine reads the clocks around each call
// and decides every retry.

// One exchange: the server's answer, a 200 body or a failure with what its body carried; or none at all.
public enum Reply<Body: Sendable>: Sendable {
  case answered(Answer<Body>)
  // No response (offline, timeout, reset, TLS), or a 200 whose body is not a response of its kind: retried with backoff.
  case unreachable
}

extension Reply where Body: ResponseBody {
  // A status and its JSON body, as every transport classifies them. A failure keeps what its body carries (`serverTime`
  // and `epoch` for the offset sample, `retryAfterMs`), or only its status when the body is not JSON of that shape.
  public init(status: Int, body: JSON?) {
    guard status == 200 else {
      self = .answered(.failed((try? HTTPFailure(status: status, body: body)) ?? HTTPFailure(status: status)))
      return
    }
    guard let body, let response = try? Body(json: body) else {
      self = .unreachable
      return
    }
    self = .answered(.ok(response))
  }
}

public protocol SyncTransport: Sendable {
  // §9.2 `GET /v1/sync/hello`; `holdsRecords` comes only with a token.
  func hello(token: SessionToken?) async -> Reply<HelloResponse>
  // §9.3 `POST /v1/sync/push`.
  func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse>
  // §9.4 `POST /v1/sync/pull`; readable trees pull without a token.
  func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse>
  // §9.5 `WebSocket /v1/sync/live`: an open socket, or the handshake's failure by its status (a 401, a 426).
  func openLive(token: SessionToken) async -> Reply<any LiveConnection>
}

// §9.5 one open socket. `receive` answers the next frame, nil once the socket has closed, and throws when it failed or a
// frame could not be read; one caller receives at a time.
public protocol LiveConnection: Sendable {
  func send(_ request: LiveRequest) async throws
  func receive() async throws -> LiveFrame?
  func close()
}

// HTTPS through an ephemeral `URLSession`: no cookies, no cache, no waiting for connectivity, since the engine decides
// retries; 30 s of silence or REQUEST_TIMEOUT_MS in all ends a request, so a trickling server cannot hold the one push in
// flight. The live socket has a session of its own, which ends a handshake after 30 s of silence and never ends an open
// socket for its age. Every request names the registry version it speaks (§9.1): hello, push and pull in the header
// `Sync-Schema`, the live socket's upgrade in the query parameter `schema`. Bodies and live messages are JCS bytes.
public final class HTTPTransport: SyncTransport {
  let baseURL: URL
  let schema: Int
  let session: URLSession
  let liveSession: URLSession
  let telemetry: any Telemetry

  // `schema`: the registry version the engine was built with.
  public init(baseURL: URL, schema: Int, configuration: URLSessionConfiguration = .ephemeral,
              telemetry: any Telemetry = NoopTelemetry()) {
    let configuration = configuration.copy() as! URLSessionConfiguration
    configuration.timeoutIntervalForRequest = 30
    configuration.waitsForConnectivity = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    let live = configuration.copy() as! URLSessionConfiguration
    configuration.timeoutIntervalForResource = TimeInterval(Constants.requestTimeoutMs) / 1000
    self.baseURL = baseURL
    self.schema = schema
    self.telemetry = telemetry
    session = URLSession(configuration: configuration)
    liveSession = URLSession(configuration: live)
  }

  public func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    await exchange("GET", "v1/sync/hello", operation: "sync_hello", body: nil, token: token)
  }

  public func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    await exchange("POST", "v1/sync/push", operation: "sync_push", body: request.body, token: token)
  }

  public func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> {
    await exchange("POST", "v1/sync/pull", operation: "sync_pull", body: request.body, token: token)
  }

  // §9.5 `GET /v1/sync/live?schema=<version>`, over `ws` or `wss` as the base URL goes over `http` or `https`; frames
  // above LIVE_FRAME_BYTES fail the socket.
  public func openLive(token: SessionToken) async -> Reply<any LiveConnection> {
    let start = ContinuousClock.now
    var components = URLComponents(url: baseURL.appending(path: "v1/sync/live"), resolvingAgainstBaseURL: false)!
    components.scheme = components.scheme == "http" ? "ws" : "wss"
    components.queryItems = [URLQueryItem(name: "schema", value: String(schema))]
    var request = URLRequest(url: components.url!)
    request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
    let task = liveSession.webSocketTask(with: request)
    task.maximumMessageSize = Constants.liveFrameBytes
    let opening = WebSocketOpening()
    task.delegate = opening
    task.resume()
    switch await withTaskCancellationHandler(operation: { await opening.outcome() }, onCancel: { task.cancel() }) {
    case .open:
      return .answered(.ok(WebSocketConnection(task: task, telemetry: telemetry)))
    case .refused(let status):
      task.cancel()
      if !Task.isCancelled {
        TransportDiagnostics.report(telemetry, operation: "sync_live", method: "GET", kind: "http", status: status,
                                    durationMs: TransportDiagnostics.elapsed(since: start))
      }
      return .answered(.failed(HTTPFailure(status: status)))
    case .unanswered(let kind):
      task.cancel()
      if !Task.isCancelled, let kind {
        TransportDiagnostics.report(telemetry, operation: "sync_live", method: "GET", kind: kind,
                                    durationMs: TransportDiagnostics.elapsed(since: start))
      }
      return .unreachable
    }
  }

  func exchange<Body: ResponseBody>(_ method: String, _ path: String, operation: String, body: [UInt8]?,
                                    token: SessionToken?) async -> Reply<Body> {
    let start = ContinuousClock.now
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpMethod = method
    request.setValue(String(schema), forHTTPHeaderField: "Sync-Schema")
    if let token { request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization") }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = Data(body)
    }
    do {
      let (data, response) = try await session.data(for: request)
      guard !Task.isCancelled else { return .unreachable }
      guard let http = response as? HTTPURLResponse else {
        TransportDiagnostics.report(telemetry, operation: operation, method: method, kind: "transport",
                                    durationMs: TransportDiagnostics.elapsed(since: start))
        return .unreachable
      }
      let reply = Reply<Body>(status: http.statusCode, body: try? JSON(parsing: [UInt8](data)))
      if http.statusCode != 200 {
        TransportDiagnostics.report(telemetry, operation: operation, method: method, kind: "http", status: http.statusCode,
                                    durationMs: TransportDiagnostics.elapsed(since: start))
      } else if case .unreachable = reply {
        TransportDiagnostics.report(telemetry, operation: operation, method: method, kind: "decode", status: 200,
                                    durationMs: TransportDiagnostics.elapsed(since: start))
      }
      return reply
    } catch {
      if !Task.isCancelled, let kind = TransportDiagnostics.kind(error) {
        TransportDiagnostics.report(telemetry, operation: operation, method: method, kind: kind,
                                    durationMs: TransportDiagnostics.elapsed(since: start))
      }
      return .unreachable
    }
  }
}

// A socket's handshake as its task reports it: open, refused with the status the upgrade was answered with, or not
// answered at all.
final class WebSocketOpening: NSObject, URLSessionWebSocketDelegate, Sendable {
  enum Outcome: Sendable {
    case open
    case refused(status: Int)
    case unanswered(kind: String?)
  }

  struct State {
    var outcome: Outcome?
    var waiter: CheckedContinuation<Outcome, Never>?
  }

  let state = Mutex(State())

  func outcome() async -> Outcome {
    await withCheckedContinuation { continuation in
      let settled = state.withLock { state -> Outcome? in
        if state.outcome == nil { state.waiter = continuation }
        return state.outcome
      }
      if let settled { continuation.resume(returning: settled) }
    }
  }

  // The first report settles the handshake; a socket that opened and later ends reports again, unheard.
  func settle(_ outcome: Outcome) {
    let waiter = state.withLock { state -> CheckedContinuation<Outcome, Never>? in
      guard state.outcome == nil else { return nil }
      state.outcome = outcome
      defer { state.waiter = nil }
      return state.waiter
    }
    waiter?.resume(returning: outcome)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    settle(.open)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    guard let status = (task.response as? HTTPURLResponse)?.statusCode else {
      return settle(.unanswered(kind: error.map { TransportDiagnostics.kind($0) } ?? "transport"))
    }
    settle(.refused(status: status))
  }
}

// An open `URLSessionWebSocketTask`: each message one JCS text frame, each frame read by the `SyncCore` parser.
final class WebSocketConnection: LiveConnection {
  let task: URLSessionWebSocketTask
  let telemetry: any Telemetry

  init(task: URLSessionWebSocketTask, telemetry: any Telemetry = NoopTelemetry()) {
    self.task = task
    self.telemetry = telemetry
  }

  func send(_ request: LiveRequest) async throws {
    let start = ContinuousClock.now
    do { try await task.send(.string(request.json.jcsText)) }
    catch {
      report(error, operation: "sync_live_send", since: start)
      throw error
    }
  }

  func receive() async throws -> LiveFrame? {
    let start = ContinuousClock.now
    let message: URLSessionWebSocketTask.Message
    do {
      message = try await task.receive()
    } catch {
      if task.closeCode == .normalClosure || task.closeCode == .goingAway { return nil }
      report(error, operation: "sync_live_receive", since: start)
      if task.closeCode != .invalid { return nil }
      throw error
    }
    do {
      switch message {
      case .string(let text): return try LiveFrame(json: JSON(parsing: Array(text.utf8)))
      case .data(let data): return try LiveFrame(json: JSON(parsing: [UInt8](data)))
      @unknown default: throw JSONError.shape("a live message of an unknown kind")
      }
    } catch {
      TransportDiagnostics.report(telemetry, operation: "sync_live_receive", method: "GET", kind: "decode",
                                  durationMs: TransportDiagnostics.elapsed(since: start))
      throw error
    }
  }

  func report(_ error: any Error, operation: String, since start: ContinuousClock.Instant) {
    if !Task.isCancelled, let kind = TransportDiagnostics.kind(error) {
      TransportDiagnostics.report(telemetry, operation: operation, method: "GET", kind: kind,
                                  durationMs: TransportDiagnostics.elapsed(since: start))
    }
  }

  func close() {
    task.cancel(with: .normalClosure, reason: nil)
  }
}
