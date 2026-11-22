import XCTest

// The Roadmap room's boards (Roadmap · iOS): its Board, a step's page, the step form, its roadmaps, and its door on
// Where to start? (Shell 02a).
final class RoadmapCaptures: DesignCapture {
  // 01.1: *Learn to sail* on its Board, as it arrives from its account.
  func testBoardAtRest() {
    captureBoard("01.1-roadmap-board-at-rest", settle: 1.5) { look in
      let app = launch("roadmap-learn-to-sail", look)
      XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 01.12: every step done, Done open by itself under what the Board says of it.
  func testEveryStepDone() {
    captureBoard("01.12-roadmap-every-step-done", settle: 1.5) { look in
      let app = launch("roadmap-all-done", look)
      XCTAssertTrue(app.staticTexts["All 8 steps done"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 02.1: an Up next row slid right shows Complete.
  func testSwipeRightRevealsComplete() {
    captureBoard("02.1-roadmap-swipe-right-complete") { look in
      let app = learnToSail(look)
      app.roadmapStep("Read the wind").swipeRight()
      XCTAssertTrue(app.buttons["Complete"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.2: the step completed, what it unlocked arrived first in Up next, and the band with Undo.
  func testCompleted() {
    captureBoard("02.2-roadmap-completed") { look in
      let app = learnToSail(look)
      app.roadmapStep("Read the wind").swipeRight()
      XCTAssertTrue(app.buttons["Complete"].waitForExistence(timeout: 5))
      app.buttons["Complete"].tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["4 of 8 done"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.3: a row slid left shows Delete.
  func testSwipeLeftRevealsDelete() {
    captureBoard("02.3-roadmap-swipe-left-delete") { look in
      let app = learnToSail(look)
      app.roadmapStep("Tie a bowline").swipeLeft()
      XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.4: the long-press menu of an Up next step.
  func testLongPressMenu() {
    captureBoard("02.4-roadmap-long-press-menu") { look in
      let app = learnToSail(look)
      app.roadmapStep("Read the wind").press(forDuration: 1)
      XCTAssertTrue(app.buttons["Delete Step"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.13: the list at its end with Done opened from its header.
  func testDoneExpanded() {
    captureBoard("02.13-roadmap-done-expanded") { look in
      let app = learnToSail(look)
      let done = app.buttons["roadmap-group-done"]
      app.swipeUp(velocity: .slow)
      XCTAssertTrue(done.waitForHittable(timeout: 5))
      done.tap()
      XCTAssertTrue(done.waitForValue("Expanded", timeout: 5))
      app.swipeUp(velocity: .slow)
      XCTAssertTrue(app.roadmapStep("Choose a sailing course").waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.15: a roadmap with no step yet.
  func testEmptyRoadmap() {
    captureBoard("02.15-roadmap-empty-roadmap") { look in
      let app = launch("roadmap-no-steps", look)
      XCTAssertTrue(app.staticTexts["Your first step"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 03.8, on the Board: the delete question on the row, with what the delete costs.
  func testDeleteQuestion() {
    captureBoard("03.8-roadmap-delete-question") { look in
      let app = learnToSail(look)
      app.roadmapStep("Read the wind").swipeLeft()
      XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
      app.buttons["Delete"].tap()
      XCTAssertTrue(app.staticTexts["Delete Read the wind?"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 03.1: an Up next step's page, with Complete at its foot.
  func testStepUpNext() {
    captureBoard("03.1-roadmap-step-up-next") { look in stepPage(["Read the wind"], look) }
  }

  // 03.4: the step completed in place, the page turned Done with Reset and the band saying what opened.
  func testStepCompletedInPlace() {
    captureBoard("03.4-roadmap-step-completed-in-place") { look in
      let app = stepPage(["Read the wind"], look)
      app.buttons["roadmap-complete"].tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["roadmap-reset"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 03.5: a Locked step's page, whose way through is its Requires rows.
  func testStepLocked() {
    captureBoard("03.5-roadmap-step-locked") { look in stepPage(["Sail solo"], look) }
  }

  // 03.6: a Done step's page, saying what Reset would lock.
  func testStepDone() {
    captureBoard("03.6-roadmap-step-done") { look in stepPage(["Read the wind", "Name the boat parts"], look) }
  }

  // 03.6b: the step reset, Up next again with Complete, what it had opened Locked and the band saying so.
  func testStepReset() {
    captureBoard("03.6b-roadmap-step-reset") { look in
      let app = stepPage(["Read the wind", "Name the boat parts"], look)
      app.buttons["roadmap-reset"].tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["roadmap-complete"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 03.7: a step page's … menu.
  func testStepMenu() {
    captureBoard("03.7-roadmap-step-menu") { look in
      let app = stepPage(["Read the wind"], look)
      app.buttons["roadmap-step-more"].tap()
      XCTAssertTrue(app.buttons["Delete Step"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 03.8: the delete question on the page's … button, with what the delete costs.
  func testStepDeleteQuestion() {
    captureBoard("03.8-roadmap-step-delete-question") { look in
      let app = stepPage(["Read the wind"], look)
      askDelete(app)
      return app
    }
  }

  // 03.9: the step deleted from its page and held, back on the Board with Undo in the band.
  func testDeletedHeld() {
    captureBoard("03.9-roadmap-deleted-held") { look in
      let app = stepPage(["Read the wind"], look)
      askDelete(app)
      app.buttons["Delete Step"].tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["3 of 7 done"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 05.1: New Step filled: Reefing basics, a Learn step that requires Read the wind and opens Leave the dock.
  func testNewStep() {
    captureBoard("05.1-roadmap-new-step") { look in reefingBasics(look) }
  }

  // 05.2: Kind, pushed inside the sheet, on a new draft's Sky.
  func testKind() {
    captureBoard("05.2-roadmap-kind") { look in
      let app = newStep(look)
      app.buttons["roadmap-form-kind"].tap()
      XCTAssertTrue(app.roadmapKind("Learn").waitForExistence(timeout: 5))
      return app
    }
  }

  // 05.3: Requires opened again, what was chosen under Selected and the steps that come after the draft's dimmed.
  func testRequires() {
    captureBoard("05.3-roadmap-requires") { look in
      let app = reefingBasics(look)
      app.buttons["roadmap-form-requires"].tap()
      XCTAssertTrue(app.staticTexts["Selected"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 05.4: Opens, the same list for the steps the draft unlocks.
  func testOpens() {
    captureBoard("05.4-roadmap-opens") { look in
      let app = reefingBasics(look)
      app.buttons["roadmap-form-opens"].tap()
      XCTAssertTrue(app.staticTexts["Selected"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 05.5: Cancel on the changed draft asks once, over Cancel.
  func testDiscardDraft() {
    captureBoard("05.5-roadmap-discard-draft") { look in
      let app = reefingBasics(look)
      app.buttons["roadmap-form-cancel"].tap()
      XCTAssertTrue(app.buttons["Discard"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 05.6a: the name typed and cleared, refused in its section's footer.
  func testRefusalNoName() {
    captureBoard("05.6a-roadmap-refusal-no-name") { look in
      let app = reefingBasics(look)
      let name = app.textFields["roadmap-form-name"]
      name.tap()
      name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 14) + "\n")
      XCTAssertTrue(app.staticTexts["Enter a name for this step."].waitForExistence(timeout: 5))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      return app
    }
  }

  // 05.6b: a tap on the dimmed Leave the dock, named in its group's footer.
  func testRefusalLoop() {
    captureBoard("05.6b-roadmap-refusal-loop") { look in
      let app = reefingBasics(look)
      app.buttons["roadmap-form-requires"].tap()
      XCTAssertTrue(app.roadmapChoice("Leave the dock").waitForExistence(timeout: 5))
      app.roadmapChoice("Leave the dock").tap()
      XCTAssertTrue(app.staticTexts["Leave the dock comes after this step."].waitForExistence(timeout: 5))
      return app
    }
  }

  // 05.7: the step created, shown washed in Locked on the Board, the band holding Undo.
  func testCreated() {
    captureBoard("05.7-roadmap-created") { look in
      let app = reefingBasics(look)
      app.buttons["roadmap-form-commit"].tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.roadmapStep("Reefing basics").waitForExistence(timeout: 5))
      return app
    }
  }

  // 05.8: Edit raised over Read the wind's page.
  func testEditStep() {
    captureBoard("05.8-roadmap-edit-step") { look in
      let app = stepPage(["Read the wind"], look)
      app.buttons["roadmap-step-edit"].tap()
      XCTAssertTrue(app.navigationBars["Edit Step"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 05.10: Description has the keyboard, which the form keeps it above.
  func testKeyboardUp() {
    captureBoard("05.10-roadmap-keyboard-up") { look in
      let app = reefingBasics(look)
      app.descendants(matching: .any)["roadmap-form-description"].tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      return app
    }
  }

  // New Step raised by the foot's + over *Learn to sail*.
  func newStep(_ look: Look) -> XCUIApplication {
    let app = learnToSail(look)
    app.buttons["roadmap-new-step"].tap()
    XCTAssertTrue(app.textFields["roadmap-form-name"].waitForExistence(timeout: 10))
    return app
  }

  // 05.1's draft, back on the form with the keyboard away.
  func reefingBasics(_ look: Look) -> XCUIApplication {
    let app = newStep(look)
    let name = app.textFields["roadmap-form-name"], description = app.descendants(matching: .any)["roadmap-form-description"]
    description.tap()
    description.typeText("How to reduce sail area safely in stronger wind.")
    // The name's return key lets go of the keyboard.
    name.tap()
    name.typeText("Reefing basics\n")
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    app.buttons["roadmap-form-kind"].tap()
    XCTAssertTrue(app.roadmapKind("Learn").waitForExistence(timeout: 5))
    app.roadmapKind("Learn").tap()
    for (list, title, step) in [("roadmap-form-requires", "Requires", "Read the wind"), ("roadmap-form-opens", "Opens", "Leave the dock")] {
      XCTAssertTrue(app.buttons[list].waitForHittable(timeout: 5))
      app.buttons[list].tap()
      XCTAssertTrue(app.roadmapChoice(step).waitForExistence(timeout: 5))
      app.roadmapChoice(step).tap()
      app.leaveRoadmapList(title)
    }
    XCTAssertTrue(app.staticTexts["Lands in Locked · Read the wind isn’t done"].waitForExistence(timeout: 5))
    return app
  }

  func learnToSail(_ look: Look) -> XCUIApplication {
    let app = launch("roadmap-learn-to-sail", look)
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    return app
  }

  // The page of the last step named, reached from the Board through a row of each page before it.
  func stepPage(_ steps: [String], _ look: Look) -> XCUIApplication {
    let app = learnToSail(look)
    for step in steps {
      reach(app.roadmapStep(step), app).tap()
      XCTAssertTrue(app.roadmapStepPage(step))
    }
    return app
  }

  // Delete Step from the page's … menu, up to its question.
  func askDelete(_ app: XCUIApplication) {
    app.buttons["roadmap-step-more"].tap()
    XCTAssertTrue(app.buttons["Delete Step"].waitForExistence(timeout: 5))
    app.buttons["Delete Step"].tap()
    XCTAssertTrue(app.staticTexts["Delete Read the wind?"].waitForExistence(timeout: 5))
  }

  // *Learn to sail* on its Graph, the picture drawn and its captions past their wait.
  func graph(_ look: Look) -> (app: XCUIApplication, canvas: XCUIElement) {
    let app = learnToSail(look)
    app.segmentedControls.buttons["Graph"].tap()
    let canvas = app.descendants(matching: .any)["roadmap-graph"]
    XCTAssertTrue(canvas.waitForExistence(timeout: 10))
    return (app, canvas)
  }

  // 04.1 and S.2: the canvas, as the layout frames the roadmap.
  func testGraphCanvas() {
    captureBoard("04.1-roadmap-graph-canvas", settle: 1.5) { look in graph(look).app }
  }

  // 04.2: a step selected, ringed on the canvas and standing in the band slot. *Read the wind* is seated 92 points
  // right of and 62 under the centre of what the bars leave.
  func testGraphStepSelected() {
    captureBoard("04.2-roadmap-graph-step-selected", settle: 1.5) { look in
      let (app, canvas) = graph(look)
      canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: 92, dy: 62)).tap()
      XCTAssertTrue(app.buttons["roadmap-graph-step"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 04.4: pinched in to one and a half times the opening zoom, the discs grown. A pinch out is as far as XCTest is
  // asked for and a pinch in is not, so the picture is pinched in to the ceiling, 2.94 times, and back out to 1.5.
  func testGraphPinchedIn() {
    captureBoard("04.4-roadmap-graph-pinched-in", settle: 1.5) { look in
      let (app, canvas) = graph(look)
      canvas.pinch(withScale: 6, velocity: 3)
      canvas.pinch(withScale: 0.51, velocity: -1)
      return app
    }
  }

  // 04.7: a roadmap with no step, under the Graph.
  func testGraphEmptyRoadmap() {
    captureBoard("04.7-roadmap-graph-empty-roadmap") { look in
      let app = launch("roadmap-no-steps", look)
      XCTAssertTrue(app.staticTexts["Your first step"].waitForExistence(timeout: 30))
      app.segmentedControls.buttons["Graph"].tap()
      XCTAssertTrue(app.segmentedControls.buttons["Graph"].wait(for: \.isSelected, toEqual: true, timeout: 5))
      return app
    }
  }

  // 01.2: the room capsule's menu, with Roadmap checked.
  func testRoomMenu() {
    for look in Look.both {
      let app = launch("roadmap-learn-to-sail", look)
      XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
      roomMenuOpen("01.2-roadmap-room-menu", look, app, current: "Roadmap")
      app.terminate()
    }
  }

  // 01.3: the title's menu over the Board, the three most recent roadmaps under the open one's checkmark.
  func testTitleMenu() {
    captureBoard("01.3-roadmap-title-menu", settle: 0.6) { look in titleMenu(of: "roadmap-several", look) }
  }

  // 01.4: All Roadmaps past eight, with its search field. The phone was never signed in, so the list has no order a
  // server gave it.
  func testAllRoadmaps() {
    captureBoard("01.4-roadmap-all-roadmaps") { look in
      let app = titleMenu(of: "roadmap-many", look)
      app.buttons["All Roadmaps…"].tap()
      XCTAssertTrue(app.searchFields["Find a roadmap"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 01.6: New Roadmap over the Board.
  func testNewRoadmap() {
    captureBoard("01.6-roadmap-new-roadmap") { look in
      let app = titleMenu(of: "roadmap-several", look)
      app.buttons["New Roadmap"].tap()
      XCTAssertTrue(app.textFields["roadmap-new-name"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 01.9: Rename has turned the bar into the system's field, the name selected.
  func testRenaming() {
    captureBoard("01.9-roadmap-renaming") { look in
      let app = titleMenu(of: "roadmap-several", look)
      app.buttons["Rename"].tap()
      XCTAssertTrue(app.navigationBars.textFields.firstMatch.waitForValue("Learn to sail"))
      return app
    }
  }

  // 01.10: the roadmap's delete question under the title, naming the step of another roadmap that opens it.
  func testDeleteRoadmapQuestion() {
    captureBoard("01.10-roadmap-delete-roadmap-question") { look in askDeleteRoadmap(look) }
  }

  // 01.11: the roadmap deleted and held, the room on the next most recent with Undo in the band.
  func testRoadmapDeletedHeld() {
    captureBoard("01.11-roadmap-deleted-held") { look in
      let app = askDeleteRoadmap(look)
      app.buttons["Delete Roadmap"].tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.navigationBars["Spanish B1"].waitForExistence(timeout: 5))
      return app
    }
  }

  // *Learn to sail* on a board that holds other roadmaps, with its title's menu open.
  func titleMenu(of board: String, _ look: Look) -> XCUIApplication {
    let app = launch(board, look)
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    // The roadmap's name leads the label of the bar's title, which the system reports as a button or as a text.
    app.navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Learn to sail")).firstMatch.tap()
    XCTAssertTrue(app.buttons["All Roadmaps…"].waitForExistence(timeout: 5))
    return app
  }

  // Delete Roadmap from the title's menu, up to its question.
  func askDeleteRoadmap(_ look: Look) -> XCUIApplication {
    let app = titleMenu(of: "roadmap-several", look)
    app.buttons["Delete Roadmap"].tap()
    XCTAssertTrue(app.staticTexts["Delete Learn to sail?"].waitForExistence(timeout: 5))
    return app
  }

  // 01.5: a phone that holds no roadmap.
  func testNoRoadmapYet() {
    captureBoard("01.5-roadmap-no-roadmap-yet") { look in
      let app = launch("roadmap-empty", look)
      XCTAssertTrue(app.staticTexts["No roadmaps yet"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 10.9, in the room: a read of the phone's copy that failed.
  func testCouldNotLoad() {
    captureBoard("10.9-roadmap-could-not-load") { look in
      let app = launch("roadmap-unreadable", look)
      XCTAssertTrue(app.staticTexts["Couldn’t load this roadmap"].waitForExistence(timeout: 30))
      return app
    }
  }

  // Shell 02a: Where to start? with its third door.
  func testRoadmapDoor() {
    captureBoard("02a-where-to-start-roadmap-door", settle: 1.5) { look in
      let app = launch("shell-anonymous", look)
      XCTAssertTrue(app.buttons["open-roadmap"].waitForExistence(timeout: 30))
      return app
    }
  }
}
