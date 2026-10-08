import SwiftUI

// Asset names and values follow docs/design/ios/ios-redesign.md §2.

enum GymPalette {
  static let canvas = Color("gym/canvas")
  static let card = Color("gym/card")
  static let raised = Color("gym/raised")
  static let sunken = Color("gym/sunken")
  static let line = Color("gym/line")
  static let lineStrong = Color("gym/line-strong")
  static let overlay = Color("gym/overlay")
  static let ink = Color("gym/ink")
  static let inkDim = Color("gym/ink-dim")
  static let inkFaint = Color("gym/ink-faint")
  static let accent = Color("gym/accent")
  static let accentSoft = Color("gym/accent-soft")
  static let onAccent = Color("gym/on-accent")
  static let done = Color("gym/done")
  static let record = Color("gym/record")
  static let alarm = Color("gym/alarm")
  static let alarmFill = Color("gym/alarm-fill")
  static let onAlarm = Color("gym/on-alarm")
}

enum JournalPalette {
  static let canvas = Color("journal/canvas")
  static let card = Color("journal/card")
  static let sunken = Color("journal/sunken")
  static let line = Color("journal/line")
  static let lineStrong = Color("journal/line-strong")
  static let overlay = Color("journal/overlay")
  static let ink = Color("journal/ink")
  static let inkDim = Color("journal/ink-dim")
  static let inkFaint = Color("journal/ink-faint")
  static let lamp = Color("journal/lamp")
  static let lampSoft = Color("journal/lamp-soft")
  static let energy = Color("journal/energy")
  static let moodRamp = (0...10).map { Color("journal/mood-\($0)") }
  static func mood(_ value: Int) -> Color { moodRamp[min(10, max(0, value))] }
}

enum ShellPalette {
  static let canvas = Color("shell/canvas")
  static let card = Color("shell/card")
  static let raised = Color("shell/raised")
  static let sunken = Color("shell/sunken")
  static let line = Color("shell/line")
  static let lineStrong = Color("shell/line-strong")
  static let overlay = Color("shell/overlay")
  static let ink = Color("shell/ink")
  static let inkDim = Color("shell/ink-dim")
  static let inkFaint = Color("shell/ink-faint")
  static let brand = Color("shell/brand")
  static let onBrand = Color("shell/on-brand")
  static let danger = Color("shell/danger")
}
