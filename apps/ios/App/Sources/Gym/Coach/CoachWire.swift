import Foundation
import GymDomain

nonisolated struct CoachAttachment: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let mediaType: String
  let width: Int
  let height: Int
  let bytes: Int
}

nonisolated struct CoachStep: Codable, Equatable, Sendable {
  let tool: String
  var failed = false
  enum CodingKeys: String, CodingKey { case tool, failed }
  init(tool: String, failed: Bool = false) { self.tool = tool; self.failed = failed }
  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    tool = try c.decode(String.self, forKey: .tool); failed = try c.decodeIfPresent(Bool.self, forKey: .failed) ?? false
  }
  var phrase: String? {
    if tool == "save_note", failed { return "could not confirm a note save" }
    let phrases = ["list_sessions": "read your recent workouts", "get_session": "read one workout",
      "last_time": "read the last time you trained a movement", "list_exercises": "read your movement list",
      "list_routines": "read your program", "get_stats": "read your movement history", "list_notes": "read your notes",
      "save_note": "saved a note", "list_bodyweight": "read your bodyweight",
      "propose_routine_change": "wrote a proposal for one of your routines", "propose_routine_removal": "wrote a proposal to remove a routine"]
    return phrases[tool].map { $0 + (failed ? " (nothing came back)" : "") }
  }
}

nonisolated struct CoachRead: Codable, Equatable, Sendable {
  var sets = 0, sessions = 0, weeks = 0
  enum CodingKeys: String, CodingKey { case sets, sessions, weeks }
  init(sets: Int = 0, sessions: Int = 0, weeks: Int = 0) { self.sets = sets; self.sessions = sessions; self.weeks = weeks }
  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sets = try c.decodeIfPresent(Int.self, forKey: .sets) ?? 0
    sessions = try c.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
    weeks = try c.decodeIfPresent(Int.self, forKey: .weeks) ?? 0
  }
  var line: String {
    let parts = [(sets, "set"), (weeks, "week"), (sessions, "session")].filter { $0.0 > 0 }
      .map { "\($0.0) \($0.1)\($0.0 == 1 ? "" : "s")" }
    return parts.isEmpty ? "read nothing from your log" : "read " + parts.joined(separator: " · ")
  }
}

nonisolated struct CoachObservation: Codable, Equatable, Sendable, Identifiable {
  struct Workout: Codable, Equatable, Sendable {
    let workingSetCount: Int
    let tonnageKg: Double
    let durationMs: Int64?
  }
  let sessionId: String
  let startedAt: Int64
  let finishedAt: Int64?
  let tool: String
  let coverage: String
  let setsRead: Int
  let routine: String?
  let exerciseId: String?
  let workout: Workout?
  var id: String { sessionId }
  var wholeWorkout: Bool {
    guard let workout else { return false }
    return coverage == "session" && exerciseId == nil && !sessionId.isEmpty && startedAt > 0 && setsRead >= 0 &&
      workout.workingSetCount >= 0 && workout.tonnageKg.isFinite && workout.tonnageKg >= 0 && (workout.durationMs ?? 0) >= 0
  }
}

nonisolated struct CoachReceipt: Codable, Equatable, Sendable {
  let version: Int
  let read: CoachRead
  let steps: [CoachStep]
  let proposals: [String]
  let observations: [CoachObservation]
  enum CodingKeys: String, CodingKey { case version, read, steps, proposals, observations }
  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    version = try c.decode(Int.self, forKey: .version); read = try c.decode(CoachRead.self, forKey: .read)
    steps = try c.decodeIfPresent([CoachStep].self, forKey: .steps) ?? []
    proposals = try c.decodeIfPresent([String].self, forKey: .proposals) ?? []
    observations = try c.decodeIfPresent([CoachObservation].self, forKey: .observations) ?? []
  }
  var workouts: [CoachObservation] {
    guard version == 1 else { return [] }
    var result: [CoachObservation] = []
    for observation in observations where observation.wholeWorkout {
      result.removeAll { $0.id == observation.id }; result.append(observation)
    }
    return result
  }
}

nonisolated struct CoachResult: Codable, Equatable, Identifiable, Sendable {
  let kind: String
  let operationId: String
  let routineId: String
  let routineName: String
  var id: String { operationId }
}

nonisolated struct CoachGeneration: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let requestId: String
  let question: String
  let status: String
  var answer: String
  let at: Int64
  let steps: [CoachStep]
  let receipt: CoachReceipt?
  let results: [CoachResult]
  let revision: Int64
  let stopRequested: Bool
  let attachments: [CoachAttachment]
  var terminal: Bool { ["completed", "failed", "stopped"].contains(status) }
  enum CodingKeys: String, CodingKey { case id, requestId, question, status, answer, at, steps, receipt, results, revision, stopRequested, attachments }
  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id); requestId = try c.decode(String.self, forKey: .requestId)
    question = try c.decode(String.self, forKey: .question); status = try c.decode(String.self, forKey: .status)
    answer = try c.decodeIfPresent(String.self, forKey: .answer) ?? ""; at = try c.decodeIfPresent(Int64.self, forKey: .at) ?? 0
    steps = try c.decodeIfPresent([CoachStep].self, forKey: .steps) ?? []; receipt = try c.decodeIfPresent(CoachReceipt.self, forKey: .receipt)
    results = try c.decodeIfPresent([CoachResult].self, forKey: .results) ?? []; revision = try c.decodeIfPresent(Int64.self, forKey: .revision) ?? 0
    stopRequested = try c.decodeIfPresent(Bool.self, forKey: .stopRequested) ?? false
    attachments = try c.decodeIfPresent([CoachAttachment].self, forKey: .attachments) ?? []
  }
}

