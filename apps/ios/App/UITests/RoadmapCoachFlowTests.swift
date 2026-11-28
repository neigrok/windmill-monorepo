import XCTest

// Roadmap Coach in the room (Roadmap · iOS section 11) on the simulator's boards, a turn played by the service a Debug launch
// plays (`-coach-play`), so no flow calls the AI service: asked from the Board, the Graph, a step's page and a Board row's
// Ask Coach; a direct write's receipt in the band and its Undo; the thread's History and What Coach Read; and the room as it
// is with Coach switched off (11.22a).
@MainActor final class RoadmapCoachFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func launch(_ board: String = "roadmap-learn-to-sail", coach: Bool = true, asking more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board, "-band-stands", "600"] + (coach ? ["-roadmap-coach", "on", "-coach-play"] : []) + more
    app.launch()
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    return app
  }

  func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement { app.descendants(matching: .any)[identifier] }

  // A question typed into the composer and sent from the keyboard.
  func ask(_ question: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    let field = element("roadmap-coach-field", in: app)
    XCTAssertTrue(field.waitForHittable(timeout: 10), file: file, line: line)
    field.tap()
    field.typeText(question + "\n")
  }

  func answer(in app: XCUIApplication) -> XCUIElement { app.staticTexts.matching(identifier: "roadmap-coach-answer").firstMatch }

  func testAQuestionFromTheBoardStreamsItsAnswerIntoTheSheet() {
    let app = launch()
    ask("What’s next?", in: app)
    XCTAssertTrue(answer(in: app).waitForExistence(timeout: 30))
    // The answer streams in word by word, so it is read once it has all come.
    XCTAssertTrue(answer(in: app).waitForLabel("Read the wind. It’s open now, and Tie a bowline can wait.", timeout: 30))
    XCTAssertTrue(element("roadmap-coach-read", in: app).waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["roadmap-coach-question"].exists)
    element("roadmap-coach-close", in: app).tap()
    XCTAssertTrue(element("roadmap-coach-field", in: app).waitForHittable(timeout: 10), "the composer is back at the room's foot")
  }

  func testAQuestionFromTheGraph() {
    let app = launch()
    app.buttons["Graph"].tap()
    ask("What’s next?", in: app)
    XCTAssertTrue(answer(in: app).waitForExistence(timeout: 30))
  }

  func testADirectWriteFromABoardRowIsItsReceiptAndItsUndoReadsUndone() {
    let app = launch()
    let row = app.roadmapStep("Read the wind")
    XCTAssertTrue(row.waitForHittable(timeout: 10))
    row.press(forDuration: 1)
    XCTAssertTrue(app.buttons["roadmap-ask-coach"].waitForHittable(timeout: 10))
    app.buttons["roadmap-ask-coach"].tap()
    ask("add a subtask: note the wind direction", in: app)
    let band = element("roadmap-band", in: app)
    XCTAssertTrue(band.waitForExistence(timeout: 30))
    XCTAssertTrue(app.staticTexts["Subtask added · Note the wind direction"].exists)
    XCTAssertFalse(element("roadmap-coach-close", in: app).exists, "a direct write raises no sheet")
    app.buttons["roadmap-undo"].tap()
    XCTAssertTrue(app.staticTexts["Undone"].waitForExistence(timeout: 30))
  }

  func testAStepsPageAsksAboutItsStepAndItsConversationKeepsTheReceipt() {
    let app = launch()
    app.roadmapStep("Read the wind").tap()
    XCTAssertTrue(app.roadmapStepPage("Read the wind"))
    XCTAssertTrue(app.buttons["roadmap-coach-circle"].waitForHittable(timeout: 10))
    app.buttons["roadmap-coach-circle"].tap()
    ask("add a subtask: note the wind direction", in: app)
    XCTAssertTrue(app.staticTexts["Subtask added · Note the wind direction"].waitForExistence(timeout: 30))
    // 11.3: the composer is back to its circle beside Complete.
    XCTAssertTrue(app.buttons["roadmap-coach-circle"].waitForHittable(timeout: 10))
    app.buttons["roadmap-coach-circle"].tap()
    ask("How do I start?", in: app)
    XCTAssertTrue(answer(in: app).waitForExistence(timeout: 30))
    XCTAssertTrue(app.staticTexts["About Read the wind"].exists || app.navigationBars.staticTexts["About Read the wind"].exists)
    XCTAssertTrue(element("roadmap-coach-receipt", in: app).waitForExistence(timeout: 10))
  }

  func testHistoryAndWhatCoachReadReadTheConversationFromThePhone() {
    let app = launch()
    ask("What’s next?", in: app)
    XCTAssertTrue(answer(in: app).waitForExistence(timeout: 30))
    XCTAssertTrue(element("roadmap-coach-read", in: app).waitForHittable(timeout: 30))
    element("roadmap-coach-read", in: app).tap()
    XCTAssertTrue(app.navigationBars["What Coach Read"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["8 steps · 3 done"].exists, "the context Coach was told, its steps and how many are done")
    app.navigationBars["What Coach Read"].buttons.firstMatch.tap()
    XCTAssertTrue(element("roadmap-coach-history", in: app).waitForHittable(timeout: 10))
    element("roadmap-coach-history", in: app).tap()
    XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 10))
    let row = element("roadmap-coach-history-row", in: app)
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()
    XCTAssertTrue(answer(in: app).waitForExistence(timeout: 10))
  }

  func testNewChatEmptiesTheThread() {
    let app = launch()
    ask("What’s next?", in: app)
    XCTAssertTrue(answer(in: app).waitForExistence(timeout: 30))
    element("roadmap-coach-new-chat", in: app).tap()
    XCTAssertTrue(answer(in: app).waitForNonExistence(timeout: 10))
    XCTAssertTrue(element("roadmap-coach-suggestion", in: app).waitForExistence(timeout: 10))
  }

  func testASpentAllowanceStandsAboveTheComposerAndKeepsTheQuestion() {
    let app = launch(asking: ["-coach-allowance", "spent"])
    ask("Should I add a night sail?", in: app)
    let notice = app.staticTexts.matching(identifier: "roadmap-coach-notice").firstMatch
    XCTAssertTrue(notice.waitForExistence(timeout: 30))
    XCTAssertTrue(notice.label.hasPrefix("You have used all of your AI allowance."))
    XCTAssertEqual(element("roadmap-coach-field", in: app).value as? String, "Should I add a night sail?")
  }

  // 11.22a: Coach switched off, the room is as it is without it: no composer, New step at the foot, no Ask Coach.
  func testWithCoachSwitchedOffTheRoomHasNoComposer() {
    let app = launch(coach: false)
    XCTAssertTrue(app.buttons["roadmap-new-step"].waitForHittable(timeout: 10))
    XCTAssertFalse(element("roadmap-coach-field", in: app).exists)
    app.roadmapStep("Read the wind").press(forDuration: 1)
    XCTAssertTrue(app.buttons["Edit"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["roadmap-ask-coach"].exists)
  }
}
