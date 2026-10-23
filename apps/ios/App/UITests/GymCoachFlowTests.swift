import XCTest

@MainActor final class GymCoachFlowTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
    addUIInterruptionMonitor(withDescription: "Wait for notification banners to dismiss") { interruption in
      MainActor.assumeIsolated {
        guard interruption.identifier == "NotificationShortLookView" else { return false }
        return interruption.waitForNonExistence(timeout: 30)
      }
    }
  }

  // The board's clock stands at noon UTC on Sep 26; the app reads it in UTC and en_US, so every time it draws is fixed.
  func launch(arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["TZ"] = "UTC"
    app.launchArguments = ["-model-server", "-board", "shell-last-room", "-onboarding-appearance", "light",
                           "-AppleLocale", "en_US", "-AppleLanguages", "(en)", "-coach-fixture"] + arguments
    app.launch()
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    let menu = app.buttons["room-menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 10)); menu.tap()
    let gym = app.buttons["room-gym"]
    XCTAssertTrue(gym.waitForExistence(timeout: 5)); gym.tap()
    openTab("Coach", app)
    XCTAssertTrue(app.descendants(matching: .any)["gym-coach"].waitForExistence(timeout: 10))
    return app
  }
  func waitForVisible(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
    let viewport = app.frame
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let snapshot = try? element.snapshot() else { return false }
      return snapshot.isEnabled && !snapshot.frame.isEmpty && viewport.contains(snapshot.frame)
    }, object: nil)
    return XCTWaiter.wait(for: [ready], timeout: 30) == .completed
  }
  // Other tabs may minimize while scrolling; Coach keeps all tabs visible.
  func openTab(_ name: String, _ app: XCUIApplication) {
    let viewport = app.frame
    let tabBar = app.tabBars.firstMatch
    var minimized = false
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let bar = try? tabBar.snapshot(), !bar.frame.isEmpty, viewport.contains(bar.frame) else { return false }
      @MainActor func buttons(_ element: any XCUIElementSnapshot) -> [any XCUIElementSnapshot] {
        (element.elementType == .button ? [element] : []) + element.children.flatMap(buttons)
      }
      let shown = buttons(bar).filter { $0.isEnabled && !$0.frame.isEmpty && viewport.contains($0.frame) }
      minimized = shown.contains { $0.value as? String == "Collapsed" }
      return minimized || shown.contains { $0.identifier == name || $0.label == name }
    }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
    if minimized { app.tabBars.buttons.firstMatch.tap() }
    let tab = app.tabBars.buttons[name]
    XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: true, timeout: 10)); tab.tap()
  }
  func ask(_ question: String, _ app: XCUIApplication) {
    let field = app.descendants(matching: .any)["coach-question"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["coach-send"].exists, "An empty question has no Send.")
    field.tap(); field.typeText(question)
    let done = app.buttons["coach-keyboard-done"], send = app.buttons["coach-send"]
    let keyboard = app.keyboards.firstMatch, tab = app.tabBars.buttons["Coach"]
    XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
    XCTAssertTrue(done.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: false, timeout: 5))
    XCTAssertFalse(done.frame.intersects(send.frame))
    done.tap()
    XCTAssertTrue(done.waitForNonExistence(timeout: 5))
    XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))
    XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertEqual(field.value as? String, question)
    field.tap()
    XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
    XCTAssertTrue(done.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: false, timeout: 5))
    send.tap()
    XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(done.waitForNonExistence(timeout: 5))
    XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))
    XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: true, timeout: 5))
  }
  func back(_ app: XCUIApplication) {
    let previous = app.navigationBars.firstMatch
    let previousTitle = previous.identifier
    let button = previous.buttons.element(boundBy: 0)
    XCTAssertTrue(waitForVisible(button, in: app))
    let frame = button.frame
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY)).press(forDuration: 0.1)
    XCTAssertTrue(app.navigationBars[previousTitle].waitForNonExistence(timeout: 5))
  }

  // Signed in: a question gets an answer with a proposal; What Coach read lists the workout it read, which opens its
  // detail; Show all reveals every change, Apply applies them, and History keeps the conversation, which reopens.
  func testAskReadReceiptApplyAndHistory() {
    let app = launch()
    ask("Is Push A still doing anything?", app)
    let sources = app.buttons["coach-read-receipt"]
    XCTAssertTrue(waitForVisible(sources, in: app))
    XCTAssertEqual(sources.label, "Read 1 workout · 1 week")
    sources.tap()
    XCTAssertTrue(app.navigationBars["What Coach read"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["1 workout · 1 week"].exists && app.staticTexts["Also read your notes."].exists)
    let sourceWorkout = app.buttons["coach-source-coach-fixture-session"]
    XCTAssertTrue(sourceWorkout.waitForExistence(timeout: 5))
    XCTAssertTrue(sourceWorkout.label.hasPrefix("Push A"), sourceWorkout.label)
    XCTAssertTrue(sourceWorkout.label.hasSuffix(" · 1 working set · 400 kg"), sourceWorkout.label)
    sourceWorkout.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
    back(app)
    openTab("Coach", app)
    XCTAssertFalse(app.descendants(matching: .any)["coach-proposal-header"].exists)
    app.buttons["coach-history"].tap()
    let previous = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Is Push A still doing anything?")).firstMatch
    XCTAssertTrue(previous.waitForExistence(timeout: 5)); previous.tap()
    let card = app.descendants(matching: .any)["coach-proposal-header"]
    XCTAssertTrue(waitForVisible(card, in: app))
    XCTAssertEqual(card.value as? String ?? "", "")
    let apply = app.buttons["coach-apply-proposal"], reject = app.buttons["coach-reject-proposal"]
    for _ in 0..<4 where !apply.isHittable { app.scrollViews.firstMatch.swipeUp() }
    XCTAssertEqual(apply.label, "Apply")
    XCTAssertTrue(reject.isEnabled)
    let expand = app.buttons["coach-proposal-expand"]
    XCTAssertEqual(expand.label, "Show all 3 changes")
    expand.tap()
    XCTAssertTrue(expand.waitForLabel("Show less", timeout: 5))
    for _ in 0..<4 where !apply.isHittable { app.scrollViews.firstMatch.swipeUp() }
    apply.tap()
    XCTAssertTrue(card.waitForValue("Applied", timeout: 10))
    XCTAssertFalse(apply.exists || reject.exists)
    let history = app.buttons["coach-history"]
    XCTAssertTrue(waitForVisible(history, in: app)); history.tap()
    XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
    let conversation = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Is Push A still doing anything?")).firstMatch
    XCTAssertTrue(conversation.waitForExistence(timeout: 5))
    XCTAssertFalse(conversation.label.contains("waiting"), conversation.label)
    conversation.tap()
    XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForExistence(timeout: 5))
  }
  func testFreshCanvasKeepsThePendingAnswerAndDraftInHistory() {
    let app = launch(arguments: ["-coach-streaming"])
    let question = app.descendants(matching: .any)["coach-question"]
    question.tap(); question.typeText("What should Thursday look like?")
    app.buttons["coach-send"].tap()
    XCTAssertTrue(app.buttons["coach-stop"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    app.scrollViews.firstMatch.swipeUp()
    for name in ["Routines", "The log", "Coach"] {
      XCTAssertTrue(app.tabBars.buttons[name].isHittable, "Coach scrolling keeps every tab visible")
    }
    openTab("Routines", app); openTab("Coach", app)
    XCTAssertTrue(app.descendants(matching: .any)["coach-answer-in-progress"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["coach-stop"].exists)
    question.tap(); question.typeText("A separate draft")
    XCTAssertFalse(app.buttons["coach-send"].isEnabled)
    app.buttons["coach-keyboard-done"].tap()
    app.buttons["coach-view-answer"].tap()
    XCTAssertTrue(app.buttons["coach-stop"].waitForExistence(timeout: 5))
    app.buttons["coach-stop"].tap()
    XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
    app.buttons["coach-history"].tap()
    let draft = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "A separate draft")).firstMatch
    XCTAssertTrue(draft.waitForExistence(timeout: 5)); draft.tap()
    XCTAssertEqual(question.value as? String, "A separate draft")
    XCTAssertTrue(app.buttons["coach-send"].isEnabled)
  }
}
