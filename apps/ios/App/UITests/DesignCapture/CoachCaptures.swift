import XCTest

final class CoachCaptures: DesignCapture {
  func ask(_ question: String, _ app: XCUIApplication) {
    let field = app.descendants(matching: .any)["coach-question"]
    field.tap(); field.typeText(question)
    app.buttons["coach-send"].tap()
  }

  func testSignedOut() {
    for look in Look.both {
      let app = launch("shell-last-room", look)
      openGymFromJournal(app, opensOn: .coach)
      XCTAssertTrue(app.staticTexts["coach-greeting"].waitForExistence(timeout: 15))
      capture("01.1-coach-greeting-signed-out", look, app)
      app.buttons["you"].tap()
      reach(app.buttons["settings-connected-log"], app).tap()
      XCTAssertTrue(app.buttons["coach-connect-tool"].waitForExistence(timeout: 5))
      capture("gym-coach-connected-log-signed-out", look, app)
    }
  }

  func testConversation() {
    for look in Look.both {
      let app = launchSignedInCoach(look)
      capture("08.1-coach-empty", look, app)
      app.buttons["you"].tap()
      reach(app.buttons["settings-connected-log"], app).tap()
      XCTAssertTrue(app.staticTexts["Claude Desktop"].waitForExistence(timeout: 5))
      capture("gym-coach-connected-log", look, app)
      app.buttons["coach-connected-how"].tap()
      XCTAssertTrue(app.navigationBars["How this works"].waitForExistence(timeout: 5))
      capture("gym-coach-connected-log-details", look, app)
      back(app); back(app); closeSheet(app)
      let question = app.descendants(matching: .any)["coach-question"]
      XCTAssertTrue(question.waitForExistence(timeout: 5)); question.tap(); question.typeText("Is Push A still doing anything?")
      capture("gym-coach-composing", look, app)
      app.buttons["coach-send"].tap()
      XCTAssertTrue(app.buttons["coach-review"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      capture("08.2-coach-proposal-pending", look, app)
      let photo = app.buttons["Enlarge photo"].firstMatch
      for _ in 0..<4 where !photo.isHittable { app.scrollViews.firstMatch.swipeDown() }
      capture("gym-coach-conversation-top", look, app)
      XCTAssertTrue(photo.waitForExistence(timeout: 5)); photo.tap()
      let cover = app.descendants(matching: .any)["coach-photo-cover"]
      XCTAssertTrue(cover.waitForExistence(timeout: 5))
      capture("gym-coach-photo", look, app)
      cover.swipeDown(velocity: .fast)
      XCTAssertTrue(cover.waitForNonExistence(timeout: 5))
      let sources = app.buttons["coach-read-receipt"]
      XCTAssertTrue(sources.wait(for: \.isHittable, toEqual: true, timeout: 5)); sources.tap()
      XCTAssertTrue(app.navigationBars["What Coach read"].waitForExistence(timeout: 5))
      capture("08.5-coach-what-coach-read", look, app)
      app.buttons["Close"].tap()
      XCTAssertTrue(app.navigationBars["What Coach read"].waitForNonExistence(timeout: 5))
      app.scrollViews.firstMatch.swipeUp()
      app.buttons["coach-review"].tap()
      XCTAssertTrue(app.buttons["coach-apply-proposal"].waitForExistence(timeout: 5))
      capture("gym-coach-review-sheet", look, app)
      app.swipeUp()
      capture("gym-coach-review-actions", look, app)
      app.buttons["Turn this down"].tap()
      let turnDown = app.alerts["Turn this down?"]
      XCTAssertTrue(turnDown.waitForExistence(timeout: 5))
      capture("gym-coach-turn-down-confirmation", look, app)
      turnDown.buttons["Keep it"].tap()
      XCTAssertTrue(turnDown.waitForNonExistence(timeout: 5))
      let apply = app.buttons["coach-apply-proposal"]
      XCTAssertTrue(apply.wait(for: \.isEnabled, toEqual: true, timeout: 5)); apply.tap()
      XCTAssertTrue(app.descendants(matching: .any)["coach-review-receipt"].waitForExistence(timeout: 10))
      capture("gym-coach-review-applied", look, app)
      app.buttons["Close"].tap()
      XCTAssertTrue(app.buttons["coach-review"].waitForValue("Applied", timeout: 5))
      capture("08.12-coach-proposal-applied", look, app)
      let history = app.buttons["coach-history"]
      XCTAssertTrue(history.wait(for: \.isHittable, toEqual: true, timeout: 5)); history.tap()
      XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
      capture("08.4-coach-history", look, app)
      let conversation = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Push A · 3 changes")).firstMatch
      XCTAssertTrue(conversation.waitForExistence(timeout: 5)); conversation.swipeLeft()
      XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5)); app.buttons["Delete"].tap()
      XCTAssertTrue(app.buttons["Delete conversation"].waitForExistence(timeout: 5))
      capture("gym-coach-history-delete-confirmation", look, app)
      app.buttons["Delete conversation"].tap()
      XCTAssertTrue(conversation.waitForNonExistence(timeout: 5))
      XCTAssertFalse(app.buttons["coach-engine-undo"].exists)
      capture("gym-coach-history-deleted", look, app)
    }
  }

