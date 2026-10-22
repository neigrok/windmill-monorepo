import XCTest

final class NotesCaptures: DesignCapture {
  func testNotes() {
    for look in Look.both {
      let app = launchSignedInCoach(look)
      app.buttons["you"].tap()
      reach(app.buttons["settings-notes"], app).tap()
      XCTAssertTrue(app.buttons["coach-add-note"].waitForExistence(timeout: 5))
      capture("09.1-notes", look, app)
      app.buttons["coach-add-note"].tap()
      let title = app.descendants(matching: .any)["coach-note-title"]
      XCTAssertTrue(title.waitForExistence(timeout: 5)); title.tap(); title.typeText("Training focus")
      capture("09.2-note-editor", look, app)
    }
  }

  func testSignedOut() {
    for look in Look.both {
      let app = launch("shell-last-room", look)
      openGymFromJournal(app, opensOn: .coach)
      app.buttons["you"].tap()
      reach(app.buttons["settings-notes"], app).tap()
      XCTAssertTrue(app.staticTexts["Notes live with your account, so they need you signed in."].waitForExistence(timeout: 5))
      capture("gym-coach-notes-signed-out", look, app)
    }
  }
}
