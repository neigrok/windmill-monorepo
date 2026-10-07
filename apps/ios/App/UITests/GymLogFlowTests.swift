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
  func visibleSessionRow(_ app: XCUIApplication) -> XCUIElement {
    let first = sessionRow(app)
    XCTAssertTrue(first.waitForExistence(timeout: 20))
    let row = app.buttons[first.identifier]
    for _ in 0..<8 {
      let frame = row.frame, top = app.navigationBars.firstMatch.frame.maxY + 8
      let bottom = app.buttons["gym-weigh-in"].frame.minY - 12
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
    XCTAssertLessThan(row.frame.maxY, app.buttons["gym-weigh-in"].frame.minY - 12)
    return row
  }
  func openFirstSession(_ app: XCUIApplication) {
    visibleSessionRow(app).tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
  }
  func firstSet(_ app: XCUIApplication) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-finished-set-")).firstMatch
  }

  func testEmptyLogAndWeighInRefusals() {
    let app = launch("dark", seeded: false)
    XCTAssertTrue(app.staticTexts["No sessions yet"].exists)
    app.buttons["gym-weigh-in"].tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5))
    app.buttons["gym-weigh-in-save"].tap()
    XCTAssertTrue(app.staticTexts["That is not a number yet."].exists)
    let field = app.textFields["gym-weigh-in-weight"]
    field.tap(); field.typeText("19")
    app.buttons["gym-weigh-in-save"].tap()
    XCTAssertTrue(app.staticTexts["Between 20 and 400 kg — check the number."].exists)
    field.tap(); field.typeText("\u{8}\u{8}82.4")
    app.buttons["gym-weigh-in-save"].tap()
    XCTAssertTrue(app.buttons["gym-weigh-in"].waitForExistence(timeout: 5))
    app.buttons["gym-bodyweight-door"].tap()
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-weigh-in-2026-")).firstMatch.waitForExistence(timeout: 5))
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
    picker.buttons["All"].tap()
    XCTAssertTrue(app.staticTexts["All · 35 sessions"].waitForExistence(timeout: 5))
    snapshot("window-check", app: app)
    picker.buttons["12 weeks"].tap()
    snapshot("window-recent-check", app: app)
    XCTAssertTrue(picker.buttons["12 weeks"].isSelected)
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Last 12 weeks ·")).firstMatch.waitForExistence(timeout: 5))
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
    XCTAssertTrue(app.staticTexts["All · 35 sessions"].waitForExistence(timeout: 5))
    assertDateAxisFollowsPan(app, chartID: "gym-record-chart")
    back(app); back(app)
    let bodyweight = app.buttons["gym-bodyweight-door"]
    let top = app.navigationBars.firstMatch.frame.maxY + 8
    let bottom = app.buttons["gym-weigh-in"].frame.minY - 12
    for _ in 0..<3 {
      if bodyweight.exists {
        let frame = bodyweight.frame
        if frame.minY > top && frame.maxY < bottom && bodyweight.isHittable { break }
      }
      app.swipeDown()
    }
    XCTAssertTrue(bodyweight.isHittable)
    XCTAssertGreaterThan(bodyweight.frame.minY, top)
    XCTAssertLessThan(bodyweight.frame.maxY, bottom)
    bodyweight.tap()
    let weightsWindow = app.segmentedControls["gym-bodyweight-window"]
    XCTAssertTrue(weightsWindow.waitForExistence(timeout: 5))
    selectAllChartHistory(weightsWindow, app: app)
    XCTAssertTrue(app.staticTexts["All · 40 weigh-ins"].waitForExistence(timeout: 5))
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

  func testOlderSessionsAndFirstSessionFooter() {
    let app = launch("dark")
    let older = app.buttons["gym-log-older"]
    for _ in 0..<20 {
      if older.exists && older.isHittable && older.frame.maxY < app.buttons["gym-weigh-in"].frame.minY - 24 { break }
      app.swipeUp(velocity: .fast)
    }
    XCTAssertTrue(older.exists)
    XCTAssertLessThan(older.frame.maxY, app.buttons["gym-weigh-in"].frame.minY - 24)
    snapshot("log-older-before", app: app)
    older.tap()
    snapshot("log-older-after", app: app)
    let first = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "First session ·")).firstMatch
    for _ in 0..<5 {
      if first.exists && first.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(first.exists)
    XCTAssertFalse(older.exists)
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
    let momentHeader = app.buttons.matching(identifier: "gym-best-moment")
      .matching(NSPredicate(format: "label CONTAINS %@", " · new best")).firstMatch
    for _ in 0..<12 {
      if momentHeader.exists {
        let frame = momentHeader.frame
        if frame.width > 0 && frame.height > 0 && frame.minY > app.navigationBars.firstMatch.frame.maxY + 8
            && frame.maxY < app.buttons["gym-weigh-in"].frame.minY - 12 && momentHeader.isHittable { break }
      }
      app.swipeUp(velocity: .slow)
    }
    let momentLabel = momentHeader.label
    let moments = app.buttons.matching(identifier: "gym-best-moment")
      .matching(NSPredicate(format: "label == %@", momentLabel))
    let moment = moments.firstMatch
    XCTAssertTrue(moment.isHittable)
    moment.tap()
    XCTAssertTrue(moments.matching(NSPredicate(format: "value == %@", "Expanded"))
      .firstMatch.waitForExistence(timeout: 5))
    // The native disclosure applies its identifier to the expanded List rows.
    let openRecord = app.buttons["Open record"]
    XCTAssertTrue(openRecord.waitForExistence(timeout: 5))
    XCTAssertTrue(openRecord.isHittable)
    snapshot("moment-\(appearance)", app: app)
    moment.tap()
    XCTAssertTrue(moments.matching(NSPredicate(format: "value == %@", "Collapsed"))
      .firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(openRecord.waitForNonExistence(timeout: 5))
    snapshot("moment-collapsed-\(appearance)", app: app)
    openFirstSession(app)
    XCTAssertTrue(app.staticTexts["Plan saved at start"].exists)
    snapshot("session-\(appearance)", app: app)
    let correctedSet = firstSet(app)
    correctedSet.tap()
    XCTAssertTrue(app.textFields["gym-fix-weight"].waitForExistence(timeout: 5))
    snapshot("fix-\(appearance)", app: app)
    let weight = app.textFields["gym-fix-weight"]
    weight.doubleTap()
    let cut = app.descendants(matching: .any).matching(NSPredicate(
      format: "(label == %@ OR identifier == %@) AND elementType IN %@", "Cut", "Cut",
      [XCUIElement.ElementType.menuItem.rawValue, XCUIElement.ElementType.button.rawValue])).firstMatch
    XCTAssertTrue(cut.waitForExistence(timeout: 5))
    cut.tap()
    let cleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let value = weight.value as? String else { return false }
      return (value.isEmpty || value == weight.placeholderValue) && !app.buttons["gym-fix-save"].isEnabled
    }, object: weight)
    XCTAssertEqual(XCTWaiter.wait(for: [cleared], timeout: 5), .completed)
    weight.typeText("90")
    let entered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "90"), object: weight)
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
    XCTAssertTrue(app.staticTexts["All · 35 sessions"].waitForExistence(timeout: 5))
    snapshot("record-all-\(appearance)", app: app)
    let chart = app.descendants(matching: .any)["gym-record-chart"]
    XCTAssertTrue(chart.exists)
    chart.press(forDuration: 0.5); chart.swipeRight()
    app.buttons["Rename"].tap()
    XCTAssertTrue(app.textFields["gym-rename-name"].waitForExistence(timeout: 5))
    snapshot("rename-\(appearance)", app: app)
    app.buttons["Cancel"].tap(); back(app)
    app.swipeUp()
    app.buttons["gym-session-share"].tap()
    XCTAssertTrue(app.buttons["Get a link"].waitForExistence(timeout: 5))
    snapshot("share-\(appearance)", app: app)
    app.buttons["Get a link"].tap()
    XCTAssertTrue(app.staticTexts["sharing needs your account — sign in first"].waitForExistence(timeout: 5))
    snapshot("share-refusal-\(appearance)", app: app)
    app.buttons["Close"].tap(); back(app)
    for _ in 0..<3 where !app.buttons["gym-bodyweight-door"].exists { app.swipeDown() }
    app.buttons["gym-bodyweight-door"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-bodyweight"].waitForExistence(timeout: 5))
    snapshot("bodyweight-\(appearance)", app: app)
    let crowdedPoint = app.buttons["gym-chart-point-2026-09-20"]
    XCTAssertTrue(crowdedPoint.waitForExistence(timeout: 5)); crowdedPoint.tap()
    let fixedDate = app.descendants(matching: .any)["gym-weigh-in-fixed-date"]
    XCTAssertTrue(fixedDate.waitForExistence(timeout: 5))
    snapshot("weigh-in-crowded-\(appearance)", app: app)
    let expectedDate = Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 9, day: 20))!
      .formatted(.dateTime.day().month(.wide).year())
    XCTAssertTrue(fixedDate.label.contains(expectedDate) || (fixedDate.value as? String ?? "").contains(expectedDate) || fixedDate.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", expectedDate)).firstMatch.exists)
    app.buttons["Cancel"].tap()
    app.segmentedControls["gym-bodyweight-window"].buttons["All"].tap()
    XCTAssertTrue(app.staticTexts["All · 6 weigh-ins"].waitForExistence(timeout: 5))
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
    visibleSessionRow(app).press(forDuration: 1)
    XCTAssertFalse(app.descendants(matching: .any)["gym-session-detail"].exists)
    XCTAssertTrue(app.buttons["Share this workout"].waitForExistence(timeout: 5))
    let discard = app.buttons["Discard workout"]
    XCTAssertTrue(discard.wait(for: \.isHittable, toEqual: true, timeout: 5))
    snapshot("log-actions-\(appearance)", app: app)
    discard.tap()
    XCTAssertTrue(app.buttons["gym-log-undo"].waitForExistence(timeout: 5))
    app.buttons["gym-log-undo"].firstMatch.tap()
  }
}
