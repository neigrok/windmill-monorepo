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
}

extension XCUIApplication {
  // Types a load on the decimal pad into a load field, the rack's or Fix set's, focusing it first if it is not; the field's
  // text is cleared before the keys, and the rack's ✓ lands the load, while Fix set holds it in its draft.
  func typeLoad(_ load: String, into identifier: String = "workout-load") {
    let field = textFields[identifier]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    if !(field.value(forKey: "hasKeyboardFocus") as? Bool ?? false) { field.tap() }
    let typed = field.value as? String ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: max(1, typed.count)) + load)
    if buttons["workout-load-done"].exists { buttons["workout-load-done"].tap() }
  }

  func cancelConfirmation() {
    let cancel = buttons["Cancel"]
    if cancel.exists { cancel.tap(); return }
    let dismiss = otherElements["PopoverDismissRegion"]
    XCTAssertTrue(dismiss.waitForExistence(timeout: 5))
    dismiss.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap()
  }
}
