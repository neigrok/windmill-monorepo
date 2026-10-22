import XCTest

final class ChromeCaptures: DesignCapture {
  // 00.1: the bar on Routines and The log is the room menu and the account; on Coach the title, History and the account.
  func testTopBars() {
    for look in Look.both {
      let app = launchSignedInCoach(look)
      XCTAssertTrue(app.buttons["coach-history"].waitForExistence(timeout: 10))
      capture("00.1-top-bar-coach", look, app, settle: 1.5)
      open(.routines, app)
      capture("00.1-top-bar-routines", look, app, settle: 1.5)
      open(.log, app)
      capture("00.1-top-bar-log", look, app, settle: 1.5)
      app.terminate()
    }
  }

  func testSignedOutRoom() {
    for look in Look.both {
      let app = launch("shell-anonymous", look)
      openGymFromWelcome(app, opensOn: .coach)
      app.buttons["you"].tap()
      XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 5))
      capture("gym-you-signed-out", look, app)
      closeSheet(app)
      roomMenuOpen("gym-room-menu-open", look, app, current: "gym")
      open(.log, app)
      capture("gym-log-empty-signed-out", look, app, settle: 1.5)
      app.buttons["gym-weigh-in"].tap()
      XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5))
      capture("gym-weigh-in-sheet-empty-log", look, app)
    }
  }

  func testSignedOutHolding() {
    for look in Look.both {
      let app = launch("shell-anonymous", look, arguments: ["-gym-log-fixture"])
      openGymFromWelcome(app, opensOn: .coach)
      open(.log, app)
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch.waitForExistence(timeout: 20))
      app.buttons["you"].tap()
      XCTAssertTrue(app.staticTexts["On this phone"].waitForExistence(timeout: 5))
      capture("gym-you-signed-out-holding", look, app)
    }
  }

  func testSignedIn() {
    for look in Look.both {
      let app = launchSignedInCoach(look)
      app.buttons["you"].tap()
      XCTAssertTrue(app.navigationBars["You"].waitForExistence(timeout: 5))
      capture("gym-you-signed-in", look, app)
      reach(app.buttons["sign-out"], app).tap()
      XCTAssertTrue(app.alerts["Sign out?"].waitForExistence(timeout: 5))
      capture("gym-sign-out-alert", look, app)
    }
  }

  // The floating layer (designer-review-3 §2.7): bands that clear the rows, sheets that commit from the bar, Weigh in
  // floating on The log, the transient on glass, and the instruments at AX3. Run on a 375 pt phone for the -375 set.
  func floatingLayer(_ look: Look) {
    let workout = launch("workout-planned", look)
    XCTAssertTrue(workout.buttons["workout-log"].waitForExistence(timeout: 10))
    capture("gym-layout-rack", look, workout, settle: 1.5)
    let ledger = workout.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    workout.buttons["workout-log"].tap(); workout.buttons["workout-log"].tap()
    capture("gym-layout-rack-ledger-scrolled", look, workout)
    workout.buttons["workout-weight"].tap()
    XCTAssertTrue(workout.buttons["set-wheel-done"].waitForExistence(timeout: 5))
    capture("gym-layout-wheel", look, workout)
    workout.buttons["set-wheel-cancel"].tap()
    XCTAssertTrue(ledger.waitForExistence(timeout: 5)); ledger.tap()
    XCTAssertTrue(workout.buttons["workout-fix-save"].waitForExistence(timeout: 5))
    capture("gym-layout-fix-set", look, workout)
    workout.navigationBars["Fix set"].buttons["Cancel"].tap()
    XCTAssertTrue(workout.buttons["workout-fix-save"].waitForNonExistence(timeout: 5))
    workout.buttons["workout-weight"].tap()
    workout.turnLoadWheel(to: "105")
    workout.buttons["workout-log"].tap(); workout.descendants(matching: .any)["workout-current-set"].swipeLeft()
    let heavier = workout.alerts["Save 105 to Lower A?"]
    XCTAssertTrue(heavier.waitForExistence(timeout: 5))
    capture("gym-layout-heavier-dialog", look, workout)
    heavier.buttons["Today only"].firstMatch.tap()
    XCTAssertTrue(workout.buttons["workout-finish"].waitForExistence(timeout: 5)); workout.buttons["workout-finish"].tap()
    XCTAssertTrue(workout.buttons["Done"].waitForExistence(timeout: 10))
    capture("gym-layout-receipt", look, workout)
    workout.swipeUp(velocity: .slow)
    capture("gym-layout-receipt-scrolled", look, workout)
    workout.buttons["Done"].tap()
    XCTAssertTrue(workout.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
    capture("gym-layout-session-detail", look, workout)

    let notice = launch("workout-notice", look)
    XCTAssertTrue(notice.staticTexts["Check the weight and reps before logging."].waitForExistence(timeout: 10))
    capture("gym-layout-transient-band", look, notice)

    let routines = launch("shell-last-room", look)
    openGymFromJournal(routines, opensOn: .coach)
    open(.routines, routines)
    routines.buttons["new-routine"].tap()
    let routineName = routines.textFields["routine-name"]
    XCTAssertTrue(routineName.waitForExistence(timeout: 5)); routineName.typeText("Upper body strength day")
    capture("gym-layout-builder-typing", look, routines)
    routines.buttons["save-routine"].tap()
    XCTAssertTrue(routines.otherElements["routine-refusal"].waitForExistence(timeout: 5))
    capture("gym-layout-builder-refusal", look, routines)
    for id in ["bench-press", "deadlift"] {
      routines.buttons["add-movement"].tap()
      reach(routines.buttons["gym-movement-" + id], routines).tap()
    }
    XCTAssertTrue(routines.buttons["builder-movement-deadlift"].waitForExistence(timeout: 5))
    capture("gym-layout-builder", look, routines)
    XCTAssertTrue(routines.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Reorder")).firstMatch.exists)
    capture("gym-layout-builder-reorder", look, routines)
    reach(routines.buttons["builder-movement-bench-press"], routines).tap()
    XCTAssertTrue(routines.buttons["gym-target-set"].waitForExistence(timeout: 5))
    capture("gym-layout-targets", look, routines)
    routines.navigationBars["Targets"].buttons["Cancel"].tap()
    reach(routines.buttons["add-movement"], routines).tap()
    let search = routines.textFields["gym-movement-search"]
    XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("Zercher")
    XCTAssertTrue(routines.buttons["gym-create-movement"].waitForExistence(timeout: 5))
    capture("gym-layout-picker-query", look, routines)
    routines.buttons["gym-create-movement"].tap()
    XCTAssertTrue(routines.textFields["gym-movement-name"].waitForExistence(timeout: 5))
    capture("gym-layout-create-movement", look, routines)

    let log = launch("shell-anonymous", look, arguments: ["-gym-log-fixture"])
    openGymFromWelcome(log, opensOn: .coach)
    open(.log, log)
    let session = log.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
    XCTAssertTrue(session.waitForExistence(timeout: 20))
    capture("gym-layout-log", look, log, settle: 1.5)
    log.swipeUp(velocity: .slow)
    capture("gym-layout-log-scrolled", look, log)
    log.buttons["gym-weigh-in"].tap()
    XCTAssertTrue(log.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5))
    capture("gym-layout-weigh-in", look, log)
    log.buttons["gym-weigh-in-cancel"].tap()
    XCTAssertTrue(log.textFields["gym-weigh-in-weight"].waitForNonExistence(timeout: 5))
    revealInLog(session, log)
    session.swipeLeft()
    let discard = log.buttons["trash-swipe"]
    XCTAssertTrue(discard.wait(for: \.isHittable, toEqual: true, timeout: 5)); discard.tap()
    XCTAssertTrue(discard.waitForNonExistence(timeout: 5))
    XCTAssertTrue(log.buttons["Discard workout"].waitForExistence(timeout: 5))
    capture("gym-layout-log-discard-confirmation", look, log)
    log.cancelConfirmation()
    XCTAssertTrue(log.buttons["Discard workout"].waitForNonExistence(timeout: 5))

    let coach = launchSignedInCoach(look)
    let question = coach.descendants(matching: .any)["coach-question"]
    capture("gym-layout-coach-composer", look, coach, settle: 1.5)
    question.tap(); question.typeText("Is Push A still doing anything for my bench?")
    capture("gym-layout-coach-composing", look, coach)
  }
  func testFloatingLayer() { for look in Look.both { floatingLayer(look) } }
  func testFloatingLayerLargestText() { for look in Look.bothAtLargestText { floatingLayer(look) } }
}
