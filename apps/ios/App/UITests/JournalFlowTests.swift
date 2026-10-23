import XCTest

@MainActor final class JournalFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // Writing outlives a relaunch with its ratings; erasing every word removes the day, ratings and all, after the next one.
  func testWritingPersistsAndErasingItRemovesTheDayAfterRelaunch() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "05-journal-first-open"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    let text = "A day to remove."
    app.buttons["write-today"].tap(); app.typeText(text)
    XCTAssertTrue(editor.waitForValue(text))
    app.buttons["done-writing"].tap()
    for scale in ["Mood", "Energy"] {
      let control = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", scale)).firstMatch
      XCTAssertTrue(control.waitForExistence(timeout: 5))
      control.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)).tap()
      XCTAssertTrue(app.buttons["Clear " + scale.lowercased()].isEnabled)
    }
    app.terminate(); app.launchArguments.append("-restore-board"); app.launch()
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    XCTAssertEqual(editor.value as? String, text)
    XCTAssertTrue(app.buttons["Clear mood"].isEnabled && app.buttons["Clear energy"].isEnabled)
    app.buttons["write-today"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: text.count))
    XCTAssertTrue(editor.waitForValue(""))
    app.buttons["done-writing"].tap()
    app.terminate(); app.launch()
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    XCTAssertEqual(editor.value as? String, "")
    XCTAssertFalse(app.buttons["Clear mood"].isEnabled)
    XCTAssertFalse(app.buttons["Clear energy"].isEnabled)
    XCTAssertFalse(app.buttons["Keep it"].exists)
    XCTAssertEqual(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "journal-day-")).count, 0)
  }

  // A page written signed out is kept by an email sign-in, backed up, signed out, and comes back with the same account.
  func testAnonymousKeepEmailBackupAndSignOutReturn() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "02a-where-to-start-signed-out"]
    app.launch()
    app.buttons["open-journal"].tap()
    let editor = app.textViews["journal-editor"]
    let page = "A page for tomorrow.\nAnother evening worth remembering."
    XCTAssertTrue(editor.waitForExistence(timeout: 10)); editor.tap(); editor.typeText(page)
    app.buttons["done-writing"].tap()
    app.buttons["Not now"].tap()
    app.buttons["Keep it"].tap()
    app.buttons["email-sign-in"].tap()
    let email = app.textFields["email-address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5)); email.tap(); email.typeText("flow@example.com")
    XCTAssertTrue(email.waitForValue("flow@example.com"))
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5)); code.tap(); code.typeText("482913")
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 10))
    let backedUp = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "backed up")).firstMatch
    XCTAssertTrue(backedUp.waitForExistence(timeout: 15))
    app.buttons["you"].tap()
    XCTAssertTrue(app.staticTexts["Sam"].waitForExistence(timeout: 5), "You names the account, never You")
    XCTAssertTrue(app.staticTexts["Backed up"].waitForExistence(timeout: 15))
    app.buttons["sign-out"].tap()
    let signOut = app.alerts["Sign out?"]
    XCTAssertTrue(signOut.waitForExistence(timeout: 10))
    XCTAssertTrue(signOut.staticTexts["Your pages and log stay in your account and leave this phone."].exists)
    XCTAssertTrue(app.navigationBars["You"].exists && !app.navigationBars["Sign out"].exists, "Sign out asks once, over You")
    signOut.buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["sign-out"].waitForExistence(timeout: 5))
    app.buttons["sign-out"].tap()
    XCTAssertTrue(signOut.waitForExistence(timeout: 10))
    signOut.buttons["Sign out"].tap()
    XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10))
    app.buttons["Sign in"].tap(); app.buttons["email-sign-in"].tap()
    XCTAssertTrue(email.waitForExistence(timeout: 5))
    XCTAssertEqual(email.value as? String, "Email address", "A finished sign-out leaves the address blank, its prompt alone")
    email.tap(); email.typeText("flow@example.com")
    XCTAssertTrue(email.waitForValue("flow@example.com"))
    app.buttons["Send code"].tap()
    XCTAssertTrue(code.waitForExistence(timeout: 5)); code.tap(); code.typeText("482913")
    XCTAssertTrue(backedUp.waitForExistence(timeout: 15))
    XCTAssertEqual(app.textViews["journal-editor"].value as? String, page)
  }
}
