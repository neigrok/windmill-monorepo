import XCTest

@MainActor final class OfflineFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // The worst network: TCP to the server hangs, signed in, through a cold launch, a resume and a relaunch.
  func testBlackHoleAPISignedInColdLaunchAndResume() { exercise(mode: "black-hole", signedIn: true) }
  // A resume while hello is still in flight, signed out.
  func testStalledNetworkSignedOutResumeDuringHello() { exercise(mode: "stalled", signedIn: false, resumeDuringLaunch: true) }

  // A seed launch on the model server keeps a page, and the account when signed in; the HTTP launch then meets the network.
  func exercise(mode: String, signedIn: Bool, resumeDuringLaunch: Bool = false) {
    let state = signedIn ? "signed-in" : "signed-out"
    let scenario = "offline-\(mode)-\(state)"
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-scenario", scenario, "-offline-fixture", "seed-\(state)"]
    app.launch()
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10), "The seed must persist its page and account before the HTTP launch.")
    app.terminate()
    let server = mode == "black-hole" ? "https://192.0.2.1" : "https://offline.invalid"
    app.launchArguments = ["-scenario", scenario, "-restore-board", "-server", server, "-offline-fixture", mode]
    app.launch()
    if resumeDuringLaunch {
      leaveForeground(app)
      app.activate()
    }
    useLocalRooms(app, suffix: " Cold.", signedIn: signedIn, restoringWorkout: false)
    leaveForeground(app)
    app.activate()
    useLocalRooms(app, suffix: " Resume.", signedIn: signedIn, restoringWorkout: true)

    app.terminate()
    app.launch()
    ready(app.buttons["room-menu"])
    XCTAssertEqual(app.textViews["journal-editor"].value as? String, "Saved on this phone. Cold. Resume.")
  }

  // Home hands the app to SpringBoard, which may keep it running or suspend it; either way it has left the foreground.
  // SpringBoard can let a press go while the app is still launching, so an unanswered press is pressed once more.
  func leaveForeground(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    for _ in 0..<2 {
      XCUIDevice.shared.press(.home)
      let backgrounded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        app.state == .runningBackground || app.state == .runningBackgroundSuspended
      }, object: nil)
      if XCTWaiter.wait(for: [backgrounded], timeout: 10) == .completed { return }
    }
    XCTFail("The app must leave the foreground before it resumes.", file: file, line: line)
  }

  func useLocalRooms(_ app: XCUIApplication, suffix: String, signedIn: Bool, restoringWorkout: Bool) {
    ready(app.buttons["room-menu"])
    ready(app.buttons["you"])
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 3))
    let previous = editor.value as? String ?? ""
    ready(app.buttons["write-today"])
    app.buttons["write-today"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
    app.typeText(suffix)
    // The editor publishes its last keystrokes a moment after the keyboard has sent them.
    XCTAssertTrue(editor.waitForValue(previous + suffix, timeout: 5), "The editor must show what was typed: \(editor.value ?? "nothing")")
    app.buttons["done-writing"].tap()

    switchRoom("Gym", in: app)
    if restoringWorkout {
      ready(app.buttons["gym-hidden-workout"])
      app.buttons["gym-hidden-workout"].tap()
    } else {
      ready(app.tabBars.buttons["Routines"])
      app.tabBars.buttons["Routines"].tap()
      ready(app.buttons["new-routine"]); app.buttons["new-routine"].tap()
      let name = app.textFields["routine-name"]
      ready(name); name.tap(); name.typeText("Offline routine\n")
      app.buttons["add-movement"].tap()
      ready(app.buttons["gym-movement-bench-press"]); app.buttons["gym-movement-bench-press"].tap()
      let movementName = app.textFields["gym-movement-name"]
      ready(movementName); XCTAssertEqual(movementName.value as? String, "Bench Press")
      XCTAssertTrue(app.textFields["gym-target-sets"].exists)
      let add = app.buttons["gym-movement-editor-commit"]
      ready(add); XCTAssertEqual(add.label, "Add"); add.tap()
      ready(app.buttons["builder-movement-bench-press"])
      ready(app.buttons["save-routine"]); app.buttons["save-routine"].tap()
      ready(app.buttons["routine-start"]); app.buttons["routine-start"].tap()
    }
    ready(app.buttons["workout-log"])
    ready(app.buttons["workout-assembly"])
    app.buttons["workout-assembly"].tap()
    ready(app.buttons["workout-hide"])
    app.buttons["workout-hide"].tap()
    ready(app.tabBars.buttons["Coach"])
    app.tabBars.buttons["Coach"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-coach"].waitForExistence(timeout: 3))
    ready(app.buttons["you"])
    app.buttons["you"].tap()
    ready(app.buttons["settings-notes"])
    if signedIn {
      XCTAssertTrue(app.buttons["sign-out"].exists, "The saved account must survive an unavailable server.")
    } else {
      XCTAssertTrue(app.staticTexts["Not signed in"].exists)
    }
    // The sheet's list can let a tap go unanswered while it settles, so an unanswered tap is tapped once more.
    let notes = app.navigationBars["Notes"]
    for _ in 0..<2 where !notes.exists {
      app.buttons["settings-notes"].tap()
      _ = notes.waitForExistence(timeout: 3)
    }
    XCTAssertTrue(notes.exists)
    app.navigationBars["Notes"].buttons.element(boundBy: 0).tap()
    ready(app.navigationBars["You"].buttons["Done"])
    app.navigationBars["You"].buttons["Done"].tap()
    switchRoom("Journal", in: app)
    XCTAssertEqual(editor.value as? String, previous + suffix)
  }

  func switchRoom(_ room: String, in app: XCUIApplication) {
    let menu = app.buttons["room-menu"]
    ready(menu)
    menu.tap()
    let item = app.roomItem(room)
    ready(item)
    item.tap()
    XCTAssertTrue(menu.wait(for: \.label, toEqual: room, timeout: 3))
  }

  func ready(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
    let enabled = NSPredicate { _, _ in element.exists && element.isEnabled && element.isHittable }
    if enabled.evaluate(with: element) { return }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: enabled, object: element)], timeout: 3), .completed,
                   "Local controls must be usable without waiting for any network request.", file: file, line: line)
  }
}
