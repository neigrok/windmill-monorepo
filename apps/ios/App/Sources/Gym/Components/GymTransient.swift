import SwiftUI

struct GymTransient: View {
  enum Message: Equatable {
    case local(String), notice(String, String), error(String), held(String), undo(String, count: Int)

    var text: String {
      switch self {
      case .local(let text), .error(let text), .notice(_, let text), .held(let text): text
      case .undo(_, let count): count == 1 ? "Change deleted" : "\(count) changes deleted"
      }
    }
  }

  // A hold the screen keeps outside the room's undo offers, such as a deleted Coach conversation.
  struct Held {
    let text: String
    let undo: () -> Void
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
    if let offer = gym.undoOffers.last { return .undo(offer.id, count: gym.undoOffers.count) }
    return nil
  }

  func dismissMessage(_ shown: Message) {
    switch shown {
    case .local(let text):
      dismiss?()
      if gym.error == text { gym.error = nil; gym.refusal = nil }
    case .notice(let id, _): gym.dismissNotice(id)
    case .error(let text):
      if gym.error == text { gym.error = nil; gym.refusal = nil }
    case .held: held?.undo()
    case .undo(let id, _): _ = gym.undo(id)
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
    case .local: return retryMessage ?? dismiss.map { _ in { dismissMessage(shown) } }
    default: return { dismissMessage(shown) }
    }
  }

  var body: some View {
    if let shown {
      let title = actionTitle(shown)
      let undo = title == "Undo"
      RoomTransient(message: shown.text, room: .gym, actionTitle: title,
                    actionSymbol: title == "Dismiss message" ? "xmark" : nil,
                    actionIdentifier: undo ? undoIdentifier : nil, action: action(shown))
      .accessibilityIdentifier(undo ? undoIdentifier + "-band" : errorIdentifier)
      .padding(.horizontal, RoomSpace.inset)
      .padding(.vertical, RoomSpace.small)
    }
  }
}
