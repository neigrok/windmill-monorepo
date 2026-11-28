import Foundation
import Agent
import SyncCore

nonisolated public enum AiLiveOpening: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  case started(AiLiveConnection)
  case refused(AiFailure)
  case failed(AiLiveEnd, callIdFree: Bool)
  case lost(AiLiveLoss)

  public var description: String {
    switch self {
    case .started: "started"
    case .refused(let failure): "refused(\(failure))"
    case .failed(let end, let callIdFree): "failed(\(end), callIdFree: \(callIdFree))"
    case .lost(let loss): "lost(\(loss))"
    }
  }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .enum) }
}

nonisolated public enum AiLiveLoss: Sendable, Equatable {
  case closed, offline, transport, wire, ping, backlog, cancelled
  case refused(status: Int)
}

nonisolated public enum AiLiveMessage: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  case text(turn: Int, delta: String)
  case turn(turn: Int, text: String)
  case end(AiLiveEnd)
  case lost(AiLiveLoss)

  public var description: String {
    switch self {
    case .text(let turn, let delta): "text(turn: \(turn), \(delta.utf8.count) bytes)"
    case .turn(let turn, let text): "turn(turn: \(turn), \(text.utf8.count) bytes)"
    case .end(let end): "end(\(end))"
    case .lost(let loss): "lost(\(loss))"
    }
  }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .enum) }
}

nonisolated public enum AiLiveResult: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  case answered(AiLiveEnd)
  case open
  case gone
  case unknown

  public var description: String {
    switch self {
    case .answered(let end): "answered(\(end))"
    case .open: "open"
    case .gone: "gone"
    case .unknown: "unknown"
    }
  }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .enum) }
}

