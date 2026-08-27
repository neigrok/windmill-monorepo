import XCTest

// Walking between movements at the rack. Two chevron buttons came off the busiest screen in the
// product and a horizontal stroke took their place, so the stroke is what has to be driven: it is
// laid over a full-width tap target and a nested vertical scroll, and neither may swallow it.
final class RoomLoggerWalkUITests: XCTestCase {
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

    func testAHorizontalStrokeWalksBetweenMovementsAndTheChevronsAreGone() {
        startOn("Back Squat")
        addNextMovement("Bench Press")

        XCTAssertFalse(app.buttons["Next movement"].exists, "the chevron is still drawn")
        XCTAssertFalse(app.buttons["Previous movement"].exists, "the chevron is still drawn")

        XCTAssertTrue(title("Bench Press").waitForExistence(timeout: 10),
                      "adding a movement did not land on it")

        // Away from the leading edge, which the shell's way home owns at this depth.
        app.swipeRight()
        XCTAssertTrue(title("Back Squat").waitForExistence(timeout: 10),
                      "the stroke did not walk back to the first movement")

        app.swipeLeft()
        XCTAssertTrue(title("Bench Press").waitForExistence(timeout: 10),
                      "the stroke did not walk on to the second movement")

        finishAndKeep()
    }

    // The walk stops at the ends of the order rather than wrapping.
    func testTheWalkStopsAtTheEndsRatherThanWrapping() {
        startOn("Back Squat")
        addNextMovement("Bench Press")
        app.swipeRight()
        XCTAssertTrue(title("Back Squat").waitForExistence(timeout: 10))

        app.swipeRight()
        XCTAssertTrue(title("Back Squat").exists, "the walk wrapped round to the last movement")

        finishAndKeep()
    }

    // MARK: - the ways in

    private func title(_ movement: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@",
                                         movement, "movement")).firstMatch
    }

    private func startOn(_ movement: String) {
        XCTAssertTrue(app.buttons["Just start logging"].waitForExistence(timeout: 20),
                      "the routines home never drew its reach band")
        app.buttons["Just start logging"].tap()
        XCTAssertTrue(app.staticTexts["What are you starting with?"].waitForExistence(timeout: 20),
                      "the logger never opened")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", movement)).firstMatch.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Log set"))
            .firstMatch.waitForExistence(timeout: 15), "the logger drew no Log set")
    }

    private func addNextMovement(_ movement: String) {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "no target")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["This session"].waitForExistence(timeout: 10),
                      "the title opened no jump sheet")
        app.buttons["+ Add next movement"].tap()
        let picked = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", movement)).firstMatch
        XCTAssertTrue(picked.waitForExistence(timeout: 10), "the picker never opened")
        picked.tap()
    }

    private func finishAndKeep() {
        app.navigationBars.buttons["Finish"].tap()
        XCTAssertTrue(app.staticTexts["Session finished"].waitForExistence(timeout: 20)
                      || app.staticTexts["Ended early"].exists,
                      "the finish sheet never presented")
        let keep = ["Keep it", "Just keep the session", "Done"]
            .map { app.buttons[$0] }
            .first { $0.exists }
        keep?.tap()
    }
}
