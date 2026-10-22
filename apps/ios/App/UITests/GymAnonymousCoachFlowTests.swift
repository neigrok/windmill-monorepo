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
    let apply = app.buttons["coach-save-routines"]
    XCTAssertTrue(apply.waitForExistence(timeout: 30))
    XCTAssertTrue(app.buttons["coach-reject-routines"].exists)
    reveal(apply, in: app)
    XCTAssertTrue(apply.isHittable, "Apply is reachable under the drafts at every size")
    try capture(app, "anonymous-drafts-" + suffix)
    apply.tap()
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

  // Signed out, Coach drafts routines and the lifter applies them; after sign-in and Add the same conversation goes on, and
  // the next question gets a change to the routine it created.
  func testTheConversationContinuesSignedInAfterAdd() throws {
    for appearance in ["dark", "light"] {
      let app = XCUIApplication()
      app.launchArguments = ["-scenario", "gym-e2e-anonymous-" + UUID().uuidString, "-server", "https://gym.invalid", "-model-server",
        "-coach-fixture", "-coach-board", "after-sign-in", "-onboarding-appearance", appearance, "-AppleLocale", "en_US", "-AppleLanguages", "(en)"]
      app.launch()
      let question = app.descendants(matching: .any)["coach-question"]
      XCTAssertTrue(question.waitForExistence(timeout: 30))
      question.tap(); question.typeText("Build me a three day full body program")
      app.buttons["coach-send"].tap()
      let apply = app.buttons["coach-save-routines"]
      XCTAssertTrue(apply.waitForExistence(timeout: 30)); reveal(apply, in: app); apply.tap()
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "coach-created-")).firstMatch.waitForExistence(timeout: 30))
      app.buttons["you"].tap()
      XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10)); app.buttons["email-sign-in"].tap()
      let address = app.textFields["email-address"]; address.tap(); address.typeText("after-sign-in-" + UUID().uuidString.prefix(8).lowercased() + "@example.com")
      app.buttons["Send code"].tap()
      let code = app.textFields["email-code"]; XCTAssertTrue(code.waitForExistence(timeout: 10)); code.tap(); code.typeText("482913")
      if app.alerts.buttons["Add"].waitForExistence(timeout: 15) { app.alerts.buttons["Add"].tap() }
      if app.buttons["Close"].waitForExistence(timeout: 3) { app.buttons["Close"].tap() }
      XCTAssertTrue(question.waitForExistence(timeout: 15))
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "coach-created-")).firstMatch.waitForExistence(timeout: 15),
                    "The adopted conversation stays")
      question.tap(); question.typeText("Swap chin-ups for pulldowns")
      app.buttons["coach-send"].tap()
      let header = app.descendants(matching: .any)["coach-proposal-header"]
      XCTAssertTrue(header.waitForExistence(timeout: 20), "The signed-in send gets Coach's answer, with its change")
      XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      try capture(app, "anonymous-after-sign-in-" + appearance)
      app.terminate()
    }
  }

  func testAnonymousDialogueLight() throws { try flow(appearance: "light") }
  func testAnonymousDialogueDark() throws { try flow(appearance: "dark") }
  func testAnonymousDialogueLargeText() throws { try flow(appearance: "light", largeText: true) }
}
