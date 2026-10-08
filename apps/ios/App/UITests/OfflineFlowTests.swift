import XCTest

@MainActor final class OfflineFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func testNoNetworkSignedOutColdLaunchAndResume() { exercise(mode: "no-network", signedIn: false) }
  func testNoNetworkSignedInColdLaunchAndResume() { exercise(mode: "no-network", signedIn: true) }
  func testUnreachableServerSignedOutColdLaunchAndResume() { exercise(mode: "unreachable", signedIn: false) }
  func testUnreachableServerSignedInColdLaunchAndResume() { exercise(mode: "unreachable", signedIn: true) }
  func testBlackHoleAPISignedOutColdLaunchAndResume() { exercise(mode: "black-hole", signedIn: false) }
  func testBlackHoleAPISignedInColdLaunchAndResume() { exercise(mode: "black-hole", signedIn: true) }
  func testStalledNetworkSignedOutColdLaunchAndResume() { exercise(mode: "stalled", signedIn: false) }
  func testStalledNetworkSignedInColdLaunchAndResume() { exercise(mode: "stalled", signedIn: true) }
  func testStalledNetworkSignedOutResumeDuringHello() { exercise(mode: "stalled", signedIn: false, resumeDuringLaunch: true) }
  func testStalledNetworkSignedInResumeDuringHello() { exercise(mode: "stalled", signedIn: true, resumeDuringLaunch: true) }

  func testPendingSignInKeepsWorkoutLoggingAndRestorationLocalAcrossRelaunch() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "shell-adoption-two-rooms"]
    app.launch()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10))
    app.buttons["email-sign-in"].tap()
    let email = app.textFields["email-address"]
    ready(email); email.tap(); email.typeText("shell@example.com")
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    ready(code); code.tap(); code.typeText("482913")
    let later = app.alerts["Add to your account?"].buttons["Not now"]
    XCTAssertTrue(later.waitForExistence(timeout: 10)); later.tap()
    ready(app.buttons["room-menu"])
    app.terminate()

    app.launchArguments = ["-board", "shell-adoption-two-rooms", "-restore-board", "-server", "https://offline.invalid", "-offline-fixture", "no-network"]
    app.launch()
    ready(app.buttons["Done"]); app.buttons["Done"].tap()
    switchRoom("Gym", in: app)
    ready(app.buttons["Just start logging"]); app.buttons["Just start logging"].tap()
    ready(app.buttons["workout-add"]); app.buttons["workout-add"].tap()
    let search = app.searchFields.firstMatch
    ready(search); search.tap(); search.typeText("Bench")
    ready(app.buttons["gym-movement-bench-press"]); app.buttons["gym-movement-bench-press"].tap()
    let sets = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-"))
    ready(app.buttons["workout-log"]); app.buttons["workout-log"].tap()
    XCTAssertEqual(sets.count, 1, "Pending sign-in must not prevent a local set from being saved.")
    let firstSet = sets.firstMatch.identifier

    for cold in [false, true] {
      ready(app.buttons["workout-assembly"]); app.buttons["workout-assembly"].tap()
      ready(app.buttons["workout-hide"]); app.buttons["workout-hide"].tap()
      if cold {
        app.terminate(); app.launch()
        ready(app.buttons["Done"]); app.buttons["Done"].tap()
      }
      ready(app.buttons["Just start logging"]); app.buttons["Just start logging"].tap()
      ready(app.buttons["workout-log"])
      XCTAssertTrue(sets.matching(identifier: firstSet).firstMatch.exists)
      XCTAssertEqual(sets.count, cold ? 2 : 1)
      app.buttons["workout-log"].tap()
      XCTAssertEqual(sets.count, cold ? 3 : 2)
    }
  }

  func testStalledEmailRequestCanBeDismissedAndJournalRemainsWritable() {
    let app = launch(mode: "stalled", signedIn: false)
    ready(app.buttons["you"])
    app.buttons["you"].tap()
    ready(app.buttons["email-sign-in"])
    app.buttons["email-sign-in"].tap()
    let email = app.textFields["email-address"]
    ready(email)
    email.tap(); email.typeText("offline@example.invalid")
    ready(app.buttons["Send code"])
    app.buttons["Send code"].tap()
    ready(app.buttons["Back"])
    app.buttons["Back"].tap()
    ready(app.buttons["Close"])
    app.buttons["Close"].tap()
    ready(app.buttons["write-today"])
    app.buttons["write-today"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
    app.typeText(" Still writing.")
    XCTAssertEqual(app.textViews["journal-editor"].value as? String, "Saved on this phone. Still writing.")
  }

  func launch(mode: String, signedIn: Bool) -> XCUIApplication {
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
    return app
  }

  func exercise(mode: String, signedIn: Bool, resumeDuringLaunch: Bool = false) {
    let app = launch(mode: mode, signedIn: signedIn)
    if resumeDuringLaunch {
      XCUIDevice.shared.press(.home)
      XCTAssertTrue(app.wait(for: .runningBackground, timeout: 3))
      app.activate()
    }
    useLocalRooms(app, suffix: " Cold.", signedIn: signedIn, restoringWorkout: false)
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 3))
    app.activate()
    useLocalRooms(app, suffix: " Resume.", signedIn: signedIn, restoringWorkout: true)

    app.terminate()
    app.launch()
    ready(app.buttons["room-menu"])
    XCTAssertEqual(app.textViews["journal-editor"].value as? String, "Saved on this phone. Cold. Resume.")
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
    XCTAssertEqual(editor.value as? String, previous + suffix)
    app.buttons["done-writing"].tap()

    switchRoom("Gym", in: app)
    if restoringWorkout {
      openSettings(app, signedIn: signedIn)
      ready(app.buttons["gym-restore-workout"])
      app.buttons["gym-restore-workout"].tap()
    } else {
      ready(app.tabBars.buttons["Routines"])
      app.tabBars.buttons["Routines"].tap()
      ready(app.buttons["Just start logging"])
      app.buttons["Just start logging"].tap()
    }
    ready(app.buttons["workout-add"])
    ready(app.buttons["workout-assembly"])
    app.buttons["workout-assembly"].tap()
    ready(app.buttons["workout-hide"])
    app.buttons["workout-hide"].tap()
    if restoringWorkout {
      let back = app.navigationBars["Gym settings"].buttons.element(boundBy: 0)
      ready(back)
      back.tap()
    }
    ready(app.tabBars.buttons["Coach"])
    app.tabBars.buttons["Coach"].tap()
    XCTAssertTrue(app.staticTexts["Coach needs a connection."].waitForExistence(timeout: 3))
    openSettings(app, signedIn: signedIn)
    let units = app.buttons[restoringWorkout ? "kg" : "lb"]
    ready(units)
    units.tap()
    XCTAssertTrue(units.isSelected)
    app.navigationBars["Gym settings"].buttons.element(boundBy: 0).tap()
    switchRoom("Journal", in: app)
    XCTAssertEqual(editor.value as? String, previous + suffix)
  }

  func openSettings(_ app: XCUIApplication, signedIn: Bool) {
    ready(app.buttons["you"])
    app.buttons["you"].tap()
    ready(app.buttons["Done"])
    if signedIn {
      XCTAssertTrue(app.buttons["sign-out"].exists, "The saved account must survive an unavailable server.")
    } else {
      XCTAssertTrue(app.staticTexts["Not signed in"].exists)
    }
    let settings = app.buttons["you-gym-settings"]
    if !settings.isHittable { app.swipeUp() }
    ready(settings)
    settings.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-settings"].waitForExistence(timeout: 3))
  }

  func switchRoom(_ room: String, in app: XCUIApplication) {
    let menu = app.buttons["room-menu"]
    ready(menu)
    menu.tap()
    let item = app.buttons["room-\(room.lowercased())"]
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
