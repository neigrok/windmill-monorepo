import XCTest

@MainActor final class OnboardingFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // A fresh phone reads the four pages in order, lands on Where to start?, and replays them from You's About Windmill,
  // whose Done leaves from its last page or from any other.
  func testFirstLaunchFourScreensThenWhereToStart() {
    let pages = OnboardingPages.launch(), app = pages.app
    for page in 0..<4 {
      pages.assertPage(page)
      // VoiceOver reads the page top to bottom, and its glimpse is one element with nothing inside it.
      let snapshot = app.debugDescription
      let identifiers = snapshot.components(separatedBy: "Path to element:")[0].split(separator: "\n").compactMap { text -> String? in
        guard let start = text.range(of: "identifier: '")?.upperBound else { return nil }
        let value = text[start...]
        guard value.hasPrefix("onboarding-"), let end = value.firstIndex(of: "'") else { return nil }
        return String(value[..<end])
      }
      XCTAssertEqual(identifiers, page == 0
        ? ["onboarding-identity", "onboarding-exit", "onboarding-title", "onboarding-body", "onboarding-glimpse", "onboarding-page-control", "onboarding-next"]
        : (page < 3 ? ["onboarding-exit"] : []) + ["onboarding-eyebrow", "onboarding-title", "onboarding-body", "onboarding-tag", "onboarding-glimpse",
                                                  "onboarding-page-control", "onboarding-next"], snapshot)
      let glimpse = pages.glimpse(page)
      XCTAssertEqual([glimpse.staticTexts.count, glimpse.buttons.count, glimpse.images.count], [0, 0, 0])
      XCTAssertFalse(app.buttons["open-journal"].exists)
      app.buttons["onboarding-next"].tap()
    }
    pages.assertWhereToStart()
    XCTAssertFalse(app.textViews["journal-editor"].exists)

    app.buttons["open-journal"].tap()
    let editor = app.textViews["journal-editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10)); editor.tap()
    let doneWriting = app.buttons["done-writing"]
    XCTAssertTrue(doneWriting.waitForExistence(timeout: 5)); doneWriting.tap()
    app.buttons["you"].tap()
    let about = app.buttons["about-windmill"]
    XCTAssertTrue(about.waitForExistence(timeout: 5))
    XCTAssertEqual(about.label, "About Windmill")
    about.tap()
    for page in 0..<4 {
      pages.assertPage(page, replay: true)
      app.buttons["onboarding-next"].tap()
    }
    XCTAssertTrue(about.waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["onboarding-title"].exists)
    about.tap()
    pages.assertPage(0, replay: true)
    app.buttons["onboarding-next"].tap()
    pages.assertPage(1, replay: true)
    app.buttons["onboarding-exit"].tap()
    XCTAssertTrue(about.waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["onboarding-title"].exists)
    XCTAssertFalse(app.buttons["open-journal"].exists)
    app.buttons["Done"].tap()
    XCTAssertTrue(editor.waitForExistence(timeout: 5))
    XCTAssertEqual(editor.value as? String, "")
  }
}
