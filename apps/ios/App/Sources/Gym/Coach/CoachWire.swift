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
  static let noAnswer = "Coach didn’t answer. Try again in a moment"
  static let offline = "Coach needs a connection."
  static let accountChanging = "Your account is changing. Your question is kept here."
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
  static let confirmRetry = "Couldn’t save the routine. Try again."
  static let draftGone = "This draft is no longer available."
  static let accountChanged = "The account changed. Open this again."
  static func escaped(_ component: String) -> String { component.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
  static func sendable(_ text: String, photo: Bool) -> Bool {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return (!text.isEmpty || photo) && text.utf8.count <= CoachRules.maxQuestionBytes
  }
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
    case .gone(let record, _) where record.type == Routine.type: routine + " is no longer in your program."
    default: nil
    }
    return [cause, notApplied + "."].compactMap { $0 }.joined(separator: " ")
  }
  // Why an out-of-date card has no buttons (08.57), one cause and then that nothing was applied.
  static func outOfDateReason(_ reason: CoachOutOfDate, routine: String, catalogue: Catalogue) -> String {
    let cause = switch reason {
    case .replaced: "A newer suggestion replaced this one."
    case .routineChanged: routine + " changed after this suggestion."
    case .workoutChanged: "This workout changed after this suggestion."
    case .workoutFinished: "This workout has finished."
    case .workoutMoved(let movement): "You logged " + (catalogue.find(movement)?.name ?? "a movement") + " since this suggestion."
    }
    return cause + " Nothing was applied."
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
  // What a refused send or a signed-out answer the server could not give says, by the code it named.
  static func refusal(_ code: String) -> String {
    switch code {
    case "client-update-required": return "Update Windmill to keep using Gym."
    case "invalid_installation": return "This phone’s AI access couldn’t be verified. Your draft is kept."
    case "installation_bound", "device_bound": return "This phone’s AI access belongs to an account."
    case "installation_rate_limited", "onboarding_rate_limited", "request_limit": return "Too many requests from this connection. Your draft is kept; try again later."
    case "insufficient_details": return "Coach needs a clearer program. Add the movements and sets, or a clearer photo."
    case "expired", "result_expired": return "This response has expired. Your draft is still on this phone."
    case "anonymous_ai_unavailable", "unconfigured": return "Coach setup is unavailable right now. Your draft is kept."
    case "unsupported_equipment": return "Coach can’t plan with that equipment yet. Your draft is kept."
    case "invalid_input", "invalid_image": return "Check your message or choose a different photo, then send again."
    case "model_refused": return "Coach couldn’t help with that request. Edit your message and try again."
    case "output_truncated", "invalid_result": return "Coach couldn’t make complete routines. Your draft is kept."
    default: return "Coach couldn’t answer that. Your draft is kept."
    }
  }
}

nonisolated extension AiAllowance {
  // Nothing remains, and no request still in progress holds any of it.
  var spent: Bool { amount(remaining) == 0 && amount(reserved) == 0 }
  func amount(_ value: String) -> Decimal { Decimal(string: value, locale: Locale(identifier: "en_US_POSIX")) ?? 0 }
  var message: String {
    if code == "subject_exhausted" {
      if amount(remaining) > 0 { return "This request needs more AI capacity than your remaining allowance." }
      if !spent { return "The rest of your AI allowance is held by a request still in progress." }
    }
    return Self.sentence(code)
  }
  // What a refusal code says when the allowance's amounts are not known, as a turn's refusal names only its code.
  static func sentence(_ code: String) -> String {
    switch code {
    case "subject_exhausted": "You have used all of your AI allowance."
    case "free_month_exhausted": "Coach’s shared free AI capacity is unavailable for this month. Signing in does not bypass this limit."
    case "free_day_exhausted": "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit."
    case "concurrency_exhausted": "Another AI request is still in progress. Try again when it finishes."
    case "funding_required": "Your plan has no funded AI allowance for this period."
    case "device_bound": "This phone’s AI access belongs to an account."
    default: "Coach’s AI allowance is unavailable right now."
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
    return "You can use Coach again on \(day) at \(dates.time(instant))."
  }
}
