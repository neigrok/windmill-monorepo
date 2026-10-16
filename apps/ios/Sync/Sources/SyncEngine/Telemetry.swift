import Foundation
import Synchronization

// Technical and product sinks accept only static operations and bounded diagnostic labels. Never pass an Error,
// resource identity, request/response body, journal value or credential through this boundary.
public protocol Telemetry: Sendable {
  func event(_ name: String, properties: [String: String], durationMs: Int64?)
  func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?)
}

public extension Telemetry {
  func event(_ name: String, properties: [String: String] = [:]) {
    event(name, properties: properties, durationMs: nil)
  }

  func failure(_ operation: String, kind: String, properties: [String: String] = [:]) {
    failure(operation, kind: kind, properties: properties, durationMs: nil)
  }
}

public struct NoopTelemetry: Telemetry {
  public init() {}
  public func event(_ name: String, properties: [String: String], durationMs: Int64?) {}
  public func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?) {}
}

// Engine callers only enqueue bounded diagnostics. The sink runs on this worker, outside writer/publisher locks;
// a stalled sink retains at most one in-flight record and 128 waiting records, dropping new diagnostics at capacity.
public final class BoundedTelemetry: Telemetry {
  struct Record: Sendable {
    let name: String
    let kind: String?
    let properties: [String: String]
    let durationMs: Int64?
  }

  struct State {
    var pending: [Record] = []
    var draining = false
  }

  public static let capacity = 128
  let sink: any Telemetry
  let worker = DispatchQueue(label: "windmill.sync.telemetry", qos: .utility)
  let state = Mutex(State())

  public init(_ sink: any Telemetry) { self.sink = sink }

  public func event(_ name: String, properties: [String: String], durationMs: Int64?) {
    enqueue(Record(name: name, kind: nil, properties: properties, durationMs: durationMs))
  }

  public func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?) {
    enqueue(Record(name: operation, kind: kind, properties: properties, durationMs: durationMs))
  }

  func enqueue(_ record: Record) {
    let start = state.withLock { state in
      guard state.pending.count < Self.capacity else { return false }
      state.pending.append(record)
      guard !state.draining else { return false }
      state.draining = true
      return true
    }
    guard start else { return }
    worker.async { [self] in
      while let record = state.withLock({ state -> Record? in
        guard !state.pending.isEmpty else {
          state.draining = false
          return nil
        }
        return state.pending.removeFirst()
      }) {
        if let kind = record.kind {
          sink.failure(record.name, kind: kind, properties: record.properties, durationMs: record.durationMs)
        } else {
          sink.event(record.name, properties: record.properties, durationMs: record.durationMs)
        }
      }
    }
  }
}

// The HTTP statuses the server answers on purpose — a refusal the client handles, an app it finds too old (426), a
// session or ticket gone (410) — which every boundary (sync, auth, the REST clients, the event queue) records as an
// `api_request_failed` metric and never as a Sentry Issue. A push also expects 413, which §7.4 halves or refuses
// too-large; no other request answers it on purpose.
public enum ExpectedStatuses {
  public static let all: Set<Int> = [400, 401, 403, 404, 409, 410, 422, 426, 429]
  static let push = all.union([413])

  public static func contains(_ status: Int?) -> Bool {
    status.map(all.contains) ?? false
  }
}

// One reporter's sync failures, the transport's or the engine's: each is an `api_request_failed` metric, and one no one
// expects is an Issue once per outage, so a failure like its operation's last files none until the operation succeeds.
final class TransportDiagnostics: Sendable {
  final class Invocation: Sendable {
    let kind = Mutex<String?>(nil)
  }

  struct Failure: Sendable, Equatable {
    let kind: String
    let status: Int?
  }

  // The request race and URLSession share one report token; separate concurrent requests inherit separate tokens.
  @TaskLocal static var invocation: Invocation?

  let telemetry: any Telemetry
  let lastFailures = Mutex<[String: Failure]>([:])

  init(_ telemetry: any Telemetry) {
    self.telemetry = telemetry
  }

  // A socket the server or the network drops fails with its POSIX error, not a URLError: ENOTCONN once the server has
  // gone, ECONNRESET for a reset. Each reads as the URLError of the same condition does.
  static func kind(_ error: any Error) -> String? {
    if error is CancellationError { return nil }
    if let error = error as? POSIXError {
      switch error.code {
      case .ENETDOWN, .ENETUNREACH, .EHOSTDOWN, .EHOSTUNREACH, .ECONNREFUSED, .ENOTCONN, .ECONNRESET, .ECONNABORTED, .EPIPE:
        return "offline"
      case .ETIMEDOUT: return "timeout"
      default: return "transport"
      }
    }
    guard let error = error as? URLError else { return "transport" }
    switch error.code {
    case .cancelled: return nil
    case .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost: return "offline"
    case .timedOut: return "timeout"
    case .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
         .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
         .clientCertificateRequired: return "tls"
    default: return "transport"
    }
  }

  static func elapsed(since start: ContinuousClock.Instant) -> Int64 {
    let parts = start.duration(to: ContinuousClock.now).components
    return max(0, parts.seconds * 1_000 + parts.attoseconds / 1_000_000_000_000_000)
  }

  func report(operation: String, method: String, kind: String, status: Int? = nil,
              expected: Set<Int> = ExpectedStatuses.all, durationMs: Int64) {
    if let invocation = Self.invocation {
      let first = invocation.kind.withLock { recordedKind in
        guard recordedKind == nil else { return false }
        recordedKind = kind
        return true
      }
      guard first else { return }
    }
    var properties = ["operation": operation, "method": method, "route": "/v1/sync", "failure_kind": kind]
    if let status { properties["status"] = String(status) }
    telemetry.event("api_request_failed", properties: properties, durationMs: durationMs)
    let failure = Failure(kind: kind, status: status)
    let repeated = lastFailures.withLock { lastFailures in
      defer { lastFailures[operation] = failure }
      return lastFailures[operation] == failure
    }
    guard kind != "offline", !(status.map(expected.contains) ?? false), !repeated else { return }
    telemetry.failure(operation, kind: kind, properties: properties, durationMs: durationMs)
  }

  // The outage of `operation` is over: its next failure files an Issue again.
  func succeeded(_ operation: String) {
    lastFailures.withLock { $0[operation] = nil }
  }
}
