import SwiftUI

// The room's one band: what it says, the one control it offers and what dismissing it does.
struct GymTransient: View {
  enum Message: Equatable {
    case local(String), notice(String, String), error(String), held(String), undo(GymUndoOffer)

    var text: String {
      switch self {
      case .local(let text), .error(let text), .notice(_, let text), .held(let text): text
      case .undo(let offer): offer.line
      }
    }
  }

  // A hold kept outside the engine's undo offers, such as a deleted Coach conversation or a saved workout's discard;
  // `keep` ends it early with the act kept, which is what a swipe down asks for.
  struct Held {
    let text: String
    let undo: () -> Void
    var keep: (() -> Void)?
  }

  let gym: GymModel
  var message: String?
  var dismiss: (() -> Void)?
  var retryMessage: (() -> Void)?
  var noticeMessage: String?
  var retry: (() -> Void)?
  var held: Held?
  var errorIdentifier = "gym-error"
  var undoIdentifier = "gym-routines-undo"

  // A refusal outranks a pending Undo, which returns once the refusal clears (gym brief 13).
  var shown: Message? {
    if gym.readFailed { return .error(message ?? gym.error ?? "Gym could not be read from this phone. Try again.") }
    if let message { return .local(message) }
    let noticeMessages = gym.notices.map { gym.message($0.refusal) }
    if let error = gym.error, !noticeMessages.contains(error), error != noticeMessage { return .error(error) }
    if let notice = gym.notices.last { return .notice(notice.id, noticeMessage ?? gym.message(notice.refusal)) }
    if let held { return .held(held.text) }
    if let offer = gym.undoOffers.last { return .undo(offer) }
    return nil
  }

  // What sends the band away, by its xmark or a swipe down: a refusal or a notice goes, and a band offering Undo leaves
  // while the act stays. A failed read, or a message its screen gave no way out, cannot be dismissed.
  func dismissal(_ shown: Message) -> (() -> Void)? {
    switch shown {
    case .local(let text): return dismiss.map { dismiss in { dismiss(); if gym.error == text { gym.error = nil; gym.refusal = nil } } }
    case .notice(let id, _): return { gym.dismissNotice(id) }
    case .error where gym.readFailed: return nil
    case .error(let text): return { if gym.error == text { gym.error = nil; gym.refusal = nil } }
    case .held: return held?.keep
    case .undo(let offer): return { gym.dismissUndo(offer.id) }
    }
  }

  func actionTitle(_ shown: Message) -> String {
    switch shown {
    case .held, .undo: "Undo"
    case .error where gym.readFailed: "Try again"
    case .local where retryMessage != nil: "Try again"
    default: "Dismiss message"
    }
  }

  func action(_ shown: Message) -> (() -> Void)? {
    switch shown {
    case .error where gym.readFailed: return { if let retry { retry() } else { gym.refresh() } }
    case .local where retryMessage != nil: return retryMessage
    case .held: return held?.undo
    case .undo(let offer): return { _ = gym.undo(offer.id) }
    default: return dismissal(shown)
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      if let shown {
        let title = actionTitle(shown)
        let undo = title == "Undo"
        RoomTransient(message: shown.text, room: .gym, actionTitle: title,
                      actionSymbol: title == "Dismiss message" ? "xmark" : nil,
                      actionIdentifier: undo ? undoIdentifier : nil, action: action(shown), dismiss: dismissal(shown))
        .accessibilityIdentifier(undo ? undoIdentifier + "-band" : errorIdentifier)
      }
    }.bandMotion(shown)
  }
}
