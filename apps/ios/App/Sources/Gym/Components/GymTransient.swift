import SwiftUI

struct GymTransient: View {
  enum Message: Equatable {
    case local(String), notice(String, String), error(String), undo(String)

    var text: String {
      switch self {
      case .local(let text), .error(let text), .notice(_, let text): text
      case .undo: "Change deleted"
      }
    }
    var isUndo: Bool { if case .undo = self { return true }; return false }
  }

  let gym: GymModel
  var message: String?
  var dismiss: (() -> Void)?
  var noticeMessage: String?
  var retry: (() -> Void)?
  var errorIdentifier = "gym-error"
  var undoIdentifier = "gym-routines-undo"

  var shown: Message? {
    if let offer = gym.undoOffers.last { return .undo(offer.id) }
    if gym.readFailed { return .error(message ?? gym.error ?? "Gym could not be read from this phone. Try again.") }
    if let message { return .local(message) }
    let noticeMessages = gym.notices.map { gym.message($0.refusal) }
    if let error = gym.error, !noticeMessages.contains(error), error != noticeMessage { return .error(error) }
    if let notice = gym.notices.last {
      let text = noticeMessage ?? gym.message(notice.refusal)
      return .notice(notice.id, text)
    }
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
    case .undo(let id): _ = gym.undo(id)
    }
  }

  func action(_ shown: Message) -> (() -> Void)? {
    if case .local = shown, dismiss == nil { return nil }
    return {
      if case .error = shown, gym.readFailed {
        if let retry { retry() } else { gym.refresh() }
      } else { dismissMessage(shown) }
    }
  }

  var body: some View {
    if let shown {
      let undo = shown.isUndo
      let retrying = !undo && gym.readFailed
      RoomTransient(message: shown.text, room: .gym,
                    actionTitle: undo ? "Undo" : retrying ? "Try again" : "Dismiss message",
                    actionSymbol: undo || retrying ? nil : "xmark",
                    actionIdentifier: undo ? undoIdentifier : nil, action: action(shown))
      .accessibilityIdentifier(undo ? undoIdentifier + "-band" : errorIdentifier)
      .padding(.horizontal, RoomSpace.inset)
      .padding(.vertical, RoomSpace.small)
    }
  }
}
