import SwiftUI
import UIKit

// Asset names and values follow docs/design/ios/ios-redesign.md §2; `ui` roles resolve in the UIKit view that draws them.

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
  static let uiAccent = UIColor(named: "gym/accent")!
}

nonisolated enum JournalPalette {
  static let canvas = Color("journal/canvas")
  static let card = Color("journal/card")
  static let line = Color("journal/line")
  static let ink = Color("journal/ink")
  static let inkDim = Color("journal/ink-dim")
  static let inkFaint = Color("journal/ink-faint")
  static let lamp = Color("journal/lamp")
  static let lampSoft = Color("journal/lamp-soft")
  static let energy = Color("journal/energy")
  static let moodRamp = (0...10).map { Color("journal/mood-\($0)") }
  static func mood(_ value: Int) -> Color { moodRamp[min(10, max(0, value))] }
  static let uiInk = UIColor(named: "journal/ink")!
  static let uiLamp = UIColor(named: "journal/lamp")!
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
  static let danger = Color("shell/danger")
  static let uiBrand = UIColor(named: "shell/brand")!
}

// What a shared control takes from the room that hosts it; the shell lends its brand as the accent.
struct RoomColors {
  let ink: Color
  let inkDim: Color
  let card: Color
  let accent: Color
  let onAccent: Color

  static let gym = RoomColors(ink: GymPalette.ink, inkDim: GymPalette.inkDim, card: GymPalette.card, accent: GymPalette.accent,
                              onAccent: GymPalette.onAccent)
  static let shell = RoomColors(ink: ShellPalette.ink, inkDim: ShellPalette.inkDim, card: ShellPalette.card, accent: ShellPalette.brand,
                                onAccent: ShellPalette.onBrand)
}
