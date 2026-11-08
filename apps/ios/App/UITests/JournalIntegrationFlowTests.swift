import XCTest

// The journal against the verify skill's backend: a page backs up, words written while it is away wait, then back up.
@MainActor final class JournalIntegrationFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func launch(_ server: String, session: String, relaunch: Bool) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-scenario", "gym-e2e", "-server", server, "-telemetry", "-code-file", session] + (relaunch ? ["-restore-board"] : [])
    app.launch()
    let menu = app.buttons["room-menu"]
    XCTAssertTrue(menu.waitForHittable(timeout: 20))
    if menu.label != "Journal" {
      menu.tap()
      let journal = app.roomItem("Journal")
      XCTAssertTrue(journal.waitForExistence(timeout: 5)); journal.tap()
    }
    XCTAssertTrue(app.buttons["write-today"].waitForHittable(timeout: 20))
    return app
  }

  func write(_ words: String, after previous: String, in app: XCUIApplication) {
    app.buttons["write-today"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText(words)
    XCTAssertTrue(app.textViews["journal-editor"].waitForValue(previous + words))
    app.buttons["done-writing"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
  }

  // You names whether the account holds everything this phone wrote; it closes again before the next step.
  func assertAccount(_ status: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    app.buttons["you"].tap()
    let you = app.navigationBars["You"]
    XCTAssertTrue(you.waitForExistence(timeout: 10), file: file, line: line)
    XCTAssertTrue(app.staticTexts[status].waitForExistence(timeout: 30), "You reads \(status)", file: file, line: line)
    you.buttons["Done"].tap()
    XCTAssertTrue(you.waitForNonExistence(timeout: 5), file: file, line: line)
  }

  func testAPageBacksUpWaitsWhileTheServerIsAwayAndBacksUpWhenItAnswers() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let server = environment["WM_JOURNAL_E2E_SERVER"], let session = environment["WM_JOURNAL_E2E_SESSION"] else {
      throw XCTSkip("requires the verify skill's isolated backend")
    }
    var app = launch(server, session: session, relaunch: false)
    let first = "A page from the phone."
    write(first, after: "", in: app)
    assertAccount("Backed up", in: app)
    app.terminate()

    app = launch("http://127.0.0.1:1", session: session, relaunch: true)
    let offline = " Written while the server is away."
    write(offline, after: first, in: app)
    assertAccount("Not backed up yet", in: app)
    app.terminate()

    app = launch(server, session: session, relaunch: true)
    assertAccount("Backed up", in: app)
    XCTAssertEqual(app.textViews["journal-editor"].value as? String, first + offline)
  }
}
