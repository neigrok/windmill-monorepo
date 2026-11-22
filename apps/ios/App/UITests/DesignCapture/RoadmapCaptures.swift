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

  // 03.1: an Up next step's page, with its workspace under what it opens and Complete at its foot.
  func testStepUpNext() {
    captureBoard("03.1-roadmap-step-up-next") { look in stepPage(["Read the wind"], look, board: "roadmap-workspace") }
  }

  // 03.2: the same page scrolled to its end: Subtasks, Note and Your links, each the person's alone.
  func testStepWorkspace() {
    captureBoard("03.2-roadmap-step-workspace") { look in
      let app = stepPage(["Read the wind"], look, board: "roadmap-workspace")
      _ = reach(app.buttons["roadmap-add-link"], app)
      return app
    }
  }

  // 03.3: every subtask checked, which the list says under itself once the band that said so has left.
  func testStepSubtasksDone() {
    captureBoard("03.3-roadmap-step-subtasks-done") { look in
      let app = stepPage(["Read the wind"], look, board: "roadmap-workspace")
      app.switches["Check the harbour flag"].tap()
      XCTAssertTrue(app.staticTexts["roadmap-subtasks-done"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForNonExistence(timeout: 15))
      // The list is drawn up until what it says under itself stands clear of Complete.
      let header = app.descendants(matching: .any)["roadmap-step-subtasks"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      header.press(forDuration: 0.1, thenDragTo: header.withOffset(CGVector(dx: 0, dy: -130)))
      return app
    }
  }

  // 03.10: the note on its own screen with the keyboard up, a paragraph added and two words set bold from the Format
  // menu of the system's edit menu, which is paged to it.
  func testStepNote() {
    captureBoard("03.10-roadmap-step-note") { look in
      let app = stepPage(["Read the wind"], look, board: "roadmap-workspace")
      // The page's end brings the note's row clear of Complete.
      _ = reach(app.buttons["roadmap-add-link"], app)
      app.buttons["roadmap-note"].tap()
      let note = app.textViews["roadmap-note-field"]
      XCTAssertTrue(note.waitForExistence(timeout: 10) && app.keyboards.firstMatch.waitForExistence(timeout: 10))
      if app.buttons["Continue"].waitForExistence(timeout: 2) { app.buttons["Continue"].tap() }
      note.typeText("\n\nAsk which way the harbour flag points when the sea breeze fills in.")
      // *dark* and *patches* stand on the field's first line, under the bar.
      for word in [150.0, 205.0] {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: word, dy: app.navigationBars["Note"].frame.maxY + 22)).doubleTap()
        XCTAssertTrue(app.menuItems["Copy"].waitForExistence(timeout: 5))
        app.buttons["Forward"].tap()
        XCTAssertTrue(app.buttons["Format"].waitForExistence(timeout: 5))
        app.buttons["Format"].tap()
        XCTAssertTrue(app.buttons["Bold"].waitForExistence(timeout: 5) && app.buttons["Italic"].exists && !app.buttons["Underline"].exists)
        app.buttons["Bold"].tap()
        XCTAssertTrue(app.buttons["Bold"].waitForNonExistence(timeout: 5))
      }
      // A tap under the words lets go of the selection.
      note.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)).tap()
      return app
    }
  }

  // 03.11: New Link over the page, filled as the board fills it.
  func testStepNewLink() {
    captureBoard("03.11-roadmap-step-new-link") { look in
      let app = stepPage(["Read the wind"], look, board: "roadmap-workspace")
      reach(app.buttons["roadmap-add-link"], app).tap()
      let title = app.textFields["roadmap-link-title"], address = app.textFields["roadmap-link-url"]
      XCTAssertTrue(title.waitForExistence(timeout: 10))
      title.tap()
      title.typeText("Telltale guide")
      address.tap()
      address.typeText("rya.org.uk/telltales")
      XCTAssertTrue(app.buttons["roadmap-link-add"].wait(for: \.isEnabled, toEqual: true, timeout: 5))
      return app
    }
  }

  // 03.14: Add Subtask with the keyboard, the words typed in the row and the foot away.
  func testStepAddingSubtask() {
    captureBoard("03.14-roadmap-step-adding-subtask") { look in
      let app = stepPage(["Read the wind"], look, board: "roadmap-workspace")
      let field = app.textFields["roadmap-add-subtask"]
      field.tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      field.typeText("Ask about the tide table")
      return app
    }
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

  func learnToSail(_ look: Look, board: String = "roadmap-learn-to-sail") -> XCUIApplication {
    let app = launch(board, look)
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    return app
  }

  // The page of the last step named, reached from the Board through a row of each page before it.
  func stepPage(_ steps: [String], _ look: Look, board: String = "roadmap-learn-to-sail") -> XCUIApplication {
    let app = learnToSail(look, board: board)
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

  // 04.3: *Next*'s menu over its bar, the Up next steps in Roadmap Order under their count.
  func testGraphNextMenu() {
    captureBoard("04.3-roadmap-graph-next-menu", settle: 1.5) { look in
      let app = graph(look).app
      app.buttons["roadmap-graph-next"].tap()
      XCTAssertTrue(app.staticTexts["2 up next"].waitForExistence(timeout: 5))
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

  // 04.5: Fit, the whole roadmap alone under the status bar.
  func testGraphFit() {
    captureBoard("04.5-roadmap-graph-fit", settle: 1.5) { look in
      let app = graph(look).app
      app.buttons["roadmap-fit"].tap()
      XCTAssertTrue(app.buttons["roadmap-fit"].waitForNonExistence(timeout: 5))
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

  // 02.5: Find up with *sail*, the matches in their groups and Done open while it holds one.
  func testFindResults() {
    captureBoard("02.5-roadmap-find-results") { look in find("sail", look) }
  }

  // 02.6: Find matching nothing, with a new step of that name.
  func testFindNothing() {
    captureBoard("02.6-roadmap-find-nothing") { look in
      let app = find("reef", look)
      XCTAssertTrue(app.buttons["roadmap-find-new-step"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.6b: Milestone shown, then *Sail solo* made a Learn step from its row's Edit: the filter has nothing to show.
  func testFilterWithNothingToShow() {
    captureBoard("02.6b-roadmap-filter-nothing") { look in
      let app = learnToSail(look)
      filter("Milestone", app)
      app.roadmapStep("Sail solo").press(forDuration: 1)
      XCTAssertTrue(app.buttons["Edit"].waitForExistence(timeout: 5))
      app.buttons["Edit"].tap()
      XCTAssertTrue(app.buttons["roadmap-form-kind"].waitForExistence(timeout: 10))
      app.buttons["roadmap-form-kind"].tap()
      XCTAssertTrue(app.roadmapKind("Learn").waitForExistence(timeout: 5))
      app.roadmapKind("Learn").tap()
      XCTAssertTrue(app.buttons["roadmap-form-commit"].waitForHittable(timeout: 5))
      app.buttons["roadmap-form-commit"].tap()
      XCTAssertTrue(app.buttons["roadmap-clear-filters"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForNonExistence(timeout: 15))
      return app
    }
  }

  // 02.7: the Board's Sort and filter menu over the Board.
  func testSortAndFilterMenu() {
    captureBoard("02.7-roadmap-sort-and-filter") { look in
      let app = learnToSail(look)
      boardTool(app)
      return app
    }
  }

  // 02.8: Learn shown, said in the first row with Clear.
  func testNarrowedToLearn() {
    captureBoard("02.8-roadmap-narrowed-to-learn") { look in
      let app = learnToSail(look)
      filter("Learn", app)
      return app
    }
  }

  // 02.9: View Branch from *Read the wind*'s page.
  func testBranch() {
    captureBoard("02.9-roadmap-branch") { look in
      let app = stepPage(["Read the wind"], look)
      app.buttons["roadmap-step-more"].tap()
      XCTAssertTrue(app.buttons["View Branch"].waitForExistence(timeout: 5))
      app.buttons["View Branch"].tap()
      XCTAssertTrue(app.staticTexts["roadmap-branch"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 02.10: *Tie a bowline* and *Sail a triangle* selected through Select Steps.
  func testSeveralSelected() {
    captureBoard("02.10-roadmap-several-selected") { look in selecting(["Tie a bowline", "Sail a triangle"], look) }
  }

  // 02.10b: Delete 2 Steps asking on itself, with what it costs.
  func testDeleteStepsQuestion() {
    captureBoard("02.10b-roadmap-delete-steps-question") { look in
      let app = selecting(["Tie a bowline", "Sail a triangle"], look)
      app.buttons["roadmap-delete-steps"].tap()
      XCTAssertTrue(app.staticTexts["Delete 2 steps?"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.10c: the two steps deleted and held, the selection ended, Undo in the band.
  func testStepsDeletedHeld() {
    captureBoard("02.10c-roadmap-steps-deleted-held") { look in
      let app = selecting(["Tie a bowline", "Sail a triangle"], look)
      app.buttons["roadmap-delete-steps"].tap()
      let answer = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Delete 2 Steps", "roadmap-delete-steps")).firstMatch
      XCTAssertTrue(answer.waitForExistence(timeout: 5))
      answer.tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10) && app.staticTexts["3 of 6 done"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.11: Recolor's menu of the six kinds over its button.
  func testRecolorMenu() {
    captureBoard("02.11-roadmap-recolor-menu") { look in
      let app = selecting(["Tie a bowline", "Sail a triangle"], look)
      app.buttons["roadmap-recolor"].tap()
      XCTAssertTrue(app.buttons["Plum"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.11b: the two steps moved to Sky, the selection ended, Undo in the band.
  func testRecolored() {
    captureBoard("02.11b-roadmap-recolored") { look in
      let app = selecting(["Tie a bowline", "Sail a triangle"], look)
      app.buttons["roadmap-recolor"].tap()
      XCTAssertTrue(app.buttons["Sky"].waitForExistence(timeout: 5))
      app.buttons["Sky"].tap()
      XCTAssertTrue(app.staticTexts["2 steps recolored"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 02.12: Select All took the roadmap's one starting step: Delete is dimmed and the band says why.
  func testStartingStepCannotGo() {
    captureBoard("02.12-roadmap-starting-step-cannot-go") { look in
      let app = selecting([], look)
      app.buttons["roadmap-select-all"].tap()
      XCTAssertTrue(app.navigationBars["8 Selected"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts["A roadmap keeps one starting step"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.14: the 5,000-step handbook with Up next and Locked folded from their headers and Done opened.
  func testFiveThousandSteps() {
    captureBoard("02.14-roadmap-five-thousand-steps", settle: 1.5) { look in
      let app = launch("roadmap-handbook", look)
      XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 120))
      for group in ["upNext", "locked", "done"] {
        app.buttons["roadmap-group-" + group].tap()
        XCTAssertTrue(app.buttons["roadmap-group-" + group].waitForValue(group == "done" ? "Expanded" : "Collapsed", timeout: 5))
      }
      return app
    }
  }

  // 06.1: Kinds from the title menu, the roadmap's kinds and the hue its steps wear unnamed.
  func testKinds() {
    captureBoard("06.1-roadmap-kinds") { look in kinds(look) }
  }

  // 06.2: Learn's page, its words and the six hues, those other kinds wear dimmed.
  func testAKind() {
    captureBoard("06.2-roadmap-a-kind") { look in kind("Learn", look) }
  }

  // 06.3: Add Kind made Brick and opened it with Name focused.
  func testAddKind() {
    captureBoard("06.3-roadmap-add-kind") { look in
      let app = kinds(look)
      app.buttons["roadmap-kinds-add"].tap()
      XCTAssertTrue(app.navigationBars["Brick"].waitForExistence(timeout: 5) && app.keyboards.firstMatch.waitForExistence(timeout: 10))
      return app
    }
  }

  // 06.4: six kinds, every hue had: Add Kind is gone and the footer says why.
  func testSixKinds() {
    captureBoard("06.4-roadmap-six-kinds") { look in
      let app = kinds(look)
      addKind("Practice", "Hours on the water", app)
      addKind("Safety", "What keeps you afloat", app)
      XCTAssertTrue(app.staticTexts["A roadmap has up to six kinds."].waitForExistence(timeout: 5) && !app.buttons["roadmap-kinds-add"].exists)
      return app
    }
  }

  // 06.5: Edit on, the delete control on the one kind no step wears.
  func testRemovingAKind() {
    captureBoard("06.5-roadmap-removing-a-kind") { look in
      let app = kinds(look)
      addKind("Practice", "Hours on the water", app)
      app.buttons["roadmap-kinds-edit"].tap()
      XCTAssertTrue(app.staticTexts["A kind that steps wear can’t be removed."].waitForExistence(timeout: 5))
      return app
    }
  }

  // 06.5b: Practice removed at once, Undo in the band at the sheet's foot.
  func testKindRemoved() {
    captureBoard("06.5b-roadmap-kind-removed") { look in
      let app = kinds(look)
      addKind("Practice", "Hours on the water", app)
      app.buttons["roadmap-kinds-edit"].tap()
      let practice = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "roadmap-kinds-row", "Practice")).firstMatch
      XCTAssertTrue(practice.waitForExistence(timeout: 5))
      practice.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
      XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
      app.buttons["Delete"].tap()
      XCTAssertTrue(app.staticTexts["Practice removed"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 06.6: Learn moved from Olive to Plum, back on the Board: its steps wear the new hue.
  func testKindRecolored() {
    captureBoard("06.6-roadmap-kind-recolored") { look in
      let app = kind("Learn", look)
      app.buttons["Plum"].tap()
      XCTAssertTrue(app.navigationBars["Learn"].waitForExistence(timeout: 5))
      app.navigationBars["Learn"].buttons.element(boundBy: 0).tap()
      app.buttons["roadmap-kinds-close"].tap()
      XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForHittable(timeout: 10))
      return app
    }
  }

  // 10.6a: the foot's + on a roadmap at its 10,000 steps, refused in the band, and no form.
  func testFullRoadmap() {
    captureBoard("10.6a-roadmap-full-roadmap") { look in
      let app = launch("roadmap-full", look)
      XCTAssertTrue(app.buttons["roadmap-new-step"].waitForHittable(timeout: 240))
      app.buttons["roadmap-new-step"].tap()
      XCTAssertTrue(app.staticTexts["This roadmap is at its limit."].waitForExistence(timeout: 10) && !app.buttons["roadmap-form-commit"].exists)
      return app
    }
  }

  // 10.6b: Build's page, the hues other kinds and the unnamed Sky wear dimmed with whose they are.
  func testHueInUse() {
    captureBoard("10.6b-roadmap-hue-in-use") { look in kind("Build", look) }
  }

  // Find up over *Learn to sail* with words typed.
  func find(_ words: String, _ look: Look) -> XCUIApplication {
    let app = learnToSail(look)
    app.buttons["roadmap-find"].tap()
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5) && app.keyboards.firstMatch.waitForExistence(timeout: 10))
    field.typeText(words)
    XCTAssertTrue(field.waitForValue(words))
    return app
  }

  // The Board's Sort and filter menu, open.
  func boardTool(_ app: XCUIApplication) {
    app.buttons["roadmap-board-tool"].tap()
    XCTAssertTrue(app.buttons["Select Steps"].waitForExistence(timeout: 5))
  }

  // One kind shown, from the Board's tool.
  func filter(_ kind: String, _ app: XCUIApplication) {
    boardTool(app)
    app.buttons[kind].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["roadmap-showing"].waitForExistence(timeout: 5))
  }

  // Select Steps from the Board's tool, then a tap on each step named.
  func selecting(_ steps: [String], _ look: Look) -> XCUIApplication {
    let app = learnToSail(look)
    boardTool(app)
    app.buttons["Select Steps"].tap()
    XCTAssertTrue(app.buttons["roadmap-select-done"].waitForExistence(timeout: 5))
    for step in steps { app.roadmapStep(step).tap() }
    XCTAssertTrue(app.navigationBars["\(steps.count) Selected"].waitForExistence(timeout: 5))
    return app
  }

  // Kinds from the title menu over *Learn to sail*.
  func kinds(_ look: Look) -> XCUIApplication {
    let app = titleMenu(of: "roadmap-learn-to-sail", look)
    app.buttons["Kinds"].tap()
    XCTAssertTrue(app.buttons["roadmap-kinds-add"].waitForExistence(timeout: 5))
    return app
  }

  // A kind's page, pushed inside Kinds.
  func kind(_ name: String, _ look: Look) -> XCUIApplication {
    let app = kinds(look)
    app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "roadmap-kinds-row", name)).firstMatch.tap()
    XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 5))
    return app
  }

  // Add Kind, named and described, and back to Kinds.
  func addKind(_ name: String, _ description: String, _ app: XCUIApplication) {
    app.buttons["roadmap-kinds-add"].tap()
    let field = app.textFields["roadmap-kind-name"]
    XCTAssertTrue(field.waitForExistence(timeout: 5) && app.keyboards.firstMatch.waitForExistence(timeout: 10))
    field.typeText(name)
    app.textFields["roadmap-kind-description"].tap()
    app.textFields["roadmap-kind-description"].typeText(description)
    XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 5))
    app.navigationBars[name].buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "roadmap-kinds-row", name)).firstMatch
      .waitForExistence(timeout: 5))
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
