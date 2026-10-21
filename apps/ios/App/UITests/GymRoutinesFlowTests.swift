import XCTest
import UIKit

@MainActor final class GymRoutinesFlowTests: XCTestCase {
  var viewport = CGRect.zero

  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }

  func launch(_ appearance: String = "dark", board: String = "shell-last-room", proposal: Bool = false, arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board, "-onboarding-appearance", appearance] + arguments
    if proposal { app.launchArguments.append("-routines-proposal-fixture") }
    app.launch()
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    viewport = app.frame
    let menu = app.buttons["room-menu"]
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let snapshot = try? menu.snapshot() else { return false }
      return snapshot.isEnabled && !snapshot.frame.isEmpty && self.viewport.contains(snapshot.frame)
    }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
    XCTAssertTrue(menu.isHittable)
    menu.tap()
    let gym = app.buttons["room-gym"]
    XCTAssertTrue(gym.waitForExistence(timeout: 5)); gym.tap()
    XCTAssertTrue(app.tabBars.buttons["Routines"].waitForExistence(timeout: 10)); app.tabBars.buttons["Routines"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    return app
  }
  func capture(_ app: XCUIApplication, _ name: String) {
    if name.hasPrefix("picker-") {
      let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        guard let snapshot = try? app.snapshot(),
              let create = self.descendant(in: snapshot, type: .button, named: "gym-new-movement"),
              let navigation = self.descendant(in: snapshot, type: .navigationBar, named: "Add movement") else { return false }
        return create.isEnabled && !create.frame.isEmpty && navigation.frame.contains(create.frame)
          && !navigation.frame.isEmpty && self.viewport.contains(navigation.frame) && navigation.frame.minY < self.viewport.height / 4
      }, object: nil)
      XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
      XCTAssertTrue(app.buttons["gym-new-movement"].isHittable)
    }
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = "routines-" + name; attachment.lifetime = .keepAlways; add(attachment)
    if let path = ProcessInfo.processInfo.environment["WM_GYM_FEEDBACK_SHOTS"] {
      let directory = URL(fileURLWithPath: path)
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try? screenshot.pngRepresentation.write(to: directory.appending(path: "routines-" + name + ".png"))
    }
  }
  func descendant(in snapshot: any XCUIElementSnapshot, type: XCUIElement.ElementType, named name: String) -> (any XCUIElementSnapshot)? {
    if snapshot.elementType == type && (snapshot.identifier == name || snapshot.label == name) { return snapshot }
    for child in snapshot.children {
      if let match = descendant(in: child, type: type, named: name) { return match }
    }
    return nil
  }
  // A band's primary is a wide pill; a sheet's commit is the bar's prominent checkmark, about 29 pt wide.
  func waitForPrimaryButton(_ button: XCUIElement, minimumWidth: CGFloat = 100) -> Bool {
    let rendered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let snapshot = try? button.snapshot() else { return false }
      let frame = snapshot.frame
      return snapshot.isEnabled && frame.width > minimumWidth && frame.height > 30 && self.viewport.contains(frame)
    }, object: button)
    return XCTWaiter.wait(for: [rendered], timeout: 5) == .completed
  }
  func assertPrimaryLabelContrast(_ button: XCUIElement, appearance: String, minimumWidth: CGFloat = 100,
                                  file: StaticString = #filePath, line: UInt = #line) {
    let previous = continueAfterFailure
    continueAfterFailure = true
    defer { continueAfterFailure = previous }
    guard waitForPrimaryButton(button, minimumWidth: minimumWidth), button.isEnabled else {
      XCTFail("Primary button must be visible and enabled before measuring \(appearance) contrast", file: file, line: line); return
    }
    let frame = button.frame
    guard frame.width > minimumWidth && frame.height > 30 else {
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
  // The rename sheet focuses its name as it rises with the keyboard, so a tap could land outside it and dismiss it.
  func retype(_ field: XCUIElement, with text: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    XCTAssertTrue(XCUIApplication().keyboards.firstMatch.waitForExistence(timeout: 5))
    let value = field.value as? String ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count) + text)
    XCTAssertTrue(field.waitForValue(text))
  }
  func replace(_ field: XCUIElement, with text: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap()
    if let value = field.value as? String, !["open", "max", "last time", "Name", "varies"].contains(value) {
      field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
    }
    field.typeText(text)
    XCTAssertTrue(field.waitForValue(text))
    if ["routine-name", "gym-movement-name"].contains(field.identifier) {
      field.typeText("\n")
      XCTAssertTrue(XCUIApplication().keyboards.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertEqual(field.value as? String, text)
    }
  }
  func openRename(_ app: XCUIApplication) {
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
    app.navigationBars.buttons["More"].tap()
    let item = app.buttons["Edit exercise"]
    XCTAssertTrue(item.wait(for: \.isHittable, toEqual: true, timeout: 5)); item.tap()
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
      XCTAssertTrue(app.staticTexts["No routines yet"].waitForExistence(timeout: 5))
      XCTAssertFalse(app.staticTexts["Build one, or just start logging."].exists, "The empty state reads out the button below it")
      XCTAssertFalse(app.buttons["Ask Coach"].exists, "Signed out, Coach is not offered")
      XCTAssertFalse(app.buttons["Movements"].exists)
      XCTAssertFalse(app.buttons["Just start logging"].exists)
      XCTAssertTrue(app.buttons["new-routine"].isHittable)
      capture(app, "empty-" + appearance)
      app.buttons["new-routine"].tap()
      XCTAssertFalse(app.buttons["save-routine"].isEnabled)
      XCTAssertFalse(app.staticTexts["History"].exists)
      XCTAssertEqual(app.textFields["routine-name"].placeholderValue, "Name")
      XCTAssertFalse(app.buttons["delete-routine"].exists, "A new routine has nothing to delete")
      capture(app, "builder-empty-" + appearance)
      replace(app.textFields["routine-name"], with: "Push A")
      app.buttons["add-movement"].tap()
      capture(app, "picker-" + appearance)
      app.buttons["gym-movement-bench-press"].tap()
      let movement = app.buttons["builder-movement-bench-press"]
      XCTAssertTrue(movement.waitForExistence(timeout: 5)); movement.tap()
      assertPrimaryLabelContrast(app.buttons["gym-target-set"], appearance: appearance, minimumWidth: 24)
      capture(app, "targets-open-" + appearance)
      replace(app.textFields["gym-target-sets"], with: "3")
      replace(app.textFields["gym-target-reps"], with: "8")
      replace(app.textFields["gym-target-weight"], with: "60")
      app.buttons["gym-target-keyboard-done"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      assertPrimaryLabelContrast(app.buttons["gym-target-set"], appearance: appearance, minimumWidth: 24)
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
        if thirdLoad.exists, thirdLoad.isHittable, thirdLoad.frame.maxY < viewport.maxY - 60 { break }
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
      assertPrimaryLabelContrast(app.buttons["gym-target-set"], appearance: appearance, minimumWidth: 24)
      capture(app, "targets-varied-" + appearance)
      app.buttons["gym-target-set"].tap()
      capture(app, "builder-" + appearance)
      app.buttons["save-routine"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["routine-detail"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.descendants(matching: .any)["routine-detail-movement-bench-press"].waitForExistence(timeout: 5))
      XCTAssertFalse(app.staticTexts["History"].exists, "A routine never trained draws no History")
      XCTAssertFalse(app.staticTexts["No workouts with this routine yet."].exists)
      XCTAssertFalse(app.staticTexts["Open movements have no target — you decide the numbers at the rack."].exists)
      assertPrimaryLabelContrast(app.buttons["routine-start"], appearance: appearance)
      capture(app, "detail-" + appearance)
      app.buttons["edit-routine"].tap()
      XCTAssertTrue(app.navigationBars["Edit routine"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["builder-movement-bench-press"].label.hasPrefix("1. Bench Press"), app.buttons["builder-movement-bench-press"].label)
      XCTAssertTrue(app.buttons["delete-routine"].exists)
      capture(app, "builder-edit-" + appearance)
      app.navigationBars["Edit routine"].buttons["Cancel"].tap()
      app.buttons["routine-close"].tap()
      let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "routine-")).firstMatch
      XCTAssertTrue(row.waitForExistence(timeout: 5))
      XCTAssertEqual(row.label, "Push A, 1 movement · never trained")
      XCTAssertFalse(app.buttons["Movements"].exists)
      XCTAssertFalse(app.buttons["routines-sign-in"].exists)
      capture(app, "list-" + appearance)
      row.tap()
      XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["routine-detail-movement-bench-press"].exists)
      app.terminate()
    }
  }

  // The builder's bar is Cancel · title · Save at every size: Reorder stands with the movements, the title stays while
  // reordering, Save never folds into an overflow, and a refusal answers a Save, never a keystroke.
  func testBuilderBarKeepsTitleAndSaveAtAccessibilityTextAndRefusesOnSave() {
    let app = launch(arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
    app.buttons["new-routine"].tap()
    let name = app.textFields["routine-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5)); name.typeText("Upper body strength day")
    let refusal = app.otherElements["routine-refusal"]
    XCTAssertFalse(refusal.waitForExistence(timeout: 2), "A refusal answered a keystroke")
    let save = app.buttons["save-routine"]
    XCTAssertTrue(save.isHittable)
    save.tap()
    XCTAssertTrue(refusal.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["A routine is at least one movement."].exists)
    let add = app.buttons["add-movement"]
    XCTAssertTrue(add.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertFalse(add.frame.intersects(refusal.frame), "The refusal \(refusal.frame) covers Add movement \(add.frame)")
    for id in ["bench-press", "deadlift"] {
      add.tap()
      let movement = app.buttons["gym-movement-" + id]
      XCTAssertTrue(movement.waitForExistence(timeout: 5))
      for _ in 0..<8 where !movement.isHittable { app.swipeUp(velocity: .slow) }
      movement.tap()
    }
    XCTAssertTrue(refusal.waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.buttons["reorder-movements"].exists)
    XCTAssertTrue(app.buttons["Reorder 2. Deadlift"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars.staticTexts["New routine"].exists, "The builder's title left the bar while reordering")
    XCTAssertTrue(save.exists && save.isHittable, "Save folded into the bar's overflow")
    XCTAssertLessThanOrEqual(save.frame.maxY, app.navigationBars.firstMatch.frame.maxY)
  }

  func testCustomCreationAndRenameScreensInBothAppearances() {
    for appearance in ["dark", "light"] {
      let app = launch(appearance)
      createRoutine(app)
      app.buttons["edit-routine"].tap()
      app.buttons["add-movement"].tap()
      XCTAssertTrue(app.navigationBars["Add movement"].waitForExistence(timeout: 5))
      capture(app, "picker-custom-" + appearance)
      app.buttons["gym-new-movement"].tap()
      let commit = app.buttons["gym-movement-create-commit"]
      XCTAssertTrue(commit.waitForExistence(timeout: 5))
      XCTAssertEqual(commit.label, "Add")
      XCTAssertLessThanOrEqual(commit.frame.maxY, app.navigationBars["Create movement"].frame.maxY)
      XCTAssertFalse(commit.isEnabled)
      XCTAssertFalse(app.staticTexts["Name it to save it."].exists)
      XCTAssertEqual(app.textFields["gym-movement-name"].placeholderValue, "Name")
      capture(app, "creation-empty-" + appearance)
      app.navigationBars["Create movement"].buttons["Cancel"].tap()
      replace(app.textFields["gym-movement-search"], with: "Cable curl")
      let offer = app.buttons["gym-create-movement"]
      XCTAssertTrue(offer.waitForExistence(timeout: 5))
      XCTAssertEqual(offer.label, "Create “Cable curl”")
      XCTAssertFalse(app.buttons["gym-new-movement"].exists)
      offer.tap()
      XCTAssertEqual(app.textFields["gym-movement-name"].value as? String, "Cable curl")
      assertPrimaryLabelContrast(commit, appearance: appearance, minimumWidth: 24)
      capture(app, "creation-" + appearance)
      commit.tap()
      XCTAssertTrue(app.buttons["save-routine"].waitForExistence(timeout: 10))
      app.buttons["save-routine"].tap()
      let custom = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "routine-detail-movement-", "Cable curl")).firstMatch
      XCTAssertTrue(custom.waitForExistence(timeout: 5))
      app.buttons["routine-start"].tap()
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
      app.descendants(matching: .any)["workout-current-set"].swipeLeft()
      XCTAssertTrue(app.buttons["Cable curl"].waitForExistence(timeout: 5))
      app.buttons["workout-log"].tap(); app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.buttons["workout-done"].waitForExistence(timeout: 10)); app.buttons["workout-done"].tap()
      let record = app.buttons["gym-session-movement"].firstMatch
      XCTAssertTrue(record.waitForExistence(timeout: 5)); record.tap()
      openRename(app)
      retype(app.textFields["gym-rename-movement-name"], with: "My curl")
      app.buttons["gym-rename-movement-commit"].tap()
      XCTAssertTrue(app.navigationBars["My curl"].waitForExistence(timeout: 5))
      app.terminate()
    }
  }

  func testCancelDraftReopenAndDeleteWithoutUndo() {
    let app = launch()
    createRoutine(app)
    app.buttons["edit-routine"].tap()
    replace(app.textFields["routine-name"], with: "Cancelled name")
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.navigationBars["Push A"].waitForExistence(timeout: 5))
    app.buttons["routine-close"].tap()
    let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "routine-", "Push A,")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5)); row.swipeLeft()
    app.buttons["Delete"].tap()
    XCTAssertTrue(row.waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.buttons["gym-routines-undo"].exists)
    XCTAssertTrue(app.staticTexts["No routines yet"].exists)
  }

  func testEditorDeletesTheRoutineAndClosesItsSummary() {
    let app = launch()
    createRoutine(app)
    app.buttons["edit-routine"].tap()
    XCTAssertTrue(app.navigationBars["Edit routine"].waitForExistence(timeout: 5))
    let delete = app.buttons["delete-routine"]
    for _ in 0..<4 where !(delete.exists && delete.isHittable) { app.swipeUp(velocity: .slow) }
    delete.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars["Edit routine"].waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.descendants(matching: .any)["routine-detail"].exists)
    XCTAssertFalse(app.staticTexts["Push A"].exists)
    XCTAssertFalse(app.buttons["gym-routines-undo"].exists)
  }

  func testSignedInEmptyRoutinesOffersOneReachablePlus() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-notice", "-onboarding-appearance", "dark"]
    app.launch()
    XCTAssertTrue(app.buttons["workout-assembly"].waitForExistence(timeout: 10)); app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    XCTAssertTrue(app.staticTexts["No routines yet"].waitForExistence(timeout: 10))
    let add = app.buttons["new-routine"]
    XCTAssertTrue(add.waitForExistence(timeout: 5))
    XCTAssertGreaterThanOrEqual(add.frame.height, 44)
    XCTAssertGreaterThan(add.frame.midY, app.frame.midY)
    XCTAssertGreaterThan(add.frame.midX, app.frame.midX)
    XCTAssertFalse(app.buttons["routines-setup"].exists)
    capture(app, "empty-signed-in")
    add.tap()
    XCTAssertTrue(app.textFields["routine-name"].waitForExistence(timeout: 5))
  }

  func testRoutineSummaryClosesReopensAndStartsWorkout() {
    let app = launch()
    XCTAssertFalse(app.buttons["Just start logging"].exists)
    XCTAssertFalse(app.buttons["routines-movements"].exists)
    XCTAssertFalse(app.buttons["routines-sign-in"].exists)
    XCTAssertFalse(app.staticTexts["Your log is saved on this device."].exists)
    createRoutine(app)
    XCTAssertEqual(app.buttons["routine-start"].label, "Start")
    XCTAssertTrue(app.buttons["edit-routine"].isHittable)
    app.buttons["routine-close"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["routine-detail"].waitForNonExistence(timeout: 5))
    let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "routine-", "Push A,")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
    XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 5))
    app.buttons["routine-start"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-workout"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Bench Press"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["routine-detail"].exists)
  }

  func testUnplannedWorkoutOffersTheWrittenProgram() {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "workout-free-empty"]
    app.launch()
    viewport = app.frame
    XCTAssertTrue(app.buttons["workout-assembly"].waitForExistence(timeout: 10)); app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5)); app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.navigationBars["Next movement"].waitForExistence(timeout: 5))
    let door = app.buttons["gym-build-written-program"]
    for _ in 0..<16 {
      if door.exists, !door.frame.isEmpty, app.frame.contains(door.frame),
         door.frame.maxY < viewport.maxY - 16, door.isHittable { break }
      app.collectionViews["gym-movement-picker"].swipeUp(velocity: .fast)
    }
    XCTAssertLessThan(door.frame.maxY, viewport.maxY - 16)
    XCTAssertTrue(door.isHittable)
    door.tap()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 5))
  }

  func testRoutineWorkoutCanAddAnotherMovementAfterLoggingASet() {
    let app = launch()
    createRoutine(app)
    app.buttons["routine-start"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5)); app.buttons["workout-log"].tap()
    let sets = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-"))
    XCTAssertTrue(sets.firstMatch.waitForExistence(timeout: 5)); XCTAssertEqual(sets.count, 1)
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5)); app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.navigationBars["Next movement"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["gym-movement-back-squat"].exists)
    app.terminate()
  }

  func testFinishedRoutineMovementOpensTheCommonRecord() {
    let app = launch()
    createRoutine(app)
    app.buttons["routine-start"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    app.buttons["workout-log"].tap(); app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.buttons["workout-done"].waitForExistence(timeout: 10)); app.buttons["workout-done"].tap()
    let movement = app.buttons["gym-session-movement"].firstMatch
    XCTAssertTrue(movement.waitForExistence(timeout: 5)); movement.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["gym-record-empty"].exists)
    openRename(app)
    retype(app.textFields["gym-rename-movement-name"], with: "Bench today")
    app.buttons["gym-rename-movement-commit"].tap()
    XCTAssertTrue(app.textFields["gym-rename-movement-name"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars.staticTexts["Bench today"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["gym-record-empty"].exists)
  }

  func testBuilderReorderRemoveAndAddMovementAgain() {
    let app = launch()
    app.buttons["new-routine"].tap()
    replace(app.textFields["routine-name"], with: "Training day")
    for id in ["bench-press", "deadlift"] {
      app.buttons["add-movement"].tap()
      app.buttons["gym-movement-" + id].tap()
    }
    XCTAssertFalse(app.buttons["reorder-movements"].exists)
    XCTAssertTrue(app.navigationBars.staticTexts["New routine"].exists, "The builder's title left the bar while reordering")
    let deadliftHandle = app.buttons["Reorder 2. Deadlift"]
    XCTAssertTrue(deadliftHandle.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertTrue(app.buttons["Reorder 1. Bench Press"].wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertTrue(deadliftHandle.exists)
    let deadlift = app.buttons["builder-movement-deadlift"]
    func settledFrame() -> CGRect {
      let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        guard deadlift.exists, deadlift.isEnabled, deadlift.isHittable else { return false }
        let frame = deadlift.frame
        return !frame.isEmpty && self.viewport.contains(frame)
      }, object: deadlift)
      XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
      return deadlift.frame
    }
    _ = settledFrame()
    deadlift.press(forDuration: 1)
    let moveUp = app.buttons["Move up"]
    XCTAssertTrue(moveUp.wait(for: \.isHittable, toEqual: true, timeout: 5)); moveUp.tap()
    let firstMovement = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "builder-movement-")).element(boundBy: 0)
    XCTAssertTrue(firstMovement.wait(for: \.identifier, toEqual: "builder-movement-deadlift", timeout: 5))
    let remove = app.buttons["builder-remove-deadlift"]
    XCTAssertTrue(remove.wait(for: \.isHittable, toEqual: true, timeout: 5)); remove.tap()
    XCTAssertTrue(deadlift.waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.buttons["builder-undo"].exists)
    app.buttons["add-movement"].tap()
    XCTAssertFalse(app.buttons["gym-movement-bench-press"].isEnabled)
    XCTAssertTrue(app.buttons["gym-movement-deadlift"].isEnabled)
    app.buttons["gym-movement-deadlift"].tap()
    app.buttons["save-routine"].tap()
    let deadliftSummary = app.staticTexts.matching(identifier: "routine-detail-movement-deadlift")
    XCTAssertTrue(deadliftSummary.firstMatch.waitForExistence(timeout: 5))
    XCTAssertEqual(deadliftSummary.allElementsBoundByIndex.map(\.label), ["2. Deadlift", "open"])
    XCTAssertEqual(app.staticTexts.matching(identifier: "routine-detail-movement-bench-press").allElementsBoundByIndex.map(\.label), ["1. Bench Press", "open"])
    XCTAssertFalse(app.staticTexts["Open movements have no target — you decide the numbers at the rack."].exists, "Open explains itself")
  }

  // The builder's search is a field in its list, so the pushed Create movement's bar checkmark takes the tap.
  func testBuilderSearchCreatesAMovementThatCommitsFromItsBar() {
    let app = launch()
    app.buttons["new-routine"].tap()
    replace(app.textFields["routine-name"], with: "Zercher day")
    app.buttons["add-movement"].tap()
    replace(app.textFields["gym-movement-search"], with: "Zercher squat")
    let offer = app.buttons["gym-create-movement"]
    XCTAssertTrue(offer.waitForExistence(timeout: 5))
    XCTAssertEqual(offer.label, "Create “Zercher squat”")
    offer.tap()
    let commit = app.buttons["gym-movement-create-commit"]
    XCTAssertTrue(commit.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    XCTAssertEqual(app.textFields["gym-movement-name"].value as? String, "Zercher squat")
    commit.tap()
    XCTAssertTrue(app.buttons["save-routine"].waitForExistence(timeout: 5), "The bar's checkmark committed the movement")
    let added = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "builder-movement-", "Zercher squat"))
    XCTAssertTrue(added.firstMatch.waitForExistence(timeout: 5))
  }

  func testBuilderCustomCreationTakesOpenTargetsAndCancelKeepsQuery() {
    let app = launch()
    app.buttons["new-routine"].tap()
    replace(app.textFields["routine-name"], with: "Custom day")
    app.buttons["add-movement"].tap()
    replace(app.textFields["gym-movement-search"], with: "Custom press")
    app.buttons["gym-create-movement"].tap()
    let commit = app.buttons["gym-movement-create-commit"]
    XCTAssertTrue(commit.waitForExistence(timeout: 5))
    XCTAssertEqual(commit.label, "Add")
    XCTAssertTrue(commit.isEnabled)
    XCTAssertEqual(app.buttons["gym-movement-targets"].label, "Targets, open")
    XCTAssertFalse(app.staticTexts["Choose at least one set."].exists)
    XCTAssertFalse(app.staticTexts["Name it to save it."].exists)
    let name = app.textFields["gym-movement-name"]
    name.tap()
    name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Custom press".count))
    XCTAssertTrue(commit.wait(for: \.isEnabled, toEqual: false, timeout: 5))
    XCTAssertFalse(app.staticTexts["Name it to save it."].exists)
    replace(name, with: "Custom press kept")
    app.navigationBars["Create movement"].buttons["Cancel"].tap()
    XCTAssertEqual(app.textFields["gym-movement-search"].value as? String, "Custom press")
    app.buttons["gym-create-movement"].tap()
    XCTAssertEqual(app.textFields["gym-movement-name"].value as? String, "Custom press kept")
    app.textFields["gym-movement-name"].tap()
    app.textFields["gym-movement-name"].typeText("\n")
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 10))
    let targets = app.buttons["gym-movement-targets"]
    XCTAssertTrue(targets.isHittable)
    XCTAssertTrue(app.frame.contains(targets.frame), "The whole Targets row is on screen at rest")
    XCTAssertLessThanOrEqual(app.buttons["gym-movement-create-commit"].frame.maxY, app.navigationBars["Create movement"].frame.maxY)
    targets.tap()
    replace(app.textFields["gym-target-sets"], with: "2")
    app.navigationBars["Targets"].buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["gym-movement-targets"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["gym-movement-targets"].label, "Targets, open")
    XCTAssertTrue(app.buttons["gym-movement-create-commit"].isEnabled)
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
    XCTAssertTrue(waitForPrimaryButton(create, minimumWidth: 24))
    XCTAssertTrue(create.isEnabled)
    let createFrame = create.frame
    XCTAssertFalse(createFrame.isEmpty)
    XCTAssertTrue(app.frame.contains(createFrame))
    create.tap()
    XCTAssertTrue(app.buttons["save-routine"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.textFields["routine-name"].value as? String, "Custom day")
    app.buttons["save-routine"].tap()
    XCTAssertTrue(app.navigationBars["Custom day"].waitForExistence(timeout: 5))
    let title = app.staticTexts["1. Custom press kept · yours"]
    XCTAssertTrue(title.waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts.matching(identifier: title.identifier).allElementsBoundByIndex.map(\.label), ["1. Custom press kept · yours", "1 × max"])
  }

  func testProposalScreensInBothAppearances() {
    for appearance in ["dark", "light"] {
      let app = launch(appearance, proposal: true)
      XCTAssertTrue(app.buttons["routine-proposal"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["routine-proposal"].label.hasPrefix("Push A · 1 change, From Coach"), app.buttons["routine-proposal"].label)
      XCTAssertFalse(app.staticTexts["Review changes"].exists)
      let routine = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "routine-", "Push A")).firstMatch
      XCTAssertTrue(routine.waitForExistence(timeout: 5))
      XCTAssertFalse(routine.label.contains("proposal"), routine.label)
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
      XCTAssertGreaterThanOrEqual(ask.frame.height, 44, "Ask Coach must answer a 44 pt target, not its label")
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
      XCTAssertTrue(done.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertEqual(question.value as? String, "Tell me about the proposal for Push A.")
      let routines = app.tabBars.buttons["Routines"]
      let tabBar = app.tabBars.firstMatch
      let routinesReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        guard let snapshot = try? tabBar.snapshot(),
              let button = self.descendant(in: snapshot, type: .button, named: "Routines") else { return false }
        return button.isEnabled && !button.frame.isEmpty && snapshot.frame.contains(button.frame) && self.viewport.contains(button.frame)
      }, object: nil)
      XCTAssertEqual(XCTWaiter.wait(for: [routinesReady], timeout: 30), .completed)
      XCTAssertTrue(routines.isHittable)
      routines.tap()
      XCTAssertTrue(routines.wait(for: \.isSelected, toEqual: true, timeout: 5))
      XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["routine-proposal"].exists)
      app.terminate()
    }
  }

  // A connected tool's proposal that an edit here put out of date keeps its row, Out of date, and its Review says why
  // where Apply stood, with no Turn this down.
  func testAConnectedToolsOutOfDateProposalKeepsItsRowInBothAppearances() {
    for appearance in ["light", "dark"] {
      let app = launch(appearance, proposal: true, arguments: ["-routines-tool-proposal"])
      let row = app.buttons["routine-proposal-out-of-date"]
      XCTAssertTrue(row.waitForExistence(timeout: 15))
      XCTAssertEqual(row.label, "Push A · 1 change, Out of date")
      XCTAssertFalse(app.buttons["routine-proposal"].exists)
      capture(app, "tool-out-of-date-" + appearance)
      row.tap()
      XCTAssertTrue(app.descendants(matching: .any)["gym-proposal-review"].waitForExistence(timeout: 5))
      let line = app.staticTexts["coach-review-out-of-date"]
      XCTAssertTrue(line.waitForExistence(timeout: 5))
      XCTAssertTrue(["The routine changed after this was written. Nothing was applied.", "This proposal is out of date. Nothing was applied."].contains(line.label), line.label)
      XCTAssertTrue(app.staticTexts["A heavier bench target"].exists)
      XCTAssertFalse(app.buttons["coach-apply-proposal"].exists)
      XCTAssertFalse(app.buttons["Turn this down"].exists)
      capture(app, "tool-out-of-date-review-" + appearance)
      app.terminate()
    }
  }

  func testRoutinesSummaryStaysReachableAtLargestText() {
    let app = launch("light", proposal: true, arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier != %@", "routine-", "routine-proposal")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 15))
    for _ in 0..<8 where !row.isHittable { app.swipeUp(velocity: .slow) }
    row.tap()
    let start = app.buttons["routine-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 5))
    XCTAssertTrue(start.isHittable)
    XCTAssertTrue(app.frame.contains(start.frame))
    XCTAssertTrue(app.buttons["routine-close"].isHittable)
    capture(app, "summary-accessibility")
    app.buttons["routine-close"].tap()
    XCTAssertTrue(app.tabBars.buttons["Routines"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["routines-movements"].exists)
    XCTAssertFalse(app.buttons["Just start logging"].exists)
  }
}
