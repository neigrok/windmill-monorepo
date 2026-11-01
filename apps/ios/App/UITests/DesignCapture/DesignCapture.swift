import XCTest

// The look a capture is taken in. A capture's name is its screen, then -375 on a 375 pt phone, -ax3 at the largest text and
// the appearance last: 02.1-routines-dark, 05.1-log-ax3-daylight.
struct Look {
  enum Appearance: String, CaseIterable { case dark, daylight }
  let appearance: Appearance
  var largestText = false

  static let both = Appearance.allCases.map { Look(appearance: $0) }
  static let dark = [Look(appearance: .dark)]
  static let bothAtLargestText = Appearance.allCases.map { Look(appearance: $0, largestText: true) }

  var launchArguments: [String] {
    ["-onboarding-appearance", appearance == .dark ? "dark" : "light"]
      + (largestText ? ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"] : [])
  }
  @MainActor func name(_ screen: String, on app: XCUIApplication) -> String {
    screen + (app.frame.width < 380 ? "-375" : "") + (largestText ? "-ax3" : "") + "-" + appearance.rawValue
  }
}

enum GymTab: String {
  case routines = "Routines", log = "The log", coach = "Coach"

  var screen: String {
    switch self {
    case .routines: "gym-routines"
    case .log: "gym-log"
    case .coach: "gym-coach"
    }
  }
}

// The opt-in design review suite: each area's captures subclass this in their own file beside it.
// Opt in with TEST_RUNNER_WM_DESIGN_CAPTURE=1 when invoking xcodebuild.
@MainActor class DesignCapture: XCTestCase {
  override func setUpWithError() throws {
    try super.setUpWithError()
    try XCTSkipUnless(ProcessInfo.processInfo.environment["WM_DESIGN_CAPTURE"] == "1", "Design capture is opt-in.")
    continueAfterFailure = false
  }

  override func tearDown() async throws {
    await MainActor.run { XCUIApplication().terminate() }
    try await super.tearDown()
  }

  func launch(_ fixture: String, _ look: Look, arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", fixture] + look.launchArguments + arguments
    app.launch()
    return app
  }
  func capture(_ screen: String, _ look: Look, _ app: XCUIApplication, settle seconds: Double = 1.0) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = look.name(screen, on: app); attachment.lifetime = .keepAlways; add(attachment)
  }
  // One board in each look, Dark and Daylight unless named: `open` launches the app in the look and brings up the board's screen.
  func captureBoard(_ screen: String, in looks: [Look] = Look.both, settle seconds: Double = 1.0, opening open: (Look) -> XCUIApplication) {
    for look in looks {
      let app = open(look)
      capture(screen, look, app, settle: seconds)
      app.terminate()
    }
  }

  // An empty gym opens on Coach; a gym holding routines or workouts opens on Routines.
  func openGymFromJournal(_ app: XCUIApplication, opensOn first: GymTab) {
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    let menu = app.buttons["room-menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 10)); menu.tap()
    let gym = app.roomItem("Gym")
    XCTAssertTrue(gym.waitForExistence(timeout: 5)); gym.tap()
    XCTAssertTrue(app.descendants(matching: .any)[first.screen].waitForExistence(timeout: 15))
  }
  // -coach-fixture signs in once Coach opens and seeds a routine, notes, a workout and a waiting proposal.
  func launchSignedInCoach(_ look: Look, arguments: [String] = []) -> XCUIApplication {
    let app = launch("shell-last-room", look, arguments: ["-coach-fixture"] + arguments)
    openGymFromJournal(app, opensOn: .routines)
    open(.coach, app)
    XCTAssertTrue(app.descendants(matching: .any)["coach-question"].waitForExistence(timeout: 20))
    return app
  }
  func openGymFromWelcome(_ app: XCUIApplication, opensOn first: GymTab) {
    XCTAssertTrue(app.buttons["open-gym"].waitForExistence(timeout: 15)); app.buttons["open-gym"].tap()
    XCTAssertTrue(app.descendants(matching: .any)[first.screen].waitForExistence(timeout: 15))
  }
  func open(_ tab: GymTab, _ app: XCUIApplication) {
    let button = app.tabBars.buttons[tab.rawValue]
    XCTAssertTrue(button.waitForExistence(timeout: 10)); button.tap()
    XCTAssertTrue(app.descendants(matching: .any)[tab.screen].waitForExistence(timeout: 10))
  }
  func closeSheet(_ app: XCUIApplication) {
    for _ in 0..<3 {
      let bar = app.navigationBars
      if bar.buttons["Done"].exists { bar.buttons["Done"].tap(); break }
      if bar.buttons["Close"].exists { bar.buttons["Close"].tap(); break }
      let back = bar.buttons["Back"]
      XCTAssertTrue(back.waitForExistence(timeout: 5)); back.tap()
    }
    let sheet = app.navigationBars.matching(NSPredicate(format: "identifier IN %@", ["You", "Keep", "Sign in", "Apple", "Sign out"])).firstMatch
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))
  }
  func back(_ app: XCUIApplication) {
    let button = app.navigationBars.firstMatch.buttons.element(boundBy: 0)
    XCTAssertTrue(button.wait(for: \.isHittable, toEqual: true, timeout: 5)); button.tap()
  }
  // A row below the fold, at 375 points or the largest text, scrolls into reach before it is tapped.
  func reach(_ element: XCUIElement, _ app: XCUIApplication) -> XCUIElement {
    _ = element.waitForExistence(timeout: 5)
    for _ in 0..<8 where !(element.exists && element.isHittable) { app.swipeUp(velocity: .slow) }
    XCTAssertTrue(element.isHittable)
    return element
  }
  func roomMenuOpen(_ screen: String, _ look: Look, _ app: XCUIApplication, current: String) {
    let menu = app.buttons["room-menu"]
    XCTAssertTrue(menu.wait(for: \.isHittable, toEqual: true, timeout: 10)); menu.tap()
    XCTAssertTrue(app.roomItem("Journal").waitForExistence(timeout: 5))
    capture(screen, look, app, settle: 0.6)
    app.roomItem(current).tap()
    XCTAssertTrue(app.roomItem("Journal").waitForNonExistence(timeout: 5))
  }
  // A lazy list keeps rows it scrolled away with an empty frame, and asking those for hittability raises.
  func onScreen(_ element: XCUIElement, _ app: XCUIApplication) -> Bool {
    element.exists && !element.frame.isEmpty && app.frame.intersects(element.frame) && element.isHittable
  }
  // Drags without momentum until the element sits fully inside the content between the bar and the tab bar, then lets the list settle.
  func revealInLog(_ element: XCUIElement, _ app: XCUIApplication) {
    for _ in 0..<12 {
      let top = app.navigationBars.firstMatch.frame.maxY + 8
      let bottom = (app.tabBars.firstMatch.exists ? app.tabBars.firstMatch.frame.minY : app.frame.maxY - 100) - 12
      if onScreen(element, app), element.frame.minY > top, element.frame.maxY < bottom { break }
      let down = element.exists && !element.frame.isEmpty && element.frame.minY <= top
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0)).withOffset(CGVector(dx: 0, dy: (top + bottom) / 2))
      start.press(forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 0, dy: down ? 160 : -160)), withVelocity: .slow, thenHoldForDuration: 0.2)
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.4))
    XCTAssertTrue(element.isHittable)
  }
}
