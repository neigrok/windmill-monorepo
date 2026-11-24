import XCTest

// A step that opens a roadmap (Roadmap · iOS 07.1 to 07.12b, 05.1) on the simulator's nested boards: the pill and the
// page's Roadmap section, going in by the page and by the swipe and coming back, attaching, changing and detaching from
// the page with Undo, a roadmap set in the step form, the odd ends and a subtree, and forking a pasted link first, refused
// with no connection and asking for a sign-in signed out.
@MainActor final class RoadmapNestedFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // A flow that takes a band's Undo launches with every band standing ten minutes (`-band-stands`), so a slow runner
  // cannot outlast one.
  func launch(_ board: String, takingUndo: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board] + (takingUndo ? ["-band-stands", "600"] : [])
    app.launch()
    XCTAssertTrue(app.navigationBars["Become a day skipper"].waitForExistence(timeout: 60))
    return app
  }

  func page(of step: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(app.roadmapStep(step).waitForHittable(timeout: 30), file: file, line: line)
    app.roadmapStep(step).tap()
    XCTAssertTrue(app.roadmapStepPage(step), file: file, line: line)
  }

  // The system's Back on the screen on top, which names the screen under it.
  func back(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    let button = app.navigationBars.firstMatch.buttons.element(boundBy: 0)
    XCTAssertTrue(button.waitForHittable(timeout: 10), file: file, line: line)
    button.tap()
  }

  func roadmapRow(_ app: XCUIApplication) -> XCUIElement { app.buttons["roadmap-step-roadmap"] }

  // A row of the attach list by the roadmap's name.
  func attachRow(_ name: String, in app: XCUIApplication) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "roadmap-attach-row", name)).firstMatch
  }

  // Roadmap · iOS 07.1 to 07.3, 07.1b: *Learn to sail* carries its roadmap's pill; its page says how far that roadmap is
  // and what completes the step, and Open Roadmap pushes the roadmap's Board, whose Back returns to the page; on the Board
  // the row's leading swipe offers Open.
  func testAStepThatOpensARoadmapGoesInByItsPageAndItsSwipeAndComesBack() {
    let app = launch("roadmap-nested")
    XCTAssertTrue(app.roadmapStep("Learn to sail").waitForExistence(timeout: 30))
    XCTAssertTrue(app.roadmapStep("Learn to sail").label.contains("Learn to sail · 3 of 8"))
    page(of: "Learn to sail", in: app)
    XCTAssertTrue(app.descendants(matching: .any)["roadmap-step-status"].label.contains("5 to go in Learn to sail"))
    XCTAssertTrue(roadmapRow(app).label.hasPrefix("Learn to sail, 3 of 8 done"))
    XCTAssertEqual(app.staticTexts["roadmap-step-roadmap-rule"].label, "Done when every step in Learn to sail is done.")
    XCTAssertFalse(app.buttons["roadmap-complete"].exists)
    XCTAssertEqual(app.buttons["roadmap-open-roadmap"].label, "Open Roadmap")

    app.buttons["roadmap-open-roadmap"].tap()
    XCTAssertTrue(app.navigationBars["Learn to sail"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.roadmapStep("Read the wind").waitForExistence(timeout: 10) && app.buttons["roadmap-inside-more"].exists)
    XCTAssertFalse(app.buttons["room-menu"].exists)
    back(app)
    XCTAssertTrue(app.roadmapStepPage("Learn to sail"))
    back(app)

    XCTAssertTrue(app.roadmapStep("Learn to sail").waitForHittable(timeout: 10))
    app.roadmapStep("Learn to sail").swipeRight()
    XCTAssertTrue(app.buttons["Open"].waitForExistence(timeout: 5) && !app.buttons["Complete"].exists)
    app.buttons["Open"].tap()
    XCTAssertTrue(app.navigationBars["Learn to sail"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.roadmapStep("Tie a bowline").waitForExistence(timeout: 10))
    back(app)
    XCTAssertTrue(app.buttons["room-menu"].waitForExistence(timeout: 10))
  }

  // Roadmap · iOS 07.6 to 07.10: Attach a Roadmap lists the person's roadmaps, the one the step stands in dimmed; a choice
  // attaches at once and pops with Undo; a Done mark is set aside and back on Detach, which asks nothing; and Change
  // Roadmap's list checks the roadmap in use under None, whose footer says what stays.
  func testARoadmapIsAttachedChangedAndDetachedFromTheStepPageEachWithUndo() {
    let app = launch("roadmap-nested", takingUndo: true)
    let undo = app.buttons["roadmap-undo"]
    XCTAssertTrue(app.buttons["roadmap-group-done"].waitForHittable(timeout: 30))
    app.buttons["roadmap-group-done"].tap()
    app.collectionViews.firstMatch.swipeUp()
    page(of: "Pass the first-aid course", in: app)
    XCTAssertFalse(roadmapRow(app).exists)
    app.buttons["roadmap-step-more"].tap()
    XCTAssertTrue(app.buttons["Attach a Roadmap"].waitForExistence(timeout: 5))
    app.buttons["Attach a Roadmap"].tap()
    XCTAssertTrue(app.navigationBars["Roadmap"].waitForExistence(timeout: 10))
    XCTAssertTrue(attachRow("Spanish B1", in: app).waitForExistence(timeout: 10))
    XCTAssertFalse(attachRow("Become a day skipper", in: app).isEnabled)
    XCTAssertTrue(attachRow("Become a day skipper", in: app).label.contains("This roadmap"))
    XCTAssertFalse(app.buttons["roadmap-attach-none"].exists)
    attachRow("Spanish B1", in: app).tap()

    XCTAssertTrue(app.roadmapStepPage("Pass the first-aid course"))
    XCTAssertTrue(undo.waitForExistence(timeout: 10) && app.staticTexts["Roadmap attached"].exists)
    XCTAssertTrue(roadmapRow(app).waitForExistence(timeout: 10) && roadmapRow(app).label.hasPrefix("Spanish B1"))
    XCTAssertTrue(app.staticTexts["roadmap-step-roadmap-rule"].label.hasSuffix("Your Done mark is set aside while it opens a roadmap."))
    undo.tap()
    XCTAssertTrue(roadmapRow(app).waitForNonExistence(timeout: 10))

    back(app)
    page(of: "Learn to sail", in: app)
    app.buttons["roadmap-step-roadmap-more"].tap()
    XCTAssertTrue(app.buttons["Change Roadmap"].waitForExistence(timeout: 5) && app.buttons["Detach Roadmap"].exists)
    app.buttons["Change Roadmap"].tap()
    XCTAssertTrue(app.buttons["roadmap-attach-none"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Learn to sail stays. This step becomes ordinary."].exists)
    XCTAssertTrue(attachRow("Learn to sail", in: app).isSelected)
    app.buttons["roadmap-attach-none"].tap()
    XCTAssertTrue(app.roadmapStepPage("Learn to sail"))
    XCTAssertTrue(app.staticTexts["Roadmap detached"].waitForExistence(timeout: 10))
    XCTAssertTrue(roadmapRow(app).waitForNonExistence(timeout: 10) && app.buttons["roadmap-complete"].exists)
    undo.tap()
    XCTAssertTrue(roadmapRow(app).waitForExistence(timeout: 10))
  }

  // Roadmap · iOS 05.1, 07.6: New Step's Roadmap row pushes the attach list, whose choice sets the draft and pops; Create
  // writes the step with its roadmap, and its Board row carries the pill.
  func testANewStepOpensTheRoadmapChosenInItsForm() {
    let app = launch("roadmap-nested")
    XCTAssertTrue(app.buttons["roadmap-new-step"].waitForHittable(timeout: 30))
    app.buttons["roadmap-new-step"].tap()
    let name = app.textFields["roadmap-form-name"], row = app.buttons["roadmap-form-roadmap"]
    XCTAssertTrue(name.waitForExistence(timeout: 10))
    name.tap()
    name.typeText("Sail at night")
    XCTAssertTrue(row.label.hasSuffix("None"))
    row.tap()
    XCTAssertTrue(attachRow("Learn to sail", in: app).waitForExistence(timeout: 10))
    attachRow("Learn to sail", in: app).tap()
    XCTAssertTrue(row.waitForLabel("Roadmap, Learn to sail"))
    app.buttons["roadmap-form-commit"].tap()
    XCTAssertTrue(app.staticTexts["Sail at night added · Up next"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.roadmapStep("Sail at night").waitForExistence(timeout: 10))
    XCTAssertTrue(app.roadmapStep("Sail at night").label.contains("Learn to sail · 3 of 8"))
  }

  // Roadmap · iOS 07.5a to 07.5d: three Up next steps each open an odd end, which their pills say short; the one that
  // cannot be found offers Choose Roadmap, which pushes the attach list.
  func testTheOddEndsReadAsTheBoardsDrawThem() {
    let app = launch("roadmap-nested-odd")
    XCTAssertTrue(app.roadmapStep("Night passage").waitForExistence(timeout: 30))
    XCTAssertTrue(app.roadmapStep("Learn to sail").label.contains("Loops back"))
    XCTAssertTrue(app.roadmapStep("Night passage").label.contains("Night sailing · No steps"))
    XCTAssertTrue(app.roadmapStep("Log 100 miles").label.contains("Not found"))
    page(of: "Night passage", in: app)
    XCTAssertEqual(app.staticTexts["roadmap-step-roadmap-rule"].label, "A roadmap with no steps isn’t done. Add its first.")
    back(app)
    page(of: "Log 100 miles", in: app)
    XCTAssertEqual(app.buttons["roadmap-open-roadmap"].label, "Choose Roadmap")
    app.buttons["roadmap-open-roadmap"].tap()
    XCTAssertTrue(app.navigationBars["Roadmap"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["roadmap-attach-none"].exists)
  }

  // Roadmap · iOS 07.11, 07.11b: a step that owns a subtree names it under Subtree with no … menu, and Open Subtree pushes
  // its Board, whose … menu holds its own verbs.
  func testASubtreeIsGoneIntoFromItsStep() {
    let app = launch("roadmap-nested-subtree")
    page(of: "Night passage", in: app)
    XCTAssertTrue(roadmapRow(app).label.hasPrefix("Night passage, 1 of 5 done"))
    XCTAssertFalse(app.buttons["roadmap-step-roadmap-more"].exists)
    XCTAssertEqual(app.staticTexts["roadmap-step-roadmap-rule"].label, "Done when every step in this subtree is done.")
    app.buttons["roadmap-open-roadmap"].tap()
    XCTAssertTrue(app.navigationBars["Night passage"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.roadmapStep("Fit the navigation lights").waitForExistence(timeout: 10))
    app.buttons["roadmap-inside-more"].tap()
    XCTAssertTrue(app.buttons["Kinds"].waitForExistence(timeout: 5) && app.buttons["Activity"].exists)
    XCTAssertFalse(app.buttons["Rename"].exists || app.buttons["Delete Roadmap"].exists)
  }

  // Roadmap · iOS 07.7, 07.12a: a pasted link to someone else's roadmap stands above the person's own with Fork Roadmap,
  // which with no connection says so in the band and writes nothing.
  func testForkingFirstWithNoConnectionSaysSo() {
    let app = launch("roadmap-nested-offline")
    page(of: "Log 100 miles", in: app)
    app.buttons["roadmap-step-more"].tap()
    XCTAssertTrue(app.buttons["Attach a Roadmap"].waitForExistence(timeout: 5))
    app.buttons["Attach a Roadmap"].tap()
    XCTAssertTrue(app.buttons["roadmap-attach-paste"].waitForHittable(timeout: 10))
    app.buttons["roadmap-attach-paste"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["roadmap-attach-pasted"].waitForExistence(timeout: 30))
    XCTAssertTrue(app.staticTexts["Someone else’s roadmap? Fork it first — the copy is yours."].exists)
    let fork = app.buttons["roadmap-attach-fork"]
    XCTAssertTrue(fork.waitForHittable(timeout: 10) && fork.label == "Fork Roadmap")
    fork.tap()
    XCTAssertTrue(app.staticTexts["Forking needs a connection."].waitForExistence(timeout: 10))
    XCTAssertFalse(attachRow("Reefing course", in: app).exists)
  }

  // Roadmap · iOS 07.12b: signed out, the pasted roadmap's primary is Sign In to Fork, which opens the shell's sign-in.
  func testForkingFirstSignedOutOpensSignIn() {
    let app = launch("roadmap-nested-signed-out")
    page(of: "Log 100 miles", in: app)
    app.buttons["roadmap-step-more"].tap()
    XCTAssertTrue(app.buttons["Attach a Roadmap"].waitForExistence(timeout: 5))
    app.buttons["Attach a Roadmap"].tap()
    XCTAssertTrue(app.buttons["roadmap-attach-paste"].waitForHittable(timeout: 10))
    app.buttons["roadmap-attach-paste"].tap()
    let fork = app.buttons["roadmap-attach-fork"]
    XCTAssertTrue(fork.waitForHittable(timeout: 30) && fork.label == "Sign In to Fork")
    fork.tap()
    XCTAssertTrue(app.staticTexts["Sign in to fork this roadmap."].waitForExistence(timeout: 10))
  }

  // Roadmap · iOS 07.7b: a pasted address with no roadmap the person can read is refused where it was pasted.
  func testAPastedAddressWithNothingThereIsRefusedWhereItWasPasted() {
    let app = launch("roadmap-nested")
    UIPasteboard.general.url = URL(string: "https://windmill.works/t/t_00000000000000fe")
    page(of: "Log 100 miles", in: app)
    app.buttons["roadmap-step-more"].tap()
    XCTAssertTrue(app.buttons["Attach a Roadmap"].waitForExistence(timeout: 5))
    app.buttons["Attach a Roadmap"].tap()
    XCTAssertTrue(app.buttons["roadmap-attach-paste"].waitForHittable(timeout: 10))
    app.buttons["roadmap-attach-paste"].tap()
    XCTAssertTrue(app.staticTexts["No roadmap you can read is at that address."].waitForExistence(timeout: 30))
    XCTAssertFalse(app.buttons["roadmap-attach-fork"].exists)
  }
}
