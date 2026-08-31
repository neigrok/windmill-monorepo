import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// The finish is a `.sheet` at `.large`, so it covers the room's note line — the one place the room
// draws a sentence. A refusal from `Save routine` therefore has to be drawn INSIDE the sheet or it
// is not drawn at all, which is the "nothing is silently dead" rule. A discard's refusal is not in
// that position: discarding empties the sheet before the nine-second window even starts, so by the
// time the log answers the room's own line is uncovered and that is where it lands.
//
// Proved the way `ReviewSheetHostingTests` proves its gate: host the real screen and read the pixels
// (`alarmPixels`). `skin.alarmInk` is painted nowhere else on this screen, so counting it answers
// whether the sentence reached the glass rather than whether a property was set.
@MainActor
final class FinishSheetRefusalHostingTests: XCTestCase {
    private let keepRefused = "the log didn’t answer — the routine wasn’t kept"

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

    private func host(_ finished: FinishedSession, failure: String?,
                      settling: Bool = true) async -> UIWindow {
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
        guard settling else { return window }
        for _ in 0..<30 {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(50))
        }
        return window
    }

    // `Save routine` is offered on a session with no routine and a working set; its refusal belongs
    // under that button. The silent count is zero because the name is seeded where the view is
    // built, so the field is never empty for a frame — which the test below is the pin for.
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

    // The sheet animates in over about a third of a second. A name seeded after the view appears
    // would spend that whole animation refusing the lifter for a field they have not touched, so it
    // is seeded where the view is built and the first frame is already silent.
    func testTheKeepCardRefusesNothingOnTheFrameItAppearsOn() async {
        let closed = FinishedSession(session: session(), sets: working(), review: nil, isFirst: true)
        XCTAssertTrue(closed.offersRoutine, "this fixture is not the keep-as-routine state")

        let first = alarmPixels(of: await host(closed, failure: nil, settling: false))

        XCTAssertEqual(first, 0, "the sheet refuses the empty name before its own name has landed")
    }
}
