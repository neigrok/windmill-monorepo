import XCTest

@MainActor final class WorkoutOutsideFlowTests: XCTestCase {
  // Shortcuts lists Windmill's two App Shortcuts, so the intents are registered with the system. Its first launch shows
  // What's New over All Shortcuts; Windmill stands under Apps in the Library that All Shortcuts goes back to.
  func testShortcutsListLogSetAndStartWorkoutWithNothingToSet() {
    continueAfterFailure = false
    XCUIApplication().launch()
    XCUIDevice.shared.press(.home)
    let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
    shortcuts.launch()
    let whatsNew = shortcuts.buttons["Continue"], library = shortcuts.navigationBars.buttons["Library"]
    let windmill = shortcuts.buttons["Windmill"]
    let opened = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in whatsNew.exists || library.exists || windmill.exists }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [opened], timeout: 15), .completed, "Shortcuts opens")
    if whatsNew.exists { whatsNew.tap() }
    if !windmill.exists, library.waitForExistence(timeout: 10) { library.tap() }
    XCTAssertTrue(windmill.waitForExistence(timeout: 10)); windmill.tap()
    let tiles = shortcuts.cells.containing(.staticText, identifier: "Log set").firstMatch
    XCTAssertTrue(tiles.waitForExistence(timeout: 10))
    XCTAssertEqual(tiles.staticTexts.allElementsBoundByIndex.map(\.label), ["Log set", "Start workout"])
    XCTAssertEqual(tiles.buttons.allElementsBoundByIndex.map(\.identifier), ["plus", "dumbbell.fill"])
    shortcuts.terminate()
  }
}
