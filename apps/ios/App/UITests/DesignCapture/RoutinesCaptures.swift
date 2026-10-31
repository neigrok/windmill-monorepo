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

  // 02.19: Start on the sheet's bottom bar, then the last movement scrolled clear of it.
  func testRoutineSummary() {
    for look in Look.both + Look.bothAtLargestText {
      let app = launchSignedInCoach(look, arguments: ["-coach-board", "summary"])
      open(.routines, app)
      app.buttons["routine-board-lower"].tap()
      let start = app.buttons["routine-start"]
      XCTAssertTrue(start.waitForExistence(timeout: 10))
      capture("02.19-routine-summary", look, app)
      let list = app.collectionViews["routine-detail"]
      let last = list.cells.containing(.any, identifier: "routine-detail-movement-hip-thrust").firstMatch
      for _ in 0..<6 where !(onScreen(last, app) && last.frame.maxY <= start.frame.minY) { list.swipeUp(velocity: .slow) }
      XCTAssertLessThanOrEqual(last.frame.maxY, start.frame.minY)
      capture("02.19-routine-summary-end", look, app)
      app.terminate()
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
        XCTAssertTrue(app.buttons["gym-movement-editor-commit"].waitForExistence(timeout: 5)); app.buttons["gym-movement-editor-commit"].tap()
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
      app.buttons["gym-movement-editor-cancel"].tap()
      XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
      app.buttons["gym-movement-bench-press"].tap()
      XCTAssertTrue(app.buttons["gym-movement-editor-commit"].waitForExistence(timeout: 5))
      let more = app.buttons["gym-target-sets-stepper-Increment"]
      for _ in 0..<4 { more.tap() }
      XCTAssertEqual(app.textFields["gym-target-sets"].value as? String, "4")
      capture("02.6-movement-editor", look, app)
      app.buttons["gym-movement-editor-commit"].tap()
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
  func testCombinedEditorCancelRestoresTheStagedIdentityAndTargets() {
    for look in Look.both {
      let app = launch("shell-last-room", look)
      openGymFromJournal(app, opensOn: .coach); open(.routines, app)
      app.buttons["new-routine"].tap()
      let name = app.textFields["routine-name"]
      XCTAssertTrue(name.waitForExistence(timeout: 5)); name.typeText("Push A\n")
      app.buttons["add-movement"].tap(); app.buttons["gym-movement-bench-press"].tap()
      let commit = app.buttons["gym-movement-editor-commit"]
      XCTAssertTrue(commit.waitForExistence(timeout: 5))
      let sets = app.textFields["gym-target-sets"]
      sets.tap(); sets.typeText("4")
      app.buttons["gym-target-keyboard-done"].tap()
      let movementName = app.textFields["gym-movement-name"]
      let editor = app.collectionViews["gym-routine-movement-editor"]
      let navigation = app.navigationBars["Add movement"]
      for _ in 0..<5 where movementName.frame.minY < navigation.frame.maxY + 8 { editor.swipeDown(velocity: .slow) }
      XCTAssertGreaterThanOrEqual(movementName.frame.minY, navigation.frame.maxY)
      XCTAssertEqual(movementName.value as? String, "Bench Press")
      XCTAssertEqual(sets.value as? String, "4")
      capture("02.6-combined-movement-editor", look, app)
      commit.tap()
      app.buttons["builder-movement-bench-press"].tap()
      XCTAssertTrue(movementName.waitForExistence(timeout: 5))
      movementName.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap()
      movementName.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Bench Press".count) + "Discarded press")
      XCTAssertTrue(movementName.waitForValue("Discarded press"))
      app.buttons["gym-movement-editor-cancel"].tap()
      let confirmation = app.sheets["Discard movement changes?"]
      XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
      capture("02.17-movement-unsaved", look, app)
      if confirmation.buttons["Keep editing"].exists { confirmation.buttons["Keep editing"].tap() }
      else {
        app.otherElements["PopoverDismissRegion"].coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap()
      }
      XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
      XCTAssertEqual(movementName.value as? String, "Discarded press")
      app.buttons["gym-movement-editor-cancel"].tap(); app.buttons["Discard"].tap()
      app.buttons["builder-movement-bench-press"].tap()
      XCTAssertEqual(movementName.value as? String, "Bench Press")
      XCTAssertEqual(sets.value as? String, "4")
      app.buttons["gym-movement-editor-cancel"].tap()
      app.navigationBars["New routine"].buttons["Cancel"].tap()
      XCTAssertTrue(app.buttons["Discard"].waitForExistence(timeout: 5)); app.buttons["Discard"].tap()
      XCTAssertTrue(app.staticTexts["No routines yet"].waitForExistence(timeout: 5))
    }
  }

  func testCombinedEditorKeyboardValidationAndLargeText() {
    for look in Look.both + Look.bothAtLargestText {
      let app = launch("shell-last-room", look)
      openGymFromJournal(app, opensOn: .coach); open(.routines, app)
      app.buttons["new-routine"].tap()
      let name = app.textFields["routine-name"]
      XCTAssertTrue(name.waitForExistence(timeout: 5)); name.typeText("Push A\n")
      app.buttons["add-movement"].tap(); app.buttons["gym-new-movement"].tap()
      let movementName = app.textFields["gym-movement-name"]
      XCTAssertTrue(movementName.waitForExistence(timeout: 5)); movementName.tap(); movementName.typeText("Custom press")
      let commit = app.buttons["gym-movement-editor-commit"]
      XCTAssertTrue(commit.isHittable)
      if !look.largestText { XCTAssertEqual(commit.frame.height, 52, accuracy: 1) }
      XCTAssertLessThanOrEqual(commit.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
      capture("02.14-create-movement-keyboard", look, app)
      app.buttons["gym-target-keyboard-done"].tap()
      let sets = reach(app.textFields["gym-target-sets"], app)
      sets.tap(); sets.typeText("21")
      XCTAssertFalse(commit.isEnabled)
      XCTAssertEqual(sets.value as? String, "21")
      let refusal = app.staticTexts["gym-target-refusal"]
      XCTAssertTrue(refusal.waitForExistence(timeout: 5))
      let navigation = app.navigationBars["Add movement"], keyboardDone = app.buttons["gym-target-keyboard-done"]
      for _ in 0..<8 {
        let top = navigation.frame.maxY + 8, bottom = keyboardDone.frame.minY - 8
        if refusal.frame.minY >= top && refusal.frame.maxY <= bottom { break }
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0))
          .withOffset(CGVector(dx: 0, dy: (top + bottom) / 2))
        let distance: CGFloat = refusal.frame.maxY > bottom ? -80 : 80
        start.press(forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 0, dy: distance)), withVelocity: .slow, thenHoldForDuration: 0.1)
      }
      XCTAssertEqual(refusal.label, "Sets, 1 to 20.")
      XCTAssertGreaterThanOrEqual(refusal.frame.minY, navigation.frame.maxY)
      XCTAssertLessThanOrEqual(refusal.frame.maxY, keyboardDone.frame.minY)
      XCTAssertTrue(commit.isHittable)
      capture("02.16-movement-target-refusal", look, app)
      sets.typeText(XCUIKeyboardKey.delete.rawValue + XCUIKeyboardKey.delete.rawValue + "2")
      app.buttons["gym-target-keyboard-done"].tap()
      XCTAssertTrue(commit.isEnabled && commit.isHittable)
      let variation = reach(app.switches["Vary by set"], app)
      let control = variation.switches.firstMatch
      XCTAssertTrue(control.isHittable); control.tap()
      XCTAssertTrue(variation.waitForValue("1"))
      XCTAssertTrue(reach(app.buttons["gym-target-fill"], app).isHittable)
      XCTAssertTrue(reach(app.buttons["gym-target-add-set"], app).isHittable)
      capture("02.15-movement-per-set", look, app)
      commit.tap()
      XCTAssertTrue(app.buttons["save-routine"].waitForExistence(timeout: 5))
    }
  }

}
