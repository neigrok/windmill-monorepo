import Foundation
import Agent
import SyncCore

public enum AiLiveOpening {
  case started(AiLiveConnection)
  case refused(AiFailure)
  case failed(AiLiveEnd)
  case lost
}

nonisolated public enum AiLiveMessage: Sendable, Equatable {
  case text(turn: Int, delta: String)
  case turn(turn: Int, text: String)
  case end(AiLiveEnd)
  case lost
}

nonisolated public enum AiLiveResult: Sendable, Equatable {
  case answered(AiLiveEnd)
  case open
  case gone
  case unknown
}

nonisolated public struct AiLiveEnd: Sendable, Equatable {
  public enum Stop: String, Sendable { case completed, cut, failed }
  public let stop: Stop
  public let code: String?
  public let text: String
  public let seconds: Int
  public let charged: String?
  public let allowance: JSON?
}

extension AiLiveEnd {
  init(_ value: JSON, opening: Bool) throws {
    let type = try value.member("type").asString()
    let object = try AiWire.fields(value, type == "ended" ? "type stop code text seconds charged allowance" : "type code text seconds charged allowance")
    let code = try object.member("code").nullable { try $0.asString() }
    let text = try object.member("text").asString()
    let seconds = Int(try object.member("seconds").asInteger(atLeast: 0))
    let charged = try object.member("charged").nullable { try $0.asString() }
    try AiWire.money(object.member("charged"), nullable: true)
    try AiWire.allowance(object.member("allowance"), nullable: true)
    let stop: Stop
    switch type {
    case "ended" where !opening:
      guard let ended = Stop(rawValue: try object.member("stop").asString()), ended != .failed, (ended == .completed) == (code == nil),
            code.map(Self.cuts.contains) ?? true else { throw AiTransportFailure.invalidResponse }
      stop = ended
    case "failed":
      guard let code, (opening ? Self.refusals : Self.failures).contains(code),
            !opening || (charged == nil && seconds == 0 && text.isEmpty) else { throw AiTransportFailure.invalidResponse }
      stop = .failed
    default: throw AiTransportFailure.invalidResponse
    }
    self.init(stop: stop, code: code, text: text, seconds: seconds, charged: charged,
              allowance: try object.member("allowance").nullable { $0 })
  }

  static let cuts: Set<String> = ["subject_exhausted", "funding_required", "paused", "session_limit", "idle", "went_away", "restarting"]
  static let failures: Set<String> = ["provider_failed", "provider_unavailable", "accounting_unavailable", "invalid_request", "funding_required"]
  static let refusals: Set<String> = [
    "invalid_request", "conflict", "funding_required", "device_bound", "subject_exhausted", "free_month_exhausted",
    "free_day_exhausted", "concurrency_exhausted", "rate_limited", "busy", "paused", "accounting_unavailable", "provider_unavailable",
  ]
  static let defects: Set<String> = ["invalid_request", "conflict"]
}

extension AiLiveMessage {
  init(_ frame: AiSocketFrame) throws {
    guard case .text(let text) = frame else { throw AiTransportFailure.invalidResponse }
    let value = try JSON(parsing: text)
    switch try value.member("type").asString() {
    case "text":
      let object = try AiWire.fields(value, "type turn delta")
      self = .text(turn: Int(try object.member("turn").asInteger(atLeast: 1)), delta: try object.member("delta").asString())
    case "turn":
      let object = try AiWire.fields(value, "type turn text")
      self = .turn(turn: Int(try object.member("turn").asInteger(atLeast: 1)), text: try object.member("text").asString())
    default: self = .end(try AiLiveEnd(value, opening: false))
    }
  }
}

@MainActor public final class AiLiveConnection {
  public private(set) var remainingSeconds = 0
  let socket: any AiSocket
  let clock: any AiClock
  let diagnostics: any AiDiagnostics
  let livenessMs: Int64
  var sending: [Int64] = []
  var ping: Int64?
  var ending = false
  var last: AiLiveMessage?
  var fenced = false
  var watch: Task<Void, Never>?

  init(socket: any AiSocket, clock: any AiClock, diagnostics: any AiDiagnostics, livenessMs: Int64) {
    self.socket = socket; self.clock = clock; self.diagnostics = diagnostics; self.livenessMs = livenessMs
  }

  var finished: Bool { last != nil }

