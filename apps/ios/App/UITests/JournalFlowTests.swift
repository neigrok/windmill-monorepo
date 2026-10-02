import XCTest

@MainActor final class JournalFlowTests: XCTestCase {
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
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5)); code.tap(); code.typeText("482913")
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 10))
    let backedUp = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "backed up")).firstMatch
    XCTAssertTrue(backedUp.waitForExistence(timeout: 15))
    app.buttons["you"].tap(); app.buttons["sign-out"].tap(); app.buttons["sign-out-keep"].tap()
    XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10))
    app.buttons["Sign in"].tap(); app.buttons["email-sign-in"].tap()
    XCTAssertEqual(app.textFields["email-address"].value as? String, "flow@example.com")
    app.buttons["Send code"].tap()
    XCTAssertTrue(code.waitForExistence(timeout: 5)); code.tap(); code.typeText("482913")
    XCTAssertTrue(backedUp.waitForExistence(timeout: 15))
    XCTAssertEqual(app.textViews["journal-editor"].value as? String, page)
  }

  func testLargestTextKeepsJournalChromeAtNormalSize() {
    let app = XCUIApplication()
    app.launchArguments = ["-board", "05-journal-first-open"]
    app.launch()
    XCTAssertTrue(app.buttons["room-menu"].waitForExistence(timeout: 10))
    let roomSize = app.buttons["room-menu"].frame.size
    let accountSize = app.buttons["you"].frame.size
    app.terminate()
    app.launchArguments = ["-board", "07j-a6-ink-notes-largest-text-AX3"]
    app.launch()
    XCTAssertTrue(app.buttons["room-menu"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["room-menu"].frame.size, roomSize)
    XCTAssertEqual(app.buttons["you"].frame.size, accountSize)
    XCTAssertEqual(app.buttons["room-menu"].label, "Journal room menu")
    XCTAssertEqual(app.buttons["you"].label, "You and settings")
  }
  func testPausedBackupOffersSameAccountEmailReauthentication() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "paused-backup"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Backup is paused. Sign in again to resume."].waitForExistence(timeout: 15))
    app.buttons["email-sign-in"].tap()
    let email = app.textFields["email-address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5)); email.tap(); email.typeText("apple@example.com")
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5)); code.tap(); code.typeText("482913")
    let backedUp = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "backed up")).firstMatch
    XCTAssertTrue(backedUp.waitForExistence(timeout: 15))
    XCTAssertFalse(app.staticTexts["Add your pages?"].exists)
    XCTAssertEqual(app.textViews["journal-editor"].value as? String, "Long day. The walk home was the best part — the rain had just stopped and the street smelled of it.\nI want more evenings like that.")
  }

}
