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
      "Read the wind, Unlocks Leave the dock, Learn to spot shifts in wind direction from the water, the telltales and the flag.",
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
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "roadmap-step", "Build, Rig the boat")).firstMatch.waitForExistence(timeout: 5))
    app.terminate()
    app.launchArguments = ["-board", "roadmap-learn-to-sail", "-restore-board", "-server", "https://offline.invalid", "-offline-fixture", "no-network"]
    app.launch()
    assertLearnToSailBoard(app)
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
