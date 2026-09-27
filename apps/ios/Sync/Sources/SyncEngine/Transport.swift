import Foundation
import SyncCore

// The wire to the sync server (§9): the `SyncTransport` port and its `URLSession` implementation. A transport only
// encodes, sends, decodes and classifies; the engine reads the clocks around each call and decides every retry.

// One exchange: the server's answer, a 200 body or a failure with what its body carried; or none at all.
public enum Reply<Body: Sendable>: Sendable {
  case answered(Answer<Body>)
  // No response (offline, timeout, reset, TLS), or a 200 whose body is not a response of its kind: retried with backoff.
  case unreachable
}

// A §9 response a reply decodes.
public protocol ResponseBody: Sendable {
  init(json: JSON) throws
}

extension HelloResponse: ResponseBody {}
extension PushResponse: ResponseBody {}
extension PullResponse: ResponseBody {}

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
}

// HTTPS through an ephemeral `URLSession`: no cookies, no cache, no waiting for connectivity, since the engine decides
// retries; 30 s of silence or 60 s in all ends a request, so a trickling server cannot hold the one push in flight.
// Every request carries `Sync-Schema` (§9.1); bodies are JCS bytes.
public final class HTTPTransport: SyncTransport {
  let baseURL: URL
  let schema: Int
  let session: URLSession

  // `schema`: the registry version the engine was built with.
  public init(baseURL: URL, schema: Int, configuration: URLSessionConfiguration = .ephemeral) {
    let configuration = configuration.copy() as! URLSessionConfiguration
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 60
    configuration.waitsForConnectivity = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    self.baseURL = baseURL
    self.schema = schema
    session = URLSession(configuration: configuration)
  }

  public func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    await exchange("GET", "v1/sync/hello", body: nil, token: token)
  }

  public func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    await exchange("POST", "v1/sync/push", body: request.json, token: token)
  }

  public func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> {
    await exchange("POST", "v1/sync/pull", body: request.json, token: token)
  }

  func exchange<Body: ResponseBody>(_ method: String, _ path: String, body: JSON?, token: SessionToken?) async -> Reply<Body> {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpMethod = method
    request.setValue(String(schema), forHTTPHeaderField: "Sync-Schema")
    if let token { request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization") }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = Data(body.jcs)
    }
    guard let (data, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse else {
      return .unreachable
    }
    return Reply(status: http.statusCode, body: try? JSON(parsing: [UInt8](data)))
  }
}
