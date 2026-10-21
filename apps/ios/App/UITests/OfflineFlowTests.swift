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
    XCTAssertTrue(email.waitForValue("shell@example.com"))
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
    ready(app.buttons["new-routine"]); app.buttons["new-routine"].tap()
    let name = app.textFields["routine-name"]
    ready(name); name.tap(); name.typeText("Offline routine\n")
    app.buttons["add-movement"].tap()
    ready(app.buttons["gym-movement-bench-press"]); app.buttons["gym-movement-bench-press"].tap()
    app.buttons["save-routine"].tap()
    ready(app.buttons["routine-start"]); app.buttons["routine-start"].tap()
    let progress = app.descendants(matching: .any)["workout-set-progress"]
    ready(app.buttons["workout-log"]); app.buttons["workout-log"].tap()
    XCTAssertTrue(progress.waitForValue("1 set"))
    var saved = app.workoutLedgerRows().filter { $0.identifier.hasPrefix("workout-set-") }
    XCTAssertEqual(saved.count, 1, "Pending sign-in must not prevent a local set from being saved.")

    for cold in [false, true] {
      ready(app.buttons["workout-assembly"]); app.buttons["workout-assembly"].tap()
      ready(app.buttons["workout-hide"]); app.buttons["workout-hide"].tap()
      if cold {
        app.terminate(); app.launch()
        ready(app.buttons["Done"]); app.buttons["Done"].tap()
      }
      ready(app.buttons["gym-hidden-workout"]); app.buttons["gym-hidden-workout"].tap()
      ready(app.buttons["workout-log"])
      XCTAssertTrue(progress.waitForValue(cold ? "2 sets" : "1 set"))
      let restored = app.workoutLedgerRows().filter { $0.identifier.hasPrefix("workout-set-") }
      XCTAssertEqual(restored.map(\.identifier), saved.map(\.identifier))
      XCTAssertEqual(restored.map(\.label), saved.map(\.label))
      app.buttons["workout-log"].tap()
      XCTAssertTrue(progress.waitForValue(cold ? "3 sets" : "2 sets"))
      let after = app.workoutLedgerRows().filter { $0.identifier.hasPrefix("workout-set-") }
      XCTAssertEqual(after.count, cold ? 3 : 2)
      XCTAssertEqual(Set(after.map(\.identifier)).count, after.count)
      XCTAssertEqual(after.prefix(saved.count).map(\.identifier), saved.map(\.identifier))
      XCTAssertEqual(after.prefix(saved.count).map(\.label), saved.map(\.label))
      saved = after
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
    XCTAssertTrue(email.waitForValue("offline@example.invalid"))
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
    showsTyped(app.textViews["journal-editor"], "Saved on this phone. Still writing.")
  }

  func testNoNetworkYouDisablesTheSignInDoorsAndSaysWhyOnce() {
    let app = launch(mode: "no-network", signedIn: false)
    ready(app.buttons["you"])
    app.buttons["you"].tap()
    let email = app.buttons["email-sign-in"]
    XCTAssertTrue(email.waitForExistence(timeout: 5))
    XCTAssertFalse(email.isEnabled, "Offline, the email door waits for a connection")
    if app.buttons["apple-sign-in"].exists { XCTAssertFalse(app.buttons["apple-sign-in"].isEnabled, "Offline, the Apple door waits too") }
    XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "Sign-in needs a connection.")).count, 1)
    XCTAssertTrue(app.buttons["about-windmill"].isEnabled, "Settings stay reachable offline")
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

  // The editor publishes its last keystrokes a moment after the keyboard has sent them.
  func showsTyped(_ editor: XCUIElement, _ text: String, file: StaticString = #filePath, line: UInt = #line) {
    let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: editor)
    XCTAssertEqual(XCTWaiter.wait(for: [shown], timeout: 5), .completed, "The editor must show what was typed: \(editor.value ?? "nothing")",
                   file: file, line: line)
  }

  // Home hands the app to SpringBoard, which may keep it running or suspend it; either way it has left the foreground.
  func leaveForeground(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    XCUIDevice.shared.press(.home)
    let backgrounded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      app.state == .runningBackground || app.state == .runningBackgroundSuspended
    }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [backgrounded], timeout: 10), .completed, "The app must leave the foreground before it resumes.",
                   file: file, line: line)
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
    showsTyped(editor, previous + suffix)
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
      app.buttons["save-routine"].tap()
      ready(app.buttons["routine-start"]); app.buttons["routine-start"].tap()
    }
    ready(app.buttons["workout-log"])
    ready(app.buttons["workout-assembly"])
    app.buttons["workout-assembly"].tap()
    ready(app.buttons["workout-hide"])
    app.buttons["workout-hide"].tap()
    ready(app.tabBars.buttons["Coach"])
    app.tabBars.buttons["Coach"].tap()
    if app.launchArguments.contains("no-network") {
      XCTAssertTrue(app.staticTexts["Coach needs a connection."].waitForExistence(timeout: 3))
    } else {
      XCTAssertTrue(app.descendants(matching: .any)["gym-coach"].waitForExistence(timeout: 3))
    }
    ready(app.buttons["you"])
    app.buttons["you"].tap()
    ready(app.buttons["settings-notes"])
    app.buttons["settings-notes"].tap()
    XCTAssertTrue(app.navigationBars["Notes"].waitForExistence(timeout: 3))
    app.navigationBars["Notes"].buttons.element(boundBy: 0).tap()
    ready(app.navigationBars["You"].buttons["Done"])
    app.navigationBars["You"].buttons["Done"].tap()
    openYou(app, signedIn: signedIn)
    switchRoom("Journal", in: app)
    XCTAssertEqual(editor.value as? String, previous + suffix)
  }

  func openYou(_ app: XCUIApplication, signedIn: Bool) {
    ready(app.buttons["you"])
    app.buttons["you"].tap()
    ready(app.buttons["Done"])
    if signedIn {
      XCTAssertTrue(app.buttons["sign-out"].exists, "The saved account must survive an unavailable server.")
    } else {
      XCTAssertTrue(app.staticTexts["Not signed in"].exists)
    }
    app.buttons["Done"].tap()
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
