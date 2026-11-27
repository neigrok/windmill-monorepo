import XCTest

extension XCUIElement {
  // XCTest returns once it has sent the keys; the app may still be inserting them when the next tap lands.
  func waitForValue(_ expected: String, timeout: TimeInterval = 10) -> Bool {
    let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expected), object: self)
    return XCTWaiter.wait(for: [shown], timeout: timeout) == .completed
  }

  func waitForLabel(_ expected: String, timeout: TimeInterval = 10) -> Bool {
    let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", expected), object: self)
    return XCTWaiter.wait(for: [shown], timeout: timeout) == .completed
  }

  // Exists, enabled and hittable: a screen whose first launch in a session is slow settles before a tap lands on it.
  func waitForHittable(timeout: TimeInterval = 15) -> Bool {
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.isReadyForTap }, object: self)
    return XCTWaiter.wait(for: [ready], timeout: timeout) == .completed
  }

  // XCTest fails the test, rather than answering, when it is asked the hittability of an element the app is rebuilding,
  // which stands in the tree for a moment without a frame; so it is asked only of one whose snapshot has its frame.
  var isReadyForTap: Bool {
    guard let shot = try? snapshot(), shot.isEnabled, !shot.frame.isEmpty else { return false }
    return isHittable
  }
}

extension XCUIApplication {
  // A room in the open room menu, found by its `room-…` identifier or by its room's title; the menu's own button, which
  // carries the current room's title, never is one.
  func roomItem(_ room: String) -> XCUIElement {
    buttons.matching(NSPredicate(format: "identifier == %@ OR (label == %@ AND identifier != %@)",
                                 "room-" + room.lowercased(), room, "room-menu")).firstMatch
  }

