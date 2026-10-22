import XCTest

final class WorkoutCaptures: DesignCapture {
  func testWorkout() {
    for look in Look.both {
      let app = launch("workout-planned", look)
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
      capture("gym-workout-rack-planned", look, app, settle: 1.5)
      app.buttons["workout-assembly"].tap()
      XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
      capture("03.4-this-workout", look, app)
      app.buttons["workout-assembly-add"].tap()
      XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
      XCTAssertTrue(app.descendants(matching: .any)["gym-movement-picker"].waitForExistence(timeout: 5))
      capture("gym-workout-movement-picker", look, app)
      app.navigationBars.buttons["Cancel"].tap()
      XCTAssertTrue(app.searchFields.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.buttons["workout-assembly-add"].waitForNonExistence(timeout: 5))
      let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
      XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
      XCTAssertTrue(app.buttons["workout-fix-save"].waitForExistence(timeout: 5))
      capture("03.3-fix-set", look, app)
      app.navigationBars["Fix set"].buttons["Cancel"].tap()
      XCTAssertTrue(app.buttons["workout-fix-save"].waitForNonExistence(timeout: 5))
      app.descendants(matching: .any)["workout-current-set"].swipeLeft()
      capture("gym-workout-rack-second-movement", look, app)
    }
  }

  // The rack at Upper A's dumbbell press, after a +1 and one rep fewer, and at the pull-up's added load.
  func testRack() {
    let rack = { (look: Look) -> XCUIApplication in
      let app = self.launch("workout-upper", look)
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
      return app
    }
    captureBoard("03.1-rack-dumbbells", settle: 1.5, opening: rack)
    captureBoard("03.11-rack-changed", settle: 1.5) { look in
      let app = rack(look)
      app.buttons["workout-weight-step-2"].tap(); app.buttons["workout-reps-minus"].tap()
      XCTAssertTrue(app.buttons["workout-weight"].waitForLabel("Weight, 17 kg each"))
      return app
    }
    captureBoard("03.12-rack-bodyweight", settle: 1.5) { look in
      let app = rack(look)
      app.descendants(matching: .any)["workout-current-set"].swipeLeft()
      XCTAssertTrue(app.buttons["workout-weight"].waitForLabel("Weight, 10 kg added"))
      return app
    }
  }

  func testFreeWorkoutStart() {
    captureBoard("03.9-free-workout-start", settle: 1.5) { look in
      let app = launch("workout-blank", look)
      XCTAssertTrue(app.buttons["workout-add"].waitForExistence(timeout: 10))
      return app
    }
  }

  func testLoadAndReps() {
    captureBoard("03.2-load-and-reps", settle: 1.5) { look in
      let app = launch("workout-upper", look)
      XCTAssertTrue(app.buttons["workout-weight"].waitForExistence(timeout: 10)); app.buttons["workout-weight"].tap()
      XCTAssertTrue(app.pickerWheels["16 kg each"].waitForExistence(timeout: 5))
      return app
    }
  }

  // Outside the app the system draws in the phone's appearance, so each look sets it before the workout goes to the Home
  // Screen with its Live Activity running.
  func leaveForHomeScreen(_ look: Look) -> XCUIApplication {
    XCUIDevice.shared.appearance = look.appearance == .dark ? .dark : .light
    let app = launch("workout-live-activity-planned", look)
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 15))
    let activity = app.otherElements["workout-activity-state"]
    XCTAssertTrue(activity.waitForValue("active", timeout: 15))
    XCUIDevice.shared.press(.home)
    return XCUIApplication(bundleIdentifier: "com.apple.springboard")
  }

  // The control in Control Center at its 2 × 1 size, added from the controls gallery when the phone does not hold it yet.
  func testControlCenterControl() {
    for look in Look.both {
      let springboard = leaveForHomeScreen(look)
      springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.005)).press(forDuration: 0.05,
        thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.6)))
      let control = springboard.buttons["works.windmill.app.workout"]
      if !control.waitForExistence(timeout: 3) {
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)).press(forDuration: 1.5)
        XCTAssertTrue(springboard.buttons["Add a Control"].waitForExistence(timeout: 5)); springboard.buttons["Add a Control"].tap()
        let search = springboard.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("Windmill")
        let gallery = springboard.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Workout")).firstMatch
        XCTAssertTrue(gallery.waitForExistence(timeout: 5)); gallery.tap()
        let placed = springboard.icons["Workout"]
        XCTAssertTrue(placed.waitForExistence(timeout: 5))
        let corner = placed.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: placed.frame.width - 9, dy: placed.frame.height - 6))
        corner.press(forDuration: 0.3, thenDragTo: corner.withOffset(CGVector(dx: placed.frame.width + 20, dy: 0)))
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)).tap()
      }
      XCTAssertTrue(control.waitForLabel("Log set"))
      capture("04.1-control-center", look, springboard)
      XCUIDevice.shared.press(.home)
      XCUIApplication().terminate()
    }
    XCUIDevice.shared.appearance = .light
  }

  func testHiddenWorkout() {
    for look in Look.both {
      let app = launch("workout-planned", look)
      XCTAssertTrue(app.buttons["workout-assembly"].waitForExistence(timeout: 10)); app.buttons["workout-assembly"].tap()
      XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
      XCTAssertTrue(app.buttons["gym-hidden-workout"].waitForExistence(timeout: 5))
      capture("gym-hidden-workout-accessory", look, app, settle: 1.5)
      open(.log, app)
      capture("gym-hidden-workout-accessory-log", look, app, settle: 1.5)
    }
  }

  func testDeviationAndReceipt() {
    for look in Look.both {
      let app = launch("workout-planned", look)
      XCTAssertTrue(app.buttons["workout-weight"].waitForExistence(timeout: 10))
      app.buttons["workout-weight"].tap()
      app.turnLoadWheel(to: "105")
      app.buttons["workout-log"].tap()
      app.descendants(matching: .any)["workout-current-set"].swipeLeft()
      let heavier = app.alerts["Save 105 to Lower A?"]
      XCTAssertTrue(heavier.waitForExistence(timeout: 5))
      capture("gym-workout-heavier-than-plan-dialog", look, app)
      heavier.buttons["Today only"].firstMatch.tap()
      XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 5)); app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
      capture("03.7-finish-receipt", look, app)
      app.swipeUp()
      capture("gym-workout-finish-receipt-actions", look, app)
    }
  }

  // A workout that set a record: the receipt's Personal record card under the workout's tiles.
  func testRecord() {
    for look in Look.both {
      let app = launch("workout-record", look)
      XCTAssertTrue(app.staticTexts["Personal record"].waitForExistence(timeout: 15))
      capture("gym-workout-finish-receipt-record", look, app)
    }
  }

  func testTransients() {
    for look in Look.both {
      let app = launch("workout-notice", look)
      XCTAssertTrue(app.staticTexts["Check the weight and reps before logging."].waitForExistence(timeout: 10))
      capture("gym-workout-transient", look, app)
      app.otherElements["workout-refusal"].buttons["Dismiss message"].tap()
      XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "not sent.")).firstMatch.waitForExistence(timeout: 5))
      capture("gym-workout-durable-refusal", look, app)
    }
  }
}
