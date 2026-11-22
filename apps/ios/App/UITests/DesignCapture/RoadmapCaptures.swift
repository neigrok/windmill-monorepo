import XCTest

// The Roadmap room's boards (Roadmap · iOS): its Board, a step's page, and its door on Where to start? (Shell 02a).
final class RoadmapCaptures: DesignCapture {
  // 01.1: *Learn to sail* on its Board, as it arrives from its account.
  func testBoardAtRest() {
    captureBoard("01.1-roadmap-board-at-rest", settle: 1.5) { look in
      let app = launch("roadmap-learn-to-sail", look)
      XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 01.12: every step done, Done open by itself under what the Board says of it.
  func testEveryStepDone() {
    captureBoard("01.12-roadmap-every-step-done", settle: 1.5) { look in
      let app = launch("roadmap-all-done", look)
      XCTAssertTrue(app.staticTexts["All 8 steps done"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 02.1: an Up next row slid right shows Complete.
  func testSwipeRightRevealsComplete() {
    captureBoard("02.1-roadmap-swipe-right-complete") { look in
      let app = learnToSail(look)
      app.roadmapStep("Read the wind").swipeRight()
      XCTAssertTrue(app.buttons["Complete"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.2: the step completed, what it unlocked arrived first in Up next, and the band with Undo.
  func testCompleted() {
    captureBoard("02.2-roadmap-completed") { look in
      let app = learnToSail(look)
      app.roadmapStep("Read the wind").swipeRight()
      XCTAssertTrue(app.buttons["Complete"].waitForExistence(timeout: 5))
      app.buttons["Complete"].tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["4 of 8 done"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.3: a row slid left shows Delete.
  func testSwipeLeftRevealsDelete() {
    captureBoard("02.3-roadmap-swipe-left-delete") { look in
      let app = learnToSail(look)
      app.roadmapStep("Tie a bowline").swipeLeft()
      XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.4: the long-press menu of an Up next step.
  func testLongPressMenu() {
    captureBoard("02.4-roadmap-long-press-menu") { look in
      let app = learnToSail(look)
      app.roadmapStep("Read the wind").press(forDuration: 1)
      XCTAssertTrue(app.buttons["Delete Step"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.13: the list at its end with Done opened from its header.
  func testDoneExpanded() {
    captureBoard("02.13-roadmap-done-expanded") { look in
      let app = learnToSail(look)
      let done = app.buttons["roadmap-group-done"]
      app.swipeUp(velocity: .slow)
      XCTAssertTrue(done.waitForHittable(timeout: 5))
      done.tap()
      XCTAssertTrue(done.waitForValue("Expanded", timeout: 5))
      app.swipeUp(velocity: .slow)
      XCTAssertTrue(app.roadmapStep("Choose a sailing course").waitForExistence(timeout: 5))
      return app
    }
  }

  // 02.15: a roadmap with no step yet.
  func testEmptyRoadmap() {
    captureBoard("02.15-roadmap-empty-roadmap") { look in
      let app = launch("roadmap-no-steps", look)
      XCTAssertTrue(app.staticTexts["Your first step"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 03.8, on the Board: the delete question on the row, with what the delete costs.
  func testDeleteQuestion() {
    captureBoard("03.8-roadmap-delete-question") { look in
      let app = learnToSail(look)
      app.roadmapStep("Read the wind").swipeLeft()
      XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
      app.buttons["Delete"].tap()
      XCTAssertTrue(app.staticTexts["Delete Read the wind?"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 03.1: an Up next step's page, with Complete at its foot.
  func testStepUpNext() {
    captureBoard("03.1-roadmap-step-up-next") { look in stepPage(["Read the wind"], look) }
  }

  // 03.4: the step completed in place, the page turned Done with Reset and the band saying what opened.
  func testStepCompletedInPlace() {
    captureBoard("03.4-roadmap-step-completed-in-place") { look in
      let app = stepPage(["Read the wind"], look)
      app.buttons["roadmap-complete"].tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["roadmap-reset"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 03.5: a Locked step's page, whose way through is its Requires rows.
  func testStepLocked() {
    captureBoard("03.5-roadmap-step-locked") { look in stepPage(["Sail solo"], look) }
  }

  // 03.6: a Done step's page, saying what Reset would lock.
  func testStepDone() {
    captureBoard("03.6-roadmap-step-done") { look in stepPage(["Read the wind", "Name the boat parts"], look) }
  }

  // 03.6b: the step reset, Up next again with Complete, what it had opened Locked and the band saying so.
  func testStepReset() {
    captureBoard("03.6b-roadmap-step-reset") { look in
      let app = stepPage(["Read the wind", "Name the boat parts"], look)
      app.buttons["roadmap-reset"].tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["roadmap-complete"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 03.7: a step page's … menu.
  func testStepMenu() {
    captureBoard("03.7-roadmap-step-menu") { look in
      let app = stepPage(["Read the wind"], look)
      app.buttons["roadmap-step-more"].tap()
      XCTAssertTrue(app.buttons["Delete Step"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 03.8: the delete question on the page's … button, with what the delete costs.
  func testStepDeleteQuestion() {
    captureBoard("03.8-roadmap-step-delete-question") { look in
      let app = stepPage(["Read the wind"], look)
      askDelete(app)
      return app
    }
  }

  // 03.9: the step deleted from its page and held, back on the Board with Undo in the band.
  func testDeletedHeld() {
    captureBoard("03.9-roadmap-deleted-held") { look in
      let app = stepPage(["Read the wind"], look)
      askDelete(app)
      app.buttons["Delete Step"].tap()
      XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["3 of 7 done"].waitForExistence(timeout: 5))
      return app
    }
  }

  func learnToSail(_ look: Look) -> XCUIApplication {
    let app = launch("roadmap-learn-to-sail", look)
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    return app
  }

  // The page of the last step named, reached from the Board through a row of each page before it.
  func stepPage(_ steps: [String], _ look: Look) -> XCUIApplication {
    let app = learnToSail(look)
    for step in steps {
      reach(app.roadmapStep(step), app).tap()
      XCTAssertTrue(app.roadmapStepPage(step))
    }
    return app
  }

  // Delete Step from the page's … menu, up to its question.
  func askDelete(_ app: XCUIApplication) {
    app.buttons["roadmap-step-more"].tap()
    XCTAssertTrue(app.buttons["Delete Step"].waitForExistence(timeout: 5))
    app.buttons["Delete Step"].tap()
    XCTAssertTrue(app.staticTexts["Delete Read the wind?"].waitForExistence(timeout: 5))
  }

  // 01.2: the room capsule's menu, with Roadmap checked.
  func testRoomMenu() {
    for look in Look.both {
      let app = launch("roadmap-learn-to-sail", look)
      XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
      roomMenuOpen("01.2-roadmap-room-menu", look, app, current: "Roadmap")
      app.terminate()
    }
  }

  // 01.5: a phone that holds no roadmap.
  func testNoRoadmapYet() {
    captureBoard("01.5-roadmap-no-roadmap-yet") { look in
      let app = launch("roadmap-empty", look)
      XCTAssertTrue(app.staticTexts["No roadmaps yet"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 10.9, in the room: a read of the phone's copy that failed.
  func testCouldNotLoad() {
    captureBoard("10.9-roadmap-could-not-load") { look in
      let app = launch("roadmap-unreadable", look)
      XCTAssertTrue(app.staticTexts["Couldn’t load this roadmap"].waitForExistence(timeout: 30))
      return app
    }
  }

  // Shell 02a: Where to start? with its third door.
  func testRoadmapDoor() {
    captureBoard("02a-where-to-start-roadmap-door", settle: 1.5) { look in
      let app = launch("shell-anonymous", look)
      XCTAssertTrue(app.buttons["open-roadmap"].waitForExistence(timeout: 30))
      return app
    }
  }
}
