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

  // The board's clock stands at noon UTC on Sep 26; the app reads it in UTC and en_US, so every time it draws is fixed.
  func launch(_ appearance: String, fixture: Bool = true, arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["TZ"] = "UTC"
    app.launchArguments = ["-model-server", "-board", "shell-last-room", "-onboarding-appearance", appearance.lowercased(),
                           "-AppleLocale", "en_US", "-AppleLanguages", "(en)"] + arguments
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
  func openDestination(_ name: String, _ app: XCUIApplication) {
    XCTAssertFalse(app.buttons["coach-more"].exists)
    if name == "History" || name == "New chat" {
      let history = app.buttons["coach-history"]
      XCTAssertTrue(waitForVisible(history, in: app)); history.tap()
      XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
      if name == "New chat" { app.buttons["coach-new-chat"].tap() }
      return
    }
    app.buttons["you"].tap()
    let item = app.buttons[name == "Notes" ? "settings-notes" : "settings-connected-log"]
    XCTAssertTrue(item.waitForExistence(timeout: 5))
    for _ in 0..<3 where !item.isHittable { app.swipeUp() }
    item.tap()
    XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 5))
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
    capture("coach-composer-focused", app)
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
  func back(_ app: XCUIApplication, expecting title: String? = nil, control: String = "coach-history") {
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
      if title == "Coach", app.navigationBars["You"].waitForExistence(timeout: 1) {
        app.navigationBars["You"].buttons["Done"].tap()
      }
      XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
      let menu = app.buttons[control]
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
    XCTAssertFalse(app.staticTexts["Three triples at 90 keeps the weekly tonnage and gives you a top set to push."].exists, "The card has no body")
    XCTAssertFalse(app.buttons["Open routine · Push A"].exists, "A pending proposal's conversation created no routine")
    app.scrollViews.firstMatch.swipeDown()
    XCTAssertTrue(app.buttons["Enlarge photo"].waitForExistence(timeout: 5)); app.buttons["Enlarge photo"].tap()
    let cover = app.descendants(matching: .any)["coach-photo-cover"]
    XCTAssertTrue(cover.waitForExistence(timeout: 5))
    XCTAssertFalse(app.navigationBars["Photo"].exists || app.buttons["Close"].exists, "The photo is a cover with no title and no Close")
    capture("coach-photo-\(suffix)", app)
    cover.swipeDown(velocity: .fast)
    XCTAssertTrue(cover.waitForNonExistence(timeout: 5))
    let sources = app.buttons["coach-read-receipt"]
    XCTAssertTrue(waitForVisible(sources, in: app))
    XCTAssertEqual(sources.label, "Read 1 workout · 1 week")
    sources.tap()
    XCTAssertTrue(app.navigationBars["What Coach read"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["1 workout · 1 week"].exists && app.staticTexts["Also read your notes."].exists)
    XCTAssertFalse(app.staticTexts["Read your recent workouts"].exists)
    let sourceWorkout = app.buttons["coach-source-coach-fixture-session"]
    XCTAssertTrue(sourceWorkout.waitForExistence(timeout: 5))
    XCTAssertTrue(sourceWorkout.label.hasPrefix("Push A"), sourceWorkout.label)
    XCTAssertTrue(sourceWorkout.label.hasSuffix(" · 1 working set · 400 kg"), sourceWorkout.label)
    capture("coach-sources-\(suffix)", app)
    sourceWorkout.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
    back(app)
    openTab("Coach", app)
    let card = app.descendants(matching: .any)["coach-proposal-header"]
    XCTAssertTrue(waitForVisible(card, in: app))
    XCTAssertEqual(card.value as? String ?? "", "")
    let apply = app.buttons["coach-apply-proposal"], reject = app.buttons["coach-reject-proposal"]
    for _ in 0..<4 where !apply.isHittable { app.scrollViews.firstMatch.swipeUp() }
    XCTAssertEqual(apply.label, "Apply")
    XCTAssertTrue(reject.isEnabled)
    let expand = app.buttons["coach-proposal-expand"]
    XCTAssertEqual(expand.label, "Show all 3 changes")
    capture("coach-proposal-\(suffix)", app)
    expand.tap()
    XCTAssertTrue(expand.waitForLabel("Show less", timeout: 5))
    for _ in 0..<4 where !apply.isHittable { app.scrollViews.firstMatch.swipeUp() }
    capture("coach-proposal-expanded-\(suffix)", app)
    apply.tap()
    XCTAssertTrue(card.waitForValue("Applied", timeout: 10))
    XCTAssertFalse(apply.exists || reject.exists)
    XCTAssertFalse(app.descendants(matching: .any)["coach-proposal-out-of-date"].exists, "An applied proposal is not out of date")
    capture("coach-proposal-applied-\(suffix)", app)
    openDestination("History", app)
    let conversation = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Is Push A still doing anything?")).firstMatch
    XCTAssertTrue(conversation.waitForExistence(timeout: 5))
    XCTAssertFalse(conversation.label.contains("waiting"), conversation.label)
    XCTAssertFalse(app.buttons["Ask something new"].exists)
    capture("coach-history-\(suffix)", app)
    XCTAssertFalse(app.tabBars.buttons["Coach"].isHittable)
    conversation.tap()
    XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForExistence(timeout: 5))
    openDestination("Notes", app)
    XCTAssertTrue(app.buttons["coach-add-note"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Agents you connect can also read these."].exists)
    XCTAssertFalse(app.staticTexts["what you write for Coach"].exists || app.staticTexts["Top note wins."].exists)
    capture("coach-notes-\(suffix)", app)
    XCTAssertFalse(app.tabBars.buttons["Coach"].isHittable)
    app.buttons["coach-add-note"].tap()
    let save = app.buttons["coach-note-save"]
    XCTAssertTrue(save.waitForExistence(timeout: 5)); XCTAssertFalse(save.isEnabled, "A note with no text cannot save")
    let text = app.descendants(matching: .any)["coach-note-text"]
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    text.typeText("Training focus\nKeep the squat steady.")
    XCTAssertFalse(app.buttons["coach-note-keyboard-done"].exists || app.buttons["Done"].exists, "Nothing but the bar commits the note")
    capture("coach-note-editor-\(suffix)", app)
    XCTAssertTrue(save.isEnabled); save.tap()
    let saved = app.staticTexts["Training focus\nKeep the squat steady."]
    XCTAssertTrue(saved.waitForExistence(timeout: 5)); saved.tap()
    XCTAssertTrue(save.waitForExistence(timeout: 5)); XCTAssertFalse(save.isEnabled, "An unchanged note cannot save")
    app.buttons["Cancel"].tap()
    back(app, expecting: "Coach")
    openDestination("Connected log", app)
    XCTAssertTrue(app.staticTexts["Claude Desktop"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Your log, read by ChatGPT or Claude."].exists, "The head line steps aside for what is connected.")
    XCTAssertFalse(app.buttons["Manage connections"].exists || app.staticTexts["Read"].exists, "Connected leads and nothing repeats it")
    XCTAssertTrue(app.buttons["coach-connection-grant:fixture"].exists)
    XCTAssertEqual(app.buttons["coach-connect-tool"].label, "Connect a tool")
    capture("coach-connected-log-\(suffix)", app)
    XCTAssertFalse(app.tabBars.buttons["Coach"].isHittable)
    app.buttons["coach-connected-how"].tap()
    XCTAssertTrue(app.navigationBars["How this works"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["No tool can apply a proposal or edit a logged set."].exists && app.staticTexts["Read"].exists)
    capture("coach-connected-disclosure-\(suffix)", app)
    back(app); back(app, expecting: "Coach")
    openDestination("New chat", app)
    XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForNonExistence(timeout: 5))
    app.buttons["you"].tap()
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
    app.terminate()
  }
  func testHistoryConfirmsDeleteAndKeepsItDeletedAfterReopen() {
    let app = launch("Light")
    ask("Is Push A still doing anything?", app)
    openDestination("History", app)
    let conversation = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Is Push A still doing anything?")).firstMatch
    XCTAssertTrue(conversation.waitForExistence(timeout: 5))
    conversation.swipeLeft()
    app.buttons["trash-swipe"].tap()
    XCTAssertTrue(app.buttons["Delete conversation"].waitForExistence(timeout: 5))
    app.cancelConfirmation()
    XCTAssertTrue(app.buttons["Delete conversation"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(conversation.exists)
    conversation.swipeLeft(); app.buttons["trash-swipe"].tap()
    XCTAssertTrue(app.buttons["Delete conversation"].waitForExistence(timeout: 5)); app.buttons["Delete conversation"].tap()
    XCTAssertTrue(app.staticTexts["No conversations"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["coach-engine-undo"].exists)
    back(app, expecting: "Coach")
    openDestination("History", app)
    XCTAssertTrue(app.staticTexts["No conversations"].waitForExistence(timeout: 5))
    app.terminate()
  }
  func testLightScreensAndNativeNavigation() { screens("Light") }
  func testDarkScreensAndNativeNavigation() { screens("Dark") }
  func testWhatCoachWroteOpensFromItsRowsAndTheReceiptSaysNothingWasRead() {
    let app = launch("Light", arguments: ["-coach-created"])
    let field = app.descendants(matching: .any)["coach-question"]
    XCTAssertTrue(field.waitForExistence(timeout: 15)); field.tap(); field.typeText("Build me a routine.")
    app.buttons["coach-send"].tap()
    let created = app.buttons["Open routine · Push A"]
    XCTAssertTrue(created.waitForExistence(timeout: 10))
    XCTAssertEqual(app.descendants(matching: .any)["coach-read-receipt"].label, "Read nothing from your log")
    XCTAssertFalse(app.descendants(matching: .any)["coach-proposal"].exists)
    let note = app.buttons["coach-saved-note"]
    XCTAssertEqual(note.label, "Saved a note")
    capture("coach-created-routine-light", app)
    note.tap()
    XCTAssertTrue(app.navigationBars["Notes"].waitForExistence(timeout: 5))
    back(app, expecting: "Coach")
    created.tap()
    XCTAssertTrue(app.navigationBars["Push A"].waitForExistence(timeout: 5))
    app.terminate()
  }
  func testRoutineRemovalKeepsItsReceiptInTheConversation() {
    let app = launch("Light", arguments: ["-coach-removal"])
    ask("Remove Push A.", app)
    let card = app.descendants(matching: .any)["coach-proposal-header"]
    XCTAssertEqual(app.descendants(matching: .any)["coach-read-receipt"].label, "Read your movement history")
    XCTAssertFalse(app.buttons["coach-read-receipt"].exists, "A read with no workout to list is not a door")
    XCTAssertFalse(app.staticTexts["Push A has stopped moving your squat."].exists, "The card has no body")
    let apply = app.buttons["coach-apply-proposal"]
    for _ in 0..<4 where !apply.isHittable { app.scrollViews.firstMatch.swipeUp() }
    XCTAssertEqual(apply.label, "Remove routine")
    apply.tap()
    XCTAssertTrue(card.waitForValue("Removed", timeout: 10))
    XCTAssertFalse(app.staticTexts["That proposal is gone."].exists)
    XCTAssertFalse(apply.exists || app.buttons["coach-reject-proposal"].exists)
    openTab("Routines", app)
    XCTAssertFalse(app.buttons["routine-coach-fixture-routine"].exists)
    openTab("The log", app)
    XCTAssertTrue(app.buttons["gym-log-session-coach-fixture-session"].waitForExistence(timeout: 5))
    openTab("Coach", app)
    XCTAssertTrue(card.waitForValue("Removed", timeout: 5))
    app.terminate()
  }
  func testAnOutOfDateProposalSaysWhyWhereApplyStood() {
    let app = launch("Light", arguments: ["-coach-out-of-date"])
    ask("Is Push A still doing anything?", app)
    XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForValue("Out of date", timeout: 10))
    let why = app.staticTexts["coach-proposal-out-of-date"]
    for _ in 0..<4 where !why.isHittable { app.scrollViews.firstMatch.swipeUp() }
    XCTAssertEqual(why.label, "A newer suggestion replaced this one. Nothing was applied.")
    XCTAssertFalse(app.buttons["coach-apply-proposal"].exists || app.buttons["coach-reject-proposal"].exists)
    capture("coach-proposal-out-of-date-light", app)
    app.terminate()
  }
  func testRemovalWaitingOnTheLogOffersTryAgainAfterFifteenSeconds() {
    let app = launch("Light", arguments: ["-coach-removal", "-coach-decision-stall"])
    ask("Remove Push A.", app)
    let apply = app.buttons["coach-apply-proposal"]
    for _ in 0..<4 where !apply.isHittable { app.scrollViews.firstMatch.swipeUp() }
    let place = apply.frame
    apply.tap()
    XCTAssertTrue(apply.waitForLabel("Removing…", timeout: 5))
    XCTAssertFalse(apply.isEnabled); XCTAssertEqual(apply.frame, place, "Apply keeps its place while it waits")
    XCTAssertFalse(app.buttons["coach-reject-proposal"].isEnabled)
    capture("coach-proposal-waiting-light", app)
    XCTAssertTrue(apply.waitForLabel("Try again", timeout: 25))
    XCTAssertFalse(app.descendants(matching: .any)["coach-proposal-failure"].exists, "A wait alone states no cause")
    XCTAssertTrue(apply.isEnabled); XCTAssertFalse(app.buttons["coach-reject-proposal"].isEnabled)
    capture("coach-proposal-still-waiting-light", app)
    apply.tap()
    XCTAssertTrue(apply.waitForLabel("Removing…", timeout: 5))
    app.terminate()
  }
  func testTheCardsDecisionStaysReachableAtTheLargestText() {
    let app = launch("Light", arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
    ask("Is Push A still doing anything?", app)
    let expand = app.buttons["coach-proposal-expand"], apply = app.buttons["coach-apply-proposal"]
    for _ in 0..<6 where !expand.isHittable { app.scrollViews.firstMatch.swipeUp() }
    expand.tap()
    XCTAssertTrue(expand.waitForLabel("Show less", timeout: 5))
    for _ in 0..<8 where !apply.isHittable { app.scrollViews.firstMatch.swipeUp() }
    XCTAssertTrue(apply.isHittable && apply.isEnabled)
    XCTAssertTrue(app.buttons["coach-reject-proposal"].isHittable)
    capture("coach-proposal-ax3", app)
    app.terminate()
  }
  func testOfflineRoomRaisesTheBandAndDimsSend() {
    for appearance in ["Light", "Dark"] {
      let suffix = appearance.lowercased(), app = launch(appearance, arguments: ["-coach-offline"])
      let band = app.staticTexts["Coach needs a connection."]
      XCTAssertTrue(band.waitForExistence(timeout: 10))
      let question = app.descendants(matching: .any)["coach-question"]
      XCTAssertTrue(question.waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["coach-send"].exists)
      capture("coach-offline-\(suffix)", app)
      app.buttons["Dismiss message"].tap()
      XCTAssertTrue(band.waitForNonExistence(timeout: 5))
      question.tap(); question.typeText("How is my training?")
      app.buttons["coach-send"].tap()
      XCTAssertTrue(band.waitForExistence(timeout: 5))
      XCTAssertFalse(app.descendants(matching: .any)["coach-proposal"].exists)
      XCTAssertEqual(question.value as? String, "How is my training?")
      capture("coach-offline-send-\(suffix)", app)
      app.terminate()
    }
  }
  func testAnonymousCoachOffersSetupAndKeepsAccountDoors() {
    for appearance in ["Light", "Dark"] {
      let suffix = appearance.lowercased(), app = launch(appearance, fixture: false)
      XCTAssertTrue(app.staticTexts["coach-greeting"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["coach-setup-build_manually"].exists)
      XCTAssertTrue(app.buttons["coach-setup-screenshot"].exists)
      XCTAssertTrue(app.descendants(matching: .any)["coach-question"].exists)
      XCTAssertFalse(app.buttons["coach-history"].exists)
      XCTAssertFalse(app.buttons["coach-sign-in"].exists)
      capture("coach-anonymous-setup-\(suffix)", app)
      openDestination("Notes", app)
      XCTAssertTrue(app.staticTexts["Notes live with your account, so they need you signed in."].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["coach-sign-in"].exists)
      capture("coach-notes-account-only-\(suffix)", app)
      back(app, expecting: "Coach", control: "coach-setup-screenshot"); openDestination("Connected log", app)
      XCTAssertTrue(app.buttons["coach-connect-tool"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.buttons["coach-connect-tool"].label, "Sign in first")
      XCTAssertTrue(app.staticTexts["Your log, read by ChatGPT or Claude."].exists)
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
      XCTAssertTrue(app.staticTexts["This Windmill does not have Coach. You can still read your log."].waitForExistence(timeout: 10))
      XCTAssertFalse(question.exists)
      capture("coach-unavailable-\(suffix)", app)
      openDestination("Notes", app)
      XCTAssertTrue(app.buttons["coach-add-note"].waitForExistence(timeout: 5))
      back(app, expecting: "Coach"); openDestination("Connected log", app)
      XCTAssertTrue(app.buttons["coach-connect-tool"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.buttons["coach-connect-tool"].label, "Connect a tool")
      app.terminate()
    }
  }

  // A pushed screen hides the tab bar; back at the conversation's end, or back from another tab, its last card stands where it
  // stood, over the composer.
  func testTheConversationsEndStaysClearOfTheComposerAfterAPushedScreenPopsAndATabSwitch() {
    let app = launch("light", arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
    ask("Is Push A still doing anything?", app)
    let review = app.buttons["coach-reject-proposal"], composer = app.descendants(matching: .any)["coach-question"]
    for _ in 0..<4 { app.scrollViews.firstMatch.swipeUp(velocity: .fast) }
    XCTAssertFalse(app.buttons["coach-read-receipt"].isHittable, "At this size the conversation scrolls past its receipt")
    let atEnd = settledFrame(review)
    XCTAssertLessThanOrEqual(atEnd.maxY, composer.frame.minY + 1, "At rest the last card \(atEnd) clears \(composer.frame)")
    openDestination("History", app)
    XCTAssertFalse(app.tabBars.firstMatch.isHittable, "A pushed screen hides the tab bar")
    back(app, expecting: "Coach")
    let returned = settledFrame(review)
    capture("coach-end-after-pop", app)
    XCTAssertEqual(returned.minY, atEnd.minY, accuracy: 1, "The last card \(returned) stands where it stood \(atEnd)")
    XCTAssertLessThanOrEqual(returned.maxY, composer.frame.minY + 1, "The last card \(returned) clears \(composer.frame)")
    openTab("Routines", app)
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    openTab("Coach", app)
    let switched = settledFrame(review)
    capture("coach-end-after-tab-switch", app)
    XCTAssertEqual(switched.minY, atEnd.minY, accuracy: 1, "Back from another tab the last card \(switched) stands where it stood \(atEnd)")
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

  func launchSetup(_ appearance: String = "dark", restore: Bool = false, largeText: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["TZ"] = "UTC"
    app.launchArguments = ["-model-server", "-board", "shell-last-room", "-onboarding-appearance", appearance,
      "-AppleLocale", "en_US", "-AppleLanguages", "(en)", "-coach-fixture", "-coach-setup-fixture"]
    if restore { app.launchArguments.append("-restore-board") }
    if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL", "-coach-long-choices"] }
    app.launch()
    if app.textViews["journal-editor"].waitForExistence(timeout: 3) {
      app.buttons["room-menu"].tap(); app.buttons["room-gym"].tap()
    }
    XCTAssertTrue(app.descendants(matching: .any)["gym-coach"].waitForExistence(timeout: 15))
    return app
  }

  func testSetupDraftReviewIsRequiredBeforeRoutineExists() {
    let app = launchSetup()
    XCTAssertTrue(app.staticTexts["coach-greeting"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["coach-setup-goal"].exists)
    XCTAssertFalse(app.buttons["coach-setup-just_log"].exists)
    let field = app.descendants(matching: .any)["coach-question"]
    field.tap(); field.typeText("Build a three day full body routine.")
    XCTAssertTrue(app.staticTexts["coach-greeting"].exists)
    app.buttons["coach-send"].tap()
    let review = app.buttons["coach-review-routine-setup-operation-B"]
    XCTAssertTrue(review.waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["coach-created-setup-operation-B"].exists)
    for _ in 0..<4 where !review.isHittable { app.swipeUp() }
    review.tap()
    XCTAssertTrue(app.buttons["coach-save-routines"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Barbell"].firstMatch.exists)
    app.buttons["Close"].tap()
    XCTAssertFalse(app.buttons["coach-created-setup-operation-B"].exists)
    review.tap(); app.buttons["coach-save-routines"].tap()
    let receipt = app.buttons["coach-created-setup-operation-B"]
    XCTAssertTrue(receipt.waitForExistence(timeout: 10)); receipt.tap()
    XCTAssertTrue(app.navigationBars["Full body B"].waitForExistence(timeout: 10))
    app.buttons["routine-start"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-workout"].waitForExistence(timeout: 10))
  }

  func testSetupGreetingAndDraftSurviveRelaunchWithoutSending() {
    var app = launchSetup()
    let field = app.descendants(matching: .any)["coach-question"]
    field.tap(); field.typeText("Three days with dumbbells")
    app.terminate(); app = launchSetup(restore: true)
    XCTAssertEqual(app.descendants(matching: .any)["coach-question"].value as? String, "Three days with dumbbells")
    XCTAssertTrue(app.staticTexts["coach-greeting"].exists)
    XCTAssertTrue(app.buttons["coach-setup-screenshot"].exists)
    XCTAssertFalse(app.buttons["coach-created-setup-operation-A"].exists)
  }

  func testSetupManualEscapePreservesGreetingAfterBuilderCancel() {
    let app = launchSetup("light")
    app.buttons["coach-setup-build_manually"].tap()
    XCTAssertTrue(app.navigationBars["New routine"].waitForExistence(timeout: 10))
    let close = app.buttons["sheet-close"]
    if close.exists { close.tap() } else { app.navigationBars["New routine"].buttons.firstMatch.tap() }
    openTab("Coach", app)
    XCTAssertTrue(app.staticTexts["coach-greeting"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["coach-setup-build_manually"].exists)
    XCTAssertFalse(app.buttons["coach-setup-just_log"].exists)
  }

  func testSetupActionsStayReachableAtAccessibilitySize() {
    let app = launchSetup(largeText: true)
    let manual = app.buttons["coach-setup-build_manually"]
    XCTAssertTrue(manual.waitForExistence(timeout: 10))
    for _ in 0..<4 where !manual.isHittable { app.swipeUp() }
    XCTAssertTrue(manual.isHittable)
    XCTAssertGreaterThanOrEqual(manual.frame.height, 44)
    XCTAssertGreaterThanOrEqual(manual.frame.minX, app.frame.minX)
    XCTAssertLessThanOrEqual(manual.frame.maxX, app.frame.maxX)
    XCTAssertFalse(app.buttons["coach-setup-goal"].exists)
    capture("Coach greeting accessibility", app)
  }
}
