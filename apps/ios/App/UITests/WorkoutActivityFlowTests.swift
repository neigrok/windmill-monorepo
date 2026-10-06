import XCTest

@MainActor final class WorkoutActivityFlowTests: XCTestCase {
  func testExpandedActivityLogsOneSetAndRefreshesTheWorkout() {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-live-activity-planned", "-onboarding-appearance", "dark"]
    if let server = ProcessInfo.processInfo.environment["WM_GYM_E2E_SERVER"] {
      app.launchArguments += ["-server", server, "-telemetry"]
      if let dsn = ProcessInfo.processInfo.environment["WM_GYM_E2E_SENTRY"] { app.launchArguments += ["-sentry-dsn", dsn] }
    }
    app.launch()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, 3)
    XCUIDevice.shared.press(.home)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.001)).press(forDuration: 0.05,
      thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)))
    for title in ["Allow", "Always Allow"] where springboard.buttons[title].exists { springboard.buttons[title].tap() }
    let banner = XCTAttachment(screenshot: springboard.screenshot())
    banner.name = "lock-screen-banner"; banner.lifetime = .keepAlways; add(banner)
    XCUIDevice.shared.press(.home)
    waitForSettledIsland(springboard.staticTexts["Since last set"])
    let compact = XCTAttachment(screenshot: springboard.screenshot())
    compact.name = "dynamic-island-compact"; compact.lifetime = .keepAlways; add(compact)
    if let media = ProcessInfo.processInfo.environment["WM_ACTIVITY_RENDER_MEDIA"], let url = URL(string: media) {
      let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
      safari.open(url)
      let play = safari.buttons["Play QA tone"]
      XCTAssertTrue(play.waitForExistence(timeout: 10)); play.tap()
      XCTAssertTrue(safari.buttons["QA tone is playing"].waitForExistence(timeout: 10),
        "The media fixture must confirm playback before Safari backgrounds")
      XCUIDevice.shared.press(.home)
      XCTAssertTrue(springboard.icons["Safari"].waitForExistence(timeout: 5))
      waitForSettledIsland(springboard.images["Workout in progress"])
      let minimal = XCTAttachment(screenshot: springboard.screenshot())
      minimal.name = "dynamic-island-minimal"; minimal.lifetime = .keepAlways; add(minimal)
      safari.terminate()
      waitForSettledIsland(springboard.staticTexts["Since last set"])
    }
    springboard.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: springboard.frame.midX, dy: 28)).press(forDuration: 1)
    let log = springboard.buttons["Log set"]
    XCTAssertTrue(log.waitForExistence(timeout: 5))
    let expanded = XCTAttachment(screenshot: springboard.screenshot())
    expanded.name = "dynamic-island-expanded"; expanded.lifetime = .keepAlways; add(expanded)
    log.tap()
    app.activate()
    let retained = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-"))
    let landed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in retained.count == 4 }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [landed], timeout: 10), .completed)
    XCTAssertTrue(app.staticTexts["workout-current-set"].label.contains("4"))
    app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.staticTexts["Ended early."].waitForExistence(timeout: 5))
    XCUIDevice.shared.press(.home)
    let ended = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      !springboard.staticTexts["Since last set"].exists &&
      !springboard.images["Workout in progress"].exists
    }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [ended], timeout: 10), .completed)
  }

  func waitForSettledIsland(_ element: XCUIElement) {
    var previous = CGRect.zero
    var settledSince: Date?
    let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard element.exists else { settledSince = nil; return false }
      let frame = element.frame
      guard !frame.isEmpty, frame.minY < 100 else { settledSince = nil; return false }
      if frame != previous { previous = frame; settledSince = Date(); return false }
      guard let settledSince else { settledSince = Date(); return false }
      return Date().timeIntervalSince(settledSince) >= 1
    }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 10), .completed, "Dynamic Island content must settle before capture")
  }
}
