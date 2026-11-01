import XCTest

final class WorkoutCaptures: DesignCapture {
  func testReceivedOtherKeepsSignedLoadsAndNativeEditors() {
    for look in Look.both {
      let app = launch("workout-upper-other", look)
      let weight = app.buttons["workout-weight"]
      XCTAssertTrue(weight.waitForLabel("Weight, −5 kg"))
      XCTAssertFalse(app.images["figure.strengthtraining.functional"].exists)
      capture("other-rack", look, app)
      weight.tap()
      let load = app.textFields["workout-load"]
      XCTAssertTrue(load.waitForValue("−5"))
      for value in ["5", "−5"] {
        app.buttons["workout-load-sign"].tap()
        XCTAssertTrue(load.waitForValue(value))
      }
      capture("other-load-sign", look, app)
      app.buttons["workout-load-done"].tap()
      XCTAssertTrue(weight.waitForLabel("Weight, −5 kg"))
      let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "workout-set-", "Set 2,")).firstMatch
      XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
      let fixLoad = app.textFields["workout-fix-load"]
      XCTAssertTrue(fixLoad.waitForValue("−5"))
      app.pickerWheels.element(boundBy: 0).adjust(toPickerWheelValue: "8 reps")
      capture("other-fix-set", look, app)
      app.typeLoad("4", into: "workout-fix-load")
      app.buttons["workout-fix-load-sign"].tap()
      XCTAssertTrue(fixLoad.waitForValue("−4"))
      app.buttons["workout-fix-save"].tap()
      XCTAssertTrue(set.waitForLabel("Set 2, logged, −4 kilograms, 8 reps"))
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.buttons["workout-done"].waitForExistence(timeout: 10)); app.buttons["workout-done"].tap()
      XCTAssertTrue(app.buttons["gym-session-movement"].firstMatch.waitForExistence(timeout: 10))
      back(app)
      open(.routines, app)
      let routine = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "routine-", "Upper A,")).firstMatch
      XCTAssertTrue(routine.waitForExistence(timeout: 5)); routine.tap()
      XCTAssertTrue(app.buttons["edit-routine"].waitForExistence(timeout: 5)); app.buttons["edit-routine"].tap()
      app.buttons["builder-movement-pull-up"].tap()
      XCTAssertTrue(app.textFields["gym-movement-name"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["gym-movement-equipment"].waitForValue("Other"))
      XCTAssertEqual(app.textFields["gym-target-weight"].value as? String, "−5")
      XCTAssertFalse(app.staticTexts["Enter the external weight you lift."].exists)
      XCTAssertFalse(app.staticTexts["Name and equipment apply everywhere. Targets stay in this routine."].exists)
      capture("other-movement-editor", look, app)
      app.buttons["gym-movement-editor-cancel"].tap()
      app.terminate()
    }
  }

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
      capture("gym-workout-fix-set", look, app)
      app.buttons["workout-fix-cancel"].tap()
      XCTAssertTrue(app.buttons["workout-fix-save"].waitForNonExistence(timeout: 5))
      app.descendants(matching: .any)["workout-current-set"].swipeLeft()
      capture("gym-workout-rack-second-movement", look, app)
    }
  }

  // Create movement over the workout, opened from a search no movement matches.
  func testCreateMovement() {
    captureBoard("gym-workout-create-movement", settle: 1.5) { look in
      let app = launch("workout-planned", look)
      let menu = app.buttons["workout-movement-menu"]
      XCTAssertTrue(menu.waitForExistence(timeout: 10)); menu.tap()
      XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 5)); app.buttons["Add movement"].tap()
      XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
      app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText("Zercher squat")
      XCTAssertTrue(app.buttons["gym-create-movement"].waitForExistence(timeout: 5)); app.buttons["gym-create-movement"].tap()
      XCTAssertTrue(app.textFields["gym-movement-name"].waitForValue("Zercher squat"))
      return app
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

  // Fix set over the second dumbbell press set, its load on the decimal pad.
  func testFixSet() {
    captureBoard("03.25-fix-set", settle: 1.5) { look in
      let app = launch("workout-upper", look)
      let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "workout-set-", "Set 2,")).firstMatch
      XCTAssertTrue(set.waitForExistence(timeout: 10))
      RunLoop.current.run(until: Date().addingTimeInterval(1)); set.tap()
      XCTAssertTrue(app.staticTexts["Set 2"].waitForExistence(timeout: 5))
      app.textFields["workout-fix-load"].tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      return app
    }
  }

  // The press's load typed in place on the rack, and its reps on the one wheel.
  func testLoadAndReps() {
    captureBoard("03.23-load-in-place", settle: 1.5) { look in
      let app = launch("workout-upper", look)
      XCTAssertTrue(app.buttons["workout-weight"].waitForExistence(timeout: 10)); app.buttons["workout-weight"].tap()
      XCTAssertTrue(app.textFields["workout-load"].waitForValue("16"))
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["workout-log"].exists)
      return app
    }
    captureBoard("03.24-reps-wheel", settle: 1.5) { look in
      let app = launch("workout-upper", look)
      XCTAssertTrue(app.buttons["workout-reps"].waitForExistence(timeout: 10)); app.buttons["workout-reps"].tap()
      XCTAssertTrue(app.pickerWheels["8 reps"].waitForExistence(timeout: 5))
      return app
    }
    captureBoard("03.30-sign-key-rack", settle: 1.5) { look in
      let app = launch("workout-upper", look)
      XCTAssertTrue(app.buttons["workout-weight"].waitForExistence(timeout: 10))
      app.descendants(matching: .any)["workout-current-set"].swipeLeft()
      XCTAssertTrue(app.buttons["workout-weight"].waitForLabel("Weight, 10 kg added")); app.buttons["workout-weight"].tap()
      XCTAssertTrue(app.buttons["workout-load-sign"].waitForExistence(timeout: 5))
      return app
    }
  }

  // The workout in flight's plan boards on its fixture (workout-in-flight.md): the movement menu with nothing logged and
  // with a logged set, past the plan, Edit sets, Swap and the receipt's plan changes.
  func testWorkoutInFlight() {
    let inFlight = { (look: Look, board: String) -> (XCUIApplication, XCUIElement) in
      let app = self.launch(board, look)
      let menu = app.buttons["workout-movement-menu"]
      XCTAssertTrue(menu.waitForExistence(timeout: 60))
      return (app, menu)
    }
    captureBoard("03.26-movement-menu-nothing-logged", settle: 1.5) { look in
      let (app, menu) = inFlight(look, "workout-inflight")
      XCTAssertTrue(menu.waitForValue("Pull-up")); menu.tap()
      XCTAssertTrue(app.buttons["Swap movement"].waitForExistence(timeout: 5))
      return app
    }
    captureBoard("03.27-movement-menu-logged", settle: 1.5) { look in
      let (app, menu) = inFlight(look, "workout-inflight-logged")
      XCTAssertTrue(menu.waitForValue("Dumbbell Bench Press")); menu.tap()
      XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["Edit sets"].exists)
      return app
    }
    captureBoard("03.28-past-the-plan", settle: 1.5) { look in
      let (app, menu) = inFlight(look, "workout-inflight-logged")
      XCTAssertTrue(menu.waitForValue("Dumbbell Bench Press"))
      app.buttons["workout-log"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["workout-current-set"].waitForLabel("Set 4, current, open target"))
      return app
    }
    captureBoard("03.29-edit-sets", settle: 1.5) { look in
      let (app, menu) = inFlight(look, "workout-inflight")
      XCTAssertTrue(menu.waitForValue("Pull-up")); menu.tap()
      XCTAssertTrue(app.buttons["Edit sets"].waitForExistence(timeout: 5)); app.buttons["Edit sets"].tap()
      XCTAssertTrue(app.staticTexts["Pull-up · this workout"].waitForExistence(timeout: 5))
      return app
    }
    captureBoard("03.31-swap-movement", settle: 1.5) { look in
      let (app, menu) = inFlight(look, "workout-inflight")
      XCTAssertTrue(menu.waitForValue("Pull-up")); menu.tap()
      XCTAssertTrue(app.buttons["Swap movement"].waitForExistence(timeout: 5)); app.buttons["Swap movement"].tap()
      XCTAssertTrue(app.navigationBars["Swap Pull-up"].waitForExistence(timeout: 5))
      return app
    }
    captureBoard("03.32-receipt-plan-changes", settle: 2) { look in
      let (app, menu) = inFlight(look, "workout-inflight")
      XCTAssertTrue(menu.waitForValue("Pull-up")); menu.tap()
      XCTAssertTrue(app.buttons["Edit sets"].waitForExistence(timeout: 5)); app.buttons["Edit sets"].tap()
      app.buttons["edit-sets-set-1"].tap()
      app.typeLoad("12.5", into: "edit-sets-load")
      app.buttons["edit-sets-save"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["workout-current-set"].waitForLabel("Set 1, current, 12.5 kilograms, 8 reps"))
      menu.tap()
      XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 5)); app.buttons["Add movement"].tap()
      XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
      app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText("Face")
      XCTAssertTrue(app.buttons["gym-movement-face-pull"].waitForExistence(timeout: 5)); app.buttons["gym-movement-face-pull"].tap()
      let open = app.descendants(matching: .any)["workout-current-set"]
      XCTAssertTrue(open.waitForLabel("Set 1, current, open target")); open.tap()
      XCTAssertTrue(app.buttons["edit-sets-add"].waitForExistence(timeout: 5)); app.buttons["edit-sets-add"].tap()
      app.typeLoad("15", into: "edit-sets-load")
      app.pickerWheels.element(boundBy: 0).adjust(toPickerWheelValue: "15 reps")
      app.buttons["edit-sets-add"].tap()
      app.buttons["edit-sets-save"].tap()
      XCTAssertTrue(open.waitForLabel("Set 1, current, 15 kilograms, 15 reps"))
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.switches["workout-receipt-save-plan"].waitForExistence(timeout: 15))
      return app
    }
  }

  // The facts row's rest target: resting toward the press's two minutes, past them, and the row with no target.
  func testRestTarget() {
    captureBoard("03.20-rest-target-resting", settle: 1.5) { look in
      let app = launch("workout-upper", look)
      XCTAssertTrue(app.descendants(matching: .any)["Since last set"].waitForExistence(timeout: 10))
      XCTAssertTrue((app.descendants(matching: .any)["Since last set"].value as? String ?? "").hasSuffix(", target 2 minutes"))
      return app
    }
    captureBoard("03.21-rest-target-reached", settle: 1.5) { look in
      let app = launch("workout-upper-rested", look)
      XCTAssertTrue(app.descendants(matching: .any)["Since last set"].waitForExistence(timeout: 10))
      return app
    }
    captureBoard("03.22-rest-target-none", settle: 1.5) { look in
      let app = launch("workout-upper", look)
      XCTAssertTrue(app.buttons["workout-weight"].waitForExistence(timeout: 10))
      for _ in 0..<2 { app.descendants(matching: .any)["workout-current-set"].swipeLeft(); RunLoop.current.run(until: Date().addingTimeInterval(0.6)) }
      let since = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND NOT (value ENDSWITH %@)", "Since last set", "minutes")).firstMatch
      XCTAssertTrue(since.waitForExistence(timeout: 5))
      return app
    }
  }

  // Outside the app the system draws in the phone's appearance, so each look sets it before the workout goes to the Home
  // Screen with its Live Activity running.
  func leaveForHomeScreen(_ look: Look) -> (app: XCUIApplication, springboard: XCUIApplication) {
    let app = launchOutside("workout-live-activity-planned", look, ready: "workout-log")
    let activity = app.otherElements["workout-activity-state"]
    XCTAssertTrue(activity.waitForValue("active", timeout: 15))
    XCUIDevice.shared.press(.home)
    return (app, XCUIApplication(bundleIdentifier: "com.apple.springboard"))
  }

  // A Live Activity outlives the app, and a later launch would meet it, so each board ends its workout before the next.
  func finishOutside(_ app: XCUIApplication) {
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 10)); app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.buttons["workout-finish"].waitForNonExistence(timeout: 10))
    app.terminate()
  }

  // The control in Control Center at its 2 × 1 size, added from the controls gallery when the phone does not hold it yet.
  func testControlCenterControl() {
    for look in Look.both {
      let (app, springboard) = leaveForHomeScreen(look)
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
      finishOutside(app)
    }
    XCUIDevice.shared.appearance = .light
  }

  // The Live Activity in the compact and expanded Island, then on the Lock Screen.
  func testLiveActivity() {
    for look in Look.both {
      let (app, springboard) = leaveForHomeScreen(look)
      let compact = springboard.staticTexts["Since last set"]
      let inIsland = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        guard let snapshot = try? compact.snapshot() else { return false }
        return !snapshot.frame.isEmpty && springboard.frame.contains(snapshot.frame) && snapshot.frame.maxY < 100
      }, object: nil)
      XCTAssertEqual(XCTWaiter.wait(for: [inIsland], timeout: 30), .completed)
      capture("04.3-dynamic-island-compact", look, springboard)
      let container = springboard.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH %@", "jindo-container-view:"))
        .containing(.staticText, identifier: "Since last set").firstMatch
      XCTAssertTrue(container.wait(for: \.isHittable, toEqual: true, timeout: 30)); container.press(forDuration: 1)
      XCTAssertTrue(springboard.buttons["Log set"].waitForExistence(timeout: 5))
      capture("04.6-dynamic-island-expanded", look, springboard)
      XCUIDevice.shared.press(.home)
      showLockScreen(springboard)
      XCTAssertTrue(springboard.buttons["Log set"].wait(for: \.isHittable, toEqual: true, timeout: 20))
      capture("04.7-live-activity-compact", look, springboard)
      finishOutside(app)
    }
    XCUIDevice.shared.appearance = .light
  }

  // 04.4's first state: a routine workout before its first set, its clock counting from the start.
  func testLiveActivityBeforeTheFirstSet() {
    for look in Look.both {
      let app = launchOutside("workout-live-activity-planned-empty", look, ready: "workout-log")
      RunLoop.current.run(until: Date().addingTimeInterval(3))
      XCUIDevice.shared.press(.home)
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      showLockScreen(springboard)
      XCTAssertTrue(springboard.buttons["Log set"].wait(for: \.isHittable, toEqual: true, timeout: 20))
      XCTAssertTrue(springboard.staticTexts["Set 1 of 4"].exists)
      capture("04.4-live-activity-before-the-first-set", look, springboard)
      finishOutside(app)
    }
    XCUIDevice.shared.appearance = .light
  }

  // The first launch after an install can open on Where to start? before the board's workout is ready, so it launches once
  // more when the workout does not appear.
  func launchOutside(_ fixture: String, _ look: Look, ready: String) -> XCUIApplication {
    XCUIDevice.shared.appearance = look.appearance == .dark ? .dark : .light
    var app = launch(fixture, look)
    if !app.buttons[ready].waitForExistence(timeout: 15) { app.terminate(); app = launch(fixture, look) }
    XCTAssertTrue(app.buttons[ready].waitForExistence(timeout: 15))
    return app
  }

  func showLockScreen(_ springboard: XCUIApplication) {
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.001)).press(forDuration: 0.05,
      thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)))
    let allow = springboard.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "Always Allow"])).firstMatch
    if allow.waitForExistence(timeout: 2) { allow.tap() }
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

  func testReceiptActions() {
    for look in Look.both {
      let app = launch("workout-planned", look)
      XCTAssertTrue(app.buttons["workout-weight"].waitForExistence(timeout: 10))
      app.buttons["workout-weight"].tap()
      app.typeLoad("105")
      app.buttons["workout-log"].tap()
      app.descendants(matching: .any)["workout-current-set"].swipeLeft()
      XCTAssertTrue(app.movementHeader("Romanian Deadlift").waitForExistence(timeout: 5))
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
      app.swipeUp()
      capture("gym-workout-finish-receipt-actions", look, app)
      app.buttons["workout-receipt-options"].tap()
      XCTAssertTrue(app.buttons["Discard workout"].waitForExistence(timeout: 5))
      capture("03.18-finish-options", look, app)
      app.buttons["Discard workout"].tap()
      XCTAssertTrue(app.alerts["Discard this workout?"].waitForExistence(timeout: 5))
      capture("03.19-finish-discard-confirmation", look, app)
    }
  }

  // 03.7: four squat sets and a deadlift set read Well done.; 03.15: the same, the phone's first receipt, suggests Keep once;
  // 03.8: finishing on two sets reads Ended early. with the deadlift not started.
  func testReceipt() {
    captureBoard("03.7-finish-receipt", settle: 1.5) { look in
      let app = launch("workout-planned", look)
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
      app.buttons["workout-log"].tap(); app.buttons["workout-log"].tap()
      app.descendants(matching: .any)["workout-current-set"].swipeLeft()
      XCTAssertTrue(app.movementHeader("Romanian Deadlift").waitForExistence(timeout: 5)); app.buttons["workout-log"].tap()
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.staticTexts["Well done."].waitForExistence(timeout: 10))
      XCTAssertFalse(app.buttons["workout-keep"].exists)
      return app
    }
    captureBoard("03.15-first-workout-signed-out", settle: 1.5) { look in
      let app = launch("workout-planned-first", look)
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
      app.buttons["workout-log"].tap(); app.buttons["workout-log"].tap()
      app.descendants(matching: .any)["workout-current-set"].swipeLeft()
      XCTAssertTrue(app.movementHeader("Romanian Deadlift").waitForExistence(timeout: 5)); app.buttons["workout-log"].tap()
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.buttons["workout-keep"].waitForExistence(timeout: 10))
      return app
    }
    captureBoard("03.8-ended-early", settle: 1.5) { look in
      let app = launch("workout-planned", look)
      XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 10)); app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.staticTexts["not started"].waitForExistence(timeout: 10))
      return app
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
