import XCTest

// Roadmap Coach against a local stack (tools/coach-e2e/room_stack.py): the backend signing passes and serving roadmap
// through the sync engine, the AI service and a provider the stack plays, one origin in front. Signed in to the account a
// browser seeded, the phone opens the browser's conversation from History, asks from the Board and has its answer stream
// into the sheet, and a direct write lands on the phone's copy with its receipt and an Undo that takes it back.
@MainActor final class RoadmapCoachIntegrationFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func testAConversationBegunInABrowserOpensAndATurnRunsAgainstTheStack() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let server = environment["WM_COACH_E2E_SERVER"], let session = environment["WM_COACH_E2E_SESSION"] else {
      throw XCTSkip("requires tools/coach-e2e/room_stack.py")
    }
    let app = XCUIApplication()
    app.launchArguments = ["-scenario", "gym-e2e-roadmap-coach", "-server", server, "-telemetry", "-code-file", session, "-roadmap-coach", "on",
                           "-band-stands", "600"]
    app.launch()
    let menu = app.buttons["room-menu"]
    XCTAssertTrue(menu.waitForHittable(timeout: 30))
    menu.tap()
    let roadmap = app.roomItem("Roadmap")
    XCTAssertTrue(roadmap.waitForExistence(timeout: 5))
    roadmap.tap()
    XCTAssertTrue(app.roadmapStep("Read the wind").waitForExistence(timeout: 90), "the browser's roadmap arrives by sync")

    let field = app.descendants(matching: .any)["roadmap-coach-field"]
    XCTAssertTrue(field.waitForHittable(timeout: 10))
    field.tap()
    field.typeText("What’s next?\n")
    let answer = app.staticTexts.matching(identifier: "roadmap-coach-answer").firstMatch
    XCTAssertTrue(answer.waitForExistence(timeout: 90), "the turn's answer streams into the sheet")
    XCTAssertTrue(answer.label.contains("open now"))

    app.buttons["roadmap-coach-history"].tap()
    let browsers = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "roadmap-coach-history-row",
                                                                         "Which step is first?")).firstMatch
    XCTAssertTrue(browsers.waitForExistence(timeout: 30), "the conversation begun in a browser is in History")
    browsers.tap()
    XCTAssertTrue(app.staticTexts["Choose a sailing course comes first."].waitForExistence(timeout: 10))
    app.buttons["roadmap-coach-close"].tap()

    let row = app.roadmapStep("Read the wind")
    XCTAssertTrue(row.waitForHittable(timeout: 10))
    row.press(forDuration: 1)
    XCTAssertTrue(app.buttons["roadmap-ask-coach"].waitForHittable(timeout: 10))
    app.buttons["roadmap-ask-coach"].tap()
    field.tap()
    field.typeText("add a subtask: note the wind direction\n")
    XCTAssertTrue(app.staticTexts["Subtask added · Note the wind direction"].waitForExistence(timeout: 90), "the direct write's receipt")
    app.buttons["roadmap-undo"].tap()
    XCTAssertTrue(app.staticTexts["Undone"].waitForExistence(timeout: 30), "its Undo takes it back")
  }
}
