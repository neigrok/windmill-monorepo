import XCTest

// The Roadmap room's flows on the simulator's boards: a step's workspace (Roadmap · iOS 03.2, 03.3, 03.10, 03.11, 03.14),
// the step form's links (05.1, 05.8), the Board's Find, sort and filter, branch and several steps with Kinds (02.4 to
// 02.12, 03.7, 06.1 to 06.5b), the Graph's (04.1 to 04.5, 04.7), then Activity and a step's History (01.13, 01.13b,
// 03.12), the room's first read (01.5b), an Undo that brings nothing back (02.10d), and a shared roadmap's link on its
// cover with Fork (09.4 to 09.10a). The canvas is one element, as
// VoiceOver hears it, so a step is tapped where the layout seats it: *Learn to sail* opens at the phone's working zoom
// with the middle of its seats' box at the centre of what the bars leave, and each step stands a known way from that
// centre (`packages/api-contract/roadmap/layout/learn-to-sail.json` pins the seats). The zoom floor is half the opening
// zoom, and the pinch ceiling 2.94 times it. The band slot holds *Next* at rest and the selected step's bar once one
// is selected, so that centre is read while no step is selected, and a pinch, which XCTest centres on the element,
// is made then too.
@MainActor final class RoadmapFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // A flow that takes a band's Undo launches with every band standing ten minutes (`-band-stands`), so a slow runner
  // cannot outlast one.
  func launch(_ board: String, takingUndo: Bool = false, asking more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board] + (takingUndo ? ["-band-stands", "600"] : []) + more
    app.launch()
    return app
  }

  // A step's page, opened from its Board row.
  func page(of step: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(app.roadmapStep(step).waitForExistence(timeout: 30), file: file, line: line)
    app.roadmapStep(step).tap()
    XCTAssertTrue(app.roadmapStepPage(step), file: file, line: line)
  }

  // A subtask's row, the switch VoiceOver hears, and the Subtasks header with its count.
  func subtask(_ words: String, in app: XCUIApplication) -> XCUIElement {
    app.switches.matching(NSPredicate(format: "identifier == %@ AND label == %@", "roadmap-subtask", words)).firstMatch
  }

  func subtasks(_ app: XCUIApplication) -> XCUIElement { app.descendants(matching: .any)["roadmap-step-subtasks"] }

  // A link's row on a step's page, or in its form, by what it says.
  func link(_ label: String, in app: XCUIApplication, form: Bool = false) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", form ? "roadmap-form-link" : "roadmap-step-link", label))
      .firstMatch
  }

  // New Link, raised by a button, filled and added: return in Title goes on to URL, and Add waits for an address.
  func addLink(_ title: String, _ address: String, raisedBy button: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    let add = app.buttons["roadmap-link-add"], name = app.textFields["roadmap-link-title"]
    XCTAssertTrue(app.buttons[button].waitForHittable(timeout: 10), file: file, line: line)
    app.buttons[button].tap()
    XCTAssertTrue(name.waitForExistence(timeout: 10) && app.navigationBars["New Link"].exists && !add.isEnabled, file: file, line: line)
    XCTAssertEqual([name.label, app.textFields["roadmap-link-url"].label], ["Title", "URL"], file: file, line: line)
    name.tap()
    name.typeText(title + "\n")
    XCTAssertFalse(add.isEnabled, file: file, line: line)
    app.textFields["roadmap-link-url"].tap()
    app.textFields["roadmap-link-url"].typeText(address)
    XCTAssertTrue(add.wait(for: \.isEnabled, toEqual: true, timeout: 5), file: file, line: line)
    add.tap()
    XCTAssertTrue(name.waitForNonExistence(timeout: 10), file: file, line: line)
  }

  // Roadmap · iOS 03.2, 03.3, 03.5, 03.10, 03.11 and 03.14, on a phone never signed in and on its copy alone: a step's
  // workspace starts as its three add rows; Add Subtask takes a subtask at each return and keeps the field, with the
  // foot away while it has the keyboard; a tap checks one, which the band says with Undo; the note is written on its own
  // screen and Done returns to the step; Add Link raises the two-field form, whose Add waits for an address; and after
  // a relaunch the page holds all of it.
  func testAStepsWorkspaceIsWrittenSignedOutAndFoundAfterARelaunch() {
    let app = launch("roadmap-empty")
    let roadmapName = app.textFields["roadmap-new-name"], field = app.textFields["roadmap-add-subtask"], complete = app.buttons["roadmap-complete"]
    XCTAssertTrue(app.buttons["roadmap-new"].waitForExistence(timeout: 30))
    app.buttons["roadmap-new"].tap()
    XCTAssertTrue(roadmapName.waitForExistence(timeout: 10))
    roadmapName.tap()
    roadmapName.typeText("Learn to cook")
    XCTAssertTrue(app.buttons["roadmap-new-create"].wait(for: \.isEnabled, toEqual: true, timeout: 5))
    app.buttons["roadmap-new-create"].tap()
    page(of: "Learn to cook", in: app)

    XCTAssertEqual(subtasks(app).label, "Subtasks, Only you")
    XCTAssertTrue(field.exists && app.buttons["roadmap-add-note"].exists && app.buttons["roadmap-add-link"].exists && complete.exists)
    XCTAssertEqual([field.label, field.placeholderValue], ["Add Subtask", "Add Subtask"])
    field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5) && complete.waitForNonExistence(timeout: 5))
    field.typeText("Buy onions\n")
    XCTAssertTrue(subtask("Buy onions", in: app).waitForExistence(timeout: 10))
    field.typeText("Sharpen the knife\n")
    XCTAssertTrue(subtask("Sharpen the knife", in: app).waitForExistence(timeout: 10))
    XCTAssertTrue(subtasks(app).waitForLabel("Subtasks, 0 of 2, Only you") && !app.buttons["roadmap-undo"].exists)
    // Return on the empty field adds nothing and lets go of the keyboard, and the foot is back.
    field.typeText("\n")
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5) && complete.waitForExistence(timeout: 5))

    XCTAssertEqual(subtask("Buy onions", in: app).value as? String, "0")
    subtask("Buy onions", in: app).tap()
    XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10) && app.staticTexts["Buy onions checked"].exists)
    XCTAssertTrue(subtask("Buy onions", in: app).waitForValue("1") && subtasks(app).waitForLabel("Subtasks, 1 of 2, Only you"))
    XCTAssertTrue(complete.exists && !app.staticTexts["roadmap-subtasks-done"].exists)

    app.buttons["roadmap-add-note"].tap()
    let note = app.textViews["roadmap-note-field"]
    XCTAssertTrue(note.waitForExistence(timeout: 10) && app.navigationBars["Note"].exists && app.keyboards.firstMatch.waitForExistence(timeout: 10))
    XCTAssertEqual(note.label, "Note")
    note.typeText("Dice, do not mash.")
    app.buttons["roadmap-note-done"].tap()
    XCTAssertTrue(app.roadmapStepPage("Learn to cook"))
    XCTAssertTrue(app.buttons["roadmap-note"].waitForLabel("Dice, do not mash.") && !app.buttons["roadmap-add-note"].exists)

    addLink("Knife skills", "example.com/knives", raisedBy: "roadmap-add-link", in: app)
    XCTAssertTrue(link("Knife skills, example.com", in: app).waitForExistence(timeout: 10))

    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    XCTAssertTrue(app.navigationBars["Learn to cook"].waitForExistence(timeout: 30))
    page(of: "Learn to cook", in: app)
    XCTAssertEqual(subtasks(app).label, "Subtasks, 1 of 2, Only you")
    XCTAssertEqual([subtask("Buy onions", in: app).value as? String, subtask("Sharpen the knife", in: app).value as? String], ["1", "0"])
    XCTAssertEqual(app.buttons["roadmap-note"].label, "Dice, do not mash.")
    XCTAssertTrue(link("Knife skills, example.com", in: app).exists && app.buttons["roadmap-add-link"].exists)
  }

  // Roadmap · iOS 03.2 and 03.3: a workspace that arrived with its account; the last subtask checked says All subtasks
  // done and leaves the step Up next; a subtask and a link slide left for Delete, each held with Undo in the band, and
  // Undo brings it back.
  func testEverySubtaskDoneCompletesNothingAndADeletedSubtaskOrLinkComesBackByUndo() {
    let app = launch("roadmap-workspace", takingUndo: true)
    let undo = app.buttons["roadmap-undo"], done = app.staticTexts["roadmap-subtasks-done"]
    page(of: "Read the wind", in: app)
    XCTAssertEqual(subtasks(app).label, "Subtasks, 1 of 2, Only you")
    XCTAssertEqual([subtask("Watch the telltales for ten minutes", in: app).value as? String, subtask("Check the harbour flag", in: app).value as? String], ["1", "0"])
    XCTAssertFalse(done.exists)

    subtask("Check the harbour flag", in: app).tap()
    XCTAssertTrue(undo.waitForExistence(timeout: 10) && app.staticTexts["Check the harbour flag checked"].exists)
    XCTAssertTrue(done.waitForExistence(timeout: 5) && subtasks(app).waitForLabel("Subtasks, 2 of 2, Only you"))
    XCTAssertEqual(done.label, "All subtasks done")
    XCTAssertTrue(app.buttons["roadmap-complete"].exists && !app.buttons["roadmap-reset"].exists)
    undo.tap()
    XCTAssertTrue(subtasks(app).waitForLabel("Subtasks, 1 of 2, Only you") && done.waitForNonExistence(timeout: 5))

    subtask("Check the harbour flag", in: app).swipeLeft()
    XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
    app.buttons["Delete"].tap()
    XCTAssertTrue(undo.waitForExistence(timeout: 10) && app.staticTexts["Check the harbour flag deleted"].exists)
    XCTAssertTrue(subtasks(app).waitForLabel("Subtasks, 1 of 1, Only you"))
    undo.tap()
    XCTAssertTrue(subtasks(app).waitForLabel("Subtasks, 1 of 2, Only you") && subtask("Check the harbour flag", in: app).exists)

    app.swipeUp()
    let guide = link("Telltale guide, rya.org.uk", in: app)
    XCTAssertTrue(guide.waitForExistence(timeout: 5) && app.buttons["roadmap-note"].label == "Gusts show as dark patches on the water. Look upwind before leaving the dock.")
    guide.swipeLeft()
    XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
    app.buttons["Delete"].tap()
    XCTAssertTrue(undo.waitForExistence(timeout: 10) && app.staticTexts["Telltale guide deleted"].exists)
    XCTAssertTrue(guide.waitForNonExistence(timeout: 5))
    undo.tap()
    XCTAssertTrue(guide.waitForExistence(timeout: 10))
  }

  // A second phone of the account adds a subtask to the step whose page this phone has open, and the page shows it.
  func testASecondPhonesSubtaskArrivesOnAnOpenPage() {
    let app = launch("roadmap-two-phones")
    page(of: "Read the wind", in: app)
    XCTAssertTrue(subtask("Ask about the tide table", in: app).waitForExistence(timeout: 30))
    XCTAssertTrue(app.roadmapStepPage("Read the wind") && subtasks(app).waitForLabel("Subtasks, 0 of 1, Only you"))
  }

  // Roadmap · iOS 05.1, 05.8 and 03.11: the form lists the links its step shares; one slides left for Delete and Add
  // Link takes another through the same two fields, both part of the draft; Save writes them in its one gesture, and
  // its Undo brings the step's links back.
  func testTheFormsLinksAreRemovedAndAddedInItsDraftAndSavedWithUndo() {
    let app = launch("roadmap-learn-to-sail", takingUndo: true)
    let commit = app.buttons["roadmap-form-commit"], beaufort = link("Beaufort wind scale, metoffice.gov.uk", in: app)
    let held = link("Beaufort wind scale, metoffice.gov.uk", in: app, form: true)
    page(of: "Read the wind", in: app)
    XCTAssertTrue(beaufort.exists)
    app.buttons["roadmap-step-edit"].tap()
    XCTAssertTrue(app.navigationBars["Edit Step"].waitForExistence(timeout: 10) && !commit.isEnabled)
    XCTAssertTrue(held.waitForExistence(timeout: 5))

    held.swipeLeft()
    XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
    app.buttons["Delete"].tap()
    XCTAssertTrue(held.waitForNonExistence(timeout: 5) && commit.wait(for: \.isEnabled, toEqual: true, timeout: 5))
    addLink("Telltale guide", "rya.org.uk/telltales", raisedBy: "roadmap-form-add-link", in: app)
    XCTAssertTrue(link("Telltale guide, rya.org.uk", in: app, form: true).waitForExistence(timeout: 5))
    commit.tap()
    XCTAssertTrue(app.staticTexts["Read the wind saved"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.roadmapStepPage("Read the wind") && link("Telltale guide, rya.org.uk", in: app).waitForExistence(timeout: 10) && !beaufort.exists)
    app.buttons["roadmap-undo"].tap()
    XCTAssertTrue(beaufort.waitForExistence(timeout: 10) && link("Telltale guide, rya.org.uk", in: app).waitForNonExistence(timeout: 5))
  }

  // The Board's Sort and filter menu, open.
  func boardTool(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(app.buttons["roadmap-board-tool"].waitForHittable(timeout: 10), file: file, line: line)
    app.buttons["roadmap-board-tool"].tap()
    XCTAssertTrue(app.buttons["Select Steps"].waitForExistence(timeout: 5), file: file, line: line)
  }

  // Find, up with words typed, or closed by its own close.
  func find(_ words: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    app.buttons["roadmap-find"].tap()
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5) && app.keyboards.firstMatch.waitForExistence(timeout: 10), file: file, line: line)
    field.typeText(words)
    XCTAssertTrue(field.waitForValue(words), file: file, line: line)
  }

  func closeFind(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    let close = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "close")).firstMatch
    XCTAssertTrue(close.waitForExistence(timeout: 5), file: file, line: line)
    close.tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForNonExistence(timeout: 5) && app.buttons["roadmap-new-step"].waitForExistence(timeout: 5),
                  file: file, line: line)
  }

  // The steps the Board lists on screen, by what each row says.
  func rows(_ app: XCUIApplication) -> [String] {
    let rows = app.descendants(matching: .any).matching(identifier: "roadmap-step")
    return (0..<rows.count).map { rows.element(boundBy: $0).label }
  }

  // Roadmap · iOS 06.1, 06.3, 02.10, 02.11, 02.5 and 02.8, on a phone never signed in and on its copy alone: Kinds from
  // the title menu adds a kind on the next free hue and names it; two steps selected through Select Steps are recolored
  // to it in one gesture; Find finds a step by its words; the Board's tool shows the new kind alone; and after a relaunch
  // the kind, the steps' colour and both reads are all there.
  func testAKindAddedStepsRecoloredAFindAndAFilterAreWrittenSignedOutAndFoundAfterARelaunch() {
    let app = launch("roadmap-many")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 60))
    let practice = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "roadmap-kinds-row", "Practice")).firstMatch
    app.navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Learn to sail")).firstMatch.tap()
    XCTAssertTrue(app.buttons["Kinds"].waitForExistence(timeout: 5))
    app.buttons["Kinds"].tap()
    XCTAssertTrue(app.buttons["roadmap-kinds-add"].waitForExistence(timeout: 10))
    let listed = app.buttons.matching(identifier: "roadmap-kinds-row")
    XCTAssertEqual((0..<listed.count).map { listed.element(boundBy: $0).label },
                   ["Build, Things you make, 3", "Learn, Things you figure out, 2", "Milestone, Moments that matter, 1", "Sky, 2"])
    app.buttons["roadmap-kinds-add"].tap()
    let name = app.textFields["roadmap-kind-name"]
    XCTAssertTrue(app.navigationBars["Brick"].waitForExistence(timeout: 5) && app.keyboards.firstMatch.waitForExistence(timeout: 10))
    name.typeText("Practice")
    app.textFields["roadmap-kind-description"].tap()
    app.textFields["roadmap-kind-description"].typeText("Hours on the water")
    XCTAssertTrue(app.navigationBars["Practice"].waitForExistence(timeout: 5))
    app.navigationBars["Practice"].buttons.element(boundBy: 0).tap()
    XCTAssertTrue(practice.waitForLabel("Practice, Hours on the water, 0"))
    app.buttons["roadmap-kinds-close"].tap()
    XCTAssertTrue(app.buttons["roadmap-kinds-add"].waitForNonExistence(timeout: 5))

    boardTool(app)
    app.buttons["Select Steps"].tap()
    XCTAssertTrue(app.buttons["roadmap-select-done"].waitForExistence(timeout: 5) && app.navigationBars["0 Selected"].exists)
    XCTAssertFalse(app.segmentedControls.firstMatch.isEnabled || app.buttons["roadmap-new-step"].exists)
    app.roadmapStep("Tie a bowline").tap()
    app.roadmapStep("Sail a triangle").tap()
    XCTAssertTrue(app.navigationBars["2 Selected"].waitForExistence(timeout: 5))
    app.buttons["roadmap-recolor"].tap()
    XCTAssertTrue(app.buttons["Practice"].waitForExistence(timeout: 5))
    app.buttons["Practice"].tap()
    XCTAssertTrue(app.staticTexts["2 steps recolored"].waitForExistence(timeout: 10) && app.buttons["roadmap-new-step"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.roadmapStep("Tie a bowline").label.hasPrefix("Practice, Tie a bowline"))

    find("bowline", in: app)
    XCTAssertTrue(app.roadmapStep("Tie a bowline").waitForExistence(timeout: 5))
    XCTAssertEqual(rows(app), ["Practice, Tie a bowline, Tie a secure loop that is easy to undo, then practise it with your eyes closed."])
    closeFind(app)

    boardTool(app)
    app.buttons["Practice"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["roadmap-showing"].waitForLabel("Showing Practice"))
    XCTAssertEqual([app.buttons["roadmap-group-upNext"].label, app.buttons["roadmap-group-locked"].label], ["Up next, 1", "Locked, 1"])
    XCTAssertFalse(app.buttons["roadmap-group-done"].exists)
    XCTAssertTrue(app.staticTexts["3 of 8 done"].exists)

    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    XCTAssertFalse(app.staticTexts["roadmap-showing"].exists)
    XCTAssertTrue(app.roadmapStep("Sail a triangle").label.hasPrefix("Practice, Sail a triangle"))
    boardTool(app)
    app.buttons["Practice"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["roadmap-showing"].waitForLabel("Showing Practice"))
    XCTAssertEqual(rows(app).count, 2)
    app.buttons["roadmap-showing-clear"].tap()
    XCTAssertTrue(app.staticTexts["roadmap-showing"].waitForNonExistence(timeout: 5))
    find("bowline", in: app)
    XCTAssertTrue(app.roadmapStep("Tie a bowline").waitForExistence(timeout: 5) && rows(app).count == 1)
  }

  // 03.7, 02.9, 02.4 and 02.10 to 02.12: View Branch on a step's page narrows the Board to it, whose first row clears it;
  // Open in Graph from a row's menu shows the step selected on the Graph; two steps selected are deleted after one
  // question with what it costs and held with one Undo; and Select All, which takes the starting step, dims Delete while
  // the band says why.
  func testABranchOpenInGraphAndSeveralStepsDeletedWithOneUndo() {
    let app = launch("roadmap-learn-to-sail", takingUndo: true)
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    page(of: "Read the wind", in: app)
    app.buttons["roadmap-step-more"].tap()
    XCTAssertTrue(app.buttons["View Branch"].waitForExistence(timeout: 5))
    app.buttons["View Branch"].tap()
    XCTAssertTrue(app.staticTexts["roadmap-branch"].waitForLabel("Branch · Read the wind"))
    XCTAssertEqual([app.buttons["roadmap-group-upNext"].label, app.buttons["roadmap-group-locked"].label], ["Up next, 1", "Locked, 3"])
    app.buttons["roadmap-branch-clear"].tap()
    XCTAssertTrue(app.buttons["roadmap-group-upNext"].waitForLabel("Up next, 2"))

    app.roadmapStep("Sail solo").press(forDuration: 1)
    XCTAssertTrue(app.buttons["Open in Graph"].waitForExistence(timeout: 5))
    app.buttons["Open in Graph"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["roadmap-graph"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["roadmap-graph-step"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["roadmap-graph-step"].label, "Milestone, Sail solo")
    app.segmentedControls.buttons["Board"].tap()
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 10))

    let undo = app.buttons["roadmap-undo"], delete = app.buttons["roadmap-delete-steps"]
    boardTool(app)
    app.buttons["Select Steps"].tap()
    XCTAssertTrue(delete.waitForExistence(timeout: 5) && !delete.isEnabled)
    app.roadmapStep("Tie a bowline").tap()
    app.roadmapStep("Sail a triangle").tap()
    XCTAssertTrue(delete.waitForLabel("Delete 2 Steps") && delete.isEnabled)
    delete.tap()
    XCTAssertTrue(app.staticTexts["Delete 2 steps?"].waitForExistence(timeout: 5) && app.staticTexts["Removes 2 steps · 1 branch resplices"].exists)
    let answer = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Delete 2 Steps", "roadmap-delete-steps")).firstMatch
    answer.tap()
    XCTAssertTrue(app.staticTexts["3 of 6 done"].waitForExistence(timeout: 10) && app.staticTexts["2 steps deleted"].exists)
    XCTAssertTrue(app.buttons["roadmap-new-step"].exists && !delete.exists)
    undo.tap()
    XCTAssertTrue(app.staticTexts["3 of 8 done"].waitForExistence(timeout: 10) && app.roadmapStep("Tie a bowline").waitForExistence(timeout: 5))

    app.roadmapStep("Read the wind").press(forDuration: 1)
    XCTAssertTrue(app.buttons["Select"].waitForExistence(timeout: 5))
    app.buttons["Select"].tap()
    XCTAssertTrue(app.navigationBars["1 Selected"].waitForExistence(timeout: 5))
    app.buttons["roadmap-select-all"].tap()
    XCTAssertTrue(app.navigationBars["8 Selected"].waitForExistence(timeout: 5) && app.buttons["Deselect All"].exists)
    XCTAssertTrue(app.staticTexts["A roadmap keeps one starting step"].waitForExistence(timeout: 5) && !delete.isEnabled)
    XCTAssertTrue(app.buttons["roadmap-recolor"].isEnabled)
    app.buttons["roadmap-select-done"].tap()
    XCTAssertTrue(app.buttons["roadmap-new-step"].waitForExistence(timeout: 5) && app.segmentedControls.firstMatch.isEnabled)
  }

  // 02.6, 05.2, 06.2, 06.5 and 06.5b: Find with a kind shown that matches nothing offers a new step of its words, whose
  // form opens named so; Edit Kinds in the form's Kind list raises Kinds over the form, where a hue another kind wears is
  // dimmed and cannot be chosen; a kind no step wears is removed at once in edit mode, with Undo in the band at the
  // sheet's foot; and the step created stands on the Board, the kind filter that hid it cleared and Find's words kept.
  func testFindOffersANewStepOfItsWordsAndAKindNoStepWearsIsRemovedWithUndo() {
    let app = launch("roadmap-learn-to-sail", takingUndo: true)
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    boardTool(app)
    app.buttons["Build"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["roadmap-showing"].waitForLabel("Showing Build"))
    find("reef", in: app)
    XCTAssertTrue(app.staticTexts["No steps match “reef”"].waitForExistence(timeout: 5) && app.buttons["roadmap-clear-filters"].exists)
    app.buttons["roadmap-find-new-step"].tap()
    XCTAssertTrue(app.textFields["roadmap-form-name"].waitForValue("reef"))
    app.buttons["roadmap-form-kind"].tap()
    XCTAssertTrue(app.buttons["roadmap-edit-kinds"].waitForExistence(timeout: 5))
    app.buttons["roadmap-edit-kinds"].tap()
    XCTAssertTrue(app.buttons["roadmap-kinds-add"].waitForExistence(timeout: 10))

    app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "roadmap-kinds-row", "Build")).firstMatch.tap()
    XCTAssertTrue(app.navigationBars["Build"].waitForExistence(timeout: 5))
    let olive = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Olive")).firstMatch
    XCTAssertTrue(olive.exists)
    XCTAssertEqual(olive.label, "Olive, In use by Learn")
    olive.tap()
    XCTAssertTrue(app.navigationBars["Build"].exists)
    XCTAssertFalse(olive.isSelected || olive.isEnabled)
    app.navigationBars["Build"].buttons.element(boundBy: 0).tap()

    app.buttons["roadmap-kinds-add"].tap()
    XCTAssertTrue(app.navigationBars["Brick"].waitForExistence(timeout: 5))
    app.navigationBars["Brick"].buttons.element(boundBy: 0).tap()
    // In edit mode a row says its delete control first: *Remove, Brick, 0*.
    let brick = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "roadmap-kinds-row", "Brick")).firstMatch
    XCTAssertTrue(brick.waitForExistence(timeout: 5))
    app.buttons["roadmap-kinds-edit"].tap()
    XCTAssertTrue(app.staticTexts["A kind that steps wear can’t be removed."].waitForExistence(timeout: 5) && brick.waitForLabel("Remove, Brick, 0"))
    let build = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "roadmap-kinds-row", "Build")).firstMatch
    XCTAssertEqual(build.label, "Build, Things you make, 3")
    brick.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
    let remove = app.buttons["Delete"]
    XCTAssertTrue(remove.waitForExistence(timeout: 5))
    remove.tap()
    XCTAssertTrue(app.staticTexts["Brick removed"].waitForExistence(timeout: 10) && brick.waitForNonExistence(timeout: 5))
    // The band stands at the foot of each screen under the sheet too: the sheet's own, on top, is the one a tap reaches.
    let undo = app.buttons.matching(identifier: "roadmap-undo").allElementsBoundByIndex.first { $0.isHittable }
    XCTAssertNotNil(undo)
    undo?.tap()
    XCTAssertTrue(brick.waitForExistence(timeout: 10))

    app.buttons["roadmap-kinds-close"].tap()
    XCTAssertTrue(app.buttons["roadmap-kinds-add"].waitForNonExistence(timeout: 5))
    app.roadmapKind("Sky").tap()
    XCTAssertTrue(app.buttons["roadmap-form-kind"].waitForLabel("Kind, Sky", timeout: 5))
    app.buttons["roadmap-form-commit"].tap()
    XCTAssertTrue(app.staticTexts["reef added · Up next"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.roadmapStep("reef").waitForExistence(timeout: 5) && rows(app).count == 1)
    XCTAssertFalse(app.staticTexts["roadmap-showing"].exists || app.buttons["roadmap-clear-filters"].exists)
    XCTAssertEqual(app.searchFields.firstMatch.value as? String, "reef")
  }

  // The canvas of the open roadmap, once the switch has shown the Graph, and the centre of what the bars leave of it.
  func graph(of app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) -> (canvas: XCUIElement, centre: CGPoint) {
    let graph = app.segmentedControls.buttons["Graph"]
    XCTAssertTrue(graph.waitForExistence(timeout: 30), file: file, line: line)
    graph.tap()
    let canvas = app.descendants(matching: .any)["roadmap-graph"]
    XCTAssertTrue(canvas.waitForExistence(timeout: 10), file: file, line: line)
    return (canvas, CGPoint(x: canvas.frame.midX, y: canvas.frame.midY))
  }

  // The band slot's bar of the selected step, by what it says: the step's colour and its name.
  func bar(_ label: String, in app: XCUIApplication) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier == %@ AND label == %@", "roadmap-graph-step", label)).firstMatch
  }

  // The canvas once it says so much of the roadmap is done.
  func graph(saying progress: String, in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND value == %@", "roadmap-graph", progress)).firstMatch
  }

  // A point of the screen so many points right of and under that centre.
  func point(_ app: XCUIApplication, from centre: CGPoint, right: Double, down: Double) -> XCUICoordinate {
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: centre.x + right, dy: centre.y + down))
  }

  // 04.1 and 04.2: the switch shows the Graph in place of the Board; a tap rings a step and the band slot becomes that
  // step, a tap on empty canvas clears it, and the bar opens the step's page. The Graph follows a step completed there,
  // and the roadmap opens on its Graph again at the next launch.
  func testTheSwitchShowsTheGraphATapSelectsAStepAndItsBarOpensItsPage() {
    let app = launch("roadmap-learn-to-sail")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    XCTAssertTrue(app.segmentedControls.firstMatch.isEnabled && app.buttons["Sort and filter"].exists)
    let (canvas, centre) = graph(of: app)
    XCTAssertEqual("\(canvas.label) · \(canvas.value as? String ?? "")", "Graph · 3 of 8 done")
    XCTAssertFalse(app.buttons["roadmap-group-locked"].exists || app.buttons["Sort and filter"].exists)
    XCTAssertTrue(app.buttons["Find"].exists && !app.buttons["Find"].isEnabled && app.buttons["roadmap-new-step"].isEnabled)
    let selected = app.buttons["roadmap-graph-step"]
    XCTAssertFalse(selected.exists)

    point(app, from: centre, right: 92, down: 62).tap()
    XCTAssertTrue(bar("Sky, Read the wind", in: app).waitForExistence(timeout: 5))
    point(app, from: centre, right: -100, down: -150).tap()
    XCTAssertTrue(selected.waitForNonExistence(timeout: 5))
    point(app, from: centre, right: 4, down: 101).tap()
    XCTAssertTrue(bar("Learn, Tie a bowline", in: app).waitForExistence(timeout: 5))

    selected.tap()
    XCTAssertTrue(app.roadmapStepPage("Tie a bowline"))
    app.buttons["roadmap-complete"].tap()
    XCTAssertTrue(app.buttons["roadmap-undo"].waitForExistence(timeout: 10))
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(graph(saying: "4 of 8 done", in: app).waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["4 of 8 done"].exists)

    app.terminate()
    app.launchArguments.append("-restore-board")
    app.launch()
    XCTAssertTrue(graph(saying: "4 of 8 done", in: app).waitForExistence(timeout: 30))
    XCTAssertFalse(app.buttons["roadmap-group-locked"].exists)
    app.segmentedControls.buttons["Board"].tap()
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 10))
    XCTAssertFalse(canvas.exists)
  }

  // 04.4: a pinch zooms about the fingers, between the layout's floor and the pinch ceiling, and one finger pans. The
  // same point of the canvas holds another step once the picture has grown or moved under it.
  func testAPinchZoomsAndADragPansThePictureInsideItsFraming() {
    let app = launch("roadmap-learn-to-sail")
    let (canvas, centre) = graph(of: app)
    let selected = app.buttons["roadmap-graph-step"]
    let empty = point(app, from: centre, right: -100, down: -150)
    point(app, from: centre, right: -6, down: 93).tap()
    XCTAssertTrue(bar("Learn, Tie a bowline", in: app).waitForExistence(timeout: 5))
    empty.tap()
    XCTAssertTrue(selected.waitForNonExistence(timeout: 5))

    // Pinched in to the ceiling, *Name the boat parts* has come under that point from 32 points under the centre.
    canvas.pinch(withScale: 6, velocity: 3)
    point(app, from: centre, right: -6, down: 93).tap()
    XCTAssertTrue(bar("Sky, Name the boat parts", in: app).waitForExistence(timeout: 5))
    empty.tap()
    XCTAssertTrue(selected.waitForNonExistence(timeout: 5))

    // Pinched out to the floor, *Read the wind* stands half as far from the centre as it opened, and its opening place
    // is empty canvas.
    canvas.pinch(withScale: 0.1, velocity: -3)
    point(app, from: centre, right: 92, down: 62).tap()
    XCTAssertFalse(selected.waitForExistence(timeout: 2))
    point(app, from: centre, right: 46, down: 31).tap()
    XCTAssertTrue(bar("Sky, Read the wind", in: app).waitForExistence(timeout: 5))
    empty.tap()
    XCTAssertTrue(selected.waitForNonExistence(timeout: 5))

    // One finger drags the picture down, and the step with it.
    let middle = point(app, from: centre, right: 0, down: 0)
    middle.press(forDuration: 0.1, thenDragTo: point(app, from: centre, right: 0, down: 80))
    point(app, from: centre, right: 46, down: 105).tap()
    XCTAssertTrue(bar("Sky, Read the wind", in: app).waitForExistence(timeout: 5))
  }

  // Roadmap on iOS §5: however the Graph keeps a pinch's frames, the picture at rest is the camera's. Each launch names
  // a way and has it act on a roadmap of any size; after a pinch in to the ceiling and one out to the floor, a tap
  // finds the step that stands under the finger.
  func testAPinchWhoseFramesAreKeptAnyWayLeavesEachStepUnderTheFinger() {
    for way in ["held", "coarse", "layered"] {
      let app = launch("roadmap-learn-to-sail", asking: ["-graph-pinch", way, "-graph-crowd", "0"])
      let (canvas, centre) = graph(of: app)
      let selected = app.buttons["roadmap-graph-step"]
      canvas.pinch(withScale: 6, velocity: 3)
      point(app, from: centre, right: -6, down: 93).tap()
      XCTAssertTrue(bar("Sky, Name the boat parts", in: app).waitForExistence(timeout: 5), way)
      point(app, from: centre, right: -100, down: -150).tap()
      XCTAssertTrue(selected.waitForNonExistence(timeout: 5), way)
      canvas.pinch(withScale: 0.1, velocity: -3)
      point(app, from: centre, right: 46, down: 31).tap()
      XCTAssertTrue(bar("Sky, Read the wind", in: app).waitForExistence(timeout: 5), way)
      app.terminate()
    }
  }

  // 04.1 and 04.3: with no step selected the band slot holds *Next* over the first Up next step, and its menu lists
  // the Up next steps in Roadmap Order under their count. A step picked is selected and glides to the centre of what
  // the bars leave, from 4 points right of it and 101 under; a tap on empty canvas brings *Next* back.
  func testNextListsTheUpNextStepsAndAStepPickedIsSelectedAndBroughtToTheCentre() {
    let app = launch("roadmap-learn-to-sail")
    let (_, centre) = graph(of: app)
    let next = app.buttons["roadmap-graph-next"]
    XCTAssertTrue(next.waitForExistence(timeout: 10))
    XCTAssertEqual(next.label, "Next, Read the wind")
    next.tap()
    XCTAssertTrue(app.staticTexts["2 up next"].waitForExistence(timeout: 5))
    let listed = app.buttons.matching(NSPredicate(format: "label IN %@", ["Read the wind", "Tie a bowline"])).allElementsBoundByIndex
    XCTAssertEqual(listed.map(\.label), ["Read the wind", "Tie a bowline"])
    listed[1].tap()
    XCTAssertTrue(bar("Learn, Tie a bowline", in: app).waitForExistence(timeout: 5))
    XCTAssertFalse(next.exists)

    // No step passes under this point while the picture glides, nor stands there once it rests.
    point(app, from: centre, right: -150, down: 180).tap()
    XCTAssertTrue(next.waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["roadmap-graph-step"].exists)
    point(app, from: centre, right: 0, down: 0).tap()
    XCTAssertTrue(bar("Learn, Tie a bowline", in: app).waitForExistence(timeout: 5))
  }

  // 04.5: Fit shows the whole roadmap and nothing else: the bar, the switch row and the foot leave, and the canvas has
  // what the status bar and the home indicator leave. One tap anywhere brings the bars back and selects nothing, and
  // the camera stays where Fit left it: each step a known way from the middle of what Fit had.
  func testFitShowsTheWholeRoadmapAloneAndOneTapBringsTheBarsBack() {
    let app = launch("roadmap-learn-to-sail")
    let (canvas, _) = graph(of: app)
    let barred = canvas.frame
    let (fit, selected) = (app.buttons["roadmap-fit"], app.buttons["roadmap-graph-step"])
    let chrome = [fit, app.buttons["roadmap-graph-next"], app.buttons["roadmap-new-step"], app.buttons["you"], app.segmentedControls.firstMatch]
    XCTAssertEqual(chrome.map(\.exists), [true, true, true, true, true])
    canvas.pinch(withScale: 6, velocity: 3)

    fit.tap()
    XCTAssertTrue(fit.waitForNonExistence(timeout: 5))
    XCTAssertEqual(chrome.map(\.exists), [false, false, false, false, false])
    let grown = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in canvas.frame.height > barred.height + 150 }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [grown], timeout: 5), .completed, "\(canvas.frame) from \(barred)")
    let whole = CGPoint(x: canvas.frame.midX, y: canvas.frame.midY)

    // *Read the wind* stands 92 points right of that middle and 62 under it; the tap there is Fit's, not the step's.
    point(app, from: whole, right: 92, down: 62).tap()
    XCTAssertTrue(fit.waitForExistence(timeout: 5))
    XCTAssertEqual(chrome.map(\.exists), [true, true, true, true, true])
    XCTAssertFalse(selected.exists)
    XCTAssertEqual(canvas.frame, barred)
    point(app, from: whole, right: 92, down: 62).tap()
    XCTAssertTrue(bar("Sky, Read the wind", in: app).waitForExistence(timeout: 5))
  }

  // 04.7: a roadmap with no step shows the Board's first step under the Graph too, and its New Step opens the form.
  func testARoadmapWithNoStepAsksForItsFirstUnderTheGraphToo() {
    let app = launch("roadmap-no-steps")
    XCTAssertTrue(app.staticTexts["Your first step"].waitForExistence(timeout: 30))
    app.segmentedControls.buttons["Graph"].tap()
    XCTAssertTrue(app.segmentedControls.buttons["Graph"].wait(for: \.isSelected, toEqual: true, timeout: 5))
    XCTAssertTrue(app.staticTexts["Your first step"].exists && app.staticTexts["Give your roadmap a place to start."].exists)
    XCTAssertFalse(app.descendants(matching: .any)["roadmap-graph"].exists || app.buttons["Sort and filter"].exists)
    app.buttons["roadmap-first-step"].tap()
    XCTAssertTrue(app.textFields["roadmap-form-name"].waitForExistence(timeout: 10))
  }

  // A row of Activity, or of a step's History, whose label begins with the words given.
  func activityRow(_ words: String, in app: XCUIApplication, history: Bool = false) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@",
                                                         history ? "roadmap-history-row" : "roadmap-activity-row", words)).firstMatch
  }

  // Roadmap · iOS 01.13b and 03.12, on a phone never signed in and with no server: Activity in the title menu reads the
  // phone's copy, its completions newest first and the eight steps planted at once folded into one row a tap opens; a
  // row opens its step's page, whose last row opens its History, the step's completion over its creation.
  func testActivityAndAStepsHistoryReadThePhonesCopySignedOut() {
    let app = launch("roadmap-many")
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    app.navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Learn to sail")).firstMatch.tap()
    XCTAssertTrue(app.buttons["Activity"].waitForExistence(timeout: 5))
    app.buttons["Activity"].tap()
    XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 10))
    let folded = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "roadmap-activity-added", "Added 8 steps, ")).firstMatch
    XCTAssertTrue(activityRow("Completed Rig the boat, ", in: app).waitForExistence(timeout: 10))
    XCTAssertTrue(activityRow("Completed Name the boat parts, ", in: app).exists && activityRow("Completed Choose a sailing course, ", in: app).exists)
    XCTAssertTrue(folded.exists && !activityRow("Added Sail solo, ", in: app).exists)
    folded.tap()
    XCTAssertTrue(activityRow("Added Sail solo, ", in: app).waitForExistence(timeout: 5))

    activityRow("Completed Rig the boat, ", in: app).tap()
    XCTAssertTrue(app.roadmapStepPage("Rig the boat"))
    // The page's last row, drawn up until it stands clear of the foot.
    let history = app.buttons["roadmap-step-history"]
    for _ in 0..<8 where !(history.exists && history.isHittable && history.frame.maxY < app.frame.maxY - 120) { app.swipeUp(velocity: .slow) }
    XCTAssertTrue(history.waitForHittable(timeout: 5))
    history.tap()
    XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 10))
    XCTAssertTrue(activityRow("Completed, ", in: app, history: true).waitForExistence(timeout: 10))
    XCTAssertTrue(activityRow("Added, ", in: app, history: true).exists)
    XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "roadmap-history-row").count, 2)
  }

  // 01.5b: while the signed-in phone's first read of its roadmaps runs, the room is its bar alone with a spinner, and the
  // Board takes its place once the copy is read.
  func testTheRoomsFirstReadShowsItsBarAndASpinnerUntilTheBoard() {
    let app = launch("roadmap-first-read")
    let spinner = app.descendants(matching: .any)["roadmap-first-read"]
    XCTAssertTrue(spinner.waitForExistence(timeout: 30))
    XCTAssertTrue(app.buttons["room-menu"].exists && !app.segmentedControls.firstMatch.exists && !app.buttons["roadmap-new-step"].exists)
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 60))
    XCTAssertFalse(spinner.exists)
  }

  // 02.10d: an Undo of a delete the engine keeps no Undo of by the time it is tapped brings nothing back; the band says so
  // in the receipt's place with no Undo, and the step stays deleted.
  func testAnUndoThatFindsNothingSaysWhatCouldNotComeBack() {
    let app = launch("roadmap-undo-finds-nothing", takingUndo: true)
    let undo = app.buttons["roadmap-undo"]
    XCTAssertTrue(app.roadmapStep("Tie a bowline").waitForExistence(timeout: 30))
    app.roadmapStep("Tie a bowline").swipeLeft()
    XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
    app.buttons["Delete"].tap()
    XCTAssertTrue(app.buttons["Delete Step"].waitForExistence(timeout: 5))
    app.buttons["Delete Step"].tap()
    XCTAssertTrue(undo.waitForExistence(timeout: 10))
    undo.tap()
    XCTAssertTrue(app.staticTexts["Couldn’t bring back Tie a bowline"].waitForExistence(timeout: 5))
    XCTAssertFalse(undo.exists)
    XCTAssertTrue(app.staticTexts["3 of 7 done"].exists && !app.roadmapStep("Tie a bowline").exists)
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
