import Foundation
import DomainKit
import GymDomain
import SyncCore

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
}

// The server's tally of what an answer read; the room counts the workouts it lists, and takes from this only that nothing was.
nonisolated struct CoachRead: Codable, Equatable, Sendable {
  var sets = 0, sessions = 0, weeks = 0
  enum CodingKeys: String, CodingKey { case sets, sessions, weeks }
  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sets = try c.decodeIfPresent(Int.self, forKey: .sets) ?? 0
    sessions = try c.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
    weeks = try c.decodeIfPresent(Int.self, forKey: .weeks) ?? 0
  }
  var nothing: Bool { sets == 0 && sessions == 0 && weeks == 0 }
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
  // A read names a workout the room can list: a summary, the whole workout, or one movement's sets in it.
  var valid: Bool {
    !sessionId.isEmpty && startedAt > 0 && setsRead >= 0 && ["summary", "session", "movement"].contains(coverage) &&
      (coverage != "movement" || !(exerciseId ?? "").isEmpty)
  }
  // The whole workout's facts, which only a summary or a read of the whole workout knows.
  var whole: Workout? {
    guard let workout, coverage != "movement", exerciseId == nil, workout.workingSetCount >= 0, workout.tonnageKg.isFinite,
          workout.tonnageKg >= 0, (workout.durationMs ?? 0) >= 0 else { return nil }
    return workout
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
  // Every workout the answer read, once: its latest read that knew the whole workout, else its latest read of a part.
  var workouts: [CoachObservation] {
    guard version == 1 else { return [] }
    var result: [CoachObservation] = []
    for observation in observations where observation.valid {
      guard let at = result.firstIndex(where: { $0.id == observation.id }) else { result.append(observation); continue }
      if observation.whole != nil || result[at].whole == nil { result[at] = observation }
    }
    return result
  }
}

nonisolated struct CoachResult: Codable, Equatable, Identifiable, Sendable {
  let kind: String
  let operationId: String
  let routineId: String
  let routineName: String
  var movementCount: Int? = nil
  var id: String { operationId }
}

nonisolated struct CoachRoutineDraft: Codable, Equatable, Identifiable, Sendable {
  struct Entry: Codable, Equatable, Sendable {
    struct Target: Codable, Equatable, Sendable { let reps: Int?; let weightKg: Double? }
    let exerciseId: String
    let sets: [Target]?
    let restSeconds: Int?
  }
  let operationId: String
  let routineId: String
  let name: String
  let position: Int
  let entries: [Entry]
  var state: String
  var id: String { operationId }
  var routine: CoachRoutine {
    CoachRoutine(name: name, entries: entries.map { entry in
      RoutineEntry(exerciseId: DomainKit.ID(RecordID(entry.exerciseId)), sets: entry.sets.map { $0.map { SetTarget(reps: $0.reps, weightKg: $0.weightKg) } }, restSeconds: entry.restSeconds)
    })
  }
}

nonisolated enum CoachPurpose: String, Codable, Sendable {
  case conversation, routineSetup = "routine_setup"
}

