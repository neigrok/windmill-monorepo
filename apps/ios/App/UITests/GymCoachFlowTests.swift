import XCTest
import UIKit

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

  func launch(_ appearance: String, fixture: Bool = true, arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "shell-last-room", "-onboarding-appearance", appearance.lowercased()] + arguments
    if fixture { app.launchArguments.append("-coach-fixture") }
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
  func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  func waitForVisible(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
    let viewport = app.frame
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let snapshot = try? element.snapshot() else { return false }
      return snapshot.isEnabled && !snapshot.frame.isEmpty && viewport.contains(snapshot.frame)
    }, object: nil)
    return XCTWaiter.wait(for: [ready], timeout: 30) == .completed
  }
  // Scrolling minimizes the tab bar to its selected tab; tapping that tab brings the other tabs back.
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
  func more(_ name: String, _ app: XCUIApplication, snapshot: String? = nil, expecting items: [String]? = nil) {
    let menu = app.buttons["coach-more"]
    XCTAssertTrue(waitForVisible(menu, in: app))
    XCTAssertTrue(menu.isHittable)
    menu.tap()
    let ids = ["History": "history", "Notes": "notes", "Connected log": "connections", "New chat": "new-chat"]
    let choices = app.buttons["coach-menu-history"]
    XCTAssertTrue(choices.waitForExistence(timeout: 5))
    if let items {
      let shown = ids.filter { app.buttons["coach-menu-" + $0.value].exists }.map(\.key)
      XCTAssertEqual(Set(shown), Set(items))
      XCTAssertFalse(app.buttons["coach-menu-settings"].exists || app.buttons["coach-menu-account"].exists)
    }
    if let snapshot { capture(snapshot, app) }
    let item = app.buttons["coach-menu-" + (ids[name] ?? name)]
    XCTAssertTrue(item.wait(for: \.isHittable, toEqual: true, timeout: 10))
    let frame = item.frame
    XCTAssertTrue(frame.minX.isFinite && frame.minY.isFinite && frame.width > 0 && frame.height > 0)
    item.tap()
    XCTAssertTrue(choices.waitForNonExistence(timeout: 10))
    if ["History", "Notes", "Connected log"].contains(name) { XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 5)) }
  }
  func ask(_ question: String, _ app: XCUIApplication) {
    let field = app.descendants(matching: .any)["coach-question"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["coach-send"].isEnabled, "An empty question cannot be sent.")
    field.tap(); field.typeText(question)
    let done = app.buttons["coach-keyboard-done"], send = app.buttons["coach-send"]
    XCTAssertTrue(done.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertFalse(done.frame.intersects(send.frame))
    send.tap()
    XCTAssertTrue(app.buttons["coach-review"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(done.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
  }
  func back(_ app: XCUIApplication, expecting title: String? = nil) {
    let previous = app.navigationBars.firstMatch
    let previousTitle = previous.identifier
    let button = previous.buttons.element(boundBy: 0)
    XCTAssertTrue(waitForVisible(button, in: app))
    XCTAssertTrue(button.isHittable)
    let frame = button.frame
    XCTAssertTrue(frame.minX.isFinite && frame.minY.isFinite && frame.width > 0 && frame.height > 0)
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY)).press(forDuration: 0.1)
    XCTAssertTrue(app.navigationBars[previousTitle].waitForNonExistence(timeout: 5))
    if let title {
      XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
      let menu = app.buttons["coach-more"]
      XCTAssertTrue(waitForVisible(menu, in: app))
      XCTAssertTrue(menu.isHittable)
    }
  }
  func screens(_ appearance: String) {
    let suffix = appearance.lowercased(), app = launch(appearance)
    let question = app.descendants(matching: .any)["coach-question"]
    XCTAssertTrue(question.waitForExistence(timeout: 15))
    for removed in ["Ten questions a day, three back to back.", "what you write for Coach", "Coach needs a connection.",
                    "Every conversation is kept so you can read it back, and yours to delete."] {
      XCTAssertFalse(app.staticTexts[removed].exists, "The empty room draws no \(removed)")
    }
    capture("coach-empty-\(suffix)", app)
    ask("Is Push A still doing anything?", app)
    capture("coach-answer-\(suffix)", app)
    app.scrollViews.firstMatch.swipeDown()
    XCTAssertTrue(app.buttons["Enlarge photo"].waitForExistence(timeout: 5)); app.buttons["Enlarge photo"].tap()
    XCTAssertTrue(app.navigationBars["Photo"].waitForExistence(timeout: 5)); capture("coach-photo-\(suffix)", app)
    app.buttons["Close"].tap()
    XCTAssertTrue(app.navigationBars["Photo"].waitForNonExistence(timeout: 5))
    let sources = app.buttons["coach-read-receipt"]
    XCTAssertTrue(waitForVisible(sources, in: app))
    XCTAssertEqual(sources.label, "read 214 sets · 6 weeks · 18 sessions")
    sources.tap()
    XCTAssertTrue(app.navigationBars["What Coach read"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Read your recent workouts"].exists && app.staticTexts["Read your notes"].exists)
    let sourceWorkout = app.buttons["coach-source-coach-fixture-session"]
    XCTAssertTrue(sourceWorkout.waitForExistence(timeout: 5))
    XCTAssertTrue(sourceWorkout.label.hasPrefix("Push A workout"), sourceWorkout.label)
    XCTAssertTrue(sourceWorkout.label.contains("1 working set · 400 kg"), sourceWorkout.label)
    capture("coach-sources-\(suffix)", app)
    sourceWorkout.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
    back(app)
    openTab("Coach", app)
    let review = app.buttons["coach-review"]
    XCTAssertTrue(waitForVisible(review, in: app))
    XCTAssertEqual(review.label, "Review 3 changes"); XCTAssertEqual(review.value as? String, "still waiting")
    XCTAssertTrue(app.staticTexts["Back Squat"].exists && app.staticTexts["1 × 5 · 80 → 1 × 3 · 90"].exists)
    XCTAssertTrue(app.staticTexts["Bench Press"].exists && app.staticTexts["added · open"].exists)
    XCTAssertFalse(app.staticTexts["Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal."].exists)
    review.tap()
    let apply = app.buttons["coach-apply-proposal"]
    XCTAssertTrue(apply.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "proposed by Coach")).firstMatch.exists)
    XCTAssertFalse(app.staticTexts["Coach wrote:"].exists)
    let gated = apply.frame
    capture("coach-review-\(suffix)", app)
    app.scrollViews.firstMatch.swipeUp()
    XCTAssertTrue(apply.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    XCTAssertEqual(apply.frame, gated, "Apply never moves when the caption slot changes.")
    capture("coach-review-actions-\(suffix)", app)
    app.buttons["Turn this down"].tap()
    XCTAssertTrue(app.alerts["Turn this down?"].waitForExistence(timeout: 5))
    app.alerts.buttons["Keep it"].tap()
    app.scrollViews.firstMatch.swipeUp()
    XCTAssertTrue(apply.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    apply.tap()
    XCTAssertTrue(app.staticTexts["Applied"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "nothing here was")).firstMatch.exists)
    capture("coach-review-receipt-\(suffix)", app)
    app.buttons["Close"].tap()
    XCTAssertTrue(review.waitForValue("applied", timeout: 5))
    app.buttons["Open routine · Push A"].tap()
    XCTAssertTrue(app.navigationBars["Push A2"].waitForExistence(timeout: 5)); capture("coach-created-routine-\(suffix)", app)
    back(app)
    XCTAssertTrue(app.navigationBars["Routines"].waitForExistence(timeout: 5))
    openTab("Coach", app)
    more("History", app, snapshot: "coach-menu-\(suffix)", expecting: ["New chat", "History", "Notes", "Connected log"])
    let conversation = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Is Push A still doing anything?")).firstMatch
    XCTAssertTrue(conversation.waitForExistence(timeout: 5))
    XCTAssertTrue(conversation.label.contains("3 changes waiting"), conversation.label)
    XCTAssertFalse(app.buttons["Ask something new"].exists)
    XCTAssertFalse(app.staticTexts["Deleting a conversation keeps applied routine changes, created routines and saved notes."].exists)
    capture("coach-history-\(suffix)", app)
    XCTAssertFalse(app.tabBars.buttons["Coach"].isHittable)
    conversation.swipeLeft()
    let delete = app.buttons["Delete"]
    XCTAssertTrue(delete.waitForExistence(timeout: 5)); delete.tap()
    XCTAssertTrue(app.staticTexts["Deleting a conversation keeps applied routine changes, created routines and saved notes."].waitForExistence(timeout: 5))
    capture("coach-history-deleted-\(suffix)", app)
    app.buttons["coach-engine-undo"].tap()
    XCTAssertTrue(conversation.waitForExistence(timeout: 5)); conversation.tap()
    XCTAssertTrue(app.buttons["coach-review"].waitForExistence(timeout: 5))
    more("Notes", app)
    XCTAssertTrue(app.buttons["coach-add-note"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Any agent you connect can read these too."].exists)
    XCTAssertFalse(app.staticTexts["what you write for Coach"].exists || app.staticTexts["Top note wins."].exists)
    capture("coach-notes-\(suffix)", app)
    XCTAssertFalse(app.tabBars.buttons["Coach"].isHittable)
    app.buttons["coach-add-note"].tap()
    let title = app.descendants(matching: .any)["coach-note-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 5)); title.tap(); title.typeText("Training focus")
    let body = app.descendants(matching: .any)["coach-note-body"]
    body.tap(); body.typeText("Keep the squat steady.")
    capture("coach-note-editor-\(suffix)", app)
    app.buttons["coach-note-save"].tap()
    XCTAssertTrue(app.staticTexts["Training focus"].waitForExistence(timeout: 5))
    back(app, expecting: "Coach")
    more("Connected log", app)
    XCTAssertTrue(app.staticTexts["Claude Desktop"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Your log, read by Claude, Cursor or Codex."].exists, "The head line steps aside for what is connected.")
    XCTAssertEqual(app.buttons["coach-connect-tool"].label, "Connect a tool")
    capture("coach-connected-log-\(suffix)", app)
    XCTAssertFalse(app.tabBars.buttons["Coach"].isHittable)
    app.swipeUp(); app.buttons["How this works"].tap(); capture("coach-connected-disclosure-\(suffix)", app)
    back(app, expecting: "Coach")
    more("New chat", app)
    XCTAssertTrue(app.buttons["coach-review"].waitForNonExistence(timeout: 5))
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["you-gym-settings"].waitForExistence(timeout: 5))
    guard let accountImage = app.screenshot().image.cgImage,
          let background = accountImage.cropping(to: CGRect(x: CGFloat(accountImage.width / 2), y: CGFloat(accountImage.height * 9 / 10), width: 1, height: 1)) else {
      XCTFail("Account screenshot has no background sample"); return
    }
    var pixel = [UInt8](repeating: 0, count: 4)
    pixel.withUnsafeMutableBytes { bytes in
      guard let context = CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        XCTFail("Account screenshot color could not be read"); return
      }
      context.draw(background, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    }
    let brightness = (Double(pixel[0]) + Double(pixel[1]) + Double(pixel[2])) / (3 * 255)
    if appearance == "Light" { XCTAssertGreaterThan(brightness, 0.7, "Gym Account must follow light appearance") }
    else { XCTAssertLessThan(brightness, 0.3, "Gym Account must follow dark appearance") }
    app.buttons["you-gym-settings"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-settings"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.descendants(matching: .any)["gym-units"].exists || app.buttons["Account"].exists)
    XCTAssertTrue(app.buttons["Notes"].exists)
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Connected log")).firstMatch.waitForExistence(timeout: 5))
    capture("coach-settings-\(suffix)", app)
    app.terminate()
  }
  func testLightScreensAndNativeNavigation() { screens("Light") }
  func testDarkScreensAndNativeNavigation() { screens("Dark") }
  func testRoutineRemovalKeepsItsReceiptInReviewAndConversation() {
    let app = launch("Light", arguments: ["-coach-removal"])
    ask("Remove Push A.", app)
    let review = app.buttons["coach-review"]
    XCTAssertEqual(review.label, "Review removal")
    app.scrollViews.firstMatch.swipeUp(); review.tap()
    XCTAssertTrue(app.staticTexts["The whole routine is removed from your program. Every set you logged against it stays in the log."].waitForExistence(timeout: 5))
    let apply = app.buttons["coach-apply-proposal"]
    XCTAssertEqual(apply.label, "Remove Push A")
    app.scrollViews.firstMatch.swipeUp()
    XCTAssertTrue(apply.wait(for: \.isEnabled, toEqual: true, timeout: 5)); apply.tap()
    XCTAssertTrue(app.staticTexts["Applied"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["That proposal is gone."].exists)
    XCTAssertFalse(app.buttons["Turn this down"].exists)
    app.buttons["Close"].tap()
    XCTAssertTrue(review.waitForValue("applied", timeout: 5))
    XCTAssertTrue(app.staticTexts["Remove this routine."].exists)
    review.tap()
    XCTAssertTrue(app.staticTexts["Applied"].waitForExistence(timeout: 5))
    app.buttons["Close"].tap()
    openTab("Routines", app)
    XCTAssertFalse(app.buttons["routine-coach-fixture-routine"].exists)
    openTab("The log", app)
    XCTAssertTrue(app.buttons["gym-log-session-coach-fixture-session"].waitForExistence(timeout: 5))
    app.terminate()
  }
  func testRemovalWaitingOnTheLogOffersRetryAfterFifteenSeconds() {
    let app = launch("Light", arguments: ["-coach-removal", "-coach-removal-stall"])
    ask("Remove Push A.", app)
    app.scrollViews.firstMatch.swipeUp(); app.buttons["coach-review"].tap()
    let apply = app.buttons["coach-apply-proposal"]
    XCTAssertTrue(apply.waitForExistence(timeout: 5))
    app.scrollViews.firstMatch.swipeUp()
    XCTAssertTrue(apply.wait(for: \.isEnabled, toEqual: true, timeout: 5)); apply.tap()
    XCTAssertTrue(app.staticTexts["Waiting for the log…"].waitForExistence(timeout: 5))
    capture("coach-review-waiting-light", app)
    XCTAssertTrue(app.staticTexts["Still waiting for the log."].waitForExistence(timeout: 25))
    XCTAssertFalse(app.staticTexts["Waiting for the log…"].exists)
    capture("coach-review-still-waiting-light", app)
    app.buttons["coach-review-retry"].tap()
    XCTAssertTrue(app.staticTexts["Waiting for the log…"].waitForExistence(timeout: 5))
    app.terminate()
  }
  func testLongReviewGatesApplyUntilItsEndWithoutMovingIt() {
    let app = launch("Light", arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
    ask("Is Push A still doing anything?", app)
    let review = app.buttons["coach-review"]
    for _ in 0..<4 where !review.isHittable { app.scrollViews.firstMatch.swipeUp() }
    review.tap()
    let apply = app.buttons["coach-apply-proposal"]
    XCTAssertTrue(apply.waitForExistence(timeout: 5))
    XCTAssertFalse(apply.isEnabled, "Apply waits until the diff has been seen to its end.")
    let gated = apply.frame
    capture("coach-review-gate-ax3", app)
    for _ in 0..<6 where !apply.isEnabled { app.scrollViews.firstMatch.swipeUp() }
    XCTAssertTrue(apply.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    XCTAssertEqual(apply.frame, gated, "Apply never moves when the caption slot changes.")
    capture("coach-review-promise-ax3", app)
    app.terminate()
  }
  func testOfflineRoomRaisesTheBandAndDimsSend() {
    for appearance in ["Light", "Dark"] {
      let suffix = appearance.lowercased(), app = launch(appearance, arguments: ["-coach-offline"])
      let band = app.staticTexts["Coach needs a connection."]
      XCTAssertTrue(band.waitForExistence(timeout: 10))
      let question = app.descendants(matching: .any)["coach-question"]
      XCTAssertTrue(question.waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["coach-send"].isEnabled)
      capture("coach-offline-\(suffix)", app)
      app.buttons["Dismiss message"].tap()
      XCTAssertTrue(band.waitForNonExistence(timeout: 5))
      question.tap(); question.typeText("How is my training?")
      app.buttons["coach-send"].tap()
      XCTAssertTrue(band.waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["coach-review"].exists)
      XCTAssertEqual(question.value as? String, "How is my training?")
      capture("coach-offline-send-\(suffix)", app)
      app.terminate()
    }
  }
  func testAnonymousCoachExplainsAccountRequirementAndKeepsDoors() {
    for appearance in ["Light", "Dark"] {
      let suffix = appearance.lowercased(), app = launch(appearance, fixture: false)
      XCTAssertTrue(app.staticTexts["Coach reads your log, so it needs you signed in."].waitForExistence(timeout: 5))
      XCTAssertFalse(app.descendants(matching: .any)["coach-question"].exists)
      XCTAssertTrue(app.buttons["coach-sign-in"].exists)
      capture("coach-account-only-\(suffix)", app)
      more("Notes", app, expecting: ["History", "Notes", "Connected log"])
      XCTAssertTrue(app.staticTexts["Notes live with your account, so they need you signed in."].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["coach-sign-in"].exists)
      capture("coach-notes-account-only-\(suffix)", app)
      back(app, expecting: "Coach"); more("Connected log", app)
      XCTAssertTrue(app.buttons["coach-connect-tool"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.buttons["coach-connect-tool"].label, "Sign in first")
      XCTAssertTrue(app.staticTexts["Your log, read by Claude, Cursor or Codex."].exists)
      capture("coach-connected-account-only-\(suffix)", app)
      app.buttons["coach-connect-tool"].tap()
      XCTAssertTrue(app.buttons["about-windmill"].waitForExistence(timeout: 5))
      app.terminate()
    }
  }
  func testUnavailableDeploymentKeepsNotesAndConnectedLog() {
    for appearance in ["Light", "Dark"] {
      let suffix = appearance.lowercased(), app = launch(appearance, arguments: ["-coach-unavailable"])
      let question = app.descendants(matching: .any)["coach-question"]
      XCTAssertTrue(question.waitForExistence(timeout: 10)); question.tap(); question.typeText("How is my training?")
      app.buttons["coach-send"].tap()
      XCTAssertTrue(app.staticTexts["Coach isn’t part of this Windmill. Your log is still yours to read."].waitForExistence(timeout: 10))
      XCTAssertFalse(question.exists)
      capture("coach-unavailable-\(suffix)", app)
      more("Notes", app)
      XCTAssertTrue(app.buttons["coach-add-note"].waitForExistence(timeout: 5))
      back(app, expecting: "Coach"); more("Connected log", app)
      XCTAssertTrue(app.buttons["coach-connect-tool"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.buttons["coach-connect-tool"].label, "Connect a tool")
      app.terminate()
    }
  }
}
