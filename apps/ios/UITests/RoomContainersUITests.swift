import XCTest

// The containers the native-idiom wave put under the gym room: a real TabView, one NavigationStack per
// tab with its path owned by the room, and the two shell seats in each root's own bar. None of this can
// be asserted from a unit test — a tab bar and a navigation stack only exist once something renders
// them — so it is asserted here, with real touches on a simulator.
final class RoomContainersUITests: XCTestCase {
    private var app: XCUIApplication!

    private let tabs = ["Routines", "The log", "Coach"]
    private let settingsDoor = "Gym settings"
    private let settingsMark = "how the room behaves at the rack"
    private let capsule = "Switch app"
    private let openLine = "You decide the numbers at the rack."

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

    private func pushGymSettings() {
        let door = app.buttons[settingsDoor]
        XCTAssertTrue(door.waitForExistence(timeout: 20), "the routines home never drew its settings door")
        if !door.isHittable { app.swipeUp() }
        door.tap()
        XCTAssertTrue(app.staticTexts[settingsMark].waitForExistence(timeout: 10),
                      "the settings screen never pushed")
    }

    // Three tabs and no fourth slot: the You seat could not have one in a native tab bar, which is why
    // both shell seats moved into the room's own top bar (ledger `1l`).
    func testTheRoomDrawsThreeTabsAndSeatsBothShellDoorsInEveryRootsOwnBar() {
        for tab in tabs {
            app.tabBars.buttons[tab].tap()
            XCTAssertTrue(app.navigationBars.buttons[capsule].waitForExistence(timeout: 10),
                          "\(tab) has no capsule in its own bar")
            XCTAssertTrue(app.navigationBars.buttons["You"].exists, "\(tab) has no You seat in its bar")
            XCTAssertEqual(app.buttons.matching(identifier: capsule).count, 1,
                           "the shell laid a second capsule over a room that hosts its own top chrome")
        }
        XCTAssertEqual(app.tabBars.buttons.count, 3, "a native tab bar has no fourth slot to jam a seat into")
    }

    // The hand-off defect the D1 prover left: every pushed screen drew its own heading underneath the
    // navigation bar's title, so `Gym` appeared twice on the settings screen.
    func testAPushedScreenDrawsItsTitleOnceAndOnlyInTheBar() {
        pushGymSettings()

        XCTAssertTrue(app.navigationBars["Gym"].exists, "the pushed screen has no title in its bar")
        XCTAssertFalse(app.scrollViews.staticTexts["Gym"].exists,
                       "the screen draws its own heading as well as the bar's")
    }

    // A TabView keeps every tab mounted, so each tab's stack is its own: leaving a tab and coming back
    // lands on the screen it was left on, and never on another tab's.
    func testEachTabKeepsItsOwnStack() {
        pushGymSettings()

        app.tabBars.buttons["The log"].tap()
        XCTAssertTrue(app.navigationBars["The log"].waitForExistence(timeout: 10),
                      "the log tab opened inside another tab's stack")
        XCTAssertFalse(app.staticTexts[settingsMark].exists,
                       "a screen pushed in one tab is drawn in another")

        app.tabBars.buttons["Routines"].tap()
        XCTAssertTrue(app.staticTexts[settingsMark].waitForExistence(timeout: 10),
                      "the routines tab forgot the screen it was left on")
    }

    // Planning work goes to the top chrome and the reach band holds what a lifter does with a bar in
    // their hands (`12-native-idiom.md`).
    func testNewRoutineIsATopBarActionAndJustStartLoggingIsInTheReachBand() {
        XCTAssertTrue(app.navigationBars.buttons["New routine"].waitForExistence(timeout: 10),
                      "New routine is not a toolbar action")

        let band = app.buttons["Just start logging"]
        XCTAssertTrue(band.waitForExistence(timeout: 10), "the reach band holds nothing")
        XCTAssertGreaterThan(band.frame.minY, app.frame.height * 0.54,
                             "the primary is not inside the reach band")
    }

