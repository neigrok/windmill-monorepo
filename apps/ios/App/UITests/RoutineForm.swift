import XCTest

// Driving the routine's movement form (02L.5, 02L.6): its menus, its steppers and its Load fields, each scrolled into reach
// first.
extension XCUIApplication {
  // A form row below the fold, or under the keyboard, scrolled whole into reach before it is tapped; a form's scroll lets
  // the keyboard go, so the rows it covered come up with it.
  @discardableResult func reveal(_ element: XCUIElement) -> XCUIElement {
    let whole = { element.exists && element.isHittable && self.frame.insetBy(dx: 0, dy: 1).contains(element.frame) }
    // The drag stays in the screen's upper third, clear of a keyboard and its row.
    for _ in 0..<8 where !whole() {
      coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.38))
        .press(forDuration: 0.05, thenDragTo: coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.16)), withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    XCTAssertTrue(whole(), "\(element) is not in reach")
    return element
  }

  // A menu picker — Equipment, Dumbbells, Rest — opened by its identifier and answered by the option's title.
  func choose(_ picker: String, _ option: String) {
    reveal(descendants(matching: .any)[picker]).tap()
    let choice = buttons[option]
    XCTAssertTrue(choice.waitForExistence(timeout: 5)); choice.tap()
  }

  // A stepper walked from where it stands to a count, by its identifier's Increment and Decrement buttons.
  func step(_ stepper: String, from current: Int, to target: Int) {
    let key = reveal(buttons[stepper + (target > current ? "-Increment" : "-Decrement")])
    for _ in 0..<abs(target - current) { key.tap() }
  }

  // The movement form's shared plan: its sets from Open, its reps from Max, its load on the decimal pad and its rest.
  func plan(sets: Int, reps: Int? = nil, load: String? = nil, rest: String? = nil) {
    step("gym-target-sets", from: 0, to: sets)
    if let reps { step("gym-target-reps", from: 0, to: reps) }
    if let load { reveal(textFields["gym-target-load"]); typeLoad(load, into: "gym-target-load") }
    if let rest { choose("gym-target-rest", rest) }
  }

  // One set's own plan on a varied form, its reps stepped from the shared count the row opened with.
  func plan(row: Int, reps: Int, from current: Int, load: String) {
    step("gym-target-row-\(row)-reps", from: current, to: reps)
    reveal(textFields["gym-target-row-\(row)-load"]); typeLoad(load, into: "gym-target-row-\(row)-load")
  }
}
