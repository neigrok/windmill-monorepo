import XCTest

// The Roadmap room's flows that go past the person's own roadmap, on the simulator's boards: the Guide, read with the
// guide above and saved with Undo, added after a draft is discarded, and held past its limit (Roadmap · iOS 08.1 to 08.5);
// a roadmap made signed out joining the account at sign-in (10.7); and a shared roadmap's link on its cover with Fork
// (09.4 to 09.10a). They stand apart from RoadmapFlowTests so CI's shards share the room's flows.
@MainActor final class RoadmapSharingFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // A flow that takes a band's Undo launches with every band standing ten minutes (`-band-stands`), so a slow runner
  // cannot outlast one.
  func launch(_ board: String, takingUndo: Bool = false, asking more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board] + (takingUndo ? ["-band-stands", "600"] : []) + more
    app.launch()
    return app
  }

  func subtasks(_ app: XCUIApplication) -> XCUIElement { app.descendants(matching: .any)["roadmap-step-subtasks"] }

  // The title menu of the open roadmap, by its name, and one of its items.
  func titleMenu(_ title: String, item: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    let name = app.navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    XCTAssertTrue(name.waitForExistence(timeout: 30), file: file, line: line)
    name.tap()
    XCTAssertTrue(app.buttons[item].waitForExistence(timeout: 5), file: file, line: line)
    app.buttons[item].tap()
  }

  // Roadmap · iOS 08.1, 08.3 and 08.5, on the account's phone: the title menu's Guide counts the guide from above and
  // opens the sheet on the roadmap's guide, who else reads it, and *Become a day skipper*'s guide under its name. Edit
  // turns the sheet into the editor with the keyboard up; Save writes once, the sheet reads the guide saved, and the
  // band's Undo takes the save back.
  func testAGuideIsReadWithTheGuideAboveAndItsSaveIsTakenBackByUndo() {
    let app = launch("roadmap-guide-above", takingUndo: true)
    let text = app.staticTexts["roadmap-guide-text"], field = app.textViews["roadmap-guide-field"], undo = app.buttons["roadmap-undo"]
    let guide = "Maya and I take the dinghy out on Sundays. This month I want to rig it, leave the dock and get us home without her taking the tiller.\n\nI mark a step done after I’ve tried it on the water. If the wind picks up, we practise reefing and leave docking for next time. Suggest one new step per sail."
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    titleMenu("Learn to sail", item: "Guide · +1 from above", in: app)
    XCTAssertTrue(text.waitForExistence(timeout: 10))
    XCTAssertEqual(text.label, guide)
    XCTAssertTrue(app.navigationBars["Guide"].exists && app.buttons["roadmap-guide-close"].exists)
    XCTAssertTrue(app.staticTexts["Your agents and people you share this roadmap with can read the guide."].exists)
    XCTAssertTrue(app.staticTexts["Become a day skipper · from above"].exists)
    XCTAssertEqual(app.staticTexts["roadmap-guide-above"].label,
                   "Day skipper by September. Theory first, then sea time: weekends are for the water, one evening a week is for the books.")

    app.buttons["roadmap-guide-edit"].tap()
    XCTAssertTrue(field.waitForExistence(timeout: 10) && app.keyboards.firstMatch.waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["roadmap-guide-save"].isEnabled, "Save waits for a change")
    XCTAssertFalse(app.staticTexts["Become a day skipper · from above"].exists)
    field.typeText(" Bring the tide table.")
    XCTAssertTrue(app.buttons["roadmap-guide-save"].wait(for: \.isEnabled, toEqual: true, timeout: 5))
    app.buttons["roadmap-guide-save"].tap()
    XCTAssertTrue(app.staticTexts["Guide saved"].waitForExistence(timeout: 10))
    XCTAssertTrue(field.waitForNonExistence(timeout: 5) && text.exists)
    XCTAssertTrue(text.label.contains(" Bring the tide table.") && text.label.count == guide.count + 22)
    // The band stands at the sheet's foot and at the room's under it: the sheet's is the one on screen.
    let shown = app.buttons.matching(identifier: "roadmap-undo").allElementsBoundByIndex.first { $0.isHittable }
    XCTAssertNotNil(shown)
    shown?.tap()
    XCTAssertTrue(text.waitForLabel(guide, timeout: 10))
    XCTAssertTrue(undo.waitForNonExistence(timeout: 5))
  }

  // Roadmap · iOS 08.2 and 08.3, on the account's phone: a roadmap with no guide opens on Add Guide, which writes with the
  // keyboard up; Cancel on a changed draft asks once and Discard leaves no guide; Save writes it, read in the sheet over
  // who else reads it, and the menu's Guide opens it again.
  func testAGuideIsAddedAfterADraftIsDiscarded() {
    let app = launch("roadmap-learn-to-sail")
    let add = app.buttons["roadmap-guide-add"], field = app.textViews["roadmap-guide-field"], text = app.staticTexts["roadmap-guide-text"]
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    titleMenu("Learn to sail", item: "Guide", in: app)
    XCTAssertTrue(app.staticTexts["No guide yet"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["What are you working toward?"].exists && !app.buttons["roadmap-guide-edit"].exists)
    add.tap()
    XCTAssertTrue(field.waitForExistence(timeout: 10) && app.keyboards.firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Your agents and people you share this roadmap with can read the guide."].exists)
    field.typeText("Rig it alone.")
    XCTAssertTrue(field.waitForValue("Rig it alone."))
    app.buttons["roadmap-guide-cancel"].tap()
    XCTAssertTrue(app.staticTexts["Discard draft?"].waitForExistence(timeout: 5))
    app.buttons["Discard"].tap()
    XCTAssertTrue(add.waitForExistence(timeout: 5) && !field.exists)

    add.tap()
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.typeText("Sail on Sundays with Maya.")
    XCTAssertTrue(field.waitForValue("Sail on Sundays with Maya."))
    app.buttons["roadmap-guide-save"].tap()
    XCTAssertTrue(text.waitForExistence(timeout: 10))
    XCTAssertEqual(text.label, "Sail on Sundays with Maya.")
    XCTAssertTrue(app.staticTexts["Guide saved"].exists && app.buttons["roadmap-guide-edit"].exists)
    app.buttons["roadmap-guide-close"].tap()
    XCTAssertTrue(text.waitForNonExistence(timeout: 5))
    titleMenu("Learn to sail", item: "Guide", in: app)
    XCTAssertTrue(text.waitForLabel("Sail on Sundays with Maya.", timeout: 10))
  }

  // Roadmap · iOS 08.3 and 08.4: the counter shows from 4,500 characters, and past 5,000 it counts the excess while Save
  // stands dimmed; nothing typed is cut, and Cancel asks before the draft goes.
  func testPastFiveThousandCharactersTheCounterCountsTheExcessAndSaveWaits() {
    let app = launch("roadmap-guide-long")
    let field = app.textViews["roadmap-guide-field"], count = app.staticTexts["roadmap-guide-count"], save = app.buttons["roadmap-guide-save"]
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    titleMenu("Learn to sail", item: "Guide", in: app)
    XCTAssertTrue(app.buttons["roadmap-guide-edit"].waitForExistence(timeout: 10))
    app.buttons["roadmap-guide-edit"].tap()
    XCTAssertTrue(count.waitForLabel("15 left", timeout: 10))
    field.typeText(", then tie up without help.")
    XCTAssertTrue(count.waitForLabel("12 over", timeout: 10))
    XCTAssertFalse(save.isEnabled)
    XCTAssertTrue((field.value as? String)?.contains(", then tie up without help.") == true, "Nothing typed is cut")
    app.buttons["roadmap-guide-cancel"].tap()
    XCTAssertTrue(app.staticTexts["Discard draft?"].waitForExistence(timeout: 5))
    app.buttons["Discard"].tap()
    XCTAssertTrue(field.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["roadmap-guide-text"].label.hasSuffix("Next Sunday, practise coming alongside the dock."))
  }

  // Roadmap · iOS 10.7, through the model server: a roadmap made on a phone signed out is named in the sign-in question
  // of an account that holds a roadmap; Add joins it to the account, so the room holds both and the account has every
  // change the phone made.
  func testARoadmapMadeSignedOutJoinsTheAccountAtSignInOnAdd() {
    let app = launch("roadmap-sign-in")
    let name = app.textFields["roadmap-new-name"]
    XCTAssertTrue(app.buttons["roadmap-new"].waitForExistence(timeout: 30))
    app.buttons["roadmap-new"].tap()
    XCTAssertTrue(name.waitForExistence(timeout: 10))
    name.tap()
    name.typeText("Learn to cook")
    app.buttons["roadmap-new-create"].tap()
    XCTAssertTrue(app.staticTexts["0 of 1 done"].waitForExistence(timeout: 10))

    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["email-sign-in"].waitForExistence(timeout: 10))
    app.buttons["email-sign-in"].tap()
    let email = app.textFields["email-address"], code = app.textFields["email-code"]
    XCTAssertTrue(email.waitForExistence(timeout: 5))
    email.tap()
    email.typeText("roadmap-fixture@example.com")
    XCTAssertTrue(email.waitForValue("roadmap-fixture@example.com"))
    app.buttons["Send code"].tap()
    XCTAssertTrue(code.waitForExistence(timeout: 10))
    code.tap()
    code.typeText("482913")
    let question = app.alerts["Add to your account?"]
    XCTAssertTrue(question.waitForExistence(timeout: 30))
    XCTAssertTrue(question.staticTexts[
      "This phone has 1 roadmap from before you signed in. Your account already has roadmaps. Add it, or discard it from this phone."].exists)
    XCTAssertTrue(question.buttons["Discard"].exists && question.buttons["Cancel sign-in"].exists)
    question.buttons["Add"].tap()
    XCTAssertTrue(question.waitForNonExistence(timeout: 15))

    titleMenu("Learn to cook", item: "All Roadmaps…", in: app)
    let rows = app.buttons.matching(identifier: "roadmap-listed")
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier == %@ AND label == %@", "roadmap-listed", "Learn to sail, 3 of 8 done")).firstMatch
      .waitForExistence(timeout: 30))
    XCTAssertEqual(Set((0..<rows.count).map { rows.element(boundBy: $0).label }), ["Learn to cook, 0 of 1 done", "Learn to sail, 3 of 8 done"])
    app.buttons["BackButton"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 10))
    app.buttons["you"].tap()
    XCTAssertTrue(app.staticTexts["Backed up"].waitForExistence(timeout: 30))
  }

  // 09.4 to 09.8: another account's public roadmap opens by its link on a cover, on its Graph with the owner's progress; its
  // Board's rows open read-only pages with Copy Link and no Edit or Complete; Fork copies it, the copy arrives by sync and
  // opens on its Board under the band, and the cover is gone.
  func testASharedLinkOpensOnACoverAndForkBringsTheCopyToItsBoard() {
    let app = launch("roadmap-cover")
    let close = app.buttons["roadmap-cover-close"], fork = app.buttons["roadmap-fork"]
    XCTAssertTrue(app.descendants(matching: .any)["roadmap-graph"].waitForExistence(timeout: 60))
    XCTAssertTrue(close.exists && fork.isEnabled && app.buttons["roadmap-cover-share"].exists)
    XCTAssertTrue(app.staticTexts["Shared roadmap · 3 of 8 done"].exists)

    app.segmentedControls.buttons["Board"].tap()
    XCTAssertTrue(app.roadmapStep("Read the wind").waitForExistence(timeout: 10))
    app.roadmapStep("Read the wind").tap()
    XCTAssertTrue(app.roadmapStepPage("Read the wind"))
    XCTAssertFalse(app.buttons["roadmap-step-edit"].exists || app.buttons["roadmap-complete"].exists || subtasks(app).exists)
    app.buttons["roadmap-step-more"].tap()
    XCTAssertTrue(app.buttons["Copy Link"].waitForExistence(timeout: 5) && !app.buttons["Delete Step"].exists)
    app.buttons["Copy Link"].tap()
    XCTAssertTrue(fork.waitForHittable(timeout: 10))

    fork.tap()
    XCTAssertTrue(app.staticTexts["Forked · 8 steps planted"].waitForExistence(timeout: 60))
    XCTAssertFalse(close.exists)
    XCTAssertTrue(app.staticTexts["0 of 8 done"].exists)
    XCTAssertTrue(app.roadmapStep("Choose a sailing course").exists)
  }

  // 09.10a: with a connection, a link to a roadmap the phone may not read says so on its cover, and closes to the room.
  func testALinkToAPrivateRoadmapCannotBeOpenedAndClosesToTheRoom() {
    let app = launch("roadmap-cover-private")
    XCTAssertTrue(app.staticTexts["This roadmap can’t be opened"].waitForExistence(timeout: 60))
    XCTAssertFalse(app.buttons["roadmap-cover-sign-in"].exists || app.buttons["roadmap-fork"].exists)
    app.buttons["roadmap-cover-close"].tap()
    XCTAssertTrue(app.buttons["roadmap-cover-close"].waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.buttons["room-menu"].waitForHittable(timeout: 10))
  }
}
