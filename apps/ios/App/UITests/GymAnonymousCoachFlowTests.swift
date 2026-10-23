import XCTest

@MainActor final class GymAnonymousCoachFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func capture(_ app: XCUIApplication, _ name: String) throws {
    guard let path = ProcessInfo.processInfo.environment["WM_ANONYMOUS_COACH_SHOTS"] else { return }
    let directory = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try app.screenshot().pngRepresentation.write(to: directory.appending(path: name + ".png"))
  }

  func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    let scroll = app.scrollViews.firstMatch
    for _ in 0..<16 {
      let frame = element.frame
      let top = app.buttons["you"].frame.maxY + 8
      let bottom = app.descendants(matching: .any)["coach-question"].frame.minY - 16
      if element.exists, element.isHittable, frame.minY >= top, frame.maxY <= bottom { return }
      let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
      let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: element.exists && frame.height > 0 && frame.minY < top ? 0.75 : 0.35))
      start.press(forDuration: 0.05, thenDragTo: end)
    }
    XCTFail("The Coach control did not become visible above the composer.")
  }

  // Signed out, Coach greets, drafts routines from one question and the lifter applies them; Keep your routines signs in,
  // the same conversation goes on, and the next question gets a change to the routine it created. With
  // WM_ANONYMOUS_COACH_SERVER the signed-out half runs against that backend.
  func testSignedOutCoachDraftsKeepsAndContinuesSignedIn() throws {
    let server = ProcessInfo.processInfo.environment["WM_ANONYMOUS_COACH_SERVER"]
    let app = XCUIApplication()
    app.launchArguments = ["-scenario", "gym-e2e-anonymous-" + UUID().uuidString, "-server", server ?? "https://gym.invalid",
      "-onboarding-appearance", "light", "-AppleLocale", "en_US", "-AppleLanguages", "(en)"]
    if server != nil { app.launchArguments += ["-telemetry"] + (ProcessInfo.processInfo.environment["WM_GYM_E2E_SENTRY"].map { ["-sentry-dsn", $0] } ?? []) }
    else { app.launchArguments += ["-model-server", "-coach-fixture", "-coach-board", "after-sign-in"] }
    app.launch()
    XCTAssertTrue(app.staticTexts["coach-greeting"].waitForExistence(timeout: 25))
    XCTAssertFalse(app.buttons["coach-history"].exists)
    try capture(app, "anonymous-greeting")
    let question = app.descendants(matching: .any)["coach-question"]
    question.tap(); question.typeText("Build a short full body routine for three days each week")
    let done = app.buttons["coach-keyboard-done"], keyboard = app.keyboards.firstMatch, tab = app.tabBars.buttons["Coach"]
    XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
    XCTAssertTrue(done.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: false, timeout: 5))
    XCTAssertFalse(done.frame.intersects(app.buttons["coach-send"].frame))
    done.tap()
    XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))
    XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertEqual(question.value as? String, "Build a short full body routine for three days each week")
    app.buttons["coach-send"].tap()
    let apply = app.buttons["coach-save-routines"]
    XCTAssertTrue(apply.waitForExistence(timeout: 30))
    XCTAssertTrue(app.buttons["coach-reject-routines"].exists)
    reveal(apply, in: app); apply.tap()
    let created = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "coach-created-")).firstMatch
    XCTAssertTrue(created.waitForExistence(timeout: 30))
    XCTAssertTrue(app.descendants(matching: .any)["coach-read-receipt"].exists)
    let keep = app.buttons["coach-keep-routines"]
    reveal(keep, in: app); try capture(app, "anonymous-created")
    keep.tap()
    XCTAssertTrue(app.staticTexts["Keep your routines"].waitForExistence(timeout: 10))
    if server != nil { return }
    app.buttons["email-sign-in"].tap()
    let address = app.textFields["email-address"]
    XCTAssertTrue(address.waitForExistence(timeout: 5)); address.typeText("after-sign-in-" + UUID().uuidString.prefix(8).lowercased() + "@example.com")
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]; XCTAssertTrue(code.waitForExistence(timeout: 10)); code.typeText("482913")
    XCTAssertTrue(code.waitForNonExistence(timeout: 15))
    XCTAssertTrue(question.waitForExistence(timeout: 15))
    XCTAssertTrue(created.waitForExistence(timeout: 15), "The adopted conversation stays")
    question.tap(); question.typeText("Swap chin-ups for pulldowns")
    app.buttons["coach-send"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForExistence(timeout: 20),
                  "The signed-in send gets Coach's answer, with its change")
    XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    try capture(app, "anonymous-after-sign-in")
  }
}
