import XCTest

// The Routines boards (02L.1–02L.8) draw one fixture, `-coach-board routines`: Push A as 02L.7 lists it, Pull A, Legs and
// Upper B, with Coach's three changes to Push A waiting at the head of the list.
final class RoutinesCaptures: DesignCapture {
  func testRoutines() {
    captureBoard("02L.1-routines", settle: 1.5) { look in
      let app = launchSignedInCoach(look, arguments: ["-coach-board", "routines", "-routines-proposal-fixture"])
      open(.routines, app)
      XCTAssertTrue(app.buttons["routine-proposal"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 02L.7: Start across the summary's foot, then the last movement scrolled clear of it.
  func testRoutineSummary() {
    for look in Look.both + Look.bothAtLargestText {
      let app = launchSignedInCoach(look, arguments: ["-coach-board", "routines"])
      open(.routines, app)
      app.buttons["routine-board-routine"].tap()
      let start = app.buttons["routine-start"]
      XCTAssertTrue(start.waitForExistence(timeout: 10))
      capture("02L.7-routine-summary", look, app)
      let list = app.collectionViews["routine-detail"]
      let last = list.cells.containing(.any, identifier: "routine-detail-movement-triceps-pushdown").firstMatch
      for _ in 0..<6 where !(onScreen(last, app) && last.frame.maxY <= start.frame.minY) { list.swipeUp(velocity: .slow) }
      XCTAssertLessThanOrEqual(last.frame.maxY, start.frame.minY)
      capture("02L.7-routine-summary-end", look, app)
      app.terminate()
    }
  }

  // 02L.3: Push A's editor in edit mode, the first row swiped to its trash circle; the editor of a routine that has been
  // trained lists its workouts under History (02.13).
  func testEditorInEditMode() {
    for look in Look.both {
      let app = launchSignedInCoach(look, arguments: ["-coach-board", "routines"])
      open(.routines, app)
      app.buttons["routine-board-routine"].tap()
      XCTAssertTrue(app.buttons["edit-routine"].waitForExistence(timeout: 10)); app.buttons["edit-routine"].tap()
      XCTAssertTrue(app.textFields["routine-name"].waitForExistence(timeout: 10))
      XCTAssertTrue(reach(app.staticTexts["History"], app).exists)
      capture("02.13-editor-history", look, app)
      let edit = app.buttons["edit-movements"]
      for _ in 0..<6 where !(edit.exists && edit.isHittable) { app.swipeDown(velocity: .slow) }
      XCTAssertTrue(edit.isHittable); edit.tap()
      XCTAssertTrue(edit.waitForLabel("Done"))
      // In edit mode the system's minus badge leads the row; a tap on it reveals the trash circle.
      let row = app.buttons["builder-movement-bench-press"]
      XCTAssertTrue(row.waitForExistence(timeout: 5))
      row.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
      XCTAssertTrue(app.buttons["trash-swipe"].wait(for: \.isHittable, toEqual: true, timeout: 5))
      capture("02L.3-routine-editor-edit-mode", look, app)
      app.terminate()
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

  // Empty Routines with a hidden workout keeps New routine in the bar.
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

  // 02L.2, 02L.4, 02L.5 and 02L.6 along one build: a new routine takes Bench Press, Incline Dumbbell Press and Chin-up as
  // the boards plan them, searches for a movement the catalogue lacks (the boards' Bulgarian split squat is a seed, so
  // Zercher squat stands in), and fills its form straight, then varied.
  func testBuildARoutine() {
    for look in Look.both {
      let app = launch("shell-last-room", look)
      openGymFromJournal(app, opensOn: .coach)
      open(.routines, app)
      XCTAssertTrue(app.staticTexts["No routines yet"].waitForExistence(timeout: 5))
      capture("02.7-routines-empty", look, app)
      app.buttons["new-routine"].tap()
      let name = app.textFields["routine-name"]
      XCTAssertTrue(name.waitForExistence(timeout: 5))
      capture("02L.2-routine-editor-new", look, app)
      name.tap(); name.typeText("Push A\n")
      addMovement(app, "bench-press", searching: "Bench") { app.plan(sets: 3, reps: 8, load: "60", rest: "2:00") }
      addMovement(app, "incline-dumbbell-press", searching: "Incline dumbbell") {
        app.plan(sets: 3, reps: 10, load: "16", rest: "1:30")
        let varied = app.switches["gym-target-varied"]
        XCTAssertTrue(varied.waitForExistence(timeout: 5)); varied.switches.firstMatch.tap()
        XCTAssertTrue(varied.waitForValue("1"))
        app.plan(row: 2, reps: 8, from: 10, load: "18"); app.plan(row: 3, reps: 6, from: 10, load: "20")
      }
      addMovement(app, "chin-up", searching: "Chin") { app.plan(sets: 3, reps: 8, load: "0", rest: "2:00") }
      XCTAssertTrue(app.buttons["builder-movement-chin-up"].waitForExistence(timeout: 5))
      capture("02L.2-routine-editor", look, app)
      app.buttons["add-movement"].tap()
      let search = app.searchFields.firstMatch
      XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("Zercher squat")
      XCTAssertTrue(app.buttons["gym-create-movement"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts["No movement by that name."].waitForExistence(timeout: 5))
      capture("02L.4-movement-picker", look, app)
      app.buttons["gym-create-movement"].tap()
      let movementName = app.textFields["gym-movement-name"]
      XCTAssertTrue(movementName.waitForExistence(timeout: 5))
      XCTAssertEqual(movementName.value as? String, "Zercher squat")
      app.choose("gym-movement-equipment", "Dumbbells")
      app.plan(sets: 3, reps: 10, load: "16", rest: "1:30")
      capture("02L.5-movement-form", look, app)
      let varied = app.switches["gym-target-varied"]
      varied.switches.firstMatch.tap()
      XCTAssertTrue(varied.waitForValue("1"))
      app.plan(row: 2, reps: 8, from: 10, load: "18"); app.plan(row: 3, reps: 6, from: 10, load: "20")
      // Back to the form's top: a drag lets the keyboard go, and a List keeps a row above the fold at a stale frame, so the
      // drags are counted, not conditioned on the row.
      for _ in 0..<4 {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28))
          .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55)), withVelocity: .slow, thenHoldForDuration: 0.1)
      }
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.buttons["gym-target-sets-Increment"].isHittable)
      capture("02L.6-movement-form-varied", look, app)
      app.buttons["gym-movement-editor-commit"].tap()
      XCTAssertTrue(app.buttons["save-routine"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "builder-movement-")).count == 4)
      app.buttons["save-routine"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["routine-detail"].waitForExistence(timeout: 5))
      capture("gym-routine-detail", look, app)
      app.terminate()
    }
  }

