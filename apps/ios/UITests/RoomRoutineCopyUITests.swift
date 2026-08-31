import XCTest

// What the routines list, the routine editor, its target sheet and a saved routine's own screen SAY
// once they are drawn: which sentence a lifter is shown, where it sits, how many times it is drawn
// (C1, C19), what the list names and what it leaves to the screen behind it, the two Save refusals
// under the name field (C4), the single refusal a broken target sheet shows (C5), and the number a
// refused clear keeps and selects (C6).
//
// None of it can be asserted from a unit test — a footer, a selection and a sheet over a sheet only
// exist once a screen has been laid out — so it is asserted with real touches on a simulator.
final class RoomRoutineCopyUITests: XCTestCase {
    private var app: XCUIApplication!

    private let openLine = "You decide the numbers at the rack."
    private let nameIt = "Name it to save it."
    private let oneMovement = "A routine is at least one movement."

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

    // C4 · Save is grey and the editor says why, one refusal at a time, under the field the first of
    // the two is fixed in. The twin of Android's `Program.missing(draft)`.
    func testTheEditorSaysWhySaveIsGreyOneRefusalAtATimeUnderTheNameField() {
        app.navigationBars.buttons["New routine"].tap()
        let save = app.navigationBars.buttons["Save"]
        XCTAssertTrue(save.waitForExistence(timeout: 10), "the editor drew no Save")

        XCTAssertTrue(app.staticTexts[nameIt].waitForExistence(timeout: 10),
                      "Save is grey and nothing says why")
        XCTAssertFalse(app.staticTexts[oneMovement].exists, "both refusals are drawn at once")
        XCTAssertFalse(save.isEnabled, "a nameless draft can be saved")

        app.typeText("Heavy Thursday")
        // C8 · a counter is chrome a short name never carries. Fourteen of sixty is not news.
        XCTAssertFalse(app.staticTexts["14/60"].exists, "the counter speaks before it has anything to say")
        XCTAssertTrue(app.staticTexts[oneMovement].waitForExistence(timeout: 10),
                      "a named but empty routine says nothing about what it still needs")
        XCTAssertFalse(app.staticTexts[nameIt].exists, "the answered refusal is still on screen")
        XCTAssertFalse(save.isEnabled, "a routine of no movements can be saved")

        addOpenMovement()
        XCTAssertFalse(app.staticTexts[oneMovement].exists, "the refusal outlived what it refused")
        XCTAssertFalse(app.staticTexts[nameIt].exists)
        XCTAssertTrue(save.isEnabled, "a named routine holding a movement cannot be saved")
    }

