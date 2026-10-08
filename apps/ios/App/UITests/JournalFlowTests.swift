import XCTest

@MainActor final class JournalFlowTests: XCTestCase {
  func testEmptyPageTapBelowTextOpensKeyboardAtEnd() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "05-journal-first-open", "-journal-layout-test"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, "")
    assertInkVisible(true, in: editor)
    XCTAssertEqual(editor.label, "Today's page")
    XCTAssertGreaterThanOrEqual(editor.frame.height, 76.5)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "journal-empty"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let point = editor.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.95))
    point.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    assertCaretAtEnd(in: editor)
    assertInkVisible(false, in: editor)
    app.typeText("A new line.")
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, "A new line.")
    app.buttons["done-writing"].tap()
    app.descendants(matching: .any)["journal-date"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    assertCaretAtEnd(in: editor)
    app.typeText(" More.")
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, "A new line. More.")
  }

  func testInkNeverReturnsAfterUntouchedFirstOpenRelaunch() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "05-journal-first-open", "-journal-layout-test"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    assertInkVisible(true, in: editor)
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    XCTAssertFalse(app.buttons["show-ink-notes"].exists)
    XCTAssertFalse(app.buttons["Show ink notes"].exists)
    app.terminate()
    app.launchArguments += ["-restore-board"]
    app.launch()
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    assertInkVisible(false, in: editor)
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, "")
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["about-windmill"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["show-ink-notes"].exists)
    XCTAssertFalse(app.buttons["Show ink notes"].exists)
    app.buttons["Done"].tap()
    XCTAssertTrue(editor.waitForExistence(timeout: 5))
    assertInkVisible(false, in: editor)
  }

  func testWriteSeatLiftsInkAndPreservesEachTypedCharacter() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "05-journal-first-open", "-journal-layout-test"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    assertInkVisible(true, in: editor)
    app.buttons["write-today"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    assertInkVisible(false, in: editor)
    var written = ""
    for character in "One line.\nAnother line." {
      app.typeText(String(character))
      written.append(character)
      XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, written)
      assertCaretAtEnd(in: editor)
    }
    app.buttons["done-writing"].tap()
    assertInkVisible(false, in: editor)
    app.terminate()
    app.launchArguments += ["-restore-board"]
    app.launch()
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    assertInkVisible(false, in: editor)
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, written)
    app.descendants(matching: .any)["journal-date"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    assertCaretAtEnd(in: editor)
    app.typeText(" More.")
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, written + " More.")
  }

  func testOneLinePageTapBelowTextOpensKeyboardAtEnd() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "journal-one-line", "-journal-layout-test"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, "Short walk, then an early night.")
    assertInkVisible(false, in: editor)
    XCTAssertGreaterThanOrEqual(editor.frame.height, 76.5)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "journal-one-line"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let point = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: editor.frame.maxX - 1, dy: editor.frame.maxY + 12))
    point.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    assertCaretAtEnd(in: editor)
    app.typeText(" Appended.")
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, "Short walk, then an early night. Appended.")
    app.buttons["done-writing"].tap()
    editor.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.1)).tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    assertCaretAtEnd(in: editor)
    app.typeText(" At the end.")
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, "Short walk, then an early night. Appended. At the end.")
    app.buttons["done-writing"].tap()
    app.descendants(matching: .any)["journal-date"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    assertCaretAtEnd(in: editor)
    app.typeText(" Again.")
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, "Short walk, then an early night. Appended. At the end. Again.")
  }

  func testFocusedOneLinePageTapsBelowTextMoveCaretToEnd() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "journal-one-line", "-journal-layout-test"]
    app.launch()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    app.buttons["write-today"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    assertCaretAtEnd(in: editor)
    for (fraction, belowLine) in [(0.01, 4.0), (0.5, 4.0), (0.99, 4.0), (0.01, 30.0), (0.5, 30.0), (0.99, 30.0)] {
      try tapIntoLastLine(in: app)
      let metrics = try XCTUnwrap(journalMetrics(in: editor))
      let lastLine = try XCTUnwrap(metrics["lastLine"] as? [Double])
      guard lastLine.count == 4 else { XCTFail("Invalid lastLine rectangle: \(lastLine)"); return }
      let visibleBottom = min(editor.frame.maxY, app.scrollViews.firstMatch.frame.maxY) - 1
      let tapY = min(lastLine[1] + lastLine[3] + belowLine, visibleBottom)
      XCTAssertGreaterThan(tapY, lastLine[1] + lastLine[3])
      let viewport = app.scrollViews.firstMatch.frame
      app.coordinate(withNormalizedOffset: .zero).withOffset(
        CGVector(dx: viewport.minX + viewport.width * fraction,
                 dy: tapY)).tap()
      assertCaretAtEnd(in: editor)
    }
    app.typeText(" Appended.")
    XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, "Short walk, then an early night. Appended.")
  }

  func testRoomMenuListsBothRoomsAndTopRightYouStillOpensSettings() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "05-journal-first-open", "-journal-layout-test"]
    app.launch()
    let roomMenu = app.buttons["room-menu"]
    XCTAssertTrue(roomMenu.waitForExistence(timeout: 10))
    XCTAssertEqual(roomMenu.label, "Journal")
    let editor = app.textViews["journal-editor"]
    assertInkVisible(true, in: editor)
    XCTAssertFalse(app.buttons["show-ink-notes"].exists)
    XCTAssertFalse(app.buttons["Show ink notes"].exists)
    let frame = roomMenu.frame
    roomMenu.tap()
    XCTAssertTrue(app.buttons["room-journal"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["room-gym"].exists)
    XCTAssertFalse(app.buttons["about-windmill"].exists)
    app.buttons["room-journal"].tap()
    XCTAssertEqual(roomMenu.frame, frame)
    assertInkVisible(false, in: editor)
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    roomMenu.tap()
    let showInk = app.buttons["Show ink notes"]
    XCTAssertTrue(showInk.waitForExistence(timeout: 5))
    showInk.tap()
    assertInkVisible(true, in: editor)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "room-menu"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["about-windmill"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["show-ink-notes"].exists)
    XCTAssertFalse(app.buttons["Show ink notes"].exists)
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
    app.buttons["room-menu"].tap()
    app.buttons["room-journal"].tap()
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
    let editor = app.textViews["journal-editor"]
    for addition in ["First filled line.\nSecond filled line.\nThird filled line.",
                     String(repeating: "\nA longer page keeps the caret clear of the Done seat.", count: 12), "\n"] {
      assertCaretAtEnd(in: editor)
      app.typeText(addition)
      try assertWritingClearsSeat(in: app)
      try tapIntoLastLine(in: app)
      let metrics = try XCTUnwrap(journalMetrics(in: editor))
      let lastLine = try XCTUnwrap(metrics["lastLine"] as? [Double])
      guard lastLine.count == 4 else { XCTFail("Invalid lastLine rectangle: \(lastLine)"); return }
      let visibleBottom = min(editor.frame.maxY, app.scrollViews.firstMatch.frame.maxY) - 1
      let tapY = min(lastLine[1] + lastLine[3] + 4, visibleBottom)
      XCTAssertGreaterThan(tapY, lastLine[1] + lastLine[3])
      app.coordinate(withNormalizedOffset: .zero).withOffset(
        CGVector(dx: editor.frame.minX + 1, dy: tapY)).tap()
      assertCaretAtEnd(in: editor)
      XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, metrics["text"] as? String)
      try tapIntoLastLine(in: app)
      let bottom = app.scrollViews.firstMatch.frame.maxY - 1
      XCTAssertGreaterThan(bottom, lastLine[1] + lastLine[3])
      app.coordinate(withNormalizedOffset: .zero).withOffset(
        CGVector(dx: editor.frame.maxX - 1, dy: bottom)).tap()
      assertCaretAtEnd(in: editor)
    }
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "journal-long-writing"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    done.tap()
    XCTAssertTrue(write.waitForExistence(timeout: 5))
  }

  func journalMetrics(in editor: XCUIElement) -> [String: Any]? {
    guard let value = editor.value as? String else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(value.utf8))) as? [String: Any]
  }

  func assertInkVisible(_ visible: Bool, in editor: XCUIElement,
                        file: StaticString = #filePath, line: UInt = #line) {
    let ready = NSPredicate { _, _ in self.journalMetrics(in: editor)?["inkVisible"] as? Bool == visible }
    if ready.evaluate(with: editor) { return }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: editor)], timeout: 5), .completed,
                   "Expected ink visibility \(visible): \(editor.value ?? "missing editor value")", file: file, line: line)
  }

  func tapIntoLastLine(in app: XCUIApplication,
                       file: StaticString = #filePath, line: UInt = #line) throws {
    let editor = app.textViews["journal-editor"]
    let metrics = try XCTUnwrap(journalMetrics(in: editor), file: file, line: line)
    let rect = try XCTUnwrap(metrics["lastLine"] as? [Double], file: file, line: line)
    guard rect.count == 4 else { XCTFail("Invalid lastLine rectangle: \(rect)", file: file, line: line); return }
    app.coordinate(withNormalizedOffset: .zero).withOffset(
      CGVector(dx: rect[0] + rect[2] / 4, dy: rect[1] + rect[3] / 2)).tap()
    let insideText = NSPredicate { _, _ in
      guard let metrics = self.journalMetrics(in: editor),
            let selection = metrics["selection"] as? [Int], selection.count == 2,
            let length = metrics["textLength"] as? Int else { return false }
      return metrics["focused"] as? Bool == true && selection[0] < length
    }
    if insideText.evaluate(with: editor) { return }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: insideText, object: editor)], timeout: 5), .completed,
                   "Expected selection inside text: \(editor.value ?? "missing editor value")", file: file, line: line)
  }

  func assertCaretAtEnd(in editor: XCUIElement,
                        file: StaticString = #filePath, line: UInt = #line) {
    let ready = NSPredicate { _, _ in
      guard let metrics = self.journalMetrics(in: editor),
            let selection = metrics["selection"] as? [Int],
            let length = metrics["textLength"] as? Int else { return false }
      return metrics["focused"] as? Bool == true && selection == [length, 0]
    }
    if ready.evaluate(with: editor) { return }
    let expectation = XCTNSPredicateExpectation(predicate: ready, object: editor)
    XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed,
                   "Expected focused caret at end: \(editor.value ?? "missing editor value")", file: file, line: line)
  }

  func assertWritingClearsSeat(in app: XCUIApplication,
                             file: StaticString = #filePath, line: UInt = #line) throws {
    let editor = app.textViews["journal-editor"]
    let done = app.buttons["done-writing"]
    let visibleTop = app.scrollViews.firstMatch.frame.minY
    let value = try XCTUnwrap(editor.value as? String, file: file, line: line)
    let metrics = try XCTUnwrap(journalMetrics(in: editor), file: file, line: line)
    let geometry = XCTAttachment(string: "\(value)\neditor: \(editor.frame)\nseat: \(done.frame)")
    geometry.name = "journal-writing-geometry"
    geometry.lifetime = .keepAlways
    add(geometry)
    for name in ["caret", "lastLine"] {
      let rect = try XCTUnwrap(metrics[name] as? [Double], file: file, line: line)
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

  func testLargestTextKeepsNativeJournalControlsReachable() {
    let app = XCUIApplication()
    app.launchArguments = ["-board", "05-journal-first-open"]
    app.launch()
    XCTAssertTrue(app.buttons["room-menu"].waitForExistence(timeout: 10))
    let writeSize = app.buttons["write-today"].frame.size
    let bodyHeight = app.textViews["journal-editor"].frame.height
    app.terminate()
    app.launchArguments = ["-board", "05-journal-first-open-AX3"]
    app.launch()
    XCTAssertTrue(app.buttons["room-menu"].waitForExistence(timeout: 10))
    let room = app.buttons["room-menu"]
    let account = app.buttons["you"]
    XCTAssertTrue(room.isHittable)
    XCTAssertTrue(account.isHittable)
    XCTAssertTrue(app.frame.contains(room.frame))
    XCTAssertTrue(app.frame.contains(account.frame))
    XCTAssertFalse(room.frame.intersects(account.frame))
    XCTAssertEqual(app.buttons["write-today"].frame.size, writeSize)
    XCTAssertGreaterThan(app.textViews["journal-editor"].frame.height, bodyHeight)
    XCTAssertEqual(app.buttons["room-menu"].label, "Journal")
    XCTAssertEqual(app.buttons["you"].label, "You and settings")
  }
  func testPausedBackupOffersSameAccountEmailReauthentication() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "paused-backup"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Backup is paused. Sign in again to resume."].waitForExistence(timeout: 30))
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
