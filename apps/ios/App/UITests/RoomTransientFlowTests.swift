import XCTest

// The one band names what went, and a swipe down sends an Undo band away while the act stays.
@MainActor final class RoomTransientFlowTests: XCTestCase {
  func testASwipeDownSendsTheUndoBandAwayAndTheDiscardStays() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "shell-anonymous", "-onboarding-appearance", "light", "-gym-log-fixture"]
    app.launch()
    XCTAssertTrue(app.buttons["open-gym"].waitForExistence(timeout: 15)); app.buttons["open-gym"].tap()
    XCTAssertTrue(app.tabBars.buttons["The log"].waitForExistence(timeout: 10)); app.tabBars.buttons["The log"].tap()
    let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 20))
    let id = row.identifier
    row.swipeLeft()
    let discard = app.buttons["Discard"]
    XCTAssertTrue(discard.wait(for: \.isHittable, toEqual: true, timeout: 5)); discard.tap()
    let band = app.descendants(matching: .any)["gym-log-undo-band"]
    XCTAssertTrue(band.waitForExistence(timeout: 5))
    XCTAssertTrue(band.staticTexts["Workout discarded"].exists)
    band.swipeDown()
    XCTAssertTrue(band.waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.buttons["gym-log-undo"].exists)
    XCTAssertFalse(app.buttons[id].exists)
  }
}
