import XCTest

// Roadmap Coach in the room (Roadmap · iOS section 11, the boards of part 1), on *Learn to sail* with Coach switched on and a
// turn played by the service a Debug launch plays.
final class RoadmapCoachCaptures: DesignCapture {
  func coach(_ look: Look, board: String = "roadmap-learn-to-sail", arguments: [String] = []) -> XCUIApplication {
    let app = launch(board, look, arguments: ["-roadmap-coach", "on", "-coach-play", "-band-stands", "600"] + arguments)
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 60))
    return app
  }

  func field(_ app: XCUIApplication) -> XCUIElement { app.descendants(matching: .any)["roadmap-coach-field"] }

  func ask(_ question: String, _ app: XCUIApplication) {
    XCTAssertTrue(field(app).waitForHittable(timeout: 10))
    field(app).tap()
    field(app).typeText(question + "\n")
  }

  func answered(_ app: XCUIApplication) {
    XCTAssertTrue(app.staticTexts.matching(identifier: "roadmap-coach-answer").firstMatch.waitForExistence(timeout: 30))
  }

  // 11.1: the composer focused, its suggestions above it and New step gone.
  func testComposerFocused() {
    captureBoard("11.1-roadmap-coach-composer-focused") { look in
      let app = coach(look)
      XCTAssertTrue(field(app).waitForHittable(timeout: 10))
      field(app).tap()
      XCTAssertTrue(app.descendants(matching: .any)["roadmap-coach-suggestion"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 11.2: a turn running: the step line in the field's place and Stop.
  func testTurnRunning() {
    captureBoard("11.2-roadmap-coach-turn-running") { look in
      let app = coach(look)
      ask("Take your time", app)
      XCTAssertTrue(app.buttons["roadmap-coach-stop"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 11.3: a subtask added from Read the wind's page, the band its receipt; 11.4: its Undo.
  func testDirectWrite() {
    captureBoard("11.3-roadmap-coach-direct-write") { look in
      let app = stepPage(look)
      ask("add a subtask: note the wind direction", app)
      XCTAssertTrue(app.staticTexts["Subtask added · Note the wind direction"].waitForExistence(timeout: 30))
      return app
    }
    captureBoard("11.4-roadmap-coach-undone") { look in
      let app = stepPage(look)
      ask("add a subtask: note the wind direction", app)
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForHittable(timeout: 30))
      app.buttons["roadmap-undo"].tap()
      XCTAssertTrue(app.staticTexts["Undone"].waitForExistence(timeout: 30))
      return app
    }
  }

  func stepPage(_ look: Look) -> XCUIApplication {
    let app = coach(look)
    app.roadmapStep("Read the wind").tap()
    XCTAssertTrue(app.roadmapStepPage("Read the wind"))
    circle(app)
    return app
  }

  // The sheet's grabber, above the middle of its title bar, dragged to the top: the sheet at large.
  func large(_ app: XCUIApplication) {
    let close = app.buttons["roadmap-coach-close"].firstMatch
    let grabber = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: close.frame.minY - 20))
    grabber.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)))
    let large = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in close.frame.minY < app.frame.height / 4 }, object: nil)
    XCTAssertEqual(XCTWaiter().wait(for: [large], timeout: 10), .completed)
  }

  // 11.3: on an Up next page the composer is a circle beside Complete until it is tapped.
  func circle(_ app: XCUIApplication) {
    XCTAssertTrue(app.buttons["roadmap-coach-circle"].waitForHittable(timeout: 10))
    app.buttons["roadmap-coach-circle"].tap()
  }

  // 11.5: an answer in the sheet at medium over the live Board; 11.6: the thread at large with a second question; 11.6b: New
  // Chat; 11.8: What Coach Read; 11.7: History.
  func testConversation() {
    captureBoard("11.5-roadmap-coach-answer") { look in
      let app = coach(look)
      ask("What’s next?", app)
      answered(app)
      return app
    }
    captureBoard("11.6-roadmap-coach-thread-at-large") { look in
      let app = coach(look)
      ask("What’s next?", app)
      answered(app)
      ask("Is this realistic?", app)
      XCTAssertTrue(app.staticTexts.matching(identifier: "roadmap-coach-answer").element(boundBy: 1).waitForExistence(timeout: 30))
      large(app)
      return app
    }
    captureBoard("11.6b-roadmap-coach-new-chat") { look in
      let app = coach(look)
      ask("What’s next?", app)
      answered(app)
      app.buttons["roadmap-coach-new-chat"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["roadmap-coach-suggestion"].waitForExistence(timeout: 10))
      return app
    }
    captureBoard("11.8-roadmap-coach-what-coach-read") { look in
      let app = coach(look)
      ask("What’s next?", app)
      answered(app)
      app.descendants(matching: .any)["roadmap-coach-read"].tap()
      XCTAssertTrue(app.navigationBars["What Coach Read"].waitForExistence(timeout: 10))
      return app
    }
    // 11.7: the board's account has had five conversations, two about Read the wind, today and yesterday, one about every
    // roadmap and two about other roadmaps days before; What's next? is asked now.
    captureBoard("11.7-roadmap-coach-history") { look in
      let app = coach(look, board: "roadmap-coach-history")
      ask("What’s next?", app)
      answered(app)
      large(app)
      app.buttons["roadmap-coach-history"].tap()
      XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["Yesterday"].waitForExistence(timeout: 10) && app.staticTexts["Other conversations"].exists)
      return app
    }
  }

  // 11.6c: the thread keeps the direct writes, one of them undone, asked on Read the wind's page.
  func testThreadKeepsDirectWrites() {
    captureBoard("11.6c-roadmap-coach-thread-keeps-direct-writes") { look in
      let app = stepPage(look)
      ask("add a subtask: check the tide", app)
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForHittable(timeout: 30))
      app.buttons["roadmap-undo"].tap()
      XCTAssertTrue(app.staticTexts["Undone"].waitForExistence(timeout: 30))
      circle(app)
      ask("add a subtask: note the wind direction", app)
      XCTAssertTrue(app.staticTexts["Subtask added · Note the wind direction"].waitForExistence(timeout: 30))
      circle(app)
      ask("How do I start?", app)
      answered(app)
      return app
    }
  }

  // 11.17: Ask Coach on a Board row opens the composer about the step.
  func testAskFromARow() {
    captureBoard("11.17-roadmap-coach-from-a-step") { look in
      let app = coach(look)
      app.roadmapStep("Read the wind").press(forDuration: 1)
      XCTAssertTrue(app.buttons["roadmap-ask-coach"].waitForHittable(timeout: 10))
      app.buttons["roadmap-ask-coach"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["roadmap-coach-suggestion"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 11.18: signed out, Coach completes a step and the Board's own sentence is the receipt.
  func testSignedOut() {
    captureBoard("11.18-roadmap-coach-signed-out") { look in
      let app = coach(look, board: "roadmap-signed-out")
      ask("I finished Read the wind", app)
      XCTAssertTrue(app.descendants(matching: .any)["roadmap-band"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 11.19a, 11.19b, 11.20: the allowance spent signed out and signed in, and the shared capacity used, each above the
  // composer with the question kept; 11.21: offline.
  func testAccessStates() {
    let states: [(String, String, [String])] = [
      ("11.19a-roadmap-coach-allowance-signed-out", "roadmap-signed-out", ["-coach-allowance", "spent"]),
      ("11.19b-roadmap-coach-allowance-signed-in", "roadmap-learn-to-sail", ["-coach-allowance", "spent"]),
      ("11.20-roadmap-coach-shared-capacity", "roadmap-learn-to-sail", ["-coach-allowance", "capacity"]),
    ]
    for (screen, board, arguments) in states {
      captureBoard(screen) { look in
        let app = coach(look, board: board, arguments: arguments)
        ask("Should I add a night sail?", app)
        XCTAssertTrue(app.staticTexts.matching(identifier: "roadmap-coach-notice").firstMatch.waitForExistence(timeout: 30))
        return app
      }
    }
    captureBoard("11.21-roadmap-coach-offline") { look in
      let app = launch("roadmap-sync-offline", look, arguments: ["-roadmap-coach", "on", "-coach-play"])
      XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "· Offline")).firstMatch.waitForExistence(timeout: 60))
      ask("Should I add a night sail?", app)
      XCTAssertTrue(app.staticTexts["Asking needs a connection."].waitForExistence(timeout: 30))
      return app
    }
  }
}
