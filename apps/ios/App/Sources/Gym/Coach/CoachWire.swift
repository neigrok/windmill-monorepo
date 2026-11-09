import Foundation
import DomainKit
import GymDomain
import SyncCore

// The lifter's photo as the composer and the transcript draw it, and as a signed-out onboarding record kept it.
nonisolated struct CoachAttachment: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let mediaType: String
  let width: Int
  let height: Int
  let bytes: Int
}

// A routine a signed-out onboarding answer created once its drafts were applied, as the archived record keeps it.
nonisolated struct CoachResult: Codable, Equatable, Identifiable, Sendable {
  let kind: String
  let operationId: String
  let routineId: String
  let routineName: String
  var movementCount: Int? = nil
  var id: String { operationId }
}

nonisolated enum CoachCopy {
  static let noAnswer = String(localized: "Coach didn’t answer. Try again in a moment")
  static let offline = String(localized: "Coach needs a connection.")
  static let accountChanging = String(localized: "Your account is changing. Your question is kept here.")
  static let absent = String(localized: "This Windmill does not have Coach. You can still read your log.")
  static let unreadableDraft = String(localized: "Your draft couldn’t be read.")
  // The day's cap, said of the wait to the server's moment: under a minute, then to the nearest minute below 9½, the nearest
  // five below 52½, and the nearest hour beyond. A refusal that names no moment says only *later*.
  static func daily(waitMs: Int64?) -> String {
    guard let waitMs else { return String(localized: "You can ask again later.") }
    let minutes = Double(waitMs) / 60_000
    return switch minutes {
    case ..<1: String(localized: "You can ask again in a minute.")
    case ..<9.5: String(localized: "You can ask again in about \(Int(minutes.rounded())) minutes.", locale: .copy)
    case ..<52.5: String(localized: "You can ask again in about \(Int((minutes / 5).rounded()) * 5) minutes.", locale: .copy)
    default: String(localized: "You can ask again in about \(Int((minutes / 60).rounded())) hours.", locale: .copy)
    }
  }
  static let confirmRetry = String(localized: "Couldn’t save the routine. Try again.")
  static let draftGone = String(localized: "This draft is no longer available.")
  static let accountChanged = String(localized: "The account changed. Open this again.")
  static func escaped(_ component: String) -> String { component.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
  static func sendable(_ text: String, photo: Bool) -> Bool {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return (!text.isEmpty || photo) && text.utf8.count <= CoachRules.maxQuestionBytes
  }
  // A proposal's one name, on its Routines and History rows: *Push A · 3 changes* or *Push A · a removal*.
  static func proposalTitle(routine: String?, changes: Int, removal: Bool) -> String {
    [routine, removal ? String(localized: "a removal") : GymCount.of(changes, .change)].compactMap { $0 }.joined(separator: " · ")
  }
  static let outOfDate = String(localized: "Out of date")
  static let notApplied = String(localized: "Not applied")
  // A refused Apply, said over its card's buttons: the cause where the refusal names one, then that nothing was applied.
  static func notApplied(_ refusal: GymRefusal?, routine: String) -> String {
    switch refusal {
    case .proposalSuperseded(let refused):
      switch try? refused.detail?.member("reason").asString() {
      case "routine-changed": String(localized: "\(routine) changed after this suggestion. Not applied.")
      case "replaced": String(localized: "A newer suggestion replaced this one. Not applied.")
      default: String(localized: "This suggestion is out of date. Not applied.")
      }
    case .proposalSettled: String(localized: "This suggestion was already answered. Not applied.")
    case .gone(let record, _) where record.type == Routine.type: String(localized: "\(routine) is no longer in your program. Not applied.")
    default: String(localized: "Not applied.")
    }
  }
  // Why an out-of-date card has no buttons (08.57), one cause and then that nothing was applied.
  static func outOfDateReason(_ reason: CoachOutOfDate, routine: String, catalogue: Catalogue) -> String {
    switch reason {
    case .replaced: String(localized: "A newer suggestion replaced this one. Nothing was applied.")
    case .routineChanged: String(localized: "\(routine) changed after this suggestion. Nothing was applied.")
    case .workoutChanged: String(localized: "This workout changed after this suggestion. Nothing was applied.")
    case .workoutFinished: String(localized: "This workout has finished. Nothing was applied.")
    case .workoutMoved(let movement):
      catalogue.find(movement).map { String(localized: "You logged \($0.name) since this suggestion. Nothing was applied.") }
        ?? String(localized: "You logged a movement since this suggestion. Nothing was applied.")
    }
  }
  // How a proposal settled, one word on its card and its History row; a waiting one says nothing. The wire keeps
  // *dismissed* for a rejected proposal.
  static func settled(_ state: String, removal: Bool) -> String? {
    switch state {
    case "applied": removal ? String(localized: "proposal-state.removed", defaultValue: "Removed", comment: "How a removal proposal settled: its routine was removed")
      : String(localized: "Applied")
    case "dismissed": String(localized: "Rejected")
    case "superseded": outOfDate
    default: nil
    }
  }
  // What a refused send or a signed-out answer the server could not give says, by the code it named.
  static func refusal(_ code: String) -> String {
    switch code {
    case "client-update-required": return String(localized: "Update Windmill to keep using Gym.")
    case "invalid_installation": return String(localized: "This phone’s AI access couldn’t be verified. Your draft is kept.")
    case "installation_bound", "device_bound": return String(localized: "This phone’s AI access belongs to an account.")
    case "installation_rate_limited", "onboarding_rate_limited", "request_limit": return String(localized: "Too many requests from this connection. Your draft is kept; try again later.")
    case "insufficient_details": return String(localized: "Coach needs a clearer program. Add the movements and sets, or a clearer photo.")
    case "expired", "result_expired": return String(localized: "This response has expired. Your draft is still on this phone.")
    case "anonymous_ai_unavailable", "unconfigured": return String(localized: "Coach setup is unavailable right now. Your draft is kept.")
    case "unsupported_equipment": return String(localized: "Coach can’t plan with that equipment yet. Your draft is kept.")
    case "invalid_input", "invalid_image": return String(localized: "Check your message or choose a different photo, then send again.")
    case "model_refused": return String(localized: "Coach couldn’t help with that request. Edit your message and try again.")
    case "output_truncated", "invalid_result": return String(localized: "Coach couldn’t make complete routines. Your draft is kept.")
    default: return String(localized: "Coach couldn’t answer that. Your draft is kept.")
    }
  }
}

nonisolated extension AiAllowance {
  // Nothing remains, and no request still in progress holds any of it.
  var spent: Bool { amount(remaining) == 0 && amount(reserved) == 0 }
  func amount(_ value: String) -> Decimal { Decimal(string: value, locale: Locale(identifier: "en_US_POSIX")) ?? 0 }
  var message: String {
    if code == "subject_exhausted" {
      if amount(remaining) > 0 { return String(localized: "This request needs more AI capacity than your remaining allowance.") }
      if !spent { return String(localized: "The rest of your AI allowance is held by a request still in progress.") }
    }
    return Self.sentence(code)
  }
  // What a refusal code says when the allowance's amounts are not known, as a turn's refusal names only its code.
  static func sentence(_ code: String) -> String {
    switch code {
    case "subject_exhausted": String(localized: "You have used all of your AI allowance.")
    case "free_month_exhausted": String(localized: "Coach’s shared free AI capacity is unavailable for this month. Signing in does not bypass this limit.")
    case "free_day_exhausted": String(localized: "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit.")
    case "concurrency_exhausted": String(localized: "Another AI request is still in progress. Try again when it finishes.")
    case "funding_required": String(localized: "Your plan has no funded AI allowance for this period.")
    case "device_bound": String(localized: "This phone’s AI access belongs to an account.")
    default: String(localized: "Coach’s AI allowance is unavailable right now.")
    }
  }
  // When Coach answers again, in the zone `dates` reads days in, said only where a reset brings it back: a spent allowance
  // at its period's end, a shared free pool when its day or month turns. Nothing else lifts at a reset — a request too
  // large, one in progress, debt.
  func detail(_ dates: GymDate) -> String? {
    let reset: Int64?
    switch code {
    case "subject_exhausted": reset = spent ? resetsAtMs : nil
    case "free_day_exhausted", "free_month_exhausted": reset = budgetResetsAtMs
    default: reset = nil
    }
    guard let reset else { return nil }
    let instant = Instant(ms: reset)
    let day = dates.draw(LocalDay(instant, in: dates.moment.zone), .dateTime.month(.abbreviated).day())
    return String(localized: "You can use Coach again on \(day) at \(dates.time(instant)).")
  }
}
