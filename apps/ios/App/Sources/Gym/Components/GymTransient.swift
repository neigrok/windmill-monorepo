import SwiftUI

struct GymTransient: View {
  enum Message: Equatable {
    case local(String), notice(String, String), error(String)

    var text: String {
      switch self {
      case .local(let text), .error(let text), .notice(_, let text): text
      }
    }
  }

  let gym: GymModel
  var message: String?
  var dismiss: (() -> Void)?
  var retryMessage: (() -> Void)?
  var noticeMessage: String?
  var retry: (() -> Void)?
  var errorIdentifier = "gym-error"

  var shown: Message? {
    if gym.readFailed { return .error(message ?? gym.error ?? "Gym could not be read from this phone. Try again.") }
    if let message { return .local(message) }
    let noticeMessages = gym.notices.map { gym.message($0.refusal) }
    if let error = gym.error, !noticeMessages.contains(error), error != noticeMessage { return .error(error) }
    if let notice = gym.notices.last { return .notice(notice.id, noticeMessage ?? gym.message(notice.refusal)) }
    return nil
  }

  func dismissal(_ shown: Message) -> (() -> Void)? {
    switch shown {
    case .local(let text): return dismiss.map { dismiss in { dismiss(); if gym.error == text { gym.error = nil; gym.refusal = nil } } }
    case .notice(let id, _): return { gym.dismissNotice(id) }
    case .error where gym.readFailed: return nil
    case .error(let text): return { if gym.error == text { gym.error = nil; gym.refusal = nil } }
    }
  }

  func actionTitle(_ shown: Message) -> String {
    switch shown {
    case .error where gym.readFailed, .local where retryMessage != nil: "Try again"
    default: "Dismiss message"
    }
  }

  func action(_ shown: Message) -> (() -> Void)? {
    switch shown {
    case .error where gym.readFailed: return { if let retry { retry() } else { gym.refresh() } }
    case .local where retryMessage != nil: return retryMessage
    default: return dismissal(shown)
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      if let shown {
        RoomTransient(message: shown.text, room: .gym, actionTitle: actionTitle(shown),
                      actionSymbol: actionTitle(shown) == "Dismiss message" ? "xmark" : nil,
                      action: action(shown), dismiss: dismissal(shown))
          .accessibilityIdentifier(errorIdentifier)
      }
    }.roomMotion(shown)
  }
}
