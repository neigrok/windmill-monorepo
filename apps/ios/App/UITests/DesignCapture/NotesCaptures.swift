import XCTest

final class NotesCaptures: DesignCapture {
  func openNotes(_ look: Look) -> XCUIApplication {
    let app = launchSignedInCoach(look)
    app.buttons["you"].tap()
    reach(app.buttons["settings-notes"], app).tap()
    XCTAssertTrue(app.buttons["coach-add-note"].waitForExistence(timeout: 5))
    return app
  }
  func testNotes() {
    captureBoard("09.1-notes") { look in openNotes(look) }
  }
  // A saved note opens on its text with the keyboard up, Delete note under it.
  func testNoteEditor() {
    captureBoard("09.2-note-editor") { look in
      let app = openNotes(look)
      let note = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "How I want to be talked to")).firstMatch
      XCTAssertTrue(note.waitForExistence(timeout: 5)); note.tap()
      XCTAssertTrue(app.descendants(matching: .any)["coach-note-text"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      return app
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