  // 02L.8: the movement form at the largest text, the stepper rows stacked and the Load field under its label.
  func testMovementFormAtLargestText() {
    for look in Look.bothAtLargestText {
      let app = launch("shell-last-room", look)
      openGymFromJournal(app, opensOn: .coach); open(.routines, app)
      app.buttons["new-routine"].tap()
      let name = app.textFields["routine-name"]
      XCTAssertTrue(name.waitForExistence(timeout: 5)); name.typeText("Push A\n")
      app.buttons["add-movement"].tap()
      XCTAssertTrue(app.buttons["gym-new-movement"].waitForExistence(timeout: 5)); app.buttons["gym-new-movement"].tap()
      let movementName = app.textFields["gym-movement-name"]
      XCTAssertTrue(movementName.waitForExistence(timeout: 5)); movementName.typeText("Zercher squat\n")
      app.choose("gym-movement-equipment", "Dumbbells")
      app.plan(sets: 3, reps: 10, load: "16", rest: "1:30")
      for _ in 0..<8 where !movementName.isHittable { app.swipeDown(velocity: .slow) }
      XCTAssertTrue(movementName.isHittable)
      capture("02L.8-movement-form", look, app)
      app.terminate()
    }
  }

  // Cancel on the form leaves the staged movement as it was; the editor's Cancel asks before discarding the routine.
  func testFormCancelRestoresTheStagedIdentityAndTargets() {
    for look in Look.both {
      let app = launch("shell-last-room", look)
      openGymFromJournal(app, opensOn: .coach); open(.routines, app)
      app.buttons["new-routine"].tap()
      let name = app.textFields["routine-name"]
      XCTAssertTrue(name.waitForExistence(timeout: 5)); name.typeText("Push A\n")
      addMovement(app, "bench-press") { app.plan(sets: 4) }
      app.buttons["builder-movement-bench-press"].tap()
      let movementName = app.textFields["gym-movement-name"]
      XCTAssertTrue(movementName.waitForExistence(timeout: 5))
      XCTAssertEqual(movementName.value as? String, "Bench Press")
      XCTAssertTrue(app.staticTexts["Sets: 4"].exists)
      movementName.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap()
      movementName.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Bench Press".count) + "Discarded press")
      XCTAssertTrue(movementName.waitForValue("Discarded press"))
      app.buttons["gym-movement-editor-cancel"].tap()
      let confirmation = app.sheets["Discard movement changes?"]
      XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
      capture("02.17-movement-unsaved", look, app)
      if confirmation.buttons["Keep editing"].exists { confirmation.buttons["Keep editing"].tap() }
      else { app.otherElements["PopoverDismissRegion"].coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap() }
      XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
      XCTAssertEqual(movementName.value as? String, "Discarded press")
      app.buttons["gym-movement-editor-cancel"].tap(); app.buttons["Discard"].tap()
      XCTAssertTrue(movementName.waitForNonExistence(timeout: 5))
      app.buttons["builder-movement-bench-press"].tap()
      XCTAssertTrue(movementName.waitForExistence(timeout: 5))
      XCTAssertEqual(movementName.value as? String, "Bench Press")
      XCTAssertTrue(app.staticTexts["Sets: 4"].exists)
      app.buttons["gym-movement-editor-cancel"].tap()
      XCTAssertTrue(movementName.waitForNonExistence(timeout: 5))
      app.navigationBars["New routine"].buttons["Cancel"].tap()
      XCTAssertTrue(app.buttons["Discard"].waitForExistence(timeout: 5)); app.buttons["Discard"].tap()
      XCTAssertTrue(app.staticTexts["No routines yet"].waitForExistence(timeout: 5))
    }
  }

  // Add movement, pick one from the catalogue — searched for when it is not among the six — plan it on the form, and add
  // it to the routine.
  func addMovement(_ app: XCUIApplication, _ id: String, searching query: String? = nil, planning plan: () -> Void) {
    app.buttons["add-movement"].tap()
    if let query {
      let search = app.searchFields.firstMatch
      XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText(query)
    }
    XCTAssertTrue(app.buttons["gym-movement-" + id].waitForExistence(timeout: 5)); app.buttons["gym-movement-" + id].tap()
    XCTAssertTrue(app.buttons["gym-movement-editor-commit"].waitForExistence(timeout: 5))
    plan()
    app.buttons["gym-movement-editor-commit"].tap()
    XCTAssertTrue(app.buttons["builder-movement-" + id].waitForExistence(timeout: 5))
  }
}
