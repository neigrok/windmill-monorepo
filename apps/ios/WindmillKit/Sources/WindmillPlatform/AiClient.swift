import Foundation
import Agent
import SyncCore

nonisolated struct AiDeliveryFailure: Error { let error: any Error }

nonisolated public struct AiCredentials: Sendable {
  public let session: String?
  public let installation: String?
  public init(session: String? = nil, installation: String? = nil) { self.session = session; self.installation = installation }
}

@MainActor public protocol AiClock: AnyObject {
  var nowMs: Int64 { get }
  func wait(ms: Int64) async throws
}

@MainActor public protocol AiDiagnostics: AnyObject {
  func failure(operation: String, kind: String)
}

@MainActor public final class AiSystemClock: AiClock {
  public init() {}
  public var nowMs: Int64 { Int64(ProcessInfo.processInfo.systemUptime * 1_000) }
  public func wait(ms: Int64) async throws { try await Task.sleep(for: .milliseconds(ms)) }
}

@MainActor public final class ServiceAiClient: AiClient {
  struct Pass {
    let token: String
    let expiresAt: Int64
    let seat: Seat
    let use: String
    let version: Int
  }
  let transport: any AiTransport
  let clock: any AiClock
  let diagnostics: any AiDiagnostics
  let credentials: @MainActor (Seat) throws -> AiCredentials
  var pass: Pass?
  var generation: UInt64 = 0
  var stop = false
  var waitTask: Task<Void, Error>?
  public private(set) var lastAllowance: JSON?

  public init(transport: any AiTransport, clock: any AiClock, diagnostics: any AiDiagnostics,
              credentials: @escaping @MainActor (Seat) throws -> AiCredentials) {
    self.transport = transport; self.clock = clock; self.diagnostics = diagnostics; self.credentials = credentials
  }

  public func seatWillChange() {
    generation &+= 1; pass = nil; lastAllowance = nil; stop = true; waitTask?.cancel(); transport.cancel()
  }
  public func invalidAnswer() { diagnostics.failure(operation: "ai-call", kind: "wire") }
  public func stopAskingAgain() { stop = true; waitTask?.cancel() }

  public func allowance(profile: Profile, seat: Seat) async throws -> JSON {
    let epoch = generation
    let response = try await authorized(method: "GET", path: "/v1/allowance", profile: profile, seat: seat, epoch: epoch)
    let value = try await body(response, operation: "ai-call")
    try fence(epoch)
    lastAllowance = value
    return value
  }

  public func upload(_ pictures: [Picture], profile: Profile, seat: Seat) async throws {
    let epoch = generation
    for picture in pictures {
      guard Self.validID(picture.pictureId), ["image/png", "image/jpeg"].contains(picture.mediaType) else {
        throw defect("invalid_request", source: .wire)
      }
      let response = try await authorized(method: "PUT", path: "/v1/pictures/\(picture.pictureId)",
        data: picture.bytes, contentType: picture.mediaType, profile: profile, seat: seat, epoch: epoch)
      guard response.status == 204 else { throw defect("invalid-answer", source: .wire) }
      try fence(epoch)
    }
  }

