import XCTest

// Creating a movement is drawn OVER the picker that opened it and never in place of it
// (`15-the-routine.md`): the picker stays mounted, so Cancel comes back to the rows the lifter was
// looking at with the search they typed still in the field. That is a property of the view's own
// lifetime, which no unit test can see — a picker that is torn down and rebuilt renders the same
// empty search field as one that was never opened — so it is asserted with real touches.
//
// Walked from the routine editor, the one door to the picker that needs no open session.
final class RoomPickerCreateUITests: XCTestCase {
    private var app: XCUIApplication!

    // Matches no name and no alias in the catalogue — the minted fixture below included, which a
    // device keeps — and is never minted itself, so the create door is offered on every run rather
    // than only on the first one.
    private let unmatched = "xqv"
    // Made up per run. A minted movement cannot be un-minted, so a fixed name is offered the create
    // door on a device's first run and never again — after which the walk below would assert only
    // that a row exists, which is a green test that has stopped testing.
    private let minted = "Zzq Test Lift \(Int(Date().timeIntervalSince1970))"

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

    func testCancellingTheCreateStepComesBackToThePickerWithTheSearchStillInIt() {
        openThePicker()
        app.searchFields.firstMatch.tap()
        app.typeText(unmatched)

        let door = createDoor(for: unmatched)
        XCTAssertTrue(door.waitForExistence(timeout: 10),
                      "a query the catalogue does not answer offered no way to mint one")
        door.tap()
        XCTAssertTrue(app.staticTexts["Your movement"].waitForExistence(timeout: 10),
                      "the create step never opened")

        cancelTheCreateStep()

        XCTAssertEqual(app.searchFields.firstMatch.value as? String, unmatched,
                       "cancelling took the search the lifter had just typed with it")
        XCTAssertTrue(createDoor(for: unmatched).waitForExistence(timeout: 10),
                      "the picker did not come back under the finger that cancelled")
    }

    // The other half of the same layering: a mint that lands closes the step AND the picker, and the
    // movement it made is picked — which is what `Create and add` says.
    func testAMintedMovementIsPickedAndTheStepAndThePickerBothClose() {
        openThePicker()
        app.searchFields.firstMatch.tap()
        app.typeText(minted)

        let door = createDoor(for: minted)
        XCTAssertTrue(door.waitForExistence(timeout: 10),
                      "a name the catalogue has never held offered no way to mint one")
        door.tap()
        XCTAssertTrue(app.staticTexts["Your movement"].waitForExistence(timeout: 10),
                      "the create step never opened")

        app.buttons["Barbell"].tap()
        app.buttons["Create and add"].tap()

        XCTAssertTrue(app.textFields["Sets"].waitForExistence(timeout: 20),
                      "the minted movement was not picked into the draft")
        XCTAssertFalse(app.staticTexts["Your movement"].exists, "the create step is still up")
        XCTAssertFalse(app.searchFields.firstMatch.exists, "the picker is still up")
    }

    // MARK: - the ways in

    private func openThePicker() {
        app.navigationBars.buttons["New routine"].tap()
        let add = app.buttons["Add movement"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the editor never opened")
        add.tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10),
                      "the picker never opened")
    }

    private func createDoor(for query: String) -> XCUIElement {
        app.buttons["Create “\(query)”"]
    }

    // The picker draws a `Cancel` of its own in the toolbar behind the step, so the step's is named by
    // the one a thumb can actually reach.
    private func cancelTheCreateStep() {
        let cancel = app.buttons.matching(identifier: "Cancel")
            .allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(cancel, "the create step drew no way out")
        cancel?.tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10),
                      "cancelling did not come back to the picker — the create step took it with it")
    }
}
