import XCTest

// The boards of a step that opens a roadmap (Roadmap · iOS 04.6, 05.1's Roadmap row, 07.1 to 07.12b), on the simulator's
// nested boards: *Become a day skipper*, whose *Learn to sail* opens *Learn to sail*.
final class RoadmapNestedCaptures: DesignCapture {
  // The board's Board at rest; a band stands one second, so an act's band has gone by the time a later screen is taken.
  func skipper(_ look: Look, board: String = "roadmap-nested", standing seconds: Int? = nil) -> XCUIApplication {
    let app = launch(board, look, arguments: seconds.map { ["-band-stands", String($0)] } ?? [])
    XCTAssertTrue(app.navigationBars["Become a day skipper"].waitForExistence(timeout: 60))
    XCTAssertTrue(app.roadmapStep("Day skipper exam").waitForExistence(timeout: 30))
    return app
  }

  func page(of step: String, in app: XCUIApplication) {
    XCTAssertTrue(app.roadmapStep(step).waitForHittable(timeout: 30))
    app.roadmapStep(step).tap()
    XCTAssertTrue(app.roadmapStepPage(step))
  }

  // The attach list from a step page's … menu.
  func attachList(of step: String, in app: XCUIApplication) {
    page(of: step, in: app)
    app.buttons["roadmap-step-more"].tap()
    XCTAssertTrue(app.buttons["Attach a Roadmap"].waitForExistence(timeout: 5))
    app.buttons["Attach a Roadmap"].tap()
    XCTAssertTrue(app.navigationBars["Roadmap"].waitForExistence(timeout: 10))
  }

  func paste(in app: XCUIApplication) {
    XCTAssertTrue(app.buttons["roadmap-attach-paste"].waitForHittable(timeout: 10))
    app.buttons["roadmap-attach-paste"].tap()
  }

  // 04.6: the step that opens a roadmap on the Graph, its mark beside its caption and the roadmap's progress under it.
  func testGraph() {
    captureBoard("04.6-roadmap-graph-opens-a-roadmap", settle: 2) { look in
      let app = skipper(look)
      app.segmentedControls.buttons["Graph"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["roadmap-graph"].waitForExistence(timeout: 10))
      // Picked from Next, the step is brought to the centre at a zoom where its caption, mark and line show.
      XCTAssertTrue(app.buttons["roadmap-graph-next"].waitForHittable(timeout: 10))
      app.buttons["roadmap-graph-next"].tap()
      XCTAssertTrue(app.buttons["Learn to sail"].waitForExistence(timeout: 5))
      app.buttons["Learn to sail"].tap()
      return app
    }
  }

