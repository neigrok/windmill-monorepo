import XCTest

// The Home Screen's quick actions (Shell · iOS 22), each chosen once while Windmill runs in the background and once from a
// cold start. A launch from the Home Screen carries no arguments, so the first launch keeps its own for the later ones.
@MainActor final class QuickActionFlowTests: XCTestCase {
  let app = XCUIApplication()
  let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

  override func setUp() { continueAfterFailure = false }

  override func tearDown() async throws {
    await MainActor.run {
      app.launchArguments = ["-model-server", "-board", "workout-planned"]; app.launch(); app.terminate()
    }
    try await super.tearDown()
  }

  func choose(_ item: String, cold: Bool) {
    if cold { app.terminate() } else { XCUIDevice.shared.press(.home) }
    let icon = springboard.icons["Windmill"]
    XCTAssertTrue(icon.waitForExistence(timeout: 10)); icon.press(forDuration: 1.5)
    let action = springboard.buttons[item]
    XCTAssertTrue(action.waitForExistence(timeout: 5)); action.tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
  }

  func finishWorkout() {
    XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 10)); app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10)); app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["Done"].waitForNonExistence(timeout: 10))
  }

  func testEveryItemOpensItsPlaceFromTheBackgroundAndFromAColdStart() {
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-keep-for-relaunch"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-assembly"].waitForExistence(timeout: 10)); app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForNonExistence(timeout: 5))

    for cold in [false, true] {
      choose("Open workout", cold: cold)
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 15), "Open workout brings the running workout forward")
    }
    finishWorkout()
    for cold in [false, true] {
      choose("Start Lower A", cold: cold)
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 15), "Start Lower A opens straight into its workout")
      XCTAssertTrue(app.buttons["Back Squat"].exists)
      finishWorkout()
    }
    for cold in [false, true] {
      choose("Write tonight", cold: cold)
      XCTAssertTrue(app.buttons["done-writing"].waitForExistence(timeout: 15), "Write tonight opens tonight's page with the keyboard up")
    }
  }
}
