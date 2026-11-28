import Foundation
import Synchronization
import Agent
import SyncCore

nonisolated public struct AiRequest: Sendable {
  public let method: String
  public let path: String
  public let headers: [String: String]
  public let body: [UInt8]?
  public init(method: String, path: String, headers: [String: String], body: [UInt8]? = nil) {
    self.method = method; self.path = path; self.headers = headers; self.body = body
  }
}

nonisolated public struct AiResponse: Sendable {
  public let status: Int
  public let contentType: String
  public let bytes: AsyncThrowingStream<[UInt8], Error>
  public init(status: Int, contentType: String, bytes: AsyncThrowingStream<[UInt8], Error>) {
    self.status = status; self.contentType = contentType; self.bytes = bytes
  }
}

nonisolated public enum AiSocketFrame: Sendable, Equatable {
  case text(String)
  case binary([UInt8])
}

@MainActor public protocol AiSocket: AnyObject, Sendable {
  func send(_ frame: AiSocketFrame, sent: @escaping @MainActor () -> Void)
  func receive() async throws -> AiSocketFrame?
  func ping(answered: @escaping @MainActor () -> Void)
  func close()
}

nonisolated public enum AiUpgrade: Sendable {
  case open(any AiSocket)
  case refused(status: Int)
}

@MainActor public protocol AiTransport: AnyObject {
  func send(_ request: AiRequest) async throws -> AiResponse
  func upgrade(_ request: AiRequest, subprotocol: String) async throws -> AiUpgrade
  func cancel()
}

extension AiTransport {
  public func cancel() {}
  public func upgrade(_ request: AiRequest, subprotocol: String) async throws -> AiUpgrade { throw AiTransportFailure.transport }
}

nonisolated public enum AiTransportFailure: Error { case offline, transport, invalidOrigin, invalidResponse }

public final class AiURLSessionTransport: AiTransport {
  let origin: URL
  var session: URLSession
  let configuration: URLSessionConfiguration

  public init(origin: URL, configuration: URLSessionConfiguration = .ephemeral, allowLoopbackHTTP: Bool = false) throws {
    let loopback = allowLoopbackHTTP && origin.scheme == "http" && ["127.0.0.1", "::1", "[::1]"].contains(origin.host ?? "")
    guard origin.scheme == "https" || loopback, origin.host != nil, origin.user == nil, origin.password == nil,
          origin.query == nil, origin.fragment == nil, origin.path.isEmpty || origin.path == "/"
    else { throw AiTransportFailure.invalidOrigin }
    self.origin = origin
    let config = configuration.copy() as! URLSessionConfiguration
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCredentialStorage = nil
    config.urlCache = nil
    config.httpAdditionalHeaders = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.timeoutIntervalForRequest = 60
    config.timeoutIntervalForResource = 1_200
    self.configuration = config
    session = URLSession(configuration: config, delegate: AiRedirectPolicy(), delegateQueue: nil)
  }

  public func cancel() {
    session.invalidateAndCancel()
    session = URLSession(configuration: configuration, delegate: AiRedirectPolicy(), delegateQueue: nil)
  }

  public func send(_ input: AiRequest) async throws -> AiResponse {
    var request = URLRequest(url: try pinned(input.path))
    request.httpMethod = input.method
    request.httpShouldHandleCookies = false
    request.httpBody = input.body.map { Data($0) }
    for (name, value) in input.headers { request.setValue(value, forHTTPHeaderField: name) }
    do {
      let (bytes, response) = try await session.bytes(for: request)
      guard let response = response as? HTTPURLResponse, response.url?.host == origin.host,
            response.url?.scheme == origin.scheme, response.url?.port == origin.port
      else { throw AiTransportFailure.invalidResponse }
      let stream = AsyncThrowingStream<[UInt8], Error> { continuation in
        let task = Task {
          do {
            var chunk: [UInt8] = []
            for try await byte in bytes {
              chunk.append(byte)
              if byte == 10 || chunk.count >= 1024 { continuation.yield(chunk); chunk.removeAll(keepingCapacity: true) }
            }
            if !chunk.isEmpty { continuation.yield(chunk) }
            continuation.finish()
          } catch {
            continuation.finish(throwing: Self.classify(error))
          }
        }
        continuation.onTermination = { _ in task.cancel() }
      }
      return AiResponse(status: response.statusCode, contentType: response.value(forHTTPHeaderField: "Content-Type") ?? "", bytes: stream)
    } catch { throw Self.classify(error) }
  }

