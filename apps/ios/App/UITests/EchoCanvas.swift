import XCTest

// The journal canvas of the echo boards as the echo flows read it: the fixture's days, and settling a control into view
// before a tap, and checking that a passage flew to its source.
@MainActor struct EchoCanvas {
  let app: XCUIApplication
  static let sourceQuote = "The long walk home helped me notice the evening."
  static var today: String { day(offset: 0) }
  static var firstSource: String { day(offset: -120) }
  static var secondSource: String { day(offset: -240) }
  static var thirdSource: String { day(offset: -400) }

  static func day(offset: Int) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    let date = calendar.date(byAdding: .day, value: offset, to: Date(timeIntervalSince1970: 1_790_424_000))!
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
  }

  static func launch(_ appearance: String, board: String = "journal-echoes", layout: Bool = false, arguments: [String] = []) -> EchoCanvas {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board, "-onboarding-appearance", appearance] + arguments
    if layout { app.launchArguments.append("-journal-layout-test") }
    app.launch()
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.staticTexts["Couldn't prepare the echo fixture."].exists)
    return EchoCanvas(app: app)
  }

  // Scrolls until the control stands whole in the visible scroll view, at least 44 pt tall, and has stopped moving.
  func reveal(_ element: XCUIElement, towardTop: Bool = false, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(element.waitForExistence(timeout: 10), file: file, line: line)
    let sheet = app.scrollViews["echo-sheet"]
    let scroller = sheet.exists ? sheet : app.scrollViews.firstMatch
    var previous = CGRect.null
    var stableSince = Date()
    var viewport = CGRect.null
    var samples: [String] = []
    let ready = NSPredicate { _, _ in
      // A snapshot the busy app could not serve says nothing about movement, so it keeps the stable run.
      guard let frame = (try? element.snapshot())?.frame else { samples.append("no snapshot"); return false }
      samples.append("\(frame)")
      guard frame.height >= 44, viewport.contains(frame) else {
        previous = .null; return false
      }
      // Between samples a scrolling page moves by points; a fraction of a point is not movement.
      if abs(frame.minX - previous.minX) >= 1 || abs(frame.minY - previous.minY) >= 1 ||
          abs(frame.width - previous.width) >= 1 || abs(frame.height - previous.height) >= 1 {
        previous = frame; stableSince = Date(); return false
      }
      return Date().timeIntervalSince(stableSince) >= 0.3
    }
    for _ in 0..<8 {
      viewport = scroller.frame.intersection(app.frame)
      let frame = element.frame
      if viewport.contains(frame) {
        let settled = XCTNSPredicateExpectation(predicate: ready, object: element)
        if XCTWaiter.wait(for: [settled], timeout: 3) == .completed { return }
        continue
      }
      let direction: CGFloat = frame.isEmpty ? (towardTop ? -1 : 1) : (frame.midY < viewport.midY ? -1 : 1)
      let distance = min(max(abs(frame.midY - viewport.midY), 80), viewport.height * 0.4)
      let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: viewport.midX, dy: viewport.midY))
      let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: viewport.midX, dy: viewport.midY - direction * distance))
      start.press(forDuration: 0.05, thenDragTo: end)
    }
    viewport = scroller.frame.intersection(app.frame)
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: element)], timeout: 3), .completed,
                   "Echo control must settle, fit in the visible scroll view \(viewport), and retain its 44-point height: \(samples.suffix(8))",
                   file: file, line: line)
  }

  func sourceMetrics(_ source: XCUIElement) -> [String: Any]? {
    guard let value = source.value as? String else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(value.utf8))) as? [String: Any]
  }

  // The first source page stands read-only with the quotation, far below its opening, centred in the visible canvas.
  func assertSourcePassageCentered(file: StaticString = #filePath, line: UInt = #line) throws {
    XCTAssertTrue(app.buttons["echo-close"].waitForNonExistence(timeout: 5), file: file, line: line)
    let source = app.textViews["journal-body-\(Self.firstSource)"]
    XCTAssertTrue(source.waitForExistence(timeout: 5), file: file, line: line)
    let viewport = app.scrollViews.firstMatch.frame.intersection(app.frame)
    let centered = NSPredicate { _, _ in
      guard let metrics = self.sourceMetrics(source), let rect = metrics["echoRect"] as? [Double], rect.count == 4 else { return false }
      return rect[2] > 0 && rect[3] > 0 && abs(rect[1] + rect[3] / 2 - viewport.midY) <= max(44, rect[3])
    }
    if !centered.evaluate(with: source) {
      XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: centered, object: source)], timeout: 5), .completed,
                     "source: \(source.value ?? "missing"), viewport: \(viewport)", file: file, line: line)
    }
    let metrics = try XCTUnwrap(sourceMetrics(source), file: file, line: line)
    let body = try XCTUnwrap(metrics["text"] as? String, file: file, line: line) as NSString
    let range = try XCTUnwrap(metrics["echoRange"] as? [Int], file: file, line: line)
    let rect = try XCTUnwrap(metrics["echoRect"] as? [Double], file: file, line: line)
    guard range.count == 2, rect.count == 4 else { XCTFail("Invalid source passage geometry", file: file, line: line); return }
    XCTAssertEqual(range, [body.range(of: Self.sourceQuote, options: .literal).location, (Self.sourceQuote as NSString).length],
                   file: file, line: line)
    XCTAssertGreaterThan(range[0], 2_000, "The fixture quote must be far below the source page's opening", file: file, line: line)
    XCTAssertEqual(metrics["editable"] as? Bool, false, file: file, line: line)
    XCTAssertEqual(metrics["focused"] as? Bool, false, file: file, line: line)
    XCTAssertGreaterThanOrEqual(rect[1], viewport.minY, file: file, line: line)
    XCTAssertLessThanOrEqual(rect[1] + rect[3], viewport.maxY, file: file, line: line)
    XCTAssertFalse(app.keyboards.firstMatch.exists, file: file, line: line)
    XCTAssertTrue(app.descendants(matching: .any)["echo-trail"].exists, file: file, line: line)
  }
}
