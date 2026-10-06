import XCTest

@MainActor final class OnboardingFlowTests: XCTestCase {
  let titles = ["Three ways to grow.", "Map what you're learning.", "A page a night.", "Log the set."]
  let bodies = [
    "One account keeps them together. You can start without one.",
    "Your goal as a skill tree. Each step opens the next, and you watch it grow.",
    "Write a line or a page, in your own words. Nothing is graded or shared.",
    "Two taps a set, and next time your numbers are already there."
  ]
  let glimpses = [
    "Example of three rooms: Roadmap, Journal, Gym",
    "Example of a skill tree: Learn to sail, three steps open, three locked",
    "Example of a journal page: yesterday above, tonight below, mood and energy unasked",
    "Example of a set being logged: squat, 100 kilograms for 5"
  ]

  func testFirstLaunchFourScreensThenWhereToStart() {
    let app = launch()
    for page in 0..<4 {
      assertPage(page, in: app)
      XCTAssertFalse(app.buttons["open-journal"].exists)
      app.buttons["onboarding-next"].tap()
    }
    assertWhereToStart(in: app)
    XCTAssertFalse(app.textViews["journal-editor"].exists)
  }

  func testSkipFromEverySkippablePage() {
    for skippedPage in 0..<3 {
      let app = launch()
      for page in 0..<skippedPage {
        assertPage(page, in: app)
        app.buttons["onboarding-next"].tap()
      }
      assertPage(skippedPage, in: app)
      app.buttons["onboarding-exit"].tap()
      assertWhereToStart(in: app)
      app.terminate()
    }
  }

  func testSwipeBackAndLastPageStaysInPager() {
    let app = launch()
    assertPage(0, in: app)
    app.swipeLeft()
    assertPage(1, in: app)
    app.swipeRight()
    assertPage(0, in: app)
    for page in 0..<3 {
      assertPage(page, in: app)
      app.buttons["onboarding-next"].tap()
    }
    assertPage(3, in: app)
    app.swipeLeft()
    assertPage(3, in: app)
    XCTAssertFalse(app.buttons["open-journal"].exists)
    app.buttons["onboarding-next"].tap()
    assertWhereToStart(in: app)
  }

  func testSwipeImmediatelyAfterArrivalChangesPage() {
    let app = launch()
    XCTAssertTrue(app.staticTexts[titles[0]].waitForExistence(timeout: 10))
    app.swipeLeft()
    assertPage(1, in: app)
    app.swipeRight()
    assertPage(0, in: app)
  }

  func testFittingPagesDoNotCaptureVerticalSwipes() {
    let app = launch()
    for page in 0..<3 {
      assertPage(page, in: app)
      let title = app.staticTexts[titles[page]]
      let frame = title.frame
      let scroll = app.scrollViews.firstMatch
      let lastContent = app.staticTexts[page == 0 ? bodies[page] : page == 1 ? "On the web" : "In this app"]
      // A page may need to scroll even at normal text sizes; navigation stays pinned either way.
      let overflow = max(0, lastContent.frame.maxY + 16 - scroll.frame.maxY)
      let primary = app.buttons["onboarding-next"], control = app.pageIndicators["onboarding-page-control"]
      let primaryFrame = primary.frame, controlFrame = control.frame
      scroll.swipeUp(velocity: .fast)
      XCTAssertEqual(title.frame.minX, frame.minX, accuracy: 0.5)
      XCTAssertEqual(title.frame.size.width, frame.size.width, accuracy: 0.5)
      XCTAssertEqual(title.frame.size.height, frame.size.height, accuracy: 0.5)
      if overflow <= 0.5 { XCTAssertEqual(title.frame.minY, frame.minY, accuracy: 0.5) }
      else {
        XCTAssertLessThan(title.frame.minY, frame.minY)
        XCTAssertGreaterThanOrEqual(title.frame.minY, frame.minY - overflow - 0.5)
      }
      XCTAssertEqual(primary.frame, primaryFrame)
      XCTAssertEqual(control.frame, controlFrame)
      XCTAssertTrue(primary.isHittable)
      app.swipeLeft(velocity: .fast)
      assertPage(page + 1, in: app)
    }
  }

