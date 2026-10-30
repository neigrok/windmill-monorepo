import XCTest

// The workout's pager end to end: the wheel, a logged set, a swipe to the next movement, a movement added by search from
// This workout, and a swipe back.
@MainActor final class GymWorkoutFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func testPagerAndAssembly() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-onboarding-appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["workout-pages"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["Workout time"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["Since last set"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["workout-set-progress"].exists)
    let ledger = app.collectionViews["workout-ledger"]
    XCTAssertTrue(ledger.waitForExistence(timeout: 5))
    XCTAssertEqual(ledger.frame.height, 132, accuracy: 1)
    let weight = app.buttons["workout-weight"]
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in weight.exists && weight.isEnabled && weight.isHittable }, object: weight)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
    weight.tap()
    app.typeLoad("105"); app.buttons["workout-log"].tap()
    app.descendants(matching: .any)["workout-current-set"].swipeLeft()
    XCTAssertTrue(app.buttons["Romanian Deadlift"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.alerts.count, 0, "A set above the plan is just logged")
    XCTAssertFalse(app.staticTexts["plan 3 × 6 · 82.5"].exists, "The planned rows already say the plan")
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
    app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
    app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText("Bench")
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
    app.buttons["gym-movement-bench-press"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Bench Press"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["workout-weight"].label, "Weight, 20 kg total")
    XCTAssertEqual(app.collectionViews["workout-ledger"].frame.height, 44, accuracy: 1)
    app.buttons["workout-log"].tap()
    let chosenSet = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(chosenSet.waitForExistence(timeout: 5))
    XCTAssertEqual(chosenSet.label, "Set 1, logged, 20 kilograms, 5 reps")
    app.descendants(matching: .any)["workout-current-set"].swipeRight()
    XCTAssertTrue(app.buttons["Romanian Deadlift"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, 0)
  }

  func testMovementPickerCanCancelReopenAndCreateWithoutLosingTheRack() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-onboarding-appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-weight"].waitForExistence(timeout: 10))
    app.buttons["workout-weight"].tap(); app.typeLoad("105")
    for _ in 0..<2 {
      app.buttons["workout-assembly"].tap()
      XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
      app.buttons["workout-assembly-add"].tap()
      XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
      let selected = app.buttons["gym-movement-back-squat"]
      XCTAssertTrue(selected.waitForExistence(timeout: 5))
      XCTAssertFalse(selected.isEnabled)
      app.navigationBars.buttons["Cancel"].tap()
      XCTAssertTrue(app.searchFields.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.buttons["workout-weight"].label, "Weight, 105 kg total")
      XCTAssertFalse(app.buttons["workout-assembly-add"].exists)
    }
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
    app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.buttons["gym-new-movement"].waitForExistence(timeout: 5))
    app.buttons["gym-new-movement"].tap()
    let name = app.textFields["gym-movement-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5)); name.tap(); name.typeText("Incline press UI")
    app.buttons["gym-movement-create-commit"].tap()
    XCTAssertTrue(app.buttons["Incline press UI"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-log"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["gym-movement-creation"].exists)
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, 0)
    app.descendants(matching: .any)["workout-current-set"].swipeRight()
    XCTAssertTrue(app.buttons["Romanian Deadlift"].waitForExistence(timeout: 5))
    app.descendants(matching: .any)["workout-current-set"].swipeRight()
    XCTAssertTrue(app.buttons["Back Squat"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["workout-weight"].label, "Weight, 105 kg total")
  }

  func testReceiptOptionsKeepsMinimumNativeTouchTarget() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-onboarding-appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 10))
    app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.staticTexts["Ended early."].waitForExistence(timeout: 10))
    let menu = app.buttons["workout-receipt-options"]
    XCTAssertTrue(menu.exists)
    for (edge, offset) in [
      ("top", CGVector(dx: 0, dy: -21.5)),
      ("bottom", CGVector(dx: 0, dy: 21.5)),
      ("leading", CGVector(dx: -21.5, dy: 0)),
      ("trailing", CGVector(dx: 21.5, dy: 0)),
    ] {
      XCTContext.runActivity(named: "Native options target: \(edge) edge of 44-point area") { _ in
        menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(offset).tap()
        let discard = app.buttons["Discard workout"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(discard.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ended early."].exists)
      }
    }
  }

  func testReceiptMenuPreservesNormalEarlyAndFirstReceipts() {
    for (board, extraSets, title, keep) in [
      ("workout-planned", 2, "Well done.", false),
      ("workout-planned", 0, "Ended early.", false),
      ("workout-planned-first", 2, "Well done.", true),
    ] {
      let app = XCUIApplication()
      app.launchArguments = ["-model-server", "-board", board, "-onboarding-appearance", keep ? "light" : "dark"]
      app.launch()
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
      for _ in 0..<extraSets { app.buttons["workout-log"].tap() }
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10))
      let share = app.buttons["workout-share-coach"], done = app.buttons["workout-done"]
      XCTAssertEqual(share.label, "👑 Share with Coach")
      XCTAssertEqual(share.frame.height, 52, accuracy: 1)
      XCTAssertEqual(done.frame.height, 52, accuracy: 1)
      XCTAssertEqual(done.frame.minY - share.frame.maxY, 12, accuracy: 1)
      XCTAssertEqual(share.frame.width, app.frame.width - 32, accuracy: 1)
      XCTAssertEqual(app.buttons["workout-keep"].exists, keep)
      let menu = app.buttons["workout-receipt-options"]
      XCTAssertTrue(menu.exists); XCTAssertGreaterThanOrEqual(menu.frame.height, 43.99)
      XCTAssertLessThan(menu.frame.maxY, share.frame.minY)
      XCTAssertFalse(app.buttons["Discard workout"].exists)
      menu.tap()
      XCTAssertTrue(app.buttons["Discard workout"].waitForExistence(timeout: 5))
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      XCTAssertTrue(app.buttons["Discard workout"].waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts[title].exists)
      menu.tap()
      XCTAssertTrue(app.buttons["Discard workout"].waitForExistence(timeout: 5)); app.buttons["Discard workout"].tap()
      let question = app.alerts["Discard this workout?"]
      XCTAssertTrue(question.waitForExistence(timeout: 5))
      XCTAssertTrue(question.staticTexts["This deletes the workout and its \(extraSets + 2) sets. You can’t undo this."].exists)
      question.buttons["Cancel"].tap()
      XCTAssertTrue(question.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts[title].exists)
      XCTAssertEqual(app.buttons["workout-keep"].exists, keep)
      done.tap()
      XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
      app.terminate()
    }
  }

  func testReceiptDiscardConfirmationReturnsToLog() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-onboarding-appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 10)); app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.buttons["workout-receipt-options"].waitForExistence(timeout: 10)); app.buttons["workout-receipt-options"].tap()
    XCTAssertTrue(app.buttons["Discard workout"].waitForExistence(timeout: 5)); app.buttons["Discard workout"].tap()
    let question = app.alerts["Discard this workout?"]
    XCTAssertTrue(question.waitForExistence(timeout: 5)); question.buttons["Discard"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["workout-done"].exists)
  }
}
