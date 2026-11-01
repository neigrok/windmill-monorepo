import XCTest

final class JournalCaptures: DesignCapture {
  func echoes(_ look: Look) {
    let app = launch("journal-echoes-first", look)
    let tab = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "journal-echo-")).firstMatch
    XCTAssertTrue(tab.waitForExistence(timeout: 20))
    capture("journal-echo-tab", look, app, settle: 1.5)
    reach(tab, app).tap()
    let gotIt = app.buttons["echo-introduction-done"]
    XCTAssertTrue(gotIt.waitForExistence(timeout: 5))
    capture("journal-echo-first-card", look, app)
    reach(gotIt, app).tap()
    let more = app.buttons["echo-more"]
    XCTAssertTrue(more.waitForExistence(timeout: 5))
    let reachable = reach(more, app)
    if reachable.frame.maxY > app.frame.maxY - 120 { app.swipeUp(velocity: .slow) }
    capture("journal-echo-ink", look, app)
    reachable.tap()
    XCTAssertTrue(app.scrollViews["echo-sheet"].waitForExistence(timeout: 5))
    capture("journal-echo-reader", look, app)
  }
  func testEchoes() { for look in Look.both { echoes(look) } }
  func testEchoesLargestText() { for look in Look.bothAtLargestText { echoes(look) } }

  func testFirstOpenAndChrome() {
    for look in Look.both {
      let app = launch("05-journal-first-open", look)
      XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
      capture("journal-first-open-ink-notes", look, app, settle: 2.0)
      app.buttons["you"].tap()
      XCTAssertTrue(app.buttons["about-windmill"].waitForExistence(timeout: 5))
      capture("journal-you-signed-out", look, app)
      app.buttons["about-windmill"].tap()
      let replay = app.navigationBars["About Windmill"]
      XCTAssertTrue(replay.waitForExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts["onboarding-title"].waitForExistence(timeout: 5))
      capture("shell-about-windmill-replay", look, app, settle: 1.6)
      replay.buttons["onboarding-exit"].tap()
      XCTAssertTrue(replay.waitForNonExistence(timeout: 5))
      XCTAssertTrue(app.buttons["about-windmill"].waitForExistence(timeout: 5))
      closeSheet(app)
      roomMenuOpen("journal-room-menu-open", look, app, current: "Journal")
      capture("journal-today-after-ink-lifted", look, app)
    }
  }

  func testHistoryAndWriting() {
    for look in Look.both {
      let app = launch("journal-history", look)
      let editor = app.textViews["journal-editor"]
      XCTAssertTrue(editor.waitForExistence(timeout: 10))
      capture("journal-history-today", look, app, settle: 1.5)
      let scroll = app.scrollViews["journal-canvas"]
      for _ in 0..<5 { scroll.swipeDown(velocity: .fast) }
      capture("journal-history-past-pages", look, app)
      app.buttons["write-today"].tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      app.typeText(" A line for the review.")
      capture("journal-writing-keyboard", look, app)
      app.buttons["done-writing"].tap()
      XCTAssertTrue(app.buttons["write-today"].waitForExistence(timeout: 5))
    }
  }

  func testAnonymousPromptsAndKeepOffer() {
    for look in Look.both {
      let app = launch("02a-where-to-start-signed-out", look)
      XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10)); app.buttons["open-journal"].tap()
      let editor = app.textViews["journal-editor"]
      XCTAssertTrue(editor.waitForExistence(timeout: 10)); editor.tap()
      editor.typeText("A page for tomorrow.\nAnother evening worth remembering.")
      app.buttons["done-writing"].tap()
      XCTAssertTrue(app.buttons["Not now"].waitForExistence(timeout: 5))
      capture("journal-mood-energy-prompt", look, app)
      app.buttons["Not now"].tap()
      XCTAssertTrue(app.buttons["Keep it"].waitForExistence(timeout: 5))
      capture("journal-keep-offer", look, app)
    }
  }

  func testKeepSheetAndSignedInYou() {
    for look in Look.both {
      let app = launch("14-keep", look)
      XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10))
      capture("journal-keep-sheet", look, app)
      app.buttons["email-sign-in"].tap()
      let email = app.textFields["email-address"]
      XCTAssertTrue(email.waitForExistence(timeout: 5))
      capture("journal-sign-in-email-address", look, app)
      email.tap(); email.typeText("design-review@example.com")
      app.buttons["Send code"].tap()
      let code = app.textFields["email-code"]
      XCTAssertTrue(code.waitForExistence(timeout: 5))
      capture("journal-sign-in-email-code", look, app)
      code.tap(); code.typeText("482913")
      XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 15))
      let backedUp = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "backed up")).firstMatch
      XCTAssertTrue(backedUp.waitForExistence(timeout: 15))
      capture("journal-today-signed-in-backed-up", look, app)
      app.buttons["you"].tap()
      XCTAssertTrue(app.buttons["sign-out"].waitForExistence(timeout: 5))
      capture("journal-you-signed-in", look, app)
      app.buttons["sign-out"].tap()
      XCTAssertTrue(app.alerts["Sign out?"].waitForExistence(timeout: 5))
      capture("journal-sign-out-alert", look, app)
    }
  }
}
