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
    let goal = app.buttons["coach-setup-goal"]
    XCTAssertTrue(goal.waitForExistence(timeout: 25))
    XCTAssertFalse(app.buttons["coach-history"].exists)
    try capture(app, "anonymous-starters-" + suffix)
    goal.tap()
    let question = app.descendants(matching: .any)["coach-question"]
    XCTAssertTrue(question.waitForExistence(timeout: 5)); question.tap(); question.typeText("Get stronger with short workouts")
    let done = app.buttons["coach-keyboard-done"]
    if done.wait(for: \.isHittable, toEqual: true, timeout: 3) { done.tap() }
    for id in ["coach-choice-days-3", "coach-choice-equipment-gym"] {
      let choice = app.buttons[id]
      reveal(choice, in: app); choice.tap()
      XCTAssertTrue(choice.wait(for: \.isSelected, toEqual: true, timeout: 3))
    }
    try capture(app, "anonymous-choices-" + suffix)
    XCTAssertTrue(app.buttons["coach-send"].isHittable); app.buttons["coach-send"].tap()
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

  func testAnonymousGoalLight() throws { try flow(appearance: "light") }
  func testAnonymousGoalDark() throws { try flow(appearance: "dark") }
  func testAnonymousGoalLargeText() throws { try flow(appearance: "light", largeText: true) }
}
