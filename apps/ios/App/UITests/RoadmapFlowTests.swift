import XCTest

// The Roadmap room's flows on the simulator's boards: a step's workspace (Roadmap · iOS 03.2, 03.3, 03.10, 03.11, 03.14)
// and the step form's links (05.1, 05.8), then the Graph's (04.1, 04.2, 04.4, 04.7). The canvas is one element, as
// VoiceOver hears it, so a step is tapped where the layout seats it: *Learn to sail* opens at the phone's working zoom
// with the middle of its seats' box at the centre of what the bars leave, and each step stands a known way from that
// centre (`packages/api-contract/roadmap/layout/learn-to-sail.json` pins the seats). The zoom floor is half the opening
// zoom, and the pinch ceiling 2.94 times it. A selected step's bar takes room at the foot, so that centre is read
// while no step is selected, and a pinch, which XCTest centres on the element, is made then too.
@MainActor final class RoadmapFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func launch(_ board: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board]
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
    let app = launch("roadmap-workspace")
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
    let app = launch("roadmap-learn-to-sail")
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
}
