import XCTest

@MainActor final class GymRecoveryFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // A saved workout whose times do not line up waits under On this phone; Fix workout holds Save and retry until the late
  // set is deleted, and the workout then lands and leaves the list.
  func testFixWorkoutSavesAndRetries() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "recovery", "-onboarding-appearance", "light"]
    app.launch()
    let log = app.tabBars.buttons["The log"]
    XCTAssertTrue(log.wait(for: \.isHittable, toEqual: true, timeout: 30)); log.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 20))
    let summary = app.buttons["recovery-summary"]
    XCTAssertTrue(summary.waitForExistence(timeout: 30), "The fixture's copies are on the phone")
    XCTAssertEqual(summary.label, "9 workouts, 9 need you")
    summary.tap()
    XCTAssertTrue(app.descendants(matching: .any)["recovery-list"].waitForExistence(timeout: 10))
    let row = reach(app.buttons["recovery-row-fixture-late-set"], app)
    row.tap()
    XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["recovery-primary"].label, "Fix workout")
    app.buttons["recovery-primary"].tap()
    XCTAssertTrue(app.navigationBars["Fix workout"].waitForExistence(timeout: 5))
    let held = app.descendants(matching: .any)["recovery-fix-held"].staticTexts["Its times don’t line up — fix the times."]
    XCTAssertTrue(held.exists)
    XCTAssertEqual(app.buttons["recovery-fix-save"].label, "Save and retry")
    XCTAssertFalse(app.buttons["recovery-fix-save"].isEnabled)
    reach(app.buttons["recovery-fix-set-fixture-late-set-set-3"], app).tap()
    XCTAssertTrue(app.buttons["recovery-set-save"].waitForExistence(timeout: 5))
    reach(app.buttons["recovery-set-delete"], app).tap()
    XCTAssertTrue(app.navigationBars["Fix workout"].waitForExistence(timeout: 5))
    XCTAssertTrue(held.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["recovery-fix-save"].isEnabled)
    app.buttons["recovery-fix-save"].tap()
    XCTAssertTrue(app.navigationBars["Fix workout"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Adding Legs to your log."].waitForNonExistence(timeout: 60), "Legs lands and the line leaves")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(row.waitForNonExistence(timeout: 60), "The fixed workout leaves once the log confirms it")
  }

  // Rows below the fold, which a lazy list has not built yet, scroll into reach above the floating band.
  func reach(_ element: XCUIElement, _ app: XCUIApplication) -> XCUIElement {
    _ = element.waitForExistence(timeout: 5)
    for _ in 0..<12 where !(element.exists && element.isHittable) { app.swipeUp(velocity: .slow) }
    XCTAssertTrue(element.isHittable)
    return element
  }
}
