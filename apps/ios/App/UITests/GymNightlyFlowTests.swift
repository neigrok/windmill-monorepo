import XCTest

// The gym's layout regressions that only a running app shows — SwiftUI's scroll restoration across a push, a pop and a
// tab switch, and iOS 26's minimizing tab bar with the hidden workout's accessory. Nothing below the UI can see them, and
// they are slow, so they run nightly: XCTest skips them unless the runner sees WM_NIGHTLY_UI=1.
@MainActor final class GymNightlyFlowTests: XCTestCase {
  override func setUpWithError() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["WM_NIGHTLY_UI"] == "1", "Nightly UI tests are opt-in.")
    continueAfterFailure = false
  }

  // A pushed screen hides the tab bar and the accessory; back at the log's end, its last row and total stand where they stood.
  func testTheLogsEndStaysClearOfTheTabBarAfterAPushedScreenPops() {
    let app = launchLog()
    assertTheEndHoldsAcrossAPush(above: app.tabBars.firstMatch, app)
  }

  func testTheLogsEndStaysClearOfTheAccessoryAfterAPushedScreenPops() {
    let app = launchLog()
    assertTheEndHoldsAcrossAPush(above: hideAWorkout(app), app)
  }

  // Each bounce at the log's end flips the bar between minimized, the accessory inline beside it, and back, the accessory
  // above it; the end settles clear of whichever stands, and back beside the minimized bar it stands where it stood.
  func testTheLogsEndStaysClearOfTheAccessoryAsABounceBringsTheBarBack() {
    let app = launchLog()
    let accessory = hideAWorkout(app), expanded = app.tabBars.buttons["Routines"], footer = app.staticTexts["gym-log-end"]
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    for _ in 0..<40 where !(footer.exists && footer.isHittable) { app.swipeUp(velocity: .fast) }
    app.swipeUp(velocity: .fast)
    for _ in 0..<3 where expanded.isHittable { app.swipeUp(velocity: .fast) }
    XCTAssertTrue(expanded.wait(for: \.isHittable, toEqual: false, timeout: 5), "Flung to its end, the log minimizes the bar")
    let minimized = settledFrame(footer)
    XCTAssertLessThanOrEqual(minimized.maxY, accessory.frame.minY + 1, "Beside the minimized bar the footer \(minimized) clears \(accessory.frame)")
    app.swipeUp(velocity: .fast)
    XCTAssertTrue(expanded.wait(for: \.isHittable, toEqual: true, timeout: 5), "A bounce at the end brings the bar back")
    let grown = settledFrame(footer)
    XCTAssertLessThanOrEqual(grown.maxY, accessory.frame.minY + 1, "Under the bar's return the footer \(grown) clears \(accessory.frame)")
    app.swipeUp(velocity: .fast)
    XCTAssertTrue(expanded.wait(for: \.isHittable, toEqual: false, timeout: 5), "The next bounce minimizes the bar again")
    let again = settledFrame(footer)
    XCTAssertEqual(again.minY, minimized.minY, accuracy: 1, "Beside the minimized bar again the footer \(again) stands where it stood \(minimized)")
  }

  // A pushed screen hides the tab bar; back at the conversation's end, or back from another tab, its last card stands where
  // it stood, over the composer.
  func testTheConversationsEndStaysClearOfTheComposerAfterAPushedScreenPopsAndATabSwitch() {
    let app = XCUIApplication()
    app.launchEnvironment["TZ"] = "UTC"
    app.launchArguments = ["-model-server", "-board", "shell-last-room", "-onboarding-appearance", "light", "-AppleLocale", "en_US",
                           "-AppleLanguages", "(en)", "-coach-fixture", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"]
    app.launch()
    XCTAssertTrue(app.buttons["room-menu"].waitForExistence(timeout: 10)); app.buttons["room-menu"].tap()
    XCTAssertTrue(app.buttons["room-gym"].waitForExistence(timeout: 5)); app.buttons["room-gym"].tap()
    openTab("Coach", app)
    let composer = app.descendants(matching: .any)["coach-question"]
    XCTAssertTrue(composer.waitForExistence(timeout: 15)); composer.tap(); composer.typeText("Is Push A still doing anything?")
    app.buttons["coach-send"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    let review = app.buttons["coach-reject-proposal"]
    for _ in 0..<4 { app.scrollViews.firstMatch.swipeUp(velocity: .fast) }
    XCTAssertFalse(app.buttons["coach-read-receipt"].isHittable, "At this size the conversation scrolls past its receipt")
    let atEnd = settledFrame(review)
    XCTAssertLessThanOrEqual(atEnd.maxY, composer.frame.minY + 1, "At rest the last card \(atEnd) clears \(composer.frame)")
    app.buttons["coach-history"].tap()
    XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.tabBars.firstMatch.isHittable, "A pushed screen hides the tab bar")
    back(app)
    XCTAssertTrue(app.navigationBars["Coach"].waitForExistence(timeout: 5))
    let returned = settledFrame(review)
    XCTAssertEqual(returned.minY, atEnd.minY, accuracy: 1, "The last card \(returned) stands where it stood \(atEnd)")
    XCTAssertLessThanOrEqual(returned.maxY, composer.frame.minY + 1, "The last card \(returned) clears \(composer.frame)")
    openTab("Routines", app)
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    openTab("Coach", app)
    XCTAssertFalse(review.exists, "A deliberate Coach tab entry starts fresh")
    app.buttons["coach-history"].tap()
    let previous = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Is Push A still doing anything?")).firstMatch
    XCTAssertTrue(previous.waitForExistence(timeout: 5)); previous.tap()
    for _ in 0..<4 { app.scrollViews.firstMatch.swipeUp(velocity: .fast) }
    let reopened = settledFrame(review)
    XCTAssertLessThanOrEqual(reopened.maxY, composer.frame.minY + 1, "The reopened conversation clears the composer")
    for name in ["Routines", "The log", "Coach"] { XCTAssertTrue(app.tabBars.buttons[name].isHittable) }
  }

  func launchLog() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "shell-anonymous", "-onboarding-appearance", "light", "-gym-log-fixture"]
    app.launch()
    XCTAssertTrue(app.buttons["open-gym"].waitForExistence(timeout: 15)); app.buttons["open-gym"].tap()
    let log = app.tabBars.buttons["The log"]
    XCTAssertTrue(log.waitForExistence(timeout: 10)); log.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 20))
    return app
  }
  func sessionRow(_ app: XCUIApplication) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
  }
  func back(_ app: XCUIApplication) { app.navigationBars.buttons.element(boundBy: 0).tap() }
  // A routine workout leaves its return control above The log while hidden.
  func hideAWorkout(_ app: XCUIApplication) -> XCUIElement {
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    app.tabBars.buttons["Routines"].tap()
    app.buttons["new-routine"].tap()
    let name = app.textFields["routine-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5)); name.tap(); name.typeText("Log coverage\n")
    app.buttons["add-movement"].tap()
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5)); app.buttons["gym-movement-bench-press"].tap()
    app.buttons["save-routine"].tap()
    XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 5)); app.buttons["routine-start"].tap()
    XCTAssertTrue(app.buttons["workout-assembly"].waitForExistence(timeout: 10)); app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    let accessory = app.buttons["gym-hidden-workout"]
    XCTAssertTrue(accessory.waitForExistence(timeout: 5))
    app.tabBars.buttons["The log"].tap()
    return accessory
  }
  func assertTheEndHoldsAcrossAPush(above foot: XCUIElement, _ app: XCUIApplication) {
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    let footer = app.staticTexts["gym-log-end"]
    for _ in 0..<40 where !(footer.exists && footer.isHittable) { app.swipeUp(velocity: .fast) }
    for _ in 0..<2 { app.swipeUp(velocity: .fast) }
    let sessions = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-"))
    let last = app.buttons[sessions.allElementsBoundByIndex.last { $0.isHittable }?.identifier ?? "none"]
    let atEnd = (row: settledFrame(last), footer: settledFrame(footer))
    XCTAssertLessThanOrEqual(atEnd.footer.maxY, foot.frame.minY + 1, "At rest the footer \(atEnd.footer) clears \(foot.frame)")
    last.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.tabBars.firstMatch.isHittable, "A pushed screen hides the tab bar")
    XCTAssertFalse(foot.isHittable, "A pushed screen hides the bar's foot")
    back(app)
    XCTAssertTrue(app.buttons["gym-weigh-in"].waitForExistence(timeout: 10))
    let back = (row: settledFrame(last), footer: settledFrame(footer))
    XCTAssertEqual(back.row.minY, atEnd.row.minY, accuracy: 1, "The last row \(back.row) stands where it stood \(atEnd.row)")
    XCTAssertEqual(back.footer.minY, atEnd.footer.minY, accuracy: 1, "The footer \(back.footer) stands where it stood \(atEnd.footer)")
    XCTAssertLessThanOrEqual(back.footer.maxY, foot.frame.minY + 1, "The footer \(back.footer) clears \(foot.frame)")
  }
  // Scrolling minimizes the tab bar to its selected tab; tapping that tab brings the other tabs back.
  func openTab(_ name: String, _ app: XCUIApplication) {
    let tab = app.tabBars.buttons[name]
    if !tab.waitForExistence(timeout: 2) || !tab.isHittable { app.tabBars.buttons.firstMatch.tap() }
    XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: true, timeout: 10)); tab.tap()
  }
  func settledFrame(_ element: XCUIElement) -> CGRect {
    var frame = element.frame
    for _ in 0..<20 {
      RunLoop.current.run(until: Date().addingTimeInterval(0.25))
      if element.frame == frame { break }
      frame = element.frame
    }
    return frame
  }
}
