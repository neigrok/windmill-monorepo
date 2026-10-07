import XCTest
import UIKit

@MainActor final class GymCoachFlowTests: XCTestCase {
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
    app.tabBars.buttons["Coach"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-coach"].waitForExistence(timeout: 10))
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  func more(_ name: String, _ app: XCUIApplication, snapshot: String? = nil) {
    let menu = app.buttons["coach-more"]
    let menuReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in menu.exists && menu.isHittable }, object: menu)
    XCTAssertEqual(XCTWaiter.wait(for: [menuReady], timeout: 5), .completed)
    menu.tap()
    let ids = ["History": "history", "Notes": "notes", "Connected log": "connections", "Gym settings": "settings"]
    let choices = app.sheets.firstMatch
    XCTAssertTrue(choices.waitForExistence(timeout: 5))
    if let snapshot { capture(snapshot, app) }
    let item = choices.buttons[name]
    let itemReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard item.exists else { return false }
      let frame = item.frame
      return frame.minX.isFinite && frame.minY.isFinite && frame.width > 0 && frame.height > 0 && item.isHittable
    }, object: item)
    XCTAssertEqual(XCTWaiter.wait(for: [itemReady], timeout: 5), .completed)
    item.tap()
    if ids[name] != nil { XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 5)) }
  }
  func back(_ app: XCUIApplication, expecting title: String? = nil) {
    let previous = app.navigationBars.firstMatch
    let previousTitle = previous.identifier
    app.navigationBars.buttons.element(boundBy: 0).tap()
    if let title {
      XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
      XCTAssertTrue(app.navigationBars[previousTitle].waitForNonExistence(timeout: 5))
      let menu = app.buttons["coach-more"]
      let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in menu.exists && menu.isHittable }, object: menu)
      XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
    }
  }
  func screens(_ appearance: String) {
    let suffix = appearance.lowercased(), app = launch(appearance)
    let question = app.descendants(matching: .any)["coach-question"]
    XCTAssertTrue(question.waitForExistence(timeout: 15)); capture("coach-empty-\(suffix)", app)
    question.tap(); question.typeText("Is Push A still doing anything?")
    app.buttons["coach-send"].tap()
    XCTAssertTrue(app.buttons["Review"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
    if app.keyboards.firstMatch.exists {
      let done = app.buttons["coach-keyboard-done"]
      XCTAssertTrue(done.waitForExistence(timeout: 5)); done.tap()
    }
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    capture("coach-answer-\(suffix)", app)
    app.scrollViews.firstMatch.swipeDown()
    XCTAssertTrue(app.buttons["Enlarge photo"].waitForExistence(timeout: 5)); app.buttons["Enlarge photo"].tap()
    XCTAssertTrue(app.navigationBars["Photo"].waitForExistence(timeout: 5)); capture("coach-photo-\(suffix)", app)
    app.buttons["Close"].tap()
    XCTAssertTrue(app.navigationBars["Photo"].waitForNonExistence(timeout: 5))
    let sources = app.buttons["read 214 sets · 6 weeks · 18 sessions"]
    let sourcesReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in sources.exists && sources.isHittable }, object: sources)
    XCTAssertEqual(XCTWaiter.wait(for: [sourcesReady], timeout: 5), .completed)
    sources.tap()
    let sourceWorkout = app.buttons["Push A workout"]
    XCTAssertTrue(sourceWorkout.waitForExistence(timeout: 5)); sourceWorkout.tap()
    capture("coach-source-workout-\(suffix)", app)
    app.buttons["Open workout"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
    back(app); app.tabBars.buttons["Coach"].tap()
    app.scrollViews.firstMatch.swipeUp()
    app.buttons["Review"].tap()
    XCTAssertTrue(app.buttons["coach-apply-proposal"].waitForExistence(timeout: 5))
    app.scrollViews.firstMatch.swipeUp(); capture("coach-review-\(suffix)", app)
    app.buttons["Turn this down"].tap()
    XCTAssertTrue(app.alerts["Turn this down?"].waitForExistence(timeout: 5))
    app.alerts.buttons["Keep it"].tap()
    app.scrollViews.firstMatch.swipeUp()
    XCTAssertTrue(app.buttons["coach-apply-proposal"].isEnabled)
    app.buttons["coach-apply-proposal"].tap()
    XCTAssertTrue(app.staticTexts["Applied"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "nothing here was")).firstMatch.exists)
    capture("coach-review-receipt-\(suffix)", app)
    app.buttons["Close"].tap()
    app.buttons["Open routine · Push A"].tap()
    XCTAssertTrue(app.navigationBars["Push A2"].waitForExistence(timeout: 5)); capture("coach-created-routine-\(suffix)", app)
    back(app); app.tabBars.buttons["Coach"].tap()
    more("History", app, snapshot: "coach-menu-\(suffix)")
    XCTAssertTrue(app.staticTexts["3 changes waiting"].waitForExistence(timeout: 5)); capture("coach-history-\(suffix)", app)
    XCTAssertFalse(app.tabBars.buttons["Coach"].isHittable)
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Is Push A still doing anything?")).firstMatch.tap()
    XCTAssertTrue(app.buttons["Review"].waitForExistence(timeout: 5))
    more("Notes", app)
    XCTAssertTrue(app.buttons["coach-add-note"].waitForExistence(timeout: 5)); capture("coach-notes-\(suffix)", app)
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
    more("Gym settings", app)
    let units = app.descendants(matching: .any)["gym-units"]
    if !units.waitForExistence(timeout: 10) { capture("coach-settings-arrival-\(suffix)", app); XCTFail("Gym settings did not open"); return }
    XCTAssertFalse(app.tabBars.buttons["Coach"].isHittable)
    app.buttons["lb"].tap()
    XCTAssertTrue(app.staticTexts["This phone still draws kg."].exists); capture("coach-settings-\(suffix)", app)
    back(app, expecting: "Coach")
    more("Connected log", app)
    XCTAssertTrue(app.staticTexts["Claude Desktop"].waitForExistence(timeout: 5)); capture("coach-connected-log-\(suffix)", app)
    XCTAssertFalse(app.tabBars.buttons["Coach"].isHittable)
    app.swipeUp(); app.buttons["How this works"].tap(); capture("coach-connected-disclosure-\(suffix)", app)
    back(app, expecting: "Coach")
    more("New chat", app)
    XCTAssertTrue(app.staticTexts["Ten questions a day, three back to back."].waitForExistence(timeout: 5))
    more("Account", app)
    XCTAssertTrue(app.buttons["about-windmill"].waitForExistence(timeout: 5))
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
    capture("coach-account-\(suffix)", app)
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["coach-more"].waitForExistence(timeout: 5))
    app.terminate()
  }
  func testLightScreensAndNativeNavigation() { screens("Light") }
  func testDarkScreensAndNativeNavigation() { screens("Dark") }
  func testRoutineRemovalKeepsItsReceiptInReviewAndConversation() {
    let app = launch("Light", arguments: ["-coach-removal"])
    let question = app.descendants(matching: .any)["coach-question"]
    XCTAssertTrue(question.waitForExistence(timeout: 10)); question.tap(); question.typeText("Remove Push A.")
    app.buttons["coach-send"].tap()
    XCTAssertTrue(app.buttons["Review"].waitForExistence(timeout: 10))
    if app.keyboards.firstMatch.exists { app.buttons["coach-keyboard-done"].tap() }
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    app.scrollViews.firstMatch.swipeUp(); app.buttons["Review"].tap()
    XCTAssertTrue(app.staticTexts["The whole routine is removed from your program. Every set you logged against it stays in the log."].waitForExistence(timeout: 5))
    let apply = app.buttons["coach-apply-proposal"]
    XCTAssertEqual(apply.label, "Remove Push A")
    app.scrollViews.firstMatch.swipeUp()
    XCTAssertTrue(apply.isEnabled); apply.tap()
    XCTAssertTrue(app.staticTexts["Applied"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["That proposal is gone."].exists)
    XCTAssertFalse(app.buttons["Turn this down"].exists)
    app.buttons["Close"].tap()
    XCTAssertTrue(app.staticTexts["applied"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Remove this routine."].exists)
    XCTAssertFalse(app.staticTexts["Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal."].exists)
    app.buttons["Review"].tap()
    XCTAssertTrue(app.staticTexts["Applied"].waitForExistence(timeout: 5))
    app.buttons["Close"].tap()
    app.tabBars.buttons["Routines"].tap()
    XCTAssertFalse(app.buttons["routine-coach-fixture-routine"].exists)
    app.tabBars.buttons["The log"].tap()
    XCTAssertTrue(app.buttons["gym-log-session-coach-fixture-session"].waitForExistence(timeout: 5))
    app.terminate()
  }
  func testAnonymousCoachExplainsAccountRequirementAndKeepsDoors() {
    for appearance in ["Light", "Dark"] {
      let suffix = appearance.lowercased(), app = launch(appearance, fixture: false)
      XCTAssertTrue(app.staticTexts["Coach reads your log, so it needs you signed in."].waitForExistence(timeout: 5))
      XCTAssertFalse(app.descendants(matching: .any)["coach-question"].exists)
      capture("coach-account-only-\(suffix)", app)
      more("Notes", app)
      XCTAssertTrue(app.staticTexts["Notes live with your account, so they need you signed in."].waitForExistence(timeout: 5))
      capture("coach-notes-account-only-\(suffix)", app)
      back(app, expecting: "Coach"); more("Connected log", app)
      XCTAssertTrue(app.buttons["coach-connect-tool"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.buttons["coach-connect-tool"].label, "Sign in first")
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
