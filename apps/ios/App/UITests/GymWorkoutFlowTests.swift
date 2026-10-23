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
    let weight = app.buttons["workout-weight"]
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in weight.exists && weight.isEnabled && weight.isHittable }, object: weight)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
    weight.tap()
    app.turnLoadWheel(to: "105"); app.buttons["workout-log"].tap()
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
    app.buttons["workout-log"].tap()
    let chosenSet = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(chosenSet.waitForExistence(timeout: 5))
    XCTAssertEqual(chosenSet.label, "Set 1, logged, 20 kilograms, 5 reps")
    app.descendants(matching: .any)["workout-current-set"].swipeRight()
    XCTAssertTrue(app.buttons["Romanian Deadlift"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, 0)
  }
}
