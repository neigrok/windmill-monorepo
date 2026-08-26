import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// The finish is a `.sheet` at `.large`, so it covers the room's note line — the one place the room
// draws a sentence. A refusal from `Save routine` or `Discard session` therefore has to be drawn
// INSIDE the sheet or it is not drawn at all, which is the "nothing is silently dead" rule.
//
// Proved the way `ReviewSheetHostingTests` proves its gate: host the real screen and read the pixels.
// `skin.alarmInk` (#D08268) is painted nowhere else on this screen, so counting it answers whether
// the sentence reached the glass rather than whether a property was set.
@MainActor
final class FinishSheetRefusalHostingTests: XCTestCase {
    private let keepRefused = "the log didn’t answer — the routine wasn’t kept"
    private let discardRefused = "the log didn’t answer — the session is still there"

    private func session(finishedAtMs: Int64? = 1_754_312_040_000) -> Session {
        Session(id: "ses_1", startedAtMs: 1_754_308_320_000, finishedAtMs: finishedAtMs)
    }

    private func working() -> [TrainingSet] {
        [TrainingSet(id: "set_1", exerciseId: "back-squat", setNumber: 1, weightKg: 100, reps: 5,
                     completedAtMs: 1_754_308_920_000)]
    }

    private func doors() -> CoachDoors {
        CoachDoors(base: URL(string: "https://windmill.works")!,
                   mint: { .failure(.noAnswer) },
                   revoke: { nil })
    }

    private func host(_ finished: FinishedSession, failure: String?) async -> UIWindow {
        let screen = FinishScreen(finished: finished,
                                  catalog: [Exercise(id: "back-squat", name: "Back Squat")],
                                  kept: false, coach: doors(), failure: failure,
                                  onKeepRoutine: { _ in }, onDiscard: {}, onDone: {})
            .environment(\.gymSkin, GymSkin.instrument)
            .environment(\.colorScheme, .dark)
        let controller = UIHostingController(rootView: screen)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 1400))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        for _ in 0..<30 {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(50))
        }
        return window
    }

    // Pixels of the alarm ink anywhere in the window. Rendered at device scale rather than at 1:
    // a 12.5pt line drawn at 1x is all antialiasing and hits its own colour exactly nowhere.
    private func alarmPixels(of window: UIWindow) -> Int {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
        guard let cg = image.cgImage, let data = cg.dataProvider?.data,
              let bytes = CFDataGetBytePtr(data) else { return 0 }
        let width = cg.width, height = cg.height, perRow = cg.bytesPerRow, perPixel = cg.bitsPerPixel / 8
        let alphaFirst = cg.alphaInfo == .premultipliedFirst || cg.alphaInfo == .first
            || cg.alphaInfo == .noneSkipFirst
        let bgr = cg.bitmapInfo.contains(.byteOrder32Little)
        var lit = 0
        for y in 0..<height {
            for x in 0..<width {
                let at = y * perRow + x * perPixel
                let r: Int, g: Int, b: Int
                if bgr { (r, g, b) = (Int(bytes[at + 2]), Int(bytes[at + 1]), Int(bytes[at])) }
                else if alphaFirst { (r, g, b) = (Int(bytes[at + 1]), Int(bytes[at + 2]), Int(bytes[at + 3])) }
                else { (r, g, b) = (Int(bytes[at]), Int(bytes[at + 1]), Int(bytes[at + 2])) }
                if abs(r - 0xD0) < 10 && abs(g - 0x82) < 10 && abs(b - 0x68) < 10 { lit += 1 }
            }
        }
        return lit
    }

    // `Save routine` is offered on a session with no routine and a working set; its refusal belongs
    // under that button.
    func testAKeepRefusalIsDrawnInsideTheSheetThatRaisedIt() async {
        let closed = FinishedSession(session: session(), sets: working(), review: nil, isFirst: true)
        XCTAssertTrue(closed.offersRoutine, "this fixture is not the keep-as-routine state")

        let silent = alarmPixels(of: await host(closed, failure: nil))
        let refused = alarmPixels(of: await host(closed, failure: keepRefused))

        XCTAssertEqual(silent, 0, "the keep-as-routine card paints the alarm ink with nothing to refuse")
        XCTAssertGreaterThan(refused, silent + 100,
                             "a refused keep says nothing anywhere the lifter can read it "
                             + "(silent \(silent) · refused \(refused))")
    }

    // `Discard session` is offered only on a slight session, and its refusal belongs under it.
    func testADiscardRefusalIsDrawnInsideTheSheetThatRaisedIt() async {
        let slight = Review(stats: Review.Stats(durationMs: 240_000, workingSets: 1), slight: true)
        let closed = FinishedSession(session: session(), sets: working(), review: slight, isFirst: true)
        XCTAssertTrue(closed.slight, "this fixture is not the ended-early state")
        XCTAssertFalse(closed.offersRoutine, "a slight session is never offered as a routine")

        // `Discard session` is itself drawn in the alarm ink, so the count is a DELTA, never a floor.
        let silent = alarmPixels(of: await host(closed, failure: nil))
        let refused = alarmPixels(of: await host(closed, failure: discardRefused))

        XCTAssertGreaterThan(refused, silent + 100,
                             "a refused discard says nothing anywhere the lifter can read it "
                             + "(silent \(silent) · refused \(refused))")
    }
}
