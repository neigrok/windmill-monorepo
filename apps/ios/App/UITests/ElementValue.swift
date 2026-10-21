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
  func cancelConfirmation() {
    let cancel = buttons["Cancel"]
    if cancel.exists { cancel.tap(); return }
    let dismiss = otherElements["PopoverDismissRegion"]
    XCTAssertTrue(dismiss.waitForExistence(timeout: 5))
    dismiss.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap()
  }
}