  // 07.1 and 07.1b: the Board with the row's pill, and the row slid right for Open.
  func testBoard() {
    captureBoard("07.1-roadmap-board-opens-a-roadmap", settle: 1.5) { look in skipper(look) }
    captureBoard("07.1b-roadmap-swipe-reveals-open") { look in
      let app = skipper(look)
      app.roadmapStep("Learn to sail").swipeRight()
      XCTAssertTrue(app.buttons["Open"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 07.2 and 07.2b: the step's page Up next, and Locked once its prerequisite is reset.
  func testStepPage() {
    captureBoard("07.2-roadmap-step-opens-a-roadmap") { look in
      let app = skipper(look)
      page(of: "Learn to sail", in: app)
      return app
    }
    captureBoard("07.2b-roadmap-step-locked-opens-a-roadmap") { look in
      let app = skipper(look, standing: 1)
      page(of: "Learn to sail", in: app)
      page(of: "Day skipper theory", in: app)
      app.buttons["roadmap-reset"].tap()
      XCTAssertTrue(app.buttons["roadmap-reset"].waitForNonExistence(timeout: 10))
      app.navigationBars.firstMatch.buttons.element(boundBy: 0).tap()
      XCTAssertTrue(app.roadmapStepPage("Learn to sail") && app.buttons["roadmap-undo"].waitForNonExistence(timeout: 10))
      return app
    }
  }

  // 07.3: Learn to sail's Board, gone into from its step's page.
  func testGoneIn() {
    captureBoard("07.3-roadmap-gone-in", settle: 1.5) { look in
      let app = skipper(look)
      page(of: "Learn to sail", in: app)
      app.buttons["roadmap-open-roadmap"].tap()
      XCTAssertTrue(app.navigationBars["Learn to sail"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.roadmapStep("Read the wind").waitForExistence(timeout: 10))
      return app
    }
  }

  // 07.4: the step Done by its roadmap, every step of which is done.
  func testDoneByItsRoadmap() {
    captureBoard("07.4-roadmap-step-done-by-its-roadmap") { look in
      let app = skipper(look, board: "roadmap-nested-done")
      XCTAssertTrue(app.buttons["roadmap-group-done"].waitForHittable(timeout: 10))
      app.buttons["roadmap-group-done"].tap()
      page(of: "Learn to sail", in: app)
      return app
    }
  }

  // 07.5a to 07.5d: the odd ends, each on its step's page, and the three on the Board.
  func testOddEnds() {
    for (screen, step) in [("07.5a-roadmap-odd-end-no-steps", "Night passage"), ("07.5b-roadmap-odd-end-loops-back", "Learn to sail"),
                           ("07.5c-roadmap-odd-end-not-found", "Log 100 miles")] {
      captureBoard(screen) { look in
        let app = skipper(look, board: "roadmap-nested-odd")
        page(of: step, in: app)
        return app
      }
    }
    captureBoard("07.5d-roadmap-odd-ends-on-the-board", settle: 1.5) { look in skipper(look, board: "roadmap-nested-odd") }
  }

  // 07.6, 07.6b and 07.6c: the attach list from the … menu, with no other roadmap, and from Change Roadmap.
  func testAttachList() {
    captureBoard("07.6-roadmap-attach-a-roadmap") { look in
      let app = skipper(look)
      attachList(of: "Log 100 miles", in: app)
      return app
    }
    captureBoard("07.6b-roadmap-attach-no-other-roadmaps") { look in
      let app = launch("roadmap-learn-to-sail", look)
      XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
      attachList(of: "Read the wind", in: app)
      return app
    }
    captureBoard("07.6c-roadmap-attach-step-opens-one") { look in
      let app = skipper(look)
      page(of: "Learn to sail", in: app)
      app.buttons["roadmap-step-roadmap-more"].tap()
      XCTAssertTrue(app.buttons["Change Roadmap"].waitForExistence(timeout: 5))
      app.buttons["Change Roadmap"].tap()
      XCTAssertTrue(app.buttons["roadmap-attach-none"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 07.7 and 07.7b: a pasted link to someone else's roadmap, and one with no roadmap the person can read.
  func testPastedLink() {
    captureBoard("07.7-roadmap-attach-someone-elses") { look in
      let app = skipper(look)
      attachList(of: "Log 100 miles", in: app)
      paste(in: app)
      XCTAssertTrue(app.buttons["roadmap-attach-fork"].waitForHittable(timeout: 30))
      return app
    }
    captureBoard("07.7b-roadmap-attach-nothing-there") { look in
      let app = skipper(look)
      UIPasteboard.general.url = URL(string: "https://windmill.works/t/t_00000000000000fe")
      attachList(of: "Log 100 miles", in: app)
      paste(in: app)
      XCTAssertTrue(app.staticTexts["No roadmap you can read is at that address."].waitForExistence(timeout: 30))
      return app
    }
  }

  // 07.8 to 07.10: *Learn to sail* attached with the band; the … menu; marked Done by hand first, attached with the mark
  // set aside; and detached with the mark back. The board whose step opens no roadmap yet is attached afresh.
  func testAttachAndDetach() {
    let attached = { (app: XCUIApplication, completing: Bool) in
      self.page(of: "Learn to sail", in: app)
      XCTAssertTrue(app.buttons["roadmap-complete"].waitForHittable(timeout: 10))
      if completing {
        app.buttons["roadmap-complete"].tap()
        XCTAssertTrue(app.buttons["roadmap-reset"].waitForHittable(timeout: 10))
      }
      app.buttons["roadmap-step-more"].tap()
      XCTAssertTrue(app.buttons["Attach a Roadmap"].waitForExistence(timeout: 5))
      app.buttons["Attach a Roadmap"].tap()
      let sail = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "roadmap-attach-row", "Learn to sail")).firstMatch
      XCTAssertTrue(sail.waitForHittable(timeout: 10))
      sail.tap()
      XCTAssertTrue(app.staticTexts["Roadmap attached"].waitForExistence(timeout: 10))
    }
    captureBoard("07.8-roadmap-attached") { look in
      let app = skipper(look, board: "roadmap-nested-unattached")
      attached(app, false)
      return app
    }
    captureBoard("07.8b-roadmap-attached-mark-set-aside") { look in
      let app = skipper(look, board: "roadmap-nested-unattached")
      attached(app, true)
      return app
    }
    captureBoard("07.9-roadmap-row-menu") { look in
      let app = skipper(look)
      page(of: "Learn to sail", in: app)
      app.buttons["roadmap-step-roadmap-more"].tap()
      XCTAssertTrue(app.buttons["Detach Roadmap"].waitForExistence(timeout: 5))
      return app
    }
    captureBoard("07.10-roadmap-detached-mark-back") { look in
      let app = skipper(look, board: "roadmap-nested-unattached")
      attached(app, true)
      app.buttons["roadmap-step-roadmap-more"].tap()
      XCTAssertTrue(app.buttons["Detach Roadmap"].waitForExistence(timeout: 5))
      app.buttons["Detach Roadmap"].tap()
      XCTAssertTrue(app.staticTexts["Roadmap detached · your mark is back"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 07.11 and 07.11b: a step with a subtree, and the subtree gone into with its … menu open.
  func testSubtree() {
    captureBoard("07.11-roadmap-step-with-a-subtree") { look in
      let app = skipper(look, board: "roadmap-nested-subtree")
      page(of: "Night passage", in: app)
      return app
    }
    captureBoard("07.11b-roadmap-inside-a-subtree-menu") { look in
      let app = skipper(look, board: "roadmap-nested-subtree")
      page(of: "Night passage", in: app)
      app.buttons["roadmap-open-roadmap"].tap()
      XCTAssertTrue(app.buttons["roadmap-inside-more"].waitForHittable(timeout: 10))
      app.buttons["roadmap-inside-more"].tap()
      XCTAssertTrue(app.buttons["Activity"].waitForExistence(timeout: 5))
      return app
    }
  }

  // 07.12a and 07.12b: fork first, tapped with no connection, and signed out.
  func testForkFirst() {
    captureBoard("07.12a-roadmap-fork-first-no-connection") { look in
      let app = skipper(look, board: "roadmap-nested-offline")
      attachList(of: "Log 100 miles", in: app)
      paste(in: app)
      XCTAssertTrue(app.buttons["roadmap-attach-fork"].waitForHittable(timeout: 30))
      app.buttons["roadmap-attach-fork"].tap()
      XCTAssertTrue(app.staticTexts["Forking needs a connection."].waitForExistence(timeout: 10))
      return app
    }
    captureBoard("07.12b-roadmap-fork-first-signed-out") { look in
      let app = skipper(look, board: "roadmap-nested-signed-out")
      attachList(of: "Log 100 miles", in: app)
      paste(in: app)
      XCTAssertTrue(app.buttons["roadmap-attach-fork"].waitForHittable(timeout: 30))
      return app
    }
  }

  // 05.1: New Step with its Roadmap row.
  func testNewStepRoadmapRow() {
    captureBoard("05.1-roadmap-new-step-roadmap-row") { look in
      let app = skipper(look)
      XCTAssertTrue(app.buttons["roadmap-new-step"].waitForHittable(timeout: 30))
      app.buttons["roadmap-new-step"].tap()
      XCTAssertTrue(app.buttons["roadmap-form-roadmap"].waitForExistence(timeout: 10))
      return app
    }
  }
}
