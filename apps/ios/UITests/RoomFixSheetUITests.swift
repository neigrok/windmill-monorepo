import XCTest

// The fix sheet at the rack (C10): a correction is one-handed too, so both its numerals raise the SAME
// keypad the logger does — and the sign key on it answers to a name rather than to its own glyph
// (C17 scope). A sheet over a finished session only exists once one has been logged, so this opens one.
final class RoomFixSheetUITests: XCTestCase {
    private var app: XCUIApplication!

    // `KeypadEntry.weightUnit` — a valid load's whole message, drawn by the rack's keypad and by nothing else.
    private let weightUnit = "kg"
    // `KeypadEntry.flipTheSign` — the one name the ± control answers to on every screen that has one.
    private let flipTheSign = "Flip the sign — band-assisted"

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

    // C10 · a correction at the rack is one-handed too: the fix sheet raises the SAME keypad the
    // logger does, off the weight numeral and off the rep count.
    func testTheFixSheetRaisesTheSameKeypadTheRackDoes() {
        logOneSetAndKeepTheSession()

        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "20 × 5")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the finished session drew no set to fix")
        row.tap()
        XCTAssertTrue(app.staticTexts["Fix this set"].waitForExistence(timeout: 10),
                      "the set row opened no fix sheet")

        app.buttons["Weight 20 kilograms"].tap()
        XCTAssertTrue(app.navigationBars["Weight"].waitForExistence(timeout: 10),
                      "the weight numeral raised no keypad")
        XCTAssertTrue(app.staticTexts[weightUnit].exists, "a valid load's message is its unit")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@",
                                                            "comma or point")).firstMatch.exists,
                       "the keypad still explains the decimal separator")
        // C17 scope · the sign key is a glyph, and a screen reader left to read it reads the glyph. It
        // carries the name the routine target's sign control carries, and the same bytes.
        XCTAssertTrue(app.buttons[flipTheSign].exists, "this is not the rack's keypad")
        XCTAssertFalse(app.buttons["±"].exists, "the sign key is still announced as its own glyph")
        app.buttons["3"].tap()
        app.buttons["0"].tap()
        app.buttons["Set"].tap()
        XCTAssertTrue(app.buttons["Weight 30 kilograms"].waitForExistence(timeout: 10),
                      "the typed weight did not reach the fix sheet")

        app.buttons["5 reps"].tap()
        XCTAssertTrue(app.staticTexts["whole reps"].waitForExistence(timeout: 10),
                      "the rep count raised no keypad, or raised it in the wrong mode")
        app.buttons["8"].tap()
        app.buttons["Set"].tap()
        XCTAssertTrue(app.buttons["8 reps"].waitForExistence(timeout: 10),
                      "the typed rep count did not reach the fix sheet")

        XCTAssertTrue(app.buttons["Save the fix"].exists, "the fix sheet lost its own commit")
    }

    // D10 · a counter over its bound goes alarm wherever it is drawn, and drawing one costs the sheet
    // vertical room. With a long note typed and the keyboard up, both of the sheet's commits — the
    // save and the delete — still have to be reachable.
    func testTheSheetStillReachesSaveAndDeleteUnderALongNoteWithTheKeyboardUp() {
        logOneSetAndKeepTheSession()

        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "20 × 5")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the finished session drew no set to fix")
        row.tap()
        XCTAssertTrue(app.staticTexts["Fix this set"].waitForExistence(timeout: 10),
                      "the set row opened no fix sheet")

        let field = noteField
        XCTAssertTrue(field.waitForExistence(timeout: 10), "the fix sheet drew no note field")
        field.tap()
        XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 10), "the note raised no keyboard")
        field.typeText(String(repeating: "felt heavy through the sticking point ", count: 6))

        for commit in ["Save the fix", "Delete set"] {
            let button = app.buttons[commit]
            XCTAssertTrue(button.exists, "the sheet lost \(commit)")
            XCTAssertTrue(scrolledTo(button),
                          "\(commit) cannot be reached under a long note — \(app.debugDescription)")
        }
    }

    // MARK: - the ways in

    // The sheet's own scroll view, never the app's middle: with a keyboard up the middle of the
    // screen is the keyboard, and a swipe there scrolls nothing.
    private func scrolledTo(_ button: XCUIElement) -> Bool {
        // Named by the bar it sits under: the keyboard puts a scroll view of its own on screen, and
        // a bare `firstMatch` picks that one often enough to make the drag land on nothing. The
        // sheet's title is its navigation bar's, not a label inside the scroll view.
        let sheet = app.otherElements.containing(.navigationBar, identifier: "Fix this set")
            .firstMatch.scrollViews.firstMatch
        guard sheet.exists else { return false }
        // Dragged between two points the keyboard does not cover, so the stroke lands on the sheet.
        let from = sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
        let to = sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05))
        for _ in 0..<6 {
            if button.isHittable { return true }
            from.press(forDuration: 0.05, thenDragTo: to)
        }
        return button.isHittable
    }

    // A vertical `TextField` is a text view on some releases and a text field on others.
    private var noteField: XCUIElement {
        let views = app.textViews
        return views.count > 0 ? views.firstMatch : app.textFields.firstMatch
    }

    // One workout, one set, finished and kept — which lands the room on the session the fix sheet is
    // opened from. Kept rather than discarded: a discarded session has no set to correct.
    private func logOneSetAndKeepTheSession() {
        XCTAssertTrue(app.buttons["Just start logging"].waitForExistence(timeout: 20),
                      "the routines home never drew its reach band")
        app.buttons["Just start logging"].tap()
        XCTAssertTrue(app.staticTexts["What are you starting with?"].waitForExistence(timeout: 20),
                      "the logger never opened")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back Squat")).firstMatch.tap()

        let logSet = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Log set")).firstMatch
        XCTAssertTrue(logSet.waitForExistence(timeout: 15), "the logger drew no Log set")
        logSet.tap()

        app.navigationBars.buttons["Finish"].tap()
        XCTAssertTrue(app.staticTexts["Session finished"].waitForExistence(timeout: 20)
                      || app.staticTexts["Ended early"].exists,
                      "the finish sheet never presented")
        // A slight session is kept by `Keep it` and every other one by the sheet's toolbar `Done`;
        // both are `onDone`.
        let keep = ["Keep it", "Done"]
            .map { app.buttons[$0] }
            .first { $0.exists }
        XCTAssertNotNil(keep, "the finish sheet drew no way to keep the session")
        keep?.tap()
        // Named by the sheet's own head: the session review screen underneath draws a
        // `Discard session` of its own now (Law 1), so that button no longer means "the sheet".
        XCTAssertFalse(app.staticTexts["Session finished"].exists
                       || app.staticTexts["Ended early"].exists,
                       "the finish sheet is still up")
    }
}
