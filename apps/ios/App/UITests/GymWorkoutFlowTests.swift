import XCTest

@MainActor final class GymWorkoutFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func launch(_ board: String = "workout-planned", appearance: String = "dark") -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board, "-onboarding-appearance", appearance]
    app.launch()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10),
                  "BoardFixture must call WorkoutFixture.prepare before the journal fixture. The shared fixture hook is outside Workout territory.")
    return app
  }

  func testKeypadCancelCommitAndLiveFix() {
    let app = launch()
    app.buttons["workout-weight"].tap()
    XCTAssertTrue(app.buttons["workout-key-1"].waitForExistence(timeout: 5))
    app.buttons["workout-key-1"].tap(); app.buttons["workout-key-2"].tap()
    XCTAssertEqual(app.staticTexts["workout-keypad-value"].label, "12")
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["workout-weight"].label.contains("100"))
    app.buttons["workout-weight"].tap()
    app.buttons["workout-key-1"].tap(); app.buttons["workout-key-0"].tap(); app.buttons["workout-key-5"].tap()
    app.buttons["workout-keypad-set"].tap()
    app.buttons["workout-log"].tap()
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    XCTAssertTrue(app.buttons["workout-fix-save"].waitForExistence(timeout: 5))
    let note = app.textViews["workout-fix-note"]
    note.tap(); note.typeText("A retained set note")
    app.buttons["workout-fix-save"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
  }

  func testPagerAssemblyAndHeavierBoundary() {
    let app = launch()
    let weight = app.buttons["workout-weight"]
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in weight.exists && weight.isEnabled && weight.isHittable }, object: weight)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
    weight.tap()
    XCTAssertTrue(app.buttons["workout-key-1"].waitForExistence(timeout: 5))
    for key in ["1", "0", "5"] { app.buttons["workout-key-\(key)"].tap() }
    app.buttons["workout-keypad-set"].tap(); app.buttons["workout-log"].tap()
    app.buttons["workout-next"].tap()
    XCTAssertTrue(app.buttons["workout-deviation-today"].waitForExistence(timeout: 5))
    app.buttons["workout-deviation-today"].tap()
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
    app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
    app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText("Bench")
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
    app.buttons["gym-movement-bench-press"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Bench Press"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["workout-weight"].label, "Weight, 20 kilograms")
    app.buttons["workout-log"].tap()
    let chosenSet = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(chosenSet.waitForExistence(timeout: 5))
    XCTAssertTrue(chosenSet.label.contains("20 kg, 5 reps"))
    app.buttons["workout-previous"].tap()
    XCTAssertTrue(app.buttons["Romanian Deadlift"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, 0)
  }

  func testFinishRetainsReceiptAndSaveRoutineInBothAppearances() {
    for appearance in ["light", "dark"] {
      let app = launch("workout-free", appearance: appearance)
      app.buttons["workout-log"].tap(); app.buttons["workout-log"].tap()
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.staticTexts["Well done."].waitForExistence(timeout: 5),
                    "GymRoom must retain the cover using gym.workout.isPresented after Finish clears openSession.")
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = "receipt-\(appearance)"; attachment.lifetime = .keepAlways; add(attachment)
      app.swipeUp()
      let save = app.buttons["workout-save-routine"]
      XCTAssertTrue(save.waitForExistence(timeout: 5)); save.tap()
      XCTAssertTrue(app.staticTexts["workout-routine-kept"].waitForExistence(timeout: 5))
      app.buttons["Done"].tap()
      XCTAssertFalse(app.buttons["workout-log"].exists)
      app.terminate()
    }
  }

  func testHiddenWorkoutRestoresFromGymSettingsWithItsSets() {
    let app = launch()
    app.buttons["workout-log"].tap()
    let retained = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 5)); app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["you-gym-settings"].waitForExistence(timeout: 5)); app.buttons["you-gym-settings"].tap()
    XCTAssertTrue(app.buttons["gym-restore-workout"].waitForExistence(timeout: 5)); app.buttons["gym-restore-workout"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, retained)
  }

  func testDismissLocalFailureRevealsDurableWorkoutRefusal() {
    let app = launch("workout-notice")
    XCTAssertTrue(app.staticTexts["Check the weight and reps before logging."].waitForExistence(timeout: 5))
    app.otherElements["workout-refusal"].buttons["Dismiss message"].tap()
    let retained = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "never reached the log")).firstMatch
    XCTAssertTrue(retained.waitForExistence(timeout: 5))
    app.otherElements["workout-refusal"].buttons["Dismiss message"].tap()
    XCTAssertTrue(retained.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-log"].exists)
  }
}
