import XCTest

// What landed oddly and what could not land (Roadmap · iOS 10.2 to 10.5c) on the simulator's section 10 boards: a step made
// offline that lands following past a step deleted elsewhere, told once by the band and its page, and the one list of the
// changes to a roadmap deleted elsewhere, copied and discarded until it closes.
@MainActor final class RoadmapLandingFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // A band the flow taps stands ten minutes (`-band-stands`), so a slow runner cannot outlast it.
  func launch(_ board: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", board, "-band-stands", "600"]
    app.launch()
    XCTAssertTrue(app.navigationBars["Learn to sail"].waitForExistence(timeout: 60))
    return app
  }

  func change(_ words: String, in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "roadmap-set-aside-row", words)).firstMatch
  }

  // Roadmap · iOS 10.5a to 10.5c: Winter refit, deleted on another phone while this one, offline, added a step to it and
  // wrote a note in it. The title menu leads with *2 Set Aside*; the list names both under the roadmap, with why. Copy
  // leaves a change where it is, a swipe's Discard takes one asking nothing, and Discard All asks on itself and takes the
  // rest, closing the list and the menu's row with it.
  func testTheSetAsideListCopiesAndDiscardsItsChangesAndClosesOnceEmpty() {
    let app = launch("roadmap-sync-set-aside")
    app.titleMenuLeadingWithSetAside().tap()
    XCTAssertTrue(app.navigationBars["Set Aside"].waitForExistence(timeout: 10))
    let anchor = change("Anchor at night, New step", in: app), rota = change("Plan the watch rota, Note edited", in: app)
    XCTAssertTrue(anchor.waitForExistence(timeout: 10) && rota.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Winter refit"].exists && app.staticTexts["The roadmap was deleted elsewhere."].exists)

    let more = app.buttons.matching(identifier: "roadmap-set-aside-more")
    XCTAssertEqual(more.count, 2)
    more.element(boundBy: 0).tap()
    XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 5) && app.buttons["Discard"].exists)
    app.buttons["Copy"].tap()
    XCTAssertTrue(app.buttons["Copy"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(anchor.exists && rota.exists)

    anchor.swipeLeft()
    XCTAssertTrue(app.buttons["Discard"].waitForHittable(timeout: 5))
    app.buttons["Discard"].tap()
    XCTAssertTrue(anchor.waitForNonExistence(timeout: 10) && rota.exists)

    app.buttons["roadmap-set-aside-discard-all"].tap()
    let answer = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Discard All", "roadmap-set-aside-discard-all")).firstMatch
    XCTAssertTrue(answer.waitForHittable(timeout: 5))
    answer.tap()
    XCTAssertTrue(app.navigationBars["Set Aside"].waitForNonExistence(timeout: 10))

    let title = app.navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Learn to sail")).firstMatch
    XCTAssertTrue(title.waitForHittable(timeout: 10))
    title.tap()
    XCTAssertTrue(app.buttons["All Roadmaps…"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", "Set Aside")).firstMatch.exists)
  }

  // Roadmap · iOS 10.2 and 10.3: Reefing basics, made offline after Read the wind, which another phone deleted first,
  // lands following Name the boat parts. The band says so once, washing the step; Show opens its page, whose footer says
  // when this phone made it and why; once the band has gone, nothing tells it again.
  func testAStepThatLandedPastADeleteIsToldOnceByTheBandAndItsPage() {
    let app = launch("roadmap-sync-landed")
    let band = app.staticTexts["Reefing basics synced · it now follows Name the boat parts"]
    XCTAssertTrue(app.buttons["roadmap-show"].waitForHittable(timeout: 60))
    XCTAssertTrue(band.exists)
    XCTAssertTrue(app.staticTexts["3 of 8 done"].exists && !app.roadmapStep("Read the wind").exists)

    app.buttons["roadmap-show"].tap()
    XCTAssertTrue(app.roadmapStepPage("Reefing basics"))
    let footer = app.staticTexts["roadmap-step-landed"]
    XCTAssertTrue(footer.waitForExistence(timeout: 5))
    XCTAssertTrue(footer.label.hasPrefix("Made on this phone on "))
    XCTAssertTrue(footer.label.hasSuffix(". Read the wind was deleted on another device before it synced, so this step now follows Name the boat parts."))
    XCTAssertFalse(band.exists)
    XCTAssertTrue(app.descendants(matching: .any)["roadmap-step-status"].label.contains("Up next"))
  }
}
