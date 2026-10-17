import XCTest

@MainActor final class GymLogFlowTests: XCTestCase {
  func launch(_ appearance: String, seeded: Bool = true, overflowingCharts: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "shell-anonymous", "-onboarding-appearance", appearance]
    if seeded { app.launchArguments.append("-gym-log-fixture") }
    if overflowingCharts { app.launchArguments.append("-gym-chart-overflow-fixture") }
    app.launch()
    XCTAssertTrue(app.buttons["open-gym"].waitForExistence(timeout: 15))
    app.buttons["open-gym"].tap()
    XCTAssertTrue(app.tabBars.buttons["The log"].waitForExistence(timeout: 10))
    app.tabBars.buttons["The log"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 20))
    return app
  }
  func snapshot(_ name: String, app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  func back(_ app: XCUIApplication) { app.navigationBars.buttons.element(boundBy: 0).tap() }
  func sessionRow(_ app: XCUIApplication) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
  }
  // Nothing floats over The log; only the tab bar meets the list's foot.
  func listBottom(_ app: XCUIApplication) -> CGFloat { app.tabBars.firstMatch.frame.minY }
  func visibleSessionRow(_ app: XCUIApplication) -> XCUIElement {
    let first = sessionRow(app)
    XCTAssertTrue(first.waitForExistence(timeout: 20))
    let row = app.buttons[first.identifier]
    for _ in 0..<8 {
      let frame = row.frame, top = app.navigationBars.firstMatch.frame.maxY + 8
      let bottom = listBottom(app) - 12
      guard bottom > top + 16 else { break }
      if frame.minY > top && frame.maxY < bottom {
        if row.isHittable { break }
        continue
      }
      let movement = min(150, (bottom - top) / 2 - 8) * (frame.minY <= top ? 1 : -1)
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
        .withOffset(CGVector(dx: 0, dy: max(top + 8, min(bottom - 8, frame.midY))))
      start.press(forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 0, dy: movement)),
        withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    XCTAssertTrue(row.isHittable)
    XCTAssertGreaterThan(row.frame.minY, app.navigationBars.firstMatch.frame.maxY + 8)
    XCTAssertLessThan(row.frame.maxY, listBottom(app) - 12)
    return row
  }
  func openFirstSession(_ app: XCUIApplication) {
    visibleSessionRow(app).tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
  }
  func firstSet(_ app: XCUIApplication) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-finished-set-")).firstMatch
  }
  // An open iOS 26 menu can keep XCTest from idling and drop the first tap on an item, so the item is tapped again until it leaves.
  func choose(_ item: String, from menu: String, _ app: XCUIApplication) {
    let button = app.buttons[menu]
    XCTAssertTrue(button.wait(for: \.isHittable, toEqual: true, timeout: 10)); button.tap()
    let choice = app.buttons[item]
    XCTAssertTrue(choice.wait(for: \.isHittable, toEqual: true, timeout: 10))
    for _ in 0..<3 where choice.exists {
      choice.tap()
      if choice.waitForNonExistence(timeout: 3) { break }
    }
    XCTAssertFalse(choice.exists)
  }

  // Empty, the log is its title and symbol alone: no Bodyweight row until a weigh-in exists, and Weigh in's checkmark
  // waits for a weight it could save.
  func testEmptyLogAndWeighInRefusals() {
    let app = launch("dark", seeded: false)
    XCTAssertTrue(app.staticTexts["No workouts yet"].exists)
    XCTAssertFalse(app.buttons["gym-bodyweight-door"].exists)
    app.buttons["gym-weigh-in"].tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5))
    let save = app.buttons["gym-weigh-in-save"]
    XCTAssertFalse(save.isEnabled)
    let field = app.textFields["gym-weigh-in-weight"]
    field.tap(); field.typeText(".")
    XCTAssertTrue(save.isEnabled); save.tap()
    XCTAssertTrue(app.staticTexts["That is not a number yet."].exists)
    XCTAssertFalse(save.isEnabled)
    field.typeText("\u{8}19")
    save.tap()
    XCTAssertTrue(app.staticTexts["Between 20 and 400 kg — check the number."].exists)
    XCTAssertFalse(save.isEnabled)
    field.typeText("\u{8}\u{8}82.4")
    save.tap()
    XCTAssertTrue(app.buttons["gym-weigh-in"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["gym-bodyweight-door"].waitForExistence(timeout: 5))
    app.buttons["gym-bodyweight-door"].tap()
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-weigh-in-2026-")).firstMatch.waitForExistence(timeout: 5))
  }

  func testWeighInIsTheLogsBarActionAndItsSheetSavesFromTheBar() {
    let app = launch("light")
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    let weighIn = app.buttons["gym-weigh-in"]
    XCTAssertTrue(weighIn.isHittable)
    XCTAssertLessThanOrEqual(weighIn.frame.maxY, app.navigationBars.firstMatch.frame.maxY)
    weighIn.tap()
    let save = app.buttons["gym-weigh-in-save"]
    XCTAssertTrue(save.waitForExistence(timeout: 5))
    XCTAssertLessThanOrEqual(save.frame.maxY, app.navigationBars["Weigh in"].frame.maxY)
    XCTAssertEqual(save.label, "Save")
  }

  // A weigh-in row has a session row's shape, its weight first and its day trailing before the door. It is as tall as its
  // text, about 51 pt, and the whole row, at least 44 pt, opens the weigh-in.
  func testAWeighInRowIsItsWeightFirstAndItsWholeRowOpensIt() {
    let app = launch("light")
    let door = app.buttons["gym-bodyweight-door"]
    XCTAssertTrue(door.waitForExistence(timeout: 20)); door.tap()
    let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-weigh-in-2026-")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    for _ in 0..<4 where !row.isHittable || row.frame.maxY > app.frame.maxY - 60 { app.swipeUp(velocity: .slow) }
    XCTAssertTrue(row.label.hasPrefix("82.4 kilograms, "), row.label)
    XCTAssertEqual(row.frame.height, 51, accuracy: 4, "A title-only row \(row.frame) is its text high")
    XCTAssertGreaterThanOrEqual(row.frame.height, 44)
    for depth in [2, row.frame.height - 2] {
      row.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: row.frame.width / 2, dy: depth)).tap()
      XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5), "A tap \(depth) pt into the row opens it")
      app.buttons["gym-weigh-in-cancel"].tap()
      XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForNonExistence(timeout: 5))
    }
  }

  func testLogScreensDark() { inspectScreens("dark") }
  func testLogScreensLight() { inspectScreens("light") }

  func testMovementRecordWindows() {
    let app = launch("dark")
    openFirstSession(app)
    let movement = app.buttons["gym-session-movement"].firstMatch
    XCTAssertTrue(movement.waitForExistence(timeout: 10)); movement.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
    let picker = app.segmentedControls["gym-record-window"]
    XCTAssertTrue(picker.waitForExistence(timeout: 5))
    for _ in 0..<3 where picker.frame.maxY > app.frame.maxY - 60 { app.swipeUp(velocity: .slow) }
    for _ in 0..<3 where picker.frame.minY < 180 {
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.4))
      start.press(forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 150)))
    }
    XCTAssertFalse(app.staticTexts["gym-chart-reading"].exists, "At rest the chart says its window, not a reading")
    picker.buttons["All"].tap()
    XCTAssertTrue(app.staticTexts["the whole series · 35 workouts"].waitForExistence(timeout: 5))
    snapshot("window-check", app: app)
    picker.buttons["12 weeks"].tap()
    snapshot("window-recent-check", app: app)
    XCTAssertTrue(picker.buttons["12 weeks"].isSelected)
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "last 12 weeks ·")).firstMatch.waitForExistence(timeout: 5))
  }

  // A new best is a door: it opens its Record at its session, that point marked under the window line, never read out.
  func testAMomentOpensItsRecordAtItsSession() {
    let app = launch("light")
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    let moment = app.buttons.matching(identifier: "gym-best-moment").firstMatch
    for _ in 0..<12 where !(moment.exists && !moment.frame.isEmpty && moment.isHittable
                            && moment.frame.minY > app.navigationBars.firstMatch.frame.maxY + 8 && moment.frame.maxY < listBottom(app) - 12) {
      app.swipeUp(velocity: .slow)
    }
    let line = moment.label
    XCTAssertTrue(line.contains(" · new best") && line.contains(" kg est · up "), line)
    XCTAssertEqual(moment.value as? String ?? "", "", "A moment is a door, never an expander")
    let estimate = line.components(separatedBy: ", ").last?.components(separatedBy: " · ").first ?? line
    moment.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["gym-chart-caption"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["gym-chart-reading"].exists, "The chart marks the moment's point without reading it out")
    let marked = app.descendants(matching: .any)["gym-record-chart"].value as? String ?? ""
    XCTAssertTrue(marked.hasPrefix("\(estimate) · "), "The chart is at the moment's point \(estimate), not \(marked)")
    snapshot("moment-record", app: app)
    let best = app.descendants(matching: .any)["gym-record-best"].label.components(separatedBy: " kg").first ?? ""
    let earlier = app.staticTexts["Earlier records"]
    for _ in 0..<6 where !(earlier.exists && earlier.isHittable) { app.swipeUp(velocity: .slow) }
    XCTAssertTrue(earlier.isHittable, "Earlier records follow the chart")
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "e1RM \(best)")).firstMatch.exists,
                   "The standing best \(best) is the tile's and never a row")
  }

  func testBothChartDateAxesFollowOverflowingHistoryPans() {
    let app = launch("light", overflowingCharts: true)
    openFirstSession(app)
    let movement = app.buttons["gym-session-movement"].firstMatch
    XCTAssertTrue(movement.waitForExistence(timeout: 10)); movement.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
    let window = app.segmentedControls["gym-record-window"]
    XCTAssertTrue(window.waitForExistence(timeout: 5))
    for _ in 0..<3 where window.frame.maxY > app.frame.maxY - 60 { app.swipeUp(velocity: .slow) }
    selectAllChartHistory(window, app: app)
    XCTAssertTrue(app.staticTexts["the whole series · 35 workouts"].waitForExistence(timeout: 5))
    assertDateAxisFollowsPan(app, chartID: "gym-record-chart")
    back(app); back(app)
    let bodyweight = app.buttons["gym-bodyweight-door"]
    for _ in 0..<3 where !(bodyweight.exists && !bodyweight.frame.isEmpty && bodyweight.isHittable && bodyweight.frame.minY >= app.navigationBars.firstMatch.frame.maxY) {
      app.swipeDown()
    }
    XCTAssertTrue(bodyweight.isHittable)
    XCTAssertGreaterThanOrEqual(bodyweight.frame.minY, app.navigationBars.firstMatch.frame.maxY)
    XCTAssertLessThan(bodyweight.frame.maxY, listBottom(app))
    bodyweight.tap()
    let weightsWindow = app.segmentedControls["gym-bodyweight-window"]
    XCTAssertTrue(weightsWindow.waitForExistence(timeout: 5))
    selectAllChartHistory(weightsWindow, app: app)
    XCTAssertTrue(app.staticTexts["the whole series · 40 weigh-ins"].waitForExistence(timeout: 5))
    assertDateAxisFollowsPan(app, chartID: "gym-bodyweight-chart")
  }

  func selectAllChartHistory(_ picker: XCUIElement, app: XCUIApplication) {
    let all = picker.buttons["All"]
    for _ in 0..<3 where picker.frame.minY < 160 {
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.35))
      start.press(forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 120)))
    }
    XCTAssertTrue(all.isHittable)
    all.tap()
    let selected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in all.isSelected }, object: all)
    XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed)
  }

  func assertDateAxisFollowsPan(_ app: XCUIApplication, chartID: String) {
    let chart = app.descendants(matching: .any)[chartID]
    XCTAssertTrue(chart.waitForExistence(timeout: 5))
    let viewport = chart.descendants(matching: .any)["gym-chart-viewport"]
    for _ in 0..<3 where !viewport.isHittable || viewport.frame.maxY > app.frame.maxY - 60 { app.swipeUp(velocity: .slow) }
    XCTAssertTrue(viewport.isHittable)
    let dateLabels = chart.descendants(matching: .any).matching(identifier: "gym-chart-dates")
    let dates = dateLabels.firstMatch
    XCTAssertTrue(dates.exists)
    let latest = dates.value as? String
    XCTAssertNotNil(latest)
    snapshot("\(chartID)-latest-dates", app: app)
    let visible = viewport.frame.intersection(app.frame.insetBy(dx: 24, dy: 140))
    XCTAssertGreaterThan(visible.width, 100); XCTAssertGreaterThan(visible.height, 100)
    let origin = app.coordinate(withNormalizedOffset: .zero)
    let left = origin.withOffset(CGVector(dx: visible.minX + visible.width * 0.2, dy: visible.midY))
    let right = origin.withOffset(CGVector(dx: visible.minX + visible.width * 0.85, dy: visible.midY))
    left.press(forDuration: 0.01, thenDragTo: right, withVelocity: .fast, thenHoldForDuration: 0)
    XCTAssertTrue(dateLabels.matching(NSPredicate(format: "value != nil AND value != %@", latest ?? ""))
      .firstMatch.waitForExistence(timeout: 10))
    let earlier = dates.value as? String
    XCTAssertNotNil(earlier)
    XCTAssertNotEqual(earlier, latest)
    snapshot("\(chartID)-earlier-dates", app: app)
    right.press(forDuration: 0.01, thenDragTo: left, withVelocity: .fast, thenHoldForDuration: 0)
    XCTAssertTrue(dateLabels.matching(NSPredicate(format: "value != nil AND value != %@", earlier ?? ""))
      .firstMatch.waitForExistence(timeout: 10))
    XCTAssertNotEqual(dates.value as? String, earlier)
  }

  func testOlderSessionsLoadAtTheEndAndTheLastSectionCountsTheWorkouts() {
    let app = launch("dark")
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    let older = app.descendants(matching: .any)["gym-log-older"]
    let end = app.staticTexts["gym-log-end"]
    for _ in 0..<30 where !(end.exists && !end.frame.isEmpty && end.isHittable) { app.swipeUp(velocity: .fast) }
    snapshot("log-end", app: app)
    XCTAssertTrue(end.isHittable)
    XCTAssertEqual(end.label, "35 workouts")
    XCTAssertFalse(older.exists)
  }

  // A pushed screen hides the tab bar and the accessory; back at the log's end, its last row and total stand where they stood.
  func testTheLogsEndStaysClearOfTheTabBarAfterAPushedScreenPops() {
    let app = launch("light")
    assertTheEndHoldsAcrossAPush(above: app.tabBars.firstMatch, app)
  }
  func testTheLogsEndStaysClearOfTheAccessoryAfterAPushedScreenPops() {
    let app = launch("light")
    assertTheEndHoldsAcrossAPush(above: hideAWorkout(app), app)
  }
  // A free workout, started from Routines and hidden, leaves the accessory standing over The log.
  func hideAWorkout(_ app: XCUIApplication) -> XCUIElement {
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    app.tabBars.buttons["Routines"].tap()
    let start = app.buttons["Just start logging"]
    XCTAssertTrue(start.waitForExistence(timeout: 10)); start.tap()
    XCTAssertTrue(app.buttons["workout-assembly"].waitForExistence(timeout: 10)); app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    let accessory = app.buttons["gym-hidden-workout"]
    XCTAssertTrue(accessory.waitForExistence(timeout: 5))
    app.tabBars.buttons["The log"].tap()
    return accessory
  }
  // Each bounce at the log's end flips the bar between minimized, the accessory inline beside it, and back, the accessory
  // above it; the end settles clear of whichever stands, and back beside the minimized bar it stands where it stood.
  func testTheLogsEndStaysClearOfTheAccessoryAsABounceBringsTheBarBack() {
    let app = launch("light")
    let accessory = hideAWorkout(app), expanded = app.tabBars.buttons["Routines"], footer = app.staticTexts["gym-log-end"]
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    for _ in 0..<40 where !(footer.exists && footer.isHittable) { app.swipeUp(velocity: .fast) }
    app.swipeUp(velocity: .fast)
    for _ in 0..<3 where expanded.isHittable { app.swipeUp(velocity: .fast) }
    XCTAssertTrue(expanded.wait(for: \.isHittable, toEqual: false, timeout: 5), "Flung to its end, the log minimizes the bar")
    let minimized = settledFrame(footer)
    snapshot("log-end-bar-minimized", app: app)
    XCTAssertLessThanOrEqual(minimized.maxY, accessory.frame.minY + 1, "Beside the minimized bar the footer \(minimized) clears \(accessory.frame)")
    app.swipeUp(velocity: .fast)
    XCTAssertTrue(expanded.wait(for: \.isHittable, toEqual: true, timeout: 5), "A bounce at the end brings the bar back")
    let grown = settledFrame(footer)
    snapshot("log-end-bar-back", app: app)
    XCTAssertLessThanOrEqual(grown.maxY, accessory.frame.minY + 1, "Under the bar's return the footer \(grown) clears \(accessory.frame)")
    app.swipeUp(velocity: .fast)
    XCTAssertTrue(expanded.wait(for: \.isHittable, toEqual: false, timeout: 5), "The next bounce minimizes the bar again")
    let again = settledFrame(footer)
    XCTAssertEqual(again.minY, minimized.minY, accuracy: 1, "Beside the minimized bar again the footer \(again) stands where it stood \(minimized)")
  }
  func assertTheEndHoldsAcrossAPush(above foot: XCUIElement, _ app: XCUIApplication) {
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    let footer = app.staticTexts["gym-log-end"]
    for _ in 0..<40 where !(footer.exists && footer.isHittable) { app.swipeUp(velocity: .fast) }
    for _ in 0..<2 { app.swipeUp(velocity: .fast) }
    let sessions = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-"))
    let last = app.buttons[sessions.allElementsBoundByIndex.last { $0.isHittable }?.identifier ?? "none"]
    let atEnd = (row: settledFrame(last), footer: settledFrame(footer))
    XCTAssertLessThanOrEqual(atEnd.footer.maxY, foot.frame.minY + 1, "At rest the footer \(atEnd.footer) clears \(foot.frame)")
    last.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.tabBars.firstMatch.isHittable, "A pushed screen hides the tab bar")
    XCTAssertFalse(foot.isHittable, "A pushed screen hides the bar's foot")
    back(app)
    XCTAssertTrue(app.buttons["gym-weigh-in"].waitForExistence(timeout: 10))
    let back = (row: settledFrame(last), footer: settledFrame(footer))
    snapshot("log-end-after-pop", app: app)
    XCTAssertEqual(back.row.minY, atEnd.row.minY, accuracy: 1, "The last row \(back.row) stands where it stood \(atEnd.row)")
    XCTAssertEqual(back.footer.minY, atEnd.footer.minY, accuracy: 1, "The footer \(back.footer) stands where it stood \(atEnd.footer)")
    XCTAssertLessThanOrEqual(back.footer.maxY, foot.frame.minY + 1, "The footer \(back.footer) clears \(foot.frame)")
  }
  func settledFrame(_ element: XCUIElement) -> CGRect {
    var frame = element.frame
    for _ in 0..<20 {
      RunLoop.current.run(until: Date().addingTimeInterval(0.25))
      if element.frame == frame { break }
      frame = element.frame
    }
    return frame
  }

  // A record the week's moment leaves unstated is its row's dot, which VoiceOver reads as a new best.
  func testARecordDotReadsAsANewBest() {
    let app = launch("light")
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    let dotted = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "gym-log-session-", "best")).firstMatch
    for _ in 0..<6 where !dotted.exists { app.swipeUp(velocity: .slow) }
    XCTAssertTrue(dotted.exists, "A session that set a new best its moment does not state says so")
    XCTAssertNotNil(dotted.label.wholeMatch(of: /Push A, new best, 2 working sets · 45m, [A-Z][a-z]{2} \d{1,2}/), dotted.label)
  }

  func testSessionDetailDiscardsFromItsMenuWithUndo() {
    let app = launch("light")
    let row = visibleSessionRow(app), id = row.identifier
    openFirstSession(app)
    choose("gym-session-discard", from: "gym-session-more", app)
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons[id].waitForNonExistence(timeout: 5))
    let undo = app.buttons["gym-log-undo"]
    XCTAssertTrue(undo.waitForExistence(timeout: 5)); undo.tap()
    XCTAssertTrue(app.buttons[id].waitForExistence(timeout: 5))
  }

  // The row's context menu opens the same sheet as the session's bar, signed out too, and Sign in to share comes back to
  // the share once the account is signed in.
  func testTheRowsShareDoorSignsInAndReturnsToTheShare() {
    let app = launch("light")
    visibleSessionRow(app).press(forDuration: 1.2)
    let door = app.buttons["Share this workout"]
    XCTAssertTrue(door.waitForExistence(timeout: 5)); door.tap()
    let signIn = app.buttons["gym-share-sign-in"]
    XCTAssertTrue(signIn.waitForExistence(timeout: 5))
    XCTAssertEqual(signIn.label, "Sign in to share")
    signIn.tap()
    let email = app.buttons["email-sign-in"]
    XCTAssertTrue(email.waitForExistence(timeout: 5)); email.tap()
    let address = app.textFields["email-address"]
    XCTAssertTrue(address.waitForExistence(timeout: 5)); address.typeText("share@example.com")
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5)); code.typeText("482913")
    let primary = app.buttons["gym-share-primary"]
    XCTAssertTrue(primary.waitForExistence(timeout: 20), "Signed in, the share returns")
    XCTAssertEqual(primary.label, "Get a link")
    XCTAssertFalse(signIn.exists)
  }

  func inspectScreens(_ appearance: String) {
    let app = launch(appearance)
    XCTAssertTrue(sessionRow(app).waitForExistence(timeout: 20))
    snapshot("log-\(appearance)", app: app)
    app.buttons["gym-weigh-in"].tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["gym-weigh-in-date"].exists)
    snapshot("weigh-in-new-\(appearance)", app: app)
    app.buttons["gym-weigh-in-cancel"].tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForNonExistence(timeout: 10))
    let returnedToLog = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      app.buttons["gym-weigh-in"].exists && app.buttons["gym-weigh-in"].isHittable
    }, object: app)
    XCTAssertEqual(XCTWaiter.wait(for: [returnedToLog], timeout: 10), .completed)
    openFirstSession(app)
    let movements = app.buttons.matching(identifier: "gym-session-movement")
    XCTAssertTrue(movements.element(boundBy: 0).label.contains("plan 1 × 5 · 60"))
    XCTAssertTrue(movements.element(boundBy: 1).label.contains("not in plan"))
    XCTAssertTrue(app.navigationBars.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "–")).firstMatch.exists)
    XCTAssertFalse(app.staticTexts["Plan saved at start"].exists)
    snapshot("session-\(appearance)", app: app)
    let correctedSet = firstSet(app)
    correctedSet.tap()
    let weight = app.buttons["gym-fix-weight"]
    XCTAssertTrue(weight.waitForExistence(timeout: 5))
    snapshot("fix-\(appearance)", app: app)
    weight.tap()
    let delete = app.buttons["workout-key-delete"]
    XCTAssertTrue(delete.waitForExistence(timeout: 5))
    for _ in 0..<8 where app.staticTexts["workout-keypad-value"].label != "—" { delete.tap() }
    XCTAssertEqual(app.staticTexts["workout-keypad-value"].label, "—")
    XCTAssertFalse(app.buttons["workout-keypad-set"].isEnabled)
    app.buttons["workout-key-9"].tap(); app.buttons["workout-key-0"].tap()
    XCTAssertEqual(app.staticTexts["workout-keypad-value"].label, "90")
    app.buttons["workout-keypad-set"].tap()
    let entered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Weight, 90 kilograms"), object: weight)
    XCTAssertEqual(XCTWaiter.wait(for: [entered], timeout: 5), .completed)
    app.buttons["gym-fix-save"].tap()
    XCTAssertTrue(weight.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
    let persisted = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "90 ×"), object: correctedSet)
    XCTAssertEqual(XCTWaiter.wait(for: [persisted], timeout: 5), .completed)
    app.buttons["gym-session-movement"].firstMatch.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
    snapshot("record-\(appearance)", app: app)
    app.swipeUp()
    XCTAssertTrue(app.segmentedControls["gym-record-window"].exists)
    for _ in 0..<3 where app.segmentedControls["gym-record-window"].frame.minY < 180 {
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.4))
      start.press(forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 150)))
    }
    app.segmentedControls["gym-record-window"].buttons["All"].tap()
    XCTAssertTrue(app.staticTexts["the whole series · 35 workouts"].waitForExistence(timeout: 5))
    snapshot("record-all-\(appearance)", app: app)
    let chart = app.descendants(matching: .any)["gym-record-chart"]
    XCTAssertTrue(chart.exists)
    chart.press(forDuration: 0.5); chart.swipeRight()
    XCTAssertFalse(app.navigationBars.buttons["Rename"].exists)
    choose("gym-record-rename", from: "gym-record-more", app)
    XCTAssertTrue(app.textFields["gym-rename-movement-name"].waitForExistence(timeout: 5))
    snapshot("rename-\(appearance)", app: app)
    app.buttons["Cancel"].tap(); back(app)
    app.buttons["gym-session-share"].tap()
    let signIn = app.buttons["gym-share-sign-in"]
    XCTAssertTrue(signIn.waitForExistence(timeout: 5))
    XCTAssertEqual(signIn.label, "Sign in to share")
    XCTAssertFalse(app.buttons["gym-share-primary"].exists)
    snapshot("share-signed-out-\(appearance)", app: app)
    signIn.tap()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 5))
    app.navigationBars.buttons["Done"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
    XCTAssertFalse(signIn.waitForExistence(timeout: 2), "A sign-in left unfinished shares nothing")
    back(app)
    for _ in 0..<3 where !app.buttons["gym-bodyweight-door"].exists { app.swipeDown() }
    app.buttons["gym-bodyweight-door"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-bodyweight"].waitForExistence(timeout: 5))
    snapshot("bodyweight-\(appearance)", app: app)
    let crowdedPoint = app.buttons["gym-chart-point-2026-09-20"]
    XCTAssertTrue(crowdedPoint.waitForExistence(timeout: 5)); crowdedPoint.tap()
    let fixedDate = app.descendants(matching: .any)["gym-weigh-in-fixed-date"]
    XCTAssertTrue(fixedDate.waitForExistence(timeout: 5))
    snapshot("weigh-in-crowded-\(appearance)", app: app)
    var style = Date.FormatStyle.dateTime.weekday(.abbreviated).day().month(.abbreviated); style.timeZone = .gmt
    let expectedDate = style.format(Date(timeIntervalSince1970: 1_789_905_600))
    XCTAssertTrue(fixedDate.label.contains(expectedDate) || (fixedDate.value as? String ?? "").contains(expectedDate) || fixedDate.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", expectedDate)).firstMatch.exists)
    XCTAssertFalse(app.buttons["gym-weigh-in-save"].isEnabled, "A weigh-in left as it was has nothing to save")
    app.buttons["Cancel"].tap()
    app.segmentedControls["gym-bodyweight-window"].buttons["All"].tap()
    XCTAssertTrue(app.staticTexts["the whole series · 6 weigh-ins"].waitForExistence(timeout: 5))
    snapshot("bodyweight-all-\(appearance)", app: app)
    let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-weigh-in-2026-")).firstMatch
    XCTAssertTrue(row.exists); row.tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["gym-weigh-in-fixed-date"].exists)
    snapshot("weigh-in-\(appearance)", app: app)
    app.buttons["gym-weigh-in-delete"].tap()
    XCTAssertTrue(app.buttons["gym-log-undo"].waitForExistence(timeout: 5))
    app.buttons["gym-log-undo"].firstMatch.tap()
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    app.buttons["gym-chart-point-2026-09-26"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-weigh-in-fixed-date"].waitForExistence(timeout: 5))
    app.buttons["Cancel"].tap()
    back(app)
    let session = visibleSessionRow(app), id = session.identifier
    session.swipeLeft()
    let discard = app.buttons["Discard"]
    XCTAssertTrue(discard.wait(for: \.isHittable, toEqual: true, timeout: 5))
    snapshot("log-actions-\(appearance)", app: app)
    discard.tap()
    XCTAssertTrue(app.buttons[id].waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["gym-log-undo"].waitForExistence(timeout: 5))
    app.buttons["gym-log-undo"].firstMatch.tap()
    XCTAssertTrue(app.buttons[id].waitForExistence(timeout: 5))
  }
}
