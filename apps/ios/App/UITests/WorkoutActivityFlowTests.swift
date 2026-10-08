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
    let activity = app.otherElements["workout-activity-state"]
    let published = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      activity.exists && activity.value as? String == "active"
    }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [published], timeout: 10), .completed,
      "The workout Live Activity must be active before backgrounding")
    XCUIDevice.shared.press(.home)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.001)).press(forDuration: 0.05,
      thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)))
    let bannerDeadline = Date().addingTimeInterval(20)
    XCTAssertTrue(springboard.staticTexts["Lower A"].waitForExistence(timeout: max(0, bannerDeadline.timeIntervalSinceNow)))
    XCTAssertTrue(springboard.buttons["Log set"].waitForExistence(timeout: max(0, bannerDeadline.timeIntervalSinceNow)))
    XCTAssertTrue(springboard.buttons["Log set"].wait(for: \.isHittable, toEqual: true, timeout: max(0, bannerDeadline.timeIntervalSinceNow)))
    let banner = XCTAttachment(screenshot: springboard.screenshot())
    banner.name = "lock-screen-banner"; banner.lifetime = .keepAlways; add(banner)
    XCUIDevice.shared.press(.home)
    let island = springboard.staticTexts["Since last set"]
    waitForVisibleIsland(island, in: springboard)
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
      waitForVisibleIsland(springboard.images["Workout in progress"], in: springboard)
      let minimal = XCTAttachment(screenshot: springboard.screenshot())
      minimal.name = "dynamic-island-minimal"; minimal.lifetime = .keepAlways; add(minimal)
      safari.terminate()
      waitForVisibleIsland(island, in: springboard)
    }
    let activityContainer = springboard.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH %@", "jindo-container-view:"))
      .containing(.staticText, identifier: "Since last set").firstMatch
    XCTAssertTrue(activityContainer.wait(for: \.isHittable, toEqual: true, timeout: 30),
      "SpringBoard's Activity container must accept the expansion gesture")
    activityContainer.press(forDuration: 1)
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

  func waitForVisibleIsland(_ element: XCUIElement, in springboard: XCUIApplication) {
    let viewport = springboard.frame
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let snapshot = try? element.snapshot() else { return false }
      return snapshot.isEnabled && !snapshot.frame.isEmpty && viewport.contains(snapshot.frame) && snapshot.frame.maxY < 100
    }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed, "Dynamic Island content must be visible before capture")
  }
}
