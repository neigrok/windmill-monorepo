import XCTest

@MainActor final class ShellFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func launch(_ board: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board]
    app.launch()
    return app
  }

  // The room menu holds the two rooms and nothing else.
  func switchRoom(_ room: String, in app: XCUIApplication) {
    let viewport = app.frame
    let menu = app.buttons.matching(NSPredicate(format: "identifier == %@ AND enabled == true", "room-menu")).firstMatch
    XCTAssertTrue(menu.waitForExistence(timeout: 10))
    XCTAssertTrue(menu.wait(for: \.isHittable, toEqual: true, timeout: 5))
    menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
    let item = app.roomItem(room)
    XCTAssertTrue(item.waitForExistence(timeout: 5))
    XCTAssertTrue(app.roomItem("Journal").exists && app.roomItem("Gym").exists)
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
