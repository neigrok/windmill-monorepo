import XCTest

// Opt in with TEST_RUNNER_WM_DESIGN_CAPTURE=1 when invoking xcodebuild.
@MainActor final class DesignCaptureTests: XCTestCase {
  override func setUpWithError() throws {
    try super.setUpWithError()
    try XCTSkipUnless(ProcessInfo.processInfo.environment["WM_DESIGN_CAPTURE"] == "1", "Design capture is opt-in.")
    continueAfterFailure = false
  }

  override func tearDown() async throws {
    await MainActor.run { XCUIApplication().terminate() }
    try await super.tearDown()
  }

  func launch(_ board: String, appearance: String, arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board, "-onboarding-appearance", appearance] + arguments
    app.launch()
    return app
  }
  func capture(_ name: String, _ app: XCUIApplication, settle seconds: Double = 1.0) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  func openGymFromJournal(_ app: XCUIApplication) {
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    let menu = app.buttons["room-menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 10)); menu.tap()
    let gym = app.buttons["room-gym"]
    XCTAssertTrue(gym.waitForExistence(timeout: 5)); gym.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
  }
  func closeSheet(_ app: XCUIApplication) {
    for _ in 0..<3 {
      let bar = app.navigationBars
      if bar.buttons["Done"].exists { bar.buttons["Done"].tap(); break }
      if bar.buttons["Close"].exists { bar.buttons["Close"].tap(); break }
      let back = bar.buttons["Back"]
      XCTAssertTrue(back.waitForExistence(timeout: 5)); back.tap()
    }
    let sheet = app.navigationBars.matching(NSPredicate(format: "identifier IN %@", ["You", "Keep", "Sign in", "Apple", "Sign out"])).firstMatch
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))
  }
  func back(_ app: XCUIApplication) {
    let button = app.navigationBars.firstMatch.buttons.element(boundBy: 0)
    XCTAssertTrue(button.wait(for: \.isHittable, toEqual: true, timeout: 5)); button.tap()
  }
  func more(_ name: String, _ app: XCUIApplication) {
    app.buttons["coach-more"].tap()
    let ids = ["History": "history", "Notes": "notes", "Connected log": "connections", "Gym settings": "settings"]
    let item = app.buttons["coach-menu-" + ids[name]!]
    XCTAssertTrue(item.wait(for: \.isHittable, toEqual: true, timeout: 5)); item.tap()
  }
  func roomMenuOpen(_ name: String, _ app: XCUIApplication, current: String) {
    let menu = app.buttons["room-menu"]
    XCTAssertTrue(menu.wait(for: \.isHittable, toEqual: true, timeout: 10)); menu.tap()
    XCTAssertTrue(app.buttons["room-journal"].waitForExistence(timeout: 5))
    capture(name, app, settle: 0.6)
    app.buttons["room-" + current].tap()
    XCTAssertTrue(app.buttons["room-journal"].waitForNonExistence(timeout: 5))
  }

  func welcome(_ appearance: String) {
    let app = launch("shell-anonymous", appearance: appearance)
    XCTAssertTrue(app.staticTexts["Where to start?"].waitForExistence(timeout: 15))
    capture("shell-welcome-signed-out-\(appearance)", app, settle: 1.5)
    app.terminate()
  }
  func testWelcomeLight() { welcome("light") }
  func testWelcomeDark() { welcome("dark") }

  func gymSignedOut(_ appearance: String) {
    let app = launch("shell-anonymous", appearance: appearance)
    XCTAssertTrue(app.buttons["open-gym"].waitForExistence(timeout: 15)); app.buttons["open-gym"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    capture("gym-routines-empty-signed-out-\(appearance)", app, settle: 1.5)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 5))
    capture("gym-you-signed-out-\(appearance)", app)
    closeSheet(app)
    roomMenuOpen("gym-room-menu-open-\(appearance)", app, current: "gym")
    let signIn = app.buttons["routines-sign-in"]
    if signIn.waitForExistence(timeout: 5) {
      signIn.tap()
      XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 5))
      capture("gym-keep-sheet-\(appearance)", app)
      app.buttons["link-sign-in"].tap()
      XCTAssertTrue(app.textFields["sign-in-link"].waitForExistence(timeout: 5))
      capture("shell-sign-in-link-\(appearance)", app)
      app.buttons["Use email instead"].tap()
      XCTAssertTrue(app.textFields["email-address"].waitForExistence(timeout: 5))
      capture("gym-sign-in-email-address-\(appearance)", app)
      closeSheet(app)
    } else { XCTFail("routines-sign-in door missing on the empty Routines tab") }
    app.tabBars.buttons["The log"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 10))
    capture("gym-log-empty-signed-out-\(appearance)", app, settle: 1.5)
    app.buttons["gym-weigh-in"].tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5))
    capture("gym-weigh-in-sheet-empty-log-\(appearance)", app)
    app.buttons["gym-weigh-in-cancel"].tap()
    app.terminate()
  }
  func testGymSignedOutLight() { gymSignedOut("light") }
  func testGymSignedOutDark() { gymSignedOut("dark") }

  func gymRoutinesPopulatedSignedOut(_ appearance: String) {
    let app = launch("shell-anonymous", appearance: appearance, arguments: ["-gym-log-fixture"])
    XCTAssertTrue(app.buttons["open-gym"].waitForExistence(timeout: 15)); app.buttons["open-gym"].tap()
    XCTAssertTrue(app.tabBars.buttons["The log"].waitForExistence(timeout: 10)); app.tabBars.buttons["The log"].tap()
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch.waitForExistence(timeout: 20))
    app.tabBars.buttons["Routines"].tap()
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "routine-")).firstMatch.waitForExistence(timeout: 10))
    capture("gym-routines-populated-signed-out-\(appearance)", app, settle: 1.5)
    app.terminate()
  }
  func testGymRoutinesPopulatedSignedOutLight() { gymRoutinesPopulatedSignedOut("light") }
  func testGymRoutinesPopulatedSignedOutDark() { gymRoutinesPopulatedSignedOut("dark") }

  func gymSignedIn(_ appearance: String) {
    let app = launch("shell-last-room", appearance: appearance, arguments: ["-coach-fixture"])
    openGymFromJournal(app)
    app.tabBars.buttons["Coach"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-coach"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["coach-question"].waitForExistence(timeout: 20))
    app.tabBars.buttons["Routines"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-routines"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["routine-proposal"].waitForExistence(timeout: 10))
    capture("gym-routines-populated-signed-in-\(appearance)", app, settle: 1.5)
    app.tabBars.buttons["The log"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["gym-log-session-coach-fixture-session"].waitForExistence(timeout: 10))
    capture("gym-log-one-session-signed-in-\(appearance)", app, settle: 1.5)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["sign-out"].waitForExistence(timeout: 5))
    capture("gym-you-signed-in-\(appearance)", app)
    app.buttons["sign-out"].tap()
    XCTAssertTrue(app.alerts["Sign out?"].waitForExistence(timeout: 5))
    capture("gym-sign-out-sheet-\(appearance)", app)
    app.terminate()
  }
  func testGymSignedInLight() { gymSignedIn("light") }
  func testGymSignedInDark() { gymSignedIn("dark") }

  func workout(_ appearance: String) {
    let app = launch("workout-planned", appearance: appearance)
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    capture("gym-workout-rack-planned-\(appearance)", app, settle: 1.5)
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5))
    capture("gym-workout-this-session-sheet-\(appearance)", app)
    app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-picker"].waitForExistence(timeout: 5))
    capture("gym-workout-movement-picker-\(appearance)", app)
    app.navigationBars.buttons["Cancel"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForNonExistence(timeout: 5))
    app.buttons["workout-weight"].tap()
    XCTAssertTrue(app.buttons["workout-key-1"].waitForExistence(timeout: 5))
    capture("gym-workout-keypad-sheet-\(appearance)", app)
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["workout-key-1"].waitForNonExistence(timeout: 5))
    app.buttons["workout-reps"].tap()
    XCTAssertTrue(app.navigationBars["Reps"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-key-1"].waitForExistence(timeout: 5))
    capture("gym-workout-reps-keypad-sheet-\(appearance)", app)
    app.navigationBars["Reps"].buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["workout-key-1"].waitForNonExistence(timeout: 5))
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    XCTAssertTrue(app.buttons["workout-fix-save"].waitForExistence(timeout: 5))
    capture("gym-workout-fix-set-sheet-\(appearance)", app)
    app.navigationBars["Fix set"].buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["workout-fix-save"].waitForNonExistence(timeout: 5))
    app.buttons["workout-next"].tap()
    capture("gym-workout-rack-second-movement-\(appearance)", app)
    app.terminate()
  }
  func testWorkoutLight() { workout("light") }
  func testWorkoutDark() { workout("dark") }

  func journalFirstOpenAndChrome(_ appearance: String) {
    let app = launch("05-journal-first-open", appearance: appearance)
    XCTAssertTrue(app.textViews["journal-editor"].waitForExistence(timeout: 10))
    capture("journal-first-open-ink-notes-\(appearance)", app, settle: 2.0)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["about-windmill"].waitForExistence(timeout: 5))
    capture("journal-you-signed-out-\(appearance)", app)
    app.buttons["about-windmill"].tap()
    let replay = app.navigationBars["About Windmill"]
    XCTAssertTrue(replay.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["onboarding-title"].waitForExistence(timeout: 5))
    capture("shell-about-windmill-replay-\(appearance)", app, settle: 1.6)
    replay.buttons["onboarding-exit"].tap()
    XCTAssertTrue(replay.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["about-windmill"].waitForExistence(timeout: 5))
    closeSheet(app)
    roomMenuOpen("journal-room-menu-open-\(appearance)", app, current: "journal")
    capture("journal-today-after-ink-lifted-\(appearance)", app)
    app.terminate()
  }
  func testJournalFirstOpenAndChromeLight() { journalFirstOpenAndChrome("light") }
  func testJournalFirstOpenAndChromeDark() { journalFirstOpenAndChrome("dark") }
  func journalHistoryAndWriting(_ appearance: String) {
    let app = launch("journal-history", appearance: appearance)
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    capture("journal-history-today-\(appearance)", app, settle: 1.5)
    let scroll = app.scrollViews["journal-canvas"]
    for _ in 0..<5 { scroll.swipeDown(velocity: .fast) }
    capture("journal-history-past-pages-\(appearance)", app)
    app.buttons["write-today"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    app.typeText(" A line for the review.")
    capture("journal-writing-keyboard-\(appearance)", app)
    app.buttons["done-writing"].tap()
    XCTAssertTrue(app.buttons["write-today"].waitForExistence(timeout: 5))
    app.terminate()
  }
  func testJournalHistoryAndWritingLight() { journalHistoryAndWriting("light") }
  func testJournalHistoryAndWritingDark() { journalHistoryAndWriting("dark") }
  func journalAnonymousPromptsAndKeepOffer(_ appearance: String) {
    let app = launch("02a-where-to-start-signed-out", appearance: appearance)
    XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10)); app.buttons["open-journal"].tap()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10)); editor.tap()
    editor.typeText("A page for tomorrow.\nAnother evening worth remembering.")
    app.buttons["done-writing"].tap()
    XCTAssertTrue(app.buttons["Not now"].waitForExistence(timeout: 5))
    capture("journal-mood-energy-prompt-\(appearance)", app)
    app.buttons["Not now"].tap()
    XCTAssertTrue(app.buttons["Keep it"].waitForExistence(timeout: 5))
    capture("journal-keep-offer-\(appearance)", app)
    app.terminate()
  }

  func testJournalAnonymousPromptsAndKeepOfferLight() { journalAnonymousPromptsAndKeepOffer("light") }
  func testJournalAnonymousPromptsAndKeepOfferDark() { journalAnonymousPromptsAndKeepOffer("dark") }

  func appleLinkingSheets(_ appearance: String) {
    let app = launch("23-start", appearance: appearance, arguments: ["-fake-apple", "-apple-fixture", "linking"])
    XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20))
    capture("shell-keep-sheet-apple-door-\(appearance)", app)
    app.buttons["apple-sign-in"].tap()
    XCTAssertTrue(app.staticTexts["Already on Windmill?"].waitForExistence(timeout: 5))
    capture("shell-apple-already-on-windmill-\(appearance)", app)
    app.buttons["Use my account"].tap()
    XCTAssertTrue(app.staticTexts["Your Windmill email"].waitForExistence(timeout: 5))
    let field = app.textFields["email-address"]
    field.tap(); field.typeText("sam@example.com")
    capture("shell-apple-your-windmill-email-\(appearance)", app)
    app.buttons["Send code"].tap()
    XCTAssertTrue(app.textFields["email-code"].waitForExistence(timeout: 5))
    app.textFields["email-code"].tap(); app.textFields["email-code"].typeText("482913")
    XCTAssertTrue(app.staticTexts["Apple added"].waitForExistence(timeout: 5))
    capture("shell-apple-added-receipt-\(appearance)", app, settle: 0.3)
    let adoption = app.alerts["Add to your account?"]
    XCTAssertTrue(adoption.waitForExistence(timeout: 10))
    capture("shell-adoption-alert-\(appearance)", app)
    adoption.buttons["Discard"].tap()
    let discard = app.alerts["Discard 1 page?"]
    XCTAssertTrue(discard.waitForExistence(timeout: 5))
    capture("shell-discard-adoption-alert-\(appearance)", app)
    discard.buttons["Cancel"].tap()
    XCTAssertTrue(adoption.waitForExistence(timeout: 5))
    adoption.buttons["Add"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 10))
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["sign-out"].waitForExistence(timeout: 5))
    capture("shell-you-signed-in-email-and-apple-\(appearance)", app)
    app.buttons["apple-method"].tap()
    XCTAssertTrue(app.buttons["Remove Apple"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["You'll sign in with sam@example.com instead. Apple won't open this account."].exists)
    capture("shell-remove-apple-confirmation-\(appearance)", app)
    app.terminate()
  }

  func testAppleLinkingSheetsLight() { appleLinkingSheets("light") }
  func testAppleLinkingSheetsDark() { appleLinkingSheets("dark") }

  func appleRecoveryScreens(_ appearance: String) {
    var app = launch("23-start", appearance: appearance, arguments: ["-fake-apple", "-apple-fixture", "linking"])
    XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20)); app.buttons["apple-sign-in"].tap()
    XCTAssertTrue(app.buttons["Use my account"].waitForExistence(timeout: 5)); app.buttons["Use my account"].tap()
    let email = app.textFields["email-address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5)); email.tap(); email.typeText("sam@icloud.com")
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5)); code.tap(); code.typeText("482913")
    XCTAssertTrue(app.staticTexts["No account at this email"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Try another email"].exists)
    capture("shell-apple-no-account-\(appearance)", app)
    app.terminate()

    app = launch("23-start", appearance: appearance, arguments: ["-fake-apple", "-apple-fixture", "expired"])
    XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20)); app.buttons["apple-sign-in"].tap()
    XCTAssertTrue(app.staticTexts["Continue with Apple again"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["apple-sign-in"].exists && app.buttons["email-sign-in"].exists)
    capture("shell-apple-expired-\(appearance)", app)
    app.terminate()

    app = launch("23-start", appearance: appearance, arguments: ["-fake-apple", "-apple-fixture", "hello-failure"])
    XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20)); app.buttons["apple-sign-in"].tap()
    XCTAssertTrue(app.buttons["Create account"].waitForExistence(timeout: 5)); app.buttons["Create account"].tap()
    XCTAssertTrue(app.buttons["auth-retry"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Finish signing in"].exists)
    capture("shell-authenticated-sign-in-pending-\(appearance)", app)
    app.terminate()

    app = launch("24a", appearance: appearance, arguments: ["-fake-apple", "-apple-fixture", "taken"])
    XCTAssertTrue(app.buttons["apple-sign-in"].waitForExistence(timeout: 20)); app.buttons["apple-sign-in"].tap()
    XCTAssertTrue(app.alerts["Apple ID already in use"].waitForExistence(timeout: 5))
    capture("shell-apple-identity-in-use-alert-\(appearance)", app)
  }
  func testAppleRecoveryScreensLight() { appleRecoveryScreens("light") }
  func testAppleRecoveryScreensDark() { appleRecoveryScreens("dark") }

  func journalKeepSheetAndSignedInYou(_ appearance: String) {
    let app = launch("14-keep", appearance: appearance)
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10))
    capture("journal-keep-sheet-\(appearance)", app)
    app.buttons["email-sign-in"].tap()
    let email = app.textFields["email-address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5))
    capture("journal-sign-in-email-address-\(appearance)", app)
    email.tap(); email.typeText("design-review@example.com")
    app.buttons["Send code"].tap()
    let code = app.textFields["email-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5))
    capture("journal-sign-in-email-code-\(appearance)", app)
    code.tap(); code.typeText("482913")
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 15))
    let backedUp = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "backed up")).firstMatch
    XCTAssertTrue(backedUp.waitForExistence(timeout: 15))
    capture("journal-today-signed-in-backed-up-\(appearance)", app)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["sign-out"].waitForExistence(timeout: 5))
    capture("journal-you-signed-in-\(appearance)", app)
    app.buttons["sign-out"].tap()
    XCTAssertTrue(app.alerts["Sign out?"].waitForExistence(timeout: 5))
    capture("journal-sign-out-sheet-\(appearance)", app)
    app.terminate()
  }
  func testJournalKeepSheetAndSignedInYouLight() { journalKeepSheetAndSignedInYou("light") }
  func testJournalKeepSheetAndSignedInYouDark() { journalKeepSheetAndSignedInYou("dark") }

  func onboarding(_ appearance: String) {
    let app = launch("onboarding-fresh", appearance: appearance)
    for page in 1...4 {
      XCTAssertTrue(app.staticTexts["onboarding-title"].waitForExistence(timeout: 10))
      XCTAssertEqual(app.pageIndicators["onboarding-page-control"].label, "Page \(page) of 4")
      capture("shell-onboarding-\(page)-\(appearance)", app, settle: 1.6)
      app.buttons["onboarding-next"].tap()
    }
    XCTAssertTrue(app.buttons["open-journal"].waitForExistence(timeout: 10))
  }
  func testOnboardingLight() { onboarding("light") }
  func testOnboardingDark() { onboarding("dark") }

  func routines(_ appearance: String) {
    let app = launch("shell-last-room", appearance: appearance)
    openGymFromJournal(app)
    app.buttons["new-routine"].tap()
    let name = app.textFields["routine-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    capture("gym-routine-builder-empty-\(appearance)", app)
    name.tap(); name.typeText("Push A\n")
    app.buttons["add-movement"].tap()
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
    capture("gym-movement-picker-\(appearance)", app)
    app.buttons["gym-create-movement"].tap()
    XCTAssertTrue(app.textFields["gym-movement-name"].waitForExistence(timeout: 5))
    capture("gym-create-movement-\(appearance)", app)
    app.navigationBars["Create movement"].buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5))
    app.buttons["gym-movement-bench-press"].tap()
    let movement = app.buttons["builder-movement-bench-press"]
    XCTAssertTrue(movement.waitForExistence(timeout: 5)); movement.tap()
    XCTAssertTrue(app.buttons["gym-target-set"].waitForExistence(timeout: 5))
    capture("gym-routine-targets-\(appearance)", app)
    app.buttons["gym-target-set"].tap()
    XCTAssertTrue(app.buttons["save-routine"].waitForExistence(timeout: 5))
    capture("gym-routine-builder-populated-\(appearance)", app)
    app.buttons["save-routine"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["routine-detail"].waitForExistence(timeout: 5))
    capture("gym-routine-detail-\(appearance)", app)
    app.buttons["edit-routine"].tap()
    XCTAssertTrue(app.navigationBars["Edit routine"].waitForExistence(timeout: 5))
    capture("gym-routine-edit-\(appearance)", app)
    app.navigationBars["Edit routine"].buttons["Cancel"].tap()
    app.buttons["routine-detail-movement-bench-press"].tap()
    XCTAssertTrue(app.buttons["rename-movement"].waitForExistence(timeout: 5))
    capture("gym-routine-movement-\(appearance)", app)
    app.buttons["rename-movement"].tap()
    XCTAssertTrue(app.textFields["gym-rename-movement-name"].waitForExistence(timeout: 5))
    capture("gym-routine-rename-movement-sheet-\(appearance)", app)
  }
  func testRoutinesLight() { routines("light") }
  func testRoutinesDark() { routines("dark") }

  func logScreens(_ appearance: String) {
    let app = launch("shell-anonymous", appearance: appearance, arguments: ["-gym-log-fixture"])
    XCTAssertTrue(app.buttons["open-gym"].waitForExistence(timeout: 15)); app.buttons["open-gym"].tap()
    XCTAssertTrue(app.tabBars.buttons["The log"].waitForExistence(timeout: 10)); app.tabBars.buttons["The log"].tap()
    let session = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
    XCTAssertTrue(session.waitForExistence(timeout: 20))
    capture("gym-log-populated-\(appearance)", app)
    app.buttons["gym-bodyweight-door"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-bodyweight"].waitForExistence(timeout: 5))
    capture("gym-bodyweight-\(appearance)", app)
    let weighIn = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-weigh-in-2026-")).firstMatch
    XCTAssertTrue(weighIn.waitForExistence(timeout: 5)); weighIn.tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForExistence(timeout: 5))
    capture("gym-weigh-in-edit-sheet-\(appearance)", app)
    app.buttons["gym-weigh-in-cancel"].tap()
    XCTAssertTrue(app.textFields["gym-weigh-in-weight"].waitForNonExistence(timeout: 5)); back(app)
    for _ in 0..<10 {
      let top = app.navigationBars.firstMatch.frame.maxY + 8
      let bottom = app.buttons["gym-weigh-in"].frame.minY - 12
      if session.isHittable && session.frame.minY > top && session.frame.maxY < bottom { break }
      app.swipeUp(velocity: .slow)
    }
    XCTAssertTrue(session.isHittable); session.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 5))
    capture("gym-session-detail-\(appearance)", app)
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-finished-set-")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    XCTAssertTrue(app.textFields["gym-fix-weight"].waitForExistence(timeout: 5))
    capture("gym-finished-set-fix-sheet-\(appearance)", app)
    app.navigationBars["Fix set"].buttons["Cancel"].tap()
    XCTAssertTrue(app.textFields["gym-fix-weight"].waitForNonExistence(timeout: 5))
    app.buttons["gym-session-movement"].firstMatch.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
    capture("gym-movement-record-\(appearance)", app)
    app.swipeUp()
    capture("gym-movement-record-chart-\(appearance)", app)
    app.buttons["Rename"].tap()
    XCTAssertTrue(app.textFields["gym-rename-name"].waitForExistence(timeout: 5))
    capture("gym-log-rename-movement-sheet-\(appearance)", app)
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.textFields["gym-rename-name"].waitForNonExistence(timeout: 5)); back(app)
    for _ in 0..<4 where !app.buttons["gym-session-share"].isHittable { app.swipeUp() }
    app.buttons["gym-session-share"].tap()
    XCTAssertTrue(app.buttons["Get a link"].waitForExistence(timeout: 5))
    capture("gym-session-share-sheet-\(appearance)", app)
    app.buttons["Get a link"].tap()
    XCTAssertTrue(app.staticTexts["sharing needs your account — sign in first"].waitForExistence(timeout: 5))
    capture("gym-session-share-transient-\(appearance)", app)
  }
  func testLogScreensLight() { logScreens("light") }
  func testLogScreensDark() { logScreens("dark") }

  func coachScreens(_ appearance: String) {
    let app = launch("shell-last-room", appearance: appearance, arguments: ["-coach-fixture"])
    openGymFromJournal(app)
    app.tabBars.buttons["Coach"].tap()
    let question = app.descendants(matching: .any)["coach-question"]
    XCTAssertTrue(question.waitForExistence(timeout: 15))
    capture("gym-coach-empty-\(appearance)", app)
    app.buttons["coach-more"].tap()
    XCTAssertTrue(app.buttons["coach-menu-history"].waitForExistence(timeout: 5))
    capture("gym-coach-more-menu-\(appearance)", app)
    app.buttons["coach-menu-notes"].tap()
    XCTAssertTrue(app.buttons["coach-add-note"].waitForExistence(timeout: 5))
    capture("gym-coach-notes-\(appearance)", app)
    app.buttons["coach-add-note"].tap()
    let title = app.descendants(matching: .any)["coach-note-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 5)); title.tap(); title.typeText("Training focus")
    capture("gym-coach-note-editor-\(appearance)", app)
    app.navigationBars["Note"].buttons["Cancel"].tap()
    XCTAssertTrue(app.navigationBars["Notes"].waitForExistence(timeout: 5)); back(app)
    more("Connected log", app)
    XCTAssertTrue(app.staticTexts["Claude Desktop"].waitForExistence(timeout: 5))
    capture("gym-coach-connected-log-\(appearance)", app)
    app.swipeUp()
    app.buttons["How this works"].tap()
    capture("gym-coach-connected-log-details-\(appearance)", app)
    back(app)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["you-gym-settings"].waitForExistence(timeout: 5))
    app.buttons["you-gym-settings"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-settings"].waitForExistence(timeout: 5))
    capture("gym-settings-\(appearance)", app)
    back(app)
    app.tabBars.buttons["Coach"].tap()
    XCTAssertTrue(question.waitForExistence(timeout: 5)); question.tap(); question.typeText("Is Push A still doing anything?")
    app.buttons["coach-send"].tap()
    XCTAssertTrue(app.buttons["Review"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
    if app.keyboards.firstMatch.exists { app.buttons["coach-keyboard-done"].tap() }
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    capture("gym-coach-conversation-\(appearance)", app)
    app.scrollViews.firstMatch.swipeDown()
    XCTAssertTrue(app.buttons["Enlarge photo"].waitForExistence(timeout: 5)); app.buttons["Enlarge photo"].tap()
    XCTAssertTrue(app.navigationBars["Photo"].waitForExistence(timeout: 5))
    capture("gym-coach-photo-sheet-\(appearance)", app)
    app.buttons["Close"].tap()
    XCTAssertTrue(app.navigationBars["Photo"].waitForNonExistence(timeout: 5))
    let sources = app.buttons["read 214 sets · 6 weeks · 18 sessions"]
    XCTAssertTrue(sources.wait(for: \.isHittable, toEqual: true, timeout: 5)); sources.tap()
    XCTAssertTrue(app.buttons["Push A workout"].waitForExistence(timeout: 5))
    app.buttons["Push A workout"].tap()
    capture("gym-coach-read-receipt-\(appearance)", app)
    app.scrollViews.firstMatch.swipeUp()
    app.buttons["Review"].tap()
    XCTAssertTrue(app.buttons["coach-apply-proposal"].waitForExistence(timeout: 5))
    capture("gym-coach-review-sheet-\(appearance)", app)
    app.scrollViews.firstMatch.swipeUp()
    capture("gym-coach-review-actions-\(appearance)", app)
    app.buttons["Turn this down"].tap()
    let turnDown = app.alerts["Turn this down?"]
    XCTAssertTrue(turnDown.waitForExistence(timeout: 5))
    capture("gym-coach-turn-down-confirmation-\(appearance)", app)
    turnDown.buttons["Keep it"].tap()
    XCTAssertTrue(turnDown.waitForNonExistence(timeout: 5))
    app.buttons["Close"].tap()
    XCTAssertTrue(app.buttons["coach-more"].waitForExistence(timeout: 5))
    more("History", app)
    XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
    capture("gym-coach-history-\(appearance)", app)
  }
  func testCoachScreensLight() { coachScreens("light") }
  func testCoachScreensDark() { coachScreens("dark") }

  func coachSignedOut(_ appearance: String) {
    let app = launch("shell-last-room", appearance: appearance)
    openGymFromJournal(app)
    app.tabBars.buttons["Coach"].tap()
    XCTAssertTrue(app.staticTexts["Coach reads your log, so it needs you signed in."].waitForExistence(timeout: 5))
    capture("gym-coach-signed-out-\(appearance)", app)
  }
  func testCoachSignedOutLight() { coachSignedOut("light") }
  func testCoachSignedOutDark() { coachSignedOut("dark") }

  func workoutDeviationAndReceipt(_ appearance: String) {
    let app = launch("workout-planned", appearance: appearance)
    XCTAssertTrue(app.buttons["workout-weight"].waitForExistence(timeout: 10))
    app.buttons["workout-weight"].tap()
    XCTAssertTrue(app.buttons["workout-key-1"].waitForExistence(timeout: 5))
    for key in ["1", "0", "5"] { app.buttons["workout-key-\(key)"].tap() }
    app.buttons["workout-keypad-set"].tap()
    app.buttons["workout-log"].tap()
    app.buttons["workout-next"].tap()
    XCTAssertTrue(app.buttons["workout-deviation-today"].waitForExistence(timeout: 5))
    capture("gym-workout-heavier-than-plan-sheet-\(appearance)", app)
    app.buttons["workout-deviation-today"].tap()
    XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 5)); app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
    capture("gym-workout-finish-receipt-\(appearance)", app)
    app.swipeUp()
    capture("gym-workout-finish-receipt-actions-\(appearance)", app)
  }
  func testWorkoutDeviationAndReceiptLight() { workoutDeviationAndReceipt("light") }
  func testWorkoutDeviationAndReceiptDark() { workoutDeviationAndReceipt("dark") }

  func workoutTransients(_ appearance: String) {
    let app = launch("workout-notice", appearance: appearance)
    XCTAssertTrue(app.staticTexts["Check the weight and reps before logging."].waitForExistence(timeout: 10))
    capture("gym-workout-transient-\(appearance)", app)
    app.otherElements["workout-refusal"].buttons["Dismiss message"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "never reached the log")).firstMatch.waitForExistence(timeout: 5))
    capture("gym-workout-durable-refusal-\(appearance)", app)
  }
  func testWorkoutTransientsLight() { workoutTransients("light") }
  func testWorkoutTransientsDark() { workoutTransients("dark") }
}
