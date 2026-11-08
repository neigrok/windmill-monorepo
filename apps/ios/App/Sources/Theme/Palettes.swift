import SwiftUI
import UIKit

// Asset names and values follow docs/design/ios/ios-redesign.md §2; `ui` roles resolve in the UIKit view that draws them.

nonisolated enum GymPalette {
  static let control = Color(uiColor: .tertiarySystemFill)
  static let uiInkFaint = UIColor(named: "gym/ink-faint")!
  // System red drawn by hand: a removal's badge on Coach's card, a failed Apply's line, and Edit sets'
  // Remove from workout.
  static let destructive = Color(uiColor: .systemRed)
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
  // The black a full-screen photo sits on in both appearances (§7.3).
  static let photoGround = Color.black
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
  static let uiInk = UIColor(named: "journal/ink")!
  static let uiLamp = UIColor(named: "journal/lamp")!
  // Faded roles: a kindled echo count, and an opened passage's highlight on its page.
  static let kindled = lamp.opacity(0.4)
  static var uiHighlight: UIColor { uiLamp.withAlphaComponent(0.24) }
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
  // Faded roles: the brand's wash under a brand tag, a page control's resting dots.
  static let brandWash = brand.opacity(0.16)
  static let inkResting = ink.opacity(0.28)
}

// What a shared control takes from the room that hosts it; the shell lends its brand as the accent, the journal its lamp.
struct RoomColors {
  let ink: Color
  let inkDim: Color
  let accent: Color
  let onAccent: Color

  static let gym = RoomColors(ink: GymPalette.ink, inkDim: GymPalette.inkDim, accent: GymPalette.accent,
                              onAccent: GymPalette.onAccent)
  static let shell = RoomColors(ink: ShellPalette.ink, inkDim: ShellPalette.inkDim, accent: ShellPalette.brand,
                                onAccent: ShellPalette.onBrand)
  static let journal = RoomColors(ink: JournalPalette.ink, inkDim: JournalPalette.inkDim, accent: JournalPalette.lamp,
                                  onAccent: JournalPalette.canvas)
}