    // The editor's only silent exit was the room's back row. Cancel replaces the chevron, and it asks
    // before it throws an edit away.
    func testTheEditorsCancelAsksBeforeItDiscardsAnEdit() {
        app.navigationBars.buttons["New routine"].tap()
        let cancel = app.navigationBars.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10), "the editor drew no Cancel")
        XCTAssertFalse(app.navigationBars.buttons["Back"].exists,
                       "the system back button is still there, and it cannot be asked a question")

        // Nothing typed is nothing to lose, and nothing to ask about.
        cancel.tap()
        XCTAssertTrue(app.navigationBars["Routines"].waitForExistence(timeout: 10),
                      "Cancel did not leave an untouched draft")
        XCTAssertFalse(app.staticTexts["Discard these edits?"].exists,
                       "an untouched draft was asked about anyway")

        app.navigationBars.buttons["New routine"].tap()
        XCTAssertTrue(cancel.waitForExistence(timeout: 10), "the editor did not reopen")
        app.typeText("Heavy Thursday")
        cancel.tap()
        XCTAssertTrue(app.staticTexts["Discard these edits?"].waitForExistence(timeout: 10),
                      "Cancel threw the edit away without asking")
        XCTAssertTrue(app.staticTexts["Nothing is saved. The routine stays as it was."].exists,
                      "the question does not say what is lost")
        XCTAssertTrue(app.buttons["Keep editing"].exists,
                      "the question draws only the destructive answer")
        app.buttons["Discard"].tap()
        XCTAssertTrue(app.navigationBars["Routines"].waitForExistence(timeout: 10),
                      "Discard did not leave the editor")
    }

    // Clearing sets is what opens a line, and `Routine.cpp:18` refuses a line that names reps or a load
    // without sets. The clear is REFUSED and the field keeps what it held — one of the two moments the
    // two phones used to draw differently (ledger `2l`).
    func testClearingSetsIsRefusedInPlaceAndTheFieldKeepsItsValue() {
        openTheTargetSheet()

        app.textFields["Sets"].tap()
        app.typeText("3")
        app.textFields["Reps"].tap()
        app.typeText("5")

        app.textFields["Sets"].tap()
        app.typeText(XCUIKeyboardKey.delete.rawValue)

        XCTAssertTrue(app.staticTexts["Clear reps and weight first — an open line names neither."]
                        .waitForExistence(timeout: 10),
                      "the clear was allowed to cascade without a word")
        XCTAssertEqual(app.textFields["Sets"].value as? String, "3",
                       "the refused keystroke took the number with it")

        // Clear reps first and the sets field lets go.
        app.textFields["Reps"].tap()
        app.typeText(XCUIKeyboardKey.delete.rawValue)
        app.textFields["Sets"].tap()
        app.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertEqual(app.textFields["Sets"].value as? String, "open",
                       "an emptied sets field does not read as the open line it is")
    }

    // The other way into an open line: the row ARRIVED open and the two other fields still take a
    // number. The refusal is a property of the three fields as they stand, not of the one keystroke
    // that empties sets — otherwise the commit writes `open` and two typed numbers go without a word.
    //
    // The remedy is the opposite of the cleared field's, so the sentence is too: this keystroke LANDED
    // and telling the lifter to clear it would be telling them to abandon what they just asked for.
    func testALineThatArrivedOpenRefusesTypedRepsRatherThanDroppingThem() {
        openTheTargetSheet()
        XCTAssertEqual(app.textFields["Sets"].value as? String, "open",
                       "this fixture is not a line that arrived open")

        app.textFields["Reps"].tap()
        app.typeText("5")

        XCTAssertTrue(app.staticTexts["Name the sets first — an open line names neither."]
                        .waitForExistence(timeout: 10),
                      "a rep target was taken on a line that names no sets, and nothing was said")
        XCTAssertFalse(app.staticTexts["Clear reps and weight first — an open line names neither."].exists,
                       "the lifter is being told to throw away the number they just typed")
        XCTAssertFalse(app.buttons["Set · open"].isEnabled,
                       "the band would have written `open` over the number that was just typed")

        // Clear it and the line is an open line again, with nothing left to drop.
        app.textFields["Reps"].tap()
        app.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertTrue(app.staticTexts[openLine].waitForExistence(timeout: 10),
                      "an open line stopped saying what open means")
        XCTAssertTrue(app.buttons["Set · open"].isEnabled, "an open line cannot be committed")
    }

    // A load may be band-assisted, so the sign is a number the lifter names — and `.decimalPad` has no
    // key for it. `±` and never a bare `−`, which reads as *decrement* elsewhere in this product.
    func testTheWeightFieldCanNameABandAssistedLoad() {
        openTheTargetSheet()

        app.textFields["Sets"].tap()
        app.typeText("3")
        app.textFields["Weight · kg"].tap()
        app.typeText("20")

        let sign = app.buttons["Flip the sign"]
        XCTAssertTrue(sign.waitForExistence(timeout: 10), "the weight field has no sign control")
        sign.tap()
        XCTAssertEqual(app.textFields["Weight · kg"].value as? String, "-20",
                       "the sign control did not take the load below zero")
        XCTAssertFalse(app.staticTexts["That is not a number yet."].exists,
                       "a band-assisted load is refused as if it were not a number")

        sign.tap()
        XCTAssertEqual(app.textFields["Weight · kg"].value as? String, "20",
                       "the sign control cannot say `back to positive`")
    }

    // Three typed fields and no ladder: the ± ladder is a rack control and stays at the rack.
    func testTheTargetSheetIsThreeTypedFieldsAndNothingElse() {
        openTheTargetSheet()

        for field in ["Sets", "Reps", "Weight · kg"] {
            XCTAssertTrue(app.textFields[field].exists, "\(field) is not a typed field")
        }
        XCTAssertTrue(app.staticTexts["comma or point, both read as a decimal"].exists,
                      "the field does not say it takes a comma")
        XCTAssertTrue(app.staticTexts[openLine].exists,
                      "an open line does not say what open means")

        // C15 · a statement about the whole line belongs ABOVE the three fields, beside `Never
        // logged — these are your numbers.`, and everything drawn UNDER a field is that field's own
        // note. Picking the movement already put an open line in the editor behind the sheet, so
        // that list has its own copy of the sentence: the one being placed here is the one on the
        // sheet, which is the only one the lifter can reach.
        guard let onTheSheet = app.staticTexts
                .matching(NSPredicate(format: "label == %@", openLine))
                .allElementsBoundByIndex.first(where: { $0.isHittable }) else {
            XCTFail("the target sheet drew no open-line sentence of its own")
            return
        }
        XCTAssertLessThan(onTheSheet.frame.maxY, app.textFields["Sets"].frame.minY,
                          "a statement about the line is drawn under the fields it describes")
        XCTAssertGreaterThan(app.staticTexts["comma or point, both read as a decimal"].frame.minY,
                             app.textFields["Weight · kg"].frame.maxY,
                             "the decimal hint left the field whose note it is")
        for gone in ["take it to max", "use last time", "Leave it open"] {
            XCTAssertFalse(app.buttons[gone].exists, "\(gone) survived the cut")
        }
        XCTAssertTrue(app.buttons["Set · open"].exists, "the band does not say what it will write")
    }

    private func openTheTargetSheet() {
        app.navigationBars.buttons["New routine"].tap()
        XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 10))
        app.buttons["Add movement"].tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10))
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back Squat")).firstMatch.tap()
        XCTAssertTrue(app.textFields["Sets"].waitForExistence(timeout: 10),
                      "the target sheet drew no typed fields")
    }

    // `.searchable` replaced the hand-built field, and the empty query shows the six and then the whole
    // catalogue rather than seven rows (ledger `2j`).
    func testThePickerSearchesWithThePlatformsFieldAndOffersMoreThanSevenRows() {
        app.navigationBars.buttons["New routine"].tap()
        XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 10),
                      "the editor drew no Add movement row")
        app.buttons["Add movement"].tap()

        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10),
                      "the picker has no platform search field")
        XCTAssertTrue(app.staticTexts["The six"].exists, "the six are not offered")
        // One label and then a gap: the rest of the catalogue is what everything under the gap
        // plainly is, and a second head for it is a head for `everything else` (C11).
        XCTAssertFalse(app.staticTexts["The whole catalogue"].exists,
                       "the picker still heads the rest of the catalogue")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Front Squat"))
                        .firstMatch.waitForExistence(timeout: 10),
                      "an empty query stops at the six")
    }
}
