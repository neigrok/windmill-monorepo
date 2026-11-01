import XCTest

// The slow end-to-end checks a day's run is enough for: system surfaces SpringBoard draws, and geometry at the sizes and
// motion settings the pull-request flows leave out. Opt in with TEST_RUNNER_WM_NIGHTLY_UI=1 when invoking xcodebuild.
@MainActor final class NightlyFlowTests: XCTestCase {
  let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

  override func setUpWithError() throws {
    try super.setUpWithError()
    try XCTSkipUnless(ProcessInfo.processInfo.environment["WM_NIGHTLY_UI"] == "1", "The nightly UI flows are opt-in.")
    continueAfterFailure = false
  }

  // MARK: System surfaces

  // The control in Control Center (Figma Gym · iOS 04.1): each state drawn, and Log set from it with the app behind.
  func testControlDrawsEachStateAndLogsTheRackFromControlCenter() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-live-activity-planned", "-onboarding-appearance", "light"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 20))
    let currentSet = app.descendants(matching: .any)["workout-current-set"]
    XCTAssertTrue(currentSet.waitForLabel("Set 3, current, 100 kilograms, 5 reps"))
    let before = app.workoutLedgerRows().filter { $0.identifier.hasPrefix("workout-set-") }
    XCTAssertEqual(before.map(\.label), ["Set 1, logged, 100 kilograms, 5 reps", "Set 2, logged, 100 kilograms, 5 reps"])
    XCUIDevice.shared.press(.home)

    // The control logs in the app behind Control Center: a tap it drops is tapped once more, only while the rack reads 2 of 4.
    for attempt in 1...2 {
      let control = controlCenterControl()
      XCTAssertTrue(control.wait(for: \.label, toEqual: "Log set", timeout: 10), "\(control.debugDescription)")
      XCTAssertEqual(control.value as? String, "100 × 5")
      XCTAssertTrue(control.wait(for: \.isHittable, toEqual: true, timeout: 5)); control.tap()
      XCUIDevice.shared.press(.home)
      app.activate()
      if currentSet.waitForLabel("Set 4, current, 100 kilograms, 5 reps", timeout: 15) { break }
      XCTAssertEqual(currentSet.label, "Set 3, current, 100 kilograms, 5 reps", "The control's tap logged something other than one set")
      XCTAssertEqual(attempt, 1, "Two taps on the control logged nothing")
      XCUIDevice.shared.press(.home)
    }
    let after = app.workoutLedgerRows().filter { $0.identifier.hasPrefix("workout-set-") }
    XCTAssertEqual(after.map(\.label), ["Set 1, logged, 100 kilograms, 5 reps", "Set 2, logged, 100 kilograms, 5 reps",
      "Set 3, logged, 100 kilograms, 5 reps"])
    XCTAssertEqual(after.prefix(before.count).map(\.identifier), before.map(\.identifier))
    XCTAssertEqual(Set(after.map(\.identifier)).count, 3)

    app.buttons["workout-assembly"].tap()
    let hide = app.buttons["Hide workout"]
    XCTAssertTrue(hide.waitForExistence(timeout: 5)); hide.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(controlCenterControl().wait(for: \.label, toEqual: "Open workout", timeout: 10))
    controlCenterControl().tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    XCTAssertTrue(currentSet.waitForLabel("Set 4, current, 100 kilograms, 5 reps"))
    let reopened = app.workoutLedgerRows().filter { $0.identifier.hasPrefix("workout-set-") }
    XCTAssertEqual(reopened.map(\.identifier), after.map(\.identifier))
    XCTAssertEqual(reopened.map(\.label), after.map(\.label))