nonisolated struct CoachClarification: Codable, Equatable, Identifiable, Sendable {
  struct Group: Codable, Equatable, Identifiable, Sendable {
    struct Option: Codable, Equatable, Identifiable, Sendable { let id: String; let label: String }
    let id: String
    let label: String
    let multiple: Bool
    let options: [Option]
  }
  let id: String
  let question: String
  let groups: [Group]
  var valid: Bool {
    !id.isEmpty && id.utf8.count <= 128 && !question.isEmpty && question.utf8.count <= 500 &&
      (1...2).contains(groups.count) && Set(groups.map(\.id)).count == groups.count && groups.allSatisfy { group in
        ["days", "equipment"].contains(group.id) && !group.label.isEmpty && group.label.utf8.count <= 80 && (group.id != "days" || !group.multiple) &&
        (1...6).contains(group.options.count) && Set(group.options.map(\.id)).count == group.options.count &&
        group.options.allSatisfy { !$0.id.isEmpty && $0.id.utf8.count <= 32 && $0.id.allSatisfy { "abcdefghijklmnopqrstuvwxyz0123456789_-".contains($0) } && !$0.label.isEmpty && $0.label.utf8.count <= 80 }
      }
  }
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
  var results: [CoachResult]
  var routineDrafts: [CoachRoutineDraft]
  let revision: Int64
  let stopRequested: Bool
  let attachments: [CoachAttachment]
  let purpose: CoachPurpose
  let clarification: CoachClarification?
  let allowanceRefusal: AiAllowance?
  var terminal: Bool { ["completed", "failed", "stopped"].contains(status) }
  enum CodingKeys: String, CodingKey { case id, requestId, question, status, answer, at, steps, receipt, results, routineDrafts, revision, stopRequested, attachments, purpose, clarification, allowanceRefusal }
  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id); requestId = try c.decode(String.self, forKey: .requestId)
    question = try c.decode(String.self, forKey: .question); status = try c.decode(String.self, forKey: .status)
    answer = try c.decodeIfPresent(String.self, forKey: .answer) ?? ""; at = try c.decodeIfPresent(Int64.self, forKey: .at) ?? 0
    steps = try c.decodeIfPresent([CoachStep].self, forKey: .steps) ?? []; receipt = try c.decodeIfPresent(CoachReceipt.self, forKey: .receipt)
    routineDrafts = try c.decodeIfPresent([CoachRoutineDraft].self, forKey: .routineDrafts) ?? []
    results = try c.decodeIfPresent([CoachResult].self, forKey: .results) ?? []; revision = try c.decodeIfPresent(Int64.self, forKey: .revision) ?? 0
    stopRequested = try c.decodeIfPresent(Bool.self, forKey: .stopRequested) ?? false
    attachments = try c.decodeIfPresent([CoachAttachment].self, forKey: .attachments) ?? []
    purpose = try c.decodeIfPresent(CoachPurpose.self, forKey: .purpose) ?? .conversation
    clarification = try c.decodeIfPresent(CoachClarification.self, forKey: .clarification)
    allowanceRefusal = try c.decodeIfPresent(AiAllowance.self, forKey: .allowanceRefusal)
  }
}

nonisolated struct CoachTurn: Codable, Equatable, Identifiable, Sendable {
  let from: String
  let text: String
  let at: Int64
  let receipt: CoachReceipt?
  let position: Int64
  let generationId: String?
  var results: [CoachResult]
  var routineDrafts: [CoachRoutineDraft]
  let status: String
  let requestId: String?
  let attachments: [CoachAttachment]
  let purpose: CoachPurpose
  let clarification: CoachClarification?
  let allowanceRefusal: AiAllowance?
  var id: Int64 { position }
  enum CodingKeys: String, CodingKey { case from, text, at, receipt, position, generationId, results, routineDrafts, status, requestId, attachments, purpose, clarification, allowanceRefusal }
  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    from = try c.decode(String.self, forKey: .from); text = try c.decode(String.self, forKey: .text)
    at = try c.decodeIfPresent(Int64.self, forKey: .at) ?? 0; receipt = try c.decodeIfPresent(CoachReceipt.self, forKey: .receipt)
    position = try c.decodeIfPresent(Int64.self, forKey: .position) ?? 0; generationId = try c.decodeIfPresent(String.self, forKey: .generationId)
    routineDrafts = try c.decodeIfPresent([CoachRoutineDraft].self, forKey: .routineDrafts) ?? []
    results = try c.decodeIfPresent([CoachResult].self, forKey: .results) ?? []; status = try c.decodeIfPresent(String.self, forKey: .status) ?? "completed"
    requestId = try c.decodeIfPresent(String.self, forKey: .requestId); attachments = try c.decodeIfPresent([CoachAttachment].self, forKey: .attachments) ?? []
    purpose = try c.decodeIfPresent(CoachPurpose.self, forKey: .purpose) ?? .conversation
    clarification = try c.decodeIfPresent(CoachClarification.self, forKey: .clarification)
    allowanceRefusal = try c.decodeIfPresent(AiAllowance.self, forKey: .allowanceRefusal)
  }
}

