import XCTest

// Share, Export and the public gallery against the verify skill's backend (Roadmap on iOS §3, §7.3, §7.4): signed in as the
// owner of a roadmap the account holds, the phone makes it public and exports it where the launch names; then, signed in
// as another account, Planted in Public lists it, its Fork copies it, and the copy arrives by sync and opens on its Board.
@MainActor final class RoadmapIntegrationFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // The Roadmap room of a launch signed in with a session's file, each account's storage its own.
  func launch(_ server: String, session: String, scenario: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-scenario", scenario, "-server", server, "-telemetry", "-code-file", session, "-roadmap-export", "roadmap-e2e.md"]
    app.launch()
    let menu = app.buttons["room-menu"]
    XCTAssertTrue(menu.waitForHittable(timeout: 30))
    menu.tap()
    let roadmap = app.roomItem("Roadmap")
    XCTAssertTrue(roadmap.waitForExistence(timeout: 5))
    roadmap.tap()
    return app
  }

  // The title of the open roadmap, once the roadmap named stands in the bar.
  func title(_ name: String, in app: XCUIApplication) -> XCUIElement {
    let title = app.navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    XCTAssertTrue(title.waitForExistence(timeout: 90))
    return title
  }

  func testARoadmapMadePublicIsExportedAndAnotherAccountForksItFromTheGallery() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let server = environment["WM_ROADMAP_E2E_SERVER"], let owner = environment["WM_ROADMAP_E2E_OWNER"],
          let reader = environment["WM_ROADMAP_E2E_READER"], let roadmap = environment["WM_ROADMAP_E2E_ROADMAP"] else {
      throw XCTSkip("requires the verify skill's isolated backend")
    }
    var app = launch(server, session: owner, scenario: "gym-e2e-roadmap-owner")
    let toggle = app.switches["roadmap-share-public"], footer = app.staticTexts["roadmap-share-footer"]
    title(roadmap, in: app).tap()
    app.buttons["Share…"].tap()
    XCTAssertTrue(toggle.waitForExistence(timeout: 10) && toggle.isEnabled)
    toggle.switches.firstMatch.tap()
    XCTAssertTrue(footer.waitForLabel("Anyone with this link can view and fork this roadmap, and it can appear in the public gallery.", timeout: 10))
    app.buttons["roadmap-share-copy"].tap()
    app.buttons["roadmap-share-link"].tap()
    let shareSheetCopy = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Copy'")).firstMatch
    XCTAssertTrue(shareSheetCopy.waitForExistence(timeout: 30))
    shareSheetCopy.tap()
    XCTAssertTrue(shareSheetCopy.waitForNonExistence(timeout: 10))
    app.buttons["roadmap-share-close"].tap()
    XCTAssertTrue(toggle.waitForNonExistence(timeout: 10))
    title(roadmap, in: app).tap()
    app.buttons["Export"].tap()
    // The switch's change reaches the server before the phone goes.
    app.buttons["you"].tap()
    XCTAssertTrue(app.staticTexts["Backed up"].waitForExistence(timeout: 60))
    app.terminate()

    app = launch(server, session: reader, scenario: "gym-e2e-roadmap-reader")
    XCTAssertTrue(app.buttons["roadmap-new"].waitForExistence(timeout: 60), "the reader's account holds no roadmap yet")
    app.buttons["roadmap-new"].tap()
    let name = app.textFields["roadmap-new-name"]
    XCTAssertTrue(name.waitForExistence(timeout: 10))
    name.tap()
    name.typeText("A place to start")
    app.buttons["roadmap-new-create"].tap()
    title("A place to start", in: app).tap()
    app.buttons["All Roadmaps…"].tap()
    XCTAssertTrue(app.buttons["roadmap-gallery-open"].waitForExistence(timeout: 10))
    app.buttons["roadmap-gallery-open"].tap()
    let row = app.cells.containing(.staticText, identifier: roadmap).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    row.buttons["roadmap-gallery-fork"].tap()
    let copy = row.buttons["roadmap-gallery-copy"]
    XCTAssertTrue(copy.waitForExistence(timeout: 60))
    copy.tap()
    XCTAssertTrue(app.staticTexts["Forked"].exists || title(roadmap, in: app).exists)
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 60) || app.buttons["roadmap-group-upNext"].exists)
  }
}
