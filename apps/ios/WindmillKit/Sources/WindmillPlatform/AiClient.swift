import Foundation
import Darwin
import Agent
import SyncCore

nonisolated struct AiDeliveryFailure: Error { let error: any Error }
nonisolated struct AiDeadlineFailure: Error {}

final class AiRoundBudget {
  var deadline: Int64
  var admission: Admission
  init(deadline: Int64, admission: Admission) { self.deadline = deadline; self.admission = admission }
}

nonisolated public struct AiUse: Sendable, Hashable {
  public let name: String
  public let version: Int
  public let label: String
  public init(name: String, version: Int, label: String) { self.name = name; self.version = version; self.label = label }
  var labelQuery: String {
    "label=" + (label.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#?"))) ?? "")
  }
}

extension Profile {
  nonisolated public var use: AiUse { AiUse(name: name, version: version, label: label) }
}

nonisolated public struct AiCredentials: Sendable {
  public let session: String?
  public let installation: String?
  public init(session: String? = nil, installation: String? = nil) { self.session = session; self.installation = installation }
}

@MainActor public protocol AiClock: AnyObject {
  var nowMs: Int64 { get }
  func wait(ms: Int64) async throws
  func waitUntil(_ deadline: Int64) async throws
}

extension AiClock {
  public func waitUntil(_ deadline: Int64) async throws {
    try await Task.sleep(for: .milliseconds(max(0, deadline - nowMs)))
  }
}

@MainActor public protocol AiDiagnostics: AnyObject {
  func failure(operation: String, kind: String)
}

@MainActor public final class AiSystemClock: AiClock {
  public init() {}
  public var nowMs: Int64 { Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000) }
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
  let connection: @MainActor () -> Bool
  var pass: Pass?
  var generation: UInt64 = 0
  var stop = false
  var waitTask: Task<Void, Error>?
  var cancelPreparation: (() -> Void)?
  public private(set) var lastAllowance: JSON?

  public init(transport: any AiTransport, clock: any AiClock, diagnostics: any AiDiagnostics,
              credentials: @escaping @MainActor (Seat) throws -> AiCredentials,
              connection: @escaping @MainActor () -> Bool = { true }) {
    self.transport = transport; self.clock = clock; self.diagnostics = diagnostics; self.credentials = credentials
    self.connection = connection
  }

  public var connected: Bool { connection() }

  public func seatWillChange() {
    generation &+= 1; pass = nil; lastAllowance = nil; stop = true; waitTask?.cancel()
    cancelPreparation?(); cancelPreparation = nil; transport.cancel()
  }
  public func invalidAnswer() { diagnostics.failure(operation: "ai-call", kind: "wire") }
  public func stopAskingAgain() { stop = true; waitTask?.cancel(); cancelPreparation?() }

  public func allowance(profile: Profile, seat: Seat) async throws -> JSON {
    try await allowance(for: profile.use, seat: seat)
  }

  public func allowance(for use: AiUse, seat: Seat) async throws -> JSON {
    let epoch = generation
    let response = try await authorized(method: "GET", path: "/v1/allowance", use: use, seat: seat, epoch: epoch)
    guard response.status == 200 else { throw defect("invalid-answer", source: .wire) }
    let value = try await body(response, operation: "ai-call", epoch: epoch)
    try fence(epoch)
    do { try AiWire.allowance(value) } catch { throw defect("invalid-answer", source: .wire) }
    lastAllowance = value
    return value
  }

  public func upload(_ pictures: [Picture], profile: Profile, seat: Seat) async throws {
    try await upload(pictures, use: profile.use, seat: seat)
  }

  func upload(_ pictures: [Picture], use: AiUse, seat: Seat) async throws {
    let epoch = generation
    for picture in pictures {
      guard Self.validID(picture.pictureId), ["image/png", "image/jpeg"].contains(picture.mediaType) else {
        throw defect("invalid_request", source: .wire)
      }
      let response = try await authorized(method: "PUT", path: "/v1/pictures/\(picture.pictureId)",
        data: picture.bytes, contentType: picture.mediaType, use: use, seat: seat, epoch: epoch)
      guard response.status == 204 else { throw defect("invalid-answer", source: .wire) }
      try fence(epoch)
    }
  }

  public func call(id: String, request: JSON, profile: Profile, seat: Seat, pictures: [Picture],
                   receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws {
    try await round(id: id, body: request.jcs, use: profile.use, seat: seat, pictures: pictures, recover: false, receive: receive)
  }

  public func recover(id: String, profile: Profile, seat: Seat,
                      receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws {
    try await round(id: id, body: nil, use: profile.use, seat: seat, pictures: [], recover: true, receive: receive)
  }

  func round(id: String, body: [UInt8]?, use: AiUse, seat: Seat, pictures: [Picture], recover: Bool,
             receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws {
    guard Self.validID(id) else { throw defect("invalid_request", source: .wire) }
    let epoch = generation
    stop = false
    let budget = AiRoundBudget(deadline: clock.nowMs + 1_200_000, admission: recover ? .admitted : .none)
    do {
      let operation: @Sendable () async throws -> Void = { @MainActor [self] in
        try await exchange(id: id, body: body, use: use, seat: seat, pictures: pictures,
          recover: recover, budget: budget, epoch: epoch, receive: receive)
      }
      let expiry: @Sendable () async throws -> Void = { @MainActor [self] in
        while true {
          try await clock.waitUntil(budget.deadline)
          if clock.nowMs >= budget.deadline { throw AiDeadlineFailure() }
        }
      }
      try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask(operation: operation)
        group.addTask(operation: expiry)
        defer { group.cancelAll() }
        _ = try await group.next()
      }
    } catch is AiDeadlineFailure {
      throw AiFailure(source: .transport, code: "answer-timeout", admission: budget.admission)
    }
  }

  func exchange(id: String, body: [UInt8]?, use: AiUse, seat: Seat, pictures: [Picture], recover: Bool,
                budget: AiRoundBudget, epoch: UInt64, receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws {
    var refusalDeadline: Int64?
    var retryRefusal: (deadline: Int64, failure: AiFailure)?
    var cursor: Int64 = 0
    var admission = budget.admission
    defer { budget.admission = admission }
    var attempt = 0
    var passRefresh = false
    var pictureRefresh = false
    var askAgain = recover
    var lost = recover
    while true {
      try fence(epoch)
      if clock.nowMs >= budget.deadline { throw AiFailure(source: .transport, code: "answer-timeout", admission: admission) }
      if stop && askAgain { throw AiFailure(source: .transport, code: "stopped", admission: admission) }
      let method = recover || cursor > 0 ? "GET" : "PUT"
      let path = method == "GET" ? "/v1/calls/\(id)/result" + (cursor > 0 ? "?after=\(cursor)" : "") : "/v1/calls/\(id)/text?\(use.labelQuery)"
      let source: AiFailure.Source = method == "GET" ? .result : .text
      var attemptSent = false
      do {
        let passToken: String = try await prepare(retry: askAgain, epoch: epoch) { [self] in
          try await self.token(use: use, seat: seat, epoch: epoch)
        }
        guard clock.nowMs < budget.deadline else { throw AiFailure(source: .transport, code: "answer-timeout", admission: admission) }
        if let retryRefusal, clock.nowMs >= retryRefusal.deadline { throw retryRefusal.failure }
        if method == "PUT", refusalDeadline == nil {
          refusalDeadline = clock.nowMs + 30_000
          budget.deadline = clock.nowMs + 1_200_000
        }
        attemptSent = true
        let response = try await prepare(retry: askAgain, epoch: epoch) { [self] in
          try await transport.send(AiRequest(method: method, path: path,
            headers: ["Authorization": "Bearer " + passToken, "Content-Type": "application/json", "Accept": "text/event-stream"],
            body: method == "PUT" ? body : nil))
        }
        try fence(epoch)
        guard clock.nowMs < budget.deadline else { throw AiFailure(source: .transport, code: "answer-timeout", admission: max(admission, .possible)) }
        if !(200..<300).contains(response.status) {
          let evidence = admission
          let failure = try await prepare(retry: askAgain, epoch: epoch) { [self] in
            try await refusal(response, source: source, admission: evidence, epoch: epoch)
          }
          try fence(epoch)
          attemptSent = false
          if failure.code == "pass_expired" && !passRefresh { passRefresh = true; pass = nil; continue }
          if failure.code == "picture_gone" && !pictureRefresh && !pictures.isEmpty && method == "PUT" {
            try await prepare(retry: askAgain, epoch: epoch) { [self] in
              try await upload(pictures, use: use, seat: seat)
            }
            pictureRefresh = true
            continue
          }
          if failure.code == "busy" || failure.code == "accounting_unavailable" { admission = max(admission, .possible) }
          let result = AiFailure(source: source, code: failure.code, admission: admission, allowance: failure.allowance)
          if recover && failure.code == "call_unknown" { throw result }
          if Self.defectCodes.contains(failure.code ?? "") || failure.code?.hasPrefix("pass_") == true || failure.code == "picture_gone" {
            throw defect(failure.code ?? "invalid-answer", source: source, admission: admission)
          }
          let code = failure.code ?? ""
          let until: Int64
          if lost && Self.recoveryRetryCodes.contains(code) { until = budget.deadline }
          else if method == "PUT", Self.transientCodes.contains(code), let refusalDeadline { until = min(budget.deadline, refusalDeadline) }
          else { throw result }
          guard clock.nowMs < until else { throw result }
          retryRefusal = (until, result)
          askAgain = true
          try await wait(attempt: attempt, until: until, epoch: epoch, admission: admission)
          if clock.nowMs >= until && until < budget.deadline { throw result }
          attempt += 1
          continue
        }
        guard response.status == 200, response.contentType.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces) == "text/event-stream" else {
          throw defect("invalid-answer", source: .wire, admission: max(admission, .possible))
        }
        var parser = AiEventParser()
        for try await chunk in response.bytes {
          try fence(epoch)
          guard clock.nowMs < budget.deadline else { throw AiFailure(source: .transport, code: "answer-timeout", admission: max(admission, .possible)) }
          let events: [AiEvent]
          do { events = try parser.append(chunk) }
          catch { throw defect("invalid-answer", source: .wire, admission: max(admission, .possible)) }
          for event in events {
            do { try AiWire.event(event, callID: id) }
            catch { throw defect("invalid-answer", source: .wire, admission: max(admission, .possible)) }
            guard event.id > cursor else { continue }
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
        admission = max(admission, failure.admission)
        if attemptSent && failure.source == .transport { admission = max(admission, .possible) }
        let temporaryTransport = failure.source == .transport && !["stopped", "answer-timeout"].contains(failure.code)
        let temporaryPass = failure.source == .pass && ["rate_limited", "unavailable"].contains(failure.code)
        if temporaryTransport || temporaryPass, !attemptSent, let retryRefusal,
           retryRefusal.deadline < budget.deadline, clock.nowMs >= retryRefusal.deadline {
          throw AiFailure(source: retryRefusal.failure.source, code: retryRefusal.failure.code,
            admission: admission, allowance: retryRefusal.failure.allowance)
        }
        if !(lost || attemptSent || admission > .none) || !(temporaryTransport || temporaryPass) {
          throw AiFailure(source: failure.source, code: failure.code, admission: admission, allowance: failure.allowance)
        }
      } catch let failure as HostFailure { throw failure }
      catch {
        if attemptSent { admission = max(admission, .possible) }
        try fence(epoch)
        if error as? AiTransportFailure != .offline { diagnostics.failure(operation: "ai-call", kind: "transport") }
      }
      askAgain = true; lost = true; retryRefusal = nil
      guard clock.nowMs < budget.deadline else { throw AiFailure(source: .transport, code: "answer-timeout", admission: admission) }
      try await wait(attempt: attempt, until: budget.deadline, epoch: epoch, admission: admission)
      attempt += 1
    }
  }

  func prepare<Value: Sendable>(retry: Bool, epoch: UInt64,
                               _ operation: @escaping @MainActor @Sendable () async throws -> Value) async throws -> Value {
    guard retry else { return try await operation() }
    if stop { throw AiFailure(source: .transport, code: "stopped") }
    let task = Task { try await operation() }
    cancelPreparation = { task.cancel() }
    defer { if generation == epoch { cancelPreparation = nil } }
    do {
      return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    } catch {
      try fence(epoch)
      if stop { throw AiFailure(source: .transport, code: "stopped") }
      throw error
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

  func token(use: AiUse, seat: Seat, epoch: UInt64) async throws -> String {
    if let pass, pass.seat == seat, pass.use == use.name, pass.version == use.version,
       pass.expiresAt - clock.nowMs >= 60_000 { return pass.token }
    let start = clock.nowMs
    do {
      let auth = try credentials(seat)
      var headers = ["Content-Type": "application/json", "Accept": "application/json"]
      if let session = auth.session { headers["Authorization"] = "Bearer " + session }
      if let installation = auth.installation { headers["X-Windmill-Installation"] = installation }
      let request = JSON.object(.init(uniqueKeysWithValues: [("client", .string("ios")),
        ("use", .string(use.name)), ("version", .number(.init(use.version)))]))
      let response = try await transport.send(AiRequest(method: "POST", path: "/v1/ai/passes", headers: headers, body: request.jcs))
      try fence(epoch)
      if !(200..<300).contains(response.status) { throw try await refusal(response, source: .pass, admission: .none, epoch: epoch) }
      guard response.status == 200 else { throw defect("invalid-answer", source: .pass) }
      let body = try await body(response, operation: "ai-pass", epoch: epoch)
      let value: JSON.Object
      do { value = try AiWire.fields(body, "pass expiresIn") } catch { throw defect("invalid-answer", source: .pass) }
      try fence(epoch)
      let token: String
      let expires: Int64
      do {
        token = try value.member("pass").asString()
        expires = try value.member("expiresIn").asInteger()
        guard !token.isEmpty, expires > 0, expires <= 600_000 else { throw AiTransportFailure.invalidResponse }
      } catch { throw defect("invalid-answer", source: .pass) }
      pass = Pass(token: token, expiresAt: start + expires, seat: seat, use: use.name, version: use.version)
      return token
    } catch let failure as AiFailure { throw failure }
    catch let failure as HostFailure { throw failure }
    catch {
      try fence(epoch)
      if error as? AiTransportFailure != .offline { diagnostics.failure(operation: "ai-pass", kind: "transport") }
      throw AiFailure(source: .transport, code: error as? AiTransportFailure == .offline ? nil : "invalid-answer")
    }
  }

  func authorized(method: String, path: String, data: [UInt8]? = nil, contentType: String = "application/json",
                  use: AiUse, seat: Seat, epoch: UInt64) async throws -> AiResponse {
    for attempt in 0...1 {
      let token = try await token(use: use, seat: seat, epoch: epoch)
      let response: AiResponse
      do {
        response = try await transport.send(AiRequest(method: method, path: path,
          headers: ["Authorization": "Bearer " + token, "Content-Type": contentType], body: data))
      } catch {
        try fence(epoch)
        if error as? AiTransportFailure != .offline { diagnostics.failure(operation: "ai-call", kind: "transport") }
        throw AiFailure(source: .transport, code: error as? AiTransportFailure == .offline ? nil : "invalid-answer")
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

  func body(_ response: AiResponse, operation: String, epoch: UInt64) async throws -> JSON {
    var bytes: [UInt8] = []
    do {
      guard response.contentType.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces) == "application/json" else { throw AiTransportFailure.invalidResponse }
      for try await chunk in response.bytes {
        try fence(epoch)
        bytes += chunk
        guard bytes.count <= 2_000_000 else { throw AiTransportFailure.invalidResponse }
      }
      try fence(epoch)
      return try JSON(parsing: bytes)
    } catch {
      try fence(epoch)
      if !(200..<300).contains(response.status) { throw AiFailure(source: .transport, code: nil) }
      if error as? AiTransportFailure == .offline { throw AiFailure(source: .transport, code: nil) }
      let transportFailure = error as? AiTransportFailure == .transport
      diagnostics.failure(operation: operation, kind: transportFailure ? "transport" : "wire")
      throw AiFailure(source: transportFailure ? .transport : .wire, code: "invalid-answer")
    }
  }

  func refusal(_ response: AiResponse, source: AiFailure.Source, admission: Admission, epoch: UInt64) async throws -> AiFailure {
    if source == .pass && response.status == 404 { return AiFailure(source: source, code: "not-found", admission: admission) }
    let body = try await body(response, operation: source == .pass ? "ai-pass" : "ai-call", epoch: epoch)
    try fence(epoch)
    let code: String
    let allowance: JSON?
    do {
      let value = try AiWire.fields(body, source == .pass ? "error code" : "code allowance")
      code = try value.member("code").asString()
      if source == .pass {
        _ = try value.member("error").asString()
        guard AiWire.passStatus[code] == response.status else { throw AiTransportFailure.invalidResponse }
        allowance = nil
      } else {
        guard AiWire.refusalStatus[code] == response.status else { throw AiTransportFailure.invalidResponse }
        try AiWire.allowance(value.member("allowance"), nullable: true)
        allowance = value["allowance"].flatMap { $0 == .null ? nil : $0 }
      }
    } catch { throw AiFailure(source: .transport, code: nil, admission: admission) }
    if let allowance { lastAllowance = allowance }
    if source == .pass && (Self.defectCodes.contains(code) || ["untrusted-origin", "unsupported-media-type"].contains(code)) { diagnostics.failure(operation: "ai-pass", kind: "refusal") }
    return AiFailure(source: source, code: code, admission: admission, allowance: allowance)
  }

  func fence(_ epoch: UInt64) throws {
    if epoch != generation { throw HostFailure.staleSeat }
    try Task.checkCancellation()
  }
  func defect(_ code: String, source: AiFailure.Source, admission: Admission = .none) -> AiFailure {
    diagnostics.failure(operation: source == .pass ? "ai-pass" : "ai-call", kind: "wire")
    return AiFailure(source: source, code: code, admission: admission)
  }
  static let recoveryRetryCodes: Set<String> = ["rate_limited", "busy", "accounting_unavailable"]
  static let transientCodes: Set<String> = ["busy", "paused", "rate_limited", "concurrency_exhausted", "accounting_unavailable", "provider_unavailable"]
  static let defectCodes: Set<String> = ["invalid_request", "too_large", "provider_rejected", "funding_required", "conflict", "call_unknown"]
  static func validID(_ value: String) -> Bool {
    (22...64).contains(value.utf8.count) && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }
  }
}