    // C1 · once beneath the list, however many rows are open. The `open` in a row's target column is
    // what says WHICH rows they are; the sentence says what that word means, and a list needs it once.
    func testTheOpenSentenceIsDrawnOnceBeneathTheMovementListAndNeverPerRow() {
        app.navigationBars.buttons["New routine"].tap()
        XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 10))
        XCTAssertEqual(sentences(openLine), 0, "an empty routine has no open row to explain")

        addOpenMovement()
        XCTAssertEqual(sentences(openLine), 1, "one open row, one sentence")

        addOpenMovement(named: "Bench Press")
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "open")).count, 2,
                       "both rows read `open` in their target column")
        XCTAssertEqual(sentences(openLine), 1, "two open rows drew the sentence twice")
    }

    // C19 · while a target sheet stands over the editor, the SHEET owns the sentence. The list's copy
    // beneath the movements steps aside for as long as the sheet is up, so the one state a lifter is
    // in is described once — never blessed behind the scrim while it is being refused in front of it.
    func testTheTargetSheetOwnsTheOpenSentenceWhileItStandsOverTheEditor() {
        app.navigationBars.buttons["New routine"].tap()
        XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 10))

        addOpenMovement()
        XCTAssertEqual(sentences(openLine), 1, "one open row beneath the list, one sentence")

        // The row is the way back into its own target sheet.
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back Squat")).firstMatch.tap()
        XCTAssertTrue(app.textFields["Sets"].waitForExistence(timeout: 10),
                      "the movement row is no door back to its target sheet")
        XCTAssertEqual(sentences(openLine), 1,
                       "the sheet says what open means and the list behind it says it again")

        // And the list has it back the moment the sheet goes.
        app.navigationBars["Back Squat"].buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 10),
                      "the target sheet never closed")
        XCTAssertEqual(sentences(openLine), 1,
                       "the sentence left with the sheet that borrowed it")
    }

    // C1 · the other list of a routine's movements: the saved routine's own screen, where the sentence
    // used to be drawn once per open row.
    func testTheRoutineScreenAlsoSaysTheOpenSentenceOnceBeneathItsList() {
        app.navigationBars.buttons["New routine"].tap()
        XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 10))
        app.typeText("Open Thursday")
        addOpenMovement()
        addOpenMovement(named: "Bench Press")
        // A save replaces the editor with the routine's own screen rather than returning to the list.
        app.navigationBars.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["Start workout"].waitForExistence(timeout: 20),
                      "the routine screen never opened")
        XCTAssertTrue(app.navigationBars["Open Thursday"].exists,
                      "this is not the routine that was just saved")

        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "open")).count, 2,
                       "both rows read `open` in their target column")
        XCTAssertEqual(sentences(openLine), 1, "two open rows drew the sentence twice")

        // A saved routine outlives the run that made it — the device keeps it — so this test takes its
        // own fixture back off the shelf rather than leaving one standing in front of every later test.
        deleteTheOpenRoutine()
    }

    // A card is a door and a door does not restate what is behind it: the list names the ROUTINE, and
    // its movements, their targets and the word `open` are read one tap deeper, on the routine's own
    // screen. The list is also where a bare `open` used to be drawn with nothing near it to say what
    // the word meant, since the sentence that explains it belongs to a list OF MOVEMENTS.
    func testTheRoutinesListNamesTheRoutineAndItsMovementsAreNamedOneTapDeeper() {
        app.navigationBars.buttons["New routine"].tap()
        XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 10))
        app.typeText("Listed Thursday")
        addOpenMovement()
        addOpenMovement(named: "Bench Press")
        app.navigationBars.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["Start workout"].waitForExistence(timeout: 20),
                      "the routine screen never opened")

        // A saved routine outlives the launch that made it, so the list is reached by reopening the
        // room on its own root rather than by guessing at a pushed screen's chrome.
        app.terminate()
        app.launch()
        XCTAssertTrue(app.navigationBars["Routines"].waitForExistence(timeout: 20),
                      "the room did not reopen on the routines list")
        XCTAssertTrue(card("Listed Thursday").waitForExistence(timeout: 20),
                      "the saved routine is not on the list")

        for movement in ["Back Squat", "Bench Press"] {
            XCTAssertFalse(card(movement).exists, "the card redraws the movements of the screen it opens")
        }
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "open")).count, 0,
                       "the list draws a target column, and a bare `open` inside it")
        XCTAssertEqual(sentences(openLine), 0,
                       "the list explains a word it does not say")
        // The head counts the program and claims nothing about a session it cannot see: the Routines
        // tab is not even mounted while one is open (the twin of Android's `RoutinesScreenTests`).
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@",
                                                            "nothing running")).count, 0,
                       "the head asserts something about a session it cannot read")
        XCTAssertGreaterThan(app.staticTexts.matching(NSPredicate(format: "label MATCHES %@",
                                                                  "^[0-9]+ routines?$")).count, 0,
                             "the head does not count the program")

        // The same two movements, read where they and their targets belong.
        card("Listed Thursday").tap()
        XCTAssertTrue(app.buttons["Start workout"].waitForExistence(timeout: 20),
                      "the card is not a door to the routine")
        for movement in ["Back Squat", "Bench Press"] {
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", movement))
                            .firstMatch.exists,
                          "the routine's own screen does not name the movements the card gave up")
        }
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "open")).count, 2,
                       "the routine screen lost the target column the list gave up")
        XCTAssertEqual(sentences(openLine), 1, "and the sentence that says what `open` means")

        deleteTheOpenRoutine(named: "Listed Thursday")
    }

    // C5 · one refusal for the sheet, under the field it belongs to, topmost first — never three ways
    // of saying the lifter got it wrong at once.
    func testTheTargetSheetDrawsOneRefusalAtATime() {
        openTheTargetSheet()

        app.textFields["Sets"].tap()
        app.typeText("3")
        app.textFields["Reps"].tap()
        app.typeText("101")
        app.textFields["Weight · kg"].tap()
        app.typeText("501")

        XCTAssertTrue(app.staticTexts["Whole reps, 1 to 100."].waitForExistence(timeout: 10),
                      "the topmost broken field is not the one being talked about")
        XCTAssertFalse(app.staticTexts["Over 500 kg — check the number."].exists,
                       "the sheet refused two fields at once")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Set ·"))
                        .firstMatch.isEnabled)

        app.textFields["Reps"].tap()
        for _ in 0..<3 { app.typeText(XCUIKeyboardKey.delete.rawValue) }
        app.typeText("5")
        XCTAssertTrue(app.staticTexts["Over 500 kg — check the number."].waitForExistence(timeout: 10),
                      "the next refusal down did not take the field's place")
        XCTAssertFalse(app.staticTexts["Whole reps, 1 to 100."].exists)
    }

    // C6 · the refused clear keeps its number AND selects it, so the next digit REPLACES what the
    // lifter has already tried to be rid of instead of appending to it.
    func testARefusedClearSelectsTheValueItKeptSoTheNextDigitReplacesIt() {
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

        app.typeText("4")
        XCTAssertEqual(app.textFields["Sets"].value as? String, "4",
                       "the kept number was not selected, so the next digit was appended to it")
    }

    // MARK: - the ways in

    private func sentences(_ said: String) -> Int {
        app.staticTexts.matching(NSPredicate(format: "label == %@", said)).count
    }

    // A `List` builds its rows lazily, so a row below the fold is not merely unhittable — it is not in
    // the tree at all, and asking whether it exists answers no until the list is scrolled to it.
    private func scrolled(to element: XCUIElement, tries: Int = 6) -> Bool {
        for _ in 0..<tries {
            if element.exists, element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists && element.isHittable
    }

    // Delete left the editor's foot — which sat three screens deep — for the routine row's own
    // trailing swipe, so this walks back to the list and swipes there (`13-gestures.md`).
    private func deleteTheOpenRoutine(named name: String = "Open Thursday") {
        for _ in 0..<3 where !app.navigationBars["Routines"].exists {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        XCTAssertTrue(app.navigationBars["Routines"].waitForExistence(timeout: 20),
                      "the way back to the routines root never opened")
        let row = card(name)
        XCTAssertTrue(scrolled(to: row), "the routines list drew no card for the fixture")
        row.swipeLeft()
        let delete = app.buttons["Delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 10), "the routine row revealed no Delete")
        delete.tap()
        XCTAssertFalse(card(name).exists, "the fixture routine is still there")

        // Withheld for nine seconds, and nothing reaches the shelf until that window closes: this
        // fixture is only really taken back once the transient has retired.
        let undo = app.buttons["Undo"]
        guard undo.exists else { return }
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: undo)
        waitForExpectations(timeout: 25)
    }

    // A routine card's header carries the name, so the card is found — and opened — by its name.
    private func card(_ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    // Adds a movement and commits it as an open line: `Set · open` writes the shape three empty
    // fields describe.
    private func addOpenMovement(named movement: String = "Back Squat") {
        app.buttons["Add movement"].tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10),
                      "the picker never opened")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", movement)).firstMatch.tap()
        let commit = app.buttons["Set · open"]
        XCTAssertTrue(commit.waitForExistence(timeout: 10), "the target sheet never opened")
        commit.tap()
        XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 10),
                      "the target sheet never closed")
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
}
