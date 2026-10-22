import XCTest

final class RoutinesCaptures: DesignCapture {
  func testRoutines() {
    captureBoard("02.1-routines", settle: 1.5) { look in
      let app = launchSignedInCoach(look)
      open(.routines, app)
      XCTAssertTrue(app.buttons["routine-proposal"].waitForExistence(timeout: 10))
      return app
    }
  }

  func testRoutineSummary() {
    captureBoard("02.2-routine-summary") { look in
      let app = launchSignedInCoach(look, arguments: ["-coach-board", "summary"])
      open(.routines, app)
      app.buttons["routine-board-lower"].tap()
      XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 10))
      return app
    }
  }

  // The editor of a routine that has been trained lists its workouts under History.
  func testEditorHistory() {
    captureBoard("02.13-editor-history") { look in
      let app = launchSignedInCoach(look, arguments: ["-coach-board", "change"])
      open(.routines, app)
      app.buttons["routine-board-routine"].tap()
      XCTAssertTrue(app.buttons["edit-routine"].waitForExistence(timeout: 10)); app.buttons["edit-routine"].tap()
      XCTAssertTrue(app.staticTexts["History"].waitForExistence(timeout: 10))
      return app
    }
  }

  func testRoutineEditorSwipe() {
    captureBoard("02.8-routine-editor-swipe") { look in
      let app = launch("shell-last-room", look)
      openGymFromJournal(app, opensOn: .coach)
      open(.routines, app)
      app.buttons["new-routine"].tap()
      let name = app.textFields["routine-name"]
      XCTAssertTrue(name.waitForExistence(timeout: 5)); name.typeText("Push A\n")
      for id in ["bench-press", "overhead-press"] {
        app.buttons["add-movement"].tap()
        XCTAssertTrue(app.buttons["gym-movement-" + id].waitForExistence(timeout: 5)); app.buttons["gym-movement-" + id].tap()
      }
      let row = app.buttons["builder-movement-overhead-press"]
      XCTAssertTrue(row.waitForExistence(timeout: 5)); row.swipeLeft()
      XCTAssertTrue(app.buttons["trash-swipe"].wait(for: \.isHittable, toEqual: true, timeout: 5))
      return app
    }
  }

  func testPopulatedSignedOut() {
    for look in Look.both {
      let app = launch("shell-anonymous", look, arguments: ["-gym-log-fixture"])
      openGymFromWelcome(app, opensOn: .coach)
      open(.log, app)
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch.waitForExistence(timeout: 20))
      open(.routines, app)
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "routine-")).firstMatch.waitForExistence(timeout: 10))
      capture("gym-routines-populated-signed-out", look, app, settle: 1.5)
    }
  }

  // Empty Routines with a hidden workout exposes one bottom-trailing New routine control.
  func testEmptySignedIn() {
    for look in Look.both {
      let app = launch("workout-notice", look)
      XCTAssertTrue(app.buttons["workout-assembly"].waitForExistence(timeout: 10)); app.buttons["workout-assembly"].tap()
      XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
      XCTAssertTrue(app.buttons["new-routine"].waitForExistence(timeout: 10))
      for _ in 0..<3 where app.buttons["Dismiss message"].exists { app.buttons["Dismiss message"].firstMatch.tap() }
      capture("gym-routines-empty-signed-in", look, app)
    }
  }

  func testBuildAndTrain() {
    for look in Look.both {
      let app = launch("shell-last-room", look)
      openGymFromJournal(app, opensOn: .coach)
      open(.routines, app)
      XCTAssertTrue(app.staticTexts["No routines yet"].waitForExistence(timeout: 5))
      capture("02.7-routines-empty", look, app)
      app.buttons["new-routine"].tap()
      let name = app.textFields["routine-name"]
      XCTAssertTrue(name.waitForExistence(timeout: 5))
      capture("02.3-routine-editor-new", look, app)
      name.tap(); name.typeText("Push A\n")
      app.buttons["add-movement"].tap()
      XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
      capture("02.4-movement-picker", look, app)
      app.buttons["gym-new-movement"].tap()
      XCTAssertTrue(app.textFields["gym-movement-name"].waitForExistence(timeout: 5))
      capture("gym-create-movement", look, app)
      app.navigationBars["Create movement"].buttons["Cancel"].tap()
      XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
      app.buttons["gym-movement-bench-press"].tap()
      let movement = app.buttons["builder-movement-bench-press"]
      XCTAssertTrue(movement.waitForExistence(timeout: 5)); movement.tap()
      XCTAssertTrue(app.buttons["gym-target-set"].waitForExistence(timeout: 5))
      let more = app.buttons["gym-target-sets-stepper-Increment"]
      for _ in 0..<4 { more.tap() }
      XCTAssertEqual(app.textFields["gym-target-sets"].value as? String, "4")
      capture("02.6-targets", look, app)
      app.navigationBars["Targets"].buttons["Cancel"].tap()
      XCTAssertTrue(app.buttons["save-routine"].waitForExistence(timeout: 5))
      capture("gym-routine-editor-planned", look, app)
      app.buttons["save-routine"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["routine-detail"].waitForExistence(timeout: 5))
      capture("gym-routine-detail", look, app)
      app.buttons["edit-routine"].tap()
      XCTAssertTrue(app.navigationBars["Edit routine"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["delete-routine"].waitForExistence(timeout: 5))
      capture("02.5-routine-editor-sortable", look, app)
      app.navigationBars["Edit routine"].buttons["Cancel"].tap()
      app.buttons["routine-close"].tap()
      let routine = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "routine-", "Push A,")).firstMatch
      XCTAssertTrue(routine.waitForExistence(timeout: 5))
      capture("gym-routines-one-routine", look, app)
      routine.tap()
      XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 5)); app.buttons["routine-start"].tap()
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10)); app.buttons["workout-log"].tap()
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.buttons["workout-done"].waitForExistence(timeout: 10)); app.buttons["workout-done"].tap()
      let record = app.buttons["gym-session-movement"].firstMatch
      XCTAssertTrue(record.waitForExistence(timeout: 5)); record.tap()
      XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
      app.navigationBars.buttons["More"].tap()
      app.buttons["Edit movement"].tap()
      XCTAssertTrue(app.textFields["gym-rename-movement-name"].waitForExistence(timeout: 5))
      capture("gym-routine-rename-movement-sheet", look, app)
    }
  }
}
