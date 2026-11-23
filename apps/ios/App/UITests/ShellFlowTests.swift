import XCTest

@MainActor final class ShellFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func launch(_ board: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board]
    app.launch()
    return app
  }

  // The room menu holds the rooms and nothing else.
  func switchRoom(_ room: String, in app: XCUIApplication) {
    let viewport = app.frame
    let menu = app.buttons.matching(NSPredicate(format: "identifier == %@ AND enabled == true", "room-menu")).firstMatch
    XCTAssertTrue(menu.waitForExistence(timeout: 10))
    XCTAssertTrue(menu.wait(for: \.isHittable, toEqual: true, timeout: 5))
    menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
    let item = app.roomItem(room)
    XCTAssertTrue(item.waitForExistence(timeout: 5))
    XCTAssertTrue(app.roomItem("Journal").exists && app.roomItem("Gym").exists && app.roomItem("Roadmap").exists)
    XCTAssertFalse(app.buttons["about-windmill"].exists, "The room menu holds only the rooms; You holds the settings")
    let visibleItem = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let snapshot = try? item.snapshot() else { return false }
      return snapshot.isEnabled && !snapshot.frame.isEmpty && viewport.contains(snapshot.frame)
    }, object: item)
    XCTAssertEqual(XCTWaiter.wait(for: [visibleItem], timeout: 5), .completed)
    item.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
    let selected = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label == %@", "room-menu", room)).firstMatch
    XCTAssertTrue(selected.waitForExistence(timeout: 10))
    XCTAssertEqual(menu.label, room)
  }

  func assertGym(_ app: XCUIApplication) {
    XCTAssertTrue(app.descendants(matching: .any)["gym-coach"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["coach-setup-screenshot"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["room-menu"].label, "Gym")
    XCTAssertTrue(app.tabBars.buttons["Routines"].exists)
    XCTAssertTrue(app.tabBars.buttons["The log"].exists)
    XCTAssertTrue(app.tabBars.buttons["Coach"].exists)
    XCTAssertTrue(app.tabBars.buttons["Coach"].isSelected)
  }

  // Each room keeps what it holds while the other is open, and the room last opened is the one a relaunch opens.
  func testRoomsSwitchAndTheLastRoomPersistsAcrossRelaunch() {
    let app = launch("shell-last-room")
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    let page = editor.value as? String
    switchRoom("Gym", in: app)
    assertGym(app)
    app.tabBars.buttons["The log"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Coach"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-coach"].waitForExistence(timeout: 5))
    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    assertGym(app)
    switchRoom("Journal", in: app)
    XCTAssertTrue(editor.waitForExistence(timeout: 5))
    XCTAssertEqual(editor.value as? String, page)
    XCTAssertFalse(app.tabBars.firstMatch.exists)
    app.terminate()
    app.launch()
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["room-menu"].label, "Journal")
    XCTAssertEqual(editor.value as? String, page)
  }

  // Shell 02a, Roadmap · iOS 01.2 and 01.5: the third door, the empty room with New Roadmap, three rooms, and a relaunch.
  func testTheRoadmapDoorOpensTheRoomOnAPhoneWithNoRoadmap() {
    let app = launch("shell-anonymous")
    let door = app.buttons["open-roadmap"]
    XCTAssertTrue(door.waitForExistence(timeout: 30))
    XCTAssertTrue(app.buttons["open-journal"].exists && app.buttons["open-gym"].exists)
    XCTAssertTrue(app.staticTexts["Your roadmap, journal and training, no account needed."].exists)
    XCTAssertEqual(door.label, "Roadmap, See what’s up next")
    door.tap()
    XCTAssertTrue(app.staticTexts["No roadmaps yet"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Plan a goal as steps that unlock each other."].exists)
    XCTAssertEqual(app.buttons["room-menu"].label, "Roadmap")
    XCTAssertTrue(app.buttons["roadmap-new"].isEnabled)
    XCTAssertFalse(app.buttons["roadmap-new-step"].exists || app.tabBars.firstMatch.exists)
    switchRoom("Gym", in: app)
    assertGym(app)
    switchRoom("Roadmap", in: app)
    XCTAssertTrue(app.staticTexts["No roadmaps yet"].waitForExistence(timeout: 10))
    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    XCTAssertTrue(app.staticTexts["No roadmaps yet"].waitForExistence(timeout: 30))
    XCTAssertEqual(app.buttons["room-menu"].label, "Roadmap")
  }

  // Roadmap · iOS 01.1 and 11.22a: the account's roadmap on its Board, Done folded, the switch, Find and the Board's
  // tool live, and New step at the foot.
  func assertLearnToSailBoard(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    let locked = app.buttons["roadmap-group-locked"]
    XCTAssertTrue(locked.waitForExistence(timeout: 30), file: file, line: line)
    XCTAssertEqual(app.buttons["room-menu"].label, "Roadmap", file: file, line: line)
    XCTAssertTrue(app.navigationBars["Learn to sail"].exists, file: file, line: line)
    XCTAssertTrue(app.staticTexts["3 of 8 done"].exists, file: file, line: line)
    let groups = ["upNext", "locked", "done"].map { (group: String) -> String in
      let header = app.buttons["roadmap-group-" + group]
      return "\(header.label) · \(header.value as? String ?? "")"
    }
    XCTAssertEqual(groups, ["Up next, 2 · Expanded", "Locked, 3 · Expanded", "Done, 3 · Collapsed"], file: file, line: line)
    let rows = app.descendants(matching: .any).matching(identifier: "roadmap-step")
    XCTAssertEqual((0..<rows.count).map { rows.element(boundBy: $0).label }, [
      "Sky, Read the wind, Unlocks Leave the dock, Learn to spot shifts in wind direction from the water, the telltales and the flag.",
      "Learn, Tie a bowline, Tie a secure loop that is easy to undo, then practise it with your eyes closed.",
      "Build, Leave the dock, Needs Read the wind · 1 to go, Cast off safely and steer clear of the dock.",
      "Learn, Sail a triangle, Needs Leave the dock · 2 to go, Practise reaching, tacking and returning to start.",
      "Milestone, Sail solo, Needs Sail a triangle +1 · 4 to go, Plan and sail a short route on your own.",
    ], file: file, line: line)
    XCTAssertTrue(app.segmentedControls.firstMatch.isEnabled, file: file, line: line)
    for control in [app.buttons["Find"], app.buttons["Sort and filter"]] {
      XCTAssertTrue(control.exists && control.isEnabled, file: file, line: line)
    }
    XCTAssertTrue(app.buttons["roadmap-new-step"].isEnabled, file: file, line: line)
    XCTAssertFalse(app.tabBars.firstMatch.exists, file: file, line: line)
  }

  // The Board is the phone's copy: with no network at the next launch it stands as it did.
  func testAPhoneHoldingLearnToSailShowsItsBoardAndAgainWithNoNetwork() {
    let app = launch("roadmap-learn-to-sail")
    assertLearnToSailBoard(app)
    // Done's header rests under the foot, below the fold: the list brings it up before it is tapped.
    let done = app.buttons["roadmap-group-done"]
    app.swipeUp(velocity: .slow)
    XCTAssertTrue(done.waitForHittable(timeout: 5))
    XCTAssertTrue(app.tap({ done.tap() }, until: { done.waitForValue("Expanded", timeout: 5) }), "Done must expand")
    // Done is newest completed first, and the list draws only the rows on screen: the step completed last leads it.
    XCTAssertTrue(app.roadmapStep("Rig the boat").waitForExistence(timeout: 5))
    app.terminate()
    app.launchArguments = ["-board", "roadmap-learn-to-sail", "-restore-board", "-server", "https://offline.invalid", "-offline-fixture", "no-network"]
    app.launch()
    assertLearnToSailBoard(app)
  }

  // Roadmap · iOS 02.1 and 02.2: only an Up next row slides right to Complete, a full swipe stops at the button, the
  // band's Undo takes the completion back, and a completion left alone regroups the Board.
  func testCompletingAStepRegroupsTheBoardAndUndoTakesItBack() {
    let app = launch("roadmap-learn-to-sail")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    let complete = app.buttons["Complete"]
    let undo = app.buttons["roadmap-undo"]
    let rows = app.descendants(matching: .any).matching(identifier: "roadmap-step")
    let atRest = "Sky, Read the wind, Unlocks Leave the dock, Learn to spot shifts in wind direction from the water, the telltales and the flag."
    // A Locked row has no leading action; where the system takes its slide for a tap, the step's page opens.
    app.roadmapStep("Leave the dock").swipeRight()
    XCTAssertFalse(complete.waitForExistence(timeout: 2), "A Locked step has no leading action")
    if app.staticTexts["roadmap-step-name"].exists { app.navigationBars.buttons.element(boundBy: 0).tap() }
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 5))
    app.roadmapStep("Read the wind").swipeRight()
    XCTAssertTrue(complete.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["3 of 8 done"].exists, "A full swipe stops at the button and completes nothing")
    // The band keeps Undo six seconds: it is taken as soon as it shows.
    complete.tap()
    XCTAssertTrue(undo.waitForExistence(timeout: 10))
    undo.tap()
    XCTAssertTrue(app.staticTexts["3 of 8 done"].waitForExistence(timeout: 10))
    XCTAssertTrue(undo.waitForNonExistence(timeout: 5))
    XCTAssertTrue(rows.firstMatch.waitForLabel(atRest, timeout: 5))

    app.roadmapStep("Read the wind").swipeRight()
    XCTAssertTrue(complete.waitForExistence(timeout: 5))
    complete.tap()
    XCTAssertTrue(app.staticTexts["Read the wind done · Leave the dock up next"].waitForExistence(timeout: 10))
    XCTAssertEqual(undo.label, "Undo")
    XCTAssertTrue(app.staticTexts["4 of 8 done"].waitForExistence(timeout: 10))
    XCTAssertTrue(rows.firstMatch.waitForLabel("Build, Leave the dock, Unlocks Sail a triangle, Cast off safely and steer clear of the dock.", timeout: 5))
    XCTAssertEqual(app.buttons["roadmap-group-upNext"].label, "Up next, 2")
    XCTAssertEqual(app.buttons["roadmap-group-locked"].label, "Locked, 2")
    XCTAssertTrue(undo.waitForNonExistence(timeout: 20), "The band leaves when its six seconds are over")
    XCTAssertTrue(app.staticTexts["4 of 8 done"].exists)
  }

  // Roadmap · iOS 02.3, 02.4, 03.8 and 03.9: Delete asks once on the row with what it costs, then holds the step with
  // Undo; the long-press menu asks the same question, and a delete left alone stands at the next launch.
  func testDeletingAStepAsksOnceHoldsItWithUndoAndStands() {
    let app = launch("roadmap-learn-to-sail")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    let tie = app.roadmapStep("Tie a bowline")
    let undo = app.buttons["roadmap-undo"]
    tie.swipeLeft()
    let delete = app.buttons["Delete"]
    XCTAssertTrue(delete.waitForExistence(timeout: 5))
    XCTAssertTrue(tie.exists, "A full swipe stops at the button and deletes nothing")
    delete.tap()
    let confirm = app.buttons["Delete Step"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Delete Tie a bowline?"].exists)
    XCTAssertTrue(app.staticTexts["Removes this step · 1 branch resplices"].exists)
    // The question closed unanswered deletes nothing.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
    XCTAssertTrue(confirm.waitForNonExistence(timeout: 5))
    XCTAssertTrue(tie.exists && app.staticTexts["3 of 8 done"].exists)
    tie.swipeLeft()
    XCTAssertTrue(delete.waitForExistence(timeout: 5))
    delete.tap()
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    // The band keeps Undo for the hold's nine seconds: it is taken as soon as the step is seen gone.
    confirm.tap()
    XCTAssertTrue(undo.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["3 of 7 done"].waitForExistence(timeout: 5))
    undo.tap()
    XCTAssertTrue(app.staticTexts["3 of 8 done"].waitForExistence(timeout: 10))
    XCTAssertTrue(tie.waitForExistence(timeout: 5))

    // The menu lists what this build can do to the step: a Locked step has no Complete.
    app.roadmapStep("Leave the dock").press(forDuration: 1)
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    XCTAssertTrue(["Edit", "Open in Graph", "Select"].allSatisfy { app.buttons[$0].exists } && !app.buttons["Complete"].exists)
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
    XCTAssertTrue(confirm.waitForNonExistence(timeout: 5))
    tie.press(forDuration: 1)
    XCTAssertTrue(app.buttons["Complete"].waitForExistence(timeout: 5))
    confirm.tap()
    XCTAssertTrue(app.staticTexts["Delete Tie a bowline?"].waitForExistence(timeout: 5))
    confirm.tap()
    XCTAssertTrue(app.staticTexts["Tie a bowline deleted"].waitForExistence(timeout: 10))
    XCTAssertTrue(tie.waitForNonExistence(timeout: 5))
    XCTAssertTrue(undo.waitForNonExistence(timeout: 20), "The band leaves when the hold's nine seconds are over")
    XCTAssertTrue(app.staticTexts["3 of 7 done"].exists)
    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    XCTAssertTrue(app.staticTexts["3 of 7 done"].waitForExistence(timeout: 30))
    XCTAssertFalse(app.roadmapStep("Tie a bowline").exists)
  }

  // The labels of the step rows on screen, in order.
  // Read from one snapshot of the screen, not one query a row: a test reads them under a band whose Undo lasts six
  // seconds, and a slow runner spent three of them on two rows queried one by one.
  func stepRows(_ app: XCUIApplication) -> [String] {
    func rows(_ element: any XCUIElementSnapshot) -> [String] {
      (element.identifier == "roadmap-step" ? [element.label] : []) + element.children.flatMap(rows)
    }
    guard let screen = try? app.snapshot() else { return [] }
    return rows(screen)
  }

  // Roadmap · iOS 01.1, 03.1 and 03.5: a Board row opens its step's page, read whole from the phone's copy, whose rows
  // open their steps on the same stack, with the person's workspace under them. What waits for its own screen is not
  // drawn.
  func testABoardRowOpensItsStepsPageAndItsRowsOpenTheirSteps() {
    let app = launch("roadmap-learn-to-sail")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    let status = app.descendants(matching: .any)["roadmap-step-status"]
    let requires = app.descendants(matching: .any)["roadmap-step-requires"], opens = app.descendants(matching: .any)["roadmap-step-opens"]
    app.roadmapStep("Read the wind").tap()
    XCTAssertTrue(app.roadmapStepPage("Read the wind"))
    XCTAssertEqual(status.label, "Up next, Sky · Unlocks Leave the dock")
    XCTAssertTrue(app.staticTexts["Learn to spot shifts in wind direction from the water, the telltales and the flag."].exists)
    XCTAssertEqual(app.descendants(matching: .any)["roadmap-step-link"].label, "Beaufort wind scale, metoffice.gov.uk")
    XCTAssertEqual([requires.label, opens.label], ["Requires, 1 of 1 done", "Opens, 1 step"])
    XCTAssertEqual(stepRows(app), ["Sky, Name the boat parts", "Build, Leave the dock, Locked · 1 to go"])
    XCTAssertTrue(app.buttons["roadmap-complete"].isEnabled && app.buttons["roadmap-step-more"].exists && app.buttons["roadmap-step-edit"].isEnabled)
    XCTAssertFalse(app.navigationBars.staticTexts["Read the wind"].exists, "The bar carries no title while the name is on the page")
    XCTAssertEqual(app.descendants(matching: .any)["roadmap-step-subtasks"].label, "Subtasks, Only you")
    for absent in [app.buttons["roadmap-new-step"], app.staticTexts["History"], app.buttons["Open Roadmap"]] {
      XCTAssertFalse(absent.exists)
    }
    XCTAssertFalse(app.tabBars.firstMatch.exists)

    app.roadmapStep("Leave the dock").tap()
    XCTAssertTrue(app.roadmapStepPage("Leave the dock"))
    XCTAssertEqual(status.label, "Locked, Build · Needs Read the wind · 1 to go")
    XCTAssertEqual([requires.label, opens.label], ["Requires, 1 of 2 done", "Opens, 1 step"])
    XCTAssertEqual(stepRows(app), ["Build, Rig the boat", "Sky, Read the wind, Up next", "Learn, Sail a triangle, Locked · 2 to go"])
    XCTAssertFalse(app.buttons["roadmap-complete"].exists || app.buttons["roadmap-reset"].exists, "A Locked step has no Complete and no Reset")

    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.roadmapStepPage("Read the wind"))
    app.navigationBars.buttons.element(boundBy: 0).tap()
    assertLearnToSailBoard(app)
  }

  // Roadmap · iOS 03.4, 03.6 and 03.6b: Complete on a step's page keeps the page and says what opened; a Done step
  // says what Reset would lock before it is pressed, and Reset asks nothing; the band's Undo takes each back.
  func testCompletingAndResettingAStepOnItsPageKeepThePageAndUndoTakesEachBack() {
    let app = launch("roadmap-learn-to-sail")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    let status = app.descendants(matching: .any)["roadmap-step-status"]
    let complete = app.buttons["roadmap-complete"], reset = app.buttons["roadmap-reset"], undo = app.buttons["roadmap-undo"]
    app.roadmapStep("Read the wind").tap()
    XCTAssertTrue(app.roadmapStepPage("Read the wind"))
    XCTAssertFalse(reset.exists)
    // The band keeps Undo six seconds: it is taken once the page has turned.
    complete.tap()
    XCTAssertTrue(undo.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Leave the dock is up next"].exists)
    XCTAssertTrue(status.waitForLabel("Done, Sky · Reset returns 1 step to Locked", timeout: 10))
    XCTAssertEqual(stepRows(app), ["Sky, Name the boat parts", "Build, Leave the dock, Up next"])
    XCTAssertTrue(reset.exists && !complete.exists && app.roadmapStepPage("Read the wind"))
    undo.tap()
    XCTAssertTrue(status.waitForLabel("Up next, Sky · Unlocks Leave the dock", timeout: 10))
    XCTAssertTrue(undo.waitForNonExistence(timeout: 5))
    XCTAssertTrue(complete.exists && !reset.exists)

    app.roadmapStep("Name the boat parts").tap()
    XCTAssertTrue(app.roadmapStepPage("Name the boat parts"))
    XCTAssertEqual(status.label, "Done, Sky · Reset returns 2 steps to Locked")
    XCTAssertEqual(stepRows(app), ["Build, Choose a sailing course", "Build, Rig the boat", "Sky, Read the wind, Up next", "Learn, Tie a bowline, Up next"])
    XCTAssertFalse(complete.exists)
    reset.tap()
    XCTAssertTrue(undo.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["2 steps locked again"].exists)
    XCTAssertTrue(status.waitForLabel("Up next, Sky · Unlocks Read the wind +1", timeout: 10))
    XCTAssertEqual(stepRows(app), ["Build, Choose a sailing course", "Build, Rig the boat", "Sky, Read the wind, Locked · 1 to go",
                                   "Learn, Tie a bowline, Locked · 1 to go"])
    XCTAssertTrue(complete.exists && !reset.exists)
    undo.tap()
    XCTAssertTrue(status.waitForLabel("Done, Sky · Reset returns 2 steps to Locked", timeout: 10))
    XCTAssertTrue(reset.exists && !complete.exists)
  }

  // Roadmap · iOS 03.7 to 03.9: the … menu holds Open in Graph, View Branch and Delete Step, which asks on the … button
  // with what the delete costs; answered, the room stands on the Board without the step, and the band's Undo brings it
  // back. The roadmap's one starting step's menu has no Delete Step.
  func testDeletingAStepFromItsPageAsksThereAndReturnsToTheBoard() {
    let app = launch("roadmap-learn-to-sail")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    let more = app.buttons["roadmap-step-more"], confirm = app.buttons["Delete Step"], undo = app.buttons["roadmap-undo"]
    app.roadmapStep("Read the wind").tap()
    XCTAssertTrue(app.roadmapStepPage("Read the wind"))
    XCTAssertEqual(more.label, "More")
    more.tap()
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Open in Graph"].exists && app.buttons["View Branch"].exists)
    for unbuilt in ["Attach a Roadmap", "Copy Link"] { XCTAssertFalse(app.buttons[unbuilt].exists) }
    confirm.tap()
    XCTAssertTrue(app.staticTexts["Delete Read the wind?"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Removes this step · 1 branch resplices"].exists)
    // The question closed unanswered deletes nothing and leaves the page.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).tap()
    XCTAssertTrue(confirm.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.roadmapStepPage("Read the wind"))

    more.tap()
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    confirm.tap()
    XCTAssertTrue(app.staticTexts["Delete Read the wind?"].waitForExistence(timeout: 5))
    // The band keeps Undo for the hold's nine seconds: it is taken as soon as the Board is seen without the step.
    confirm.tap()
    XCTAssertTrue(app.staticTexts["3 of 7 done"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Read the wind deleted"].exists)
    XCTAssertFalse(app.roadmapStep("Read the wind").exists)
    undo.tap()
    XCTAssertTrue(app.staticTexts["3 of 8 done"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.roadmapStep("Read the wind").waitForExistence(timeout: 5))

    for step in ["Read the wind", "Name the boat parts", "Choose a sailing course"] {
      app.roadmapStep(step).tap()
      XCTAssertTrue(app.roadmapStepPage(step))
    }
    more.tap()
    XCTAssertTrue(app.buttons["View Branch"].waitForExistence(timeout: 5))
    XCTAssertFalse(confirm.exists, "The roadmap's one starting step offers no Delete")
    // The menu closes on a tap beside it on the step's name, which does nothing: a tap there reaches the page too, so one
    // lower would open the Note row, and the bar's middle is under the menu.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.15)).tap()
    XCTAssertTrue(app.buttons["View Branch"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["roadmap-reset"].exists)
  }

  // Roadmap · iOS 03.1, at the largest text, where the page is longer than the screen: the bar takes the step's name
  // once the name has scrolled away, and gives it back.
  func testAStepsNameTakesTheBarOnceItHasScrolledAway() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "roadmap-learn-to-sail", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"]
    app.launch()
    XCTAssertTrue(app.buttons["roadmap-group-upNext"].waitForExistence(timeout: 30))
    app.roadmapStep("Read the wind").tap()
    XCTAssertTrue(app.roadmapStepPage("Read the wind"))
    let inBar = app.navigationBars.staticTexts["Read the wind"]
    XCTAssertFalse(inBar.exists)
    app.swipeUp()
    XCTAssertTrue(inBar.waitForExistence(timeout: 5))
    // A swipe's reach depends on its speed, so one swipe down can leave the name still under the bar.
    XCTAssertTrue(app.tap({ app.swipeDown() }, until: { inBar.waitForNonExistence(timeout: 5) }), "The page must come back to its top")
  }

  // The step form, raised and on screen: its name field.
  func stepForm(_ app: XCUIApplication, raisedBy button: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    let name = app.textFields["roadmap-form-name"]
    XCTAssertTrue(app.buttons[button].waitForHittable(timeout: 10), file: file, line: line)
    app.buttons[button].tap()
    XCTAssertTrue(name.waitForExistence(timeout: 10), file: file, line: line)
    return name
  }

  // One step taken or dropped in the form's Requires or Opens list, and back on the form.
  func choose(_ step: String, in list: String, of app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(app.buttons["roadmap-form-" + list.lowercased()].waitForHittable(timeout: 5), file: file, line: line)
    app.buttons["roadmap-form-" + list.lowercased()].tap()
    XCTAssertTrue(app.roadmapChoice(step).waitForExistence(timeout: 5), file: file, line: line)
    app.roadmapChoice(step).tap()
    app.leaveRoadmapList(list)
  }

  // Roadmap · iOS 05.1, 05.3, 05.7, 05.8 and 02.2, on a phone never signed in and on its copy alone: a roadmap is made;
  // New Step adds a step and then a second that requires the first, each shown on the Board under its receipt; Edit
  // renames the second from its page; the first is completed; and a relaunch finds all of it.
  func testStepsAreMadeLinkedEditedAndCompletedSignedOutAndFoundAfterARelaunch() {
    let app = launch("roadmap-empty")
    let roadmapName = app.textFields["roadmap-new-name"], commit = app.buttons["roadmap-form-commit"]
    XCTAssertTrue(app.buttons["roadmap-new"].waitForExistence(timeout: 30))
    app.buttons["roadmap-new"].tap()
    XCTAssertTrue(roadmapName.waitForExistence(timeout: 10))
    roadmapName.tap()
    roadmapName.typeText("Learn to cook")
    XCTAssertTrue(app.buttons["roadmap-new-create"].wait(for: \.isEnabled, toEqual: true, timeout: 5))
    app.buttons["roadmap-new-create"].tap()
    XCTAssertTrue(app.staticTexts["0 of 1 done"].waitForExistence(timeout: 10))

    var name = stepForm(app, raisedBy: "roadmap-new-step")
    XCTAssertTrue(app.navigationBars["New Step"].exists && !commit.isEnabled)
    XCTAssertEqual(name.placeholderValue, "Name this step")
    XCTAssertEqual(app.buttons["roadmap-form-kind"].label, "Kind, Sky")
    name.tap()
    name.typeText("Buy a knife")
    XCTAssertTrue(commit.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    commit.tap()
    XCTAssertTrue(app.staticTexts["Buy a knife added · Up next"].waitForExistence(timeout: 10))
    XCTAssertTrue(name.waitForNonExistence(timeout: 5) && app.staticTexts["0 of 2 done"].waitForExistence(timeout: 5))

    name = stepForm(app, raisedBy: "roadmap-new-step")
    name.tap()
    name.typeText("Chop an onion\n")
    choose("Buy a knife", in: "Requires", of: app)
    XCTAssertEqual(app.buttons["roadmap-form-requires"].label, "Requires, Buy a knife")
    XCTAssertTrue(app.staticTexts["Lands in Locked · Buy a knife isn’t done"].exists)
    commit.tap()
    XCTAssertTrue(app.staticTexts["Chop an onion added · Locked"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["0 of 3 done"].waitForExistence(timeout: 5))
    XCTAssertEqual([app.buttons["roadmap-group-upNext"].label, app.buttons["roadmap-group-locked"].label], ["Up next, 2", "Locked, 1"])
    XCTAssertEqual(app.roadmapStep("Chop an onion").label, "Sky, Chop an onion, Needs Buy a knife · 1 to go")

    app.roadmapStep("Chop an onion").tap()
    XCTAssertTrue(app.roadmapStepPage("Chop an onion"))
    name = stepForm(app, raisedBy: "roadmap-step-edit")
    XCTAssertTrue(app.navigationBars["Edit Step"].exists && !commit.isEnabled)
    XCTAssertTrue(name.waitForValue("Chop an onion"))
    XCTAssertEqual(app.buttons["roadmap-form-requires"].label, "Requires, Buy a knife")
    name.tap()
    name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + "two onions")
    XCTAssertTrue(commit.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    commit.tap()
    XCTAssertTrue(app.staticTexts["Chop two onions saved"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.roadmapStepPage("Chop two onions"))
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 5))

    app.roadmapStep("Buy a knife").swipeRight()
    XCTAssertTrue(app.buttons["Complete"].waitForExistence(timeout: 5))
    app.buttons["Complete"].tap()
    XCTAssertTrue(app.staticTexts["Buy a knife done · Chop two onions up next"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["1 of 3 done"].waitForExistence(timeout: 5))

    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    XCTAssertTrue(app.navigationBars["Learn to cook"].waitForExistence(timeout: 30))
    XCTAssertTrue(app.staticTexts["1 of 3 done"].exists)
    XCTAssertEqual([app.buttons["roadmap-group-upNext"].label, app.buttons["roadmap-group-done"].label], ["Up next, 2", "Done, 1"])
    app.roadmapStep("Chop two onions").tap()
    XCTAssertTrue(app.roadmapStepPage("Chop two onions"))
    XCTAssertEqual(app.descendants(matching: .any)["roadmap-step-requires"].label, "Requires, 1 of 1 done")
    XCTAssertEqual(stepRows(app), ["Sky, Buy a knife"])
  }

  // Roadmap · iOS 05.1 to 05.7: the form opens on no refusal with Create disabled; a name typed and cleared is refused
  // in its footer; Kind lists six kinds and returns with the one chosen; Requires and Opens take a step in place and, opened
  // again, head with what was chosen; a tap on a dimmed step changes nothing and names it; Cancel on the changed draft
  // asks once, a tap outside keeps editing and Discard writes nothing; and Create shows the step on the Board, where
  // Undo takes it back.
  func testTheStepFormRefusesWhereItStandsAsksBeforeDiscardingAndCreatesWithUndo() {
    let app = launch("roadmap-learn-to-sail")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    let commit = app.buttons["roadmap-form-commit"], cancel = app.buttons["roadmap-form-cancel"], undo = app.buttons["roadmap-undo"]
    let refusal = app.staticTexts["roadmap-form-refusal"]
    let name = stepForm(app, raisedBy: "roadmap-new-step")
    XCTAssertFalse(commit.isEnabled || refusal.exists)
    XCTAssertTrue(app.staticTexts["Lands in Up next"].exists)
    // The rows whose screens are not built are left out: the form's Roadmap row would read as Kind's does.
    XCTAssertTrue(app.staticTexts["Links"].exists && app.buttons["roadmap-form-add-link"].exists)
    for unbuilt in ["Roadmap, None", "Delete Step"] { XCTAssertFalse(app.staticTexts[unbuilt].exists || app.buttons[unbuilt].exists) }
    name.tap()
    name.typeText("Reef")
    XCTAssertTrue(commit.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4))
    XCTAssertTrue(refusal.waitForExistence(timeout: 5))
    XCTAssertEqual(refusal.label, "Enter a name for this step.")
    XCTAssertFalse(commit.isEnabled)
    name.typeText("Reefing basics\n")
    XCTAssertTrue(refusal.waitForNonExistence(timeout: 5) && commit.isEnabled)

    app.buttons["roadmap-form-kind"].tap()
    XCTAssertTrue(app.roadmapKind("Learn").waitForExistence(timeout: 5))
    let kinds = app.buttons.matching(identifier: "roadmap-kind")
    XCTAssertEqual((0..<kinds.count).map { kinds.element(boundBy: $0).label },
                   ["Build, Things you make", "Learn, Things you figure out", "Milestone, Moments that matter", "Brick", "Sky", "Plum"])
    XCTAssertTrue(app.roadmapKind("Sky").isSelected && !app.roadmapKind("Learn").isSelected)
    app.roadmapKind("Learn").tap()
    XCTAssertTrue(app.buttons["roadmap-form-kind"].waitForLabel("Kind, Learn", timeout: 5))

    choose("Read the wind", in: "Requires", of: app)
    choose("Leave the dock", in: "Opens", of: app)
    XCTAssertEqual([app.buttons["roadmap-form-requires"].label, app.buttons["roadmap-form-opens"].label], ["Requires, Read the wind", "Opens, Leave the dock"])
    XCTAssertTrue(app.staticTexts["Lands in Locked · Read the wind isn’t done"].exists)

    app.buttons["roadmap-form-requires"].tap()
    XCTAssertTrue(app.staticTexts["Selected"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["All steps"].exists && app.staticTexts["Can’t be prerequisites"].exists && app.staticTexts["These come after this step."].exists)
    XCTAssertTrue(app.searchFields["Find a step"].exists && app.roadmapChoice("Read the wind").isSelected)
    app.roadmapChoice("Leave the dock").tap()
    XCTAssertTrue(refusal.waitForExistence(timeout: 5))
    XCTAssertEqual(refusal.label, "Leave the dock comes after this step.")
    XCTAssertFalse(app.roadmapChoice("Leave the dock").isSelected || app.staticTexts["These come after this step."].exists)
    app.leaveRoadmapList("Requires")
    XCTAssertEqual(app.buttons["roadmap-form-requires"].label, "Requires, Read the wind")
    XCTAssertTrue(refusal.waitForNonExistence(timeout: 5), "The list's refusal leaves with the list")

    cancel.tap()
    XCTAssertTrue(app.buttons["Discard"].waitForExistence(timeout: 5) && app.staticTexts["Discard draft?"].exists)
    app.dismissPopover()
    XCTAssertTrue(app.buttons["Discard"].waitForNonExistence(timeout: 5) && name.exists)
    cancel.tap()
    XCTAssertTrue(app.buttons["Discard"].waitForExistence(timeout: 5))
    app.buttons["Discard"].tap()
    XCTAssertTrue(name.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["3 of 8 done"].exists && !undo.exists)

    // An unchanged draft closes at once.
    _ = stepForm(app, raisedBy: "roadmap-new-step")
    cancel.tap()
    XCTAssertTrue(name.waitForNonExistence(timeout: 5))

    let again = stepForm(app, raisedBy: "roadmap-new-step")
    again.tap()
    again.typeText("Reefing basics\n")
    choose("Read the wind", in: "Requires", of: app)
    commit.tap()
    // The band keeps Undo for six seconds: the Board is read, and Undo taken, as soon as the step is seen.
    XCTAssertTrue(app.roadmapStep("Reefing basics").waitForExistence(timeout: 10))
    XCTAssertEqual(app.roadmapStep("Reefing basics").label, "Sky, Reefing basics, Needs Read the wind · 1 to go")
    XCTAssertTrue(app.staticTexts["Reefing basics added · Locked"].exists && app.staticTexts["3 of 9 done"].exists)
    undo.tap()
    XCTAssertTrue(app.roadmapStep("Reefing basics").waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["3 of 8 done"].waitForExistence(timeout: 5))
  }

  // Roadmap · iOS 05.8 and 03.8: Edit raises the form over the step's page on what the step holds, Save disabled until
  // something changes; a change of kind is saved as one gesture, the page staying under its receipt, and Undo takes it
  // back; Delete Step in the form asks there with what the delete costs and leaves the room on the Board; and the
  // roadmap's one starting step has no Delete Step.
  func testEditSavesAStepsChangeWithUndoAndDeleteStepAsksInTheForm() {
    let app = launch("roadmap-learn-to-sail")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    let commit = app.buttons["roadmap-form-commit"], undo = app.buttons["roadmap-undo"], delete = app.buttons["roadmap-form-delete"]
    let status = app.descendants(matching: .any)["roadmap-step-status"]
    app.roadmapStep("Tie a bowline").tap()
    XCTAssertTrue(app.roadmapStepPage("Tie a bowline"))
    XCTAssertEqual(status.label, "Up next, Learn")
    var name = stepForm(app, raisedBy: "roadmap-step-edit")
    XCTAssertTrue(app.navigationBars["Edit Step"].exists && !commit.isEnabled && delete.exists)
    XCTAssertEqual(commit.label, "Save")
    XCTAssertTrue(name.waitForValue("Tie a bowline"))
    XCTAssertEqual([app.buttons["roadmap-form-kind"].label, app.buttons["roadmap-form-requires"].label, app.buttons["roadmap-form-opens"].label],
                   ["Kind, Learn", "Requires, Name the boat parts", "Opens, Sail solo"])
    XCTAssertFalse(app.staticTexts["roadmap-form-placement"].exists, "A step that stays in its group says nothing of where it lands")
    app.buttons["roadmap-form-kind"].tap()
    XCTAssertTrue(app.roadmapKind("Plum").waitForExistence(timeout: 5))
    app.roadmapKind("Plum").tap()
    XCTAssertTrue(commit.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    commit.tap()
    XCTAssertTrue(app.staticTexts["Tie a bowline saved"].waitForExistence(timeout: 10))
    XCTAssertTrue(status.waitForLabel("Up next, Plum", timeout: 5) && app.roadmapStepPage("Tie a bowline"))
    undo.tap()
    XCTAssertTrue(status.waitForLabel("Up next, Learn", timeout: 10))

    name = stepForm(app, raisedBy: "roadmap-step-edit")
    XCTAssertTrue(delete.waitForHittable(timeout: 5))
    delete.tap()
    XCTAssertTrue(app.staticTexts["Delete Tie a bowline?"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Removes this step · 1 branch resplices"].exists)
    app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Delete Step", "roadmap-form-delete")).firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Tie a bowline deleted"].waitForExistence(timeout: 10))
    XCTAssertTrue(name.waitForNonExistence(timeout: 5) && app.buttons["roadmap-group-locked"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["3 of 7 done"].exists)
    undo.tap()
    XCTAssertTrue(app.roadmapStep("Tie a bowline").waitForExistence(timeout: 10))

    for step in ["Tie a bowline", "Name the boat parts", "Choose a sailing course"] {
      app.roadmapStep(step).tap()
      XCTAssertTrue(app.roadmapStepPage(step))
    }
    _ = stepForm(app, raisedBy: "roadmap-step-edit")
    XCTAssertTrue(app.navigationBars["Edit Step"].exists)
    XCTAssertFalse(delete.exists, "The roadmap's one starting step offers no Delete")
  }

  // The title's menu, opened from the bar's title, whose label the open roadmap's name leads: the system reports the
  // title as a button or as a text, and adds words of its own to the label.
  func openTitleMenu(_ title: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    let name = app.navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    XCTAssertTrue(name.waitForExistence(timeout: 10), file: file, line: line)
    name.tap()
    XCTAssertTrue(app.buttons["All Roadmaps…"].waitForExistence(timeout: 5), file: file, line: line)
  }

  // The labels of the roadmaps' rows on screen in All Roadmaps, in order.
  func listedRoadmaps(_ app: XCUIApplication) -> [String] {
    let rows = app.buttons.matching(identifier: "roadmap-listed")
    return (0..<rows.count).map { rows.element(boundBy: $0).label }
  }

  // Roadmap · iOS 01.5, 01.6 and 01.9 to 01.11, signed out and on the phone's copy alone: New Roadmap names one, Cancel
  // writes nothing and Create plants it with its one step and opens it; Rename turns the bar into a field whose return
  // commits; a relaunch opens the roadmap again; and Delete Roadmap asks once, leaves the room with no roadmap and Undo
  // in the band, which brings it back.
  func testARoadmapIsMadeRenamedReopenedAndDeletedWithUndoSignedOut() {
    let app = launch("roadmap-empty")
    let new = app.buttons["roadmap-new"], name = app.textFields["roadmap-new-name"], create = app.buttons["roadmap-new-create"]
    XCTAssertTrue(new.waitForExistence(timeout: 30))
    new.tap()
    XCTAssertTrue(name.waitForExistence(timeout: 10))
    XCTAssertEqual(name.placeholderValue, "Name your roadmap")
    XCTAssertTrue(app.navigationBars["New Roadmap"].exists && !create.isEnabled)
    for unbuilt in ["Start from", "A Quest", "A Copied Plan", "A File"] { XCTAssertFalse(app.staticTexts[unbuilt].exists || app.buttons[unbuilt].exists) }
    app.buttons["roadmap-new-cancel"].tap()
    XCTAssertTrue(name.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["No roadmaps yet"].exists)

    new.tap()
    XCTAssertTrue(name.waitForExistence(timeout: 10))
    name.tap()
    name.typeText("Learn to cook")
    XCTAssertTrue(create.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    create.tap()
    XCTAssertTrue(app.navigationBars["Learn to cook"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["0 of 1 done"].waitForExistence(timeout: 5))
    XCTAssertEqual(stepRows(app), ["Build, Learn to cook"])
    XCTAssertEqual(app.buttons["roadmap-group-upNext"].label, "Up next, 1")

    // The bar's field starts from the name, selected: what is typed takes its place.
    let field = app.navigationBars.textFields.firstMatch
    openTitleMenu("Learn to cook", in: app)
    for unbuilt in ["Guide", "Activity", "Share…", "Export"] { XCTAssertFalse(app.buttons[unbuilt].exists) }
    app.buttons["Rename"].tap()
    XCTAssertTrue(field.waitForValue("Learn to cook"))
    field.typeText("Cook at home\n")
    XCTAssertTrue(app.navigationBars["Cook at home"].waitForExistence(timeout: 10))

    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    XCTAssertTrue(app.navigationBars["Cook at home"].waitForExistence(timeout: 30))
    XCTAssertTrue(app.staticTexts["0 of 1 done"].exists)
    XCTAssertEqual(stepRows(app), ["Build, Learn to cook"])

    let confirm = app.buttons["Delete Roadmap"], undo = app.buttons["roadmap-undo"]
    openTitleMenu("Cook at home", in: app)
    confirm.tap()
    XCTAssertTrue(app.staticTexts["Delete Cook at home?"].waitForExistence(timeout: 5))
    // The question closed unanswered deletes nothing.
    app.cancelConfirmation()
    XCTAssertTrue(confirm.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars["Cook at home"].exists)
    openTitleMenu("Cook at home", in: app)
    confirm.tap()
    XCTAssertTrue(app.staticTexts["Delete Cook at home?"].waitForExistence(timeout: 5))
    // The band keeps Undo for the hold's nine seconds: it is taken as soon as the room is seen without the roadmap.
    confirm.tap()
    XCTAssertTrue(app.staticTexts["No roadmaps yet"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Cook at home deleted"].exists)
    undo.tap()
    XCTAssertTrue(app.navigationBars["Cook at home"].waitForExistence(timeout: 10))
    XCTAssertTrue(undo.waitForNonExistence(timeout: 5))
    XCTAssertEqual(stepRows(app), ["Build, Learn to cook"])
  }

  // Roadmap · iOS 01.3 and 01.4: the title menu lists the account's roadmaps, most recent first and the open one
  // checked, over the verbs this build has; a roadmap chosen there opens on its Board and is the one a relaunch opens;
  // All Roadmaps lists them in the same order, a row opens its roadmap, and + opens New Roadmap.
  func testTheTitleMenuAndAllRoadmapsOpenARoadmapAndARelaunchOpensItAgain() {
    let app = launch("roadmap-several")
    assertLearnToSailBoard(app)
    openTitleMenu("Learn to sail", in: app)
    // The menu's items, in order, outside the bar, whose title the system may report as a button of the same name.
    let listed = ["Learn to sail", "Spanish B1", "Become a day skipper", "All Roadmaps…", "New Roadmap", "Kinds", "Rename", "Delete Roadmap"]
    let named = NSPredicate(format: "label IN %@", listed)
    let items = app.buttons.matching(named)
    let inBar = app.navigationBars.buttons.matching(named).count
    XCTAssertEqual((inBar..<items.count).map { items.element(boundBy: $0).label }, listed)
    XCTAssertTrue(items.element(boundBy: inBar).isSelected && !items.element(boundBy: inBar + 1).isSelected)
    for unbuilt in ["Guide", "Activity", "Share…", "Export"] { XCTAssertFalse(app.buttons[unbuilt].exists) }
    app.buttons["Spanish B1"].tap()
    XCTAssertTrue(app.navigationBars["Spanish B1"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["2 of 7 done"].waitForExistence(timeout: 5))
    XCTAssertEqual(Array(stepRows(app).prefix(2)), ["Build, Talk about last weekend, Unlocks Tell a story, Use both past tenses in a five-minute chat about what you did.",
                                                    "Learn, Meet the subjunctive, Unlocks Give advice, Learn the ten phrases that always take the subjunctive."])

    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    XCTAssertTrue(app.navigationBars["Spanish B1"].waitForExistence(timeout: 30))

    openTitleMenu("Spanish B1", in: app)
    app.buttons["All Roadmaps…"].tap()
    XCTAssertTrue(app.navigationBars["All Roadmaps"].waitForExistence(timeout: 5))
    XCTAssertEqual(listedRoadmaps(app), ["Learn to sail, 3 of 8 done", "Spanish B1, 2 of 7 done", "Become a day skipper, 1 of 3 done"])
    let rows = app.buttons.matching(identifier: "roadmap-listed")
    XCTAssertEqual((0..<rows.count).map { rows.element(boundBy: $0).isSelected }, [false, true, false])
    XCTAssertFalse(app.searchFields.firstMatch.exists, "The search field stands only past eight roadmaps")
    XCTAssertFalse(app.staticTexts["Planted in Public"].exists || app.buttons["roadmap-new-step"].exists)
    app.buttons["roadmap-list-new"].tap()
    XCTAssertTrue(app.textFields["roadmap-new-name"].waitForExistence(timeout: 10))
    app.buttons["roadmap-new-cancel"].tap()
    XCTAssertTrue(app.textFields["roadmap-new-name"].waitForNonExistence(timeout: 5))
    rows.element(boundBy: 2).tap()
    XCTAssertTrue(app.navigationBars["Become a day skipper"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["1 of 3 done"].exists && app.buttons["roadmap-group-upNext"].exists)
  }

  // Roadmap · iOS 01.10 and 01.11: Delete Roadmap asks once under the title, naming the step of another roadmap that
  // opens this one; answered, the room moves to the next most recent roadmap with Undo in the band, which opens the
  // roadmap again. A row of All Roadmaps slides to Delete and stops there, asks on the row, and the list stays under the
  // band, whose Undo brings the row back.
  func testDeletingARoadmapAsksOnceMovesTheRoomOnAndUndoBringsItBack() {
    let app = launch("roadmap-several")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    let confirm = app.buttons["Delete Roadmap"], undo = app.buttons["roadmap-undo"]
    openTitleMenu("Learn to sail", in: app)
    confirm.tap()
    XCTAssertTrue(app.staticTexts["Delete Learn to sail?"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Also removes the step that opens it in Become a day skipper"].exists)
    // The band keeps Undo for the hold's nine seconds: it is taken as soon as the next roadmap's Board is seen.
    confirm.tap()
    XCTAssertTrue(app.navigationBars["Spanish B1"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Learn to sail deleted"].exists && app.staticTexts["2 of 7 done"].exists)
    undo.tap()
    XCTAssertTrue(app.navigationBars["Learn to sail"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["3 of 8 done"].waitForExistence(timeout: 5))
    XCTAssertTrue(undo.waitForNonExistence(timeout: 5))

    openTitleMenu("Learn to sail", in: app)
    app.buttons["All Roadmaps…"].tap()
    XCTAssertTrue(app.navigationBars["All Roadmaps"].waitForExistence(timeout: 5))
    let spanish = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "roadmap-listed", "Spanish B1")).firstMatch
    let delete = app.buttons["Delete"]
    spanish.swipeLeft()
    XCTAssertTrue(delete.waitForExistence(timeout: 5))
    XCTAssertTrue(spanish.exists, "A full swipe stops at the button and deletes nothing")
    delete.tap()
    XCTAssertTrue(app.staticTexts["Delete Spanish B1?"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Also removes")).firstMatch.exists)
    confirm.tap()
    XCTAssertTrue(undo.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Spanish B1 deleted"].exists)
    XCTAssertTrue(spanish.waitForNonExistence(timeout: 5))
    XCTAssertEqual(listedRoadmaps(app), ["Learn to sail, 3 of 8 done", "Become a day skipper, 1 of 3 done"])
    undo.tap()
    XCTAssertTrue(spanish.waitForExistence(timeout: 10))
    XCTAssertTrue(app.navigationBars["All Roadmaps"].exists)
    XCTAssertEqual(listedRoadmaps(app), ["Learn to sail, 3 of 8 done", "Spanish B1, 2 of 7 done", "Become a day skipper, 1 of 3 done"])
  }

  // Roadmap · iOS 01.3 and 01.4, on a phone never signed in that holds nine roadmaps: the title menu lists three of
  // them, and past eight All Roadmaps finds a roadmap by its name.
  func testAllRoadmapsFindsARoadmapByNamePastEight() {
    let app = launch("roadmap-many")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    let rows = ["Become a day skipper, 1 of 3 done", "Coastal navigation handbook, 3 of 4 done", "Learn to sail, 3 of 8 done", "Learn watercolor, 1 of 2 done",
                "Personal finance reset, 1 of 1 done", "Room makeover, 0 of 1 done", "Run a 10k, 1 of 2 done", "Ship v1, 1 of 2 done", "Spanish B1, 2 of 7 done"]
    openTitleMenu("Learn to sail", in: app)
    // The menu's roadmaps are the buttons of those names outside the bar, whose title the system may report as one.
    let named = NSPredicate(format: "label IN %@", rows.map { $0.components(separatedBy: ", ")[0] })
    XCTAssertEqual(app.buttons.matching(named).count - app.navigationBars.buttons.matching(named).count, 3)
    app.buttons["All Roadmaps…"].tap()
    let search = app.searchFields["Find a roadmap"]
    XCTAssertTrue(search.waitForExistence(timeout: 5))
    XCTAssertEqual(listedRoadmaps(app).sorted(), rows)
    search.tap()
    search.typeText("run ")
    XCTAssertTrue(app.buttons.matching(identifier: "roadmap-listed").firstMatch.waitForLabel("Run a 10k, 1 of 2 done", timeout: 5))
    XCTAssertEqual(listedRoadmaps(app), ["Run a 10k, 1 of 2 done"])
    app.buttons.matching(identifier: "roadmap-listed").firstMatch.tap()
    XCTAssertTrue(app.navigationBars["Run a 10k"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["1 of 2 done"].exists)
  }

  // Roadmap · iOS 02.15 and 01.12: a roadmap with no step asks for the first, and one with every step done opens Done.
  func testTheBoardAtItsEndsAsksForAFirstStepOrOpensDone() {
    let empty = launch("roadmap-no-steps")
    XCTAssertTrue(empty.staticTexts["Your first step"].waitForExistence(timeout: 30))
    XCTAssertTrue(empty.navigationBars["Night sailing"].exists && empty.staticTexts["No steps yet"].exists)
    XCTAssertTrue(empty.staticTexts["Give your roadmap a place to start."].exists)
    XCTAssertTrue(empty.buttons["roadmap-new-step"].isEnabled)
    // 02.15: New Step opens the form, where a roadmap with no step offers none to require or to open.
    let name = empty.textFields["roadmap-form-name"], lists = [empty.buttons["roadmap-form-requires"], empty.buttons["roadmap-form-opens"]]
    empty.buttons["roadmap-first-step"].tap()
    XCTAssertTrue(name.waitForExistence(timeout: 10))
    XCTAssertEqual(lists.map(\.label), ["Requires, None", "Opens, None"])
    XCTAssertFalse(lists[0].isEnabled || lists[1].isEnabled)
    XCTAssertTrue(empty.staticTexts["Lands in Up next"].exists)
    name.tap()
    name.typeText("Sail after dark")
    XCTAssertTrue(empty.buttons["roadmap-form-commit"].wait(for: \.isEnabled, toEqual: true, timeout: 5))
    empty.buttons["roadmap-form-commit"].tap()
    XCTAssertTrue(empty.staticTexts["0 of 1 done"].waitForExistence(timeout: 10))
    XCTAssertTrue(empty.staticTexts["Sail after dark added · Up next"].exists)
    XCTAssertEqual(stepRows(empty), ["Sky, Sail after dark"])
    empty.terminate()

    let done = launch("roadmap-all-done")
    XCTAssertTrue(done.staticTexts["All 8 steps done"].waitForExistence(timeout: 30))
    XCTAssertTrue(done.staticTexts["8 of 8 done"].exists && done.staticTexts["Add a step whenever you’re ready."].exists)
    XCTAssertTrue(done.buttons["roadmap-share"].exists)
    XCTAssertFalse(done.buttons["roadmap-share"].isEnabled)
    let header = done.buttons["roadmap-group-done"]
    XCTAssertEqual("\(header.label) · \(header.value as? String ?? "")", "Done, 8 · Expanded")
    XCTAssertFalse(done.buttons["roadmap-group-upNext"].exists || done.buttons["roadmap-group-locked"].exists)
    XCTAssertTrue(done.roadmapStep("Sail solo").exists)
  }

  // Roadmap · iOS 01.5c, for a read of the phone's copy the room cannot make: it says so, naming the phone, and offers to
  // try again.
  func testARoadmapThePhoneCannotReadSaysSoAndOffersToTryAgain() {
    let app = launch("roadmap-unreadable")
    XCTAssertTrue(app.staticTexts["Couldn’t load this roadmap"].waitForExistence(timeout: 30))
    XCTAssertTrue(app.staticTexts["The copy on this iPhone couldn’t be read."].exists)
    XCTAssertEqual(app.buttons["room-menu"].label, "Roadmap")
    XCTAssertFalse(app.buttons["roadmap-new-step"].exists || app.segmentedControls.firstMatch.exists)
    app.buttons["roadmap-try-again"].tap()
    XCTAssertTrue(app.staticTexts["Couldn’t load this roadmap"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["roadmap-try-again"].isEnabled)
  }

  // 27a–27d: the typed email confirms, the account closes, and Done returns to You signed out over Where to start?.
  func testDeleteAccountLeavesThePhoneSignedOut() {
    let app = launch("24a")
    let delete = app.buttons["delete-account"]
    XCTAssertTrue(delete.waitForExistence(timeout: 30))
    for _ in 0..<6 where !delete.isHittable { app.swipeUp(velocity: .slow) }
    delete.tap()
    let field = app.textFields["delete-account-email"], confirm = app.buttons["delete-account-confirm"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    XCTAssertFalse(confirm.isEnabled)
    field.tap(); field.typeText(" SAM@example.com ")
    XCTAssertTrue(confirm.wait(for: \.isEnabled, toEqual: true, timeout: 5)); confirm.tap()
    XCTAssertTrue(app.staticTexts["Your account is deleted"].waitForExistence(timeout: 20))
    app.buttons["delete-account-done"].tap()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["sign-out"].exists || app.buttons["delete-account"].exists)
    XCTAssertTrue(app.staticTexts["Not signed in"].exists)
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10))
  }
}
