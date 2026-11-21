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

  // Shell 02a, Roadmap · iOS 01.2 and 01.5: the third door, the empty room with New Roadmap disabled, three rooms, and a relaunch.
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
    XCTAssertTrue(app.buttons["roadmap-new"].exists)
    XCTAssertFalse(app.buttons["roadmap-new"].isEnabled)
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

  // Roadmap · iOS 01.1 and 11.22a: the account's roadmap on its Board, Done folded, and what waits for its own screen disabled.
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
    for control in [app.segmentedControls.firstMatch, app.buttons["Find"], app.buttons["Sort and filter"], app.buttons["roadmap-new-step"]] {
      XCTAssertTrue(control.exists, file: file, line: line)
      XCTAssertFalse(control.isEnabled, file: file, line: line)
    }
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
    done.tap()
    XCTAssertTrue(done.waitForValue("Expanded", timeout: 5))
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
    app.roadmapStep("Leave the dock").swipeRight()
    XCTAssertFalse(complete.waitForExistence(timeout: 2), "A Locked step has no leading action")
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
    // The band keeps Undo for the hold's nine seconds: it is taken as soon as the step is seen gone.
    confirm.tap()
    XCTAssertTrue(undo.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["3 of 7 done"].waitForExistence(timeout: 5))
    undo.tap()
    XCTAssertTrue(app.staticTexts["3 of 8 done"].waitForExistence(timeout: 10))
    XCTAssertTrue(tie.waitForExistence(timeout: 5))

    // The menu lists what this build can do to the step: a Locked step has Delete Step alone.
    app.roadmapStep("Leave the dock").press(forDuration: 1)
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Complete"].exists)
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

  // Roadmap · iOS 02.15 and 01.12: a roadmap with no step asks for the first, and one with every step done opens Done.
  func testTheBoardAtItsEndsAsksForAFirstStepOrOpensDone() {
    let empty = launch("roadmap-no-steps")
    XCTAssertTrue(empty.staticTexts["Your first step"].waitForExistence(timeout: 30))
    XCTAssertTrue(empty.navigationBars["Night sailing"].exists && empty.staticTexts["No steps yet"].exists)
    XCTAssertTrue(empty.staticTexts["Give your roadmap a place to start."].exists)
    for control in [empty.buttons["roadmap-first-step"], empty.buttons["roadmap-new-step"]] {
      XCTAssertTrue(control.exists)
      XCTAssertFalse(control.isEnabled)
    }
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

  // Roadmap · iOS 10.9, for a read of the phone's copy the room cannot make: it says so and offers to try again.
  func testARoadmapThePhoneCannotReadSaysSoAndOffersToTryAgain() {
    let app = launch("roadmap-unreadable")
    XCTAssertTrue(app.staticTexts["Couldn’t load this roadmap"].waitForExistence(timeout: 30))
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
