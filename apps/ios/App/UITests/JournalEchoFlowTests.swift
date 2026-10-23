import XCTest

@MainActor final class JournalEchoFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // Today's count opens the ink above the seat, Useful answers it, the reader holds the rest, a passage flies to its
  // source and back to tonight, the keyboard closes the ink, and Not useful retires the page's echo.
  func testLightEchoOpensSourceAndAcceptsFeedback() throws {
    let canvas = EchoCanvas.launch("light", layout: true), app = canvas.app
    let disclosure = app.buttons["journal-echo-\(EchoCanvas.today)"]
    canvas.reveal(disclosure, towardTop: true)
    XCTAssertEqual(disclosure.label, "3 passages you wrote before")
    XCTAssertGreaterThanOrEqual(disclosure.frame.height, 44)
    XCTAssertFalse(app.keyboards.firstMatch.exists)

    let dateRow = app.descendants(matching: .any)["journal-date"]
    let closed = dateRow.frame
    disclosure.tap()
    let open = app.buttons["echo-open-\(EchoCanvas.firstSource)"]
    XCTAssertTrue(open.waitForExistence(timeout: 5))
    // The ink opens below the page; the page above moves only as far as the ink's end needs to stand 16 pt above the write seat.
    let end = app.buttons["echo-more"], seat = app.buttons["write-today"]
    let cleared = NSPredicate { _, _ in
      end.frame.maxY <= seat.frame.minY - 16 + 1 && dateRow.frame.minY <= closed.minY + 1 &&
        (abs(dateRow.frame.minY - closed.minY) <= 1 || abs(end.frame.maxY - (seat.frame.minY - 16)) <= 2)
    }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: cleared, object: nil)], timeout: 5), .completed,
                   "The ink ends 16 pt above the seat: \(end.frame) over \(seat.frame); the date row from \(closed.minY) to \(dateRow.frame.minY)")
    canvas.reveal(open)
    XCTAssertTrue(app.buttons["echo-open-\(EchoCanvas.secondSource)"].exists)
    XCTAssertFalse(app.buttons["echo-open-\(EchoCanvas.thirdSource)"].exists, "The ink shows two passages; the reader holds the rest")
    XCTAssertTrue(open.label.contains("from your voice note"))
    XCTAssertTrue(app.buttons["echo-open-\(EchoCanvas.secondSource)"].label.contains("something you copied down"))
    XCTAssertTrue(app.buttons["write-today"].isHittable)
    disclosure.tap()
    XCTAssertTrue(open.waitForNonExistence(timeout: 5), "Tapping the count again closes the ink")
    disclosure.tap()
    canvas.reveal(open)

    let useful = app.buttons["echo-useful-page"]
    canvas.reveal(useful); useful.tap()
    let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Selected"), object: useful)
    XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed)

    let more = app.buttons["echo-more"]
    canvas.reveal(more); more.tap()
    let reader = app.scrollViews["echo-sheet"]
    XCTAssertTrue(reader.waitForExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars["From your journal"].exists)
    XCTAssertTrue(app.buttons["echo-read-\(EchoCanvas.thirdSource)"].waitForExistence(timeout: 5))
    app.buttons["echo-close"].tap()
    XCTAssertTrue(reader.waitForNonExistence(timeout: 5))

    canvas.reveal(open, towardTop: true); open.tap()
    try canvas.assertSourcePassageCentered()
    XCTAssertFalse(open.exists, "Reading a source closes the ink")

    let back = app.buttons["echo-back-to-tonight"]
    XCTAssertTrue(back.isHittable); back.tap()
    XCTAssertTrue(back.waitForNonExistence(timeout: 5))
    canvas.reveal(disclosure, towardTop: true); disclosure.tap()
    canvas.reveal(useful)
    XCTAssertEqual(useful.value as? String, "Selected")
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.wait(for: \.isHittable, toEqual: true, timeout: 5)); write.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(open.waitForNonExistence(timeout: 5), "The keyboard closes the ink")
    XCTAssertFalse(disclosure.exists, "Today's count does not draw while writing")
    app.buttons["done-writing"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    canvas.reveal(disclosure, towardTop: true); disclosure.tap()
    let notUseful = app.buttons["echo-dismiss-page"]
    canvas.reveal(notUseful); notUseful.tap()
    XCTAssertTrue(disclosure.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["write-today"].wait(for: \.isHittable, toEqual: true, timeout: 5))
  }
}
