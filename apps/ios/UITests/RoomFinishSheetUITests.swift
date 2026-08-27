import XCTest

// The finish stops being a screen of its own and becomes a sheet over the session it just closed
// (`16-the-workout.md`), and Finish itself stops being a button in the logger's own header and becomes
// that screen's one toolbar action. Both are things only a running session shows, so this class opens
// one — and it discards it on the way out, because a session left open follows the next launch.
final class RoomFinishSheetUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-windmill.journey.asked", "YES", "-windmill.journey.lastRoom", "gym"]
        app.launch()
    }

    override func tearDown() {
        app?.terminate()
        app = nil
    }

    func testFinishIsAToolbarActionAndItsSheetStandsOverTheSessionItClosed() {
        XCTAssertTrue(app.buttons["Just start logging"].waitForExistence(timeout: 20),
                      "the routines home never drew its reach band")
        app.buttons["Just start logging"].tap()

        XCTAssertTrue(app.staticTexts["What are you starting with?"].waitForExistence(timeout: 20),
                      "the logger never opened")
        XCTAssertTrue(app.navigationBars.buttons["Finish"].exists, "Finish is not a toolbar action")
        XCTAssertTrue(app.navigationBars.buttons["You"].exists, "the You seat left the logger")
        XCTAssertTrue(app.navigationBars.buttons["Switch app"].exists, "the capsule left the logger")

        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back Squat")).firstMatch.tap()

        // All four kinds, and the pill is one tap rather than a trip through a sheet.
        let pill = app.buttons["Set type"]
        XCTAssertTrue(pill.waitForExistence(timeout: 15), "the logger drew no set-kind control")
        pill.tap()
        for kind in ["warmup", "working", "drop", "failure"] {
            XCTAssertTrue(app.buttons[kind].waitForExistence(timeout: 5), "\(kind) is not offered")
        }
        app.buttons["working"].tap()

        let logSet = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Log set")).firstMatch
        XCTAssertTrue(logSet.waitForExistence(timeout: 10), "the logger drew no Log set")
        logSet.tap()

        app.navigationBars.buttons["Finish"].tap()

        // Presented only after the close reported the session closed, and over the session itself.
        XCTAssertTrue(app.staticTexts["Session finished"].waitForExistence(timeout: 20)
                      || app.staticTexts["Ended early"].exists,
                      "the finish sheet never presented")
        // The sheet stands OVER the session review screen, which draws a `Discard session` of its
        // own now (Law 1) — so the sheet's is named by the one a thumb can actually reach.
        let discard = app.buttons.matching(identifier: "Discard session")
            .allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(discard, "the sheet lost its destructive door")

        discard?.tap()
        // A confirmation on an act that HAS an undo is a tap that buys nothing, so the dialog is gone
        // and the nine-second window took its place (`13-gestures.md` Law 2).
        XCTAssertFalse(app.staticTexts["Discard this session?"].exists,
                       "the discard still asks a question it no longer needs to")
        XCTAssertTrue(app.staticTexts["Session deleted."].waitForExistence(timeout: 10),
                      "the discard offered no way back")
        XCTAssertTrue(app.buttons["Undo"].exists)

        // The sheet stood over a session on its way out, so the room unwinds to the log's root.
        XCTAssertTrue(app.navigationBars["The log"].waitForExistence(timeout: 20),
                      "the room did not land back on the log after a discard")
        XCTAssertFalse(app.buttons["Discard session"].exists, "the finish sheet is still up")

        // Nothing reaches the shelf until the window closes, and this test leaves nothing standing.
        waitOutTheWindow()
    }

    // The transient retires with the last clock, and only then has the discard actually happened.
    private func waitOutTheWindow() {
        let undo = app.buttons["Undo"]
        guard undo.exists else { return }
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: undo)
        waitForExpectations(timeout: 25)
    }
}
