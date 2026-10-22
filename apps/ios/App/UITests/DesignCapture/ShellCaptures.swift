import XCTest

final class ShellCaptures: DesignCapture {
  func testWelcome() {
    for look in Look.both {
      let app = launch("shell-anonymous", look)
      XCTAssertTrue(app.staticTexts["Where to start?"].waitForExistence(timeout: 15))
      capture("shell-welcome-signed-out", look, app, settle: 1.5)
    }
  }

  // Every page at rest, whole. Run on a 375 pt phone for the -375 set.
  func onboarding(_ look: Look) {
    let app = launch("onboarding-fresh", look)
    for page in 1...4 {
      XCTAssertTrue(app.staticTexts["onboarding-title"].waitForExistence(timeout: 10))
      XCTAssertEqual(app.pageIndicators["onboarding-page-control"].label, "Page \(page) of 4")
      capture("shell-onboarding-\(page)", look, app, settle: 1.6)
      app.buttons["onboarding-next"].tap()
    }
    XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10))
  }
  func testOnboarding() { for look in Look.both { onboarding(look) } }
  func testOnboardingLargestText() { for look in Look.bothAtLargestText { onboarding(look) } }

  // 02b–02c: the returning account's arrival is held part-way, so its counts stand still for the capture.
  func testReturning() {
    for look in Look.both {
      let app = launch("02-returning-held", look)
      let signIn = app.buttons["Sign in"]
      XCTAssertTrue(signIn.waitForExistence(timeout: 60)); signIn.tap()
      XCTAssertTrue(app.staticTexts["Pick up where you left off"].waitForExistence(timeout: 5))
      capture("02b-pick-up-where-you-left-off", look, app)
      app.buttons["apple-sign-in"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["restore-head"].waitForExistence(timeout: 30))
      XCTAssertTrue(app.descendants(matching: .any)["restore-gym"].exists)
      capture("02c-bringing-it-back", look, app, settle: 2)
      app.terminate()
    }
  }

  // 26b, 27a–27g: Delete account from You, against the fake server; `-delete-fixture` holds the request or refuses it offline.
  func openDeletion(_ board: String, _ look: Look, _ fixture: String? = nil) -> XCUIApplication {
    let app = launch(board, look, arguments: ["-fake-apple", "-apple-fixture", "linking"] + (fixture.map { ["-delete-fixture", $0] } ?? []))
    reach(app.buttons["delete-account"], app).tap()
    XCTAssertTrue(app.textFields["delete-account-email"].waitForExistence(timeout: 10))
    return app
  }
  func type(_ app: XCUIApplication) {
    let field = app.textFields["delete-account-email"]
    field.tap(); field.typeText("sam@example.com")
    XCTAssertTrue(app.buttons["delete-account-confirm"].wait(for: \.isEnabled, toEqual: true, timeout: 5))
  }
  func testDeleteAccount() {
    captureBoard("26b-you-signed-in") { look in
      let app = launch("24b", look, arguments: ["-fake-apple", "-apple-fixture", "linking"])
      XCTAssertTrue(app.buttons["delete-account"].waitForExistence(timeout: 30))
      return app
    }
    captureBoard("27a-delete-your-account") { look in openDeletion("24b", look) }
    captureBoard("27b-email-typed") { look in let app = openDeletion("24b", look); type(app); return app }
    captureBoard("27f-delete-with-unsent-changes") { look in
      let app = openDeletion("16e", look)
      XCTAssertTrue(app.staticTexts["3 changes on this phone haven’t been confirmed by your account. They are deleted too."].waitForExistence(timeout: 10))
      return app
    }
    captureBoard("27g-email-typed-with-unsent-changes") { look in let app = openDeletion("16e", look); type(app); return app }
    captureBoard("27c-deleting") { look in
      let app = openDeletion("24b", look, "held"); type(app)
      app.buttons["delete-account-confirm"].tap()
      XCTAssertTrue(app.buttons["Deleting…"].waitForExistence(timeout: 10))
      return app
    }
    captureBoard("27d-account-deleted") { look in
      let app = openDeletion("24b", look); type(app)
      app.buttons["delete-account-confirm"].tap()
      XCTAssertTrue(app.staticTexts["Your account is deleted"].waitForExistence(timeout: 20))
      return app
    }
    captureBoard("27e-could-not-delete") { look in
      let app = openDeletion("24b", look, "offline"); type(app)
      app.buttons["delete-account-confirm"].tap()
      XCTAssertTrue(app.staticTexts["Couldn’t delete your account. Check your connection and try again."].waitForExistence(timeout: 20))
      return app
    }
  }

  func testGymKeepAndSignIn() {
    for look in Look.both {
      let app = launch("keep-gym", look)
      XCTAssertTrue(app.staticTexts["Keep your log"].waitForExistence(timeout: 15))
      capture("gym-keep-sheet", look, app)
      app.buttons["email-sign-in"].tap()
      let email = app.textFields["email-address"]
      XCTAssertTrue(email.waitForExistence(timeout: 5))
      capture("gym-sign-in-email-address", look, app)
      email.typeText("you@example.com"); app.buttons["Send code"].tap()
      XCTAssertTrue(app.buttons["link-sign-in"].waitForExistence(timeout: 10))
      capture("shell-sign-in-code", look, app)
      app.buttons["link-sign-in"].tap()
      XCTAssertTrue(app.textFields["sign-in-link"].waitForExistence(timeout: 5))
      capture("shell-sign-in-link", look, app)
    }
  }

  // 22: the quick actions over Windmill's icon on the Home Screen, after a workout of Lower A.
  func testQuickActions() {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    for look in Look.both {
      XCUIDevice.shared.appearance = look.appearance == .dark ? .dark : .light
      let app = launch("workout-planned", look)
      XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 10)); app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10)); app.buttons["Done"].tap()
      XCUIDevice.shared.press(.home)
      let icon = springboard.icons["Windmill"]
      XCTAssertTrue(icon.waitForExistence(timeout: 10)); icon.press(forDuration: 1.5)
      XCTAssertTrue(springboard.buttons["Start Lower A"].waitForExistence(timeout: 5))
      capture("22-quick-actions", look, springboard)
      XCUIDevice.shared.press(.home)
      app.terminate()
    }
    XCUIDevice.shared.appearance = .light
  }

  func testUpdateRequired() {
    for look in Look.both {
      let app = launch("update-required", look)
      let alert = app.alerts["Update required"]
      XCTAssertTrue(alert.waitForExistence(timeout: 20))
      capture("shell-update-required-alert", look, app)
      alert.buttons["Keep working on this phone"].tap()
      XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
      app.buttons["you"].tap()
      XCTAssertTrue(app.staticTexts["Syncing paused · update Windmill"].waitForExistence(timeout: 5))
      capture("shell-you-update-required", look, app)
      app.buttons["get-update"].tap()
      XCTAssertTrue(app.staticTexts["Couldn't open the update. Try again."].waitForExistence(timeout: 5))
      capture("shell-you-update-transient", look, app)
    }
  }

  func testUpdateAtSignIn() {
    for look in Look.both {
      let app = launch("update-sign-in", look)
      XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 20)); app.buttons["email-sign-in"].tap()
      let email = app.textFields["email-address"]
      XCTAssertTrue(email.waitForExistence(timeout: 5)); email.typeText("update@example.com")
      app.buttons["Send code"].tap()
      let code = app.textFields["email-code"]
      XCTAssertTrue(code.waitForExistence(timeout: 5)); code.typeText("482913")
      let alert = app.alerts["Update required"]
      XCTAssertTrue(alert.waitForExistence(timeout: 15))
      capture("shell-update-required-alert-signed-out", look, app)
      alert.buttons["Keep working on this phone"].tap()
      XCTAssertTrue(app.staticTexts["Finish signing in"].waitForExistence(timeout: 5))
      capture("shell-you-sign-in-pending-update", look, app)
    }
  }

  func testAppleLinkingSheets() {
    for look in Look.both {
      let app = launch("23-start", look, arguments: ["-fake-apple", "-apple-fixture", "linking"])
      XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20))
      capture("shell-keep-sheet-apple-door", look, app)
      app.buttons["apple-sign-in"].tap()
      XCTAssertTrue(app.staticTexts["Already on Windmill?"].waitForExistence(timeout: 5))
      capture("shell-apple-already-on-windmill", look, app)
      app.buttons["Use my account"].tap()
      XCTAssertTrue(app.staticTexts["Your Windmill email"].waitForExistence(timeout: 5))
      let field = app.textFields["email-address"]
      field.tap(); field.typeText("sam@example.com")
      capture("23b-your-windmill-email", look, app)
      app.buttons["Send code"].tap()
      XCTAssertTrue(app.textFields["email-code"].waitForExistence(timeout: 5))
      app.textFields["email-code"].tap(); app.textFields["email-code"].typeText("482913")
      XCTAssertTrue(app.staticTexts["Apple added"].waitForExistence(timeout: 5))
      capture("shell-apple-added-receipt", look, app, settle: 0.3)
      let adoption = app.alerts["Add to your account?"]
      XCTAssertTrue(adoption.waitForExistence(timeout: 10))
      capture("shell-adoption-alert", look, app)
      adoption.buttons["Discard"].tap()
      let discard = app.alerts["Discard 1 journal page?"]
      XCTAssertTrue(discard.waitForExistence(timeout: 5))
      capture("shell-discard-adoption-alert", look, app)
      discard.buttons["Cancel"].tap()
      XCTAssertTrue(adoption.waitForExistence(timeout: 5))
      adoption.buttons["Add"].tap()
      XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 10))
      app.buttons["you"].tap()
      XCTAssertTrue(app.buttons["sign-out"].waitForExistence(timeout: 5))
      capture("shell-you-signed-in-email-and-apple", look, app)
      app.buttons["apple-method"].tap()
      XCTAssertTrue(app.buttons["Remove Apple"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts["You'll sign in with sam@example.com instead. Apple won't open this account."].exists)
      capture("shell-remove-apple-confirmation", look, app)
    }
  }

  // The sign-in question over Apple added, in each board's words, and its discard confirmation (23d–23j).
  func testAdoptionQuestions() {
    let boards = [
      ("23d", "23f", 3, 0, "This phone has 3 workouts from before you signed in. Your account already has training. Add them, or discard them from this phone.", "Discard 3 workouts?"),
      ("23g", "23h", 0, 3, "This phone has 3 journal pages from before you signed in. Your account already has journal pages. Add them, or discard them from this phone.", "Discard 3 journal pages?"),
      ("23i", "23j", 2, 3, "This phone has 2 workouts and 3 journal pages from before you signed in. Your account already has training and journal pages. Add them, or discard them from this phone.", "Discard 2 workouts and 3 journal pages?"),
    ]
    for (question, confirmation, workouts, pages, message, discardTitle) in boards {
      for look in Look.both {
        let app = launch("23d", look, arguments: ["-fake-apple", "-apple-fixture", "linking", "-adoption-workouts", "\(workouts)", "-adoption-pages", "\(pages)"])
        let adoption = app.alerts["Add to your account?"]
        XCTAssertTrue(adoption.waitForExistence(timeout: 30))
        XCTAssertTrue(adoption.staticTexts.matching(NSPredicate(format: "label == %@", message)).firstMatch.exists)
        capture("\(question)-add-to-your-account", look, app)
        adoption.buttons["Discard"].tap()
        let discard = app.alerts[discardTitle]
        XCTAssertTrue(discard.waitForExistence(timeout: 5))
        XCTAssertTrue(discard.staticTexts["They are deleted from this phone. You can’t undo this."].exists)
        capture("\(confirmation)-discard", look, app)
        app.terminate()
      }
    }
  }

  func testSignOutQuestions() {
    for (board, fixture, message) in [("16c-sign-out", "24b", "Your pages and log stay in your account and leave this phone."),
      ("16e-sign-out-unconfirmed", "16e", "3 changes haven’t been confirmed by your account yet. Keep them on this phone until you sign in again, or discard them from this phone.")] {
      captureBoard(board) { look in
        let app = launch(fixture, look, arguments: ["-fake-apple", "-apple-fixture", "linking"])
        reach(app.buttons["sign-out"], app).tap()
        let alert = app.alerts["Sign out?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 15))
        XCTAssertTrue(alert.staticTexts.matching(NSPredicate(format: "label == %@", message)).firstMatch.exists)
        return app
      }
    }
  }

  func testAppleRecoveryScreens() {
    for look in Look.both {
      var app = launch("23-start", look, arguments: ["-fake-apple", "-apple-fixture", "linking"])
      XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20)); app.buttons["apple-sign-in"].tap()
      XCTAssertTrue(app.buttons["Use my account"].waitForExistence(timeout: 5)); app.buttons["Use my account"].tap()
      let email = app.textFields["email-address"]
      XCTAssertTrue(email.waitForExistence(timeout: 5)); email.tap(); email.typeText("sam@icloud.com")
      app.buttons["Send code"].tap()
      let code = app.textFields["email-code"]
      XCTAssertTrue(code.waitForExistence(timeout: 5)); code.tap(); code.typeText("482913")
      XCTAssertTrue(app.staticTexts["No account at this email"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["Try another email"].exists)
      capture("shell-apple-no-account", look, app)

      app = launch("23-start", look, arguments: ["-fake-apple", "-apple-fixture", "expired"])
      XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20)); app.buttons["apple-sign-in"].tap()
      XCTAssertTrue(app.staticTexts["Continue with Apple again"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["apple-sign-in"].exists && app.buttons["email-sign-in"].exists)
      capture("shell-apple-expired", look, app)

      app = launch("23-start", look, arguments: ["-fake-apple", "-apple-fixture", "hello-failure"])
      XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20)); app.buttons["apple-sign-in"].tap()
      XCTAssertTrue(app.buttons["Create account"].waitForExistence(timeout: 5)); app.buttons["Create account"].tap()
      XCTAssertTrue(app.buttons["auth-retry"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["Finish signing in"].exists)
      capture("shell-authenticated-sign-in-pending", look, app)

      app = launch("24a", look, arguments: ["-fake-apple", "-apple-fixture", "taken"])
      XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20)); app.buttons["apple-sign-in"].tap()
      XCTAssertTrue(app.alerts["Apple ID already in use"].waitForExistence(timeout: 5))
      capture("shell-apple-identity-in-use-alert", look, app)
    }
  }
}
