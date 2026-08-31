import XCTest

// The undo window, driven on a real simulator, because the dangerous half of this is geometry and
// navigation and neither can be read off the source. Four facts are load-bearing:
//
//   · two deletes in one second BOTH restore — the window is a list, never a slot;
//   · swipe, then press back, does not destroy the row — leaving keeps the window;
//   · a full swipe does nothing — the fastest possible gesture is not a delete;
//   · the transient grows no inset — `Log set` is pressed five to forty times a session.
final class RoomUndoWindowUITests: XCTestCase {
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

    // The one this wave must not ship wrong: a second delete settling the first would make a swipe
    // on a row an unrecoverable delete.
    func testTwoDeletesInOneSecondBothRestore() {
        logTwoSetsAndKeepTheSession()

        let five = row("20 × 5")
        let six = row("20 × 6")
        XCTAssertTrue(five.waitForExistence(timeout: 20), "the finished session drew no first set")
        XCTAssertTrue(six.exists, "the finished session drew no second set")

        swipeToDelete(five)
        swipeToDelete(six)

        XCTAssertTrue(app.staticTexts["2 deleted."].waitForExistence(timeout: 5),
                      "the transient does not say a second delete is being held")
        XCTAssertFalse(five.exists)
        XCTAssertFalse(six.exists)

        app.buttons["Undo"].tap()
        XCTAssertTrue(six.waitForExistence(timeout: 5), "the newest was not the one restored")
        XCTAssertTrue(app.staticTexts["20 × 5 is out of the log."].waitForExistence(timeout: 5),
                      "the transient did not re-read for the delete still held")

        app.buttons["Undo"].tap()
        XCTAssertTrue(five.waitForExistence(timeout: 5), "the first delete was settled by the second")
        XCTAssertFalse(app.buttons["Undo"].exists, "and the transient retires with the last clock")
    }

    // Swipe, then press back: two entirely ordinary actions, and between them the window has to live.
    func testSwipeThenBackDoesNotDestroyTheRow() {
        logTwoSetsAndKeepTheSession()

        let five = row("20 × 5")
        XCTAssertTrue(five.waitForExistence(timeout: 20), "the finished session drew no set")
        swipeToDelete(five)
        XCTAssertTrue(app.staticTexts["20 × 5 is out of the log."].waitForExistence(timeout: 5))

        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["Undo"].waitForExistence(timeout: 5),
                      "leaving the screen took the window with it")

        // It floats over the reach band, never under the platform's own bar.
        let bar = app.tabBars.firstMatch
        XCTAssertTrue(bar.exists, "the room drew no tab bar to measure against")
        XCTAssertLessThanOrEqual(app.buttons["Undo"].frame.maxY, bar.frame.minY + 1,
                                 "the transient is drawn under the tab bar")

