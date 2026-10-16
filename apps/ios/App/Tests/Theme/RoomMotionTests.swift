import SwiftUI
import Testing
@testable import Windmill

@Suite struct RoomMotionTests {
  @Test func everyActMovesOnTheSystemSpringAndFadesIn200MillisecondsUnderReduceMotion() {
    #expect(RoomMotion.animation(reduceMotion: false) == .spring)
    #expect(RoomMotion.animation(reduceMotion: true) == .easeInOut(duration: 0.2))
    #expect(RoomMotion.numeral(reduceMotion: false, value: 100) == .numericText(value: 100))
    #expect(RoomMotion.numeral(reduceMotion: false) == .numericText())
    #expect(RoomMotion.symbol(reduceMotion: false) == .symbolEffect(.replace))
    #expect(RoomMotion.numeral(reduceMotion: true, value: 100) == .opacity && RoomMotion.symbol(reduceMotion: true) == .opacity)
  }
}
