import XCTest

@MainActor final class WorkoutOutsideFlowTests: XCTestCase {
  // Shortcuts lists Windmill's two App Shortcuts, so the intents are registered with the system.
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
    shortcuts.terminate()
  }
}
