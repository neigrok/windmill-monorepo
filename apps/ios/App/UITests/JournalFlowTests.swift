import XCTest

@MainActor final class JournalFlowTests: XCTestCase {
  func testEmptyPageTapBelowTextOpensKeyboardAtEnd() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "05-journal-first-open"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    XCTAssertEqual(editor.value as? String, "")
    XCTAssertEqual(editor.label, "Today's page")
    XCTAssertGreaterThanOrEqual(editor.frame.height, 76.5)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "journal-empty"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let point = editor.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.95))
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
    XCTAssertEqual(editor.value as? String, "Short walk, then an early night.")
    XCTAssertGreaterThanOrEqual(editor.frame.height, 76.5)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "journal-one-line"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let point = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: editor.frame.maxX - 1, dy: editor.frame.maxY + 12))
    point.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText(" Appended.")
    XCTAssertEqual(editor.value as? String, "Short walk, then an early night. Appended.")
    app.buttons["done-writing"].tap()
    editor.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.1)).tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText(" At the end.")
    XCTAssertEqual(editor.value as? String, "Short walk, then an early night. Appended. At the end.")
  }

  func testOneRoomTitleIsInertAndTopRightYouStillOpensSettings() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "05-journal-first-open"]
    app.launch()
    let title = app.staticTexts["room-name"]
    XCTAssertTrue(title.waitForExistence(timeout: 10))
    XCTAssertEqual(title.label, "Journal")
    XCTAssertFalse(app.buttons["room-menu"].exists)
    XCTAssertFalse(app.buttons["room-name"].exists)
    let frame = title.frame
    title.tap()
    XCTAssertEqual(title.frame, frame)
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    XCTAssertFalse(app.descendants(matching: .any)["journal-room-menu"].exists)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "room-title"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["about-windmill"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["write-today"].exists)
    XCTAssertFalse(app.buttons["done-writing"].exists)
  }

  func testEmptyLaterPageWriteSeatAndKeyboardSeat() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "journal-empty-later"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.waitForExistence(timeout: 10))
    XCTAssertEqual(write.label, "Write")
    XCTAssertEqual(write.frame.width, 44, accuracy: 1)
    XCTAssertEqual(write.frame.height, 44, accuracy: 1)
    XCTAssertEqual(app.frame.maxX - write.frame.maxX, 16, accuracy: 1)
    XCTAssertEqual(editor.value as? String, "")
    XCTAssertGreaterThanOrEqual(editor.frame.height, 76.5)
    XCTAssertFalse(app.staticTexts["Start anywhere. Nothing here is graded."].exists)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "journal-empty-later"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let parkedSeat = write.frame
    write.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    let done = app.buttons["done-writing"]
    XCTAssertEqual(done.label, "Done writing")
    XCTAssertEqual(done.frame.width, parkedSeat.width, accuracy: 0.5)
    XCTAssertEqual(done.frame.height, parkedSeat.height, accuracy: 0.5)
    XCTAssertEqual(done.frame.minX, parkedSeat.minX)
    // XCTest's keyboard frame excludes its prediction bar.
    XCTAssertLessThanOrEqual(done.frame.maxY, app.keyboards.firstMatch.frame.minY - 12)
    done.tap()
    XCTAssertTrue(write.waitForExistence(timeout: 5))
    XCTAssertEqual(write.frame.minY, parkedSeat.minY, accuracy: 0.5)
    XCTAssertEqual(editor.value as? String, "")
    app.descendants(matching: .any)["journal-date"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText("Today's line.")
    XCTAssertEqual(editor.value as? String, "Today's line.")
  }

  func testWriteSeatReturnsFromPastDayToToday() {
    assertWriteFromHistory(board: "journal-history", screenshotName: "journal-history")
  }

  func testReduceMotionWriteSeatReturnsFromPastDayToToday() {
    assertWriteFromHistory(board: "journal-history-RM", screenshotName: "journal-reduce-motion")
  }

  func testReduceMotionEmptyPageKeepsParkedCaretStill() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "journal-empty-later-RM"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    let parked = editor.screenshot().pngRepresentation
    app.staticTexts["room-name"].tap()
    XCTAssertEqual(editor.screenshot().pngRepresentation, parked)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "journal-reduce-motion-empty"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    app.buttons["write-today"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.buttons["done-writing"].tap()
    XCTAssertTrue(app.buttons["write-today"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    XCTAssertEqual(editor.value as? String, "")
  }

  func testReadOnlyEditorHidesWriteSeatAndIgnoresPageTap() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "journal-read-only"]
    app.launch()
    let marker = app.descendants(matching: .any)["journal-date"]
    XCTAssertTrue(marker.waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["write-today"].exists)
    XCTAssertFalse(app.buttons["done-writing"].exists)
    marker.tap()
    XCTAssertFalse(app.keyboards.firstMatch.exists)
  }

  func testCompactKeepSheetHidesWriteSeat() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "14-keep"]
    app.launch()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["write-today"].exists)
    XCTAssertFalse(app.buttons["done-writing"].exists)
  }

  func testFilledLinesStayAboveDoneSeat() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "journal-empty-later", "-journal-layout-test"]
    app.launch()
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.waitForExistence(timeout: 10))
    write.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    let done = app.buttons["done-writing"]
    for addition in ["First filled line.\nSecond filled line.\nThird filled line.",
                     String(repeating: "\nA longer page keeps the caret clear of the Done seat.", count: 12), "\n"] {
      app.typeText(addition)
      try assertWritingClearsSeat(in: app)
    }
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "journal-long-writing"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    done.tap()
    XCTAssertTrue(write.waitForExistence(timeout: 5))
  }

  func assertWritingClearsSeat(in app: XCUIApplication,
                             file: StaticString = #filePath, line: UInt = #line) throws {
    let editor = app.textViews["journal-editor"]
    let done = app.buttons["done-writing"]
    let visibleTop = app.scrollViews.firstMatch.frame.minY
    let value = try XCTUnwrap(editor.value as? String, file: file, line: line)
    let metrics = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: [Double]], file: file, line: line)
    let geometry = XCTAttachment(string: "\(value)\neditor: \(editor.frame)\nseat: \(done.frame)")
    geometry.name = "journal-writing-geometry"
    geometry.lifetime = .keepAlways
    add(geometry)
    for name in ["caret", "lastLine"] {
      let rect = try XCTUnwrap(metrics[name], file: file, line: line)
      guard rect.count == 4 else { XCTFail("Invalid \(name) rectangle: \(rect)", file: file, line: line); return }
      XCTAssertGreaterThan(rect[2], 0, file: file, line: line)
      XCTAssertGreaterThan(rect[3], 0, file: file, line: line)
      XCTAssertGreaterThanOrEqual(rect[1], visibleTop, file: file, line: line)
      XCTAssertLessThanOrEqual(rect[1] + rect[3], done.frame.minY,
                              "\(name): \(rect), editor: \(editor.frame), seat: \(done.frame)", file: file, line: line)
    }
  }

  func assertWriteFromHistory(board: String, screenshotName: String) {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    let scroll = app.scrollViews.firstMatch
    for _ in 0..<5 { scroll.swipeDown(velocity: .fast) }
    XCTAssertFalse(editor.isHittable)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = screenshotName + "-past"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.isHittable)
    write.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(editor.isHittable)
    XCTAssertTrue(app.buttons["done-writing"].exists)
    let returned = XCTAttachment(screenshot: app.screenshot())
    returned.name = screenshotName + "-today"
    returned.lifetime = .keepAlways
    add(returned)
    app.typeText(" Appended today.")
    XCTAssertEqual(editor.value as? String, "Short walk, then an early night. Appended today.")
    app.buttons["done-writing"].tap()
    XCTAssertTrue(write.waitForExistence(timeout: 5))
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    scroll.swipeDown(velocity: .fast)
    XCTAssertFalse(app.buttons["done-writing"].exists)
    XCTAssertTrue(write.isHittable)
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
    XCTAssertTrue(app.staticTexts["room-name"].waitForExistence(timeout: 10))
    let roomSize = app.staticTexts["room-name"].frame.size
    let accountSize = app.buttons["you"].frame.size
    let writeSize = app.buttons["write-today"].frame.size
    let bodyHeight = app.textViews["journal-editor"].frame.height
    app.terminate()
    app.launchArguments = ["-board", "05-journal-first-open-AX3"]
    app.launch()
    XCTAssertTrue(app.staticTexts["room-name"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts["room-name"].frame.size, roomSize)
    XCTAssertEqual(app.buttons["you"].frame.size, accountSize)
    XCTAssertEqual(app.buttons["write-today"].frame.size, writeSize)
    XCTAssertGreaterThan(app.textViews["journal-editor"].frame.height, bodyHeight)
    XCTAssertEqual(app.staticTexts["room-name"].label, "Journal")
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
