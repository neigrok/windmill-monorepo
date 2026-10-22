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
    capture("05.3-workout-detail", look, app)
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
    capture("05.6-record", look, app)
    app.swipeUp(velocity: .slow)
    capture("gym-movement-record-chart", look, app)
    choose("gym-record-rename", from: "gym-record-more", app, capturing: "gym-movement-record-menu", look)
    XCTAssertTrue(app.textFields["gym-rename-movement-name"].waitForExistence(timeout: 5))
    capture("05.9-edit-exercise", look, app)
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.textFields["gym-rename-movement-name"].waitForNonExistence(timeout: 5)); back(app)
    app.buttons["gym-session-share"].tap()
    XCTAssertTrue(app.buttons["gym-share-sign-in"].waitForExistence(timeout: 5))
    capture("gym-session-share-sheet", look, app)
  }
  func testScreens() { for look in Look.both { screens(look) } }
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
