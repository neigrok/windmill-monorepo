import XCTest

@MainActor final class WorkoutOutsideFlowTests: XCTestCase {
  func testShortcutsListLogSetAndStartWorkoutWithNothingToSet() {
    continueAfterFailure = false
    XCUIApplication().launch()
    XCUIDevice.shared.press(.home)
    let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
    shortcuts.launch()
    let windmill = shortcuts.buttons["Windmill"]
    XCTAssertTrue(windmill.waitForExistence(timeout: 10)); windmill.tap()
    let tiles = shortcuts.cells.containing(.staticText, identifier: "Log set").firstMatch
    XCTAssertTrue(tiles.waitForExistence(timeout: 10))
    XCTAssertEqual(tiles.staticTexts.allElementsBoundByIndex.map(\.label), ["Log set", "Start workout"])
    XCTAssertEqual(tiles.buttons.allElementsBoundByIndex.map(\.identifier), ["plus", "dumbbell.fill"])
    capture("shortcuts-windmill-\(ProcessInfo.processInfo.environment["WM_APPEARANCE"] ?? "light")")
    shortcuts.terminate()
  }

  // The control in Control Center (Figma Gym · iOS 04.1): each state drawn, and Log set from it with the app behind.
  func testControlDrawsEachStateAndLogsTheRackFromControlCenter() {
    continueAfterFailure = false
    let appearance = ProcessInfo.processInfo.environment["WM_APPEARANCE"] ?? "light"
    let app = XCUIApplication(), springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    app.launchArguments = ["-model-server", "-board", "workout-live-activity-planned", "-onboarding-appearance", appearance]
    app.launch()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 20))
    let progress = app.descendants(matching: .any)["workout-set-progress"]
    XCTAssertTrue(progress.waitForValue("2 of 4 sets"))
    let before = app.workoutLedgerRows().filter { $0.identifier.hasPrefix("workout-set-") }
    XCTAssertEqual(before.map(\.label), ["Set 1, logged, 100 kilograms, 5 reps", "Set 2, logged, 100 kilograms, 5 reps"])
    XCUIDevice.shared.press(.home)

    let control = controlCenterControl(springboard)
    XCTAssertTrue(control.wait(for: \.label, toEqual: "Log set", timeout: 10), "\(control.debugDescription)")
    XCTAssertEqual(control.value as? String, "100 × 5")
    capture("control-log-set-\(appearance)")
    control.tap()
    XCTAssertTrue(control.wait(for: \.label, toEqual: "Log set", timeout: 10))
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(progress.waitForValue("3 of 4 sets"))
    let after = app.workoutLedgerRows().filter { $0.identifier.hasPrefix("workout-set-") }
    XCTAssertEqual(after.map(\.label), ["Set 1, logged, 100 kilograms, 5 reps", "Set 2, logged, 100 kilograms, 5 reps",
      "Set 3, logged, 100 kilograms, 5 reps"])
    XCTAssertEqual(after.prefix(before.count).map(\.identifier), before.map(\.identifier))
    XCTAssertEqual(Set(after.map(\.identifier)).count, 3)

    app.buttons["workout-assembly"].tap()
    let hide = app.buttons["Hide workout"]
    XCTAssertTrue(hide.waitForExistence(timeout: 5)); hide.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(controlCenterControl(springboard).wait(for: \.label, toEqual: "Open workout", timeout: 10))
    capture("control-open-workout-\(appearance)")
    controlCenterControl(springboard).tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    XCTAssertTrue(progress.waitForValue("3 of 4 sets"))
    let reopened = app.workoutLedgerRows().filter { $0.identifier.hasPrefix("workout-set-") }
    XCTAssertEqual(reopened.map(\.identifier), after.map(\.identifier))
    XCTAssertEqual(reopened.map(\.label), after.map(\.label))

    app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10)); app.buttons["Done"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(controlCenterControl(springboard).wait(for: \.label, toEqual: "Start workout", timeout: 10))
    capture("control-start-workout-\(appearance)")
    controlCenterControl(springboard).tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Routines"].isSelected)
    XCTAssertFalse(app.descendants(matching: .any)["gym-session-detail"].exists)
    capture("control-start-workout-opened-\(appearance)")
  }

  // Control Center open, the workout control in it: added from the gallery the first time and widened to its medium size.
  func controlCenterControl(_ springboard: XCUIApplication) -> XCUIElement {
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.003)).press(forDuration: 0.05,
      thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.6)))
    let control = springboard.buttons.matching(identifier: "works.windmill.app.workout").firstMatch
    if control.waitForExistence(timeout: 3) { return control }
    let add = springboard.buttons["Add Controls"]
    XCTAssertTrue(add.waitForExistence(timeout: 5)); add.tap()
    let gallery = springboard.buttons["Add a Control"]
    XCTAssertTrue(gallery.waitForExistence(timeout: 5)); gallery.tap()
    let search = springboard.searchFields["Search Controls"]
    XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("Windmill")
    let tutorial = springboard.buttons["Continue"]
    if tutorial.waitForExistence(timeout: 2) { tutorial.tap() }
    let workout = springboard.icons["Workout"]
    XCTAssertTrue(workout.waitForExistence(timeout: 5), "\(springboard.debugDescription)"); workout.tap()
    let added = springboard.icons["Workout"], origin = springboard.coordinate(withNormalizedOffset: .zero)
    let sized = { (size: String) in XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in added.value as? String == size }, object: nil) }
    XCTAssertEqual(XCTWaiter.wait(for: [sized("1 by 1")], timeout: 5), .completed)
    origin.withOffset(CGVector(dx: added.frame.maxX - 6, dy: added.frame.maxY - 6)).press(forDuration: 0.4,
      thenDragTo: origin.withOffset(CGVector(dx: added.frame.maxX + 90, dy: added.frame.maxY - 6)))
    XCTAssertEqual(XCTWaiter.wait(for: [sized("2 by 1")], timeout: 5), .completed)
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
    XCTAssertTrue(control.waitForExistence(timeout: 5), "\(springboard.debugDescription)")
    return control
  }

  func capture(_ name: String) {
    let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
  }
}
