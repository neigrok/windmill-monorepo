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

    // Exactly one dismissal per state. An ordinary session’s sheet carries a toolbar `Done` and
    // nothing else — the card’s `Just keep the session` and the drawn `Done` are both off it — while a
    // session that ended early keeps `Keep it`, the affirmative half of a decided pair, and draws no
    // toolbar action at all.
    //
    // Four working sets is what makes a session ordinary (`LocalLog.slightWorkingSets`), and a session
    // with no routine and a working set in it is the one the keep-as-routine card is offered on — so
    // this walk reaches the state the toolbar `Done` was drawn for.
    func testAnOrdinarySessionIsDismissedByOneToolbarDoneAndNothingElse() {
        XCTAssertTrue(app.buttons["Just start logging"].waitForExistence(timeout: 20),
                      "the routines home never drew its reach band")
        app.buttons["Just start logging"].tap()
        XCTAssertTrue(app.staticTexts["What are you starting with?"].waitForExistence(timeout: 20),
                      "the logger never opened")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back Squat")).firstMatch.tap()

        logWorkingSets(4)

        app.navigationBars.buttons["Finish"].tap()
        XCTAssertTrue(app.staticTexts["Session finished"].waitForExistence(timeout: 20),
                      "four working sets did not close as an ordinary session")

        let done = app.navigationBars.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10), "the sheet drew no way out of its own")
        XCTAssertFalse(app.buttons["Just keep the session"].exists,
                       "the keep-as-routine card still draws a second dismissal")
        XCTAssertFalse(app.buttons["Keep it"].exists,
                       "the ordinary session drew the slight session’s affirmative")
        XCTAssertTrue(app.buttons["Save routine"].exists,
                      "this session was never offered as a routine, so the state is not the one under test")

        done.tap()
        XCTAssertFalse(app.staticTexts["Session finished"].exists, "the toolbar Done dismissed nothing")

        discardTheKeptSession()
    }

    // The keep-as-routine card's Save is grey while the name is empty, and it says why in the routine
    // editor's own sentence. The name is a `@State` on the sheet, so this is the only place the drawn
    // sentence can be reached — a hosting test can host the card but cannot empty its field.
    func testEmptyingTheRoutineNameSaysWhySaveIsGrey() {
        XCTAssertTrue(app.buttons["Just start logging"].waitForExistence(timeout: 20),
                      "the routines home never drew its reach band")
        app.buttons["Just start logging"].tap()
        XCTAssertTrue(app.staticTexts["What are you starting with?"].waitForExistence(timeout: 20),
                      "the logger never opened")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back Squat")).firstMatch.tap()

        logWorkingSets(4)

        app.navigationBars.buttons["Finish"].tap()
        let save = app.buttons["Save routine"]
        XCTAssertTrue(save.waitForExistence(timeout: 20),
                      "this session was never offered as a routine, so the state is not the one under test")

        // Seeded with the weekday where the view is built, so the card refuses nothing on the frame
        // it appears on.
        let refusal = app.staticTexts["Name it to save it."]
        XCTAssertFalse(refusal.exists, "the card refuses a name it filled in itself")
        XCTAssertTrue(save.isEnabled)

        let name = app.textFields["Routine name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10), "the routine name field says nothing it is")
        name.tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 20))

        XCTAssertTrue(refusal.waitForExistence(timeout: 10),
                      "Save went grey and the card never said why")
        XCTAssertFalse(save.isEnabled, "a routine with no name is savable")

        name.typeText("Tuesday")
        XCTAssertTrue(save.isEnabled, "a named routine is still refused")
        XCTAssertFalse(refusal.exists, "the refusal outlived the thing it was refusing")

        app.navigationBars.buttons["Done"].tap()
        discardTheKeptSession()
    }

    // The keep is the one thing this receipt does that WRITES, so it is the one thing the receipt owes
    // an answer for: the form is gone once the log has taken the routine and the room's own note line
    // is behind the sheet, which leaves one sentence where the form was — Android's words, to the byte.
    // The name is a `@State` on the sheet and the keep is the room's, so a hosting test can host this
    // state but cannot arrive at it: only a real touch does.
    func testAKeptRoutineIsConfirmedWhereItsFormStood() {
        XCTAssertTrue(app.buttons["Just start logging"].waitForExistence(timeout: 20),
                      "the routines home never drew its reach band")
        app.buttons["Just start logging"].tap()
        XCTAssertTrue(app.staticTexts["What are you starting with?"].waitForExistence(timeout: 20),
                      "the logger never opened")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back Squat")).firstMatch.tap()

        logWorkingSets(4)

        app.navigationBars.buttons["Finish"].tap()
        let save = app.buttons["Save routine"]
        XCTAssertTrue(save.waitForExistence(timeout: 20),
                      "this session was never offered as a routine, so the state is not the one under test")

        // The seeded weekday is read off the field rather than spelled again here: what the sentence
        // has to say back is whatever name the keep went out under.
        let seeded = app.textFields["Routine name"].value as? String ?? ""
        XCTAssertFalse(seeded.isEmpty, "the card was offered with no name in it")

        save.tap()

        XCTAssertTrue(app.staticTexts["Kept as \(seeded)."].waitForExistence(timeout: 20),
                      "the receipt took the routine and said nothing about it")
        XCTAssertFalse(save.exists, "the form outlived the keep it answered")

        app.navigationBars.buttons["Done"].tap()
        discardTheKeptSession()

        XCTAssertTrue(app.tabBars.buttons["Routines"].waitForExistence(timeout: 20),
                      "the room drew no way back to the routines list")
        app.tabBars.buttons["Routines"].tap()
        deleteTheKeptRoutine(named: seeded)
    }

    // The counter over the weight names the set the NEXT tap will log (`LiveLines.counter`), so each
    // tap is waited out by name rather than counted. Four working sets is exactly the line between a
    // slight session and an ordinary one (`LocalLog.slightWorkingSets`), so a tap the run drops would
    // otherwise flip the branch these walks are about.
    private func logWorkingSets(_ wanted: Int) {
        let logSet = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Log set")).firstMatch
        XCTAssertTrue(logSet.waitForExistence(timeout: 15), "the logger drew no Log set")
        for set in 1...wanted {
            let next = app.staticTexts["set \(set + 1)"]
            logSet.tap()
            if next.waitForExistence(timeout: 6) { continue }
            // A dropped tap is the harness, not the thing under test: one retry, and only then red.
            logSet.tap()
            XCTAssertTrue(next.waitForExistence(timeout: 10),
                          "set \(set) never landed — the logger stayed on set \(set)")
        }
    }

    // The sheet was dismissed onto the session it closed, and that screen draws a discard of its own —
    // so this test takes its own fixture back off the shelf.
    private func discardTheKeptSession() {
        let discard = app.buttons["Discard session"]
        XCTAssertTrue(discard.waitForExistence(timeout: 20),
                      "the sheet did not leave the lifter on the session it closed")
        discard.tap()
        waitOutTheWindow()
    }

    // A kept routine outlives the run that made it — the log has it — so this test takes its own
    // fixture back off the shelf rather than leaving one standing in front of every later run. Every
    // card of that name goes: a walk that crashed after the keep leaves one behind.
    private func deleteTheKeptRoutine(named name: String) {
        let cards = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name))
        XCTAssertTrue(cards.firstMatch.waitForExistence(timeout: 20), "the kept routine is not on the list")
        for _ in 0..<3 where cards.firstMatch.exists {
            cards.firstMatch.swipeLeft()
            let delete = app.buttons["Delete"]
            XCTAssertTrue(delete.waitForExistence(timeout: 10), "the routine row revealed no Delete")
            delete.tap()
            waitOutTheWindow()
        }
        XCTAssertFalse(cards.firstMatch.exists, "the fixture routine is still on the list")
    }

    // The transient retires with the last clock, and only then has the discard actually happened.
    private func waitOutTheWindow() {
        let undo = app.buttons["Undo"]
        guard undo.exists else { return }
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: undo)
        waitForExpectations(timeout: 25)
    }
}
