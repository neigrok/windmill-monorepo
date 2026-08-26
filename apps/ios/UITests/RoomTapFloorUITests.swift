import XCTest

// The room's tap floor, measured where a stock control breaks it. A control's height is decided by the
// environment it renders in, so nothing but a laid-out screen can say whether it clears the floor.
final class RoomTapFloorUITests: XCTestCase {
    private var app: XCUIApplication!

    private let settingsDoor = "Gym settings"
    private let settingsMark = "how the room behaves at the rack"

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

    // The room's tap floor is 46pt (`GymTap.minimum`) and a stock segmented control measured 30.7pt
    // here. A frame does not move it — `.controlSize(.large)` does, to 48.
    func testTheSettingsSegmentedControlsKeepTheRoomsTapFloor() {
        let door = app.buttons[settingsDoor]
        XCTAssertTrue(scrolled(to: door), "the routines home never drew its settings door")
        door.tap()
        XCTAssertTrue(app.staticTexts[settingsMark].waitForExistence(timeout: 10),
                      "the settings screen never pushed")

        let controls = app.segmentedControls
        XCTAssertEqual(controls.count, 2, "settings draws two segmented controls — units and rest")
        for index in 0..<controls.count {
            let control = controls.element(boundBy: index)
            XCTAssertGreaterThanOrEqual(control.frame.height, 46,
                                        "a segmented control stands under the room's tap floor")
        }
    }

    // MARK: - the ways in

    // A `List` builds its rows lazily, so a row below the fold is not merely unhittable — it is not in
    // the tree at all, and asking whether it exists answers no until the list is scrolled to it.
    private func scrolled(to element: XCUIElement, tries: Int = 6) -> Bool {
        for _ in 0..<tries {
            if element.exists, element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists && element.isHittable
    }
}
