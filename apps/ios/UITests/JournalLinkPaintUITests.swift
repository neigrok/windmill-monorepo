import XCTest

// The composer paints its links on a layer over the field, and whether that layer sits ON the text or a
// hair off it cannot be answered anywhere but a running simulator: a text field's own line breaks are
// decided by the field, and this test is the only place both layers are laid out for real.
final class JournalLinkPaintUITests: XCTestCase {
    private var app: XCUIApplication!

    private let page = "Went back to https://en.wikipedia.org/wiki/Windmill_(machine) after the walk, then www.example.com and one that has to wrap: https://arxiv.org/abs/2401.12345?utm_source=longenoughtowrapaline. Nothing else. e.g. things.Ok is not one, and neither is example.com."

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-windmill.journey.asked", "YES", "-windmill.journey.lastRoom", "journal"]
        app.launch()
    }

    override func tearDown() {
        app?.terminate()
        app = nil
    }

    private func frame(_ named: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = named
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testTheLinkIsLitUnderTheCaretAsItIsWritten() {
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 20), "the journal room never opened its composer")
        field.tap()
        field.typeText(page)
        frame("composer — the paint over the field")
        // The written page is what the field holds, whatever is painted over it.
        XCTAssertEqual(field.value as? String, page, "the paint changed what the field holds")
    }
}
