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
  // A September day of the fixture's year in the day form, ordered as the phone's region orders it.
  func september(_ day: Int) -> String {
    var style = Date.FormatStyle.dateTime.day().month(.abbreviated); style.timeZone = .gmt
    return style.format(Date(timeIntervalSince1970: 1_788_177_600 + Double(day) * 86_400))
  }
  // Two or more saved workouts are one row under the log's On this phone header, which opens the On this phone list.
  func openList(_ title: String, _ needYou: String, _ app: XCUIApplication) {
    let summary = app.buttons["recovery-summary"]
    XCTAssertTrue(summary.waitForExistence(timeout: 30), "The fixture's copies are on the phone")
    XCTAssertTrue(app.staticTexts["On this phone"].exists)
    XCTAssertEqual(summary.label, "\(title), \(needYou)")
    summary.tap()
    XCTAssertTrue(app.descendants(matching: .any)["recovery-list"].waitForExistence(timeout: 10))
  }
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
  // A queued retry leaves Inspect's band and menu; Inspect says the workout is on its way only until the log confirms
  // it, and back on the log its row has left.
  func landed(_ name: String, _ id: String, _ app: XCUIApplication) {
    XCTAssertTrue(app.buttons["recovery-primary"].waitForNonExistence(timeout: 10))
    XCTAssertFalse(app.buttons["recovery-more"].exists)
    XCTAssertTrue(app.staticTexts["Adding \(name) to your log."].waitForNonExistence(timeout: 60), "\(name) lands and the line leaves")
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
    XCTAssertFalse(row("fixture-unsent", app).exists, "Nine workouts are one row at the head")
    openList("9 workouts", "9 need you", app)
    XCTAssertTrue(app.staticTexts["Needs you"].exists && !app.staticTexts["Adding"].exists)
    let rows = [
      ("fixture-open-copy", "Pull A · Today · 3 sets", "Your account has an open workout — keep this one as finished."),
      ("fixture-overlap", "Push A · \(september(24)) · 12 sets", "Overlaps another workout — fix its times."),
      ("fixture-landed-push", "1 set from Push A · \(september(23))", "A set missed its workout — retry puts it back."),
      ("fixture-late-set", "Legs · \(september(22)) · 4 sets", "Its times don't line up — fix the times."),
      ("fixture-missing-movement", "Free workout · \(september(21)) · 3 sets", "A movement is missing — fix its sets, then retry."),
      ("fixture-id-taken", "Free workout · \(september(20)) · 4 sets", "Already added once — discard this copy."),
      ("fixture-parent-dead", "Free workout · \(september(19)) · 3 sets", "Refused by the log — fix the workout, then retry."),
      ("fixture-many-sets", "Free workout · \(september(18)) · 201 sets", "Over 200 sets — remove some, then retry."),
      ("fixture-unsent", "Free workout · \(september(17)) · 3 sets", "Not on your log yet — retry to add it."),
    ]
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recovery-row-")).count, rows.count)
    for (id, title, line) in rows { XCTAssertEqual(reach(row(id, app), app).label, "\(title), \(line)", id) }
    app.swipeDown(velocity: .fast); app.swipeDown(velocity: .fast)

    inspect("fixture-open-copy", app)
    XCTAssertEqual(app.staticTexts["recovery-reason"].label, "Your account has an open workout — keep this one as finished.")
    XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "—")).firstMatch.exists,
                   "Inspect draws only the facts that are known")
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", " at ")).firstMatch.exists, "Started and Finished hold the time")
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
    XCTAssertEqual(app.buttons["recovery-fix-save"].label, "Save and retry")
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
    XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].waitForNonExistence(timeout: 5), "Discard returns to the list it came from")
    let band = app.descendants(matching: .any)["gym-log-undo-band"]
    XCTAssertTrue(band.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Workout discarded"].exists)
    XCTAssertFalse(row("fixture-id-taken", app).exists, "The row leaves while the window is open")
    app.buttons["gym-log-undo"].tap()
    XCTAssertTrue(band.waitForNonExistence(timeout: 5))
    XCTAssertTrue(row("fixture-id-taken", app).waitForExistence(timeout: 5))
    inspect("fixture-id-taken", app)
    choose("recovery-discard", app)
    XCTAssertTrue(band.waitForExistence(timeout: 5))
    XCTAssertTrue(band.waitForNonExistence(timeout: 20), "The window closes into the discard")
    XCTAssertFalse(row("fixture-id-taken", app).exists)
  }

  func testAPausedAccountShowsTheWorkoutOnItsWayAndHoldsTheRest() {
    let app = launch("recovery-paused", appearance: "dark")
    openList("2 workouts", "1 needs you", app)
    XCTAssertTrue(app.staticTexts["Needs you"].exists && app.staticTexts["Adding"].exists)
    XCTAssertEqual(reach(row("fixture-sending", app), app).label, "Push A · Yesterday · 6 sets, Adding…")
    XCTAssertEqual(row("fixture-unsent", app).label, "Free workout · \(september(24)) · 3 sets, Not on your log yet — retry to add it.")
    XCTAssertLessThan(row("fixture-unsent", app).frame.minY, row("fixture-sending", app).frame.minY, "Needs you comes first")
    inspect("fixture-sending", app)
    XCTAssertFalse(app.buttons["recovery-primary"].exists || app.buttons["recovery-more"].exists)
    app.navigationBars.buttons.element(boundBy: 0).tap()
    inspect("fixture-unsent", app)
    XCTAssertEqual(app.buttons["recovery-primary"].label, "Retry")
    XCTAssertFalse(app.buttons["recovery-primary"].isEnabled)
    XCTAssertTrue(app.descendants(matching: .any)["recovery-error"].staticTexts["Sign in again to add it."].exists)
  }
}
