import XCTest

final class JournalCaptures: DesignCapture {
  // Journal · iOS 05.1A today with Write in the bottom bar, 05.2P reading back, 05.3P writing with Done alone.
  func today(_ look: Look) {
    let app = launch("journal-history", look)
    let write = app.buttons["write-today"]
    XCTAssertTrue(write.waitForExistence(timeout: 10))
    capture("journal-05.1-today", look, app, settle: 1.5)
    let scroll = app.scrollViews["journal-canvas"]
    for _ in 0..<2 { scroll.swipeDown(velocity: .slow) }
    capture("journal-05.2-reading-back", look, app, settle: 1.5)
    write.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText(" A line for the review.")
    capture("journal-05.3-writing", look, app)
    app.buttons["done-writing"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
  }
  func testToday() { for look in Look.both { today(look) } }
  // Journal · iOS 05.5P: the same room at the largest text.
  func testTodayLargestText() { for look in Look.bothAtLargestText { today(look) } }

  // Journal · iOS 01.5P: a refused save keeps the writing, says so under it in ink, and offers Try again.
  func testRefusedSave() {
    for look in Look.both + Look.bothAtLargestText {
      let app = launch("journal-history-refused", look)
      XCTAssertTrue(app.buttons["journal-try-again"].waitForExistence(timeout: 10))
      capture("journal-01.5-save-refused", look, app, settle: 1.5)
      app.terminate()
    }
  }

  // Journal · iOS 02.3P–02.5P: the count's sheet at .medium (.large at the largest text), raised by year, lowered over a passage.
  func echoes(_ look: Look) {
    let app = launch("journal-echoes", look)
    let count = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "journal-echo-")).firstMatch
    XCTAssertTrue(count.waitForExistence(timeout: 20))
    reach(count, app).tap()
    let sheet = app.descendants(matching: .any)["echo-sheet"]
    XCTAssertTrue(sheet.waitForExistence(timeout: 5))
    if look.largestText {
      capture("journal-02.4-echoes-large", look, app, settle: 1.5)
    } else {
      capture("journal-02.3-echoes-medium", look, app, settle: 1.5)
      let top = app.navigationBars["From your journal"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
      top.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.06)))
      capture("journal-02.4-echoes-large", look, app, settle: 1.5)
    }
    let passage = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "echo-open-")).firstMatch
    passage.tap()
    XCTAssertTrue(app.buttons["echo-back-to-tonight"].waitForExistence(timeout: 5))
    capture("journal-02.5-echo-opened", look, app, settle: 3.2)
  }
  func testEchoes() { for look in Look.both { echoes(look) } }
  func testEchoesLargestText() { for look in Look.bothAtLargestText { echoes(look) } }

  // The first echo ever says what echoes are once, at the head of its sheet.
  func testFirstEcho() {
    for look in Look.both {
      let app = launch("journal-echoes-first", look)
      let count = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "journal-echo-")).firstMatch
      XCTAssertTrue(count.waitForExistence(timeout: 20))
      capture("journal-echo-count", look, app, settle: 1.5)
      reach(count, app).tap()
      XCTAssertTrue(app.buttons["echo-introduction-done"].waitForExistence(timeout: 5))
      capture("journal-echo-first", look, app)
      app.terminate()
    }
  }

  func testFirstOpenAndChrome() {
    for look in Look.both {
      let app = launch("05-journal-first-open", look)
      XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
      capture("journal-05.8-first-open-ink-notes", look, app, settle: 2.0)
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

  func testAnonymousKeepOffer() {
    for look in Look.both {
      let app = launch("02a-where-to-start-signed-out", look)
      XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10)); app.buttons["open-journal"].tap()
      let editor = app.textViews["journal-editor"]
      XCTAssertTrue(editor.waitForExistence(timeout: 10)); editor.tap()
      editor.typeText("A page for tomorrow.\nAnother evening worth remembering.")
      app.buttons["done-writing"].tap()
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
      XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 15))
      capture("journal-today-signed-in", look, app, settle: 2.0)
      app.buttons["you"].tap()
      XCTAssertTrue(app.buttons["sign-out"].waitForExistence(timeout: 5))
      capture("journal-you-signed-in", look, app)
      app.buttons["sign-out"].tap()
      XCTAssertTrue(app.alerts["Sign out?"].waitForExistence(timeout: 5))
      capture("journal-sign-out-alert", look, app)
    }
  }
}
