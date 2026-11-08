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

  static func bodyFont(size: CGFloat) -> UIFont {
    UIFont(name: "Inter-Regular", size: size) ?? .systemFont(ofSize: size)
  }

  static func handFont(size: CGFloat) -> UIFont {
    UIFont(name: "Caveat-Regular", size: size) ?? .systemFont(ofSize: size)
  }
}

// The big numeral: SF Rounded, bold, monospaced digits, scaled with the large title and capped, at the scaled size unless
// the host solved a size of its own.
struct GymNumeral: ViewModifier {
  static let scaled = 68.0
  static let cap = 92.0
  @ScaledMetric(relativeTo: .largeTitle) private var size = scaled
  var points: CGFloat? = nil
  func body(content: Content) -> some View {
    content.font(.system(size: points ?? min(size, Self.cap), weight: .bold, design: .rounded)).monospacedDigit()
  }
  // The same face as UIKit measures it.
  static func uiFont(_ size: CGFloat) -> UIFont {
    let face = UIFont.monospacedDigitSystemFont(ofSize: size, weight: .bold)
    return UIFont(descriptor: face.fontDescriptor.withDesign(.rounded) ?? face.fontDescriptor, size: size)
  }
}

enum RoomSpace {
  static let small: CGFloat = 4
  static let related: CGFloat = 8
  static let inset: CGFloat = 16
  static let panel: CGFloat = 20
  // Every card on a room's canvas, drawn with continuous corners as `.card`.
  static let cardRadius: CGFloat = 22
  static let minimumTarget: CGFloat = 44
  // A row-height control drawn by hand: a labelled floating act, onboarding's top row, the welcome's Sign in.
  static let controlHeight: CGFloat = 52
}

// The locale copy writes its numbers and picks its plural forms in: English, the one language, with digits as Swift
// writes them, 1000 and never 1,000 or ١٠٠٠. A message that interpolates an Int resolves in it.
extension Locale {
  nonisolated static let copy = Locale(identifier: "en_US_POSIX")
}

extension Shape where Self == RoundedRectangle {
  static var card: RoundedRectangle { RoundedRectangle(cornerRadius: RoomSpace.cardRadius, style: .continuous) }
}
