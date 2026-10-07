import XCTest
import UIKit

@MainActor final class GymRoutinesFlowTests: XCTestCase {
  var viewport = CGRect.zero

  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }

  func launch(_ appearance: String = "dark", proposal: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "shell-last-room", "-onboarding-appearance", appearance]
    if proposal { app.launchArguments.append("-routines-proposal-fixture") }
    app.launch()
    XCTAssertTrue(app.buttons["room-menu"].waitForExistence(timeout: 10))
    app.buttons["room-menu"].tap()
    app.buttons["room-gym"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    viewport = app.frame
    return app
  }
  func capture(_ app: XCUIApplication, _ name: String) {
    if name.hasPrefix("picker-") {
      let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        let create = app.buttons["gym-create-movement"]
        return create.exists && create.isHittable && create.frame.maxY <= app.frame.maxY
          && app.navigationBars["Add movement"].frame.minY < app.frame.height / 4
      }, object: app)
      XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
    }
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "routines-" + name; attachment.lifetime = .keepAlways; add(attachment)
  }
  func waitForPrimaryButton(_ button: XCUIElement) -> Bool {
    let rendered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let snapshot = try? button.snapshot() else { return false }
      let frame = snapshot.frame
      return snapshot.isEnabled && frame.width > 100 && frame.height > 30 && self.viewport.contains(frame)
    }, object: button)
    guard XCTWaiter.wait(for: [rendered], timeout: 5) == .completed else { return false }
    return button.wait(for: \.isHittable, toEqual: true, timeout: 5)
  }
  func assertPrimaryLabelContrast(_ button: XCUIElement, appearance: String, file: StaticString = #filePath, line: UInt = #line) {
    let previous = continueAfterFailure
    continueAfterFailure = true
    defer { continueAfterFailure = previous }
    guard waitForPrimaryButton(button), button.isEnabled else {
      XCTFail("Primary button must be visible and enabled before measuring \(appearance) contrast", file: file, line: line); return
    }
    let frame = button.frame
    guard frame.width > 100 && frame.height > 30 else {
      XCTFail("Primary button must have rendered bounds before measuring \(appearance) contrast", file: file, line: line); return
    }
    let screenshot = button.screenshot()
    guard let image = screenshot.image.cgImage else { XCTFail("Primary button has no rendered image", file: file, line: line); return }
    let width = image.width, height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let rendered = pixels.withUnsafeMutableBytes { bytes -> Bool in
      guard let space = CGColorSpace(name: CGColorSpace.sRGB),
            let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
              bytesPerRow: width * 4, space: space,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
      return true
    }
    guard rendered else { XCTFail("Primary button pixels could not be read", file: file, line: line); return }
    typealias Sample = (count: Int, red: Int, green: Int, blue: Int)
    var colors: [Int: Sample] = [:]
    // The central interior contains the label and solid fill, excluding rounded edges, borders and shadows.
    for y in (height / 4)..<(height * 3 / 4) {
      for x in (width * 15 / 100)..<(width * 85 / 100) {
        let offset = (y * width + x) * 4
        let red = Int(pixels[offset]), green = Int(pixels[offset + 1]), blue = Int(pixels[offset + 2])
        let key = (red / 8) << 10 | (green / 8) << 5 | blue / 8
        let previous = colors[key] ?? (0, 0, 0, 0)
        colors[key] = (previous.count + 1, previous.red + red, previous.green + green, previous.blue + blue)
      }
    }
    func rgb(_ value: Sample) -> [Double] { [value.red, value.green, value.blue].map { Double($0) / Double(value.count) / 255 } }
    func luminance(_ color: [Double]) -> Double {
      let linear = color.map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    guard let background = colors.values.max(by: { $0.count < $1.count }) else {
      XCTFail("Primary button has no interior fill", file: file, line: line); return
    }
    let fill = rgb(background), sampled = colors.values.reduce(0) { $0 + $1.count }
    let glyph = colors.values.filter { sample in zip(rgb(sample), fill).contains { abs($0.0 - $0.1) >= 48.0 / 255 } }
      .max(by: { $0.count < $1.count })
    guard let glyph else { XCTFail("Primary button has no distinct rendered label", file: file, line: line); return }
    XCTAssertGreaterThan(background.count, sampled / 2, "Measure the primary button's actual fill", file: file, line: line)
    XCTAssertGreaterThanOrEqual(glyph.count, max(20, sampled / 500), "Require core glyph pixels, not a stray edge", file: file, line: line)
    let textLuminance = luminance(rgb(glyph)), fillLuminance = luminance(fill)
    let contrast = (max(textLuminance, fillLuminance) + 0.05) / (min(textLuminance, fillLuminance) + 0.05)
    if contrast < 4.5 {
      let attachment = XCTAttachment(screenshot: screenshot)
      attachment.name = "primary-contrast-\(appearance)-\(button.label)"; attachment.lifetime = .keepAlways; add(attachment)
    }
    XCTAssertGreaterThanOrEqual(contrast, 4.5,
      "\(appearance) \(button.label): rendered glyph/fill contrast \(contrast), glyph pixels \(glyph.count)", file: file, line: line)
  }
  func replace(_ field: XCUIElement, with text: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap()
    if let value = field.value as? String, !["open", "max", "last time", "Routine name", "varies"].contains(value) {
      field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
    }
    field.typeText(text)
    if ["routine-name", "gym-movement-name"].contains(field.identifier) {
      field.typeText("\n")
      XCTAssertTrue(XCUIApplication().keyboards.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertEqual(field.value as? String, text)
    }
  }
  func createRoutine(_ app: XCUIApplication) {
    app.buttons["new-routine"].tap()
    replace(app.textFields["routine-name"], with: "Push A")
    app.buttons["add-movement"].tap()
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
    app.buttons["gym-movement-bench-press"].tap()
    XCTAssertTrue(app.buttons["save-routine"].waitForExistence(timeout: 5))
    app.buttons["save-routine"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["routine-detail"].waitForExistence(timeout: 5))
  }

  func testPlanningScreensAndTargetsInBothAppearances() {
    for appearance in ["dark", "light"] {
      let app = launch(appearance)
      assertPrimaryLabelContrast(app.buttons["Just start logging"], appearance: appearance)
      capture(app, "empty-" + appearance)
      app.buttons["new-routine"].tap()
      XCTAssertFalse(app.buttons["save-routine"].isEnabled)
      capture(app, "builder-empty-" + appearance)
      replace(app.textFields["routine-name"], with: "Push A")
      app.buttons["add-movement"].tap()
      capture(app, "picker-" + appearance)
      app.buttons["gym-movement-bench-press"].tap()
      let movement = app.buttons["builder-movement-bench-press"]
      XCTAssertTrue(movement.waitForExistence(timeout: 5)); movement.tap()
      assertPrimaryLabelContrast(app.buttons["gym-target-set"], appearance: appearance)
      capture(app, "targets-open-" + appearance)
      replace(app.textFields["gym-target-sets"], with: "3")
      replace(app.textFields["gym-target-reps"], with: "8")
      replace(app.textFields["gym-target-weight"], with: "60")
      app.buttons["gym-target-keyboard-done"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      assertPrimaryLabelContrast(app.buttons["gym-target-set"], appearance: appearance)
      capture(app, "targets-straight-" + appearance)
      let vary = app.switches["Vary by set"]
      let control = vary.descendants(matching: .switch).firstMatch
      let visibleVary = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        guard let snapshot = try? control.snapshot() else { return false }
        return snapshot.isEnabled && !snapshot.frame.isEmpty && self.viewport.contains(snapshot.frame)
      }, object: control)
      XCTAssertEqual(XCTWaiter.wait(for: [visibleVary], timeout: 5), .completed)
      XCTAssertTrue(control.wait(for: \.isHittable, toEqual: true, timeout: 5))
      control.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5)).press(forDuration: 0.1,
        thenDragTo: control.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5)),
        withVelocity: .slow, thenHoldForDuration: 0.1)
      let varied = app.switches.matching(NSPredicate(format: "label == %@ AND value == %@", "Vary by set", "1")).firstMatch
      XCTAssertTrue(varied.waitForExistence(timeout: 5))
      XCTAssertEqual(vary.value as? String, "1")
      let targets = app.collectionViews["gym-routine-targets"]
      let thirdLoad = app.textFields["gym-target-row-3-weight"]
      for _ in 0..<4 {
        if thirdLoad.exists, thirdLoad.frame.maxY < app.buttons["gym-target-set"].frame.minY - 12 { break }
        targets.swipeUp()
      }
      replace(thirdLoad, with: "100")
      XCTAssertEqual(thirdLoad.value as? String, "100")
      app.buttons["gym-target-keyboard-done"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      for _ in 0..<4 where !app.descendants(matching: .any)["gym-target-fill"].firstMatch.isHittable { targets.swipeDown() }
      app.descendants(matching: .any)["gym-target-fill"].firstMatch.tap()
      let ramp = app.buttons["Ramp up"]
      let visibleRamp = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        ramp.exists && ramp.isEnabled && ramp.isHittable && ramp.frame.width > 0 && app.frame.contains(ramp.frame)
      }, object: app)
      XCTAssertEqual(XCTWaiter.wait(for: [visibleRamp], timeout: 10), .completed)
      ramp.tap()
      XCTAssertTrue(ramp.waitForNonExistence(timeout: 5))
      XCTAssertEqual(app.textFields["gym-target-row-2-weight"].value as? String, "80")
      app.buttons["gym-target-fill"].tap()
      let match = app.buttons["Match set 1"]
      XCTAssertTrue(match.waitForExistence(timeout: 5)); match.tap()
      XCTAssertTrue(match.waitForNonExistence(timeout: 5))
      for row in 1...3 { XCTAssertEqual(app.textFields["gym-target-row-\(row)-weight"].value as? String, "60") }
      replace(thirdLoad, with: "100")
      app.buttons["gym-target-keyboard-done"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      app.buttons["gym-target-fill"].tap()
      XCTAssertTrue(ramp.waitForExistence(timeout: 5)); ramp.tap()
      XCTAssertTrue(ramp.waitForNonExistence(timeout: 5))
      XCTAssertEqual(app.textFields["gym-target-row-2-weight"].value as? String, "80")
      assertPrimaryLabelContrast(app.buttons["gym-target-set"], appearance: appearance)
      capture(app, "targets-varied-" + appearance)
      app.buttons["gym-target-set"].tap()
      capture(app, "builder-" + appearance)
      app.buttons["save-routine"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["routine-detail"].waitForExistence(timeout: 5))
      assertPrimaryLabelContrast(app.buttons["Start workout"], appearance: appearance)
      capture(app, "detail-" + appearance)
      app.buttons["edit-routine"].tap()
      capture(app, "builder-edit-" + appearance)
      app.navigationBars["Edit routine"].buttons["Cancel"].tap()
      app.buttons["routine-detail-movement-bench-press"].tap()
      capture(app, "movement-" + appearance)
      app.buttons["rename-movement"].tap()
      app.textFields["gym-rename-movement-name"].tap()
      capture(app, "rename-" + appearance)
      replace(app.textFields["gym-rename-movement-name"], with: "Bench today")
      app.buttons["gym-rename-movement-commit"].tap()
      XCTAssertTrue(app.staticTexts["gym-rename-movement-refusal"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.textFields["gym-rename-movement-name"].value as? String, "Bench today")
      app.terminate()
    }
  }

  func testCustomCreationAndRenameScreensInBothAppearances() {
    for appearance in ["dark", "light"] {
      let app = launch(appearance)
      app.buttons["Movements"].tap()
      replace(app.searchFields.firstMatch, with: "Cable curl")
      XCTAssertTrue(app.buttons["gym-create-movement"].waitForExistence(timeout: 5))
      app.buttons["gym-create-movement"].tap()
      replace(app.textFields["gym-movement-name"], with: "Cable curl")
      assertPrimaryLabelContrast(app.buttons["gym-movement-create-commit"], appearance: appearance)
      capture(app, "creation-" + appearance)
      app.buttons["gym-movement-create-commit"].tap()
      XCTAssertTrue(app.buttons["rename-movement"].waitForExistence(timeout: 5))
      app.buttons["rename-movement"].tap()
      replace(app.textFields["gym-rename-movement-name"], with: "My curl")
      app.buttons["gym-rename-movement-commit"].tap()
      XCTAssertTrue(app.navigationBars["My curl"].waitForExistence(timeout: 5))
      app.terminate()
    }
  }

  func testCancelDraftReopenDeleteAndUndo() {
    let app = launch()
    createRoutine(app)
    app.buttons["edit-routine"].tap()
    replace(app.textFields["routine-name"], with: "Cancelled name")
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.navigationBars["Push A"].waitForExistence(timeout: 5))
    app.navigationBars.buttons["Routines"].tap()
    let row = app.cells.containing(.staticText, identifier: "Push A").firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5)); row.swipeLeft()
    app.buttons["Delete"].tap()
    XCTAssertTrue(app.buttons["Undo"].waitForExistence(timeout: 5)); app.buttons["Undo"].tap()
    XCTAssertTrue(app.staticTexts["Push A"].waitForExistence(timeout: 5))
  }

  func testJustStartLoggingOpensWorkout() {
    let app = launch()
    app.buttons["Just start logging"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-workout"].waitForExistence(timeout: 10))
  }

  func testAnonymousSignInAndFirstSessionWrittenProgramDoors() {
    let app = launch()
    app.buttons["routines-sign-in"].tap()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 5))
    if app.buttons["Done"].exists { app.buttons["Done"].tap() } else { app.buttons["Close"].tap() }
    XCTAssertTrue(app.buttons["email-sign-in"].waitForNonExistence(timeout: 10))
    app.buttons["Movements"].tap()
    XCTAssertTrue(app.navigationBars["What are you starting with?"].waitForExistence(timeout: 5))
    let door = app.buttons["gym-build-written-program"]
    for _ in 0..<16 {
      if door.exists {
        let frame = door.frame
        if frame.width > 0 && frame.height > 0 && app.frame.contains(frame)
            && frame.maxY < app.buttons["gym-create-movement"].frame.minY - 16 && door.isHittable { break }
      }
      app.collectionViews["gym-movement-picker"].swipeUp(velocity: .fast)
    }
    XCTAssertLessThan(door.frame.maxY, app.buttons["gym-create-movement"].frame.minY - 16)
    XCTAssertTrue(door.isHittable)
    door.tap()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 5))
  }

  func testRoutineMovementOpensTheCommonRecord() {
    let app = launch()
    createRoutine(app)
    app.buttons["routine-detail-movement-bench-press"].tap()
    app.buttons["routine-open-record"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["gym-record-empty"].exists)
  }

  func testBuilderReorderRemoveUndoAndSelectedMovement() {
    let app = launch()
    app.buttons["new-routine"].tap()
    replace(app.textFields["routine-name"], with: "Training day")
    for id in ["bench-press", "deadlift"] {
      app.buttons["add-movement"].tap()
      app.buttons["gym-movement-" + id].tap()
    }
    let reorder = app.buttons["reorder-movements"]
    reorder.tap()
    XCTAssertTrue(reorder.wait(for: \.label, toEqual: "Done reordering", timeout: 5))
    let deadliftHandle = app.buttons["Reorder Deadlift"]
    let benchHandle = app.buttons["Reorder Bench Press"]
    XCTAssertTrue(deadliftHandle.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertTrue(benchHandle.wait(for: \.isHittable, toEqual: true, timeout: 5))
    deadliftHandle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.5,
      thenDragTo: benchHandle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)),
      withVelocity: .default, thenHoldForDuration: 0.3)
    let firstMovement = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "builder-movement-")).element(boundBy: 0)
    XCTAssertTrue(firstMovement.wait(for: \.identifier, toEqual: "builder-movement-deadlift", timeout: 5))
    reorder.tap()
    XCTAssertTrue(reorder.wait(for: \.label, toEqual: "Reorder", timeout: 5))
    XCTAssertTrue(deadliftHandle.waitForNonExistence(timeout: 5))
    let deadlift = app.cells.containing(.button, identifier: "builder-movement-deadlift").firstMatch
    XCTAssertTrue(deadlift.wait(for: \.isHittable, toEqual: true, timeout: 5))
    let row = deadlift.frame
    XCTAssertTrue(row.width > 0 && row.height > 0 && viewport.contains(row))
    let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: row.maxX - 40, dy: row.midY))
    start.press(forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: -min(150, row.width / 2), dy: 0)),
      withVelocity: .slow, thenHoldForDuration: 0.1)
    let remove = app.buttons["Remove"]
    XCTAssertTrue(remove.wait(for: \.isHittable, toEqual: true, timeout: 5)); remove.tap()
    app.buttons["Undo movement removal"].tap()
    app.buttons["add-movement"].tap()
    XCTAssertFalse(app.buttons["gym-movement-bench-press"].isEnabled)
    app.navigationBars["Add movement"].buttons["Cancel"].tap()
    app.buttons["save-routine"].tap()
    XCTAssertTrue(app.buttons["routine-detail-movement-deadlift"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["routine-detail-movement-deadlift"].label, "1. Deadlift, open")
    XCTAssertEqual(app.buttons["routine-detail-movement-bench-press"].label, "2. Bench Press, open")
  }

  func testBuilderCustomCreationRequiresTargetsAndCancelKeepsQuery() {
    let app = launch()
    app.buttons["new-routine"].tap()
    replace(app.textFields["routine-name"], with: "Custom day")
    app.buttons["add-movement"].tap()
    replace(app.textFields["gym-movement-search"], with: "Custom press")
    app.buttons["gym-create-movement"].tap()
    XCTAssertFalse(app.buttons["gym-movement-create-commit"].isEnabled)
    replace(app.textFields["gym-movement-name"], with: "Custom press kept")
    app.navigationBars["Create movement"].buttons["Cancel"].tap()
    XCTAssertEqual(app.textFields["gym-movement-search"].value as? String, "Custom press")
    app.buttons["gym-create-movement"].tap()
    XCTAssertEqual(app.textFields["gym-movement-name"].value as? String, "Custom press kept")
    app.textFields["gym-movement-name"].tap()
    app.textFields["gym-movement-name"].typeText("\n")
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 10))
    let targets = app.buttons["gym-movement-targets"]
    XCTAssertTrue(targets.isHittable)
    XCTAssertLessThanOrEqual(targets.frame.maxY, app.buttons["gym-movement-create-commit"].frame.minY - 16, "The whole Targets row is above the padded bottom action bar")
    targets.tap()
    replace(app.textFields["gym-target-sets"], with: "2")
    app.navigationBars["Custom press kept"].buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["gym-movement-targets"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["gym-movement-create-commit"].isEnabled)
    app.buttons["gym-movement-targets"].tap()
    XCTAssertTrue(app.textFields["gym-target-sets"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.textFields["gym-target-sets"].value as? String, "open")
    replace(app.textFields["gym-target-sets"], with: "1")
    let keyboardDone = app.buttons["gym-target-keyboard-done"]
    XCTAssertTrue(keyboardDone.waitForExistence(timeout: 5))
    capture(app, "custom-targets-before-keyboard-done")
    keyboardDone.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 10))
    capture(app, "custom-targets-after-keyboard-done")
    XCTAssertTrue(app.buttons["gym-target-set"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.textFields["gym-target-sets"].value as? String, "1")
    XCTAssertTrue(app.buttons["gym-target-set"].isEnabled)
    app.buttons["gym-target-set"].tap()
    XCTAssertTrue(app.navigationBars["Create movement"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["gym-movement-targets"].label, "Targets, 1 × max")
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "Returning from Targets must keep the dismissed keyboard closed")
    let create = app.buttons["gym-movement-create-commit"]
    XCTAssertTrue(waitForPrimaryButton(create))
    XCTAssertTrue(create.isEnabled)
    let createFrame = create.frame
    XCTAssertFalse(createFrame.isEmpty)
    XCTAssertTrue(app.frame.contains(createFrame))
    create.tap()
    XCTAssertTrue(app.buttons["save-routine"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.textFields["routine-name"].value as? String, "Custom day")
    app.buttons["save-routine"].tap()
    XCTAssertTrue(app.navigationBars["Custom day"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["1. Custom press kept · yours, 1 × max"].waitForExistence(timeout: 5))
  }

  func testProposalScreensInBothAppearances() {
    for appearance in ["dark", "light"] {
      let app = launch(appearance, proposal: true)
      XCTAssertTrue(app.buttons["routine-proposal"].waitForExistence(timeout: 5))
      capture(app, "list-" + appearance)
      app.buttons["routine-proposal"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["gym-proposal-review"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts["A heavier bench target"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts["Bench Press"].exists)
      XCTAssertTrue(app.buttons["coach-apply-proposal"].exists)
      XCTAssertFalse(app.staticTexts["The account changed. Open this proposal again."].exists)
      capture(app, "proposal-" + appearance)
      app.buttons["Close"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["gym-proposal-review"].waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.buttons["routine-proposal"].waitForExistence(timeout: 5))
      app.buttons["routine-proposal"].tap()
      let ask = app.descendants(matching: .any)["gym-proposal-review"].buttons["Ask Coach"]
      XCTAssertTrue(ask.waitForExistence(timeout: 5))
      ask.tap()
      XCTAssertTrue(app.descendants(matching: .any)["gym-proposal-review"].waitForNonExistence(timeout: 5))
      let question = app.descendants(matching: .any)["coach-question"]
      XCTAssertTrue(question.waitForExistence(timeout: 5))
      let seeded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        question.value as? String == "Tell me about the proposal for Push A."
      }, object: question)
      XCTAssertEqual(XCTWaiter.wait(for: [seeded], timeout: 5), .completed)
      let done = app.buttons["coach-keyboard-done"]
      let keyboardReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        app.keyboards.firstMatch.exists && done.exists && done.isHittable
      }, object: done)
      XCTAssertEqual(XCTWaiter.wait(for: [keyboardReady], timeout: 5), .completed)
      let send = app.buttons["coach-send"]
      XCTAssertTrue(send.waitForExistence(timeout: 5))
      capture(app, "coach-proposal-question-" + appearance)
      XCTAssertFalse(done.frame.intersects(send.frame), "Coach Done \(done.frame) must not cover Send \(send.frame) in \(appearance).")
      XCTAssertGreaterThanOrEqual(done.frame.height, 44)
      XCTAssertTrue(done.isEnabled && done.isHittable)
      XCTAssertTrue(send.isEnabled && send.isHittable)
      done.tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertEqual(question.value as? String, "Tell me about the proposal for Push A.")
      let routines = app.tabBars.buttons["Routines"]
      XCTAssertTrue(routines.wait(for: \.isHittable, toEqual: true, timeout: 5))
      var previousFrame = CGRect.zero
      var unchangedSince = ContinuousClock.now
      let routinesSettled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        let frame = routines.frame
        if frame.isEmpty || frame != previousFrame {
          previousFrame = frame; unchangedSince = ContinuousClock.now; return false
        }
        return unchangedSince.duration(to: ContinuousClock.now) >= .seconds(1)
      }, object: routines)
      XCTAssertEqual(XCTWaiter.wait(for: [routinesSettled], timeout: 5), .completed)
      XCTAssertTrue(app.tabBars.firstMatch.frame.contains(routines.frame))
      routines.tap()
      XCTAssertTrue(routines.wait(for: \.isSelected, toEqual: true, timeout: 5))
      XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["routine-proposal"].exists)
      app.terminate()
    }
  }
}
