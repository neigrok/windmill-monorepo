import SwiftUI
import UIKit

// Frozen illustration roles; the journal glimpse keeps its iteration-one warm day ink.
enum OnboardingSpecimen {
  static let journalInk = color(0xF1F0EC, 0x2A2118)
  static let journalDim = color(0xB6B5B0, 0x74654F)
  static let journalFaint = color(0x737476, 0x8E8272)
  static let journalLine = color(0x20232B, 0xE3E0DA)
  static let completed = color(0x9AA859, 0x7D8C43)
  static let completedOutline = color(0xC4D18A, 0xA6B86A)
  static let skyKind = color(0x9DBDCA, 0x5F8494)
  static let skyLockedFill = color(0x293033, 0xD8DEDC)
  static let skyLockedOutline = color(0x36464B, 0xA9BDC5)
  static let goldKind = color(0xE9C563, 0xC4972F)
  static let goldLockedFill = color(0x433619, 0xEEE1BD)
  static let goldLockedOutline = color(0x6A5220, 0xE0C880)
  static let clayOpenOutline = color(0xEFB58F, 0xEFB58F)
  static let clayLockedFill = color(0x462D1D, 0xEFDFD0)
  static let clayLockedOutline = color(0x73492F, 0xC8A989)
  static let openEdge = color(0x888780, 0xA7997D)
  static let lockedEdge = color(0x2E2E32, 0xE5D9C0)

  private static func color(_ night: UInt32, _ day: UInt32) -> Color {
    Color(uiColor: UIColor { traits in
      let hex = traits.userInterfaceStyle == .dark ? night : day
      return UIColor(red: CGFloat((hex >> 16) & 255) / 255,
                     green: CGFloat((hex >> 8) & 255) / 255,
                     blue: CGFloat(hex & 255) / 255, alpha: 1)
    })
  }
}

enum OnboardingSpecimenType {
  static let wordmark = Font.custom("Baloo2-Bold", fixedSize: 30)
  static let roomTitle = Font.custom("Nunito-ExtraBold", fixedSize: 18)
  static let roomLine = Font.custom("Inter-Regular", fixedSize: 13)
  static let miniWeight = Font.custom("JetBrainsMono-Regular", fixedSize: 30)
  static let miniCheck = Font.custom("Inter-SemiBold", fixedSize: 13)
  static let caption = Font.custom("JetBrainsMono-Regular", fixedSize: 10)
  static let treeTitle = Font.custom("Inter-SemiBold", fixedSize: 12)
  static let treeNode = Font.custom("Inter-Regular", fixedSize: 12)
  static let journalPast = Font.custom("Inter-Regular", fixedSize: 15)
  static let journalTitle = Font.custom("Nunito-ExtraBold", fixedSize: 14)
  static let journalBody = Font.custom("Inter-Regular", fixedSize: 17)
  static let scaleLabel = Font.custom("Inter-Regular", fixedSize: 11)
  static let movementTitle = Font.custom("Nunito-ExtraBold", fixedSize: 22)
  static let setMeta = Font.custom("JetBrainsMono-Regular", fixedSize: 11)
  static let setRow = Font.custom("JetBrainsMono-Regular", fixedSize: 12)
  static let weight = Font.custom("JetBrainsMono-Regular", fixedSize: 72)
  static let weightUnit = Font.custom("JetBrainsMono-Regular", fixedSize: 18)
  static let logAction = Font.custom("Nunito-ExtraBold", fixedSize: 15)
  static let checkSymbol = Font.system(size: 11, weight: .semibold)
}
