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
        XCTAssertTrue(app.buttons["Discard session"].exists, "the sheet lost its destructive door")

        app.buttons["Discard session"].tap()
        XCTAssertTrue(app.staticTexts["Discard this session?"].waitForExistence(timeout: 10),
                      "discarding a whole workout was not asked about")
        app.buttons["Discard"].tap()

        // The sheet stood over a session that no longer exists, so the room unwinds to the log's root.
        XCTAssertTrue(app.navigationBars["The log"].waitForExistence(timeout: 20),
                      "the room did not land back on the log after a discard")
        XCTAssertFalse(app.buttons["Discard session"].exists, "the finish sheet is still up")
    }
}
