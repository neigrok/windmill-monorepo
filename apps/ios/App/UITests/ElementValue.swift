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
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.exists && self.isEnabled && self.isHittable }, object: self)
    return XCTWaiter.wait(for: [ready], timeout: timeout) == .completed
  }
}

extension XCUIApplication {
  // A room in the open room menu, found by its `room-…` identifier or by its room's title; the menu's own button, which
  // carries the current room's title, never is one.
  func roomItem(_ room: String) -> XCUIElement {
    buttons.matching(NSPredicate(format: "identifier == %@ OR (label == %@ AND identifier != %@)",
                                 "room-" + room.lowercased(), room, "room-menu")).firstMatch
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
  // Log set, a tap outside or a sheet opening, in a sheet by its ✓ or its next row.
  func typeLoad(_ load: String, into identifier: String = "workout-load") {
    let field = textFields[identifier]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    if !(field.value(forKey: "hasKeyboardFocus") as? Bool ?? false) { field.tap() }
    let typed = field.value as? String ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: max(1, typed.count)) + load)
    XCTAssertTrue(field.waitForValue(load))
  }

  func cancelConfirmation() {
    let cancel = buttons["Cancel"]
    if cancel.exists { cancel.tap(); return }
    // Over a sheet at its medium detent each presentation keeps a dismiss region; the question's is the last, on top.
    let regions = otherElements.matching(identifier: "PopoverDismissRegion")
    XCTAssertTrue(regions.firstMatch.waitForExistence(timeout: 5))
    regions.element(boundBy: regions.count - 1).coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap()
  }
}
