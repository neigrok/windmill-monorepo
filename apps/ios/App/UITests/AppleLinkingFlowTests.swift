import XCTest

@MainActor final class AppleLinkingFlowTests: XCTestCase {
  let localPage = "Long day. The walk home was the best part — the rain had just stopped and the street smelled of it.\nI want more evenings like that."
  let accountPage = "An earlier page in Sam's account."

  func assertPage(_ app: XCUIApplication, equals expected: String, relaunch: Bool = true) {
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 20))
    let content = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expected), object: editor)
    XCTAssertEqual(XCTWaiter.wait(for: [content], timeout: 20), .completed)
    XCTAssertEqual(editor.value as? String, expected)
    if relaunch {
      app.terminate(); app.launchArguments.append("-restore-board"); app.launch()
      assertPage(app, equals: expected, relaunch: false)
    }
  }
  func launch(_ board: String = "23-start", fixture: String = "linking") -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-fake-apple", "-board", board, "-apple-fixture", fixture]
    app.launch()
    if board == "23d" { XCTAssertTrue(app.alerts["Add to your account?"].waitForExistence(timeout: 20)) }
    else { XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20)) }
    return app
  }

  func question(_ app: XCUIApplication) {
    app.buttons["apple-sign-in"].tap()
    XCTAssertTrue(app.staticTexts["Already on Windmill?"].waitForExistence(timeout: 5))
  }

  func sendCode(_ app: XCUIApplication, email: String = "sam@example.com") {
    app.buttons["Use my account"].tap()
    XCTAssertTrue(app.staticTexts["Your Windmill email"].waitForExistence(timeout: 5))
    let field = app.textFields["email-address"]
    field.tap(); field.typeText(email)
    app.buttons["Send code"].tap()
    XCTAssertTrue(app.textFields["email-code"].waitForExistence(timeout: 5))
    app.textFields["email-code"].tap()
  }

  func test23aCreateAccountKeepsLocalPage() {
    let app = launch(); question(app)
    XCTAssertFalse(app.alerts["Add to your account?"].exists)
    XCTAssertFalse(app.staticTexts["Signed up with email before? Use email, so it stays one account."].exists)
    app.buttons["Create account"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 10))
    assertPage(app, equals: localPage, relaunch: false)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["apple-method"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["sam@privaterelay.appleid.com"].exists)
    XCTAssertTrue(app.staticTexts["Hide My Email"].exists)
    app.buttons["Done"].tap(); assertPage(app, equals: localPage)
  }

  func test23aUseAccountReceiptAnd23dAdd() {
    let app = launch(); question(app); sendCode(app)
    app.textFields["email-code"].typeText("482913")
    XCTAssertTrue(app.staticTexts["Apple added"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Apple now opens sam@example.com."].exists)
    let adoption = app.alerts["Add to your account?"]
    XCTAssertTrue(adoption.waitForExistence(timeout: 10))
    XCTAssertTrue(adoption.staticTexts.matching(NSPredicate(format: "label == %@", "Journal · 1 page from before you signed in is only on this phone, and your account already has pages. Add it, or discard it for good.")).firstMatch.exists)
    adoption.buttons["Add"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 10))
    assertPage(app, equals: accountPage + "\n\n" + localPage)
  }

  func test23dDiscardRequiresConfirmationAndCancelReturns() {
    let app = launch("23d")
    let adoption = app.alerts["Add to your account?"]
    XCTAssertTrue(adoption.waitForExistence(timeout: 15))
    adoption.buttons["Discard"].tap()
    let discard = app.alerts["Discard 1 page?"]
    XCTAssertTrue(discard.waitForExistence(timeout: 5))
    discard.buttons["Cancel"].tap()
    XCTAssertTrue(adoption.waitForExistence(timeout: 5))
    adoption.buttons["Discard"].tap()
    XCTAssertTrue(discard.waitForExistence(timeout: 5)); discard.buttons["Discard"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 10))
    assertPage(app, equals: accountPage)
  }

  func test23eAWrongCodeHoldsDigitsAndHasSpecificCopy() {
    let app = launch(); question(app); sendCode(app)
    let field = app.textFields["email-code"]
    field.typeText("482931")
    XCTAssertTrue(app.staticTexts["That code didn't work. Check the digits, or send a fresh one."].waitForExistence(timeout: 5))
    XCTAssertEqual(field.value as? String, "482931")
    XCTAssertFalse(app.staticTexts["No account at this email"].exists)
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Resend code in")).firstMatch.exists)
  }

  func test23eBNoAccountOnlyAfterValidCodeAndCanCreate() {
    let app = launch(); question(app); sendCode(app, email: "sam@icloud.com")
    XCTAssertFalse(app.staticTexts["No account at this email"].exists)
    app.textFields["email-code"].typeText("482913")
    XCTAssertTrue(app.staticTexts["No account at this email"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["sam@icloud.com doesn't open a Windmill account. Try the address you signed up with, or create one with Apple."].exists)
    app.buttons["Try another email"].tap()
    XCTAssertTrue(app.staticTexts["Your Windmill email"].waitForExistence(timeout: 5))
    app.buttons["Back"].tap()
    XCTAssertTrue(app.buttons["Create account"].waitForExistence(timeout: 5)); app.buttons["Create account"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 10))
  }

  func test23eCOfflineLeavesQuestionAndPages() {
    let app = launch(fixture: "offline"); question(app)
    app.buttons["Create account"].tap()
    XCTAssertTrue(app.staticTexts["Sign-in needs a connection. Your work stays on this phone."].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Create account"].isEnabled)
    app.buttons["Close"].tap()
    XCTAssertTrue(app.staticTexts["Keep your pages"].waitForExistence(timeout: 5))
  }

  func test23eDExpiredTicketReturnsToAppleDoors() {
    let app = launch(fixture: "expired")
    app.buttons["apple-sign-in"].tap()
    XCTAssertTrue(app.staticTexts["Continue with Apple again"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Apple's sign-in lasts 15 minutes, and this one ran out. Nothing was created."].exists)
    XCTAssertTrue(app.buttons["apple-sign-in"].exists && app.buttons["email-sign-in"].exists)
    XCTAssertFalse(app.buttons["Create account"].exists)
  }

  func test24aAttach24bRemove24cKeepsEmail() {
    let app = launch("24a")
    XCTAssertTrue(app.staticTexts["Apple will open this same account."].exists)
    XCTAssertTrue(app.staticTexts["sam@example.com"].exists)
    app.buttons["apple-sign-in"].tap()
    XCTAssertTrue(app.buttons["apple-method"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Either one opens this account."].exists)
    XCTAssertTrue(app.staticTexts["Hide My Email"].exists)
    app.buttons["apple-method"].tap()
    let remove = app.buttons["Remove Apple"]
    XCTAssertTrue(remove.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["You'll sign in with sam@example.com instead. Apple won't open this account."].exists)
    if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
    else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.15)).tap() }
    XCTAssertTrue(remove.wait(for: \.exists, toEqual: false, timeout: 5))
    XCTAssertTrue(app.buttons["apple-method"].exists)
    app.buttons["apple-method"].tap(); XCTAssertTrue(remove.waitForExistence(timeout: 5)); remove.tap()
    XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["apple-method"].exists)
    XCTAssertTrue(app.staticTexts["sam@example.com"].exists)
  }

  func test24dOccupiedAppleIdentityStaysOnCaller() {
    let app = launch("24a", fixture: "taken")
    app.buttons["apple-sign-in"].tap()
    let alert = app.alerts["Apple ID already in use"]
    XCTAssertTrue(alert.waitForExistence(timeout: 5))
    XCTAssertTrue(alert.staticTexts["It opens another Windmill account with its own data. Windmill doesn't merge accounts. Remove Apple there first."].exists)
    alert.buttons["OK"].tap()
    XCTAssertTrue(app.staticTexts["sam@example.com"].exists)
    XCTAssertFalse(app.buttons["apple-method"].exists)
  }

  func test24bEmptyOwnerMovesWithoutQuestion() {
    let app = launch("24a", fixture: "empty")
    app.buttons["apple-sign-in"].tap()
    XCTAssertTrue(app.buttons["apple-method"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.alerts["Apple ID already in use"].exists)
    XCTAssertFalse(app.staticTexts["Already on Windmill?"].exists)
    XCTAssertTrue(app.staticTexts["sam@example.com"].exists)
  }

  func testAuthenticatedCreateHelloFailureCanRetryWithoutTicket() {
    let app = launch(fixture: "hello-failure"); question(app)
    app.buttons["Create account"].tap()
    XCTAssertTrue(app.buttons["auth-retry"].waitForExistence(timeout: 10))
    let capture = XCTAttachment(screenshot: app.screenshot()); capture.name = "authenticated-engine-pending"; capture.lifetime = .keepAlways; add(capture)
    XCTAssertFalse(app.buttons["Create account"].exists)
    app.buttons["auth-retry"].tap()
    assertPage(app, equals: localPage)
  }

  func testAuthenticatedLinkHelloFailureCanRetryAndThenAdopt() {
    let app = launch(fixture: "hello-failure"); question(app); sendCode(app)
    app.textFields["email-code"].typeText("482913")
    XCTAssertTrue(app.buttons["auth-retry"].waitForExistence(timeout: 10))
    app.buttons["auth-retry"].tap()
    let adoption = app.alerts["Add to your account?"]
    XCTAssertTrue(adoption.waitForExistence(timeout: 10)); adoption.buttons["Add"].tap()
    assertPage(app, equals: accountPage + "\n\n" + localPage)
  }
}
