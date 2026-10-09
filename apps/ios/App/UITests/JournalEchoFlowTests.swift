import XCTest

@MainActor final class JournalEchoFlowTests: XCTestCase {
  var today: String { day(offset: 0) }
  var firstSource: String { day(offset: -120) }
  var secondSource: String { day(offset: -240) }
  let sourceQuote = "The long walk home helped me notice the evening."

  func day(offset: Int) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    let date = calendar.date(byAdding: .day, value: offset, to: Date(timeIntervalSince1970: 1_790_424_000))!
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
  }

  func launch(_ appearance: String, board: String = "journal-echoes", layout: Bool = false) -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board]
    app.launchEnvironment["WM_IOS_ECHO_APPEARANCE"] = appearance
    if layout { app.launchArguments.append("-journal-layout-test") }
    app.launch()
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.staticTexts["Couldn't prepare the echo fixture."].exists)
    return app
  }

  func capture(_ name: String, _ app: XCUIApplication) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    if let path = ProcessInfo.processInfo.environment["WM_IOS_ECHO_SHOTS"] {
      let directory = URL(fileURLWithPath: path, isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: directory.appendingPathComponent(name + ".png"))
    }
  }

  func reveal(_ element: XCUIElement, in app: XCUIApplication, towardTop: Bool = false) {
    XCTAssertTrue(element.waitForExistence(timeout: 10))
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
    let geometry = XCTAttachment(string: "control: \(element.frame)\nvisible scroll view: \(viewport)\nlast samples: \(samples.suffix(8))")
    geometry.name = "echo-control-visibility"; geometry.lifetime = .keepAlways; add(geometry)
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: element)], timeout: 3), .completed,
                   "Echo control must settle, fit in the visible scroll view, and retain its 44-point height")
  }

  func sourceMetrics(_ source: XCUIElement) -> [String: Any]? {
    guard let value = source.value as? String else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(value.utf8))) as? [String: Any]
  }

  func assertSourcePassageCentered(in app: XCUIApplication, appearance: String, quote: String? = nil) throws {
    XCTAssertTrue(app.buttons["echo-close"].waitForNonExistence(timeout: 5))
    let source = app.textViews["journal-body-\(firstSource)"]
    XCTAssertTrue(source.waitForExistence(timeout: 5))
    let viewport = app.scrollViews.firstMatch.frame.intersection(app.frame)
    let centered = NSPredicate { _, _ in
      guard let metrics = self.sourceMetrics(source), let rect = metrics["echoRect"] as? [Double], rect.count == 4 else { return false }
      return rect[2] > 0 && rect[3] > 0 && abs(rect[1] + rect[3] / 2 - viewport.midY) <= max(44, rect[3])
    }
    if !centered.evaluate(with: source) {
      let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: centered, object: source)], timeout: 5)
      if result != .completed {
        let evidence = XCTAttachment(string: "source: \(source.value ?? "missing")\nviewport: \(viewport)")
        evidence.name = "echo-source-position-failure"; evidence.lifetime = .keepAlways; add(evidence)
      }
      XCTAssertEqual(result, .completed)
    }
    let metrics = try XCTUnwrap(sourceMetrics(source))
    let body = try XCTUnwrap(metrics["text"] as? String) as NSString
    let range = try XCTUnwrap(metrics["echoRange"] as? [Int])
    let rect = try XCTUnwrap(metrics["echoRect"] as? [Double])
    guard range.count == 2, rect.count == 4 else { XCTFail("Invalid source passage geometry"); return }
    let expectedQuote = quote ?? sourceQuote
    XCTAssertEqual(range, [body.range(of: expectedQuote, options: .literal).location, (expectedQuote as NSString).length])
    XCTAssertGreaterThan(range[0], 2_000, "The fixture quote must be far below the source page's opening")
    XCTAssertEqual(metrics["editable"] as? Bool, false)
    XCTAssertEqual(metrics["focused"] as? Bool, false)
    XCTAssertGreaterThanOrEqual(rect[1], viewport.minY)
    XCTAssertLessThanOrEqual(rect[1] + rect[3], viewport.maxY)
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    XCTAssertTrue(app.descendants(matching: .any)["echo-trail"].exists)
    let geometry = XCTAttachment(string: "range: \(range)\nquote first line: \(rect)\nvisible canvas: \(viewport)")
    geometry.name = "echo-source-geometry-\(appearance)"; geometry.lifetime = .keepAlways; add(geometry)
  }

  func flow(_ appearance: String) throws {
    let app = launch(appearance, layout: true)
    let disclosure = app.buttons["journal-echo-\(today)"]
    reveal(disclosure, in: app, towardTop: true)
    XCTAssertEqual(disclosure.label, "2 passages you wrote before")
    XCTAssertGreaterThanOrEqual(disclosure.frame.height, 44)
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    try capture("night-canvas-echo-collapsed-sheet-\(appearance)", app)

    disclosure.tap()
    let open = app.buttons["echo-open-\(firstSource)"]
    reveal(open, in: app)
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    XCTAssertTrue(app.staticTexts["from your voice note"].exists)
    XCTAssertTrue(app.staticTexts["something you copied down"].exists)
    XCTAssertFalse(app.buttons["write-today"].isHittable)
    try capture("echo-opened-\(appearance)", app)

    let useful = app.buttons["echo-useful-\(firstSource)"]
    reveal(useful, in: app); useful.tap()
    let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Selected"), object: useful)
    XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed)
    try capture("echo-useful-\(appearance)", app)
    reveal(open, in: app, towardTop: true); open.tap()
    try assertSourcePassageCentered(in: app, appearance: appearance)
    try capture("night-canvas-echo-source-trail-sheet-\(appearance)", app)

    let back = app.buttons["echo-back-to-tonight"]
    XCTAssertTrue(back.isHittable); back.tap()
    XCTAssertTrue(back.waitForNonExistence(timeout: 5))
    reveal(disclosure, in: app, towardTop: true); disclosure.tap()
    reveal(useful, in: app)
    XCTAssertEqual(useful.value as? String, "Selected")
    let dismiss = app.buttons["echo-dismiss-\(firstSource)"]
    reveal(dismiss, in: app); dismiss.tap()
    XCTAssertTrue(open.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["echo-open-\(secondSource)"].exists)
    try capture("echo-one-dismissed-\(appearance)", app)
    let dismissPage = app.buttons["echo-dismiss-page"]
    reveal(dismissPage, in: app); dismissPage.tap()
    XCTAssertTrue(disclosure.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["echo-close"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["write-today"].wait(for: \.isHittable, toEqual: true, timeout: 5))
    try capture("night-canvas-echo-dismissed-sheet-\(appearance)", app)
    app.terminate()
  }

  func testLightEchoOpensSourceAndAcceptsFeedback() throws { try flow("light") }
  func testDarkEchoOpensSourceAndAcceptsFeedback() throws { try flow("dark") }

  func testEquivalentSourceEditKeepsReadNavigationAndRealEditRetractsEcho() throws {
    for appearance in ["light", "dark"] {
      let decomposed = appearance == "dark"
      let app = launch(appearance, board: decomposed ? "journal-echoes-unicode-decomposed" : "journal-echoes-unicode", layout: true)
      let disclosure = app.buttons["journal-echo-\(today)"]
      reveal(disclosure, in: app, towardTop: true); disclosure.tap()
      let useful = app.buttons["echo-useful-\(firstSource)"]
      reveal(useful, in: app); useful.tap()
      let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Selected"), object: useful)
      XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed)
      let open = app.buttons["echo-open-\(firstSource)"]
      reveal(open, in: app, towardTop: true); open.tap()
      let quote = decomposed ? "I remembered the cafe\u{301} by the river." : "I remembered the café by the river."
      try assertSourcePassageCentered(in: app, appearance: "unicode-\(appearance)", quote: quote)
      let source = app.textViews["journal-body-\(firstSource)"]
      let text = try XCTUnwrap(sourceMetrics(source)?["text"] as? String)
      let expected = decomposed ? text.decomposedStringWithCanonicalMapping : text.precomposedStringWithCanonicalMapping
      XCTAssertEqual(Array(text.utf8), Array(expected.utf8), "The text view must contain the current source bytes")
      try capture("night-canvas-echo-unicode-source-sheet-\(appearance)", app)
      app.buttons["echo-back-to-tonight"].tap()
      reveal(disclosure, in: app, towardTop: true); disclosure.tap()
      let changeWords = app.buttons["echo-useful-\(secondSource)"]
      reveal(changeWords, in: app); changeWords.tap()
      XCTAssertTrue(open.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.buttons["echo-open-\(secondSource)"].exists)
      XCTAssertTrue(app.staticTexts["1 passage you wrote before"].exists)
      try capture("echo-unicode-real-edit-retracted-\(appearance)", app)
      app.terminate()
    }
  }

  func silentWriting(_ board: String, appearance: String, empty: Bool) throws {
    let app = launch(appearance, board: board)
    let editor = app.textViews["journal-editor"]
    let initial = editor.value as? String ?? ""
    if empty { XCTAssertEqual(initial, "") }
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "journal-echo-")).count, 0)
    XCTAssertFalse(app.descendants(matching: .any)["echo-sheet"].exists)
    XCTAssertFalse(app.staticTexts["No echo on this page."].exists)
    try capture("night-canvas-echo-\(empty ? "empty" : "offline")-sheet-\(appearance)", app)
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.wait(for: \.isHittable, toEqual: true, timeout: 5)); write.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    let addition = empty ? "One quiet line." : " Another line stays here."
    app.typeText(addition)
    let typed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", initial + addition), object: editor)
    XCTAssertEqual(XCTWaiter.wait(for: [typed], timeout: 5), .completed)
    app.buttons["done-writing"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    XCTAssertEqual(editor.value as? String, initial + addition)
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "journal-echo-")).count, 0)
    XCTAssertFalse(app.staticTexts["Couldn't read echoes."].exists)
    try capture("night-canvas-echo-\(empty ? "empty" : "offline")-written-sheet-\(appearance)", app)
    app.terminate()
  }

  func testOfflineEchoesStaySilentAndWritingSaves() throws {
    for appearance in ["light", "dark"] { try silentWriting("journal-echoes-offline", appearance: appearance, empty: false) }
  }

  func testEmptyJournalHasNoEchoAndAcceptsFirstLine() throws {
    for appearance in ["light", "dark"] { try silentWriting("journal-echoes-empty", appearance: appearance, empty: true) }
  }

  func testAccessibleTextAndReducedMotionKeepEchoActionsReachable() throws {
    for appearance in ["light", "dark"] {
      let app = launch(appearance, board: "journal-echoes-AX3-RM", layout: true)
      let disclosure = app.buttons["journal-echo-\(today)"]
      reveal(disclosure, in: app, towardTop: true)
      XCTAssertEqual(disclosure.label, "2 passages you wrote before")
      disclosure.tap()
      let open = app.buttons["echo-open-\(firstSource)"]
      reveal(open, in: app)
      XCTAssertGreaterThanOrEqual(open.frame.height, 44)
      XCTAssertLessThanOrEqual(open.frame.maxX, app.frame.maxX)
      XCTAssertGreaterThanOrEqual(open.frame.minX, app.frame.minX)
      try capture("echo-opened-ax3-rm-\(appearance)", app)
      let useful = app.buttons["echo-useful-\(firstSource)"]
      reveal(useful, in: app)
      XCTAssertGreaterThanOrEqual(useful.frame.height, 44)
      let dismiss = app.buttons["echo-dismiss-\(firstSource)"]
      reveal(dismiss, in: app)
      XCTAssertGreaterThanOrEqual(dismiss.frame.height, 44)
      try capture("echo-actions-ax3-rm-\(appearance)", app)
      reveal(open, in: app, towardTop: true); open.tap()
      try assertSourcePassageCentered(in: app, appearance: "ax3-rm-\(appearance)")
      let back = app.buttons["echo-back-to-tonight"]
      XCTAssertTrue(back.isHittable)
      XCTAssertGreaterThanOrEqual(back.frame.height, 44)
      XCTAssertLessThanOrEqual(back.frame.maxX, app.frame.maxX)
      XCTAssertGreaterThanOrEqual(back.frame.minX, app.frame.minX)
      try capture("night-canvas-echo-source-trail-ax3-rm-sheet-\(appearance)", app)
      back.tap()
      XCTAssertTrue(back.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.textViews["journal-editor"].wait(for: \.isHittable, toEqual: true, timeout: 5))
      XCTAssertFalse(app.keyboards.firstMatch.exists)
      try capture("night-canvas-echo-returned-ax3-rm-sheet-\(appearance)", app)
      app.terminate()
    }
  }
}
