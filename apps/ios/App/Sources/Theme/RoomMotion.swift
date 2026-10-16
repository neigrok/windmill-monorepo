import SwiftUI

// The rooms' one motion rule (docs/design/ios/ios-redesign.md §5 Motion): each act answers in place on the system spring,
// a numeral rolls and a mark replaces its symbol; with Reduce Motion each is a 200 ms fade.
nonisolated enum RoomMotion {
  static func animation(reduceMotion: Bool) -> Animation { reduceMotion ? .easeInOut(duration: 0.2) : .spring }

  static func numeral(reduceMotion: Bool, value: Double? = nil) -> ContentTransition {
    if reduceMotion { return .opacity }
    return value.map { .numericText(value: $0) } ?? .numericText()
  }

  static func symbol(reduceMotion: Bool) -> ContentTransition { reduceMotion ? .opacity : .symbolEffect(.replace) }
}

// A view answers a change of `value` with the room's motion: a band's host keyed on what the band says, a numeral on its
// number, a ledger row on its place.
struct RoomMotionAnimation<Value: Equatable>: ViewModifier {
  let value: Value
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View { content.animation(RoomMotion.animation(reduceMotion: reduceMotion), value: value) }
}

extension View {
  func roomMotion<Value: Equatable>(_ value: Value) -> some View { modifier(RoomMotionAnimation(value: value)) }
}