nonisolated struct CoachThread: Codable, Equatable, Identifiable, Sendable {
  struct Outcome: Codable, Equatable, Sendable {
    let kind: String
    let changes: Int
    let routineId: String?
    let routine: String?
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
  // History's row title: the conversation's first question.
  var headline: String { title.isEmpty ? "Conversation" : title }
  // History's trailing day, the day the conversation was last asked; none before the server stamps it.
  func askedDay(_ dates: GymDate) -> String? { askedAt > 0 ? dates.day(Instant(ms: askedAt)) : nil }
  // History's second line, what the conversation came to: the routine and what was proposed for it, with the card's word
  // once it settled — Out of date while the phone sees every waiting proposal outrun — or the routines it created.
  func outcomeLine(removal: Bool, outOfDate: Bool) -> String? {
    guard let outcome else { return nil }
    if outcome.kind == "created", outcome.changes > 0 { return "Created " + GymCount.of(outcome.changes, "routine") }
    guard ["proposed", "applied", "dismissed", "superseded"].contains(outcome.kind), outcome.changes > 0 else { return nil }
    let settled = outcome.kind == "proposed" && outOfDate ? CoachCopy.outOfDate : CoachCopy.settled(outcome.kind, removal: removal)
    return ([CoachCopy.proposalTitle(routine: outcome.routine, changes: outcome.changes, removal: removal)] + [settled].compactMap { $0 }).joined(separator: " · ")
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
  static let interrupted = "Response interrupted."
  static let stopped = "Response stopped."
  static let noAnswer = "Coach didn’t answer. Try again in a moment"
  static let offline = "Coach needs a connection."
  static let signedOut = "Coach needs your workout log. Please sign in."
  static let absent = "This Windmill does not have Coach. You can still read your log."
  static let unreadableDraft = "Your draft couldn’t be read."
  // The day's cap, said of the wait to the server's moment: under a minute, then to the nearest minute below 9½, the nearest
  // five below 52½, and the nearest hour beyond. A refusal that names no moment says only *later*.
  static func daily(waitMs: Int64?) -> String {
    guard let waitMs else { return "You can ask again later." }
    let minutes = Double(waitMs) / 60_000
    let wait = switch minutes {
    case ..<1: "a minute"
    case ..<9.5: "about " + GymCount.of(Int(minutes.rounded()), "minute")
    case ..<52.5: "about " + GymCount.of(Int((minutes / 5).rounded()) * 5, "minute")
    default: "about " + GymCount.of(Int((minutes / 60).rounded()), "hour")
    }
    return "You can ask again in \(wait)."
  }
  static let reconnecting = "Reconnecting…"
  static let signInToContinue = "Sign in to continue."
  static let confirmRetry = "Couldn’t save the routine. Try again."
  static let draftGone = "This draft is no longer available."
  static let draftUnsavable = "This draft can’t be saved. Ask Coach for a new one."
  static let draftSignIn = "Sign in again to save this routine."
  static let accountChanged = "The account changed. Open this again."
  static func sendable(_ text: String, photo: Bool) -> Bool {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return (!text.isEmpty || photo) && text.utf8.count <= 8000
  }
  static func escaped(_ component: String) -> String { component.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
  // A proposal's one name, on its Routines and History rows: *Push A · 3 changes* or *Push A · a removal*.
  static func proposalTitle(routine: String?, changes: Int, removal: Bool) -> String {
    [routine, removal ? "a removal" : GymCount.of(changes, "change")].compactMap { $0 }.joined(separator: " · ")
  }
  static let outOfDate = "Out of date"
  static let notApplied = "Not applied"
  // A refused Apply, said over its card's buttons: the cause where the refusal names one, then that nothing was applied.
  static func notApplied(_ refusal: GymRefusal?, routine: String) -> String {
    let cause: String? = switch refusal {
    case .proposalSuperseded(let refused):
      switch try? refused.detail?.member("reason").asString() {
      case "routine-changed": routine + " changed after this suggestion."
      case "replaced": "A newer suggestion replaced this one."
      default: "This suggestion is out of date."
      }
    case .proposalSettled: "This suggestion was already answered."
    case .sessionOpen: "Finish your workout first."
    case .gone(let record, _) where record.type == Routine.type: routine + " is no longer in your program."
    default: nil
    }
    return [cause, notApplied + "."].compactMap { $0 }.joined(separator: " ")
  }
  // How a proposal settled, one word on its card and its History row; a waiting one says nothing. The wire keeps
  // *dismissed* for a rejected proposal.
  static func settled(_ state: String, removal: Bool) -> String? {
    switch state {
    case "applied": removal ? "Removed" : "Applied"
    case "dismissed": "Rejected"
    case "superseded": outOfDate
    default: nil
    }
  }
  // A note Coach saved is never silent: the card under its answer says so, or that the save could not be confirmed.
  static func noteSave(_ steps: [CoachStep]) -> String? {
    let saves = steps.filter { $0.tool == "save_note" }
    if saves.contains(where: { !$0.failed }) { return "Saved a note" }
    return saves.isEmpty ? nil : "Could not confirm a note save"
  }
  // A movement Coach corrected lands at once, so its card says so, or that the change could not be confirmed.
  static func movementUpdate(_ steps: [CoachStep]) -> String? {
    let updates = steps.filter { $0.tool == "update_exercise" }
    if updates.contains(where: { !$0.failed }) { return "Changed a movement" }
    return updates.isEmpty ? nil : "Could not confirm a movement update"
  }
}

// Recovery for a refused send: sign-in where the phone's own AI access is spent or bound. Signed in there is none to offer
// while paid plans are closed.
nonisolated enum CoachRecovery: Equatable {
  case signIn
  init?(code: String, anonymous: Bool) {
    guard anonymous, ["subject_exhausted", "device_bound", "installation_bound", "invalid_installation"].contains(code) else { return nil }
    self = .signIn
  }
  init?(_ refusal: CoachRefusal?, anonymous: Bool) {
    switch refusal {
    case .allowance(let allowance): self.init(code: allowance.code, anonymous: anonymous)
    case .installation: if anonymous { self = .signIn } else { return nil }
    default: return nil
    }
  }
}

nonisolated enum CoachRefusal: Equatable {
  case retry(String), daily(String), ceiling(String), fresh(String), absent, said(String), allowance(AiAllowance), installation(String)
  // `waitMs` runs from now to the moment the server names for the day's next question.
  init(status: Int?, code: String?, message: String?, waitMs: Int64? = nil) {
    if status == nil { self = .retry(CoachCopy.noAnswer); return }
    if status == 404 || (status == 503 && code == "ask-not-configured") { self = .absent; return }
    if status! >= 500 { self = .retry(message ?? CoachCopy.noAnswer); return }
    switch code {
    case "ask-daily-limit": self = .daily(CoachCopy.daily(waitMs: waitMs))
    case "ask-out-of-budget": self = .ceiling(message ?? "This account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on.")
    case "ask-generation-active": self = .retry(message ?? "Coach is answering another message. Try again when it finishes.")
    case "ask-thread-full", "ask-thread-taken": self = .fresh(message ?? "This conversation is unavailable. Start a new one.")
    default: self = .said(message ?? "Coach couldn’t take that one")
    }
  }
  var message: String {
    switch self { case .retry(let m), .daily(let m), .ceiling(let m), .fresh(let m), .said(let m), .installation(let m): m; case .absent: CoachCopy.absent; case .allowance(let allowance): allowance.message }
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

nonisolated extension AiAllowance {
  // Nothing remains, and no request still in progress holds any of it.
  var spent: Bool { amount(remaining) == 0 && amount(reserved) == 0 }
  func amount(_ value: String) -> Decimal { Decimal(string: value, locale: Locale(identifier: "en_US_POSIX")) ?? 0 }
  var message: String {
    switch code {
    case "subject_exhausted":
      if amount(remaining) > 0 { return "This request needs more AI capacity than your remaining allowance." }
      if !spent { return "The rest of your AI allowance is held by a request still in progress." }
      return "You have used all of your AI allowance."
    case "free_month_exhausted": return "Coach’s shared free AI capacity is unavailable for this month. Signing in does not bypass this limit."
    case "free_day_exhausted": return "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit."
    case "concurrency_exhausted": return "Another AI request is still in progress. Try again when it finishes."
    case "funding_required": return "Your plan has no funded AI allowance for this period."
    case "device_bound": return "This phone’s AI access belongs to an account."
    default: return "Coach’s AI allowance is unavailable right now."
    }
  }
  // When Coach answers again, said only where a reset brings it back: a spent allowance at its period's end, a shared
  // free pool when its day or month turns. Nothing else lifts at a reset — a request too large, one in progress, debt.
  var detail: String? {
    let reset: Int64?
    switch code {
    case "subject_exhausted": reset = spent ? resetsAtMs : nil
    case "free_day_exhausted", "free_month_exhausted": reset = budgetResetsAtMs
    default: reset = nil
    }
    guard let reset else { return nil }
    let date = Date(timeIntervalSince1970: Double(reset) / 1000)
    return "You can use Coach again on " + date.formatted(.dateTime.month(.abbreviated).day()) + " at " + date.formatted(date: .omitted, time: .shortened) + "."
  }
}
