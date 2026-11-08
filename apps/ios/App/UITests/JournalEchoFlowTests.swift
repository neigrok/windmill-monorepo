import XCTest

@MainActor final class JournalEchoFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // Today's count opens one sheet of every passage at .medium, Useful answers it, a passage lowers the sheet over its
  // source with Back to tonight, Close and the count close it, and Not useful retires the page's echo.
  func testLightEchoOpensSourceAndAcceptsFeedback() throws {
    let canvas = EchoCanvas.launch("light", layout: true), app = canvas.app
    let disclosure = app.buttons["journal-echo-\(EchoCanvas.today)"]
    canvas.reveal(disclosure, towardTop: true)
    XCTAssertEqual(disclosure.label, "3 passages you wrote before")
    XCTAssertEqual(disclosure.value as? String, "Closed")
    XCTAssertGreaterThanOrEqual(disclosure.frame.height, 44)
    XCTAssertFalse(app.keyboards.firstMatch.exists)

    disclosure.tap()
    let sheet = app.descendants(matching: .any)["echo-sheet"]
    XCTAssertTrue(sheet.waitForExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars["From your journal"].exists)
    XCTAssertGreaterThan(sheet.frame.minY, app.frame.height * 0.3, "The sheet opens at .medium, the page readable above it")
    let open = app.buttons["echo-open-\(EchoCanvas.firstSource)"]
    XCTAssertTrue(open.waitForExistence(timeout: 5))
    XCTAssertTrue(open.label.contains("from your voice note"))
    XCTAssertTrue(app.buttons["echo-open-\(EchoCanvas.secondSource)"].label.contains("something you copied down"))
    XCTAssertTrue(app.buttons["echo-open-\(EchoCanvas.thirdSource)"].exists, "The sheet holds every passage; there is no reader")
    XCTAssertEqual(disclosure.value as? String, "Open")
    XCTAssertTrue(disclosure.isHittable, "The count's page stands above the sheet")
    disclosure.tap()
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5), "The count again closes the sheet")
    disclosure.tap()
    XCTAssertTrue(sheet.waitForExistence(timeout: 5))
    app.descendants(matching: .any)["journal-date"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5), "The keyboard closes the sheet")
    app.buttons["done-writing"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    canvas.reveal(disclosure, towardTop: true); disclosure.tap()
    XCTAssertTrue(sheet.waitForExistence(timeout: 5))

    let useful = app.buttons["echo-useful-page"]
    XCTAssertTrue(useful.isHittable); useful.tap()
    let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Selected"), object: useful)
    XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed)
    app.buttons["echo-close"].tap()
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))

    canvas.reveal(disclosure, towardTop: true); disclosure.tap()
    XCTAssertTrue(open.waitForExistence(timeout: 5))
    XCTAssertEqual(useful.value as? String, "Selected")
    open.tap()
    try canvas.assertSourcePassageCentered()
    XCTAssertFalse(open.exists, "Reading a source lowers the sheet to where you are")

    let back = app.buttons["echo-back-to-tonight"]
    XCTAssertTrue(back.isHittable)
    XCTAssertGreaterThanOrEqual(back.frame.height, 44)
    back.tap()
    XCTAssertTrue(back.waitForNonExistence(timeout: 5), "Back at tonight the sheet goes")
    XCTAssertTrue(app.textViews["journal-editor"].wait(for: \.isHittable, toEqual: true, timeout: 5))

    let write = app.buttons["write-today"]
    XCTAssertTrue(write.wait(for: \.isHittable, toEqual: true, timeout: 5)); write.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertFalse(disclosure.exists, "Today's count does not draw while writing")
    app.buttons["done-writing"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    canvas.reveal(disclosure, towardTop: true); disclosure.tap()
    let notUseful = app.buttons["echo-dismiss-page"]
    XCTAssertTrue(notUseful.waitForExistence(timeout: 5)); notUseful.tap()
    XCTAssertTrue(disclosure.waitForNonExistence(timeout: 5))
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["write-today"].wait(for: \.isHittable, toEqual: true, timeout: 5))
  }

  // You, reached past the open sheet, takes the screen once the sheet has stepped aside, and closing it leaves today writable.
  func testYouOverTheEchoSheetLeavesTheJournalWritable() {
    let canvas = EchoCanvas.launch("dark"), app = canvas.app
    let disclosure = app.buttons["journal-echo-\(EchoCanvas.today)"]
    canvas.reveal(disclosure, towardTop: true); disclosure.tap()
    let sheet = app.descendants(matching: .any)["echo-sheet"]
    XCTAssertTrue(sheet.waitForExistence(timeout: 5))
    app.buttons["you"].tap()
    let you = app.navigationBars["You"]
    XCTAssertTrue(you.waitForExistence(timeout: 10), "You opens over the journal")
    XCTAssertFalse(sheet.exists)
    you.buttons["Done"].tap()
    XCTAssertTrue(you.waitForNonExistence(timeout: 5))
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.wait(for: \.isHittable, toEqual: true, timeout: 10)); write.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertFalse(sheet.exists, "The echo sheet stays closed")
  }
}
