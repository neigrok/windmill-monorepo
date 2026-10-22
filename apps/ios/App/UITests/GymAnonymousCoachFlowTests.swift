import XCTest

@MainActor final class GymAnonymousCoachFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func capture(_ app: XCUIApplication, _ name: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    if let path = ProcessInfo.processInfo.environment["WM_ANONYMOUS_COACH_SHOTS"] {
      let directory = URL(fileURLWithPath: path)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: directory.appending(path: name + ".png"))
    }
  }

  func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    let scroll = app.scrollViews.firstMatch
    for _ in 0..<16 {
      let frame = element.frame
      let top = app.buttons["you"].frame.maxY + 8
      let bottom = app.descendants(matching: .any)["coach-question"].frame.minY - 16
      if element.exists, element.isHittable, frame.minY >= top, frame.maxY <= bottom { return }
      let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
      let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: element.exists && frame.height > 0 && frame.minY < top ? 0.75 : 0.35))
      start.press(forDuration: 0.05, thenDragTo: end)
    }
    XCTFail("The Coach control did not become visible above the composer.")
  }

  func flow(appearance: String, largeText: Bool = false) throws {
    let server = ProcessInfo.processInfo.environment["WM_ANONYMOUS_COACH_SERVER"]
    let app = XCUIApplication()
    app.launchArguments = ["-scenario", "gym-e2e-anonymous-" + UUID().uuidString, "-server", server ?? "https://gym.invalid",
      "-onboarding-appearance", appearance, "-AppleLocale", "en_US", "-AppleLanguages", "(en)"]
    if server == nil { app.launchArguments.append("-model-server") }
    else { app.launchArguments.append("-telemetry") }
    if let dsn = ProcessInfo.processInfo.environment["WM_GYM_E2E_SENTRY"] { app.launchArguments += ["-sentry-dsn", dsn] }
    if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
    app.launch()
    let suffix = appearance + (largeText ? "-large" : "")
    XCTAssertTrue(app.staticTexts["coach-greeting"].waitForExistence(timeout: 25))
    XCTAssertFalse(app.buttons["coach-history"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["coach-installation-allowance"].exists)
    try capture(app, "anonymous-greeting-" + suffix)
    if largeText {
      let screenshot = app.buttons["coach-setup-screenshot"], build = app.buttons["coach-setup-build_manually"]
      reveal(screenshot, in: app); XCTAssertTrue(screenshot.isHittable)
      reveal(build, in: app); XCTAssertTrue(build.isHittable)
      try capture(app, "anonymous-greeting-actions-" + suffix)
    }
    let question = app.descendants(matching: .any)["coach-question"]
    question.tap(); question.typeText("Build a short full body routine for three days each week")
    let done = app.buttons["coach-keyboard-done"], keyboard = app.keyboards.firstMatch
    let tab = app.tabBars.buttons["Coach"]
    XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
    XCTAssertTrue(done.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: false, timeout: 5))
    XCTAssertFalse(done.frame.intersects(app.buttons["coach-send"].frame))
    try capture(app, "anonymous-composer-focused-" + suffix)
    done.tap()
    XCTAssertTrue(done.waitForNonExistence(timeout: 5))
    XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))
    XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertEqual(question.value as? String, "Build a short full body routine for three days each week")
    XCTAssertTrue(app.staticTexts["coach-greeting"].exists)
    app.buttons["coach-send"].tap()
    let review = app.buttons["coach-review-routines"]
    XCTAssertTrue(review.waitForExistence(timeout: 30))
    reveal(review, in: app); review.tap()
    XCTAssertTrue(app.buttons["coach-save-routines"].waitForExistence(timeout: 5))
    try capture(app, "anonymous-review-" + suffix)
    if largeText {
      let lastTarget = app.staticTexts["coach-review-final-set"]
      let save = app.buttons["coach-save-routines"]
      for _ in 0..<16 {
        if lastTarget.exists, lastTarget.isHittable, lastTarget.frame.maxY <= save.frame.minY - 28 { break }
        let top = app.navigationBars.firstMatch.frame.maxY + 24
        let bottom = save.frame.minY - 40
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: app.frame.midX, dy: bottom))
        let end = origin.withOffset(CGVector(dx: app.frame.midX, dy: top))
        start.press(forDuration: 0.05, thenDragTo: end)
      }
      XCTAssertTrue(lastTarget.isHittable)
      XCTAssertLessThanOrEqual(lastTarget.frame.maxY, save.frame.minY - 28)
      XCTAssertTrue(save.isHittable)
      try capture(app, "anonymous-review-bottom-" + suffix)
    }
    app.buttons["coach-save-routines"].tap()
    let receipt = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "coach-created-")).firstMatch
    XCTAssertTrue(receipt.waitForExistence(timeout: 30))
    XCTAssertTrue(app.buttons["coach-keep-routines"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["coach-read-receipt"].exists)
    let keep = app.buttons["coach-keep-routines"]
    reveal(keep, in: app)
    try capture(app, "anonymous-created-" + suffix)
    keep.tap()
    XCTAssertTrue(app.staticTexts["Keep your routines"].waitForExistence(timeout: 10))
    try capture(app, "anonymous-keep-" + suffix)
    app.buttons["Close"].tap()
    XCTAssertTrue(receipt.waitForExistence(timeout: 5)); reveal(receipt, in: app); receipt.tap()
    XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 10)); app.buttons["routine-start"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    try capture(app, "anonymous-workout-" + suffix)
    app.terminate()
  }

  func testAnonymousDialogueLight() throws { try flow(appearance: "light") }
  func testAnonymousDialogueDark() throws { try flow(appearance: "dark") }
  func testAnonymousDialogueLargeText() throws { try flow(appearance: "light", largeText: true) }
}