  func testReplayFromYouCanExitFromEveryPage() {
    let app = launch()
    assertPage(0, in: app)
    app.buttons["onboarding-exit"].tap()
    assertWhereToStart(in: app)
    app.buttons["open-journal"].tap()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    editor.tap()
    let doneWriting = app.buttons["done-writing"]
    XCTAssertTrue(doneWriting.waitForExistence(timeout: 5))
    doneWriting.tap()
    app.buttons["you"].tap()
    let about = app.buttons["about-windmill"]
    XCTAssertTrue(about.waitForExistence(timeout: 5))
    XCTAssertEqual(about.label, "About Windmill")
    for exitPage in 0..<4 {
      about.tap()
      for page in 0..<exitPage {
        assertPage(page, in: app, replay: true)
        app.buttons["onboarding-next"].tap()
      }
      assertPage(exitPage, in: app, replay: true)
      app.buttons["onboarding-exit"].tap()
      XCTAssertTrue(about.waitForExistence(timeout: 5))
      XCTAssertFalse(app.staticTexts["onboarding-title"].exists)
      XCTAssertFalse(app.buttons["open-journal"].exists)
    }
    app.buttons["Done"].tap()
    XCTAssertTrue(editor.waitForExistence(timeout: 5))
    XCTAssertEqual(editor.value as? String, "")
  }

