import XCTest

// The workout's pager end to end: the wheel, a logged set, a swipe to the next movement, a movement added by search from
// This workout, and a swipe back; the rack's load on the decimal pad and the ways it lands.
@MainActor final class GymWorkoutFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func testPagerAndAssembly() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-onboarding-appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["workout-pages"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["Workout time"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["Since last set"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["workout-set-progress"].exists)
    let ledger = app.collectionViews["workout-ledger"]
    XCTAssertTrue(ledger.waitForExistence(timeout: 5))
    XCTAssertEqual(ledger.frame.height, 132, accuracy: 1)
    let weight = app.buttons["workout-weight"]
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in weight.exists && weight.isEnabled && weight.isHittable }, object: weight)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
    weight.tap()
    app.typeLoad("105"); app.buttons["workout-log"].tap()
    app.descendants(matching: .any)["workout-current-set"].swipeLeft()
    XCTAssertTrue(app.movementHeader("Romanian Deadlift").waitForExistence(timeout: 5))
    XCTAssertEqual(app.alerts.count, 0, "A set above the plan is just logged")
    XCTAssertFalse(app.staticTexts["plan 3 × 6 · 82.5"].exists, "The planned rows already say the plan")
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
    app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
    app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText("Bench")
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
    app.buttons["gym-movement-bench-press"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.movementHeader("Bench Press").waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["workout-weight"].label, "Weight, 20 kg total")
    XCTAssertEqual(app.collectionViews["workout-ledger"].frame.height, 44, accuracy: 1)
    app.buttons["workout-log"].tap()
    let chosenSet = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(chosenSet.waitForExistence(timeout: 5))
    XCTAssertEqual(chosenSet.label, "Set 1, logged, 20 kilograms, 5 reps")
    app.descendants(matching: .any)["workout-current-set"].swipeRight()
    XCTAssertTrue(app.movementHeader("Romanian Deadlift").waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, 0)
  }

  func testMovementPickerCanCancelReopenAndCreateWithoutLosingTheRack() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-onboarding-appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-weight"].waitForExistence(timeout: 10))
    app.buttons["workout-weight"].tap(); app.typeLoad("105")
    for _ in 0..<2 {
      app.buttons["workout-assembly"].tap()
      XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
      app.buttons["workout-assembly-add"].tap()
      XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
      let selected = app.buttons["gym-movement-back-squat"]
      XCTAssertTrue(selected.waitForExistence(timeout: 5))
      XCTAssertFalse(selected.isEnabled)
      app.navigationBars.buttons["Cancel"].tap()
      XCTAssertTrue(app.searchFields.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.buttons["workout-weight"].label, "Weight, 105 kg total")
      XCTAssertFalse(app.buttons["workout-assembly-add"].exists)
    }
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
    app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.buttons["gym-new-movement"].waitForExistence(timeout: 5))
    app.buttons["gym-new-movement"].tap()
    let name = app.textFields["gym-movement-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5)); name.tap(); name.typeText("Incline press UI")
    app.buttons["gym-movement-create-commit"].tap()
    XCTAssertTrue(app.movementHeader("Incline press UI").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-log"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["gym-movement-creation"].exists)
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, 0)
    app.descendants(matching: .any)["workout-current-set"].swipeRight()
    XCTAssertTrue(app.movementHeader("Romanian Deadlift").waitForExistence(timeout: 5))
    app.descendants(matching: .any)["workout-current-set"].swipeRight()
    XCTAssertTrue(app.movementHeader("Back Squat").waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["workout-weight"].label, "Weight, 105 kg total")
  }

  // A search with no match offers Create “name” from the movement menu's Add movement, and Create movement opens over
  // the workout with that name; Add puts the new movement on the rack.
  func testCreateFromASearchOpensWithTheSearchedName() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-onboarding-appearance", "dark"]
    app.launch()
    let menu = app.buttons["workout-movement-menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 10)); menu.tap()
    XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 5)); app.buttons["Add movement"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
    app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText("Zercher squat")
    let create = app.buttons["gym-create-movement"]
    XCTAssertTrue(create.waitForExistence(timeout: 5)); create.tap()
    let name = app.textFields["gym-movement-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    XCTAssertEqual(name.value as? String, "Zercher squat")
    app.buttons["gym-movement-create-commit"].tap()
    XCTAssertTrue(app.movementHeader("Zercher squat").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-log"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["gym-movement-creation"].exists)
  }

  func testReceiptOptionsKeepsMinimumNativeTouchTarget() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-onboarding-appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 10))
    app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.staticTexts["Ended early."].waitForExistence(timeout: 10))
    let menu = app.buttons["workout-receipt-options"]
    XCTAssertTrue(menu.exists)
    for (edge, offset) in [
      ("top", CGVector(dx: 0, dy: -21.5)),
      ("bottom", CGVector(dx: 0, dy: 21.5)),
      ("leading", CGVector(dx: -21.5, dy: 0)),
      ("trailing", CGVector(dx: 21.5, dy: 0)),
    ] {
      XCTContext.runActivity(named: "Native options target: \(edge) edge of 44-point area") { _ in
        menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(offset).tap()
        let discard = app.buttons["Discard workout"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(discard.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ended early."].exists)
      }
    }
  }

  func testReceiptMenuPreservesNormalEarlyAndFirstReceipts() {
    for (board, extraSets, title, keep) in [
      ("workout-planned", 2, "Well done.", false),
      ("workout-planned", 0, "Ended early.", false),
      ("workout-planned-first", 2, "Well done.", true),
    ] {
      let app = XCUIApplication()
      app.launchArguments = ["-model-server", "-board", board, "-onboarding-appearance", keep ? "light" : "dark"]
      app.launch()
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
      for _ in 0..<extraSets { app.buttons["workout-log"].tap() }
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10))
      let share = app.buttons["workout-share-coach"], done = app.buttons["workout-done"]
      XCTAssertEqual(share.label, "👑 Share with Coach")
      XCTAssertEqual(share.frame.height, 52, accuracy: 1)
      XCTAssertEqual(done.frame.height, 52, accuracy: 1)
      XCTAssertEqual(done.frame.minY - share.frame.maxY, 12, accuracy: 1)
      XCTAssertEqual(share.frame.width, app.frame.width - 32, accuracy: 1)
      XCTAssertEqual(app.buttons["workout-keep"].exists, keep)
      let menu = app.buttons["workout-receipt-options"]
      XCTAssertTrue(menu.exists); XCTAssertGreaterThanOrEqual(menu.frame.height, 43.99)
      XCTAssertLessThan(menu.frame.maxY, share.frame.minY)
      XCTAssertFalse(app.buttons["Discard workout"].exists)
      menu.tap()
      XCTAssertTrue(app.buttons["Discard workout"].waitForExistence(timeout: 5))
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      XCTAssertTrue(app.buttons["Discard workout"].waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts[title].exists)
      menu.tap()
      XCTAssertTrue(app.buttons["Discard workout"].waitForExistence(timeout: 5)); app.buttons["Discard workout"].tap()
      let question = app.alerts["Discard this workout?"]
      XCTAssertTrue(question.waitForExistence(timeout: 5))
      XCTAssertTrue(question.staticTexts["This deletes the workout and its \(extraSets + 2) sets. You can’t undo this."].exists)
      question.buttons["Cancel"].tap()
      XCTAssertTrue(question.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts[title].exists)
      XCTAssertEqual(app.buttons["workout-keep"].exists, keep)
      done.tap()
      XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
      app.terminate()
    }
  }

  // This workout's plan end to end (Gym · iOS 03.26–03.32): Pull-up's menu opens Edit sets, its first set takes 12.5 kg and
  // the ledger shows it; Face Pull joins from the menu and takes two sets of 15 × 15; a logged movement's menu holds no plan
  // item; the receipt lists both changes and its switch saves them to Upper A.
  func testPlanEditsFromTheMenuReachTheLedgerTheReceiptAndTheRoutine() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-inflight", "-onboarding-appearance", "dark"]
    app.launch()
    let menu = app.buttons["workout-movement-menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 60) && menu.waitForValue("Pull-up"))
    XCTAssertEqual(menu.label, "Movement options")
    menu.tap()
    XCTAssertTrue(app.buttons["Edit sets"].waitForExistence(timeout: 5) && app.buttons["Swap movement"].exists)
    app.buttons["Edit sets"].tap()
    XCTAssertTrue(app.staticTexts["Pull-up · this workout"].waitForExistence(timeout: 5))
    app.buttons["edit-sets-set-1"].tap()
    app.typeLoad("12.5", into: "edit-sets-load")
    app.buttons["edit-sets-save"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["workout-current-set"].waitForLabel("Set 1, current, target 12.5 kilograms, 8 reps"))

    menu.tap()
    XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 5)); app.buttons["Add movement"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
    app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText("Face")
    XCTAssertTrue(app.buttons["gym-movement-face-pull"].waitForExistence(timeout: 5)); app.buttons["gym-movement-face-pull"].tap()
    XCTAssertTrue(menu.waitForValue("Face Pull"))
    let open = app.descendants(matching: .any)["workout-current-set"]
    XCTAssertTrue(open.waitForLabel("Set 1, current, open target")); open.tap()
    XCTAssertTrue(app.staticTexts["Face Pull · this workout"].waitForExistence(timeout: 5))
    app.buttons["edit-sets-add"].tap()
    app.typeLoad("15", into: "edit-sets-load")
    app.pickerWheels.element(boundBy: 0).adjust(toPickerWheelValue: "15 reps")
    app.buttons["edit-sets-add"].tap()
    app.buttons["edit-sets-save"].tap()
    XCTAssertTrue(open.waitForLabel("Set 1, current, target 15 kilograms, 15 reps"))

    for _ in 0..<4 where menu.value as? String != "Dumbbell Bench Press" {
      app.descendants(matching: .any)["workout-current-set"].swipeRight(); _ = menu.waitForValue("Dumbbell Bench Press", timeout: 2)
    }
    XCTAssertTrue(menu.waitForValue("Dumbbell Bench Press")); menu.tap()
    XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Edit sets"].exists || app.buttons["Swap movement"].exists, "A logged movement keeps its plan")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertTrue(app.buttons["Add movement"].waitForNonExistence(timeout: 5))

    app.buttons["workout-finish"].tap()
    let changes = app.descendants(matching: .any)["workout-receipt-plan-changes"]
    XCTAssertTrue(changes.waitForExistence(timeout: 15))
    XCTAssertEqual(changes.label, "Plan changes, 2 changes")
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Added, Face Pull, Sets, 2, Reps, 15, Load, 15 kg")).firstMatch.exists)
    let save = app.switches["workout-receipt-save-plan"]
    XCTAssertTrue(save.waitForExistence(timeout: 5)); XCTAssertEqual(save.value as? String, "0")
    save.switches.firstMatch.tap()
    XCTAssertTrue(save.waitForValue("1"))
    app.buttons["workout-done"].tap()
    XCTAssertTrue(app.buttons["workout-done"].waitForNonExistence(timeout: 10))

    back(app)
    let routines = app.tabBars.buttons["Routines"]
    XCTAssertTrue(routines.waitForExistence(timeout: 10)); routines.tap()
    let routine = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "routine-", "Upper A,")).firstMatch
    XCTAssertTrue(routine.waitForExistence(timeout: 10)); routine.tap()
    XCTAssertTrue(app.descendants(matching: .any)["routine-detail-movement-face-pull"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@",
                                                                       "routine-detail-movement-pull-up", "12.5")).firstMatch.exists)
  }

  // Edit sets over Pull-up (03.29), opened from its menu; `-log-set-on-signal` lets the test land a set on it from outside.
  func openEditSets(signal: Bool = false) -> (XCUIApplication, current: XCUIElement) {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-inflight", "-onboarding-appearance", "dark"] + (signal ? ["-log-set-on-signal"] : [])
    app.launch()
    let menu = app.buttons["workout-movement-menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 60) && menu.waitForValue("Pull-up"))
    let current = app.descendants(matching: .any)["workout-current-set"]
    XCTAssertTrue(current.waitForExistence(timeout: 10))
    menu.tap()
    XCTAssertTrue(app.buttons["Edit sets"].waitForExistence(timeout: 5)); app.buttons["Edit sets"].tap()
    XCTAssertTrue(app.staticTexts["Pull-up · this workout"].waitForExistence(timeout: 5))
    return (app, current)
  }

  // A set that lands on the movement while its sheet is open closes the sheet, the plan as it was, and the room says why.
  func testASetLandingOnTheMovementClosesEditSetsAndChangesNothing() {
    let (app, current) = openEditSets(signal: true)
    let planned = current.label
    app.buttons["edit-sets-set-1"].tap()
    app.typeLoad("12.5", into: "edit-sets-load")
    CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName("works.windmill.fixture.log-set" as CFString), nil, nil, true)
    XCTAssertTrue(app.staticTexts["Pull-up · this workout"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.otherElements["workout-refusal"].staticTexts["Pull-up has a logged set now. Nothing changed."].waitForExistence(timeout: 5))
    XCTAssertTrue(current.waitForLabel(planned.replacingOccurrences(of: "Set 1,", with: "Set 2,")))
    app.buttons["workout-movement-menu"].tap()
    XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Edit sets"].exists, "A logged movement keeps its plan")
  }

  // Cancel leaves the plan as it was, whatever the sheet drafted.
  func testCancelLeavesThePlanAsItWas() {
    let (app, current) = openEditSets()
    let planned = current.label
    app.buttons["edit-sets-set-1"].tap()
    app.typeLoad("12.5", into: "edit-sets-load")
    app.buttons["edit-sets-add"].tap()
    app.buttons["edit-sets-cancel"].tap()
    XCTAssertTrue(app.staticTexts["Pull-up · this workout"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(current.waitForLabel(planned))
    app.buttons["workout-movement-menu"].tap()
    XCTAssertTrue(app.buttons["Edit sets"].waitForExistence(timeout: 5)); app.buttons["Edit sets"].tap()
    XCTAssertTrue(app.buttons["edit-sets-set-3"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["edit-sets-set-4"].exists)
    XCTAssertEqual(app.buttons["edit-sets-set-1"].label, planned.replacingOccurrences(of: ", current, target ", with: ", planned, "))
  }

  // ✓ tapped twice saves the sheet once: one set added, no refusal said.
  func testSavingTwiceSavesOnce() {
    let (app, current) = openEditSets()
    app.buttons["edit-sets-add"].tap()
    app.typeLoad("12.5", into: "edit-sets-load")
    app.buttons["edit-sets-save"].doubleTap()
    XCTAssertTrue(app.staticTexts["Pull-up · this workout"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(current.waitForExistence(timeout: 5))
    XCTAssertFalse(app.otherElements["workout-refusal"].exists)
    app.buttons["workout-movement-menu"].tap()
    XCTAssertTrue(app.buttons["Edit sets"].waitForExistence(timeout: 5)); app.buttons["Edit sets"].tap()
    XCTAssertTrue(app.buttons["edit-sets-set-4"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["edit-sets-set-5"].exists)
    XCTAssertEqual(app.buttons["edit-sets-set-4"].label, "Set 4, planned, 12.5 kilograms, 8 reps")
  }

  func back(_ app: XCUIApplication) {
    let button = app.navigationBars.firstMatch.buttons.element(boundBy: 0)
    XCTAssertTrue(button.wait(for: \.isHittable, toEqual: true, timeout: 10)); button.tap()
  }

  func testReceiptDiscardConfirmationReturnsToLog() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-onboarding-appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 10)); app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.buttons["workout-receipt-options"].waitForExistence(timeout: 10)); app.buttons["workout-receipt-options"].tap()
    XCTAssertTrue(app.buttons["Discard workout"].waitForExistence(timeout: 5)); app.buttons["Discard workout"].tap()
    let question = app.alerts["Discard this workout?"]
    XCTAssertTrue(question.waitForExistence(timeout: 5)); question.buttons["Discard"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["workout-done"].exists)
  }

  func launchTypingTheRack() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-onboarding-appearance", "dark"]
    app.launch()
    let weight = app.buttons["workout-weight"]
    XCTAssertTrue(weight.waitForExistence(timeout: 15))
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in weight.exists && weight.isEnabled && weight.isHittable }, object: weight)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
    XCTAssertEqual(weight.label, "Weight, 100 kg total")
    weight.tap()
    XCTAssertTrue(app.textFields["workout-load"].waitForValue("100"))
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    return app
  }

  // The rack's numeral opens on the pad with its text selected, so the first key replaces it; ✓ on the numeral's line and a
  // tap outside each land the load and bring back the ladder, reps and Log set.
  func testTheRackLoadOpensSelectedAndLandsByCheckOrATapOutside() {
    let app = launchTypingTheRack()
    XCTAssertTrue(app.buttons["workout-load-done"].exists)
    XCTAssertFalse(app.buttons["workout-load-sign"].exists, "A barbell has no sign to flip")
    XCTAssertFalse(app.buttons["workout-log"].exists)
    let field = app.textFields["workout-load"]
    field.typeText("105")
    XCTAssertTrue(field.waitForValue("105"))
    app.buttons["workout-load-done"].tap()
    XCTAssertTrue(app.buttons["workout-weight"].waitForLabel("Weight, 105 kg total"))
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    app.buttons["workout-weight"].tap()
    XCTAssertTrue(field.waitForValue("105"))
    field.typeText("110")
    XCTAssertTrue(field.waitForValue("110"))
    app.descendants(matching: .any)["Workout time"].firstMatch.tap()
    XCTAssertTrue(app.buttons["workout-weight"].waitForLabel("Weight, 110 kg total"))
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
  }

  // A load typed and not yet landed lands on its own movement when the lifter moves on by This workout, and the next
  // movement opens on its own rack with Log set; while a load is typed the page dots are outside the field, so a tap there
  // lands it where it is.
  func testATypedLoadLandsOnItsMovementWhenTheLifterMovesOn() {
    let app = launchTypingTheRack()
    app.textFields["workout-load"].typeText("123")
    app.buttons["workout-assembly"].tap()
    let deadlift = app.buttons["workout-movement-romanian-deadlift"]
    XCTAssertTrue(deadlift.waitForExistence(timeout: 5)); deadlift.tap()
    XCTAssertTrue(app.movementHeader("Romanian Deadlift").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.textFields["workout-load"].exists)
    let deadliftLoad = app.buttons["workout-weight"].label
    XCTAssertNotEqual(deadliftLoad, "Weight, 123 kg total")
    app.buttons["workout-weight"].tap()
    XCTAssertTrue(app.textFields["workout-load"].waitForExistence(timeout: 5))
    app.textFields["workout-load"].typeText("77")
    let dots = app.pageIndicators.firstMatch
    XCTAssertTrue(dots.exists)
    dots.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)).tap()
    XCTAssertTrue(app.buttons["workout-weight"].waitForLabel("Weight, 77 kg total"))
    XCTAssertTrue(app.movementHeader("Romanian Deadlift").exists && app.buttons["workout-log"].exists)
    app.descendants(matching: .any)["workout-current-set"].swipeRight()
    XCTAssertTrue(app.movementHeader("Back Squat").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-weight"].waitForLabel("Weight, 123 kg total"))
    XCTAssertTrue(app.buttons["workout-log"].exists)
  }

  // Coach over a typed load closes back to the rack exactly as it was, the load still in the field, and ✓ lands it.
  func testCoachOverATypedLoadClosesBackToTheFieldAsItWas() {
    let app = launchTypingTheRack()
    let field = app.textFields["workout-load"]
    field.typeText("123")
    app.buttons["workout-coach"].tap()
    XCTAssertTrue(app.buttons["coach-close"].waitForExistence(timeout: 10)); app.buttons["coach-close"].tap()
    XCTAssertTrue(app.buttons["coach-close"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(field.waitForValue("123"))
    XCTAssertTrue(app.buttons["workout-load-done"].exists)
    app.buttons["workout-load-done"].tap()
    XCTAssertTrue(app.buttons["workout-weight"].waitForLabel("Weight, 123 kg total"))
    XCTAssertTrue(app.buttons["workout-log"].exists)
  }

  // Fix set's load emptied and saved keeps the set's load: only a readable value replaces it.
  func testFixSetSavesTheOpeningLoadWhenTheFieldIsEmptied() {
    let app = launchTypingTheRack()
    app.buttons["workout-load-done"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5)); app.buttons["workout-log"].tap()
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "workout-set-", "Set 2,")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5))
    XCTAssertEqual(set.label, "Set 2, logged, 100 kilograms, 5 reps")
    set.tap()
    let field = app.textFields["workout-fix-load"]
    XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    field.typeText("1")
    XCTAssertTrue(field.waitForValue("1"))
    field.typeText(XCUIKeyboardKey.delete.rawValue)
    XCTAssertTrue(field.waitForValue("Load"), "An empty field reads its placeholder")
    app.buttons["workout-fix-save"].tap()
    XCTAssertTrue(field.waitForNonExistence(timeout: 5))
    XCTAssertTrue(set.waitForLabel("Set 2, logged, 100 kilograms, 5 reps"))
  }

  // Fix set's load opens selected each time it is tapped into, so the first key replaces the load it shows.
  func testFixSetLoadOpensSelectedSoTheFirstKeyReplacesIt() {
    let app = launchTypingTheRack()
    app.buttons["workout-load-done"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5)); app.buttons["workout-log"].tap()
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "workout-set-", "Set 2,")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    let field = app.textFields["workout-fix-load"]
    XCTAssertTrue(field.waitForExistence(timeout: 5) && field.waitForValue("100")); field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    field.typeText("95")
    XCTAssertTrue(field.waitForValue("95"))
    let note = app.descendants(matching: .any)["workout-fix-note"]
    XCTAssertTrue(note.waitForExistence(timeout: 5)); note.tap()
    XCTAssertTrue(field.waitForValue("95"))
    field.tap()
    field.typeText("90")
    XCTAssertTrue(field.waitForValue("90"))
    app.buttons["workout-fix-save"].tap()
    XCTAssertTrue(field.waitForNonExistence(timeout: 5))
    XCTAssertTrue(set.waitForLabel("Set 2, logged, 90 kilograms, 5 reps"))
  }
}
