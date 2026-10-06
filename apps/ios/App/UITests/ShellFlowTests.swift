import XCTest

@MainActor final class ShellFlowTests: XCTestCase {
  func launch(_ board: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board]
    app.launch()
    return app
  }

  func switchRoom(_ room: String, in app: XCUIApplication) {
    let menu = app.buttons.matching(NSPredicate(format: "identifier == %@ AND enabled == true", "room-menu")).firstMatch
    XCTAssertTrue(menu.waitForExistence(timeout: 10))
    menu.tap()
    let item = app.buttons.matching(NSPredicate(format: "identifier == %@ AND enabled == true", "room-\(room.lowercased())")).firstMatch
    XCTAssertTrue(item.waitForExistence(timeout: 5))
    item.tap()
    let selected = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label == %@", "room-menu", room)).firstMatch
    XCTAssertTrue(selected.waitForExistence(timeout: 10))
    XCTAssertEqual(menu.label, room)
  }

  func assertGym(_ app: XCUIApplication) {
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["room-menu"].label, "Gym")
    XCTAssertTrue(app.tabBars.buttons["Routines"].exists)
    XCTAssertTrue(app.tabBars.buttons["The log"].exists)
    XCTAssertTrue(app.tabBars.buttons["Coach"].exists)
  }

  func testSwitchRoomsKeepsJournalAndUsesGymTabs() {
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
    switchRoom("Journal", in: app)
    XCTAssertTrue(editor.waitForExistence(timeout: 5))
    XCTAssertEqual(editor.value as? String, page)
    XCTAssertFalse(app.tabBars.firstMatch.exists)
  }

  func testLastRoomPersistsAcrossRelaunch() {
    let app = launch("shell-last-room")
    switchRoom("Gym", in: app)
    assertGym(app)
    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    assertGym(app)
    switchRoom("Journal", in: app)
    app.terminate()
    app.launch()
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["room-menu"].label, "Journal")
  }

  func testAnonymousGymDoorOpensWithoutSigningIn() {
    let app = launch("shell-anonymous")
    XCTAssertTrue(app.staticTexts["Where to start?"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["open-journal"].exists)
    app.buttons["open-gym"].tap()
    assertGym(app)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "gym-anonymous-room"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    XCTAssertFalse(app.buttons["email-sign-in"].exists)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["sign-out"].exists)
  }

  func testSignInWithBothRoomsAsksEachCountBeforeBinding() {
    let app = launch("shell-adoption-two-rooms")
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10))
    app.buttons["email-sign-in"].tap()
    let email = app.textFields["email-address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5))
    email.tap(); email.typeText("shell@example.com")
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5))
    code.tap(); code.typeText("482913")
    let adoption = app.alerts["Add to your account?"]
    XCTAssertTrue(adoption.waitForExistence(timeout: 15))
    XCTAssertTrue(adoption.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Journal · 1 page")).firstMatch.exists)
    adoption.buttons["Add"].tap()
    let gymQuestion = adoption.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Gym · 1 routine")).firstMatch
    XCTAssertTrue(gymQuestion.waitForExistence(timeout: 10))
    adoption.buttons["Discard"].tap()
    let discard = app.alerts["Discard 1 routine?"]
    XCTAssertTrue(discard.waitForExistence(timeout: 5))
    discard.buttons["Cancel"].tap()
    XCTAssertTrue(gymQuestion.waitForExistence(timeout: 5))
    adoption.buttons["Discard"].tap()
    XCTAssertTrue(discard.waitForExistence(timeout: 5))
    discard.buttons["Discard"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 15))
    XCTAssertFalse(adoption.exists)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["sign-out"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["shell@example.com"].exists)
  }
}
