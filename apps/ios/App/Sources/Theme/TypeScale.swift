import SwiftUI
import UIKit

enum ShellType {
  static let display = Font.custom("Nunito-ExtraBold", size: 34, relativeTo: .largeTitle)
  static let title = Font.custom("Nunito-ExtraBold", size: 28, relativeTo: .title)
  static let body = Font.body
  static let action = Font.body.weight(.semibold)
  static let subheadline = Font.subheadline
  static let secondaryAction = Font.subheadline.weight(.semibold)
  static let meta = Font.footnote
  static let caption = Font.caption
}

enum JournalType {
  static let bodySize: CGFloat = 17
  static let handSize: CGFloat = 24
  static let lineSpacing: CGFloat = 7
  static let dateTracking: CGFloat = 0.7
  static let body = Font.custom("Inter-Regular", size: bodySize, relativeTo: .body)
  static let date = Font.custom("JetBrainsMono-Regular", size: 11, relativeTo: .caption)
  static let hand = Font.custom("Caveat-Regular", size: handSize, relativeTo: .body)

  static func bodyFont(size: CGFloat) -> UIFont {
    UIFont(name: "Inter-Regular", size: size) ?? .systemFont(ofSize: size)
  }

  static func handFont(size: CGFloat) -> UIFont {
    UIFont(name: "Caveat-Regular", size: size) ?? .systemFont(ofSize: size)
  }
}

struct GymNumeral: ViewModifier {
  @ScaledMetric(relativeTo: .largeTitle) private var size = 68.0
  func body(content: Content) -> some View {
    content.font(.system(size: min(size, 92), weight: .bold, design: .rounded)).monospacedDigit()
  }
}

struct GymKeypadNumeral: ViewModifier {
  @ScaledMetric(relativeTo: .largeTitle) private var size = 60.0
  func body(content: Content) -> some View {
    content.font(.system(size: min(size, 84), weight: .bold, design: .rounded)).monospacedDigit()
  }
}

enum RoomSpace {
  static let small: CGFloat = 4
  static let related: CGFloat = 8
  static let group: CGFloat = 12
  static let inset: CGFloat = 16
  static let panel: CGFloat = 20
  static let section: CGFloat = 24
  static let tail: CGFloat = 32
  static let cardRadius: CGFloat = 16
  static let minimumTarget: CGFloat = 44
}