  public func call(id: String, request: JSON, profile: Profile, seat: Seat, pictures: [Picture],
                   receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws {
    try await round(id: id, body: request.jcs, profile: profile, seat: seat, pictures: pictures, recover: false, receive: receive)
  }

  public func recover(id: String, profile: Profile, seat: Seat,
                      receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws {
    try await round(id: id, body: nil, profile: profile, seat: seat, pictures: [], recover: true, receive: receive)
  }

  func round(id: String, body: [UInt8]?, profile: Profile, seat: Seat, pictures: [Picture], recover: Bool,
             receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws {
    guard Self.validID(id) else { throw defect("invalid_request", source: .wire) }
    stop = false
    let epoch = generation
    let deadline = clock.nowMs + 1_200_000
    var refusalDeadline: Int64?
    var lastRefusal: AiFailure?
    var cursor: Int64 = 0
    var admission: Admission = recover ? .admitted : .none
    var attempt = 0
    var passRefresh = false
    var pictureRefresh = false
    var askAgain = recover
    var lost = recover
    while true {
      try fence(epoch)
      if clock.nowMs >= deadline { throw AiFailure(source: .transport, code: "answer-timeout", admission: admission) }
      if !lost, let refusalDeadline, clock.nowMs >= refusalDeadline, let lastRefusal { throw lastRefusal }
      if stop && askAgain { throw AiFailure(source: .transport, code: "stopped", admission: admission) }
      let method = recover || cursor > 0 ? "GET" : "PUT"
      let label = profile.label.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#?"))) ?? ""
      let path = method == "GET" ? "/v1/calls/\(id)/result" + (cursor > 0 ? "?after=\(cursor)" : "") : "/v1/calls/\(id)/text?label=\(label)"
      let source: AiFailure.Source = method == "GET" ? .result : .text
      do {
        let token = try await token(profile: profile, seat: seat, epoch: epoch)
        let response = try await transport.send(AiRequest(method: method, path: path,
          headers: ["Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "text/event-stream"],
          body: method == "PUT" ? body : nil))
        try fence(epoch)
        if !(200..<300).contains(response.status) {
          let failure = try await refusal(response, source: source, admission: admission, epoch: epoch)
          try fence(epoch)
          if failure.code == "pass_expired" && !passRefresh { passRefresh = true; pass = nil; continue }
          if failure.code == "picture_gone" && !pictureRefresh && !pictures.isEmpty && method == "PUT" {
            pictureRefresh = true
            try await upload(pictures, profile: profile, seat: seat)
            continue
          }
          if failure.code == "busy" || failure.code == "accounting_unavailable" { admission = max(admission, .possible) }
          let result = AiFailure(source: source, code: failure.code, admission: admission, allowance: failure.allowance)
          lastRefusal = result
          if Self.defectCodes.contains(failure.code ?? "") || failure.code?.hasPrefix("pass_") == true || failure.code == "picture_gone" {
            throw defect(failure.code ?? "invalid-answer", source: source, admission: admission)
          }
          let transient = Self.transientCodes.contains(failure.code ?? "")
          if !transient { throw result }
          if refusalDeadline == nil { refusalDeadline = clock.nowMs + 30_000 }
          let until = lost ? deadline : min(deadline, refusalDeadline!)
          guard clock.nowMs < until else { throw result }
          askAgain = true
          try await wait(attempt: attempt, until: until, epoch: epoch, admission: admission)
          attempt += 1
          continue
        }
        guard response.contentType.lowercased().hasPrefix("text/event-stream") else {
          throw defect("invalid-answer", source: .wire, admission: max(admission, .possible))
        }
        var parser = AiEventParser()
        for try await chunk in response.bytes {
          try fence(epoch)
          let events: [AiEvent]
          do { events = try parser.append(chunk) }
          catch { throw defect("invalid-answer", source: .wire, admission: max(admission, .possible)) }
          for event in events {
            guard event.id > cursor else { continue }
            do { try Self.validate(event) }
            catch { throw defect("invalid-answer", source: .wire, admission: .admitted) }
            if event.name == "failed", let code = try event.data.asObject()["code"]?.asString(), Self.defectCodes.contains(code) {
              diagnostics.failure(operation: "ai-call", kind: "refusal")
            }
            cursor = event.id; admission = .admitted
            if let allowance = try event.data.asObject()["allowance"], allowance != .null { lastAllowance = allowance }
            do { try await receive(event) }
            catch { throw AiDeliveryFailure(error: error) }
            try fence(epoch)
            if event.name == "ended" || event.name == "failed" { return }
          }
        }
        admission = max(admission, .possible)
      } catch let failure as AiDeliveryFailure { throw failure.error }
      catch let failure as AiFailure {
        throw AiFailure(source: failure.source, code: failure.code, admission: max(admission, failure.admission), allowance: failure.allowance)
      } catch let failure as HostFailure { throw failure }
      catch {
        try fence(epoch)
        admission = max(admission, .possible)
        if error as? AiTransportFailure != .offline { diagnostics.failure(operation: "ai-call", kind: "transport") }
      }
      askAgain = true; lost = true
      guard clock.nowMs < deadline else { throw AiFailure(source: .transport, code: "answer-timeout", admission: admission) }
      try await wait(attempt: attempt, until: deadline, epoch: epoch, admission: admission)
      attempt += 1
    }
  }

  func wait(attempt: Int, until: Int64, epoch: UInt64, admission: Admission) async throws {
    if stop { throw AiFailure(source: .transport, code: "stopped", admission: admission) }
    let duration = min(Int64(1 << min(attempt, 3)) * 1_000, max(0, until - clock.nowMs))
    let task = Task { try await clock.wait(ms: duration) }
    waitTask = task
    do { try await task.value }
    catch { throw AiFailure(source: .transport, code: "stopped", admission: admission) }
    waitTask = nil
    try fence(epoch)
    if stop { throw AiFailure(source: .transport, code: "stopped", admission: admission) }
  }

  func token(profile: Profile, seat: Seat, epoch: UInt64) async throws -> String {
    if let pass, pass.seat == seat, pass.use == profile.name, pass.version == profile.version,
       pass.expiresAt - clock.nowMs >= 60_000 { return pass.token }
    let auth = try credentials(seat)
    var headers = ["Content-Type": "application/json", "Accept": "application/json"]
    if let session = auth.session { headers["Authorization"] = "Bearer " + session }
    if let installation = auth.installation { headers["X-Windmill-Installation"] = installation }
    let request = JSON.object(.init(uniqueKeysWithValues: [("client", .string("ios")),
      ("use", .string(profile.name)), ("version", .number(.init(profile.version)))]))
    let start = clock.nowMs
    do {
      let response = try await transport.send(AiRequest(method: "POST", path: "/v1/ai/passes", headers: headers, body: request.jcs))
      try fence(epoch)
      if !(200..<300).contains(response.status) { throw try await refusal(response, source: .pass, admission: .none, epoch: epoch) }
      let value = try await body(response, operation: "ai-pass").asObject()
      try fence(epoch)
      let token = try value.member("pass").asString()
      let expires = try value.member("expiresIn").asInteger()
      guard !token.isEmpty, expires > 0, expires <= 600_000 else { throw AiTransportFailure.invalidResponse }
      pass = Pass(token: token, expiresAt: start + expires, seat: seat, use: profile.name, version: profile.version)
      return token
    } catch let failure as AiFailure { throw failure }
    catch let failure as HostFailure { throw failure }
    catch {
      if error as? AiTransportFailure != .offline { diagnostics.failure(operation: "ai-pass", kind: "transport") }
      throw AiFailure(source: .pass, code: error as? AiTransportFailure == .offline ? "offline" : "invalid-answer")
    }
  }

  func authorized(method: String, path: String, data: [UInt8]? = nil, contentType: String = "application/json",
                  profile: Profile, seat: Seat, epoch: UInt64) async throws -> AiResponse {
    for attempt in 0...1 {
      let token = try await token(profile: profile, seat: seat, epoch: epoch)
      let response: AiResponse
      do {
        response = try await transport.send(AiRequest(method: method, path: path,
          headers: ["Authorization": "Bearer " + token, "Content-Type": contentType], body: data))
      } catch {
        if error as? AiTransportFailure != .offline { diagnostics.failure(operation: "ai-call", kind: "transport") }
        throw AiFailure(source: .transport, code: error as? AiTransportFailure == .offline ? "offline" : "invalid-answer")
      }
      try fence(epoch)
      if (200..<300).contains(response.status) { return response }
      let failure = try await refusal(response, source: .text, admission: .none, epoch: epoch)
      if failure.code == "pass_expired" && attempt == 0 { pass = nil; continue }
      if Self.defectCodes.contains(failure.code ?? "") || failure.code?.hasPrefix("pass_") == true {
        throw defect(failure.code ?? "invalid-answer", source: .text)
      }
      throw failure
    }
    throw defect("pass_expired", source: .text)
  }

  func body(_ response: AiResponse, operation: String) async throws -> JSON {
    var bytes: [UInt8] = []
    do {
      for try await chunk in response.bytes {
        bytes += chunk
        guard bytes.count <= 2_000_000 else { throw AiTransportFailure.invalidResponse }
      }
      return try JSON(parsing: bytes)
    } catch {
      diagnostics.failure(operation: operation, kind: "wire")
      throw AiFailure(source: .wire, code: "invalid-answer")
    }
  }

  func refusal(_ response: AiResponse, source: AiFailure.Source, admission: Admission, epoch: UInt64) async throws -> AiFailure {
    if source == .pass && response.status == 404 { return AiFailure(source: source, code: "not-found", admission: admission) }
    let value = try await body(response, operation: source == .pass ? "ai-pass" : "ai-call").asObject()
    guard let code = try value["code"]?.asString() else { throw defect("invalid-answer", source: .wire, admission: admission) }
    try fence(epoch)
    guard AiFailure.codes.contains(code) else { throw defect("invalid-answer", source: source, admission: admission) }
    let allowance = value["allowance"].flatMap { $0 == .null ? nil : $0 }
    if let allowance { lastAllowance = allowance }
    if source == .pass && Self.defectCodes.contains(code) { diagnostics.failure(operation: "ai-pass", kind: "refusal") }
    return AiFailure(source: source, code: code, admission: admission, allowance: allowance)
  }

  func fence(_ epoch: UInt64) throws { if epoch != generation { throw HostFailure.staleSeat } }
  func defect(_ code: String, source: AiFailure.Source, admission: Admission = .none) -> AiFailure {
    diagnostics.failure(operation: source == .pass ? "ai-pass" : "ai-call", kind: "wire")
    return AiFailure(source: source, code: code, admission: admission)
  }
  static let transientCodes: Set<String> = ["busy", "paused", "rate_limited", "concurrency_exhausted", "accounting_unavailable", "provider_unavailable"]
  static let defectCodes: Set<String> = ["invalid_request", "too_large", "provider_rejected", "funding_required", "conflict", "call_unknown"]
  static func validID(_ value: String) -> Bool {
    value.utf8.count == 22 && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }
  }
  static func validate(_ event: AiEvent) throws {
    let value = try event.data.asObject()
    switch event.name {
    case "started": _ = try value.member("callId").asString(); _ = try value.member("served").asString(); _ = try value.member("maxTokens").asInteger()
    case "text": _ = try value.member("delta").asString()
    case "toolCall": _ = try value.member("id").asString(); _ = try value.member("name").asString(); _ = try value.member("input")
    case "ended":
      guard ["completed", "tool_calls", "truncated", "declined"].contains(try value.member("stop").asString()) else { throw AiTransportFailure.invalidResponse }
      let message = try value.member("message").asObject()
      guard try message.member("role").asString() == "assistant" else { throw AiTransportFailure.invalidResponse }
      _ = try message.member("parts").asArray()
    case "failed":
      guard AiFailure.codes.contains(try value.member("code").asString()) else { throw AiTransportFailure.invalidResponse }
    default: throw AiTransportFailure.invalidResponse
    }
  }
}
