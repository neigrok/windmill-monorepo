import SwiftUI
import UIKit
import Testing
@testable import Windmill

@Suite @MainActor struct RoomTransientTests {
  func bandHeight(_ content: some View, typeSize: DynamicTypeSize = .accessibility3) -> CGFloat {
    let host = UIHostingController(rootView: content.modifier(BoundedBand()).environment(\.dynamicTypeSize, typeSize))
    return host.sizeThatFits(in: CGSize(width: 393, height: 800)).height
  }

  @Test func aBoundedBandTakesItsContentsHeightUpToItsLimitAndNothingWhenEmpty() {
    #expect(bandHeight(VStack {}) == 0)
    #expect(bandHeight(Color.clear.frame(height: 60)) == 60)
    #expect(bandHeight(Color.clear.frame(height: 400)) == 180)
    #expect(bandHeight(Color.clear.frame(height: 400), typeSize: .large) == 400)
  }

  @Test func theBandMovesOnTheSystemSpringAndFadesIn200MillisecondsUnderReduceMotion() {
    #expect(RoomTransient.motion(reduceMotion: false) == .spring)
    #expect(RoomTransient.motion(reduceMotion: true) == .easeInOut(duration: 0.2))
  }
}