  func testRoutineSaved() {
    for look in Look.both {
      let app = launchSignedInCoach(look, arguments: ["-coach-created"])
      ask("Build me a routine.", app)
      XCTAssertTrue(app.buttons["Open routine · Push A"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      capture("01.8-coach-routine-saved", look, app)
    }
  }

  func testOutOfDate() {
    for look in Look.both {
      let app = launchSignedInCoach(look, arguments: ["-coach-out-of-date"])
      ask("Is Push A still doing anything?", app)
      let review = app.buttons["coach-review"]
      XCTAssertTrue(review.waitForValue("Out of date", timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      capture("08.14-coach-proposal-out-of-date", look, app)
      for _ in 0..<4 where !review.isHittable { app.scrollViews.firstMatch.swipeUp() }
      review.tap()
      XCTAssertTrue(app.staticTexts["coach-review-out-of-date"].waitForExistence(timeout: 5))
      capture("gym-coach-review-out-of-date", look, app)
    }
  }

  // Review at AX3 scrolled to its middle: the caption and *Turn this down* stand on the hard scroll edge, no row through them.
  func testReviewLargestText() {
    for look in Look.bothAtLargestText {
      let app = launchSignedInCoach(look)
      ask("Is Push A still doing anything?", app)
      let review = app.buttons["coach-review"]
      XCTAssertTrue(review.waitForExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      for _ in 0..<4 where !review.isHittable { app.scrollViews.firstMatch.swipeUp() }
      review.tap()
      XCTAssertTrue(app.buttons["coach-apply-proposal"].waitForExistence(timeout: 5))
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)))
      capture("gym-coach-review-mid", look, app)
    }
  }

  func testOffline() {
    for look in Look.both {
      let app = launch("shell-last-room", look, arguments: ["-coach-fixture", "-coach-offline"])
      openGymFromJournal(app, opensOn: .routines)
      open(.coach, app)
      XCTAssertTrue(app.staticTexts["Coach needs a connection."].waitForExistence(timeout: 15))
      capture("gym-coach-offline", look, app)
    }
  }

  func testRemovalWait() {
    for look in Look.both {
      let app = launchSignedInCoach(look, arguments: ["-coach-removal", "-coach-removal-stall"])
      ask("Remove Push A.", app)
      XCTAssertTrue(app.buttons["coach-review"].waitForExistence(timeout: 10))
      capture("08.16-coach-proposal-remove", look, app)
      app.scrollViews.firstMatch.swipeUp(); app.buttons["coach-review"].tap()
      let apply = app.buttons["coach-apply-proposal"]
      XCTAssertTrue(apply.waitForExistence(timeout: 5))
      capture("gym-coach-removal-review", look, app)
      // The conversation behind the sheet is the first scroll view, so the drag starts in the sheet itself.
      for _ in 0..<6 where !apply.isEnabled {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)))
      }
      XCTAssertTrue(apply.wait(for: \.isEnabled, toEqual: true, timeout: 5))
      capture("gym-coach-removal-review-promise", look, app)
      apply.tap()
      XCTAssertTrue(apply.waitForLabel("Removing…", timeout: 5))
      capture("gym-coach-removal-waiting", look, app)
      XCTAssertTrue(apply.waitForLabel("Retry", timeout: 25))
      capture("gym-coach-removal-still-waiting", look, app)
    }
  }
}