  public func upgrade(_ input: AiRequest, subprotocol: String) async throws -> AiUpgrade {
    var components = URLComponents(url: try pinned(input.path), resolvingAgainstBaseURL: false)
    components?.scheme = origin.scheme == "https" ? "wss" : "ws"
    guard let url = components?.url else { throw AiTransportFailure.invalidOrigin }
    var request = URLRequest(url: url)
    request.httpShouldHandleCookies = false
    for (name, value) in input.headers { request.setValue(value, forHTTPHeaderField: name) }
    request.setValue(subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
    let task = session.webSocketTask(with: request)
    let opening = AiSocketOpening()
    task.delegate = opening
    task.resume()
    switch await withTaskCancellationHandler(operation: { await opening.outcome() }, onCancel: { task.cancel() }) {
    case .open(let chosen):
      guard chosen == subprotocol, let response = task.response as? HTTPURLResponse, response.url?.host == origin.host,
            response.url?.port == origin.port else { task.cancel(); throw AiTransportFailure.invalidResponse }
      return .open(AiURLSessionSocket(task: task))
    case .refused(let status):
      task.cancel()
      return .refused(status: status)
    case .unanswered(let failure):
      task.cancel()
      throw failure
    }
  }

  func pinned(_ path: String) throws -> URL {
    guard path.hasPrefix("/v1/"), !path.contains("\\"),
          let url = URL(string: path, relativeTo: origin)?.absoluteURL,
          url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port,
          url.user == nil, url.password == nil, url.fragment == nil
    else { throw AiTransportFailure.invalidOrigin }
    return url
  }

  nonisolated static func classify(_ error: Error) -> AiTransportFailure {
    if let error = error as? AiTransportFailure { return error }
    if let error = error as? URLError,
       [.notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(error.code) {
      return .offline
    }
    return .transport
  }
}

final class AiURLSessionSocket: AiSocket {
  var task: URLSessionWebSocketTask?
  init(task: URLSessionWebSocketTask) { self.task = task }

  func send(_ frame: AiSocketFrame, sent: @escaping @MainActor () -> Void) {
    let message: URLSessionWebSocketTask.Message = switch frame {
    case .text(let text): .string(text)
    case .binary(let bytes): .data(Data(bytes))
    }
    task?.send(message) { _ in Task { @MainActor in sent() } }
  }

  func receive() async throws -> AiSocketFrame? {
    guard let task else { return nil }
    do {
      switch try await task.receive() {
      case .string(let text): return .text(text)
      case .data(let data): return .binary([UInt8](data))
      @unknown default: throw AiTransportFailure.invalidResponse
      }
    } catch {
      if [.normalClosure, .goingAway].contains(task.closeCode) { return nil }
      throw AiURLSessionTransport.classify(error)
    }
  }

  func ping(answered: @escaping @MainActor () -> Void) {
    task?.sendPing { error in if error == nil { Task { @MainActor in answered() } } }
  }

  func close() {
    task?.cancel(with: .normalClosure, reason: nil)
    task = nil
  }
}

nonisolated final class AiSocketOpening: NSObject, URLSessionWebSocketDelegate, Sendable {
  enum Outcome: Sendable {
    case open(String?)
    case refused(Int)
    case unanswered(AiTransportFailure)
  }
  let state = Mutex<(outcome: Outcome?, waiter: CheckedContinuation<Outcome, Never>?)>((nil, nil))

  func outcome() async -> Outcome {
    await withCheckedContinuation { continuation in
      let settled = state.withLock { state -> Outcome? in
        if state.outcome == nil { state.waiter = continuation }
        return state.outcome
      }
      if let settled { continuation.resume(returning: settled) }
    }
  }

  func settle(_ outcome: Outcome) {
    let waiter = state.withLock { state -> CheckedContinuation<Outcome, Never>? in
      guard state.outcome == nil else { return nil }
      state.outcome = outcome
      defer { state.waiter = nil }
      return state.waiter
    }
    waiter?.resume(returning: outcome)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol chosen: String?) {
    settle(.open(chosen))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    if let status = (task.response as? HTTPURLResponse)?.statusCode, status != 101 { return settle(.refused(status)) }
    settle(.unanswered(AiURLSessionTransport.classify(error ?? AiTransportFailure.transport)))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

nonisolated final class AiRedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

struct AiEventParser {
  var buffer: [UInt8] = []
  var event = ""
  var id: Int64?
  var data: [String] = []

  mutating func append(_ bytes: [UInt8]) throws -> [AiEvent] {
    buffer += bytes
    guard buffer.count <= 2_000_000 else { throw AiTransportFailure.invalidResponse }
    var events: [AiEvent] = []
    while let newline = buffer.firstIndex(of: 10) {
      var line = Array(buffer[..<newline])
      buffer.removeFirst(newline + 1)
      if line.last == 13 { line.removeLast() }
      guard let text = String(bytes: line, encoding: .utf8) else { throw AiTransportFailure.invalidResponse }
      if text.isEmpty {
        if !data.isEmpty {
          guard let id, id > 0, !event.isEmpty else { throw AiTransportFailure.invalidResponse }
          events.append(AiEvent(id: id, name: event, data: try JSON(parsing: data.joined(separator: "\n"))))
        }
        event = ""; id = nil; data = []
      } else if !text.hasPrefix(":") {
        let parts = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        var value = parts.count == 2 ? String(parts[1]) : ""
        if value.hasPrefix(" ") { value.removeFirst() }
        switch parts[0] {
        case "event": event = value
        case "id": id = Int64(value)
        case "data": data.append(value)
        default: break
        }
      }
    }
    return events
  }
}
