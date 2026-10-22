import XCTest

final class LogCaptures: DesignCapture {
  // An open iOS 26 menu can drop the first tap on an item; the item is tapped again until it leaves.
  func choose(_ item: String, from menu: String, _ app: XCUIApplication, capturing screen: String, _ look: Look) {
    let button = app.buttons[menu]
    XCTAssertTrue(button.wait(for: \.isHittable, toEqual: true, timeout: 10)); button.tap()
    let choice = app.buttons[item]
    XCTAssertTrue(choice.wait(for: \.isHittable, toEqual: true, timeout: 10))
    capture(screen, look, app, settle: 0.6)
    for _ in 0..<3 where choice.exists {
      choice.tap()
      if choice.waitForNonExistence(timeout: 3) { break }
    }
  }

  func screens(_ look: Look) {
    let app = launch("shell-anonymous", look, arguments: ["-gym-log-fixture"])
    openGymFromWelcome(app, opensOn: .coach)
    open(.log, app)
    let session = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
    XCTAssertTrue(session.waitForExistence(timeout: 20))
    capture("05.1-log", look, app)
    let moment = app.buttons.matching(identifier: "gym-best-moment").firstMatch
    revealInLog(moment, app)
    capture("gym-log-moment", look, app)
    moment.tap()
    XCTAssertTrue(app.staticTexts["gym-chart-caption"].waitForExistence(timeout: 5))
    capture("gym-movement-record-from-moment", look, app, settle: 1.5)
    back(app)
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 5))
    let end = app.staticTexts["gym-log-end"]
    for _ in 0..<30 where !onScreen(end, app) { app.swipeUp(velocity: .fast) }
    revealInLog(end, app)
    capture("gym-log-end", look, app)
    for _ in 0..<30 where !onScreen(app.buttons["gym-bodyweight-door"], app) { app.swipeDown(velocity: .fast) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.6))
    app.buttons["gym-weigh-in"].tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5))
    capture("06.1-weigh-in", look, app)
    app.buttons["gym-weigh-in-cancel"].tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForNonExistence(timeout: 5))
    revealInLog(app.buttons["gym-bodyweight-door"], app)
    app.buttons["gym-bodyweight-door"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-bodyweight"].waitForExistence(timeout: 5))
    capture("06.2-bodyweight", look, app)
    let weighIn = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-weigh-in-2026-")).firstMatch
    revealInLog(weighIn, app)
    capture("gym-bodyweight-rows", look, app)
    XCTAssertTrue(weighIn.waitForExistence(timeout: 5)); weighIn.tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5))
    capture("gym-weigh-in-edit-sheet", look, app)
    app.buttons["gym-weigh-in-cancel"].tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForNonExistence(timeout: 5)); back(app)
    revealInLog(session, app)
    session.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
    choose("gym-session-discard", from: "gym-session-more", app, capturing: "gym-session-detail-menu", look)
    XCTAssertTrue(app.buttons["Discard workout"].waitForExistence(timeout: 5))
    capture("gym-log-discard-confirmation", look, app)
    app.cancelConfirmation()
    XCTAssertTrue(app.buttons["Discard workout"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-finished-set-")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    XCTAssertTrue(app.buttons["gym-fix-weight"].waitForExistence(timeout: 5))
    capture("gym-finished-set-fix-sheet", look, app)
    app.navigationBars["Fix set"].buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["gym-fix-weight"].waitForNonExistence(timeout: 5))
    app.buttons["gym-session-movement"].firstMatch.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
    choose("gym-record-rename", from: "gym-record-more", app, capturing: "gym-movement-record-menu", look)
    XCTAssertTrue(app.textFields["gym-rename-movement-name"].waitForExistence(timeout: 5))
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.textFields["gym-rename-movement-name"].waitForNonExistence(timeout: 5)); back(app)
    app.buttons["gym-session-share"].tap()
    XCTAssertTrue(app.buttons["gym-share-sign-in"].waitForExistence(timeout: 5))
    capture("gym-session-share-sheet", look, app)
  }
  func testScreens() { for look in Look.both { screens(look) } }

  func openLog(_ look: Look) -> XCUIApplication {
    let app = launch("shell-anonymous", look, arguments: ["-gym-log-fixture"])
    openGymFromWelcome(app, opensOn: .coach)
    open(.log, app)
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch.waitForExistence(timeout: 20))
    return app
  }
  func openWorkout(_ look: Look) -> XCUIApplication {
    let app = openLog(look)
    let session = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
    revealInLog(session, app); session.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
    return app
  }

  func testWorkoutDetail() {
    captureBoard("05.3-workout-detail") { look in openWorkout(look) }
  }

  func openRecord(_ look: Look) -> XCUIApplication {
    let app = openWorkout(look)
    app.buttons["gym-session-movement"].firstMatch.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-record-chart"].waitForExistence(timeout: 5))
    return app
  }
  func testRecord() {
    captureBoard("05.6-record", settle: 1.5) { look in openRecord(look) }
  }
  // A finger held on the plot rules the point under it and reads it in the window line's place.
  func testRecordScrub() {
    captureBoard("05.7-record-scrub", settle: 0.2) { look in
      let app = openRecord(look)
      let viewport = app.descendants(matching: .any)["gym-chart-viewport"]
      let start = viewport.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
      start.press(forDuration: 0.6, thenDragTo: start.withOffset(CGVector(dx: -12, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.1)
      XCTAssertTrue(app.staticTexts["gym-chart-reading"].exists)
      return app
    }
  }
  func openEditExercise(_ look: Look) -> XCUIApplication {
    let app = openRecord(look)
    for _ in 0..<3 where !app.buttons["gym-record-rename"].exists {
      app.buttons["gym-record-more"].tap(); _ = app.buttons["gym-record-rename"].waitForExistence(timeout: 3)
    }
    app.buttons["gym-record-rename"].tap()
    XCTAssertTrue(app.textFields["gym-rename-movement-name"].waitForExistence(timeout: 5))
    return app
  }
  // Switched to Dumbbells, the sheet asks how many are lifted and says what the weight means.
  func testEditExercise() {
    captureBoard("05.9-edit-exercise") { look in
      let app = openEditExercise(look)
      app.buttons["gym-rename-movement-equipment"].tap()
      let dumbbells = app.buttons["Dumbbells"]
      XCTAssertTrue(dumbbells.waitForExistence(timeout: 5)); dumbbells.tap()
      XCTAssertTrue(app.segmentedControls["gym-rename-movement-equipment-count"].waitForExistence(timeout: 5))
      return app
    }
  }
  func testEditExerciseEquipment() {
    captureBoard("05.10-edit-exercise-equipment", settle: 0.6) { look in
      let app = openEditExercise(look)
      app.buttons["gym-rename-movement-equipment"].tap()
      XCTAssertTrue(app.buttons["Kettlebell"].waitForExistence(timeout: 5))
      return app
    }
  }

  // The whole series, panned back to its earliest workouts.
  func testRecordPanned() {
    captureBoard("05.8-record-panned", settle: 1.0) { look in
      let app = openRecord(look)
      let all = app.segmentedControls["gym-record-window"].buttons["All"]
      all.tap()
      XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "the whole series")).firstMatch.waitForExistence(timeout: 5))
      let viewport = app.descendants(matching: .any)["gym-chart-viewport"]
      let left = viewport.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5))
      left.press(forDuration: 0.01, thenDragTo: viewport.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)), withVelocity: .fast, thenHoldForDuration: 0)
      left.press(forDuration: 0.01, thenDragTo: viewport.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)), withVelocity: .fast, thenHoldForDuration: 0)
      return app
    }
  }
  func testScreensLargestText() { for look in Look.bothAtLargestText { screens(look) } }

  // Swipe deletes reveal the round red trash circle: a workout on The log, a set in the workout's detail.
  func testSwipeDeletes() {
    for look in Look.both {
      let app = launch("shell-anonymous", look, arguments: ["-gym-log-fixture"])
      openGymFromWelcome(app, opensOn: .coach)
      open(.log, app)
      let session = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
      XCTAssertTrue(session.waitForExistence(timeout: 20))
      revealInLog(session, app)
      session.swipeLeft()
      XCTAssertTrue(app.buttons["trash-swipe"].wait(for: \.isHittable, toEqual: true, timeout: 5))
      capture("05.2-log-discard-by-swipe", look, app)
      session.swipeRight()
      XCTAssertTrue(app.buttons["trash-swipe"].waitForNonExistence(timeout: 5)); session.tap()
      XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
      let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-finished-set-")).element(boundBy: 1)
      XCTAssertTrue(set.waitForExistence(timeout: 5)); set.swipeLeft()
      XCTAssertTrue(app.buttons["trash-swipe"].wait(for: \.isHittable, toEqual: true, timeout: 5))
      capture("05.4-workout-detail-delete-set-by-swipe", look, app)
      app.terminate()
    }
  }

  // At the largest text the log's end scrolls clear above the floating Weigh in.
  func testWeighInClearsTheEndAtLargestText() {
    for look in Look.bothAtLargestText {
      let app = launch("shell-anonymous", look, arguments: ["-gym-log-fixture"])
      openGymFromWelcome(app, opensOn: .coach)
      open(.log, app)
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch.waitForExistence(timeout: 20))
      let end = app.staticTexts["gym-log-end"]
      for _ in 0..<40 where !onScreen(end, app) { app.swipeUp(velocity: .fast) }
      for _ in 0..<3 { app.swipeUp(velocity: .fast) }
      RunLoop.current.run(until: Date().addingTimeInterval(1.5))
      XCTAssertLessThanOrEqual(end.frame.maxY, app.buttons["gym-weigh-in"].frame.minY)
      capture("gym-log-end-weigh-in", look, app)
      app.terminate()
    }
  }

  func testOneSessionSignedIn() {
    for look in Look.both {
      let app = launchSignedInCoach(look)
      open(.log, app)
      XCTAssertTrue(app.buttons["gym-log-session-coach-fixture-session"].waitForExistence(timeout: 10))
      capture("gym-log-one-session-signed-in", look, app, settle: 1.5)
    }
  }

  // Signed in and offline, the log's sessions wait on the phone: the rows carry the phone symbol and the detail says so once.
  func testUnsent() {
    for look in Look.both {
      let app = XCUIApplication()
      app.launchArguments = ["-model-server", "-scenario", "capture-log-unsent", "-offline-fixture", "seed-signed-in"]
      app.launch()
      XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 15))
      app.terminate()
      app.launchArguments = ["-scenario", "capture-log-unsent", "-restore-board", "-server", "https://offline.invalid",
                             "-offline-fixture", "no-network", "-gym-log-fixture"] + look.launchArguments
      app.launch()
      openGymFromJournal(app, opensOn: .coach)
      open(.log, app)
      let session = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
      XCTAssertTrue(session.waitForExistence(timeout: 20))
      XCTAssertTrue(session.images["iphone"].exists || session.label.contains("On this phone"))
      capture("gym-log-signed-in-unsent", look, app, settle: 1.5)
      revealInLog(session, app)
      session.tap()
      XCTAssertTrue(app.staticTexts["gym-session-footer"].waitForExistence(timeout: 5))
      capture("gym-session-detail-unsent", look, app)
    }
  }
}
