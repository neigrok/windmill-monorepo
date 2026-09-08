import XCTest

// The connected log, signed out, with real touches on a simulator (`19-connected-log.md`): the head
// line, the three level rows, the one caption, `Sign in first` in the reach band, and `How this works`
// closed until it is opened. Frames leave as attachments; `xcresulttool export attachments` lifts
// them out of the .xcresult by the names below.
final class RoomConnectedLogUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-windmill.journey.asked", "YES", "-windmill.journey.lastRoom", "gym"]
        app.launch()
        XCTAssertTrue(app.buttons["Coach"].waitForExistence(timeout: 20), "the gym room never opened")
    }

    override func tearDown() {
        app?.terminate()
        app = nil
    }

    func testSignedOutTheScreenIsTwoLevelsOfDisclosureAndSignInFirst() {
        let door = app.buttons["Gym settings"]
        XCTAssertTrue(door.waitForExistence(timeout: 20), "the routines home never drew its settings door")
        if !door.isHittable { app.swipeUp() }
        door.tap()
        let row = app.buttons["Connected log, nothing connected yet"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the settings row does not print the state")
        row.tap()

        XCTAssertTrue(app.navigationBars["Connected log"].waitForExistence(timeout: 10),
                      "the screen is not named by its bar")
        XCTAssertTrue(app.staticTexts["Your log, read by Claude, Cursor or Codex."].exists)
        for (label, meta) in [("Read", "sets, workouts, routines, records, notes, weigh-ins"),
                              ("Write", "logs sets · adds routines · shares workouts · proposes changes"),
                              ("Delete", "discards a workout · ends a share")] {
            XCTAssertTrue(app.staticTexts[label].exists, label)
            XCTAssertTrue(app.staticTexts[meta].exists, meta)
        }
        XCTAssertTrue(app.staticTexts["A routine change waits for your Apply; the rest lands at once."].exists)
        XCTAssertTrue(app.buttons["Sign in first"].exists, "signed out, the action names the door")
        XCTAssertFalse(app.buttons["Connect a tool"].exists)
        XCTAssertFalse(app.staticTexts["Manage connections"].exists, "nothing is connected")
        let closed = app.staticTexts["One URL pasted into your tool. Your browser opens once to approve."]
        XCTAssertFalse(closed.exists, "the disclosure opens closed")
        frame("ios-connected-log")

        app.staticTexts["How this works"].tap()
        XCTAssertTrue(closed.waitForExistence(timeout: 10), "the disclosure did not open in place")
        XCTAssertTrue(app.staticTexts["End a connection under Settings → Connected tools; a key under API keys."].exists)
        frame("ios-connected-log-open")
    }

    private func frame(_ named: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = named
        shot.lifetime = .keepAlways
        add(shot)
    }
}