nonisolated struct CoachTurn: Codable, Equatable, Identifiable, Sendable {
  let from: String
  let text: String
  let at: Int64
  let receipt: CoachReceipt?
  let position: Int64
  let generationId: String?
  let results: [CoachResult]
  let status: String
  let requestId: String?
  let attachments: [CoachAttachment]
  var id: Int64 { position }
  enum CodingKeys: String, CodingKey { case from, text, at, receipt, position, generationId, results, status, requestId, attachments }
  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    from = try c.decode(String.self, forKey: .from); text = try c.decode(String.self, forKey: .text)
    at = try c.decodeIfPresent(Int64.self, forKey: .at) ?? 0; receipt = try c.decodeIfPresent(CoachReceipt.self, forKey: .receipt)
    position = try c.decodeIfPresent(Int64.self, forKey: .position) ?? 0; generationId = try c.decodeIfPresent(String.self, forKey: .generationId)
    results = try c.decodeIfPresent([CoachResult].self, forKey: .results) ?? []; status = try c.decodeIfPresent(String.self, forKey: .status) ?? "completed"
    requestId = try c.decodeIfPresent(String.self, forKey: .requestId); attachments = try c.decodeIfPresent([CoachAttachment].self, forKey: .attachments) ?? []
  }
}

nonisolated struct CoachThread: Codable, Equatable, Identifiable, Sendable {
  struct Outcome: Codable, Equatable, Sendable {
    let kind: String
    let changes: Int
    let routineId: String?
    let routine: String?
    var line: String? {
      switch kind {
      case "created": return changes == 1 ? "created \(routine ?? "1 routine")" : "\(changes) routines created"
      case "applied": return "\(changes) changes → \(routine ?? "your routines")"
      case "dismissed": return "\(changes) changes turned down"
      case "proposed": return "\(changes) changes waiting"
      case "superseded": return "\(changes) changes superseded"
      default: return nil
      }
    }
  }
  let id: String
  let title: String
  let createdAt: Int64
  let askedAt: Int64
  let outcome: Outcome?
  var turns: [CoachTurn]
  var nextCursor: String?
  var generation: CoachGeneration?
  enum CodingKeys: String, CodingKey { case id, title, createdAt, askedAt, outcome, turns, nextCursor, generation }
  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id); title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0; askedAt = try c.decodeIfPresent(Int64.self, forKey: .askedAt) ?? 0
    outcome = try c.decodeIfPresent(Outcome.self, forKey: .outcome); turns = try c.decodeIfPresent([CoachTurn].self, forKey: .turns) ?? []
    nextCursor = try c.decodeIfPresent(String.self, forKey: .nextCursor); generation = try c.decodeIfPresent(CoachGeneration.self, forKey: .generation)
  }
  mutating func prepend(_ page: CoachThread) {
    var positions = Set<Int64>()
    turns = (page.turns + turns).filter { positions.insert($0.position).inserted }.sorted { $0.position < $1.position }
    nextCursor = page.nextCursor
  }
}

nonisolated struct CoachThreadPage: Decodable, Sendable { let threads: [CoachThread]; let nextCursor: String? }
nonisolated struct CoachSnapshot: Decodable, Sendable { let thread: String; let generation: CoachGeneration }

nonisolated enum CoachCopy {
  static let interrupted = "Response interrupted. Retry to continue this response."
  static let stopped = "Response stopped."
  static let noAnswer = "Coach didn’t answer. Try again in a moment"
  static let connectionRequired = "Coach needs a connection. Your draft is saved on this phone."
  static let signedOut = "Coach reads your log, so it needs you signed in."
  static let absent = "Coach isn’t part of this Windmill. Your log is still yours to read."
  static let promise = "Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal."
  static func sendable(_ text: String, photo: Bool) -> Bool {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return (!text.isEmpty || photo) && text.utf8.count <= 1000
  }
  static func escaped(_ component: String) -> String { component.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
}

nonisolated enum CoachRefusal: Equatable {
  case retry(String), daily(String), ceiling(String), fresh(String), absent, said(String)
  init(status: Int?, code: String?, message: String?) {
    if status == nil { self = .retry(CoachCopy.noAnswer); return }
    if status == 404 || (status == 503 && code == "ask-not-configured") { self = .absent; return }
    if status! >= 500 { self = .retry(message ?? CoachCopy.noAnswer); return }
    switch code {
    case "ask-daily-limit": self = .daily(message ?? "The next question frees up in a couple of hours.")
    case "ask-out-of-budget": self = .ceiling(message ?? "This account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on.")
    case "ask-generation-active": self = .retry(message ?? "Coach is answering another message. Try again when it finishes.")
    case "ask-thread-full", "ask-thread-taken": self = .fresh(message ?? "This conversation is unavailable. Start a new one.")
    default: self = .said(message ?? "Coach couldn’t take that one")
    }
  }
  var message: String {
    switch self { case .retry(let m), .daily(let m), .ceiling(let m), .fresh(let m), .said(let m): m; case .absent: CoachCopy.absent }
  }
}

nonisolated struct CoachSSE {
  var event = "", lines: [String] = []
  mutating func consume(_ line: String) -> (String, Data)? {
    if line.isEmpty {
      defer { event = ""; lines = [] }
      guard !lines.isEmpty else { return nil }
      return (event, Data(lines.joined(separator: "\n").utf8))
    }
    if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
    if line.hasPrefix("data:") { lines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)) }
    return nil
  }
}

@MainActor extension CoachCopy {
  static func targets(_ sets: [SetTarget]?) -> String {
    Readout.target(sets) + ((sets?.contains { $0.weightKg != nil } ?? false) ? " kg" : "")
  }
}
