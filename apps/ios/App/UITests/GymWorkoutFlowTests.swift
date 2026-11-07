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
    let load = app.textFields["workout-load"]
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in load.exists && load.isEnabled && load.isHittable }, object: load)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
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
    XCTAssertEqual(app.textFields["workout-load"].label, "Weight, 20 kg total")
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
    XCTAssertTrue(app.textFields["workout-load"].waitForExistence(timeout: 10))
    app.typeLoad("105")
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
      XCTAssertEqual(app.textFields["workout-load"].label, "Weight, 105 kg total")
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
    XCTAssertEqual(app.textFields["workout-load"].label, "Weight, 105 kg total")
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
    XCTAssertTrue(app.descendants(matching: .any)["workout-current-set"].waitForLabel("Set 1, current, 12.5 kilograms, 8 reps"))

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
    XCTAssertTrue(open.waitForLabel("Set 1, current, 15 kilograms, 15 reps"))

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
    XCTAssertEqual(app.buttons["edit-sets-set-1"].label, planned.replacingOccurrences(of: ", current, ", with: ", planned, "))
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
    let load = app.textFields["workout-load"]
    XCTAssertTrue(load.waitForHittable(timeout: 25))
    XCTAssertEqual(load.label, "Weight, 100 kg total")
    load.tap()
    XCTAssertTrue(load.waitForValue("100"))
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    return app
  }

  // The rack's load is its field: a tap into it raises the pad with the text selected, so the first key replaces it, and
  // the rack rides up as one block, the ladder, reps and Log set where they were and the page keeping its head; no keyboard
  // row appears. Log set logs what the field shows, drops the keyboard and leaves the rack on the plan's next set, a
  // heavier triple here, not on the field's text; a tap outside lands the load where it is.
  func testTheRackLoadOpensSelectedAndLandsByLogSetOrATapOutside() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-planned-varied", "-onboarding-appearance", "dark"]
    app.launch()
    let load = app.textFields["workout-load"], log = app.buttons["workout-log"]
    XCTAssertTrue(load.waitForExistence(timeout: 15) && log.waitForExistence(timeout: 5))
    let rackFrames = { [load, app.buttons["workout-weight-step-0"], app.buttons["workout-reps"], log].map(\.frame) }
    let rack = rackFrames()
    let head = [app.buttons["workout-movement-menu"], app.pageIndicators.firstMatch].map(\.frame)
    load.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(load.waitForValue("100"))
    XCTAssertFalse(app.buttons["workout-load-done"].exists, "No keyboard row")
    XCTAssertFalse(app.buttons["workout-load-sign"].exists, "A barbell has no sign to flip")
    XCTAssertEqual([app.buttons["workout-movement-menu"], app.pageIndicators.firstMatch].map(\.frame), head, "The page keeps its head")
    let raised = rackFrames()
    XCTAssertTrue(log.isHittable && app.buttons["workout-weight-step-0"].isHittable, "The rack stays above the keyboard")
    XCTAssertEqual(Set(zip(rack, raised).map { ($0.minY - $1.minY).rounded() }).count, 1, "The rack rises as one: \(rack) \(raised)")
    XCTAssertEqual(zip(rack, raised).map { $0.size == $1.size }, [true, true, true, true], "Nothing in the rack resizes: \(rack) \(raised)")
    load.typeText("105")
    XCTAssertTrue(load.waitForValue("105") && load.waitForLabel("Weight, 105 kg total"))
    log.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "Log set drops the keyboard")
    let logged = app.loggedSet(3)
    XCTAssertTrue(logged.waitForExistence(timeout: 5))
    XCTAssertEqual(logged.label, "Set 3, logged, 105 kilograms, 5 reps")
    XCTAssertTrue(load.waitForLabel("Weight, 120 kg total"), "The plan's next set takes the rack, not the field's text")
    XCTAssertEqual(app.buttons["workout-reps"].label, "3 reps")
    XCTAssertEqual(rackFrames(), rack, "The rack settles where it was")
    load.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    load.typeText("110")
    XCTAssertTrue(load.waitForValue("110"))
    app.landTypedLoad()
    XCTAssertTrue(load.waitForLabel("Weight, 110 kg total"))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    app.buttons["workout-weight-step-3"].tap()
    XCTAssertTrue(load.waitForValue("120") && load.waitForLabel("Weight, 120 kg total"))
  }

  // Bodyweight and Other lead the ladder with ±, at rest and with the pad up alike; it flips the load the field shows and
  // the unit stays. A barbell's ladder has four keys.
  func testTheSignKeyLeadsTheLadderForASignedLoadAndFlipsIt() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-upper-other", "-onboarding-appearance", "dark"]
    app.launch()
    let load = app.textFields["workout-load"], sign = app.buttons["workout-load-sign"]
    XCTAssertTrue(load.waitForLabel("Weight, −5 kg", timeout: 15))
    XCTAssertTrue(sign.waitForExistence(timeout: 5))
    XCTAssertLessThan(sign.frame.maxX, app.buttons["workout-weight-step-0"].frame.minX, "± leads the ladder")
    XCTAssertEqual(sign.frame.minY, app.buttons["workout-weight-step-0"].frame.minY, accuracy: 1)
    sign.tap()
    XCTAssertTrue(load.waitForLabel("Weight, 5 kg") && load.waitForValue("5"))
    load.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(sign.isHittable)
    load.typeText("7")
    XCTAssertTrue(load.waitForValue("7"))
    sign.tap()
    XCTAssertTrue(load.waitForValue("−7") && load.waitForLabel("Weight, −7 kg"))
    app.buttons["workout-log"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    let logged = app.loggedSet(3)
    XCTAssertTrue(logged.waitForExistence(timeout: 5))
    XCTAssertEqual(logged.label, "Set 3, logged, −7 kilograms, 7 reps")
  }

  // A typed load is the rack's as it is typed: the ladder steps it in the field, Log set logs it, and moving on by This
  // workout lands it on its movement and opens the next on its own rack with the keyboard down; while a load is typed the
  // page dots are outside the field, so a tap there lands it where it is.
  func testATypedLoadIsTheRacksAndLandsOnItsMovementWhenTheLifterMovesOn() {
    let app = launchTypingTheRack()
    let load = app.textFields["workout-load"]
    load.typeText("120")
    XCTAssertTrue(load.waitForValue("120"))
    app.buttons["workout-weight-step-3"].tap()
    XCTAssertTrue(load.waitForValue("130"), "The ladder steps the typed load")
    XCTAssertTrue(load.waitForLabel("Weight, 130 kg total"))
    XCTAssertEqual(app.buttons["workout-log"].label, "Log set, 130 kilograms, 5 reps")
    app.buttons["workout-log"].tap()
    let logged = app.loggedSet(3)
    XCTAssertTrue(logged.waitForExistence(timeout: 5))
    XCTAssertEqual(logged.label, "Set 3, logged, 130 kilograms, 5 reps")
    app.buttons["workout-assembly"].tap()
    let deadlift = app.buttons["workout-movement-romanian-deadlift"]
    XCTAssertTrue(deadlift.waitForExistence(timeout: 5)); deadlift.tap()
    XCTAssertTrue(app.movementHeader("Romanian Deadlift").waitForExistence(timeout: 5))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    XCTAssertNotEqual(load.label, "Weight, 130 kg total")
    load.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    load.typeText("77")
    let dots = app.pageIndicators.firstMatch
    XCTAssertTrue(dots.exists)
    dots.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)).tap()
    XCTAssertTrue(load.waitForLabel("Weight, 77 kg total"))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.movementHeader("Romanian Deadlift").exists && app.buttons["workout-log"].exists)
    RunLoop.current.run(until: Date().addingTimeInterval(0.6))
    app.descendants(matching: .any)["workout-current-set"].swipeRight()
    XCTAssertTrue(app.movementHeader("Back Squat").waitForExistence(timeout: 5))
    XCTAssertTrue(load.waitForLabel("Weight, 130 kg total"))
  }

  // Coach over a typed load closes back to the rack exactly as it was, the load in the field.
  func testCoachOverATypedLoadClosesBackToTheFieldAsItWas() {
    let app = launchTypingTheRack()
    let load = app.textFields["workout-load"]
    load.typeText("123")
    XCTAssertTrue(load.waitForValue("123"))
    app.buttons["workout-coach"].tap()
    XCTAssertTrue(app.buttons["coach-close"].waitForExistence(timeout: 10)); app.buttons["coach-close"].tap()
    XCTAssertTrue(app.buttons["coach-close"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(load.waitForValue("123") && load.waitForLabel("Weight, 123 kg total"))
    XCTAssertTrue(app.buttons["workout-log"].isHittable)
  }

  // Fix set's load emptied and saved keeps the set's load: only a readable value replaces it.
  func testFixSetSavesTheOpeningLoadWhenTheFieldIsEmptied() {
    let app = launchTypingTheRack()
    app.buttons["workout-log"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    let set = app.loggedSet(2)
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
    app.buttons["workout-log"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    let set = app.loggedSet(2)
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
