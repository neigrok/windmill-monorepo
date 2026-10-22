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
      let discard = app.alerts["Discard 1 page?"]
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
