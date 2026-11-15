import Foundation
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

@MainActor public protocol AiTransport: AnyObject {
  func send(_ request: AiRequest) async throws -> AiResponse
  func cancel()
}

extension AiTransport { public func cancel() {} }

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
    guard input.path.hasPrefix("/v1/"), !input.path.contains("\\"),
          let url = URL(string: input.path, relativeTo: origin)?.absoluteURL,
          url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port,
          url.user == nil, url.password == nil, url.fragment == nil
    else { throw AiTransportFailure.invalidOrigin }
    var request = URLRequest(url: url)
    request.httpMethod = input.method
    request.httpShouldHandleCookies = false
    request.httpBody = input.body.map(Data.init)
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

  nonisolated static func classify(_ error: Error) -> Error {
    if let error = error as? AiTransportFailure { return error }
    if let error = error as? URLError,
       [.notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(error.code) {
      return AiTransportFailure.offline
    }
    return AiTransportFailure.transport
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
