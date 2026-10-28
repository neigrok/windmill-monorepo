import Foundation
import GymDomain
import SyncCore

// The Coach turn wire (Coach §6): the four routes a phone speaks during a turn, over URLSession, and the frames the turn
// stream carries. A bound seat authenticates with its session token, an anon seat with the installation credential; every
// request of a turn uses the seat that opened it.

nonisolated enum TurnSeat: Equatable, Sendable {
  case bound(token: String)
  case anon(credential: String)

  var seat: Seat {
    switch self {
    case .bound: .bound
    case .anon: .anon
    }
  }
}

// §6.2, the open body: the question, the model copies of its pictures, the newest completed turns and the context reads.
nonisolated struct TurnOpenRequest: Equatable, Sendable {
  static let catalog = "catalog/1"

  struct Picture: Equatable, Sendable {
    let id: String
    let mediaType: String
    let data: Data
  }

  struct Line: Equatable, Sendable {
    let role: CoachMessage.Role
    let text: String
  }

  struct ContextRead: Equatable, Sendable {
    let name: String
    let input: JSON
    let result: JSON
  }

  let turnId: String
  let question: String
  let pictures: [Picture]
  let history: [Line]
  let context: [ContextRead]

  var json: JSON {
    ["catalog": .string(Self.catalog), "turnId": .string(turnId), "question": .string(question),
     "pictures": .array(pictures.map { ["id": .string($0.id), "mediaType": .string($0.mediaType), "data": .string($0.data.base64EncodedString())] }),
     "history": .array(history.map { ["role": .string($0.role.rawValue), "text": .string($0.text)] }),
     "context": .array(context.map { ["name": .string($0.name), "input": $0.input, "result": $0.result] })]
  }
}

// §4.3, one batch of ability calls the server sends the phone.
nonisolated struct TurnBatch: Equatable, Sendable {
  let batch: Int
  let calls: [AbilityRequest]

  init(batch: Int, calls: [AbilityRequest]) {
    self.batch = batch
    self.calls = calls
  }

  init(_ json: JSON) throws {
    batch = Int(try json.member("batch").asInteger(atLeast: 1))
    calls = try json.member("calls").asArray().map { call in
      AbilityRequest(callId: try call.member("callId").asString(), name: try call.member("name").asString(), input: try call.member("input"))
    }
  }
}

// §6.4, what the phone answers for one call: the result the executor produced, or the code it refused with.
nonisolated struct TurnResult: Equatable, Sendable {
  enum Outcome: Equatable, Sendable {
    case ok(JSON)
    case refused(String)
  }

  static let tooLarge = "result-too-large"

  let callId: String
  let outcome: Outcome

  var json: JSON {
    switch outcome {
    case .ok(let result): ["callId": .string(callId), "ok": true, "result": result]
    case .refused(let code): ["callId": .string(callId), "ok": false, "code": .string(code)]
    }
  }
}

// §6.3, the frames of a turn stream, heartbeats aside.
nonisolated enum TurnEvent: Equatable, Sendable {
  case snapshot(text: String, state: MessageState, batch: TurnBatch?)
  case text(String)
  case calls(TurnBatch)
  case done(state: MessageState, truncated: Bool)
  case error(code: String)

  init(event: String, data: JSON) throws {
    switch event {
    case "snapshot":
      let batch = (try? data.member("calls")).flatMap { $0.isNull ? nil : $0 }
      self = .snapshot(text: try data.member("text").asString(), state: try Self.state(of: data), batch: try batch.map(TurnBatch.init))
    case "text": self = .text(try data.member("delta").asString())
    case "calls": self = .calls(try TurnBatch(data))
    case "done": self = .done(state: try Self.state(of: data), truncated: (try? data.member("truncated").asBool()) ?? false)
    case "error": self = .error(code: try data.member("code").asString())
    default: throw TurnWireFault.unknownEvent
    }
  }

  static func state(of data: JSON) throws -> MessageState {
    guard let state = MessageState(rawValue: try data.member("state").asString()) else { throw TurnWireFault.unknownState }
    return state
  }
}

// A refusal the server answered a turn request with before its stream, by §6.5 code.
nonisolated struct TurnRefusal: Error, Equatable, Sendable {
  let status: Int
  let code: String

  static let turnUnknown = "coach-turn-unknown"
  static let allowanceCodes: Set<String> = ["subject_exhausted", "free_month_exhausted", "free_day_exhausted", "concurrency_exhausted",
                                            "funding_required", "debt_outstanding", "device_bound", "invalid_installation"]
}

// The wire's own faults: a frame or an answer the stream cannot be read as.
nonisolated enum TurnWireFault: Error, Equatable, Sendable {
  case unknownEvent, unknownState, notAStream, lineTooLong, endedWithoutTerminal
}

nonisolated enum TurnAnswer: Equatable, Sendable {
  case accepted, replayed
}

// A stream of text/event-stream lines: `event:` and `data:` lines gather one frame, a blank line ends it, and a `:` line
// is a heartbeat comment.
nonisolated struct TurnSSE {
  var event = ""
  var lines: [String] = []

  mutating func consume(_ line: String) -> (event: String, data: String)? {
    if line.isEmpty {
      defer { event = ""; lines = [] }
      return lines.isEmpty ? nil : (event, lines.joined(separator: "\n"))
    }
    if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
    if line.hasPrefix("data:") { lines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)) }
    return nil
  }
}

