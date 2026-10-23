import XCTest

// The four introduction pages as the onboarding flows read them, and Where to start? after them.
@MainActor struct OnboardingPages {
  let app: XCUIApplication
  static let titles = ["Three ways to grow.", "Map what you're learning.", "A page a night.", "Log the set."]
  static let bodies = [
    "One account keeps them together. You can start without one.",
    "Your goal as a skill tree. Each step opens the next, and you watch it grow.",
    "Write a line or a page, in your own words. Nothing is graded or shared.",
    "Two taps a set, and next time your numbers are already there."
  ]
  static let glimpses = [
    "Example of three rooms: Roadmap, Journal, Gym",
    "Example of a skill tree: Learn to sail, three steps open, three locked",
    "Example of a journal page: yesterday above, tonight below, mood and energy unasked",
    "Example of a set being logged: squat, 100 kilograms for 5"
  ]

  static func launch(arguments: [String] = []) -> OnboardingPages {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "onboarding-fresh"] + arguments
    app.launch()
    return OnboardingPages(app: app)
  }

  func title(_ page: Int) -> XCUIElement {
    app.staticTexts.matching(identifier: "onboarding-title").matching(NSPredicate(format: "label == %@", Self.titles[page])).firstMatch
  }

  func glimpse(_ page: Int) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: "onboarding-glimpse").matching(NSPredicate(format: "label == %@", Self.glimpses[page])).firstMatch
  }

  // The page names where it lives; Skip stands on the first three, Done on every page of a replay.
  func assertPage(_ page: Int, replay: Bool = false, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(title(page).waitForExistence(timeout: 10), file: file, line: line)
    XCTAssertTrue(app.staticTexts[Self.bodies[page]].exists, file: file, line: line)
    XCTAssertTrue(glimpse(page).exists, file: file, line: line)
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

  func assertWhereToStart(file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10), file: file, line: line)
    XCTAssertTrue(app.buttons["open-gym"].exists, file: file, line: line)
    XCTAssertTrue(app.staticTexts["Where to start?"].exists, file: file, line: line)
    XCTAssertFalse(app.staticTexts["onboarding-title"].exists, file: file, line: line)
  }
}
