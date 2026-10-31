import SwiftUI

// The room's band over a screen: the screen's own message, or what the room holds for it.
struct GymTransient: View {
  // What the band says and its one control. A failed read leads, and only a retry answers it; then the screen's message,
  // with its retry or its dismissal; then the room's newest error, unless a notice already says it; then the newest notice.
  enum Band: Equatable {
    case readFailure(String)
    case local(String, retries: Bool, dismisses: Bool)
    case notice(String, String)
    case error(String)

    enum Control: Equatable {
      case retry, dismiss

      var title: String { self == .retry ? "Try again" : "Dismiss message" }
      var symbol: String? { self == .dismiss ? "xmark" : nil }
    }

    init?(readFailed: Bool, error: String?, notices: [(id: String, text: String)], local: String?, retries: Bool, dismisses: Bool, noticeText: String?) {
      if readFailed { self = .readFailure(local ?? error ?? "Gym could not be read from this phone. Try again."); return }
      if let local { self = .local(local, retries: retries, dismisses: dismisses); return }
      if let error, !notices.contains(where: { $0.text == error }), error != noticeText { self = .error(error); return }
      guard let notice = notices.last else { return nil }
      self = .notice(notice.id, noticeText ?? notice.text)
    }

    var text: String {
      switch self {
      case .readFailure(let text), .local(let text, _, _), .notice(_, let text), .error(let text): text
      }
    }

    var control: Control? {
      switch self {
      case .readFailure: .retry
      case .local(_, let retries, let dismisses): retries ? .retry : dismisses ? .dismiss : nil
      case .notice, .error: .dismiss
      }
    }

    var dismissible: Bool {
      switch self {
      case .readFailure: false
      case .local(_, _, let dismisses): dismisses
      case .notice, .error: true
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

  var shown: Band? {
    Band(readFailed: gym.readFailed, error: gym.error, notices: gym.notices.map { ($0.id, gym.message($0.refusal)) },
         local: message, retries: retryMessage != nil, dismisses: dismiss != nil, noticeText: noticeMessage)
  }

  func dismissal(_ band: Band) -> (() -> Void)? {
    guard band.dismissible else { return nil }
    switch band {
    case .notice(let id, _): return { gym.dismissNotice(id) }
    case .local(let text, _, _): return { dismiss?(); gym.dismissError(text) }
    case .readFailure(let text), .error(let text): return { gym.dismissError(text) }
    }
  }

  func action(_ band: Band) -> (() -> Void)? {
    switch (band.control, band) {
    case (.retry?, .readFailure): return { if let retry { retry() } else { gym.refresh() } }
    case (.retry?, _): return retryMessage
    case (.dismiss?, _): return dismissal(band)
    case (nil, _): return nil
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      if let shown {
        RoomTransient(message: shown.text, room: .gym, actionTitle: shown.control?.title, actionSymbol: shown.control?.symbol,
                      action: action(shown), dismiss: dismissal(shown))
          .accessibilityIdentifier(errorIdentifier)
      }
    }.roomMotion(shown)
  }
}