@MainActor final class CoachTurnWire {
  nonisolated static let idleTimeout: TimeInterval = 60
  nonisolated static let maxLineBytes = 1_048_576

  let baseURL: URL?
  let session: URLSession

  init(baseURL: URL?, session: URLSession? = nil) {
    self.baseURL = baseURL
    self.session = session ?? Self.streamingSession()
  }

  static func streamingSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil
    configuration.waitsForConnectivity = false
    configuration.timeoutIntervalForRequest = idleTimeout
    configuration.timeoutIntervalForResource = 3600
    return URLSession(configuration: configuration)
  }

  func open(_ open: TurnOpenRequest, seat: TurnSeat) throws -> AsyncThrowingStream<TurnEvent, any Error> {
    stream(try request("/v1/gym/coach/turns", method: "POST", body: Data(open.json.jcs), seat: seat))
  }

  func resume(_ turnId: String, seat: TurnSeat) throws -> AsyncThrowingStream<TurnEvent, any Error> {
    stream(try request("/v1/gym/coach/turns/\(turnId)", seat: seat))
  }

  func answer(_ turnId: String, batch: Int, results: [TurnResult], seat: TurnSeat) async throws -> TurnAnswer {
    let body: JSON = ["batch": JSON(batch), "results": .array(results.map(\.json))]
    let (status, _) = try await data(for: try request("/v1/gym/coach/turns/\(turnId)/results", method: "POST", body: Data(body.jcs), seat: seat))
    return status == 204 ? .replayed : .accepted
  }

  func stop(_ turnId: String, seat: TurnSeat) async throws -> MessageState {
    let (_, data) = try await data(for: try request("/v1/gym/coach/turns/\(turnId)/stop", method: "POST", body: Data("{}".utf8), seat: seat))
    return try TurnEvent.state(of: try JSON(parsing: Array(data)))
  }

  // Every request of a turn names a turn route under the configured host, and carries its seat's credential alone.
  func request(_ path: String, method: String = "GET", body: Data? = nil, seat: TurnSeat) throws -> URLRequest {
    guard let baseURL, path.hasPrefix("/v1/gym/coach/turns"), !path.contains(".."),
          let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
          url.host == baseURL.host, url.scheme == baseURL.scheme, url.port == baseURL.port else { throw URLError(.badURL) }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.timeoutInterval = Self.idleTimeout
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    switch seat {
    case .bound(let token): request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    case .anon(let credential): request.setValue(credential, forHTTPHeaderField: "X-Windmill-Installation")
    }
    return request
  }

  // A one-shot answer: its status, or the refusal its body names.
  func data(for request: URLRequest) async throws -> (Int, Data) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    guard (200..<300).contains(http.statusCode) else { throw Self.refusal(http.statusCode, data) }
    return (http.statusCode, data)
  }

  nonisolated static func refusal(_ status: Int, _ body: Data) -> TurnRefusal {
    let code = (try? JSON(parsing: Array(body)).member("code").asString()) ?? ""
    return TurnRefusal(status: status, code: code.isEmpty ? "coach-vendor-error" : code)
  }

  // The frames of one stream, parsed off the main actor, until its terminal frame; a stream that ends before one is a lost
  // connection, and a refusal before it starts is the HTTP error its body names.
  func stream(_ request: URLRequest) -> AsyncThrowingStream<TurnEvent, any Error> {
    var accepting = request
    accepting.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    let session = session
    let wireRequest = accepting
    return AsyncThrowingStream { continuation in
      let task = Task.detached {
        do {
          let (bytes, response) = try await session.bytes(for: wireRequest)
          guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
          guard (200..<300).contains(http.statusCode) else {
            var body = Data()
            for try await byte in bytes {
              body.append(byte)
              if body.count > Self.maxLineBytes { break }
            }
            throw Self.refusal(http.statusCode, body)
          }
          guard (http.value(forHTTPHeaderField: "Content-Type") ?? "").hasPrefix("text/event-stream") else { throw TurnWireFault.notAStream }
          var parser = TurnSSE(), line = Data()
          for try await byte in bytes {
            try Task.checkCancellation()
            guard byte == 10 else {
              line.append(byte)
              if line.count > Self.maxLineBytes { throw TurnWireFault.lineTooLong }
              continue
            }
            if line.last == 13 { line.removeLast() }
            guard let text = String(data: line, encoding: .utf8) else { throw URLError(.cannotDecodeContentData) }
            line.removeAll(keepingCapacity: true)
            guard let (event, data) = parser.consume(text) else { continue }
            let frame = try TurnEvent(event: event, data: try JSON(parsing: data))
            continuation.yield(frame)
            switch frame {
            case .done, .error: continuation.finish(); return
            case .snapshot(_, let state, _) where state.isTerminal: continuation.finish(); return
            default: break
            }
          }
          throw TurnWireFault.endedWithoutTerminal
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}
