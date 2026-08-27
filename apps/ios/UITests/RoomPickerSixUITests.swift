import XCTest

// C2 · the six are the account's OWN most-trained, ranked off the log this device holds, and the
// shared opener list only fills what the log cannot. `PickerSixRankingTests` pins the ranking; this
// pins the wiring — that the log the room holds actually reaches the picker, which no unit test can
// see, because the picker's `sessions` are handed to it by the screen that draws it.
//
// The assertion is written to hold on every run rather than only on a fresh phone: a kept session
// stays on the device, so a test that asserted "before" would pass once and then poison itself. What
// is asserted is the state a run leaves behind, and it is the state the unwired picker cannot reach —
// with no log in hand the six are the openers, the leg press sits deep in the catalogue and the chin-
// up is the sixth row on screen.
final class RoomPickerSixUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-windmill.journey.asked", "YES", "-windmill.journey.lastRoom", "gym"]
        app.launch()
        // A room holding an open session draws the logger and no tabs, so a session left standing by
        // whatever ran before is thrown away rather than allowed to fail this test as a room that
        // never opened.
        if !app.buttons["Coach"].waitForExistence(timeout: 20) { throwAwayTheStandingSession() }
        XCTAssertTrue(app.buttons["Coach"].waitForExistence(timeout: 20), "the gym room never opened")
    }

    override func tearDown() {
        app?.terminate()
        app = nil
    }

    func testAMovementTheLogNamesTakesAnOpenersPlaceAmongTheSix() {
        logOneSession(of: "Leg Press")
        // Keeping a session leaves the room standing on the session it just closed, and the picker is
        // reached from the routines home. Coming back through the front door rather than guessing at
        // chrome also proves the ranking survives the log being read again from scratch.
        relaunch()

        openThePicker()
        let legPress = row("Leg Press")
        XCTAssertTrue(legPress.waitForExistence(timeout: 10),
                      "a movement this log has trained is not among the six on screen")
        let barbellRow = row("Barbell Row")
        XCTAssertTrue(barbellRow.exists, "the openers no longer fill what the log cannot")
        XCTAssertLessThan(legPress.frame.minY, barbellRow.frame.minY,
                          "what the log ranked sits below what merely topped the six up")
        // The six are six: one ranked movement puts the last opener out, and the catalogue it lands
        // in is twenty rows below the fold.
        XCTAssertFalse(row("Chin Up").exists,
                       "the six grew a seventh row rather than spending one")

        leaveTheSessionUnstarted()
    }

    // MARK: - the ways in

    // The finish sheet stands OVER the session review screen, which draws a `Discard session` of its
    // own now (Law 1) — so the sheet's is named by the one a thumb can actually reach.
    private var theSheetsDiscard: XCUIElement? {
        app.buttons.matching(identifier: "Discard session")
            .allElementsBoundByIndex.first { $0.isHittable }
    }

    private func throwAwayTheStandingSession() {
        guard app.navigationBars.buttons["Finish"].exists else { return }
        app.navigationBars.buttons["Finish"].tap()
        guard app.buttons["Discard session"].waitForExistence(timeout: 20) else { return }
        guard let discard = theSheetsDiscard else { return }
        discard.tap()
        waitOutTheWindow()
    }

    // Discarding asks nothing and is withheld for nine seconds instead, so nothing has actually left
    // the shelf until the transient retires — and a relaunch before then brings the session back.
    private func waitOutTheWindow() {
        let undo = app.buttons["Undo"]
        guard undo.waitForExistence(timeout: 10) else { return }
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: undo)
        waitForExpectations(timeout: 25)
    }

    private func relaunch() {
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Coach"].waitForExistence(timeout: 20), "the gym room never reopened")
    }

    private func row(_ movement: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", movement)).firstMatch
    }

    private func openThePicker() {
        XCTAssertTrue(app.buttons["Just start logging"].waitForExistence(timeout: 20),
                      "the routines home never drew its reach band")
        app.buttons["Just start logging"].tap()
        XCTAssertTrue(app.staticTexts["What are you starting with?"].waitForExistence(timeout: 20),
                      "the logger never opened")
        XCTAssertTrue(app.staticTexts["The six"].waitForExistence(timeout: 10),
                      "the picker drew no six to rank")
    }

    // Searched for rather than scrolled to: the leg press is the seventh row of the catalogue on a
    // phone that has never trained it, and this test is about where it sits AFTERWARDS.
    private func logOneSession(of movement: String) {
        openThePicker()
        app.searchFields.firstMatch.tap()
        app.typeText(movement)
        let found = row(movement)
        XCTAssertTrue(found.waitForExistence(timeout: 10), "the catalogue does not hold \(movement)")
        found.tap()

        let logSet = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Log set")).firstMatch
        XCTAssertTrue(logSet.waitForExistence(timeout: 15), "the logger drew no Log set")
        logSet.tap()

        app.navigationBars.buttons["Finish"].tap()
        // One set is a slight session, so which head the sheet draws is the log's business and not
        // this test's: either of them means the sheet is up.
        let head = app.staticTexts
            .matching(NSPredicate(format: "label IN %@", ["Session finished", "Ended early"]))
            .firstMatch
        XCTAssertTrue(head.waitForExistence(timeout: 20), "the finish sheet never presented")
        let keep = ["Keep it", "Just keep the session", "Done"]
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

    // The second session named nothing, so it is thrown away rather than left standing in front of
    // whatever runs next.
    private func leaveTheSessionUnstarted() {
        app.navigationBars.buttons["Finish"].tap()
        XCTAssertTrue(app.buttons["Discard session"].waitForExistence(timeout: 20),
                      "an empty session offered no way to throw it away")
        let discard = theSheetsDiscard
        XCTAssertNotNil(discard, "the finish sheet's own discard is not reachable")
        discard?.tap()
        XCTAssertFalse(app.staticTexts["Discard this session?"].exists,
                       "the discard still asks a question the undo window replaced")
        waitOutTheWindow()
        // The discard drops the room back onto its tabs — on the log's own root, since the screen the
        // sheet stood over was the session it just deleted.
        XCTAssertTrue(app.buttons["Coach"].waitForExistence(timeout: 20),
                      "the discard did not put the room back on its tabs")
    }
}
