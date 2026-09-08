import XCTest

// The set-targets fixture of `17-set-targets.md`, walked with real touches: Lower A's Back Squat typed
// as a ramp on the target sheet, read back on the routine's own screen, and lifted two sets in at the
// rack — where the set line and the slot strip say which set comes next. Each state is photographed
// as an attachment, because a ladder under a keyboard and a strip of slots only exist once laid out.
final class RoomSetTargetsUITests: XCTestCase {
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

    func testARampIsTypedReadBackAndLiftedSlotBySlot() {
        app.navigationBars.buttons["New routine"].tap()
        XCTAssertTrue(app.navigationBars.buttons["Save"].waitForExistence(timeout: 10), "the editor never opened")
        app.typeText("Lower A")

        app.buttons["Add movement"].tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10), "the picker never opened")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back Squat")).firstMatch.tap()
        XCTAssertTrue(app.textFields["Sets"].waitForExistence(timeout: 10), "the target sheet never opened")

        app.textFields["Sets"].tap()
        app.typeText("5")
        // The keyboard's `Next` walks the ladder top to bottom without leaving the keyboard.
        app.textFields["Set 1 reps"].tap()
        for (ordinal, set) in [(1, ("5", "60")), (2, ("5", "80")), (3, ("3", "90")), (4, ("1", "100")), (5, ("5", "80"))] {
            app.typeText(set.0)
            app.buttons["Next"].tap()
            app.typeText(set.1)
            XCTAssertEqual(app.textFields["Set \(ordinal) weight"].value as? String, set.1,
                           "row \(ordinal)'s load did not land in its own field")
            if ordinal < 5 { app.buttons["Next"].tap() }
        }
        // The keyboard's own bar puts it down; the commit stands under the list again.
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["Set · 5 sets"].waitForExistence(timeout: 10),
                      "a ladder whose rows disagree is named by its count")
        XCTAssertEqual(app.textFields["Reps"].value as? String, "varies")
        XCTAssertEqual(app.textFields["Weight · kg"].value as? String, "varies")
        app.swipeDown()
        frame("ios-targets-sheet")
        app.buttons["Set · 5 sets"].tap()

        XCTAssertTrue(app.staticTexts["5 × 1–5 · 60–100"].waitForExistence(timeout: 10),
                      "the editor row does not read the ramp in the readout formula")
        app.navigationBars.buttons["Save"].tap()

        // Save lands on the routine's own screen.
        let start = app.buttons["Start workout"]
        XCTAssertTrue(start.waitForExistence(timeout: 20), "the routine screen never opened")
        XCTAssertTrue(app.staticTexts["5 × 1–5 · 60–100"].exists, "the routine screen lost the readout")
        frame("ios-targets-routine")

        start.tap()
        let logSet = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Log set")).firstMatch
        XCTAssertTrue(logSet.waitForExistence(timeout: 20), "the logger never opened")
        XCTAssertTrue(app.staticTexts["Set 1 of 5 · target 5 @ 60"].waitForExistence(timeout: 10),
                      "the set line does not read the first slot")
        XCTAssertTrue(app.buttons["Weight 60 kilograms"].exists, "the pad did not open on slot 1's load")
        logSet.tap()
        XCTAssertTrue(app.staticTexts["Set 2 of 5 · target 5 @ 80"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Weight 80 kilograms"].waitForExistence(timeout: 10),
                      "the prefill did not follow the second slot")
        logSet.tap()
        XCTAssertTrue(app.staticTexts["Set 3 of 5 · target 3 @ 90"].waitForExistence(timeout: 10),
                      "the set line does not read the current slot")
        XCTAssertTrue(app.buttons["Weight 90 kilograms"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["set 3, target 90 × 3"].exists
                      || app.staticTexts["set 3, target 90 × 3"].exists,
                      "the strip does not speak the current slot")
        frame("ios-targets-logger")

        discardTheSession()
        deleteTheRoutine()
    }

    private func frame(_ named: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = named
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func scrolled(to element: XCUIElement, tries: Int = 4) -> Bool {
        for _ in 0..<tries {
            if element.exists, element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists && element.isHittable
    }

    // A session left open follows the next launch, so the walk ends on the log with nothing standing.
    private func discardTheSession() {
        app.navigationBars.buttons["Finish"].tap()
        let done = app.navigationBars.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 20), "the finish sheet never presented")
        done.tap()
        let discard = app.buttons["Discard session"]
        XCTAssertTrue(discard.waitForExistence(timeout: 20), "the session page never opened")
        discard.tap()
        let undo = app.buttons["Undo"]
        guard undo.waitForExistence(timeout: 5) else { return }
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: undo)
        waitForExpectations(timeout: 25)
    }

    private func deleteTheRoutine() {
        app.tabBars.buttons["Routines"].tap()
        for _ in 0..<3 where !app.navigationBars["Routines"].exists {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        XCTAssertTrue(app.navigationBars["Routines"].waitForExistence(timeout: 20))
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Lower A")).firstMatch
        XCTAssertTrue(scrolled(to: row), "the routines list drew no card for Lower A")
        row.swipeLeft()
        let delete = app.buttons["Delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 10), "the routine row revealed no Delete")
        delete.tap()
        let undo = app.buttons["Undo"]
        guard undo.exists else { return }
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: undo)
        waitForExpectations(timeout: 25)
    }
}
