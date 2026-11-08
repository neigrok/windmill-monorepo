import XCTest

// The journal against the verify skill's isolated backend: a page written from the accessory backs up, words written while
// the server cannot be reached wait on the phone, and back up once it answers again.
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

  func testAPageBacksUpWaitsWhileTheServerIsAwayAndBacksUpWhenItAnswers() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let server = environment["WM_JOURNAL_E2E_SERVER"], let session = environment["WM_JOURNAL_E2E_SESSION"] else {
      throw XCTSkip("requires the verify skill's isolated backend")
    }
    var app = launch(server, session: session, relaunch: false)
    let first = "A page from the phone."
    write(first, after: "", in: app)
    XCTAssertTrue(app.todayBackedUp.waitForExistence(timeout: 30), "\(app.buttons["write-today"].value ?? "")")
    app.terminate()

    app = launch("http://127.0.0.1:1", session: session, relaunch: true)
    let offline = " Written while the server is away."
    write(offline, after: first, in: app)
    let waiting = app.buttons.matching(NSPredicate(format: "identifier == %@ AND value CONTAINS %@", "write-today", "Not backed up yet")).firstMatch
    XCTAssertTrue(waiting.waitForExistence(timeout: 15), "\(app.buttons["write-today"].value ?? "")")
    app.terminate()

    app = launch(server, session: session, relaunch: true)
    XCTAssertTrue(app.todayBackedUp.waitForExistence(timeout: 30), "\(app.buttons["write-today"].value ?? "")")
    XCTAssertEqual(app.textViews["journal-editor"].value as? String, first + offline)
  }
}