    app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10)); app.buttons["Done"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(controlCenterControl().wait(for: \.label, toEqual: "Start workout", timeout: 10))
    controlCenterControl().tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Routines"].isSelected)
    XCTAssertFalse(app.descendants(matching: .any)["gym-session-detail"].exists)
  }

  // Control Center open, the workout control in it: added from the gallery the first time and widened to its medium size.
  func controlCenterControl() -> XCUIElement {
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.003)).press(forDuration: 0.05,
      thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.6)))
    let control = springboard.buttons.matching(identifier: "works.windmill.app.workout").firstMatch
    if control.waitForExistence(timeout: 3) { return control }
    let add = springboard.buttons["Add Controls"]
    XCTAssertTrue(add.waitForExistence(timeout: 5)); add.tap()
    let gallery = springboard.buttons["Add a Control"]
    XCTAssertTrue(gallery.waitForExistence(timeout: 5)); gallery.tap()
    let search = springboard.searchFields["Search Controls"]
    XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("Windmill")
    let tutorial = springboard.buttons["Continue"]
    if tutorial.waitForExistence(timeout: 2) { tutorial.tap() }
    let workout = springboard.icons["Workout"]
    XCTAssertTrue(workout.waitForExistence(timeout: 5), "\(springboard.debugDescription)"); workout.tap()
    let added = springboard.icons["Workout"], origin = springboard.coordinate(withNormalizedOffset: .zero)
    let sized = { (size: String) in XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in added.value as? String == size }, object: nil) }
    XCTAssertEqual(XCTWaiter.wait(for: [sized("1 by 1")], timeout: 5), .completed)
    origin.withOffset(CGVector(dx: added.frame.maxX - 6, dy: added.frame.maxY - 6)).press(forDuration: 0.4,
      thenDragTo: origin.withOffset(CGVector(dx: added.frame.maxX + 90, dy: added.frame.maxY - 6)))
    XCTAssertEqual(XCTWaiter.wait(for: [sized("2 by 1")], timeout: 5), .completed)
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
    XCTAssertTrue(control.waitForExistence(timeout: 5), "\(springboard.debugDescription)")
    return control
  }

  // The Home Screen's quick actions (Shell · iOS 22), each chosen once while Windmill runs in the background and once from a
  // cold start. A launch from the Home Screen carries no arguments, so the first launch keeps its own for the later ones.
  func testEveryQuickActionOpensItsPlaceFromTheBackgroundAndFromAColdStart() {
    // An open icon menu never stops animating, so SpringBoard skips XCTest's 60 s idle wait and each step waits on its element.
    if springboard.responds(to: NSSelectorFromString("setIdleAnimationWaitEnabled:")) {
      springboard.setValue(false, forKey: "idleAnimationWaitEnabled")
    }
    let app = XCUIApplication()
    // The arguments the next tests' launches would otherwise inherit from the Home Screen go with one plain launch.
    addTeardownBlock { @MainActor in
      app.launchArguments = ["-model-server", "-board", "workout-planned"]; app.launch(); app.terminate()
    }
    func choose(_ item: String, cold: Bool) {
      if cold { app.terminate() } else { XCUIDevice.shared.press(.home) }
      let icon = springboard.icons["Windmill"]
      XCTAssertTrue(icon.wait(for: \.isHittable, toEqual: true, timeout: 10)); icon.press(forDuration: 1.5)
      let action = springboard.buttons[item]
      XCTAssertTrue(action.wait(for: \.isHittable, toEqual: true, timeout: 5)); action.tap()
      XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
    }
    func finishWorkout() {
      XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 10)); app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10)); app.buttons["Done"].tap()
      XCTAssertTrue(app.buttons["Done"].waitForNonExistence(timeout: 10))
    }
    app.launchArguments = ["-model-server", "-board", "workout-planned", "-keep-for-relaunch"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-assembly"].waitForExistence(timeout: 10)); app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForNonExistence(timeout: 5))

    for cold in [false, true] {
      choose("Open workout", cold: cold)
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 15), "Open workout brings the running workout forward")
    }
    finishWorkout()
    for cold in [false, true] {
      choose("Start Lower A", cold: cold)
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 15), "Start Lower A opens straight into its workout")
      XCTAssertTrue(app.movementHeader("Back Squat").exists)
      finishWorkout()
    }
    for cold in [false, true] {
      choose("Write tonight", cold: cold)
      XCTAssertTrue(app.buttons["done-writing"].waitForExistence(timeout: 15), "Write tonight opens tonight's page with the keyboard up")
    }
  }

  // MARK: Journal seat geometry

  func launchJournal(_ board: String, layout: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board] + (layout ? ["-journal-layout-test"] : [])
    app.launch()
    return app
  }

  // The 44 pt Write seat stands 16 pt from the trailing edge, becomes Done writing above the keyboard and parks again where it was.
  func testEmptyLaterPageWriteSeatAndKeyboardSeat() {
    let app = launchJournal("journal-empty-later")
    let editor = app.textViews["journal-editor"]
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.waitForExistence(timeout: 10))
    XCTAssertEqual(write.label, "Write")
    XCTAssertEqual(write.frame.width, 44, accuracy: 1)
    XCTAssertEqual(write.frame.height, 44, accuracy: 1)
    XCTAssertEqual(app.frame.maxX - write.frame.maxX, 16, accuracy: 1)
    XCTAssertEqual(editor.value as? String, "")
    XCTAssertGreaterThanOrEqual(editor.frame.height, 76.5)
    let parkedSeat = write.frame
    write.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    let done = app.buttons["done-writing"]
    XCTAssertEqual(done.label, "Done writing")
    XCTAssertEqual(done.frame.width, parkedSeat.width, accuracy: 0.5)
    XCTAssertEqual(done.frame.height, parkedSeat.height, accuracy: 0.5)
    XCTAssertEqual(done.frame.minX, parkedSeat.minX)
    // XCTest's keyboard frame excludes its prediction bar.
    XCTAssertLessThanOrEqual(done.frame.maxY, app.keyboards.firstMatch.frame.minY - 12)
    done.tap()
    XCTAssertTrue(write.waitForExistence(timeout: 5))
    XCTAssertEqual(write.frame.minY, parkedSeat.minY, accuracy: 0.5)
    XCTAssertEqual(editor.value as? String, "")
    app.descendants(matching: .any)["journal-date"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText("Today's line.")
    XCTAssertEqual(editor.value as? String, "Today's line.")
  }

  // However long the page grows, the caret and the last line stay above Done writing, and a tap below the text ends at its end.
  func testFilledLinesStayAboveDoneSeat() throws {
    let app = launchJournal("journal-empty-later", layout: true)
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.waitForExistence(timeout: 10))
    write.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    let done = app.buttons["done-writing"]
    let editor = app.textViews["journal-editor"]
    for addition in ["First filled line.\nSecond filled line.\nThird filled line.",
                     String(repeating: "\nA longer page keeps the caret clear of the Done seat.", count: 12), "\n"] {
      assertCaretAtEnd(in: editor)
      app.typeText(addition)
      let visibleTop = app.scrollViews["journal-canvas"].frame.minY
      let written = try XCTUnwrap(journalMetrics(in: editor))
      for name in ["caret", "lastLine"] {
        let rect = try XCTUnwrap(written[name] as? [Double])
        guard rect.count == 4 else { XCTFail("Invalid \(name) rectangle: \(rect)"); return }
        XCTAssertGreaterThan(rect[2], 0)
        XCTAssertGreaterThan(rect[3], 0)
        XCTAssertGreaterThanOrEqual(rect[1], visibleTop)
        XCTAssertLessThanOrEqual(rect[1] + rect[3], done.frame.minY, "\(name): \(rect), editor: \(editor.frame), seat: \(done.frame)")
      }
      try tapIntoLastLine(in: app)
      let metrics = try XCTUnwrap(journalMetrics(in: editor))
      let lastLine = try XCTUnwrap(metrics["lastLine"] as? [Double])
      guard lastLine.count == 4 else { XCTFail("Invalid lastLine rectangle: \(lastLine)"); return }
      let visibleBottom = min(editor.frame.maxY, app.scrollViews["journal-canvas"].frame.maxY) - 1
      let tapY = min(lastLine[1] + lastLine[3] + 4, visibleBottom)
      XCTAssertGreaterThan(tapY, lastLine[1] + lastLine[3])
      app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: editor.frame.minX + 1, dy: tapY)).tap()
      assertCaretAtEnd(in: editor)
      XCTAssertEqual(journalMetrics(in: editor)?["text"] as? String, metrics["text"] as? String)
      try tapIntoLastLine(in: app)
      let bottom = app.scrollViews["journal-canvas"].frame.maxY - 1
      XCTAssertGreaterThan(bottom, lastLine[1] + lastLine[3])
      app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: editor.frame.maxX - 1, dy: bottom)).tap()
      assertCaretAtEnd(in: editor)
    }
    done.tap()
    XCTAssertTrue(write.waitForExistence(timeout: 5))
  }

  // From history the seat brings today back and opens writing, with and without Reduce Motion.
  func testWriteSeatReturnsFromPastDayToToday() {
    for board in ["journal-history", "journal-history-RM"] {
      let app = launchJournal(board)
      let editor = app.textViews["journal-editor"]
      XCTAssertTrue(editor.waitForExistence(timeout: 10))
      let scroll = app.scrollViews["journal-canvas"]
      for _ in 0..<5 { scroll.swipeDown(velocity: .fast) }
      XCTAssertFalse(editor.isHittable)
      let write = app.buttons["write-today"]
      XCTAssertTrue(write.isHittable)
      write.tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      XCTAssertTrue(editor.isHittable)
      XCTAssertTrue(app.buttons["done-writing"].exists)
      app.typeText(" Appended today.")
      XCTAssertEqual(editor.value as? String, "Short walk, then an early night. Appended today.")
      app.buttons["done-writing"].tap()
      XCTAssertTrue(write.waitForExistence(timeout: 5))
      XCTAssertFalse(app.keyboards.firstMatch.exists)
      scroll.swipeDown(velocity: .fast)
      XCTAssertFalse(app.buttons["done-writing"].exists)
      XCTAssertTrue(write.isHittable)
      app.terminate()
    }
  }

  // With Reduce Motion the parked caret of an empty page stands still.
  func testReduceMotionEmptyPageKeepsParkedCaretStill() {
    let app = launchJournal("journal-empty-later-RM")
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    let parked = editor.screenshot().pngRepresentation
    app.buttons["room-menu"].tap()
    app.roomItem("Journal").tap()
    XCTAssertEqual(editor.screenshot().pngRepresentation, parked)
    app.buttons["write-today"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.buttons["done-writing"].tap()
    XCTAssertTrue(app.buttons["write-today"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    XCTAssertEqual(editor.value as? String, "")
  }

  // At the largest text the room and account buttons stay whole and apart, the seat keeps its size and the body grows.
  func testLargestTextKeepsNativeJournalControlsReachable() {
    let app = XCUIApplication()
    app.launchArguments = ["-board", "05-journal-first-open"]
    app.launch()
    XCTAssertTrue(app.buttons["room-menu"].waitForExistence(timeout: 10))
    let writeSize = app.buttons["write-today"].frame.size
    let bodyHeight = app.textViews["journal-editor"].frame.height
    app.terminate()
    app.launchArguments = ["-board", "05-journal-first-open-AX3"]
    app.launch()
    XCTAssertTrue(app.buttons["room-menu"].waitForExistence(timeout: 10))
    let room = app.buttons["room-menu"]
    let account = app.buttons["you"]
    XCTAssertTrue(room.isHittable)
    XCTAssertTrue(account.isHittable)
    XCTAssertTrue(app.frame.contains(room.frame))
    XCTAssertTrue(app.frame.contains(account.frame))
    XCTAssertFalse(room.frame.intersects(account.frame))
    XCTAssertEqual(app.buttons["write-today"].frame.size, writeSize)
    XCTAssertGreaterThan(app.textViews["journal-editor"].frame.height, bodyHeight)
    XCTAssertEqual(app.buttons["room-menu"].label, "Journal")
    XCTAssertEqual(app.buttons["you"].label, "You and settings")
  }

  func journalMetrics(in editor: XCUIElement) -> [String: Any]? {
    guard let value = editor.value as? String else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(value.utf8))) as? [String: Any]
  }

  func tapIntoLastLine(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) throws {
    let editor = app.textViews["journal-editor"]
    let metrics = try XCTUnwrap(journalMetrics(in: editor), file: file, line: line)
    let rect = try XCTUnwrap(metrics["lastLine"] as? [Double], file: file, line: line)
    guard rect.count == 4 else { XCTFail("Invalid lastLine rectangle: \(rect)", file: file, line: line); return }
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: rect[0] + rect[2] / 4, dy: rect[1] + rect[3] / 2)).tap()
    let insideText = NSPredicate { _, _ in
      guard let metrics = self.journalMetrics(in: editor),
            let selection = metrics["selection"] as? [Int], selection.count == 2,
            let length = metrics["textLength"] as? Int else { return false }
      return metrics["focused"] as? Bool == true && selection[0] < length
    }
    if insideText.evaluate(with: editor) { return }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: insideText, object: editor)], timeout: 5), .completed,
                   "Expected selection inside text: \(editor.value ?? "missing editor value")", file: file, line: line)
  }

  func assertCaretAtEnd(in editor: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
    let ready = NSPredicate { _, _ in
      guard let metrics = self.journalMetrics(in: editor),
            let selection = metrics["selection"] as? [Int],
            let length = metrics["textLength"] as? Int else { return false }
      return metrics["focused"] as? Bool == true && selection == [length, 0]
    }
    if ready.evaluate(with: editor) { return }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: editor)], timeout: 5), .completed,
                   "Expected focused caret at end: \(editor.value ?? "missing editor value")", file: file, line: line)
  }

  // MARK: Echoes at large text

  // At rest the canvas's end stands 16 pt above the write seat, and today's opened ink scrolls clear of it with no swipe.
  func testTheCanvasEndAndAnOpenedInkClearTheWriteSeat() {
    let app = EchoCanvas.launch("light", board: "journal-echoes-first").app
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.wait(for: \.isHittable, toEqual: true, timeout: 10))
    let energy = app.buttons["Clear energy"]
    XCTAssertTrue(energy.waitForExistence(timeout: 5))
    XCTAssertLessThanOrEqual(energy.frame.maxY, write.frame.minY - 16 + 0.5, "At rest the last row ends 16 pt above the seat")
    let disclosure = app.buttons["journal-echo-\(EchoCanvas.today)"]
    XCTAssertTrue(disclosure.wait(for: \.isHittable, toEqual: true, timeout: 10)); disclosure.tap()
    let gotIt = app.buttons["echo-introduction-done"]
    XCTAssertTrue(gotIt.waitForExistence(timeout: 5))
    let passage = app.buttons["echo-open-\(EchoCanvas.firstSource)"]
    let cleared = NSPredicate { _, _ in gotIt.isHittable && max(gotIt.frame.maxY, passage.frame.maxY) <= write.frame.minY - 16 }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: cleared, object: nil)], timeout: 5), .completed,
                   "The card and its first passage stand above the seat: \(gotIt.frame), \(passage.frame) over \(write.frame)")
  }

  // At AX3 what opened rises by the least that clears the seat, and never so far that its start passes 16 pt under the
  // bar: where both cannot hold, its start wins and the reader scrolls for the rest.
  func testAnOpenedInkAtTheLargestTextShowsItsStartBeforeItClearsTheSeat() {
    let canvas = EchoCanvas.launch("light", board: "journal-echoes-first",
                                   arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
    let app = canvas.app
    let write = app.buttons["write-today"], bar = app.navigationBars.firstMatch
    XCTAssertTrue(write.wait(for: \.isHittable, toEqual: true, timeout: 15))
    let disclosure = app.buttons["journal-echo-\(EchoCanvas.today)"]
    canvas.reveal(disclosure, towardTop: true); disclosure.tap()
    let ink = app.descendants(matching: .any)["echo-ink-\(EchoCanvas.today)"]
    XCTAssertTrue(ink.waitForExistence(timeout: 5))
    let settled = NSPredicate { _, _ in
      let start = ink.frame.minY - bar.frame.maxY
      return start >= 16 - 1 && (ink.frame.maxY <= write.frame.minY - 16 + 1 || start <= 16 + 1)
    }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: nil)], timeout: 5), .completed,
                   "The ink \(ink.frame) ends 16 pt above the seat \(write.frame) or starts 16 pt under the bar \(bar.frame)")
  }

  // At accessible text with Reduce Motion every echo action keeps its 44 pt target inside the screen, in both looks.
  func testAccessibleTextAndReducedMotionKeepEchoActionsReachable() throws {
    for appearance in ["light", "dark"] {
      let canvas = EchoCanvas.launch(appearance, board: "journal-echoes-AX3-RM", layout: true), app = canvas.app
      let disclosure = app.buttons["journal-echo-\(EchoCanvas.today)"]
      canvas.reveal(disclosure, towardTop: true)
      XCTAssertEqual(disclosure.label, "3 passages you wrote before")
      disclosure.tap()
      let open = app.buttons["echo-open-\(EchoCanvas.firstSource)"]
      canvas.reveal(open)
      XCTAssertGreaterThanOrEqual(open.frame.height, 44)
      XCTAssertLessThanOrEqual(open.frame.maxX, app.frame.maxX)
      XCTAssertGreaterThanOrEqual(open.frame.minX, app.frame.minX)
      for identifier in ["echo-useful-page", "echo-dismiss-page", "echo-more"] {
        let action = app.buttons[identifier]
        canvas.reveal(action)
        XCTAssertGreaterThanOrEqual(action.frame.height, 44)
        XCTAssertLessThanOrEqual(action.frame.maxX, app.frame.maxX)
      }
      canvas.reveal(open, towardTop: true); open.tap()
      try canvas.assertSourcePassageCentered()
      let back = app.buttons["echo-back-to-tonight"]
      XCTAssertTrue(back.isHittable)
      XCTAssertGreaterThanOrEqual(back.frame.height, 44)
      XCTAssertLessThanOrEqual(back.frame.maxX, app.frame.maxX)
      XCTAssertGreaterThanOrEqual(back.frame.minX, app.frame.minX)
      back.tap()
      XCTAssertTrue(back.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.textViews["journal-editor"].wait(for: \.isHittable, toEqual: true, timeout: 5))
      XCTAssertFalse(app.keyboards.firstMatch.exists)
      app.terminate()
    }
  }

  // MARK: Onboarding at accessibility sizes

  // The glimpse takes the height the whole text block leaves it, from full down to its 220 pt floor, scaled uniformly and
  // centred: a page a few points too tall shrinks its picture, never its words.
  func testTheGlimpseTakesTheHeightTheTextLeavesDownToItsFloor() {
    let pages = OnboardingPages.launch(), app = pages.app
    for page in 0..<4 {
      pages.assertPage(page)
      let picture = pages.glimpse(page).frame
      let scroll = app.scrollViews.containing(NSPredicate(format: "label == %@", OnboardingPages.titles[page])).firstMatch
      let top = scroll.staticTexts.matching(identifier: page == 0 ? "onboarding-title" : "onboarding-eyebrow").firstMatch.frame.minY
      let end = scroll.staticTexts[page == 0 ? OnboardingPages.bodies[0] : page == 1 ? "On the web" : "In this app"].frame.maxY
      let full: CGFloat = page == 0 ? 320 : 340, slot = top - 26 - picture.minY, column = scroll.frame.width - 48
      let room = slot + scroll.frame.maxY - (end + 16)
      let scale = min(column / 354, slot / full), evidence = "Page \(page + 1): \(picture), text \(top)–\(end) in \(scroll.frame)"
      // Accessibility frames round outward to whole points, so each is checked to within one.
      XCTAssertEqual(slot, min(full, max(220, room)), accuracy: 1, evidence)
      XCTAssertEqual(picture.width, 354 * scale, accuracy: 1, evidence)
      XCTAssertEqual(picture.height, full * scale, accuracy: 1, evidence)
      XCTAssertEqual(picture.midX, scroll.frame.midX, accuracy: 1, evidence)
      app.buttons["onboarding-next"].tap()
    }
    pages.assertWhereToStart()
  }

  // At the accessibility sizes the text leads: each page opens on its title and body with the glimpse after them, and at
  // AX3 page 1's honesty sentence stands whole in the first screen, above the fade a scrolling page draws at its foot.
  func testTheTextLeadsAtAccessibilitySizesAndPageOneSaysItWhole() {
    let pages = OnboardingPages.launch(arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
    let app = pages.app
    for page in 0..<4 {
      pages.assertPage(page)
      let scroll = app.scrollViews.containing(NSPredicate(format: "label == %@", OnboardingPages.titles[page])).firstMatch
      let title = pages.title(page), body = app.staticTexts[OnboardingPages.bodies[page]], picture = pages.glimpse(page)
      let evidence = "Page \(page + 1): title \(title.frame), body \(body.frame), glimpse \(picture.frame) in \(scroll.frame)"
      XCTAssertTrue(title.frame.maxY <= body.frame.minY && body.frame.maxY < picture.frame.minY, evidence)
      XCTAssertGreaterThanOrEqual(title.frame.minY, scroll.frame.minY, evidence)
      XCTAssertEqual(picture.frame.height, 260, accuracy: 1, evidence)
      if page == 0 { XCTAssertLessThanOrEqual(body.frame.maxY, scroll.frame.maxY - 16, evidence) }
      app.buttons["onboarding-next"].tap()
    }
    pages.assertWhereToStart()
  }

  // At the largest text the primary stays pinned and hittable below the scrolling page.
  func testLargestAccessibilityTextKeepsPrimaryPinned() {
    let pages = OnboardingPages.launch(arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    let app = pages.app
    for page in 0..<4 {
      pages.assertPage(page)
      let primary = app.buttons["onboarding-next"]
      XCTAssertTrue(primary.isHittable)
      XCTAssertGreaterThanOrEqual(primary.frame.height, 52)
      XCTAssertLessThanOrEqual(primary.frame.maxY, app.frame.maxY)
      XCTAssertGreaterThan(primary.frame.minY, app.frame.midY)
      let frame = primary.frame
      let scroll = app.scrollViews.firstMatch
      XCTAssertTrue(scroll.exists)
      XCTAssertLessThanOrEqual(scroll.frame.maxY, app.pageIndicators["onboarding-page-control"].frame.minY)
      XCTAssertEqual(pages.glimpse(page).frame.height, 260, accuracy: 1, "The largest text leaves no room for the full-height glimpse")
      let body = app.staticTexts[OnboardingPages.bodies[page]]
      let bodyTop = body.frame.minY
      scroll.swipeUp()
      XCTAssertLessThan(body.frame.minY, bodyTop)
      XCTAssertTrue(primary.isHittable)
      XCTAssertEqual(primary.frame, frame)
      XCTAssertGreaterThan(pages.title(page).frame.height, 0)
      primary.tap()
    }
    pages.assertWhereToStart()
  }
}
