import XCTest

// The boards, taken off the simulator rather than described. `12-native-idiom.md` asks for every screen
// carrying a numeral at three text sizes; these are the two that break things — the default and the
// largest accessibility size, which is where every hand-set fixed-width column in the room gives way.
//
// The size is set through the argument domain (`-UIPreferredContentSizeCategoryName`), so no test-only
// door exists in product code. Frames leave as attachments; `xcresulttool export attachments` lifts
// them out of the .xcresult by the names below.
final class RoomFramesUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        app?.terminate()
        app = nil
    }

    func testTheThreeRootsAtTheDefaultTextSize() {
        capture(at: "default", arguments: [])
    }

    func testTheThreeRootsAtTheLargestAccessibilityTextSize() {
        capture(at: "axxxl",
                arguments: ["-UIPreferredContentSizeCategoryName",
                            "UICTContentSizeCategoryAccessibilityXXXL"])
    }

    private func capture(at size: String, arguments: [String]) {
        app = XCUIApplication()
        app.launchArguments = ["-windmill.journey.asked", "YES",
                               "-windmill.journey.lastRoom", "gym"] + arguments
        app.launch()
        XCTAssertTrue(app.buttons["Coach"].waitForExistence(timeout: 20), "the gym room never opened")

        for (tab, slug) in [("Routines", "routines"), ("The log", "log"), ("Coach", "coach")] {
            app.tabBars.buttons[tab].tap()
            XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 10),
                          "\(tab) drew no bar of its own")
            frame("ios-c-\(slug)-\(size)")
        }

        app.tabBars.buttons["Routines"].tap()
        app.navigationBars.buttons["New routine"].tap()
        XCTAssertTrue(app.navigationBars.buttons["Cancel"].waitForExistence(timeout: 10),
                      "the editor drew no Cancel")
        frame("ios-c-editor-\(size)")

        app.buttons["Add movement"].tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10),
                      "the picker drew no search field")
        frame("ios-c-picker-\(size)")

        app.buttons["Back Squat"].firstMatch.tap()
        XCTAssertTrue(app.textFields["Sets"].waitForExistence(timeout: 10),
                      "the target sheet drew no typed fields")
        frame("ios-c-target-\(size)")
    }

    private func frame(_ named: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = named
        shot.lifetime = .keepAlways
        add(shot)
    }
}
