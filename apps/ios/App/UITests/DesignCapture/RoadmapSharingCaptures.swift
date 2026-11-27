import XCTest

// The boards of Share, Export and the public gallery (Roadmap · iOS 09.1a to 09.3, 09.12a, 09.12b), each in Dark and
// Daylight: the Share sheet over the open roadmap on the boards' accounts, the system's exporter, and Planted in Public under
// All Roadmaps over the board's gallery.
final class RoadmapSharingCaptures: DesignCapture {
  // A board's roadmap with an item of its title menu chosen, once the roadmap's name stands in the bar.
  func titleMenu(of board: String, named roadmap: String = "Learn to sail", item: String, _ look: Look) -> XCUIApplication {
    let app = launch(board, look)
    let title = app.navigationBars.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", roadmap)).firstMatch
    XCTAssertTrue(title.waitForExistence(timeout: 60))
    XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
    title.tap()
    XCTAssertTrue(app.buttons[item].waitForExistence(timeout: 5))
    app.buttons[item].tap()
    return app
  }

  // The Share sheet raised, its switch turned on where the board asks for the roadmap public.
  func share(on board: String, named roadmap: String = "Learn to sail", public turned: Bool, _ look: Look) -> XCUIApplication {
    let app = titleMenu(of: board, named: roadmap, item: "Share", look)
    let toggle = app.switches["roadmap-share-public"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    guard turned else { return app }
    toggle.switches.firstMatch.tap()
    XCTAssertTrue(app.buttons["roadmap-share-copy"].waitForExistence(timeout: 10))
    return app
  }

  // Planted in Public, from All Roadmaps, on the gallery's board.
  func gallery(_ board: String, _ look: Look) -> XCUIApplication {
    let app = titleMenu(of: board, named: "Spanish B1", item: "All Roadmaps…", look)
    XCTAssertTrue(app.buttons["roadmap-gallery-open"].waitForExistence(timeout: 10))
    app.buttons["roadmap-gallery-open"].tap()
    return app
  }

  // 09.1a: a private roadmap's Share sheet.
  func testSharePrivate() {
    captureBoard("09.1a-roadmap-share-private") { look in share(on: "roadmap-learn-to-sail", public: false, look) }
  }

  // 09.1b: the switch on, with Share Link and Copy Link.
  func testSharePublic() {
    captureBoard("09.1b-roadmap-share-public") { look in share(on: "roadmap-learn-to-sail", public: true, look) }
  }

  // 09.1c: *Become a day skipper*, whose *Night passage* owns a subtree, made public.
  func testSharePublicWithSubtrees() {
    captureBoard("09.1c-roadmap-share-public-subtrees") { look in
      share(on: "roadmap-nested-subtree", named: "Become a day skipper", public: true, look)
    }
  }

  // 09.2a: signed out, on a phone never signed in.
  func testShareSignedOut() {
    captureBoard("09.2a-roadmap-share-signed-out") { look in
      let app = share(on: "roadmap-many", public: false, look)
      XCTAssertTrue(app.buttons["roadmap-share-sign-in"].waitForExistence(timeout: 10))
      return app
    }
  }

  // 09.2b: with no connection.
  func testShareWithNoConnection() {
    captureBoard("09.2b-roadmap-share-no-connection") { look in
      let app = share(on: "roadmap-sync-offline", public: false, look)
      XCTAssertTrue(app.staticTexts["Sharing needs a connection."].waitForExistence(timeout: 10))
      return app
    }
  }

  // 09.3: the system's exporter over the room, handed *Learn to sail*'s file.
  func testExport() {
    captureBoard("09.3-roadmap-export", settle: 3) { look in titleMenu(of: "roadmap-learn-to-sail", item: "Export", look) }
  }

  // 09.12a: Planted in Public, both pages read, *Room makeover* forked so it offers the copy.
  func testGallery() {
    captureBoard("09.12a-roadmap-gallery") { look in
      let app = gallery("roadmap-gallery", look)
      let makeover = app.cells.containing(.staticText, identifier: "Room makeover").firstMatch
      XCTAssertTrue(makeover.waitForExistence(timeout: 30) && app.staticTexts["ML foundations"].waitForExistence(timeout: 30))
      makeover.buttons["roadmap-gallery-fork"].tap()
      XCTAssertTrue(makeover.buttons["roadmap-gallery-copy"].waitForExistence(timeout: 60))
      return app
    }
  }

  // 09.12b: a gallery that cannot be reached.
  func testGalleryUnreachable() {
    captureBoard("09.12b-roadmap-gallery-unreachable") { look in
      let app = gallery("roadmap-gallery-unreachable", look)
      XCTAssertTrue(app.buttons["roadmap-gallery-try-again"].waitForExistence(timeout: 30))
      return app
    }
  }
}
