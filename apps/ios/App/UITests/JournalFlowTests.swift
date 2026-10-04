import XCTest

@MainActor final class JournalFlowTests: XCTestCase {
  func testEmptyPageTapBelowTextOpensKeyboardAtEnd() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "05-journal-first-open"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    XCTAssertEqual(editor.value as? String, "")
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "journal-empty"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let point = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 8, dy: app.frame.maxY - 52))
    XCTAssertGreaterThan(point.screenPoint.y, editor.frame.maxY + 40)
    point.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText("A new line.")
    XCTAssertEqual(editor.value as? String, "A new line.")
    app.buttons["done-writing"].tap()
    app.descendants(matching: .any)["journal-date"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText(" More.")
    XCTAssertEqual(editor.value as? String, "A new line. More.")
  }

  func testOneLinePageTapBelowTextOpensKeyboardAtEnd() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "journal-one-line"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    XCTAssertEqual(editor.value as? String, "One line.")
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "journal-one-line"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let point = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.midX, dy: app.frame.maxY - 52))
    XCTAssertGreaterThan(point.screenPoint.y, editor.frame.maxY + 40)
    point.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText(" Appended.")
    XCTAssertEqual(editor.value as? String, "One line. Appended.")
    app.buttons["done-writing"].tap()
    editor.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.1)).tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText(" At the end.")
    XCTAssertEqual(editor.value as? String, "One line. Appended. At the end.")
  }

  func testRoomMenuContainsJournalAndTopRightYouStillOpensSettings() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "05-journal-first-open"]
    app.launch()
    XCTAssertTrue(app.buttons["room-menu"].waitForExistence(timeout: 10))
    app.buttons["room-menu"].tap()
    let menu = app.descendants(matching: .any)["journal-room-menu"]
    XCTAssertEqual(menu.buttons.allElementsBoundByIndex.map(\.label), ["Journal"])
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "room-menu"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    app.buttons["Journal"].tap()
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["about-windmill"].waitForExistence(timeout: 5))
  }

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
    app.launchArguments = ["-board", "05-journal-first-open-AX3"]
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
