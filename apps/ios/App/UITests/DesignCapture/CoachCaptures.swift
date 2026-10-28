import XCTest

final class CoachCaptures: DesignCapture {
  func ask(_ question: String, _ app: XCUIApplication) {
    let field = app.descendants(matching: .any)["coach-question"]
    field.tap(); field.typeText(question)
    app.buttons["coach-send"].tap()
  }

  func testSignedOut() {
    for look in Look.both {
      let app = launch("shell-last-room", look)
      openGymFromJournal(app, opensOn: .coach)
      XCTAssertTrue(app.staticTexts["coach-greeting"].waitForExistence(timeout: 15))
      capture("01.1-coach-greeting-signed-out", look, app)
      app.buttons["you"].tap()
      reach(app.buttons["settings-connected-log"], app).tap()
      XCTAssertTrue(app.buttons["coach-connect-tool"].waitForExistence(timeout: 5))
      capture("gym-coach-connected-log-signed-out", look, app)
    }
  }

  func testGreetingSignedIn() {
    captureBoard("01.2-coach-greeting-signed-in") { look in
      let app = launch("shell-last-room", look, arguments: ["-coach-fixture", "-coach-setup-fixture"])
      openGymFromJournal(app, opensOn: .coach)
      let capabilities = app.descendants(matching: .any)["coach-capabilities"]
      XCTAssertTrue(capabilities.waitForExistence(timeout: 15))
      let signedIn = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "Changes — ask me, and I suggest changes to your routines."), object: capabilities)
      XCTAssertEqual(XCTWaiter.wait(for: [signedIn], timeout: 15), .completed)
      return app
    }
  }

  // 01.18: a draft a signed-out start left on this phone waits under the greeting.
  func testSetupStates() {
    captureBoard("01.18-draft-kept") { look in
      let app = launch("shell-last-room", look, arguments: ["-coach-fixture", "-coach-setup-fixture", "-coach-kept-draft"])
      openGymFromJournal(app, opensOn: .coach)
      XCTAssertTrue(app.buttons["Continue saved draft"].waitForExistence(timeout: 15))
      return app
    }
  }

  func testPhotoCaption() {
    captureBoard("01.4-coach-photo-signed-out") { look in
      let app = launch("shell-last-room", look, arguments: ["-coach-draft-photo"])
      openGymFromJournal(app, opensOn: .coach)
      typeOverPhoto(app)
      return app
    }
    captureBoard("01.5-coach-photo-signed-in") { look in
      let app = launch("shell-last-room", look, arguments: ["-coach-fixture", "-coach-setup-fixture", "-coach-draft-photo"])
      openGymFromJournal(app, opensOn: .coach)
      typeOverPhoto(app)
      return app
    }
  }
  // The draft photo stands in the field; the question goes in under it with the keyboard up.
  func typeOverPhoto(_ app: XCUIApplication) {
    XCTAssertTrue(app.staticTexts["coach-photo-caption"].waitForExistence(timeout: 15))
    let field = app.descendants(matching: .any)["coach-question"]
    field.tap(); field.typeText("My program, 3 days a week")
    XCTAssertTrue(app.buttons["coach-send"].waitForExistence(timeout: 5))
  }

  func testEmpty() {
    captureBoard("08.1-coach-empty") { look in launchSignedInCoach(look) }
  }

  func testConversation() {
    for look in Look.both {
      let app = launchSignedInCoach(look, arguments: ["-coach-draft-photo"])
      app.buttons["you"].tap()
      reach(app.buttons["settings-connected-log"], app).tap()
      XCTAssertTrue(app.staticTexts["Claude Desktop"].waitForExistence(timeout: 5))
      capture("gym-coach-connected-log", look, app)
      app.buttons["coach-connected-how"].tap()
      XCTAssertTrue(app.navigationBars["How this works"].waitForExistence(timeout: 5))
      capture("gym-coach-connected-log-details", look, app)
      back(app); back(app); closeSheet(app)
      let question = app.descendants(matching: .any)["coach-question"]
      XCTAssertTrue(question.waitForExistence(timeout: 5)); question.tap(); question.typeText("Is Push A still doing anything?")
      capture("gym-coach-composing", look, app)
      app.buttons["coach-send"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      let photo = app.buttons["Enlarge photo"].firstMatch
      for _ in 0..<4 where !photo.isHittable { app.scrollViews.firstMatch.swipeDown() }
      capture("gym-coach-conversation-top", look, app)
      XCTAssertTrue(photo.waitForExistence(timeout: 5)); photo.tap()
      let cover = app.descendants(matching: .any)["coach-photo-cover"]
      XCTAssertTrue(cover.waitForExistence(timeout: 5))
      capture("gym-coach-photo", look, app)
      cover.swipeDown(velocity: .fast)
      XCTAssertTrue(cover.waitForNonExistence(timeout: 5))
      let sources = app.buttons["coach-read-receipt"]
      XCTAssertTrue(sources.wait(for: \.isHittable, toEqual: true, timeout: 5)); sources.tap()
      XCTAssertTrue(app.navigationBars["What Coach read"].waitForExistence(timeout: 5))
      capture("08.5-coach-what-coach-read", look, app)
      app.buttons["Close"].tap()
      XCTAssertTrue(app.navigationBars["What Coach read"].waitForNonExistence(timeout: 5))
      let history = app.buttons["coach-history"]
      XCTAssertTrue(history.wait(for: \.isHittable, toEqual: true, timeout: 5)); history.tap()
      XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
      capture("gym-coach-history-one", look, app)
      let conversations = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Is Push A still doing anything?"))
      let conversation = conversations.firstMatch
      XCTAssertTrue(conversation.waitForExistence(timeout: 5))
      XCTAssertEqual(conversations.count, 1, "Local and server history describe one conversation identity")
      conversation.swipeLeft()
      XCTAssertTrue(app.buttons["trash-swipe"].waitForExistence(timeout: 5)); app.buttons["trash-swipe"].tap()
      XCTAssertTrue(app.alerts["Delete this conversation?"].buttons["Delete"].waitForExistence(timeout: 5))
      capture("gym-coach-history-delete-confirmation", look, app)
      app.alerts["Delete this conversation?"].buttons["Delete"].tap()
      XCTAssertTrue(conversation.waitForNonExistence(timeout: 5))
      XCTAssertFalse(app.buttons["coach-engine-undo"].exists)
      capture("gym-coach-history-deleted", look, app)
    }
  }

  // Ask a board's question and wait for its card to settle at the conversation's end.
  func askBoard(_ board: String, _ question: String, _ look: Look, arguments: [String] = []) -> XCUIApplication {
    let app = launchSignedInCoach(look, arguments: ["-coach-board", board] + arguments)
    ask(question, app)
    XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    return app
  }
  // Show all, then drag until the card's decision stands over the composer.
  func expandCard(_ app: XCUIApplication) {
    let expand = app.buttons["coach-proposal-expand"]
    XCTAssertTrue(expand.waitForExistence(timeout: 5)); expand.tap()
    XCTAssertTrue(expand.waitForLabel("Show less", timeout: 5))
    for _ in 0..<6 where !app.buttons["coach-reject-proposal"].isHittable { app.scrollViews.firstMatch.swipeUp(velocity: .slow) }
  }

  func testProposalPending() {
    captureBoard("08.2-coach-proposal-pending") { look in askBoard("change", "Is Push A still doing anything?", look) }
    captureBoard("08.3-coach-proposal-expanded") { look in
      let app = askBoard("change", "Is Push A still doing anything?", look)
      expandCard(app)
      return app
    }
    for look in Look.bothAtLargestText {
      let app = askBoard("change", "Is Push A still doing anything?", look)
      expandCard(app)
      XCTAssertTrue(app.buttons["coach-apply-proposal"].isHittable && app.buttons["coach-reject-proposal"].isHittable)
      capture("08.3-coach-proposal-expanded", look, app)
      app.terminate()
    }
  }

  func testMarkdownAnswer() {
    captureBoard("08.10-coach-markdown") { look in
      let app = launchSignedInCoach(look, arguments: ["-coach-markdown"])
      ask("What should Thursday look like?", app)
      XCTAssertTrue(app.descendants(matching: .any)["coach-read-receipt"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      return app
    }
  }

  func testStreaming() {
    captureBoard("08.11-coach-streaming") { look in
      let app = launchSignedInCoach(look, arguments: ["-coach-streaming"])
      ask("What should Thursday look like?", app)
      XCTAssertTrue(app.descendants(matching: .any)["coach-answer"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["coach-stop"].exists)
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      return app
    }
  }

  func testFreshEntryWhileAnswering() {
    for look in Look.both {
      let app = launchSignedInCoach(look, arguments: ["-coach-streaming"])
      ask("What should Thursday look like?", app)
      XCTAssertTrue(app.buttons["coach-stop"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      open(.routines, app); open(.coach, app)
      XCTAssertTrue(app.buttons["coach-view-answer"].waitForExistence(timeout: 5))
      let field = app.descendants(matching: .any)["coach-question"]
      field.tap(); field.typeText("How was my week?")
      XCTAssertFalse(app.buttons["coach-send"].isEnabled)
      app.buttons["coach-keyboard-done"].tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      capture("08.33-coach-fresh-pending", look, app)
      app.buttons["coach-history"].tap()
      XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
      capture("08.34-coach-local-history", look, app)
    }
  }

  func testThinking() {
    captureBoard("01.6-coach-thinking") { look in
      let app = launchSignedInCoach(look, arguments: ["-coach-thinking", "-coach-draft-photo"])
      ask("My program, 3 days a week", app)
      XCTAssertTrue(app.buttons["Enlarge photo"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.descendants(matching: .any)["coach-typing"].exists)
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      return app
    }
  }

  func testRoutineSaved() {
    for look in Look.both {
      let app = launchSignedInCoach(look, arguments: ["-coach-created"])
      ask("Build me a routine.", app)
      XCTAssertTrue(app.buttons["Open routine · Push A"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      capture("gym-coach-routine-created", look, app)
    }
  }

  func testDecided() {
    captureBoard("08.12-coach-proposal-applied") { look in
      let app = askBoard("change", "Is Push A still doing anything?", look)
      reachDecision(app).tap()
      XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForValue("Applied", timeout: 10))
      return app
    }
    captureBoard("08.13-coach-proposal-rejected") { look in
      let app = askBoard("change", "Is Push A still doing anything?", look)
      _ = reachDecision(app); app.buttons["coach-reject-proposal"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForValue("Rejected", timeout: 5))
      return app
    }
    captureBoard("08.14-coach-proposal-out-of-date") { look in
      let app = askBoard("routine-changed", "Is Push A still doing anything?", look)
      XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForValue("Out of date", timeout: 10))
      return app
    }
    captureBoard("08.28-coach-two-proposals") { look in
      let app = askBoard("two", "Is Push A still doing anything?", look)
      reachDecision(app).tap()
      XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForValue("Applied", timeout: 10))
      ask("And Pull A?", app)
      XCTAssertTrue(app.buttons["coach-apply-proposal"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      for _ in 0..<4 where !app.buttons["coach-reject-proposal"].isHittable { app.scrollViews.firstMatch.swipeUp(velocity: .slow) }
      return app
    }
  }
  func testRoutineChanges() {
    captureBoard("08.15-coach-proposal-rename") { look in askBoard("rename", "Can Push A have a better name?", look) }
    captureBoard("08.16-coach-proposal-remove") { look in askBoard("remove", "Should I keep Arms?", look) }
    for look in Look.both {
      let app = askBoard("remove", "Should I keep Arms?", look)
      reachDecision(app).tap()
      XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForValue("Removed", timeout: 10))
      capture("gym-coach-proposal-removal-applied", look, app)
      app.terminate()
    }
  }
  func testMovementChanges() {
    captureBoard("08.17-coach-proposal-add") { look in askBoard("add", "My shoulders feel tight.", look) }
    captureBoard("08.18-coach-proposal-remove-movement") { look in askBoard("drop", "Upright Row hurts my shoulder.", look) }
    captureBoard("08.19-coach-proposal-swap") { look in askBoard("swap", "I can’t do chin-ups yet.", look) }
    captureBoard("08.20-coach-proposal-move") { look in askBoard("move", "What should I do first?", look) }
  }
  func testTargetChanges() {
    captureBoard("08.21-coach-proposal-targets") { look in askBoard("targets", "Give me more work.", look) }
    captureBoard("08.22-coach-proposal-vary") { look in askBoard("vary", "Make the last set heavier.", look) }
    captureBoard("08.23-coach-proposal-ramp") { look in askBoard("ramp", "Warm up to your top set.", look) }
    captureBoard("08.24-coach-proposal-rest") { look in askBoard("rest", "Dips have no target.", look) }
  }
  func testLongFailureRetry() {
    captureBoard("08.27-coach-proposal-long") { look in
      let app = askBoard("long", "Rebuild Push A for strength", look)
      expandCard(app)
      return app
    }
    for look in Look.both {
      let app = askBoard("bench", "Is Push A still doing anything?", look, arguments: ["-coach-decision-unreachable"])
      let apply = reachDecision(app)
      apply.tap()
      XCTAssertTrue(apply.waitForLabel("Try again", timeout: 12))
      XCTAssertEqual(app.descendants(matching: .any)["coach-proposal-failure"].label, "No connection. Not applied.")
      capture("08.29-coach-proposal-apply-failed", look, app)
      apply.tap()
      XCTAssertTrue(apply.waitForLabel("Applying…", timeout: 5))
      capture("08.30-coach-proposal-applying", look, app, settle: 0.3)
      app.terminate()
    }
  }
  // A board where Coach writes while it answers: its card stands under the answer when the answer settles.
  func askWrite(_ board: String, _ question: String, _ card: String, _ look: Look) -> XCUIApplication {
    let app = launchSignedInCoach(look, arguments: ["-coach-board", board])
    ask(question, app)
    XCTAssertTrue(app.descendants(matching: .any)[card].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    return app
  }

  // The note's card reads the record the turn's call created: what Coach did, then the note's own title and body.
  func testWriteReceipts() {
    captureBoard("08.25-coach-saved-note", settle: 2) { look in
      let app = askWrite("note", "My left shoulder hurts on wide-grip bench.", "coach-saved-note", look)
      XCTAssertTrue(app.buttons["coach-saved-note"].label.hasPrefix("Saved a note"))
      XCTAssertTrue(app.buttons["coach-saved-note"].label.contains("Shoulder"))
      return app
    }
    captureBoard("08.32-copy-menu", settle: 1) { look in
      let app = askWrite("note", "My left shoulder hurts on wide-grip bench.", "coach-saved-note", look)
      app.descendants(matching: .any)["coach-answer"].firstMatch.press(forDuration: 1)
      XCTAssertTrue(app.buttons["Copy answer"].waitForExistence(timeout: 5))
      return app
    }
  }
  func testAccessStates() {
    captureBoard("08.6-coach-no-seat") { look in
      let app = launch("recovery-paused", look)
      XCTAssertTrue(app.tabBars.buttons["Coach"].waitForExistence(timeout: 30)); app.tabBars.buttons["Coach"].tap()
      XCTAssertTrue(app.buttons["coach-sign-in"].waitForExistence(timeout: 15))
      return app
    }
    captureBoard("08.7-coach-not-carried") { look in
      let app = launchSignedInCoach(look, arguments: ["-coach-unavailable"])
      ask("How is my training?", app)
      XCTAssertTrue(app.staticTexts["This Windmill does not have Coach. You can still read your log."].waitForExistence(timeout: 10))
      return app
    }
    captureBoard("08.8-coach-daily-cap") { look in
      let app = launchSignedInCoach(look, arguments: ["-coach-board", "stalled", "-coach-daily-cap"])
      ask("Bench has stalled for three weeks. Is Push A still doing anything?", app)
      XCTAssertTrue(app.descendants(matching: .any)["coach-read-receipt"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
      ask("What should Thursday look like?", app)
      XCTAssertTrue(app.descendants(matching: .any)["coach-daily-cap"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["You can ask again later."].exists)
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertEqual(app.descendants(matching: .any)["coach-question"].value as? String, "What should Thursday look like?", "The refused question stays in the field")
      return app
    }
    captureBoard("08.31-coach-change-needs-account") { look in
      let app = XCUIApplication()
      app.launchArguments = ["-scenario", "gym-e2e-anonymous-" + UUID().uuidString, "-server", "https://gym.invalid", "-model-server",
                             "-coach-fixture", "-coach-board", "needs-account", "-AppleLocale", "en_US", "-AppleLanguages", "(en)"] + look.launchArguments
      app.launch()
      let field = app.descendants(matching: .any)["coach-question"]
      XCTAssertTrue(field.waitForExistence(timeout: 30))
      field.tap(); field.typeText("Make Push A harder")
      app.buttons["coach-send"].tap()
      XCTAssertTrue(app.buttons["coach-sign-in"].waitForExistence(timeout: 15))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      return app
    }
  }

  func testAllowanceUsed() {
    captureBoard("01.10-coach-allowance-signed-out") { look in
      let app = XCUIApplication()
      app.launchArguments = ["-scenario", "gym-e2e-anonymous-" + UUID().uuidString, "-server", "https://gym.invalid", "-model-server",
                             "-coach-fixture", "-coach-board", "squats", "-coach-allowance-spent", "-AppleLocale", "en_US", "-AppleLanguages", "(en)"] + look.launchArguments
      app.launch()
      XCTAssertTrue(app.descendants(matching: .any)["coach-question"].waitForExistence(timeout: 30))
      ask("How heavy should I start squats?", app)
      XCTAssertTrue(app.descendants(matching: .any)["coach-answer"].waitForExistence(timeout: 15))
      ask("Swap chin-ups for pulldowns", app)
      XCTAssertTrue(app.buttons["coach-sign-in"].waitForExistence(timeout: 15))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      return app
    }
    captureBoard("01.11-coach-allowance-signed-in") { look in
      let app = launchSignedInCoach(look, arguments: ["-coach-board", "squats", "-coach-allowance-spent"])
      ask("How heavy should I start squats?", app)
      XCTAssertTrue(app.descendants(matching: .any)["coach-answer"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
      ask("Swap chin-ups for pulldowns", app)
      XCTAssertTrue(app.descendants(matching: .any)["coach-allowance"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertFalse(app.buttons["coach-sign-in"].exists, "Signed in, a spent allowance offers no upgrade")
      return app
    }
  }

  func testHistory() {
    captureBoard("08.4-coach-history") { look in
      let app = launchSignedInCoach(look, arguments: ["-coach-history"])
      let history = app.buttons["coach-history"]
      XCTAssertTrue(history.wait(for: \.isHittable, toEqual: true, timeout: 10)); history.tap()
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "My program")).firstMatch.waitForExistence(timeout: 10))
      app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pull-ups")).firstMatch.swipeLeft()
      XCTAssertTrue(app.buttons["trash-swipe"].wait(for: \.isHittable, toEqual: true, timeout: 5))
      return app
    }
  }

  // A signed-in gym with no routines holds the signed-out answer an earlier version archived: Coach's drafts on one card.
  func askDrafts(_ look: Look, arguments: [String] = []) -> XCUIApplication {
    let app = launch("shell-last-room", look, arguments: ["-coach-fixture", "-coach-setup-fixture", "-coach-archived-answer"] + arguments)
    openGymFromJournal(app, opensOn: .routines)
    open(.coach, app)
    // Entering the tab opens a fresh canvas; the archived answer is reopened from History.
    let history = app.buttons["coach-history"]
    XCTAssertTrue(history.waitForExistence(timeout: 15)); history.tap()
    let archived = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "My program")).firstMatch
    XCTAssertTrue(archived.waitForExistence(timeout: 10)); archived.tap()
    let apply = app.buttons["coach-save-routines"]
    XCTAssertTrue(apply.waitForExistence(timeout: 15))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    for _ in 0..<4 where !apply.isHittable { app.scrollViews.firstMatch.swipeUp(velocity: .slow) }
    return app
  }

  func testDrafts() {
    captureBoard("01.7-coach-drafts") { look in askDrafts(look) }
    captureBoard("01.14-coach-one-draft") { look in askDrafts(look, arguments: ["-coach-one-draft"]) }
    captureBoard("01.15-coach-drafts-rejected") { look in
      let app = askDrafts(look)
      app.buttons["coach-reject-routines"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["coach-drafts-rejected"].waitForExistence(timeout: 5))
      return app
    }
  }

  func testDraftsSaved() {
    captureBoard("01.8-coach-drafts-saved") { look in
      let app = askDrafts(look)
      app.buttons["coach-save-routines"].tap()
      XCTAssertTrue(app.buttons["coach-created-setup-operation-2"].waitForExistence(timeout: 15))
      return app
    }
    captureBoard("01.9-coach-routine-summary") { look in
      let app = askDrafts(look)
      app.buttons["coach-save-routines"].tap()
      let first = app.buttons["coach-created-setup-operation-0"]
      XCTAssertTrue(first.waitForExistence(timeout: 15)); first.tap()
      XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 10))
      return app
    }
  }

  func testAfterSignIn() {
    captureBoard("01.13-coach-after-sign-in") { look in
      let app = XCUIApplication()
      app.launchArguments = ["-scenario", "gym-e2e-anonymous-" + UUID().uuidString, "-server", "https://gym.invalid", "-model-server",
                             "-coach-fixture", "-coach-board", "after-sign-in", "-AppleLocale", "en_US", "-AppleLanguages", "(en)"] + look.launchArguments
      app.launch()
      XCTAssertTrue(app.descendants(matching: .any)["coach-question"].waitForExistence(timeout: 30))
      ask("Build me a three day full body program", app)
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "coach-created-")).firstMatch.waitForExistence(timeout: 30))
      app.buttons["you"].tap()
      XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10)); app.buttons["email-sign-in"].tap()
      let address = app.textFields["email-address"]; address.tap(); address.typeText("after-sign-in-" + UUID().uuidString.prefix(8).lowercased() + "@example.com")
      app.buttons["Send code"].tap()
      let code = app.textFields["email-code"]; XCTAssertTrue(code.waitForExistence(timeout: 10)); code.tap(); code.typeText("482913")
      if app.alerts.buttons["Add"].waitForExistence(timeout: 15) { app.alerts.buttons["Add"].tap() }
      if app.buttons["Close"].waitForExistence(timeout: 3) { app.buttons["Close"].tap() }
      ask("Swap chin-ups for pulldowns", app)
      XCTAssertTrue(app.descendants(matching: .any)["coach-proposal-header"].waitForExistence(timeout: 20))
      XCTAssertTrue(app.buttons["coach-stop"].waitForNonExistence(timeout: 10))
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      let reject = app.buttons["coach-reject-proposal"]
      for _ in 0..<4 where !reject.isHittable { app.scrollViews.firstMatch.swipeUp(velocity: .slow) }
      return app
    }
  }

  // The card's Apply, dragged into reach.
  func reachDecision(_ app: XCUIApplication) -> XCUIElement {
    let apply = app.buttons["coach-apply-proposal"]
    for _ in 0..<4 where !apply.isHittable { app.scrollViews.firstMatch.swipeUp(velocity: .slow) }
    return apply
  }

  func testOffline() {
    for look in Look.both {
      let app = launch("shell-last-room", look, arguments: ["-coach-fixture", "-coach-offline"])
      openGymFromJournal(app, opensOn: .routines)
      open(.coach, app)
      XCTAssertTrue(app.staticTexts["Coach needs a connection."].waitForExistence(timeout: 15))
      capture("gym-coach-offline", look, app)
    }
  }

  func testRemovalWait() {
    for look in Look.both {
      let app = launchSignedInCoach(look, arguments: ["-coach-removal", "-coach-decision-stall"])
      ask("Remove Push A.", app)
      let apply = app.buttons["coach-apply-proposal"]
      XCTAssertTrue(apply.waitForExistence(timeout: 10))
      for _ in 0..<4 where !apply.isHittable { app.scrollViews.firstMatch.swipeUp() }
      apply.tap()
      XCTAssertTrue(apply.waitForLabel("Removing…", timeout: 5))
      capture("gym-coach-removal-waiting", look, app)
      XCTAssertTrue(apply.waitForLabel("Try again", timeout: 25))
      capture("gym-coach-removal-still-waiting", look, app)
    }
  }
}