  func testReplayLastPrimaryReturnsToYou() {
    let app = launch("onboarding-room")
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 10))
    app.buttons["you"].tap()
    let about = app.buttons["about-windmill"]
    XCTAssertTrue(about.waitForExistence(timeout: 5))
    about.tap()
    for page in 0..<4 {
      assertPage(page, in: app, replay: true)
      app.buttons["onboarding-next"].tap()
    }
    XCTAssertTrue(about.waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["onboarding-title"].exists)
    XCTAssertFalse(app.buttons["open-journal"].exists)
  }

  func testPhoneHoldingRoomDoesNotShowIntroduction() {
    let app = launch("onboarding-room")
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["you"].exists)
    XCTAssertFalse(app.staticTexts["onboarding-title"].exists)
    XCTAssertFalse(app.buttons["onboarding-next"].exists)
    XCTAssertFalse(app.buttons["open-journal"].exists)
    XCTAssertFalse((app.textViews["journal-editor"].value as? String ?? "").isEmpty)
  }

  func testSignedInPhoneDoesNotShowIntroduction() {
    let app = launch("onboarding-signed-in")
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["onboarding-title"].exists)
    XCTAssertFalse(app.buttons["onboarding-next"].exists)
  }

  func testDeepLinkDoesNotShowIntroduction() {
    let app = launch("onboarding-deep-link")
    XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["onboarding-title"].exists)
    XCTAssertFalse(app.buttons["onboarding-next"].exists)
  }

  func testLargestAccessibilityTextKeepsPrimaryPinned() {
    let app = launch(arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    for page in 0..<4 {
      assertPage(page, in: app)
      let primary = app.buttons["onboarding-next"]
      XCTAssertTrue(primary.isHittable)
      XCTAssertGreaterThanOrEqual(primary.frame.height, 52)
      XCTAssertLessThanOrEqual(primary.frame.maxY, app.frame.maxY)
      XCTAssertGreaterThan(primary.frame.minY, app.frame.midY)
      let frame = primary.frame
      let scroll = app.scrollViews.firstMatch
      XCTAssertTrue(scroll.exists)
      XCTAssertLessThanOrEqual(scroll.frame.maxY, app.pageIndicators["onboarding-page-control"].frame.minY)
      if page == 0 {
        let firstPaint = XCTAttachment(screenshot: app.screenshot())
        firstPaint.name = "onboarding-largest-text-first-paint"
        firstPaint.lifetime = .keepAlways
        add(firstPaint)
      }
      let body = app.staticTexts[bodies[page]]
      let bodyTop = body.frame.minY
      scroll.swipeUp()
      XCTAssertLessThan(body.frame.minY, bodyTop)
      XCTAssertTrue(primary.isHittable)
      XCTAssertEqual(primary.frame, frame)
      let title = app.staticTexts.matching(identifier: "onboarding-title").matching(NSPredicate(format: "label == %@", titles[page])).firstMatch
      XCTAssertGreaterThan(title.frame.height, 0)
      let scrolled = XCTAttachment(screenshot: app.screenshot())
      scrolled.name = "onboarding-largest-text-page-\(page + 1)"
      scrolled.lifetime = .keepAlways
      add(scrolled)
      primary.tap()
    }
    assertWhereToStart(in: app)
  }

  func testAccessibilityElementsAndReadingOrder() {
    let app = launch()
    for page in 0..<4 {
      assertPage(page, in: app)
      let snapshot = app.debugDescription
      let identifiers = snapshot.components(separatedBy: "Path to element:")[0].split(separator: "\n")
        .compactMap { text -> String? in
          guard let start = text.range(of: "identifier: '")?.upperBound else { return nil }
          let value = text[start...]
          guard value.hasPrefix("onboarding-"), let end = value.firstIndex(of: "'") else { return nil }
          return String(value[..<end])
        }
      let expected: [String]
      if page == 0 {
        expected = ["onboarding-identity", "onboarding-exit", "onboarding-title", "onboarding-body", "onboarding-glimpse", "onboarding-page-control", "onboarding-next"]
      } else {
        expected = (page < 3 ? ["onboarding-exit"] : []) + ["onboarding-eyebrow", "onboarding-title", "onboarding-body", "onboarding-tag", "onboarding-glimpse", "onboarding-page-control", "onboarding-next"]
      }
      XCTAssertEqual(identifiers, expected, snapshot)
      let glimpse = app.descendants(matching: .any).matching(identifier: "onboarding-glimpse")
        .matching(NSPredicate(format: "label == %@", glimpses[page])).firstMatch
      XCTAssertEqual(glimpse.staticTexts.count, 0)
      XCTAssertEqual(glimpse.buttons.count, 0)
      XCTAssertEqual(glimpse.images.count, 0)
      let tree = XCTAttachment(string: snapshot)
      tree.name = "onboarding-accessibility-page-\(page + 1)"
      tree.lifetime = .keepAlways
      add(tree)
      app.buttons["onboarding-next"].tap()
    }
  }

  func testScreenshotsInDarkAndLight() {
    for appearance in ["dark", "light"] {
      let app = launch(arguments: ["-onboarding-appearance", appearance])
      for page in 0..<4 {
        assertPage(page, in: app)
        RunLoop.current.run(until: Date().addingTimeInterval(1.6))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "onboarding-\(appearance)-\(page + 1)"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["onboarding-next"].tap()
      }
      app.terminate()
    }
  }

  func launch(_ board: String = "onboarding-fresh", arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board] + arguments
    app.launch()
    return app
  }

  func assertPage(_ page: Int, in app: XCUIApplication, replay: Bool = false, file: StaticString = #filePath, line: UInt = #line) {
    let title = app.staticTexts.matching(identifier: "onboarding-title").matching(NSPredicate(format: "label == %@", titles[page])).firstMatch
    XCTAssertTrue(title.waitForExistence(timeout: 10), file: file, line: line)
    XCTAssertTrue(app.staticTexts[bodies[page]].exists, file: file, line: line)
    let glimpse = app.descendants(matching: .any).matching(identifier: "onboarding-glimpse")
      .matching(NSPredicate(format: "label == %@", glimpses[page])).firstMatch
    XCTAssertTrue(glimpse.exists, file: file, line: line)
    let control = app.pageIndicators["onboarding-page-control"]
    XCTAssertTrue(control.exists, file: file, line: line)
    XCTAssertEqual(app.pageIndicators.count, 1, file: file, line: line)
    XCTAssertEqual(control.label, "Page \(page + 1) of 4", file: file, line: line)
    if page > 0 {
      XCTAssertTrue(app.staticTexts[["ROADMAP", "JOURNAL", "GYM"][page - 1]].exists, file: file, line: line)
      XCTAssertTrue(app.staticTexts[["On the web", "In this app", "In this app"][page - 1]].exists, file: file, line: line)
    }
    let exit = app.buttons["onboarding-exit"]
    if replay || page < 3 {
      XCTAssertTrue(exit.exists, file: file, line: line)
      XCTAssertEqual(exit.label, replay ? "Done" : "Skip", file: file, line: line)
    } else {
      XCTAssertFalse(exit.exists, file: file, line: line)
    }
    let next = app.buttons["onboarding-next"]
    XCTAssertTrue(next.isHittable, file: file, line: line)
    XCTAssertEqual(next.label, page < 3 ? "Next" : replay ? "Done" : "Get started", file: file, line: line)
  }

  func assertWhereToStart(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10), file: file, line: line)
    XCTAssertTrue(app.buttons["open-gym"].exists, file: file, line: line)
    XCTAssertTrue(app.staticTexts["Where to start?"].exists, file: file, line: line)
    XCTAssertFalse(app.staticTexts["onboarding-title"].exists, file: file, line: line)
  }
}