        app.buttons["Undo"].tap()
        openTheNewestSession()
        XCTAssertTrue(five.waitForExistence(timeout: 10), "the row did not come back")
    }

    // No full swipe: carried all the way through, the stroke reveals and waits.
    func testAFullSwipeDeletesNothing() {
        logTwoSetsAndKeepTheSession()

        let five = row("20 × 5")
        XCTAssertTrue(five.waitForExistence(timeout: 20), "the finished session drew no set")

        let from = five.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
        let to = five.coordinate(withNormalizedOffset: CGVector(dx: -0.6, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: to)

        XCTAssertTrue(five.exists, "a full swipe deleted the row without a second tap")
        XCTAssertFalse(app.buttons["Undo"].exists, "and nothing was withheld either")
        XCTAssertTrue(app.buttons["Delete"].exists, "the stroke revealed the action and waited")
    }

    // The transient floats OVER the reach band. `Log set` may not move when a window opens, and may
    // not move back when it closes.
    func testTheTransientNeverMovesTheLogSetButton() {
        startASessionOnOneMovement()

        let logSet = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Log set")).firstMatch
        XCTAssertTrue(logSet.waitForExistence(timeout: 15), "the logger drew no Log set")
        let closed = settled(logSet)
        logSet.tap()

        let undo = app.buttons["Undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5), "logging a set opened no window")
        let whileOpen = settled(logSet)
        XCTAssertEqual(whileOpen, closed, "the reach band moved when a window opened")
        XCTAssertLessThanOrEqual(undo.frame.maxY, whileOpen.maxY + 1,
                                 "the transient is drawn below the reach band, not over it")

        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: undo)
        waitForExpectations(timeout: 20)

        XCTAssertEqual(settled(logSet), closed, "the reach band jumped when the window closed")
        // A session left open sends the next launch straight into the logger, where there is no tab
        // bar to find: this test closes what it opened.
        finishAndKeep()
    }

    // The menu holds two. Discard was withheld from it only "until the withheld delete exists", and
    // it does now — so the condition has fired and no `⋮` is drawn on the row to carry it instead.
    func testTheSessionRowsMenuHoldsShareAndDiscard() {
        logTwoSetsAndKeepTheSession()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        openTheRowsMenu()

        XCTAssertEqual(menuItems(), ["Share this workout", "Discard session"],
                       "the menu is not exactly these two, in this order")
        XCTAssertFalse(app.buttons["Delete"].exists, "a delete is a discard here, said in one word")
    }

    // Through the menu it withholds exactly as the review screen's own Discard does: same nine
    // seconds, same transient, same undo — which is the whole reason the menu may carry it.
    func testDiscardingFromTheMenuIsWithheldAndTakenBack() {
        logTwoSetsAndKeepTheSession()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Counted off the log's own head, not off the drawn rows: the simulator keeps whatever
        // earlier runs logged, every one of those rows reads `Session · no routine`, and a `List`
        // only puts the rows it is drawing into the hierarchy.
        XCTAssertTrue(sessionRow.waitForExistence(timeout: 15), "the log drew no session row")
        let before = sessionsLoaded()
        XCTAssertNotNil(before, "the log's head does not say how much it holds")

        openTheRowsMenu()
        app.buttons["Discard session"].tap()

        XCTAssertTrue(app.staticTexts["Session deleted."].waitForExistence(timeout: 5),
                      "discarding from the menu raised no transient")
        XCTAssertTrue(app.buttons["Undo"].exists, "and offered no way back")
        XCTAssertTrue(logHolds(before! - 1), "the session is still on a log it has left")

        app.buttons["Undo"].tap()
        XCTAssertTrue(logHolds(before!), "the session never came back")
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Undo"])
        waitForExpectations(timeout: 5)
    }

    // Law 1 · the long press is the gesture twin, and a gesture may never be the ONLY way to an
    // action — so the session review screen draws the act itself, as web and Android already do. It
    // is the same window, the same transient and the same undo as every other door into it.
    func testTheReviewScreenDrawsDiscardAndWithholdsLikeEveryOtherDoor() {
        logTwoSetsAndKeepTheSession()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        XCTAssertTrue(sessionRow.waitForExistence(timeout: 15), "the log drew no session row")
        let before = sessionsLoaded()
        XCTAssertNotNil(before, "the log's head does not say how much it holds")
        openTheNewestSession()

        let discard = app.buttons["Discard session"]
        XCTAssertTrue(discard.waitForExistence(timeout: 20),
                      "the review screen draws no Discard, so the long press is the only way to it")
        if !discard.isHittable { app.swipeUp() }
        discard.tap()

        // A confirmation on an act that HAS an undo is a tap that buys nothing (Law 2).
        XCTAssertFalse(app.staticTexts["Discard this session?"].exists,
                       "the review screen's discard asks a question it no longer needs to")
        XCTAssertTrue(app.staticTexts["Session deleted."].waitForExistence(timeout: 10),
                      "the review screen's discard raised no transient")
        XCTAssertTrue(app.buttons["Undo"].exists, "and offered no way back")
        XCTAssertTrue(app.navigationBars["The log"].waitForExistence(timeout: 20),
                      "the screen it stood on was the session leaving, so the room unwinds to the log")
        XCTAssertTrue(logHolds(before! - 1), "the session is still on a log it has left")

        app.buttons["Undo"].tap()
        XCTAssertTrue(logHolds(before!), "the session never came back")
    }

    // Swipe, switch apps, come back. The window is the room's and the room is not on screen, so what
    // was held is let go rather than sent — otherwise two ordinary actions would destroy a row with
    // the way back already gone.
    func testLeavingTheForegroundKeepsTheRowAndSendsNothing() {
        logTwoSetsAndKeepTheSession()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        XCTAssertTrue(sessionRow.waitForExistence(timeout: 15), "the log drew no session row")
        let before = sessionsLoaded()
        XCTAssertNotNil(before, "the log's head does not say how much it holds")

        openTheRowsMenu()
        app.buttons["Discard session"].tap()
        XCTAssertTrue(app.staticTexts["Session deleted."].waitForExistence(timeout: 5),
                      "discarding from the menu raised no transient")
        XCTAssertTrue(logHolds(before! - 1), "the session did not leave the log")

        XCUIDevice.shared.press(.home)
        app.activate()

        XCTAssertTrue(sessionRow.waitForExistence(timeout: 20), "the room never came back")
        XCTAssertTrue(logHolds(before!),
                      "leaving the foreground destroyed the session instead of letting go")
        XCTAssertFalse(app.buttons["Undo"].exists, "the window did not go with the foreground")
        XCTAssertFalse(app.staticTexts["Deleted while you were away."].exists,
                       "nothing happened, so nothing is said about it")
    }

    // MARK: - the ways in

    // The transient animates in and out, so a frame is trusted only once two reads in a row agree.
    private func settled(_ element: XCUIElement) -> CGRect {
        var last = element.frame
        for _ in 0..<25 {
            Thread.sleep(forTimeInterval: 0.15)
            let now = element.frame
            if now == last { return now }
            last = now
        }
        return last
    }

    private func openTheRowsMenu() {
        let session = sessionRow
        XCTAssertTrue(session.waitForExistence(timeout: 15), "the log drew no session row")
        session.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Share this workout"].waitForExistence(timeout: 5),
                      "the row's long press opened no menu")
    }

    // Read off the platter itself, not off the app: the log underneath is still in the hierarchy and
    // would answer for buttons that are not menu items.
    private func menuItems() -> [String] {
        for platter in app.descendants(matching: .collectionView).allElementsBoundByIndex
        where platter.buttons["Share this workout"].exists {
            return platter.buttons.allElementsBoundByIndex.map(\.label)
        }
        XCTFail("no menu platter held the row's actions — \(app.debugDescription)")
        return []
    }

    // `LogWeeks.loaded` — `5 sessions · 1 week loaded`, at the head of the tab. It counts what the
    // log HOLDS rather than what it is drawing, which is the only count a scrolling list cannot lie
    // about, and the singular reads `1 session`.
    private func sessionsLoaded() -> Int? {
        let head = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "loaded")).firstMatch
        guard head.exists else { return nil }
        return Int(head.label.prefix { $0.isNumber })
    }

    // A list redraw is a frame away from the tap that caused it.
    private func logHolds(_ sessions: Int) -> Bool {
        for _ in 0..<25 {
            if sessionsLoaded() == sessions { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    private func row(_ effort: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", effort)).firstMatch
    }

    private func swipeToDelete(_ row: XCUIElement) {
        row.swipeLeft()
        let delete = app.buttons["Delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "the row revealed no Delete")
        delete.tap()
    }

    private func startASessionOnOneMovement() {
        XCTAssertTrue(app.buttons["Just start logging"].waitForExistence(timeout: 20),
                      "the routines home never drew its reach band")
        app.buttons["Just start logging"].tap()
        XCTAssertTrue(app.staticTexts["What are you starting with?"].waitForExistence(timeout: 20),
                      "the logger never opened")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back Squat")).firstMatch.tap()
    }

    // Two sets that read differently, so each row can be named on its own.
    private func logTwoSetsAndKeepTheSession() {
        startASessionOnOneMovement()

        let logSet = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Log set")).firstMatch
        XCTAssertTrue(logSet.waitForExistence(timeout: 15), "the logger drew no Log set")
        logSet.tap()
        app.buttons["One rep more"].tap()
        logSet.tap()

        finishAndKeep()
    }

    private func finishAndKeep() {
        app.navigationBars.buttons["Finish"].tap()
        XCTAssertTrue(app.staticTexts["Session finished"].waitForExistence(timeout: 20)
                      || app.staticTexts["Ended early"].exists,
                      "the finish sheet never presented")
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

    // A session logged with no routine reads `Session · no routine` at the head of its own row.
    private var sessionRow: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "no routine")).firstMatch
    }

    private func openTheNewestSession() {
        XCTAssertTrue(sessionRow.waitForExistence(timeout: 15), "the log drew no session row")
        sessionRow.tap()
    }
}