  public func send(audio: [UInt8]) throws {
    guard !audio.isEmpty, audio.count % 2 == 0, audio.count <= 65_536 else {
      diagnostics.failure(operation: "ai-call", kind: "wire")
      throw AiFailure(source: .wire, code: "invalid_request")
    }
    guard last == nil, !ending else { return }
    let startedAt = clock.nowMs
    sending.append(startedAt)
    socket.send(.binary(audio)) { [weak self] in
      if let index = self?.sending.firstIndex(of: startedAt) { self?.sending.remove(at: index) }
    }
  }

  public func commit() { control("commit") }

  public func end() {
    control("end")
    ending = true
    ping = nil
  }

  public func close() { finish(.lost) }

  public func next() async throws -> AiLiveMessage {
    if fenced { throw HostFailure.staleSeat }
    if let last { return last }
    let frame = await receive()
    if fenced { throw HostFailure.staleSeat }
    try Task.checkCancellation()
    if let last { return last }
    guard let frame else { return finish(.lost) }
    let message: AiLiveMessage
    do { message = try AiLiveMessage(frame) }
    catch {
      diagnostics.failure(operation: "ai-call", kind: "wire")
      return finish(.lost)
    }
    guard case .end(let end) = message else { return message }
    if end.stop == .failed, AiLiveEnd.defects.contains(end.code ?? "") { diagnostics.failure(operation: "ai-call", kind: "refusal") }
    return finish(message)
  }

  func firstMessage(callId: String) async throws -> AiLiveOpening {
    let frame = await receive()
    if fenced { throw HostFailure.staleSeat }
    try Task.checkCancellation()
    guard let frame, last == nil else { finish(.lost); return .lost }
    do {
      guard case .text(let text) = frame else { throw AiTransportFailure.invalidResponse }
      let value = try JSON(parsing: text)
      if try value.member("type").asString() == "failed" {
        let end = try AiLiveEnd(value, opening: true)
        if AiLiveEnd.defects.contains(end.code ?? "") { diagnostics.failure(operation: "ai-call", kind: "refusal") }
        finish(.end(end))
        return .failed(end)
      }
      let started = try AiWire.fields(value, "type callId remainingSeconds")
      guard try started.member("type").asString() == "started", try started.member("callId").asString() == callId
      else { throw AiTransportFailure.invalidResponse }
      remainingSeconds = Int(try started.member("remainingSeconds").asInteger(atLeast: 0))
    } catch {
      diagnostics.failure(operation: "ai-call", kind: "wire")
      finish(.lost)
      return .refused(AiFailure(source: .wire, code: "invalid-answer"))
    }
    watch = Task { [weak self] in await self?.watchLiveness() }
    return .started(self)
  }

  func seatChanged() {
    fenced = true
    finish(.lost)
  }

  func control(_ type: String) {
    guard last == nil, !ending else { return }
    socket.send(.text(JSON.object(.init(uniqueKeysWithValues: [("type", .string(type))])).jcsText)) {}
  }

  func receive() async -> AiSocketFrame? {
    do {
      return try await withTaskCancellationHandler(operation: { try await socket.receive() },
                                                   onCancel: { Task { @MainActor [self] in close() } })
    } catch {
      if last == nil, error as? AiTransportFailure != .offline { diagnostics.failure(operation: "ai-call", kind: "transport") }
      return nil
    }
  }

  func watchLiveness() async {
    var pingAt = clock.nowMs
    while last == nil {
      let now = clock.nowMs
      if let ping, now - ping >= livenessMs { finish(.lost); return }
      if let oldest = sending.first, now - oldest >= livenessMs { finish(.lost); return }
      if !ending, ping == nil, now >= pingAt {
        ping = now
        pingAt = now + livenessMs
        socket.ping { [weak self] in if self?.ping == now { self?.ping = nil } }
      }
      let deadlines = [ending ? nil : pingAt, ping.map { $0 + livenessMs }, sending.first.map { $0 + livenessMs }].compactMap { $0 }
      do { try await clock.waitUntil(deadlines.filter { $0 > now }.min() ?? now + livenessMs) } catch { return }
    }
  }

  @discardableResult func finish(_ message: AiLiveMessage) -> AiLiveMessage {
    guard last == nil else { return last ?? message }
    last = message
    watch?.cancel()
    socket.close()
    return message
  }
}
