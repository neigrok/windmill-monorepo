import XCTest

@MainActor final class ShellFlowTests: XCTestCase {
  func launch(_ board: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board]
    app.launch()
    return app
  }

  func switchRoom(_ room: String, in app: XCUIApplication) {
    let viewport = app.frame
    let menu = app.buttons.matching(NSPredicate(format: "identifier == %@ AND enabled == true", "room-menu")).firstMatch
    XCTAssertTrue(menu.waitForExistence(timeout: 10))
    XCTAssertTrue(menu.wait(for: \.isHittable, toEqual: true, timeout: 5))
    menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
    let item = app.buttons.matching(NSPredicate(format: "identifier == %@ AND enabled == true", "room-\(room.lowercased())")).firstMatch
    XCTAssertTrue(item.waitForExistence(timeout: 5))
    let visibleItem = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let snapshot = try? item.snapshot() else { return false }
      return snapshot.isEnabled && !snapshot.frame.isEmpty && viewport.contains(snapshot.frame)
    }, object: item)
    XCTAssertEqual(XCTWaiter.wait(for: [visibleItem], timeout: 5), .completed)
    item.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
    let selected = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label == %@", "room-menu", room)).firstMatch
    XCTAssertTrue(selected.waitForExistence(timeout: 10))
    XCTAssertEqual(menu.label, room)
  }

  func assertGym(_ app: XCUIApplication) {
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["room-menu"].label, "Gym")
    XCTAssertTrue(app.tabBars.buttons["Routines"].exists)
    XCTAssertTrue(app.tabBars.buttons["The log"].exists)
    XCTAssertTrue(app.tabBars.buttons["Coach"].exists)
  }

  func testSwitchRoomsKeepsJournalAndUsesGymTabs() {
    let app = launch("shell-last-room")
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    let page = editor.value as? String
    switchRoom("Gym", in: app)
    assertGym(app)
    app.tabBars.buttons["The log"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Coach"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-coach"].waitForExistence(timeout: 5))
    switchRoom("Journal", in: app)
    XCTAssertTrue(editor.waitForExistence(timeout: 5))
    XCTAssertEqual(editor.value as? String, page)
    XCTAssertFalse(app.tabBars.firstMatch.exists)
  }

  func testLastRoomPersistsAcrossRelaunch() {
    let app = launch("shell-last-room")
    switchRoom("Gym", in: app)
    assertGym(app)
    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    assertGym(app)
    switchRoom("Journal", in: app)
    app.terminate()
    app.launch()
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["room-menu"].label, "Journal")
  }

  func testAnonymousGymDoorOpensWithoutSigningIn() {
    let app = launch("shell-anonymous")
    XCTAssertTrue(app.staticTexts["Where to start?"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["open-journal"].exists)
    app.buttons["open-gym"].tap()
    assertGym(app)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "gym-anonymous-room"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    XCTAssertFalse(app.buttons["email-sign-in"].exists)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["sign-out"].exists)
  }

  func testSignInWithBothRoomsAsksEachCountBeforeBinding() {
    let app = launch("shell-adoption-two-rooms")
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10))
    app.buttons["email-sign-in"].tap()
    let email = app.textFields["email-address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5))
    email.tap(); email.typeText("shell@example.com")
    XCTAssertTrue(email.waitForValue("shell@example.com"))
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5))
    code.tap(); code.typeText("482913")
    let adoption = app.alerts["Add to your account?"]
    XCTAssertTrue(adoption.waitForExistence(timeout: 15))
    XCTAssertTrue(adoption.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Journal · 1 page")).firstMatch.exists)
    adoption.buttons["Add"].tap()
    let gymQuestion = adoption.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Gym · 1 routine")).firstMatch
    XCTAssertTrue(gymQuestion.waitForExistence(timeout: 10))
    adoption.buttons["Discard"].tap()
    let discard = app.alerts["Discard 1 routine?"]
    XCTAssertTrue(discard.waitForExistence(timeout: 5))
    discard.buttons["Cancel"].tap()
    XCTAssertTrue(gymQuestion.waitForExistence(timeout: 5))
    adoption.buttons["Discard"].tap()
    XCTAssertTrue(discard.waitForExistence(timeout: 5))
    discard.buttons["Discard"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 15))
    XCTAssertFalse(adoption.exists)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["sign-out"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["shell@example.com"].exists)
  }

  // The top band of the screen, where the room's ground meets the status bar, read from a screenshot.
  func groundLuminance(_ app: XCUIApplication) -> Double {
    let image = app.screenshot().image.cgImage!
    let width = image.width, height = image.height
    var pixel = [UInt8](repeating: 0, count: 4)
    let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(image, in: CGRect(x: -width / 2, y: -height * 7 / 10, width: width, height: height))
    return (0.2126 * Double(pixel[0]) + 0.7152 * Double(pixel[1]) + 0.0722 * Double(pixel[2])) / 255
  }

  func testYouIsOneListWithSettingsAndAppearanceAnswersInEveryRoom() {
    let app = launch("shell-anonymous")
    app.buttons["open-gym"].tap()
    assertGym(app)
    app.buttons["you"].tap()
    XCTAssertTrue(app.staticTexts["Not signed in"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["nothing yet"].exists)
    XCTAssertFalse(app.staticTexts["One Windmill account keeps your journal and training together."].exists)
    XCTAssertFalse(app.buttons["link-sign-in"].exists)
    XCTAssertFalse(app.staticTexts["Sign-in needs a connection."].exists)
    XCTAssertTrue(app.buttons["email-sign-in"].isEnabled)
    XCTAssertTrue(app.buttons["you-gym-settings"].exists && app.buttons["about-windmill"].exists)
    let appearance = app.segmentedControls["appearance"]
    XCTAssertTrue(appearance.buttons["System"].isSelected)
    appearance.buttons["Dark"].tap()
    XCTAssertTrue(appearance.buttons["Dark"].wait(for: \.isSelected, toEqual: true, timeout: 5))
    app.navigationBars["You"].buttons["Done"].tap()
    XCTAssertTrue(app.navigationBars["You"].waitForNonExistence(timeout: 5))
    XCTAssertLessThan(groundLuminance(app), 0.2, "Dark answers with the gym's Instrument ground")
    switchRoom("Journal", in: app)
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    XCTAssertLessThan(groundLuminance(app), 0.2, "Dark answers with the journal's Night")
    app.buttons["you"].tap()
    XCTAssertTrue(appearance.waitForExistence(timeout: 5))
    appearance.buttons["Light"].tap()
    XCTAssertTrue(appearance.buttons["Light"].wait(for: \.isSelected, toEqual: true, timeout: 5))
    app.navigationBars["You"].buttons["Done"].tap()
    XCTAssertTrue(app.navigationBars["You"].waitForNonExistence(timeout: 5))
    XCTAssertGreaterThan(groundLuminance(app), 0.85, "Light answers with the journal's Day")
    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    XCTAssertGreaterThan(groundLuminance(app), 0.85, "The choice persists across launches")
    app.buttons["you"].tap()
    XCTAssertTrue(app.segmentedControls["appearance"].buttons["Light"].wait(for: \.isSelected, toEqual: true, timeout: 5))
  }

  func testGymKeepDoorOpensKeepInTheRoomsWords() {
    let app = launch("keep-gym")
    XCTAssertTrue(app.staticTexts["Keep your log"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["It lives only on this phone. Sign in to back it up and open it on the web."].exists)
    XCTAssertTrue(app.buttons["email-sign-in"].exists)
    XCTAssertFalse(app.buttons["link-sign-in"].exists)
    XCTAssertFalse(app.staticTexts["Not signed in"].exists, "The gym's Keep door opens Keep, never You")
  }

  func testUpdateRequiredSpeaksOncePerLaunchAndYouKeepsIt() {
    let app = launch("update-required")
    let alert = app.alerts["Update required"]
    XCTAssertTrue(alert.waitForExistence(timeout: 20))
    XCTAssertTrue(alert.staticTexts["Update Windmill to keep syncing. Your work is saved on this phone."].exists)
    XCTAssertTrue(alert.buttons["Get the update"].exists)
    alert.buttons["Keep working on this phone"].tap()
    XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
    XCTAssertFalse(alert.waitForExistence(timeout: 3), "The alert never returns mid-session")
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.wait(for: \.isHittable, toEqual: true, timeout: 5), "The rooms keep working on the phone")
    app.buttons["you"].tap()
    XCTAssertTrue(app.staticTexts["Syncing paused · update Windmill"].waitForExistence(timeout: 5))
    let update = app.buttons["get-update"]
    XCTAssertTrue(update.exists); update.tap()
    // The simulator has no TestFlight, so the destination cannot open and the transient says so.
    XCTAssertTrue(app.staticTexts["Couldn't open the update. Try again."].waitForExistence(timeout: 5))
    app.buttons["update-failure-dismiss"].tap()
    XCTAssertTrue(app.staticTexts["Couldn't open the update. Try again."].waitForNonExistence(timeout: 5))
    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    XCTAssertTrue(app.alerts["Update required"].waitForExistence(timeout: 20), "A cold launch while the flag holds speaks once more")
  }

  func testUpdateRequiredAtSignInRaisesTheAlertNeverTheErrorText() {
    let app = launch("update-sign-in")
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 15)); app.buttons["email-sign-in"].tap()
    let email = app.textFields["email-address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5)); email.typeText("update@example.com")
    XCTAssertTrue(email.waitForValue("update@example.com"))
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5)); code.typeText("482913")
    let alert = app.alerts["Update required"]
    XCTAssertTrue(alert.waitForExistence(timeout: 15))
    XCTAssertTrue(alert.staticTexts["Update Windmill to sign in. Your work is saved on this phone."].exists, "Signed out, nothing syncs")
    alert.buttons["Keep working on this phone"].tap()
    XCTAssertTrue(app.staticTexts["Syncing paused · update Windmill"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["the server requires a newer app"].exists)
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "newer app")).firstMatch.exists)
    app.navigationBars.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["write-today"].wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertFalse(app.alerts["Update required"].exists)
  }

  // A sign-in the server refuses for an old app leaves You whole: the update line and Get the update above Settings,
  // and a way to give the sign-in up.
  func testUpdateAtSignInLeavesYouReachable() {
    let app = launch("update-sign-in")
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 15)); app.buttons["email-sign-in"].tap()
    let email = app.textFields["email-address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5)); email.typeText("update@example.com")
    XCTAssertTrue(email.waitForValue("update@example.com"))
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5)); code.typeText("482913")
    let alert = app.alerts["Update required"]
    XCTAssertTrue(alert.waitForExistence(timeout: 15))
    alert.buttons["Keep working on this phone"].tap()
    XCTAssertTrue(app.navigationBars["You"].waitForExistence(timeout: 5))
    app.navigationBars.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 5)); app.buttons["you"].tap()
    XCTAssertTrue(app.staticTexts["Finish signing in"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Syncing paused · update Windmill"].exists)
    XCTAssertTrue(app.buttons["get-update"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["appearance"].exists, "You's Settings stay reachable")
    XCTAssertTrue(app.buttons["you-gym-settings"].exists, "Gym settings stay reachable")
    XCTAssertFalse(app.buttons["email-sign-in"].exists, "No second sign-in starts over a pending one")
    app.buttons["auth-cancel"].tap()
    XCTAssertTrue(app.staticTexts["Finish signing in"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Everything lives on this phone"].exists)
    XCTAssertTrue(app.buttons["email-sign-in"].exists)
    app.navigationBars.buttons["Done"].tap()
    app.terminate(); app.launchArguments.append("-restore-board"); app.launch()
    XCTAssertTrue(app.buttons["write-today"].waitForExistence(timeout: 20))
    XCTAssertFalse(app.navigationBars["You"].exists, "Nothing resumes at the next launch")
  }
}
