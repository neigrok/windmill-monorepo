import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// The transient's own geometry, measured by hosting it rather than reasoned from paddings. The
// conversation's detail draws 249 points, and the slot it gets — the phone less the two horizontal
// paddings, the row's spacing, the Undo button and the share the flexible spacer beside it takes —
// holds one line only from 402 points up. On a 390 it takes a second line, which is why the detail is
// clamped at TWO and not one: a disclosure cut off mid-word is not a disclosure. Swept in one-point
// steps; the numbers below are the sweep's own.
@MainActor
final class WithheldTransientTests: XCTestCase {
    private func height(detail: String, width: CGFloat) async -> CGFloat {
        let window = WithheldWindow(windowMs: 60_000)
        await window.hold(Withheld(.thread, subject: "thr_1", line: WithheldWords.thread, detail: detail))
        let host = UIHostingController(rootView: WithheldTransient(window: window, say: { _ in })
            .environment(\.gymSkin, GymSkin.instrument)
            .frame(width: width))
        return host.sizeThatFits(in: CGSize(width: width, height: .infinity)).height
    }

    func testTheConversationsDetailRunsOnRatherThanBeingCutOffMidWord() async {
        let ideal = UIHostingController(rootView: Text(WithheldWords.threadDetail).font(GymType.numeral(11.5)))
            .sizeThatFits(in: CGSize(width: CGFloat.infinity, height: .infinity)).width
        XCTAssertEqual(ideal, 249, accuracy: 1, "six words at the detail's own font")

        let oneLine = await height(detail: WithheldWords.routineDetail, width: 390)
        let above = await height(detail: WithheldWords.threadDetail, width: 402)
        let below = await height(detail: WithheldWords.threadDetail, width: 400)
        let flagship = await height(detail: WithheldWords.threadDetail, width: 390)
        let small = await height(detail: WithheldWords.threadDetail, width: 375)

        XCTAssertEqual(above, oneLine, "one line from 402 points up")
        XCTAssertGreaterThan(below, oneLine, "and a second line below it — never a sentence stopped mid-word")
        XCTAssertGreaterThan(flagship, oneLine, "which is where every 390-point phone lands")
        XCTAssertGreaterThan(small, oneLine)
    }

    // The routine's own detail is four words and clears the slot on every phone the room runs on, so the
    // two-line clamp costs it nothing: it is the one-line reference the case above measures against.
    func testTheRoutinesDetailIsOneLineOnEveryPhone() async {
        let oneLine = await height(detail: WithheldWords.routineDetail, width: 430)
        for width in [430.0, 402.0, 393.0, 390.0, 375.0, 360.0] {
            let drawn = await height(detail: WithheldWords.routineDetail, width: width)
            XCTAssertEqual(drawn, oneLine, "one line at \(width)")
        }
    }
}
