import XCTest
import Vision

@MainActor final class GymWorkoutFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func launch(_ board: String = "workout-planned", appearance: String = "dark", arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board, "-onboarding-appearance", appearance] + arguments
    app.launch()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10),
                  "BoardFixture must call WorkoutFixture.prepare before the journal fixture. The shared fixture hook is outside Workout territory.")
    return app
  }

  func capture(_ app: XCUIApplication, _ name: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    if let path = ProcessInfo.processInfo.environment["WM_GYM_FEEDBACK_SHOTS"] {
      let directory = URL(fileURLWithPath: path)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: directory.appending(path: name + ".png"))
    }
  }

  func testRepeatedStepEdgesUpdateAndLogVisibleValues() throws {
    let app = launch(appearance: "light")
    let weight = app.buttons["workout-weight"], reps = app.buttons["workout-reps"]
    for (id, expected) in [(0, "90"), (0, "80"), (0, "70"), (1, "67.5"), (1, "65"), (2, "67.5")] {
      let step = app.buttons["workout-weight-step-\(id)"]
      XCTAssertGreaterThanOrEqual(step.frame.width, 44); XCTAssertGreaterThanOrEqual(step.frame.height, 44)
      step.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.2)).tap()
      XCTAssertEqual(weight.label, "Weight, \(expected) kg total")
    }
    for (id, expected) in [("minus", "4 reps"), ("minus", "3 reps"), ("plus", "4 reps")] {
      let step = app.buttons["workout-reps-" + id]
      XCTAssertGreaterThanOrEqual(step.frame.width, 44); XCTAssertGreaterThanOrEqual(step.frame.height, 44)
      step.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.8)).tap()
      XCTAssertEqual(reps.label, expected)
    }
    try capture(app, "workout-steps-light")
    app.buttons["workout-log"].tap()
    let logged = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "workout-set-", "Set 3, logged, 67.5 kilograms, 4 reps")).firstMatch
    XCTAssertTrue(logged.waitForExistence(timeout: 5))
    logged.tap()
    XCTAssertTrue(app.buttons["workout-fix-weight"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["workout-fix-weight"].label, "Weight, 67.5 kg total")
  }

  func testSeedRenameAndDumbbellCountKeepHistoryTogether() throws {
    let app = launch(appearance: "light")
    app.buttons["workout-assembly"].tap()
    let movement = app.buttons["Back Squat, 2 of 4 sets"]
    XCTAssertTrue(movement.waitForExistence(timeout: 5)); movement.press(forDuration: 1)
    app.buttons["Edit exercise"].tap()
    let name = app.textFields["gym-rename-movement-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5)); name.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Back Squat".count) + "Dumbbell squat")
    let equipment = app.buttons["gym-rename-movement-equipment"]
    for _ in 0..<3 where !equipment.isHittable { app.swipeUp() }
    XCTAssertTrue(equipment.isHittable); equipment.tap()
    app.buttons["Dumbbells"].tap()
    let count = app.segmentedControls["gym-rename-movement-equipment-count"]
    for _ in 0..<3 where !count.buttons["One"].isHittable { app.swipeUp() }
    XCTAssertTrue(count.buttons["Two"].isSelected)
    count.buttons["One"].tap(); XCTAssertTrue(count.buttons["One"].isSelected)
    count.buttons["Two"].tap(); XCTAssertTrue(count.buttons["Two"].isSelected)
    count.buttons["One"].tap(); XCTAssertTrue(count.buttons["One"].isSelected)
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    XCTAssertLessThanOrEqual(count.frame.maxY, app.keyboards.firstMatch.frame.minY)
    try capture(app, "dumbbell-editor-keyboard-light")
    app.buttons["gym-rename-movement-commit"].tap()
    XCTAssertTrue(name.waitForNonExistence(timeout: 5))
    app.navigationBars["This workout"].buttons["Close"].tap()
    XCTAssertEqual(app.buttons["workout-weight"].label, "Weight, 100 kg")
    XCTAssertTrue(app.staticTexts["One dumbbell · 100 kg total"].exists)
    XCTAssertTrue(app.buttons["Dumbbell squat"].exists)
    try capture(app, "dumbbell-rack-light")
    app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.buttons["workout-done"].waitForExistence(timeout: 10)); app.buttons["workout-done"].tap()
    let history = app.buttons["gym-session-movement"].firstMatch
    XCTAssertTrue(history.waitForExistence(timeout: 5))
    XCTAssertTrue(history.label.hasPrefix("Dumbbell squat"), history.label)
    let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-finished-set-"))
    XCTAssertEqual(rows.allElementsBoundByIndex.map(\.label), ["1 · 100 × 5", "2 · 100 × 5"])
    try capture(app, "seed-renamed-history-light")
    history.tap()
    XCTAssertTrue(app.navigationBars.staticTexts["Dumbbell squat"].waitForExistence(timeout: 5))
    app.navigationBars.buttons["More"].tap(); app.buttons["Edit exercise"].tap()
    XCTAssertTrue(app.segmentedControls["gym-rename-movement-equipment-count"].buttons["One"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.segmentedControls["gym-rename-movement-equipment-count"].buttons["One"].isSelected)
  }

  func testCurrentSetRemainsFullyVisibleAtLargestText() throws {
    let app = launch(appearance: "light", arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    let current = app.descendants(matching: .any)["workout-current-set"]
    XCTAssertTrue(current.waitForExistence(timeout: 5))
    let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      let frame = current.frame
      return frame.height >= 44 && app.frame.contains(frame) && frame.maxY <= app.buttons["workout-weight"].frame.minY
    }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 5), .completed)
    XCTAssertEqual(current.label, "Set 3, current, target 100 kilograms, 5 reps")
    try capture(app, "workout-current-set-largest-text")
  }

  func testKeypadCancelCommitAndLiveFix() {
    let app = launch()
    app.buttons["workout-weight"].tap()
    XCTAssertTrue(app.buttons["workout-key-1"].waitForExistence(timeout: 5))
    let value = app.staticTexts["workout-keypad-value"], kilograms = app.staticTexts["workout-keypad-unit"]
    XCTAssertTrue(kilograms.waitForExistence(timeout: 5)); XCTAssertEqual(kilograms.label, "kg total")
    XCTAssertTrue(kilograms.frame.minX >= value.frame.maxX && kilograms.frame.maxY <= value.frame.maxY,
                  "The unit \(kilograms.frame) stands at the numeral's baseline \(value.frame), as on the rack")
    for digit in ["±", "0", "."] {
      XCTAssertLessThanOrEqual(app.buttons["workout-key-" + digit].frame.maxY, app.buttons["workout-keypad-set"].frame.minY)
    }
    app.buttons["workout-key-1"].tap(); app.buttons["workout-key-2"].tap()
    XCTAssertEqual(app.staticTexts["workout-keypad-value"].label, "12")
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["workout-weight"].label.contains("100"))
    app.buttons["workout-weight"].tap()
    app.buttons["workout-key-1"].tap(); app.buttons["workout-key-0"].tap(); app.buttons["workout-key-5"].tap()
    app.buttons["workout-keypad-set"].tap()
    app.buttons["workout-reps"].tap()
    XCTAssertTrue(app.navigationBars["Reps"].waitForExistence(timeout: 5))
    let repsValue = app.staticTexts["workout-keypad-value"], reps = app.staticTexts["workout-keypad-unit"]
    XCTAssertTrue(reps.waitForExistence(timeout: 5)); XCTAssertEqual(reps.label, "reps")
    XCTAssertTrue(reps.frame.minX >= repsValue.frame.maxX, "The reps pad's unit \(reps.frame) stands beside \(repsValue.frame)")
    XCTAssertFalse(app.staticTexts["whole reps"].exists)
    XCTAssertFalse(app.buttons["workout-key-±"].exists || app.buttons["workout-key-."].exists, "The reps pad's sign and decimal slots are empty")
    app.navigationBars["Reps"].buttons["Cancel"].tap()
    XCTAssertTrue(app.navigationBars["Reps"].waitForNonExistence(timeout: 5))
    app.buttons["workout-log"].tap()
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    XCTAssertTrue(app.buttons["workout-fix-save"].waitForExistence(timeout: 5))
    let note = app.textFields["workout-fix-note"]
    note.tap(); note.typeText("A retained set note")
    app.buttons["workout-fix-save"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
  }

  // At the first accessibility sizes the rack reflows instead of scrolling: every control is on screen at rest, none under
  // Log set, and the keypad keeps its last row above Set.
  func testRackAndKeypadKeepEveryControlInReachAtAccessibilityText() {
    let app = launch(arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
    let log = app.buttons["workout-log"]
    XCTAssertTrue(log.wait(for: \.isHittable, toEqual: true, timeout: 5))
    let ladder = ["−10 kg total", "−2.5 kg total", "+2.5 kg total", "+10 kg total"].map { app.buttons[$0] }
    for control in ladder + [app.buttons["Fewer reps"], app.buttons["workout-reps"], app.buttons["More reps"], app.buttons["workout-weight"]] {
      XCTAssertTrue(control.exists && control.isHittable, "\(control) is out of reach at rest")
      XCTAssertTrue(app.frame.contains(control.frame), "\(control.frame) leaves the screen")
      XCTAssertFalse(control.frame.intersects(log.frame), "\(control.frame) sits under Log set \(log.frame)")
    }
    XCTAssertTrue(log.label.hasPrefix("Log set, 100 kilograms, "), log.label)
    app.buttons["workout-weight"].tap()
    let set = app.buttons["workout-keypad-set"]
    XCTAssertTrue(set.waitForExistence(timeout: 5))
    for key in ["1", "2", "3", "4", "5", "6", "7", "8", "9", "±", "0", "."] {
      let button = app.buttons["workout-key-\(key)"]
      XCTAssertTrue(button.isHittable, "Key \(key) is out of reach")
      XCTAssertLessThanOrEqual(button.frame.maxY, set.frame.minY, "Key \(key) \(button.frame) sits under Set \(set.frame)")
    }
    app.buttons["workout-key-6"].tap(); app.buttons["workout-key-0"].tap(); set.tap()
    XCTAssertTrue(app.buttons["workout-weight"].wait(for: \.label, toEqual: "Weight, 60 kg total", timeout: 5))
  }

  func testReceiptActionsRemainReachableAtAccessibilityText() {
    let app = launch(appearance: "light", arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
    app.buttons["workout-finish"].tap()
    let done = app.buttons["workout-done"], share = app.buttons["workout-share-coach"], discard = app.buttons["workout-discard-receipt"]
    XCTAssertTrue(done.waitForExistence(timeout: 10))
    XCTAssertEqual([discard.label, share.label, done.label], ["Discard", "👑 Share with Coach", "Done"])
    for button in [discard, share, done] {
      XCTAssertTrue(button.isHittable)
      XCTAssertTrue(app.frame.contains(button.frame))
      XCTAssertGreaterThanOrEqual(button.frame.height, 44)
    }
    XCTAssertLessThanOrEqual(discard.frame.maxY, share.frame.minY)
    XCTAssertLessThanOrEqual(share.frame.maxY, done.frame.minY)
    XCTAssertFalse(app.staticTexts["Sends Coach one line — Check my last workout."].exists)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "receipt-actions-ax3"; attachment.lifetime = .keepAlways; add(attachment)
  }

  func testReceiptDiscardCanCancelThenRemoveWorkout() {
    let app = launch()
    app.buttons["workout-finish"].tap()
    let discard = app.buttons["workout-discard-receipt"]
    XCTAssertTrue(discard.waitForExistence(timeout: 10)); discard.tap()
    let confirmation = app.buttons["Discard workout"]
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    app.cancelConfirmation()
    XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
    XCTAssertTrue(discard.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-done"].exists)
    discard.tap()
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5)); confirmation.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.descendants(matching: .any)["gym-session-detail"].exists)
    XCTAssertFalse(app.buttons["gym-log-undo"].exists)
  }

  // Fix set commits from its bar, so the destructive row and its caption stand clear at rest.
  func testFixSetSavesFromItsBarAndLeavesDeleteAndItsCaptionClear() {
    let app = launch(appearance: "light")
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    let save = app.buttons["workout-fix-save"]
    XCTAssertTrue(save.waitForExistence(timeout: 5))
    XCTAssertEqual(save.label, "Save")
    XCTAssertLessThanOrEqual(save.frame.maxY, app.navigationBars["Fix set"].frame.maxY)
    let delete = app.buttons["workout-fix-delete"], caption = app.staticTexts["Lower A keeps its planned targets."]
    XCTAssertTrue(delete.isHittable && caption.exists)
    XCTAssertTrue(app.frame.contains(caption.frame), "The caption \(caption.frame) is below the sheet at rest")
  }

  func testCompactSetsExposeLoggedCurrentAndPlannedValues() {
    let app = launch(appearance: "light")
    XCTAssertTrue(app.descendants(matching: .any)["workout-set-progress"].waitForValue("2 of 4 sets"))
    let rows = app.workoutLedgerRows()
    let kind = { (row: XCUIElementSnapshot) in row.elementType == .button ? "button" : row.elementType == .staticText ? "text" : "type \(row.elementType.rawValue)" }
    XCTAssertEqual(rows.map { "\(kind($0))\($0.isSelected ? " selected" : ""): \($0.label)" }, [
      "button: Set 1, logged, 100 kilograms, 5 reps", "button: Set 2, logged, 100 kilograms, 5 reps",
      "text: Set 3, current, target 100 kilograms, 5 reps", "text: Set 4, planned, 100 kilograms, 5 reps",
    ])
    for row in rows.filter({ $0.elementType == .button }) { XCTAssertGreaterThanOrEqual(row.frame.height, 44) }
    XCTAssertTrue(app.descendants(matching: .any)["workout-set-progress"].exists)
  }

  // The receipt opens over session detail at full height only. Done shows the detail, which numbers a set the way the
  // ledger did: from one, each against the plan.
  func testSessionDetailNumbersSetsAsTheLedgerDid() {
    let app = launch(appearance: "light")
    XCTAssertTrue(app.descendants(matching: .any)["workout-set-progress"].waitForValue("2 of 4 sets"))
    let ledger = app.workoutLedgerRows().filter { $0.identifier.hasPrefix("workout-set-") }
    XCTAssertEqual(ledger.map { $0.label.components(separatedBy: ",").first }, ["Set 1", "Set 2"])
    app.buttons["workout-finish"].tap()
    let done = app.buttons["workout-done"]
    XCTAssertTrue(done.waitForExistence(timeout: 10))
    XCTAssertLessThan(app.navigationBars.firstMatch.frame.minY, app.frame.height / 4)
    done.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
    let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-finished-set-"))
    XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5))
    XCTAssertEqual((0..<rows.count).map { rows.element(boundBy: $0).label }, ["1 · 100 × 5", "2 · 100 × 5"])
  }

  func testPagerAssemblyAndHeavierBoundary() {
    let app = launch()
    XCTAssertTrue(app.descendants(matching: .any)["workout-pages"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["workout-next"].exists)
    XCTAssertFalse(app.buttons["workout-previous"].exists)
    XCTAssertFalse(app.staticTexts["Movement 1 of 2"].exists)
    for control in [app.buttons["Fewer reps"], app.buttons["More reps"], app.buttons["−2.5 kg total"], app.buttons["+2.5 kg total"]] {
      XCTAssertGreaterThanOrEqual(control.frame.width, 44)
      XCTAssertGreaterThanOrEqual(control.frame.height, 44)
    }
    XCTAssertLessThanOrEqual(app.buttons["workout-log"].frame.height, 64)
    XCTAssertTrue(app.descendants(matching: .any)["Workout time"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["Since last set"].exists)
    let weight = app.buttons["workout-weight"]
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in weight.exists && weight.isEnabled && weight.isHittable }, object: weight)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
    weight.tap()
    XCTAssertTrue(app.buttons["workout-key-1"].waitForExistence(timeout: 5))
    for key in ["1", "0", "5"] { app.buttons["workout-key-\(key)"].tap() }
    app.buttons["workout-keypad-set"].tap(); app.buttons["workout-log"].tap()
    app.descendants(matching: .any)["workout-current-set"].swipeLeft()
    // Leaving the movement raised the question, so nothing on screen anchors it: it is an alert.
    let heavier = app.alerts["Save 105 to Lower A?"]
    XCTAssertTrue(heavier.waitForExistence(timeout: 5))
    XCTAssertTrue(heavier.staticTexts["Today’s workout already has it."].exists)
    XCTAssertEqual(Set(heavier.buttons.allElementsBoundByIndex.map(\.label)), ["Save to Lower A", "Today only"])
    XCTAssertFalse(app.navigationBars["Heavier than the plan"].exists)
    heavier.buttons["Today only"].firstMatch.tap()
    XCTAssertTrue(heavier.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Romanian Deadlift"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["plan 3 × 6 · 82.5"].exists, "The planned rows already say the plan")
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
    app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
    app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText("Bench")
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
    app.buttons["gym-movement-bench-press"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Bench Press"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["workout-weight"].label, "Weight, 20 kg total")
    app.buttons["workout-log"].tap()
    let chosenSet = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(chosenSet.waitForExistence(timeout: 5))
    XCTAssertEqual(chosenSet.label, "Set 1, logged, 20 kilograms, 5 reps")
    app.descendants(matching: .any)["workout-current-set"].swipeRight()
    XCTAssertTrue(app.buttons["Romanian Deadlift"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, 0)
  }

  func testFinishRetainsReceiptAndSaveRoutineInBothAppearances() {
    for appearance in ["light", "dark"] {
      let app = launch("workout-free", appearance: appearance)
      app.buttons["workout-log"].tap(); app.buttons["workout-log"].tap()
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.staticTexts["Well done."].waitForExistence(timeout: 5),
                    "GymRoom must retain the cover using gym.workout.isPresented after Finish clears openSession.")
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = "receipt-\(appearance)"; attachment.lifetime = .keepAlways; add(attachment)
      app.swipeUp()
      let save = app.buttons["workout-save-routine"]
      XCTAssertTrue(save.waitForExistence(timeout: 5)); save.tap()
      XCTAssertTrue(app.staticTexts["workout-routine-kept"].waitForExistence(timeout: 5))
      app.buttons["Done"].tap()
      XCTAssertFalse(app.buttons["workout-log"].exists)
      app.terminate()
    }
  }

  // This workout counts each movement's working sets against its plan, adds a movement from its own list, and hides the
  // workout without promising a place the phone does not draw.
  func testThisWorkoutCountsSetsAgainstThePlanAndHidesTheWorkout() {
    let app = launch(appearance: "light")
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.navigationBars["This workout"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Back Squat, 2 of 4 sets"].exists)
    XCTAssertTrue(app.buttons["Romanian Deadlift, 0 of 3 sets"].exists)
    XCTAssertTrue(app.buttons["workout-assembly-add"].exists)
    XCTAssertFalse(app.staticTexts["Your sets stay saved. Restore this workout from Gym settings."].exists)
    let footer = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
      ? "Your sets stay saved. Tap the workout above the tabs to return." : "Your sets stay saved. Find it at the top of The log."
    XCTAssertTrue(app.staticTexts[footer].exists)
  }

  // Hidden heads The log, or stands in the tab bar's accessory on iOS 26: either brings the logger back with its sets.
  func testHiddenWorkoutReturnsFromTheLogWithItsSets() {
    let app = launch()
    app.buttons["workout-log"].tap()
    let retained = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    XCTAssertTrue(app.tabBars.buttons["The log"].waitForExistence(timeout: 5)); app.tabBars.buttons["The log"].tap()
    let hidden = app.buttons["gym-hidden-workout"]
    XCTAssertTrue(hidden.waitForExistence(timeout: 5)); hidden.tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, retained)
  }

  func testDismissLocalFailureRevealsDurableWorkoutRefusal() {
    let app = launch("workout-notice")
    XCTAssertTrue(app.staticTexts["Check the weight and reps before logging."].waitForExistence(timeout: 5))
    app.otherElements["workout-refusal"].buttons["Dismiss message"].tap()
    let retained = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "not sent.")).firstMatch
    XCTAssertTrue(retained.waitForExistence(timeout: 5))
    app.otherElements["workout-refusal"].buttons["Dismiss message"].tap()
    XCTAssertTrue(retained.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-log"].exists)
  }

  func testOfflineFinishWarningLeadsWithItsConnectionRequirementAtLargestText() throws {
    let app = launch("workout-notice")
    app.terminate()
    app.launchArguments = ["-board", "workout-notice", "-restore-board",
                           "-server", "https://offline.invalid", "-offline-fixture", "no-network",
                           "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    app.launch()
    let log = app.buttons["workout-log"]
    XCTAssertTrue(log.waitForExistence(timeout: 3)); XCTAssertTrue(log.isEnabled); XCTAssertTrue(log.isHittable)
    log.tap(); app.buttons["workout-finish"].tap()
    let message = "Finish needs a connection — keep logging, or hide the workout."
    XCTAssertTrue(app.staticTexts[message].waitForExistence(timeout: 3))
    var captures = 0
    func visibleText() throws -> String {
      let screenshot = app.screenshot()
      let attachment = XCTAttachment(screenshot: screenshot)
      attachment.name = "offline-finish-warning-AX5-\(captures)"
      attachment.lifetime = .keepAlways; add(attachment); captures += 1
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.recognitionLanguages = ["en-US"]
      try VNImageRequestHandler(cgImage: XCTUnwrap(screenshot.image.cgImage)).perform([request])
      return (request.results ?? []).sorted { $0.boundingBox.minY > $1.boundingBox.minY }
        .compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased()
        .split(separator: " ").filter { $0 != "x" }.joined(separator: " ")
    }
    let unscrolled = try visibleText()
    for phrase in ["needs a connection", "log set"] {
      XCTAssertTrue(unscrolled.contains(phrase), "The warning hid ‘\(phrase)’ before any scroll: \(unscrolled)")
    }
    var rendered = unscrolled
    let notice = app.scrollViews.containing(.staticText, identifier: message).firstMatch
    for _ in 0..<12 where !(rendered.contains("keep logging") && rendered.contains("or hide")) {
      guard notice.exists else { break }
      let start = notice.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
      let end = notice.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
      start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
      rendered += " " + (try visibleText())
    }
    for phrase in ["keep logging", "or hide"] {
      XCTAssertTrue(rendered.contains(phrase), "The warning never showed ‘\(phrase)’: \(rendered)")
    }
    XCTAssertTrue(log.isEnabled); XCTAssertTrue(log.isHittable); log.tap()
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.navigationBars["This workout"].waitForExistence(timeout: 3))
    let hide = app.buttons["workout-hide"]
    for _ in 0..<4 where !hide.exists || !hide.isHittable { app.swipeUp() }
    XCTAssertTrue(hide.exists)
    XCTAssertTrue(hide.isEnabled); XCTAssertTrue(hide.isHittable); hide.tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 3))
  }
}
