import XCTest

@MainActor final class GymRecoveryFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func launch(_ board: String, appearance: String = "light") -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board, "-onboarding-appearance", appearance]
    app.launch()
    let log = app.tabBars.buttons["The log"]
    XCTAssertTrue(log.wait(for: \.isHittable, toEqual: true, timeout: 30)); log.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 20))
    return app
  }
  func row(_ id: String, _ app: XCUIApplication) -> XCUIElement { app.buttons["recovery-row-" + id] }
  // Rows below the fold, which a lazy list has not built yet, scroll into reach above the floating band before they are
  // read or tapped.
  func reach(_ element: XCUIElement, _ app: XCUIApplication) -> XCUIElement {
    _ = element.waitForExistence(timeout: 5)
    for _ in 0..<12 where !(element.exists && element.isHittable) { app.swipeUp(velocity: .slow) }
    XCTAssertTrue(element.isHittable)
    return element
  }
  func inspect(_ id: String, _ app: XCUIApplication) {
    reach(row(id, app), app).tap()
    XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].waitForExistence(timeout: 10))
  }
  // A queued retry says so on Inspect and stays there; back on the log its row leaves once the log confirms it.
  func landed(_ name: String, _ id: String, _ app: XCUIApplication) {
    XCTAssertTrue(app.staticTexts["\(name) is on your log."].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["recovery-primary"].exists || app.buttons["recovery-more"].exists)
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(row(id, app).waitForNonExistence(timeout: 60), "\(id) leaves once the log confirms it")
  }
  // An iOS 26 menu keeps XCTest from idling; a tap the stall dropped is tapped again.
  func choose(_ item: String, _ app: XCUIApplication) {
    let more = app.buttons["recovery-more"]
    XCTAssertTrue(more.waitForExistence(timeout: 5))
    for _ in 0..<3 {
      if !app.buttons[item].exists { more.tap() }
      if app.buttons[item].waitForExistence(timeout: 5) { app.buttons[item].tap() }
      if !app.buttons[item].waitForNonExistence(timeout: 5) { continue }
      return
    }
    XCTFail("\(item) did not open from More")
  }

  func testEveryReasonIsARowAndEachWayOutLeavesTheLog() {
    let app = launch("recovery")
    XCTAssertTrue(row("fixture-unsent", app).waitForExistence(timeout: 30), "The fixture's last copies are on the phone")
    let rows = [
      ("fixture-open-copy", "Pull A · today · 3 sets", "Your account has an open workout — keep this one as finished."),
      ("fixture-overlap", "Push A · 24 Sep · 12 sets", "Overlaps another workout — fix its times."),
      ("fixture-landed-push", "1 set from Push A · 23 Sep", "A set missed its workout — retry puts it back."),
      ("fixture-late-set", "Legs · 22 Sep · 4 sets", "Its times don't line up — fix the times."),
      ("fixture-missing-movement", "Free session · 21 Sep · 3 sets", "A movement is missing — fix its sets, then retry."),
      ("fixture-id-taken", "Free session · 20 Sep · 4 sets", "Already added once — discard this copy."),
      ("fixture-parent-dead", "Free session · 19 Sep · 3 sets", "Refused by the log — fix the workout, then retry."),
      ("fixture-many-sets", "Free session · 18 Sep · 201 sets", "Over 200 sets — remove some, then retry."),
      ("fixture-unsent", "Free session · 17 Sep · 3 sets", "Not on your log yet — retry to add it."),
    ]
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recovery-row-")).count, rows.count)
    for (id, title, line) in rows { XCTAssertEqual(reach(row(id, app), app).label, "\(title), \(line)", id) }
    app.swipeDown(velocity: .fast); app.swipeDown(velocity: .fast)

    inspect("fixture-open-copy", app)
    XCTAssertEqual(app.staticTexts["recovery-reason"].label, "Your account has an open workout — keep this one as finished.")
    XCTAssertEqual(app.buttons["recovery-primary"].label, "Keep as finished")
    app.buttons["recovery-primary"].tap()
    landed("Pull A", "fixture-open-copy", app)

    inspect("fixture-landed-push", app)
    XCTAssertEqual(app.buttons["recovery-primary"].label, "Retry")
    XCTAssertFalse(app.staticTexts["Started"].exists)
    app.buttons["recovery-primary"].tap()
    landed("Push A", "fixture-landed-push", app)

    inspect("fixture-late-set", app)
    XCTAssertEqual(app.buttons["recovery-primary"].label, "Fix workout")
    app.buttons["recovery-primary"].tap()
    XCTAssertTrue(app.navigationBars["Fix workout"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["recovery-fix-held"].staticTexts["Its times don't line up — fix the times."].exists)
    XCTAssertFalse(app.buttons["recovery-fix-save"].isEnabled)
    XCTAssertTrue(app.switches["Linked to Legs"].exists)
    reach(app.buttons["recovery-fix-set-fixture-late-set-set-3"], app).tap()
    XCTAssertTrue(app.navigationBars["Fix set"].waitForExistence(timeout: 5))
    reach(app.buttons["recovery-set-delete"], app).tap()
    XCTAssertTrue(app.navigationBars["Fix workout"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["recovery-fix-set-fixture-late-set-set-3"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["recovery-fix-held"].staticTexts["Its times don't line up — fix the times."].waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["recovery-fix-save"].isEnabled)
    app.buttons["recovery-fix-save"].tap()
    XCTAssertTrue(app.navigationBars["Fix workout"].waitForNonExistence(timeout: 10))
    landed("Legs", "fixture-late-set", app)

    inspect("fixture-missing-movement", app)
    app.buttons["recovery-primary"].tap()
    XCTAssertTrue(app.navigationBars["Fix workout"].waitForExistence(timeout: 5))
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recovery-fix-set-")).firstMatch
    reach(set, app).tap()
    XCTAssertTrue(app.navigationBars["Fix set"].waitForExistence(timeout: 5))
    reach(app.buttons["recovery-set-movement"], app).tap()
    reach(app.buttons["Overhead Press"], app).tap()
    XCTAssertTrue(app.navigationBars["Fix set"].waitForExistence(timeout: 5))
    app.buttons["recovery-set-save"].tap()
    XCTAssertTrue(app.navigationBars["Fix workout"].waitForExistence(timeout: 5))
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.navigationBars["Fix workout"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].exists)
    app.navigationBars.buttons.element(boundBy: 0).tap()

    inspect("fixture-id-taken", app)
    XCTAssertFalse(app.buttons["recovery-primary"].exists)
    choose("recovery-discard", app)
    XCTAssertTrue(app.staticTexts["Workout discarded"].waitForExistence(timeout: 5))
    app.buttons["recovery-undo"].tap()
    XCTAssertTrue(app.staticTexts["Workout discarded"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["recovery-more"].waitForExistence(timeout: 5))
    choose("recovery-discard", app)
    XCTAssertTrue(app.staticTexts["Workout discarded"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].waitForNonExistence(timeout: 20), "The window closes and the screen leaves")
    XCTAssertTrue(row("fixture-id-taken", app).waitForNonExistence(timeout: 10))
  }

  func testAPausedAccountShowsTheWorkoutOnItsWayAndHoldsTheRest() {
    let app = launch("recovery-paused", appearance: "dark")
    XCTAssertEqual(reach(row("fixture-sending", app), app).label, "Push A · 25 Sep · 6 sets, adding…")
    XCTAssertEqual(row("fixture-unsent", app).label, "Free session · 24 Sep · 3 sets, Not on your log yet — retry to add it.")
    inspect("fixture-sending", app)
    XCTAssertFalse(app.buttons["recovery-primary"].exists || app.buttons["recovery-more"].exists)
    app.navigationBars.buttons.element(boundBy: 0).tap()
    inspect("fixture-unsent", app)
    XCTAssertEqual(app.buttons["recovery-primary"].label, "Retry")
    XCTAssertFalse(app.buttons["recovery-primary"].isEnabled)
    XCTAssertTrue(app.descendants(matching: .any)["recovery-error"].staticTexts["Sign in again to add it."].exists)
  }
}
