import XCTest

// The Graph's flows (Roadmap · iOS 04.1 to 04.5, 04.7) on the simulator's boards. The canvas is one element, as
// VoiceOver hears it, so a step is tapped where the layout seats it: *Learn to sail* opens at the phone's working zoom
// with the middle of its seats' box at the centre of what the bars leave, and each step stands a known way from that
// centre (`packages/api-contract/roadmap/layout/learn-to-sail.json` pins the seats). The zoom floor is half the opening
// zoom, and the pinch ceiling 2.94 times it. The band slot holds *Next* at rest and the selected step's bar once one
// is selected, so that centre is read while no step is selected, and a pinch, which XCTest centres on the element,
// is made then too.
@MainActor final class RoadmapFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  func launch(_ board: String, asking more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board] + more
    app.launch()
    return app
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
}
