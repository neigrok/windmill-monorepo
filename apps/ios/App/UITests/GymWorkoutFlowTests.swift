import XCTest
import Vision

@MainActor final class GymWorkoutFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func launch(_ board: String = "workout-planned", appearance: String = "dark", arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board, "-onboarding-appearance", appearance] + arguments
    app.launch()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10),
                  "BoardFixture must call WorkoutFixture.prepare before the journal fixture. The shared fixture hook is outside Workout territory.")
    return app
  }

  func testKeypadCancelCommitAndLiveFix() {
    let app = launch()
    app.buttons["workout-weight"].tap()
    XCTAssertTrue(app.buttons["workout-key-1"].waitForExistence(timeout: 5))
    app.buttons["workout-key-1"].tap(); app.buttons["workout-key-2"].tap()
    XCTAssertEqual(app.staticTexts["workout-keypad-value"].label, "12")
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["workout-weight"].label.contains("100"))
    app.buttons["workout-weight"].tap()
    app.buttons["workout-key-1"].tap(); app.buttons["workout-key-0"].tap(); app.buttons["workout-key-5"].tap()
    app.buttons["workout-keypad-set"].tap()
    app.buttons["workout-log"].tap()
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    XCTAssertTrue(app.buttons["workout-fix-save"].waitForExistence(timeout: 5))
    let note = app.textFields["workout-fix-note"]
    note.tap(); note.typeText("A retained set note")
    app.buttons["workout-fix-save"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
  }

  // At the first accessibility sizes the rack reflows instead of scrolling: every control is on screen at rest, none under
  // Log set, and the keypad keeps its last row above Set.
  func testRackAndKeypadKeepEveryControlInReachAtAccessibilityText() {
    let app = launch(arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
    let log = app.buttons["workout-log"]
    XCTAssertTrue(log.wait(for: \.isHittable, toEqual: true, timeout: 5))
    let ladder = ["−10 kilograms", "−2.5 kilograms", "+2.5 kilograms", "+10 kilograms"].map { app.buttons[$0] }
    for control in ladder + [app.buttons["Fewer reps"], app.buttons["workout-reps"], app.buttons["More reps"], app.buttons["workout-weight"]] {
      XCTAssertTrue(control.exists && control.isHittable, "\(control) is out of reach at rest")
      XCTAssertTrue(app.frame.contains(control.frame), "\(control.frame) leaves the screen")
      XCTAssertFalse(control.frame.intersects(log.frame), "\(control.frame) sits under Log set \(log.frame)")
    }
    XCTAssertTrue(log.label.hasPrefix("Log set, 100 kilograms, "), log.label)
    app.buttons["workout-weight"].tap()
    let set = app.buttons["workout-keypad-set"]
    XCTAssertTrue(set.waitForExistence(timeout: 5))
    for key in ["1", "2", "3", "4", "5", "6", "7", "8", "9", "±", "0", "."] {
      let button = app.buttons["workout-key-\(key)"]
      XCTAssertTrue(button.isHittable, "Key \(key) is out of reach")
      XCTAssertLessThanOrEqual(button.frame.maxY, set.frame.minY, "Key \(key) \(button.frame) sits under Set \(set.frame)")
    }
    app.buttons["workout-key-6"].tap(); app.buttons["workout-key-0"].tap(); set.tap()
    XCTAssertTrue(app.buttons["workout-weight"].wait(for: \.label, toEqual: "Weight, 60 kilograms", timeout: 5))
  }

  // The receipt's primary and its footer stand in one reach band: at the largest text the rows that scroll beneath soften
  // under the band's edge, so no row's text reads crisply against the footer's line.
  func testReceiptRowsSoftenUnderItsBandAtAccessibilityText() throws {
    let app = launch(appearance: "light", arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
    app.buttons["workout-finish"].tap()
    let keep = app.buttons["Keep this log"]
    XCTAssertTrue(keep.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["This log is only on this phone."].exists)
    RunLoop.current.run(until: Date().addingTimeInterval(1))
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = "receipt-band-ax3"; attachment.lifetime = .keepAlways; add(attachment)
    let image = try XCTUnwrap(screenshot.image.cgImage)
    let scale = CGFloat(image.width) / app.frame.width
    let strip = CGRect(x: 16, y: keep.frame.minY - 16, width: app.frame.width - 32, height: 14)
    let width = image.width, height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    pixels.withUnsafeMutableBytes { bytes in
      let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
      context?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    var darkest = 1.0, lightest = 0.0
    for y in Int(strip.minY * scale)..<Int(strip.maxY * scale) {
      for x in Int(strip.minX * scale)..<Int(strip.maxX * scale) {
        let offset = (y * width + x) * 4
        let linear = (0..<3).map { channel -> Double in
          let value = Double(pixels[offset + channel]) / 255
          return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        let luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
        darkest = min(darkest, luminance); lightest = max(lightest, luminance)
      }
    }
    XCTAssertLessThan((lightest + 0.05) / (darkest + 0.05), 4.5, "A row reads crisply under the band at \(strip)")
  }

  // Fix set commits from its bar, so the destructive row and its caption stand clear at rest.
  func testFixSetSavesFromItsBarAndLeavesDeleteAndItsCaptionClear() {
    let app = launch(appearance: "light")
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    let save = app.buttons["workout-fix-save"]
    XCTAssertTrue(save.waitForExistence(timeout: 5))
    XCTAssertEqual(save.label, "Save")
    XCTAssertLessThanOrEqual(save.frame.maxY, app.navigationBars["Fix set"].frame.maxY)
    let delete = app.buttons["workout-fix-delete"], caption = app.staticTexts["Lower A keeps its planned targets."]
    XCTAssertTrue(delete.isHittable && caption.exists)
    XCTAssertTrue(app.frame.contains(caption.frame), "The caption \(caption.frame) is below the sheet at rest")
  }

  // Session detail numbers a set the way the ledger did: a warmup by its letter, work sets from one.
  func testSessionDetailNumbersSetsAsTheLedgerDid() {
    let app = launch(appearance: "light")
    let ledger = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-"))
    XCTAssertTrue(ledger.firstMatch.waitForExistence(timeout: 5))
    XCTAssertEqual((0..<ledger.count).map { ledger.element(boundBy: $0).label.components(separatedBy: ",").first }, ["Warmup", "Set 1", "Set 2"])
    app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10)); app.buttons["Done"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
    let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-finished-set-"))
    XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5))
    XCTAssertEqual((0..<rows.count).map { rows.element(boundBy: $0).label.components(separatedBy: ",").first },
                   ["W · 80 × 3", "1 · 100 × 5", "2 · 100 × 5"])
  }

  func testPagerAssemblyAndHeavierBoundary() {
    let app = launch()
    let weight = app.buttons["workout-weight"]
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in weight.exists && weight.isEnabled && weight.isHittable }, object: weight)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
    weight.tap()
    XCTAssertTrue(app.buttons["workout-key-1"].waitForExistence(timeout: 5))
    for key in ["1", "0", "5"] { app.buttons["workout-key-\(key)"].tap() }
    app.buttons["workout-keypad-set"].tap(); app.buttons["workout-log"].tap()
    app.buttons["workout-next"].tap()
    XCTAssertTrue(app.buttons["workout-deviation-today"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Save 105 to Lower A?"].exists)
    XCTAssertTrue(app.staticTexts["Today’s workout already has it."].exists)
    XCTAssertEqual(app.buttons["workout-deviation-save"].firstMatch.label, "Save to Lower A")
    XCTAssertFalse(app.navigationBars["Heavier than the plan"].exists)
    app.buttons["workout-deviation-today"].firstMatch.tap()
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
    app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
    app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText("Bench")
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
    app.buttons["gym-movement-bench-press"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Bench Press"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["workout-weight"].label, "Weight, 20 kilograms")
    app.buttons["workout-log"].tap()
    let chosenSet = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(chosenSet.waitForExistence(timeout: 5))
    XCTAssertTrue(chosenSet.label.contains("20 kg, 5 reps"))
    app.buttons["workout-previous"].tap()
    XCTAssertTrue(app.buttons["Romanian Deadlift"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, 0)
  }

  func testFinishRetainsReceiptAndSaveRoutineInBothAppearances() {
    for appearance in ["light", "dark"] {
      let app = launch("workout-free", appearance: appearance)
      app.buttons["workout-log"].tap(); app.buttons["workout-log"].tap()
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.staticTexts["Well done."].waitForExistence(timeout: 5),
                    "GymRoom must retain the cover using gym.workout.isPresented after Finish clears openSession.")
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = "receipt-\(appearance)"; attachment.lifetime = .keepAlways; add(attachment)
      app.swipeUp()
      let save = app.buttons["workout-save-routine"]
      XCTAssertTrue(save.waitForExistence(timeout: 5)); save.tap()
      XCTAssertTrue(app.staticTexts["workout-routine-kept"].waitForExistence(timeout: 5))
      app.buttons["Done"].tap()
      XCTAssertFalse(app.buttons["workout-log"].exists)
      app.terminate()
    }
  }

  func testHiddenWorkoutRestoresFromGymSettingsWithItsSets() {
    let app = launch()
    app.buttons["workout-log"].tap()
    let retained = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 5)); app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["you-gym-settings"].waitForExistence(timeout: 5)); app.buttons["you-gym-settings"].tap()
    XCTAssertTrue(app.buttons["gym-restore-workout"].waitForExistence(timeout: 5)); app.buttons["gym-restore-workout"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, retained)
  }

  func testDismissLocalFailureRevealsDurableWorkoutRefusal() {
    let app = launch("workout-notice")
    XCTAssertTrue(app.staticTexts["Check the weight and reps before logging."].waitForExistence(timeout: 5))
    app.otherElements["workout-refusal"].buttons["Dismiss message"].tap()
    let retained = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "not sent.")).firstMatch
    XCTAssertTrue(retained.waitForExistence(timeout: 5))
    app.otherElements["workout-refusal"].buttons["Dismiss message"].tap()
    XCTAssertTrue(retained.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-log"].exists)
  }

  func testOfflineFinishWarningLeadsWithItsConnectionRequirementAtLargestText() throws {
    let app = launch("workout-notice")
    app.terminate()
    app.launchArguments = ["-board", "workout-notice", "-restore-board",
                           "-server", "https://offline.invalid", "-offline-fixture", "no-network",
                           "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    app.launch()
    let log = app.buttons["workout-log"]
    XCTAssertTrue(log.waitForExistence(timeout: 3)); XCTAssertTrue(log.isEnabled); XCTAssertTrue(log.isHittable)
    log.tap(); app.buttons["workout-finish"].tap()
    let message = "Finish needs a connection — keep logging, or hide the workout."
    XCTAssertTrue(app.staticTexts[message].waitForExistence(timeout: 3))
    var captures = 0
    func visibleText() throws -> String {
      let screenshot = app.screenshot()
      let attachment = XCTAttachment(screenshot: screenshot)
      attachment.name = "offline-finish-warning-AX5-\(captures)"
      attachment.lifetime = .keepAlways; add(attachment); captures += 1
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.recognitionLanguages = ["en-US"]
      try VNImageRequestHandler(cgImage: XCTUnwrap(screenshot.image.cgImage)).perform([request])
      return (request.results ?? []).sorted { $0.boundingBox.minY > $1.boundingBox.minY }
        .compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased()
        .split(separator: " ").filter { $0 != "x" }.joined(separator: " ")
    }
    let unscrolled = try visibleText()
    for phrase in ["needs a connection", "log set"] {
      XCTAssertTrue(unscrolled.contains(phrase), "The warning hid ‘\(phrase)’ before any scroll: \(unscrolled)")
    }
    var rendered = unscrolled
    let notice = app.scrollViews.containing(.staticText, identifier: message).firstMatch
    for _ in 0..<12 where !(rendered.contains("keep logging") && rendered.contains("or hide")) {
      guard notice.exists else { break }
      let start = notice.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
      let end = notice.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
      start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
      rendered += " " + (try visibleText())
    }
    for phrase in ["keep logging", "or hide"] {
      XCTAssertTrue(rendered.contains(phrase), "The warning never showed ‘\(phrase)’: \(rendered)")
    }
    XCTAssertTrue(log.isEnabled); XCTAssertTrue(log.isHittable); log.tap()
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.navigationBars["This session"].waitForExistence(timeout: 3))
    let hide = app.buttons["workout-hide"]
    for _ in 0..<4 where !hide.exists || !hide.isHittable { app.swipeUp() }
    XCTAssertTrue(hide.exists)
    XCTAssertTrue(hide.isEnabled); XCTAssertTrue(hide.isHittable); hide.tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 3))
  }
}
