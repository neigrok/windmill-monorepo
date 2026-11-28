import UIKit
import XCTest

// The Roadmap room's boards (Roadmap · iOS): its Board, a step's page, the step form, its roadmaps, its Guide, a shared
// roadmap's cover and Fork, the account's questions that name its work, and its door on Where to start? (Shell 02a).
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

  // 03.10: the note on its own screen with the keyboard up and a paragraph added; on iOS 26 two words set bold from the
  // Format menu of the system's edit menu, which is paged to it. Before iOS 26 the note edits plain text, whose edit menu
  // has no Format.
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
      guard #available(iOS 26.0, *) else { return app }
      // The edit menu's page turn, which iOS 26 calls Forward and iOS 27 Next Page.
      let nextPage = app.buttons.matching(NSPredicate(format: "label IN %@", ["Forward", "Next Page"])).firstMatch
      // *dark* and *patches* stand on the field's first line, under the bar.
      for word in [150.0, 205.0] {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: word, dy: app.navigationBars["Note"].frame.maxY + 22)).doubleTap()
        XCTAssertTrue(app.menuItems["Copy"].waitForExistence(timeout: 5))
        nextPage.tap()
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

  func learnToSail(_ look: Look, board: String = "roadmap-learn-to-sail", copying copied: String? = nil) -> XCUIApplication {
    let app = launch(board, look, copying: copied)
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

  // 01.6: New Roadmap over the Board, a plan on the clipboard for the system's Paste button.
  func testNewRoadmap() {
    captureBoard("01.6-roadmap-new-roadmap") { look in
      UIPasteboard.general.string = RoadmapFlowTests.summerCruise
      let app = titleMenu(of: "roadmap-several", look)
      app.buttons["New Roadmap"].tap()
      XCTAssertTrue(app.textFields["roadmap-new-name"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 02.16: the foot's + held, its menu offering New Step and Paste Steps.
  func testPlusHeld() {
    captureBoard("02.16-roadmap-plus-held") { look in
      let app = learnToSail(look)
      app.buttons["roadmap-new-step"].press(forDuration: 1.0)
      XCTAssertTrue(app.buttons["Paste Steps"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.16b: Paste Steps over a clipboard that holds no text.
  func testNothingToPaste() {
    captureBoard("02.16b-roadmap-nothing-to-paste") { look in
      UIPasteboard.general.items = []
      let app = learnToSail(look)
      app.pasteSteps()
      XCTAssertTrue(app.staticTexts["No text to paste"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.16c: Paste Steps the person did not allow, with Settings in the band.
  func testPasteNotAllowed() {
    captureBoard("02.16c-roadmap-paste-not-allowed") { look in
      UIPasteboard.general.string = Self.daySail
      let app = learnToSail(look)
      app.pasteSteps(refusing: true)
      XCTAssertTrue(app.staticTexts["Paste not allowed"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.17: the copied list read back over the Board, a heading and the four steps under it.
  func testPastedStepsReadBack() {
    captureBoard("02.17-roadmap-pasted-steps-read-back") { look in
      let app = learnToSail(look, copying: Self.daySail)
      app.pasteSteps()
      XCTAssertTrue(app.navigationBars["Paste Steps"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 02.18: the five steps added, washed in their groups, with Undo in the band.
  func testPastedStepsAdded() {
    captureBoard("02.18-roadmap-pasted-steps-added") { look in
      let app = learnToSail(look, copying: Self.daySail)
      app.pasteSteps()
      XCTAssertTrue(app.buttons["roadmap-paste-add"].waitForExistence(timeout: 10))
      app.buttons["roadmap-paste-add"].tap()
      XCTAssertTrue(app.staticTexts["Added 5 steps"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["3 of 13 done"].waitForExistence(timeout: 5))
      return app
    }
  }

  // The list 02.17 pastes: a heading and the four steps under it.
  static let daySail = "## Day sail\n- Check the forecast\n- Plan the passage\n- Brief the crew\n- Pack the boat"

  // 01.8: the boards' copied plan read back in New Roadmap, named by its first line.
  func testPlanReadBack() {
    captureBoard("01.8-roadmap-plan-read-back") { look in pastedPlan(look) }
  }

  // 01.8b: the plan planted, its Board open under the band that says what it planted.
  func testPlanted() {
    captureBoard("01.8b-roadmap-planted") { look in
      let app = pastedPlan(look)
      app.buttons["roadmap-new-create"].tap()
      XCTAssertTrue(app.staticTexts["Roadmap planted · 12 steps · 2 already done"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["2 of 12 done"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 01.8c: a file the phone could not read, named in Start from's footer.
  func testFileUnreadable() {
    captureBoard("01.8c-roadmap-file-unreadable") { look in
      UIPasteboard.general.string = RoadmapFlowTests.summerCruise
      let app = titleMenu(of: "roadmap-several", look, asking: ["-roadmap-file", "Sailing plan.md"])
      app.buttons["New Roadmap"].tap()
      XCTAssertTrue(app.buttons["roadmap-new-file"].waitForExistence(timeout: 10))
      app.buttons["roadmap-new-file"].tap()
      XCTAssertTrue(app.staticTexts["Couldn’t read “Sailing plan.md”."].waitForExistence(timeout: 5))
      return app
    }
  }

  // New Roadmap over the Board with the boards' plan pasted through the system's Paste button and read back.
  func pastedPlan(_ look: Look) -> XCUIApplication {
    UIPasteboard.general.string = RoadmapFlowTests.summerCruise
    let app = titleMenu(of: "roadmap-several", look)
    app.buttons["New Roadmap"].tap()
    app.pastePlan()
    XCTAssertTrue(app.staticTexts["Pasted plan"].waitForExistence(timeout: 10))
    return app
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

  // A roadmap on a board, *Learn to sail* unless named, with its title's menu open once its Board stands.
  func titleMenu(of board: String, named roadmap: String = "Learn to sail", _ look: Look, asking more: [String] = []) -> XCUIApplication {
    let app = launch(board, look, arguments: more)
    // The roadmap's name leads the label of the bar's title, which the system reports as a button or as a text.
    let title = app.navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", roadmap)).firstMatch
    XCTAssertTrue(title.waitForExistence(timeout: 30))
    title.tap()
    XCTAssertTrue(app.buttons["All Roadmaps…"].waitForExistence(timeout: 5))
    return app
  }

  // Activity from the title menu of a roadmap on a board.
  func activity(of board: String, named roadmap: String = "Learn to sail", _ look: Look) -> XCUIApplication {
    let app = titleMenu(of: board, named: roadmap, look)
    app.buttons["Activity"].tap()
    XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 10))
    return app
  }

  // 01.13: Activity of the account's *Learn to sail*, its completions newest first over the eight steps planted at
  // once, their fold opened. The board's clock stands still, so every row falls on one day.
  func testActivity() {
    captureBoard("01.13-roadmap-activity") { look in
      let app = activity(of: "roadmap-learn-to-sail", look)
      let folded = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Added 8 steps")).firstMatch
      XCTAssertTrue(folded.waitForExistence(timeout: 10))
      folded.tap()
      XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Added Sail solo")).firstMatch.waitForExistence(timeout: 5))
      return app
    }
  }

  // 01.13b: Activity of *Learn to sail* made on a phone never signed in, the steps planted at once folded.
  func testActivitySignedOut() {
    captureBoard("01.13b-roadmap-activity-signed-out") { look in
      let app = activity(of: "roadmap-many", look)
      XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Added 8 steps")).firstMatch
        .waitForExistence(timeout: 10))
      return app
    }
  }

  // 01.15: Activity of *Night sailing*, which has no step.
  func testActivityNothingYet() {
    captureBoard("01.15-roadmap-activity-nothing-yet") { look in
      let app = activity(of: "roadmap-no-steps", named: "Night sailing", look)
      XCTAssertTrue(app.staticTexts["No activity yet"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 03.12: *Read the wind* completed on its page (03.4), then its History from the page's last row once the band has left.
  func testStepHistory() {
    captureBoard("03.12-roadmap-step-history") { look in
      let app = stepPage(["Read the wind"], look)
      app.buttons["roadmap-complete"].tap()
      XCTAssertTrue(app.buttons["roadmap-reset"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForNonExistence(timeout: 15))
      reach(app.buttons["roadmap-step-history"], app).tap()
      XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "roadmap-history-row").firstMatch.waitForExistence(timeout: 10))
      return app
    }
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

  // 01.5b: the room's first read running long, its bar alone and the spinner that shows once it has run half a second.
  func testBeforeTheFirstRead() {
    captureBoard("01.5b-roadmap-before-the-first-read", settle: 0.3) { look in
      let app = launch("roadmap-first-read", look)
      XCTAssertTrue(app.descendants(matching: .any)["roadmap-first-read"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 01.5c: the room's read of the phone's own copy failed.
  func testCouldNotRead() {
    captureBoard("01.5c-roadmap-could-not-read") { look in
      let app = launch("roadmap-unreadable", look)
      XCTAssertTrue(app.staticTexts["The copy on this iPhone couldn’t be read."].waitForExistence(timeout: 30))
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

  // 02.10d: the two steps deleted, and their Undo taken once the engine kept no Undo of their delete: the band says how
  // many could not come back, with no Undo.
  func testStepsUndoBroughtNothingBack() {
    captureBoard("02.10d-roadmap-undo-brought-nothing-back") { look in
      let app = selecting(["Tie a bowline", "Sail a triangle"], look, board: "roadmap-undo-finds-nothing")
      app.buttons["roadmap-delete-steps"].tap()
      let answer = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Delete 2 Steps", "roadmap-delete-steps")).firstMatch
      XCTAssertTrue(answer.waitForExistence(timeout: 5))
      answer.tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      app.buttons["roadmap-undo"].tap()
      XCTAssertTrue(app.staticTexts["Couldn’t bring back 2 steps"].waitForExistence(timeout: 5))
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
      // The board plants the handbook's 5,000 steps before its Board stands; Up next's 170 rows keep Locked's header off
      // the screen until Up next is folded.
      let app = launch("roadmap-handbook", look)
      XCTAssertTrue(app.staticTexts["120 of 5000 done"].waitForExistence(timeout: 120))
      for group in ["upNext", "locked", "done"] {
        XCTAssertTrue(app.buttons["roadmap-group-" + group].waitForHittable(timeout: 10))
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
      // Edit mode draws one delete control, Practice's, the one kind no step wears. iOS 18 reports its symbol twice, inside
      // the control that takes the tap, so the tap goes to the first one's middle.
      let remove = app.images.matching(identifier: "minus.circle.fill").firstMatch
      XCTAssertTrue(remove.waitForExistence(timeout: 5))
      remove.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
      app.buttons["Delete"].tap()
      XCTAssertTrue(app.staticTexts["Practice removed"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 06.5c: Practice removed, and its Undo taken once the engine kept nothing of the removal: the band at the sheet's foot
  // names the kind that could not come back, with no Undo.
  func testKindUndoBroughtNothingBack() {
    captureBoard("06.5c-roadmap-kind-undo-brought-nothing-back") { look in
      let app = kinds(look, board: "roadmap-undo-finds-nothing")
      addKind("Practice", "Hours on the water", app)
      app.buttons["roadmap-kinds-edit"].tap()
      // Edit mode draws one delete control, Practice's, the one kind no step wears. iOS 18 reports its symbol twice, inside
      // the control that takes the tap, so the tap goes to the first one's middle.
      let remove = app.images.matching(identifier: "minus.circle.fill").firstMatch
      XCTAssertTrue(remove.waitForExistence(timeout: 5))
      remove.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
      app.buttons["Delete"].tap()
      // The band stands at the sheet's foot and at the Board's behind it, where it cannot be tapped.
      let undo = app.buttons.matching(identifier: "roadmap-undo")
      XCTAssertTrue(undo.firstMatch.waitForExistence(timeout: 10))
      undo.allElementsBoundByIndex.first { $0.isHittable }?.tap()
      XCTAssertTrue(app.staticTexts["Couldn’t bring back Practice"].waitForExistence(timeout: 5))
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

  // 10.1: offline, Reefing basics just made in the form, in Locked with its receipt, and Offline beside the progress.
  func testOffline() {
    captureBoard("10.1-roadmap-offline") { look in
      let app = launch("roadmap-sync-offline", look, arguments: ["-band-stands", "600"])
      XCTAssertTrue(app.staticTexts["3 of 9 done · Offline"].waitForExistence(timeout: 60))
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 10.2: Reefing basics landed after Read the wind was deleted elsewhere, Up next and washed, the band saying so with Show.
  func testLanded() {
    captureBoard("10.2-roadmap-landed") { look in landed(look) }
  }

  // 10.3: Show opens the landed step's page, its footer under the status row.
  func testLandedStepPage() {
    captureBoard("10.3-roadmap-landed-step-page") { look in
      let app = landed(look)
      app.buttons["roadmap-show"].tap()
      XCTAssertTrue(app.staticTexts["roadmap-step-landed"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 10.4: Reefing basics back where its prerequisites put it, washed, the band saying why with Show.
  func testCameBack() {
    captureBoard("10.4-roadmap-came-back") { look in
      let app = launch("roadmap-sync-came-back", look, arguments: ["-band-stands", "600"])
      XCTAssertTrue(app.buttons["roadmap-show"].waitForExistence(timeout: 60))
      XCTAssertTrue(app.staticTexts["3 of 9 done"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 10.5a: the title menu leading with the two changes set aside.
  func testSetAsideInTheTitleMenu() {
    captureBoard("10.5a-roadmap-set-aside-menu", settle: 1.5) { look in setAside(look) }
  }

  // 10.5b: Set Aside, the two changes under Winter refit with why.
  func testSetAside() {
    captureBoard("10.5b-roadmap-set-aside") { look in
      let app = setAside(look)
      app.buttons["2 Set Aside"].tap()
      XCTAssertTrue(app.navigationBars["Set Aside"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 10.5c: a change's … menu, Copy and Discard.
  func testSetAsideChangeMenu() {
    captureBoard("10.5c-roadmap-set-aside-change-menu", settle: 1.5) { look in
      let app = setAside(look)
      app.buttons["2 Set Aside"].tap()
      XCTAssertTrue(app.navigationBars["Set Aside"].waitForExistence(timeout: 10))
      // iOS 18 reports an unnamed button of the menu's own at the frame of the … a row draws, so the … itself is never
      // hittable there; the tap goes to its middle.
      let more = app.buttons.matching(identifier: "roadmap-set-aside-more").firstMatch
      XCTAssertTrue(more.waitForExistence(timeout: 10))
      more.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 5))
      return app
    }
  }

  // roadmap-sync-landed once the step has landed and the band says so.
  func landed(_ look: Look) -> XCUIApplication {
    let app = launch("roadmap-sync-landed", look, arguments: ["-band-stands", "600"])
    XCTAssertTrue(app.buttons["roadmap-show"].waitForExistence(timeout: 60))
    XCTAssertTrue(app.staticTexts["3 of 8 done"].waitForExistence(timeout: 10))
    return app
  }

  // roadmap-sync-set-aside with the title's menu open, leading with Set Aside.
  func setAside(_ look: Look) -> XCUIApplication {
    let app = launch("roadmap-sync-set-aside", look)
    XCTAssertTrue(app.navigationBars["Learn to sail"].waitForExistence(timeout: 60))
    _ = app.titleMenuLeadingWithSetAside()
    return app
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
  func selecting(_ steps: [String], _ look: Look, board: String = "roadmap-learn-to-sail") -> XCUIApplication {
    let app = learnToSail(look, board: board)
    boardTool(app)
    app.buttons["Select Steps"].tap()
    XCTAssertTrue(app.buttons["roadmap-select-done"].waitForExistence(timeout: 5))
    for step in steps { app.roadmapStep(step).tap() }
    XCTAssertTrue(app.navigationBars["\(steps.count) Selected"].waitForExistence(timeout: 5))
    return app
  }

  // Kinds from the title menu over *Learn to sail*.
  func kinds(_ look: Look, board: String = "roadmap-learn-to-sail") -> XCUIApplication {
    let app = titleMenu(of: board, look)
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

  // The Guide sheet over a roadmap on a board, raised by the title menu's item of that name.
  func guide(of board: String, item: String = "Guide", _ look: Look) -> XCUIApplication {
    let app = titleMenu(of: board, look)
    app.buttons[item].tap()
    XCTAssertTrue(app.navigationBars["Guide"].waitForExistence(timeout: 10))
    return app
  }

  // 08.1: *Learn to sail*'s guide, read, over who else reads it.
  func testGuide() {
    captureBoard("08.1-roadmap-guide") { look in
      let app = guide(of: "roadmap-guide", look)
      XCTAssertTrue(app.staticTexts["roadmap-guide-text"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 08.2: a roadmap with no guide yet.
  func testNoGuideYet() {
    captureBoard("08.2-roadmap-guide-none-yet") { look in
      let app = guide(of: "roadmap-learn-to-sail", look)
      XCTAssertTrue(app.buttons["roadmap-guide-add"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 08.3: the long guide in the editor with the keyboard up, the counter showing what it may still hold.
  func testGuideNearTheLimit() {
    captureBoard("08.3-roadmap-guide-near-the-limit") { look in
      let app = guide(of: "roadmap-guide-long", look)
      app.buttons["roadmap-guide-edit"].tap()
      XCTAssertTrue(app.staticTexts["roadmap-guide-count"].waitForExistence(timeout: 10) && app.keyboards.firstMatch.waitForExistence(timeout: 10))
      return app
    }
  }

  // 08.4: typed past 5,000 characters, the excess counted and Save dimmed.
  func testGuideOverTheLimit() {
    captureBoard("08.4-roadmap-guide-over-the-limit") { look in
      let app = guide(of: "roadmap-guide-long", look)
      app.buttons["roadmap-guide-edit"].tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
      app.textViews["roadmap-guide-field"].typeText(", then tie up without help.")
      XCTAssertTrue(app.staticTexts["roadmap-guide-count"].waitForLabel("12 over", timeout: 10))
      return app
    }
  }

  // 08.5: *Learn to sail* gone into from *Become a day skipper*, whose guide stands under its own.
  func testGuidesFromAbove() {
    captureBoard("08.5-roadmap-guides-from-above") { look in
      let app = guide(of: "roadmap-guide-above", item: "Guides, +1 from above", look)
      XCTAssertTrue(app.staticTexts["roadmap-guide-above"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 10.7: two roadmaps made on the phone signed out, then the sign-in question of an account that holds one.
  func testSignInQuestionNamesRoadmaps() {
    captureBoard("10.7-roadmap-sign-in-question") { look in
      let app = launch("roadmap-sign-in", look)
      XCTAssertTrue(app.buttons["roadmap-new"].waitForExistence(timeout: 30))
      app.buttons["roadmap-new"].tap()
      for name in ["Learn to cook", "Run a 10k"] {
        let field = app.textFields["roadmap-new-name"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(name)
        app.buttons["roadmap-new-create"].tap()
        XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 10))
        if name == "Learn to cook" {
          app.navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch.tap()
          XCTAssertTrue(app.buttons["New Roadmap"].waitForExistence(timeout: 5))
          app.buttons["New Roadmap"].tap()
        }
      }
      app.buttons["you"].tap()
      XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10))
      app.buttons["email-sign-in"].tap()
      let email = app.textFields["email-address"]
      XCTAssertTrue(email.waitForExistence(timeout: 5))
      email.tap()
      email.typeText("roadmap-fixture@example.com")
      app.buttons["Send code"].tap()
      let code = app.textFields["email-code"]
      XCTAssertTrue(code.waitForExistence(timeout: 10))
      code.tap()
      code.typeText("482913")
      XCTAssertTrue(app.alerts["Add to your account?"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 10.8: the sign-out question over You, counting the five steps completed after the server stopped answering.
  func testSignOutQuestionCountsRoadmapChanges() {
    captureBoard("10.8-roadmap-sign-out-question") { look in
      let app = launch("roadmap-unconfirmed", look)
      XCTAssertTrue(app.staticTexts["8 of 8 done"].waitForExistence(timeout: 60))
      app.buttons["you"].tap()
      let signOut = app.buttons["sign-out"]
      XCTAssertTrue(signOut.waitForExistence(timeout: 10))
      for _ in 0..<6 where !signOut.isHittable { app.swipeUp(velocity: .slow) }
      signOut.tap()
      XCTAssertTrue(app.alerts["Sign out?"].waitForExistence(timeout: 30))
      return app
    }
  }

  // A shared roadmap's link opened on its board's cover, which lands on the Graph.
  func cover(_ look: Look, board: String = "roadmap-cover", arguments: [String] = []) -> XCUIApplication {
    let app = launch(board, look, arguments: arguments)
    XCTAssertTrue(app.descendants(matching: .any)["roadmap-graph"].waitForExistence(timeout: 60))
    return app
  }

  // 09.4: another account's public *Learn to sail* on its cover, on the Graph, its owner's progress under its name.
  func testCoverOnTheGraph() {
    captureBoard("09.4-roadmap-cover-graph", settle: 1.5) { look in cover(look) }
  }

  // 09.5a: the cover's Board, the owner's progress, read-only.
  func testCoverBoard() {
    captureBoard("09.5a-roadmap-cover-board") { look in
      let app = cover(look)
      app.segmentedControls.buttons["Board"].tap()
      XCTAssertTrue(app.roadmapStep("Read the wind").waitForExistence(timeout: 10))
      return app
    }
  }

  // 09.5b: a step's page on the cover, read-only, Fork at its foot.
  func testCoverStepPage() {
    captureBoard("09.5b-roadmap-cover-step") { look in
      let app = cover(look)
      app.segmentedControls.buttons["Board"].tap()
      XCTAssertTrue(app.roadmapStep("Read the wind").waitForExistence(timeout: 10))
      app.roadmapStep("Read the wind").tap()
      XCTAssertTrue(app.roadmapStepPage("Read the wind"))
      return app
    }
  }

  // 09.7: Fork under way, which the board's server leaves unanswered.
  func testForking() {
    captureBoard("09.7-roadmap-forking", settle: 1.5) { look in
      let app = cover(look, arguments: ["-fork-held"])
      app.buttons["roadmap-fork"].tap()
      XCTAssertTrue(app.staticTexts["Forking…"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 09.8: the copy arrived and opened on its Board, the band saying so.
  func testForked() {
    captureBoard("09.8-roadmap-forked", settle: 1.5) { look in
      let app = cover(look)
      app.buttons["roadmap-fork"].tap()
      XCTAssertTrue(app.staticTexts["Forked · 8 steps planted"].waitForExistence(timeout: 60))
      return app
    }
  }

  // 09.9a: Fork signed out raises the shell's sign-in over the cover.
  func testForkSignedOut() {
    captureBoard("09.9a-roadmap-fork-signed-out", settle: 1.5) { look in
      let app = cover(look, board: "roadmap-cover-signed-out")
      app.buttons["roadmap-fork"].tap()
      XCTAssertTrue(app.staticTexts["Sign in to fork this roadmap."].waitForExistence(timeout: 10))
      return app
    }
  }

  // 09.9b: a cover opened with no connection: Fork dimmed and the band slot saying why.
  func testForkWithNoConnection() {
    captureBoard("09.9b-roadmap-fork-no-connection", settle: 1.5) { look in
      let app = cover(look, board: "roadmap-cover-offline")
      XCTAssertTrue(app.staticTexts["Forking needs a connection."].waitForExistence(timeout: 10))
      return app
    }
  }

  // 09.10a and 09.10b: a link to a private roadmap, signed in and signed out.
  func testLinkCannotOpen() {
    for (screen, board) in [("09.10a-roadmap-link-cannot-open", "roadmap-cover-private"), ("09.10b-roadmap-link-cannot-open-signed-out", "roadmap-cover-private-signed-out")] {
      captureBoard(screen) { look in
        let app = launch(board, look)
        XCTAssertTrue(app.staticTexts["This roadmap can’t be opened"].waitForExistence(timeout: 60))
        return app
      }
    }
  }

  // 09.11: a link with no connection to a roadmap the phone holds no copy of.
  func testLinkWithNoConnection() {
    captureBoard("09.11-roadmap-link-no-connection") { look in
      let app = launch("roadmap-cover-no-connection", look)
      XCTAssertTrue(app.staticTexts["Needs a connection"].waitForExistence(timeout: 60))
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
