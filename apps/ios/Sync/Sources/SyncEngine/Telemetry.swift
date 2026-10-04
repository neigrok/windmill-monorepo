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

enum TransportDiagnostics {
  final class Invocation: Sendable {
    let kind = Mutex<String?>(nil)
  }
  // The request race and URLSession share one report token; separate concurrent requests inherit separate tokens.
  @TaskLocal static var invocation: Invocation?
  static let expectedStatuses: Set<Int> = [400, 401, 403, 404, 409, 422, 429]

  static func kind(_ error: any Error) -> String? {
    if error is CancellationError { return nil }
    guard let error = error as? URLError else { return "transport" }
    switch error.code {
    case .cancelled: return nil
    case .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed: return "offline"
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

  static func report(_ telemetry: any Telemetry, operation: String, method: String, kind: String, status: Int? = nil,
                     durationMs: Int64) {
    if let invocation {
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
    if kind != "offline", status.map({ !expectedStatuses.contains($0) }) ?? true {
      telemetry.failure(operation, kind: kind, properties: properties, durationMs: durationMs)
    }
  }
}