nonisolated public struct AiLiveEnd: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public enum Stop: String, Sendable { case completed, cut, failed }
  public let stop: Stop
  public let code: String?
  public let text: String
  public let seconds: Int
  public let charged: String?
  public let allowance: JSON?

  public var description: String { "\(stop.rawValue), code: \(code ?? "none"), \(text.utf8.count) bytes, \(seconds) s" }
  public var debugDescription: String { description }
  public var customMirror: Mirror {
    Mirror(self, children: ["stop": stop.rawValue, "code": code ?? "none", "textBytes": text.utf8.count, "seconds": seconds], displayStyle: .struct)
  }
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
    guard code.map(Self.isCode) ?? true else { throw AiTransportFailure.invalidResponse }
    let stop: Stop
    switch type {
    case "ended" where !opening:
      guard let ended = Stop(rawValue: try object.member("stop").asString()), ended != .failed, (ended == .completed) == (code == nil)
      else { throw AiTransportFailure.invalidResponse }
      stop = ended
    case "failed":
      guard code != nil, !opening || ([nil, "0"].contains(charged) && seconds == 0 && text.isEmpty) else { throw AiTransportFailure.invalidResponse }
      stop = .failed
    default: throw AiTransportFailure.invalidResponse
    }
    self.init(stop: stop, code: code, text: text, seconds: seconds, charged: charged,
              allowance: try object.member("allowance").nullable { $0 })
  }

  func isKnown(failures: Set<String>) -> Bool {
    guard let code else { return true }
    return stop == .failed ? failures.contains(code) : Self.cuts.contains(code)
  }

  static func isCode(_ value: String) -> Bool {
    value.utf8.count <= 64 && value.split(separator: "_", omittingEmptySubsequences: false).allSatisfy {
      !$0.isEmpty && $0.utf8.allSatisfy { (97...122).contains($0) }
    }
  }

  static let cuts: Set<String> = ["subject_exhausted", "funding_required", "paused", "session_limit", "idle", "went_away", "restarting"]
  static let failures: Set<String> = ["provider_failed", "provider_unavailable", "accounting_unavailable", "invalid_request", "funding_required"]
  static let refusals: Set<String> = [
    "invalid_request", "conflict", "rate_limited", "busy", "accounting_unavailable", "funding_required", "concurrency_exhausted",
    "subject_exhausted", "paused", "provider_unavailable",
  ]
  static let defects: Set<String> = ["invalid_request", "conflict"]
  static let freeing: Set<String> = ["concurrency_exhausted", "subject_exhausted", "funding_required", "paused"]
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
  var socket: (any AiSocket)?
  let clock: any AiClock
  let diagnostics: any AiDiagnostics
  let livenessMs: Int64
  var sending: [Int64] = []
  var ping: Int64?
  var pingAt: Int64 = 0
  var ending = false
  var unread: [AiLiveMessage] = []
  var last: AiLiveMessage?
  var readers: [CheckedContinuation<AiLiveMessage, Never>] = []
  var fenced = false
  var tasks: [Task<Void, Never>] = []

  init(socket: any AiSocket, clock: any AiClock, diagnostics: any AiDiagnostics, livenessMs: Int64) {
    self.socket = socket; self.clock = clock; self.diagnostics = diagnostics; self.livenessMs = livenessMs
  }

  isolated deinit {
    for task in tasks { task.cancel() }
    socket?.close()
  }

  var finished: Bool { last != nil }

  public func send(audio: [UInt8]) throws {
    guard !audio.isEmpty, audio.count % 2 == 0, audio.count <= 65_536 else { throw AiFailure(source: .wire, code: "invalid_request") }
    guard last == nil, !ending, let socket else { return }
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

  public func close() { finish(.lost(.cancelled)) }

  public func next() async throws -> AiLiveMessage {
    if fenced { throw HostFailure.staleSeat }
    if !unread.isEmpty { return unread.removeFirst() }
    if let last { return last }
    let message = await withTaskCancellationHandler(operation: { await withCheckedContinuation { readers.append($0) } },
                                                    onCancel: { Task { @MainActor [self] in finish(.lost(.cancelled)) } })
    if fenced { throw HostFailure.staleSeat }
    try Task.checkCancellation()
    return message
  }

  func firstMessage(callId: String) async throws -> AiLiveOpening {
    guard let socket else { return .lost(.closed) }
    let result: Result<AiSocketFrame?, any Error>
    do {
      result = .success(try await withTaskCancellationHandler(operation: { try await socket.receive() },
                                                              onCancel: { Task { @MainActor [self] in finish(.lost(.cancelled)) } }))
    } catch { result = .failure(error) }
    if fenced { throw HostFailure.staleSeat }
    try Task.checkCancellation()
    guard let frame = frame(result) else {
      if case .lost(let loss)? = last { return .lost(loss) }
      return .lost(.closed)
    }
    do {
      guard case .text(let text) = frame else { throw AiTransportFailure.invalidResponse }
      let value = try JSON(parsing: text)
      if try value.member("type").asString() == "failed" {
        let end = try AiLiveEnd(value, opening: true)
        report(end, failures: AiLiveEnd.refusals)
        finish(.end(end))
        return .failed(end, callIdFree: AiLiveEnd.freeing.contains(end.code ?? ""))
      }
      let started = try AiWire.fields(value, "type callId remainingSeconds")
      guard try started.member("type").asString() == "started", try started.member("callId").asString() == callId
      else { throw AiTransportFailure.invalidResponse }
      remainingSeconds = Int(try started.member("remainingSeconds").asInteger(atLeast: 0))
    } catch {
      diagnostics.failure(operation: "ai-live", kind: "wire")
      finish(.lost(.wire))
      return .refused(AiFailure(source: .wire, code: "invalid-answer"))
    }
    start(socket)
    return .started(self)
  }

  func start(_ socket: any AiSocket) {
    let clock = clock
    pingAt = clock.nowMs
    tasks = [
      Task { [weak self] in
        while true {
          let result: Result<AiSocketFrame?, any Error>
          do { result = .success(try await socket.receive()) } catch { result = .failure(error) }
          guard self?.take(result) == true else { return }
        }
      },
      Task { [weak self] in
        while let wake = self?.check() {
          do { try await clock.waitUntil(wake) } catch { return }
        }
      },
    ]
  }

  func take(_ result: Result<AiSocketFrame?, any Error>) -> Bool {
    guard let frame = frame(result) else { return false }
    let message: AiLiveMessage
    do { message = try AiLiveMessage(frame) }
    catch {
      diagnostics.failure(operation: "ai-live", kind: "wire")
      finish(.lost(.wire))
      return false
    }
    if case .end(let end) = message {
      report(end, failures: AiLiveEnd.failures)
      finish(message)
      return false
    }
    if readers.isEmpty { unread.append(message) } else { readers.removeFirst().resume(returning: message) }
    return true
  }

  func frame(_ result: Result<AiSocketFrame?, any Error>) -> AiSocketFrame? {
    guard last == nil else { return nil }
    switch result {
    case .success(let frame?): return frame
    case .success(nil): finish(.lost(.closed))
    case .failure(let error) where error as? AiTransportFailure == .offline: finish(.lost(.offline))
    case .failure:
      diagnostics.failure(operation: "ai-live", kind: "transport")
      finish(.lost(.transport))
    }
    return nil
  }

  func check() -> Int64? {
    guard last == nil else { return nil }
    let now = clock.nowMs
    if let ping, now - ping >= livenessMs { finish(.lost(.ping)); return nil }
    if let oldest = sending.first, now - oldest >= livenessMs { finish(.lost(.backlog)); return nil }
    if !ending, ping == nil, now >= pingAt {
      ping = now
      pingAt = now + livenessMs
      socket?.ping { [weak self] in if self?.ping == now { self?.ping = nil } }
    }
    let deadlines = [ending ? nil : pingAt, ping.map { $0 + livenessMs }, sending.first.map { $0 + livenessMs }].compactMap { $0 }
    return deadlines.filter { $0 > now }.min() ?? now + livenessMs
  }

  func report(_ end: AiLiveEnd, failures: Set<String>) {
    if !end.isKnown(failures: failures) { diagnostics.failure(operation: "ai-live", kind: "code") }
    if end.stop == .failed, AiLiveEnd.defects.contains(end.code ?? "") { diagnostics.failure(operation: "ai-live", kind: "refusal") }
  }

  func seatChanged() {
    fenced = true
    finish(.lost(.cancelled))
  }

  func control(_ type: String) {
    guard last == nil, !ending else { return }
    socket?.send(.text(JSON.object(.init(uniqueKeysWithValues: [("type", .string(type))])).jcsText)) {}
  }

  func finish(_ message: AiLiveMessage) {
    guard last == nil else { return }
    last = message
    for task in tasks { task.cancel() }
    tasks = []
    socket?.close()
    socket = nil
    let waiting = readers
    readers = []
    for reader in waiting { reader.resume(returning: message) }
  }
}
