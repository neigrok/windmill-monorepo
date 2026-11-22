import XCTest

// The Graph's flows (Roadmap · iOS 04.1, 04.2, 04.4, 04.7) on the simulator's boards. The canvas is one element, as
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