  // A step's row in the Roadmap room, on the Board or on a step's page, by the step's name: its label leads with the
  // name, or with its colour and then the name, which ends the label of a Done step's row on a page; another row's
  // reason may hold the name too.
  func roadmapStep(_ name: String) -> XCUIElement {
    descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND (label BEGINSWITH %@ OR label CONTAINS %@ OR label ENDSWITH %@)",
                                                     "roadmap-step", name + ", ", ", " + name + ", ", ", " + name)).firstMatch
  }

  // The Roadmap room's title menu, open once it leads with *2 Set Aside*, which it answers. Nothing else in the room says a
  // change is set aside, so until the phone has heard the server refuse them the menu closes through All Roadmaps and
  // back, and opens again.
  func titleMenuLeadingWithSetAside(_ roadmap: String = "Learn to sail", file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    let title = navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", roadmap)).firstMatch
    let row = buttons["2 Set Aside"]
    for _ in 0..<10 {
      XCTAssertTrue(title.waitForHittable(timeout: 10), file: file, line: line)
      title.tap()
      XCTAssertTrue(buttons["All Roadmaps…"].waitForExistence(timeout: 5), file: file, line: line)
      if row.waitForExistence(timeout: 3) { return row }
      buttons["All Roadmaps…"].tap()
      XCTAssertTrue(navigationBars["All Roadmaps"].waitForExistence(timeout: 10), file: file, line: line)
      navigationBars["All Roadmaps"].buttons.element(boundBy: 0).tap()
      XCTAssertTrue(navigationBars["All Roadmaps"].waitForNonExistence(timeout: 10), file: file, line: line)
    }
    XCTFail("the title menu never led with Set Aside", file: file, line: line)
    return row
  }

  // A step in the step form's Requires or Opens list, by its name.
  func roadmapChoice(_ name: String) -> XCUIElement {
    buttons.matching(NSPredicate(format: "identifier == %@ AND label == %@", "roadmap-choice", name)).firstMatch
  }

  // A kind in the step form's Kind list, by its name, which leads its label before its description.
  func roadmapKind(_ name: String) -> XCUIElement {
    buttons.matching(NSPredicate(format: "identifier == %@ AND (label == %@ OR label BEGINSWITH %@)", "roadmap-kind", name, name + ", ")).firstMatch
  }

  // The pushed list on screen in the step form goes back to the form.
  func leaveRoadmapList(_ title: String) {
    let back = navigationBars[title].buttons.element(boundBy: 0)
    XCTAssertTrue(back.waitForExistence(timeout: 5))
    back.tap()
    XCTAssertTrue(buttons["roadmap-form-commit"].waitForExistence(timeout: 5))
  }

  // A step's page in the Roadmap room, on screen once its name is the one page name there: a page going away keeps its
  // own for a moment. The names are counted, which asks the app for no element that may just have gone; this page's
  // first, since once it has come only another page's name can leave.
  func roadmapStepPage(_ name: String, timeout: TimeInterval = 10) -> Bool {
    let names = staticTexts.matching(identifier: "roadmap-step-name")
    let named = names.matching(NSPredicate(format: "label == %@", name))
    let alone = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in named.count == 1 && names.count == 1 }, object: nil)
    return XCTWaiter.wait(for: [alone], timeout: timeout) == .completed
  }

  // The ledger's logged row for a set number, its label *Set N, logged, …*.
  func loggedSet(_ number: Int) -> XCUIElement {
    buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "workout-set-", "Set \(number),")).firstMatch
  }

  // Lands a load typed on the rack where it is: a tap on the page dots, outside the field and the rack.
  func landTypedLoad() { pageIndicators.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }

  // The workout's movement header: a menu VoiceOver hears as Movement options, its value the movement it stands on.
  func movementHeader(_ movement: String) -> XCUIElement {
    buttons.matching(NSPredicate(format: "identifier == %@ AND value == %@", "workout-movement-menu", movement)).firstMatch
  }

  // Types a load on the decimal pad into a load field, the rack's, Fix set's or Edit sets', focusing it first if it is not;
  // the field's text is cleared before the keys. The keyboard stays up: the load lands as the field lets go, on the rack by
  // the keyboard row's ✓, Log set, a tap outside or a sheet opening, in a sheet by its bar's ✓ or its next row.
  func typeLoad(_ load: String, into identifier: String = "workout-load") {
    let field = textFields[identifier]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    if !(field.value(forKey: "hasKeyboardFocus") as? Bool ?? false) { field.tap() }
    let typed = field.value as? String ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: max(1, typed.count)) + load)
    XCTAssertTrue(field.waitForValue(load))
  }

  // A tap can go unanswered and leave the screen as it was: a control redrawn under it is rebuilt and drops it
  // (GymModel.publish), and a sheet's list lets one go while it settles. A tap whose answer has not come is sent once more,
  // which asks the same of the screen again.
  func tap(_ send: () -> Void, until answered: () -> Bool) -> Bool {
    for _ in 0..<2 {
      send()
      if answered() { return true }
    }
    return false
  }

  // Paste Steps, from the long press of the room's +; the system then asks, in SpringBoard's alert, before the room reads
  // what another app copied, answered as `allowing` says. Once allowed, the system asks no more of the same copied text,
  // so an allowing paste answers only where it is asked, and a refusing one needs text copied since. Where the system
  // cannot ask (`systemAsksBeforePaste`), it refuses unasked: a refusing paste holds, and an allowing one returns false.
  @discardableResult
  func pasteSteps(allowing allowed: Bool? = nil, file: StaticString = #filePath, line: UInt = #line) -> Bool {
    let plus = buttons["roadmap-new-step"]
    XCTAssertTrue(plus.waitForHittable(timeout: 10), file: file, line: line)
    plus.press(forDuration: 1.0)
    let item = buttons["Paste Steps"]
    XCTAssertTrue(item.waitForExistence(timeout: 5), file: file, line: line)
    item.tap()
    guard let allowed else { return true }
    guard Self.systemAsksBeforePaste else { return !allowed }
    let answer = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons[allowed ? "Allow Paste" : "Don’t Allow Paste"]
    let asked = answer.waitForExistence(timeout: allowed ? 3 : 10)
    XCTAssertTrue(asked || allowed, "the system asks before the room reads another app's text", file: file, line: line)
    if asked { answer.tap() }
    return true
  }

  // The iOS 27.0 simulator cannot ask before a paste: SpringBoard refuses its pasteboard daemon the alert (the daemon lacks
  // the com.apple.springboard.CFUserNotification entitlement), and the read fails as not authorized.
  static let systemAsksBeforePaste = ProcessInfo.processInfo.operatingSystemVersion.majorVersion != 27
    || ProcessInfo.processInfo.operatingSystemVersion.minorVersion != 0
  static let pasteUnasked = "the iOS 27.0 simulator cannot ask before a paste, so nothing can allow one"

  // The system's Paste button in New Roadmap's *A Copied Plan* row, which takes the row's label and frame: its capsule
  // stands at the row's trailing end, where a tap reaches it.
  func pastePlan() {
    let row = buttons["roadmap-new-paste"]
    XCTAssertTrue(row.waitForHittable(timeout: 5))
    row.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.5)).tap()
  }

  func cancelConfirmation() {
    let cancel = buttons["Cancel"]
    if cancel.exists { cancel.tap(); return }
    dismissPopover()
  }

  // A question raised as a popover closes unanswered by a tap outside it. Over a sheet each presentation keeps a dismiss
  // region; the question's is the last, on top.
  func dismissPopover() {
    let regions = otherElements.matching(identifier: "PopoverDismissRegion")
    XCTAssertTrue(regions.firstMatch.waitForExistence(timeout: 5))
    regions.element(boundBy: regions.count - 1).coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap()
  }
}
