import XCTest

final class RecoveryCaptures: DesignCapture {
  // On this phone (§7.16): the log's one row and badge, the list it opens, Inspect for each primary, Fix workout and its
  // set, the held discard back on the list, and a paused account's workout on its way.
  func recovery(_ look: Look) {
    let app = launch("recovery", look)
    XCTAssertTrue(app.tabBars.buttons["The log"].waitForExistence(timeout: 30)); app.tabBars.buttons["The log"].tap()
    XCTAssertTrue(app.buttons["recovery-summary"].waitForExistence(timeout: 20))
    capture("gym-log-on-this-phone", look, app, settle: 1.5)
    app.buttons["recovery-summary"].tap()
    XCTAssertTrue(app.buttons["recovery-row-fixture-overlap"].waitForExistence(timeout: 10))
    capture("07.1-on-this-phone", look, app)
    for (id, screen) in [("fixture-open-copy", "gym-recovery-inspect-keep"), ("fixture-overlap", nil),
                         ("fixture-landed-push", "gym-recovery-inspect-retry"), ("fixture-id-taken", "gym-recovery-inspect-discard-only")] {
      let row = app.buttons["recovery-row-" + id]
      for _ in 0..<8 where !row.isHittable { app.swipeUp(velocity: .slow) }
      row.tap()
      XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].waitForExistence(timeout: 10))
      if let screen { capture(screen, look, app) }
      if id == "fixture-overlap" {
        app.buttons["recovery-primary"].tap()
        XCTAssertTrue(app.navigationBars["Fix workout"].waitForExistence(timeout: 5))
        // A set row reached at the largest text sits under the band at the sheet's foot until it scrolls clear of it.
        let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recovery-fix-set-")).firstMatch
        let held = app.descendants(matching: .any)["recovery-fix-held"]
        for _ in 0..<8 where !(set.isHittable && (!held.exists || set.frame.maxY < held.frame.minY)) { app.swipeUp(velocity: .slow) }
        set.tap()
        XCTAssertTrue(app.navigationBars["Fix set"].waitForExistence(timeout: 5))
        capture("gym-recovery-fix-set", look, app)
        app.navigationBars["Fix set"].buttons["Cancel"].tap()
        XCTAssertTrue(app.navigationBars["Fix workout"].waitForExistence(timeout: 5))
        app.navigationBars["Fix workout"].buttons["Cancel"].tap()
        XCTAssertTrue(app.navigationBars["Fix workout"].waitForNonExistence(timeout: 5))
      }
      if id == "fixture-id-taken" {
        for _ in 0..<3 where !app.buttons["recovery-discard"].exists {
          app.buttons["recovery-more"].tap(); _ = app.buttons["recovery-discard"].waitForExistence(timeout: 5)
        }
        capture("gym-recovery-more-menu", look, app, settle: 0.6)
        app.buttons["recovery-discard"].tap()
        XCTAssertTrue(app.buttons["Discard workout"].waitForExistence(timeout: 5))
        capture("gym-recovery-discard-confirmation", look, app)
        app.buttons["Discard workout"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["gym-log-undo"].exists)
        continue
      }
      back(app)
      XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].waitForNonExistence(timeout: 5))
    }
    let paused = launch("recovery-paused", look)
    XCTAssertTrue(paused.tabBars.buttons["The log"].waitForExistence(timeout: 30)); paused.tabBars.buttons["The log"].tap()
    XCTAssertTrue(paused.buttons["recovery-summary"].waitForExistence(timeout: 20))
    capture("gym-log-on-this-phone-paused", look, paused, settle: 1.5)
    paused.buttons["recovery-summary"].tap()
    XCTAssertTrue(paused.buttons["recovery-row-fixture-sending"].waitForExistence(timeout: 10))
    capture("gym-on-this-phone-list-paused", look, paused)
    paused.buttons["recovery-row-fixture-unsent"].tap()
    XCTAssertTrue(paused.descendants(matching: .any)["recovery-inspect"].waitForExistence(timeout: 10))
    capture("gym-recovery-inspect-blocked", look, paused)
  }
  func testRecovery() { for look in Look.both { recovery(look) } }

  func openOverlap(_ look: Look) -> XCUIApplication {
    let app = launch("recovery", look)
    XCTAssertTrue(app.tabBars.buttons["The log"].waitForExistence(timeout: 30)); app.tabBars.buttons["The log"].tap()
    XCTAssertTrue(app.buttons["recovery-summary"].waitForExistence(timeout: 20)); app.buttons["recovery-summary"].tap()
    let row = app.buttons["recovery-row-fixture-overlap"]
    XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
    XCTAssertTrue(app.descendants(matching: .any)["recovery-inspect"].waitForExistence(timeout: 10))
    return app
  }
  func testInspect() {
    captureBoard("07.2-inspect") { look in openOverlap(look) }
  }
  func testFixWorkout() {
    captureBoard("07.3-fix-workout") { look in
      let app = openOverlap(look)
      app.buttons["recovery-primary"].tap()
      XCTAssertTrue(app.navigationBars["Fix workout"].waitForExistence(timeout: 5))
      return app
    }
  }
  func testRecoveryLargestText() { for look in Look.bothAtLargestText { recovery(look) } }
}
