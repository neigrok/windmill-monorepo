import SyncCore

public struct Seat: Sendable, Hashable {
  public enum Kind: String, Sendable { case anon, bound }
  public let kind: Kind
  public let key: String
  public init(kind: Kind, key: String) { self.kind = kind; self.key = key }
}

public struct Picture: Sendable, Equatable {
  public let pictureId: String
  public let mediaType: String
  public let bytes: [UInt8]
  public init(pictureId: String, mediaType: String, bytes: [UInt8]) {
    self.pictureId = pictureId; self.mediaType = mediaType; self.bytes = bytes
  }
}

public struct TurnInput: Sendable {
  public let turnId: String
  public let seat: Seat
  public let question: String
  public let pictures: [Picture]
  public init(turnId: String, seat: Seat, question: String, pictures: [Picture] = []) {
    self.turnId = turnId; self.seat = seat; self.question = question; self.pictures = pictures
  }
}

public struct Mark: Sendable, Equatable {
  public let turnId: String
  public let callId: String?
  public let textBytesBeforeRound: Int
  public init(turnId: String, callId: String?, textBytesBeforeRound: Int) {
    self.turnId = turnId; self.callId = callId; self.textBytesBeforeRound = textBytesBeforeRound
  }
}

public struct TurnEnd: Sendable, Equatable {
  public enum State: String, Sendable { case completed, declined, failed, stopped, interrupted }
  public let state: State
  public let text: String
  public let truncated: Bool
  public let code: String?
  public init(state: State, text: String, truncated: Bool = false, code: String? = nil) {
    self.state = state; self.text = text; self.truncated = truncated; self.code = code
  }
}

public struct HostLease: Sendable, Hashable {
  public let turnId: String
  public let seat: Seat
  public let generation: UInt64
  public let replica: String?
  public init(turnId: String, seat: Seat, generation: UInt64, replica: String? = nil) {
    self.turnId = turnId; self.seat = seat; self.generation = generation; self.replica = replica
  }
}

public struct OpenTurn: Sendable {
  public let lease: HostLease
  public let history: String
  public let context: [String]
  public let pictures: [Picture]
  public init(lease: HostLease, history: String = "", context: [String] = [], pictures: [Picture] = []) {
    self.lease = lease; self.history = history; self.context = context; self.pictures = pictures
  }
}

public enum HostFailure: Error { case recordGone, staleSeat, refused(String) }
public enum ToolOutcome: Sendable, Equatable { case success(String), refusal(String) }
public enum GateCheck: String, Sendable { case seat, shape, product }

public struct ToolCall: Sendable, Equatable {
  public let id: String
  public let name: String
  public let input: JSON
  public init(id: String, name: String, input: JSON) { self.id = id; self.name = name; self.input = input }
}

@MainActor public protocol ToolHost: AnyObject {
  func open(_ input: TurnInput) async throws -> OpenTurn
  func recover(_ input: TurnInput) async throws -> Recovery?
  func text(_ text: String, lease: HostLease) async throws
  func beginRound(_ mark: Mark, text: String, lease: HostLease) async throws
  func end(_ end: TurnEnd, lease: HostLease) async throws
  func withdraw(lease: HostLease) async throws
  func check(_ check: GateCheck, call: ToolCall, lease: HostLease) async throws -> String?
  func execute(_ call: ToolCall, callId: String, lease: HostLease) async throws -> ToolOutcome
}

public enum Admission: Int, Sendable, Comparable {
  case none, possible, admitted
  public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

public struct AiFailure: Error, Sendable {
  public static let codes: Set<String> = [
    "accounting_unavailable", "busy", "call_unknown", "concurrency_exhausted", "conflict", "device_bound",
    "free_day_exhausted", "free_month_exhausted", "funding_required", "invalid_request", "pass_audience",
    "pass_expired", "pass_malformed", "pass_missing", "pass_signature", "paused", "picture_gone",
    "provider_rejected", "provider_unavailable", "provider_failed", "rate_limited", "result_gone",
    "subject_exhausted", "too_large", "unauthenticated", "unavailable", "invalid_installation", "client-update-required",
    "anonymous_ai_unavailable", "not-found", "offline", "invalid-answer", "answer-timeout", "model-call-limit", "stopped",
  ]
  public enum Source: String, Sendable { case pass, text, result, transport, wire }
  public let source: Source
  public let code: String?
  public let admission: Admission
  public let allowance: JSON?
  public init(source: Source, code: String?, admission: Admission = .none, allowance: JSON? = nil) {
    self.source = source; self.code = code; self.admission = admission; self.allowance = allowance
  }
}

extension AiFailure: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "AiFailure(source: \(source.rawValue), code: \(code ?? "none"), admission: \(admission))" }
  public var debugDescription: String { description }
  public var customMirror: Mirror {
    Mirror(self, children: ["source": source.rawValue, "code": code ?? "none", "admission": "\(admission)"], displayStyle: .struct)
  }
}

public struct AiEvent: Sendable {
  public let id: Int64
  public let name: String
  public let data: JSON
  public init(id: Int64, name: String, data: JSON) { self.id = id; self.name = name; self.data = data }
}

@MainActor public protocol AiClient: AnyObject {
  var connected: Bool { get }
  func allowance(profile: Profile, seat: Seat) async throws -> JSON
  func upload(_ pictures: [Picture], profile: Profile, seat: Seat) async throws
  func call(id: String, request: JSON, profile: Profile, seat: Seat, pictures: [Picture],
            receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws
  func recover(id: String, profile: Profile, seat: Seat,
               receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws
  func invalidAnswer()
  func stopAskingAgain()
  func seatWillChange()
}

@MainActor public protocol TurnRuntime: AnyObject {
  var nowMs: Int64 { get }
  func callID() throws -> String
  func acquire() async throws
  func release()
}

@MainActor public protocol Telemetry: AnyObject {
  func hostFailure()
  func ability(name: String, code: String?)
  func turn(state: TurnEnd.State, seat: Seat.Kind, code: String?, rounds: Int, abilityCalls: Int,
            refusals: Int, answerBytes: Int, durationMs: Int64)
}

public enum Access: String, Sendable {
  case allowanceUsed, capacityUsed, busy, signIn, update, switchedOff, offline, didNotAnswer
  public static func forFailure(_ failure: AiFailure) -> Access {
    switch failure.code {
    case "subject_exhausted": .allowanceUsed
    case "free_day_exhausted", "free_month_exhausted": .capacityUsed
    case "concurrency_exhausted", "rate_limited", "busy", "paused": .busy
    case "unauthenticated", "invalid_installation", "device_bound": .signIn
    case "client-update-required": .update
    case "anonymous_ai_unavailable", "not-found": .switchedOff
    case nil, "offline": .offline
    default: .didNotAnswer
    }
  }
}

public enum TurnFreshness {
  public static func isStale(state: String, syncLive: Bool, serverNow: Int64?, serverUpdatedAt: Int64?) -> Bool {
    guard state == "running", syncLive, let now = serverNow, let updated = serverUpdatedAt, now >= updated else { return false }
    return now - updated >= 1_800_000
  }
}
