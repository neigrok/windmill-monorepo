import SwiftUI
import UIKit

// Asset names and values follow docs/design/ios/ios-redesign.md §2; roles resolve from any thread.

nonisolated enum GymPalette {
  static let canvas = Color("gym/canvas")
  static let card = Color("gym/card")
  static let line = Color("gym/line")
  static let ink = Color("gym/ink")
  static let inkDim = Color("gym/ink-dim")
  static let inkFaint = Color("gym/ink-faint")
  static let accent = Color("gym/accent")
  static let accentSoft = Color("gym/accent-soft")
  static let onAccent = Color("gym/on-accent")
  static let done = Color("gym/done")
  static let record = Color("gym/record")
  static let alarm = Color("gym/alarm")
}

nonisolated enum JournalPalette {
  static let canvas = Color("journal/canvas")
  static let line = Color("journal/line")
  static let ink = Color("journal/ink")
  static let inkDim = Color("journal/ink-dim")
  static let inkFaint = Color("journal/ink-faint")
  static let lamp = Color("journal/lamp")
  static let lampSoft = Color("journal/lamp-soft")
  static let energy = Color("journal/energy")
  static let moodRamp = (0...10).map { Color("journal/mood-\($0)") }
  static func mood(_ value: Int) -> Color { moodRamp[min(10, max(0, value))] }
  static func nightColor(_ role: Color) -> UIColor {
    UIColor(role).resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
  }
}

nonisolated enum ShellPalette {
  static let canvas = Color("shell/canvas")
  static let card = Color("shell/card")
  static let raised = Color("shell/raised")
  static let line = Color("shell/line")
  static let lineStrong = Color("shell/line-strong")
  static let ink = Color("shell/ink")
  static let inkDim = Color("shell/ink-dim")
  static let inkFaint = Color("shell/ink-faint")
  static let brand = Color("shell/brand")
  static let onBrand = Color("shell/on-brand")
}

// What a shared control takes from the room that hosts it; the shell lends its brand as the accent.
struct RoomColors {
  let ink: Color
  let card: Color
  let accent: Color
  let onAccent: Color

  static let gym = RoomColors(ink: GymPalette.ink, card: GymPalette.card, accent: GymPalette.accent, onAccent: GymPalette.onAccent)
  static let shell = RoomColors(ink: ShellPalette.ink, card: ShellPalette.card, accent: ShellPalette.brand, onAccent: ShellPalette.onBrand)
}
