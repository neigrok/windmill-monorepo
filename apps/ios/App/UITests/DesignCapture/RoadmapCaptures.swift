import XCTest

// The Roadmap room's boards (Roadmap · iOS), and its door on Where to start? (Shell 02a).
final class RoadmapCaptures: DesignCapture {
  // 01.1: *Learn to sail* on its Board, as it arrives from its account.
  func testBoardAtRest() {
    captureBoard("01.1-roadmap-board-at-rest", settle: 1.5) { look in
      let app = launch("roadmap-learn-to-sail", look)
      XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 01.2: the room capsule's menu, with Roadmap checked.
  func testRoomMenu() {
    for look in Look.both {
      let app = launch("roadmap-learn-to-sail", look)
      XCTAssertTrue(app.buttons["roadmap-group-locked"].waitForExistence(timeout: 30))
      roomMenuOpen("01.2-roadmap-room-menu", look, app, current: "Roadmap")
      app.terminate()
    }
  }

  // 01.5: a phone that holds no roadmap.
  func testNoRoadmapYet() {
    captureBoard("01.5-roadmap-no-roadmap-yet") { look in
      let app = launch("roadmap-empty", look)
      XCTAssertTrue(app.staticTexts["No roadmaps yet"].waitForExistence(timeout: 30))
      return app
    }
  }

  // 10.9, in the room: a read of the phone's copy that failed.
  func testCouldNotLoad() {
    captureBoard("10.9-roadmap-could-not-load") { look in
      let app = launch("roadmap-unreadable", look)
      XCTAssertTrue(app.staticTexts["Couldn’t load this roadmap"].waitForExistence(timeout: 30))
      return app
    }
  }

  // Shell 02a: Where to start? with its third door.
  func testRoadmapDoor() {
    captureBoard("02a-where-to-start-roadmap-door", settle: 1.5) { look in
      let app = launch("shell-anonymous", look)
      XCTAssertTrue(app.buttons["open-roadmap"].waitForExistence(timeout: 30))
      return app
    }
  }
}
