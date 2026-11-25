import XCTest

@MainActor
final class ProbeUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ probe: String, variant: String = "") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-probe", probe, "-variant", variant]
        app.launch()
        return app
    }

    private func capture(_ name: String, in app: XCUIApplication) throws {
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let environment = ProcessInfo.processInfo.environment
        let folder = URL(fileURLWithPath: try XCTUnwrap(environment["SHOTS_DIR"]))
        let appearance = try XCTUnwrap(environment["SHOTS_APPEARANCE"])
        try XCUIScreen.main.screenshot().pngRepresentation.write(to: folder.appendingPathComponent("\(name)-\(appearance).png"))
        try app.debugDescription.write(to: folder.appendingPathComponent("\(name)-\(appearance).tree.txt"), atomically: true, encoding: .utf8)
    }

    func testFind() throws {
        executionTimeAllowance = 420
        let variants = [
            "minimize", "minimize-active", "minimize-searchtop", "minimize-searchtop-active",
            "minimize-searchbottom", "minimize-searchbottom-active", "drawer-scrolled", "drawer-scrolled-active",
            "conditional", "conditional-active", "conditional-dismissed", "toolbar", "toolbar-active",
        ]
        for variant in variants {
            let app = launch("room", variant: variant)
            XCTAssertTrue(app.collectionViews.firstMatch.waitForExistence(timeout: 30))
            if variant.contains("active") {
                _ = app.keyboards.firstMatch.waitForExistence(timeout: 8)
            }
            if variant.contains("dismissed") {
                _ = app.keyboards.firstMatch.waitForExistence(timeout: 8)
                _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 8)
            }
            try capture("13-find-\(variant)", in: app)
        }
    }

    func testFindMore() throws {
        executionTimeAllowance = 300
        for variant in ["conditional-shown", "conditional-slow-active", "drawerminimize", "drawerminimize-active", "drawer-nudged", "drawer-nudged-active"] {
            let app = launch("room", variant: variant)
            XCTAssertTrue(app.collectionViews.firstMatch.waitForExistence(timeout: 30))
            if variant.contains("active") {
                _ = app.keyboards.firstMatch.waitForExistence(timeout: 8)
            }
            if variant.contains("shown") {
                _ = app.searchFields.firstMatch.waitForExistence(timeout: 5)
            }
            try capture("13-find-\(variant)", in: app)
        }
    }

    func testFindNudges() throws {
        executionTimeAllowance = 300
        for variant in ["drawer-nudged", "drawer-nudged-active"] {
            let app = launch("room", variant: variant)
            XCTAssertTrue(app.collectionViews.firstMatch.waitForExistence(timeout: 30))
            if variant.contains("active") {
                _ = app.keyboards.firstMatch.waitForExistence(timeout: 8)
            }
            try capture("13-find-\(variant)", in: app)
        }
        let app = launch("room", variant: "drawer")
        let row = app.staticTexts["Step 3"]
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        let start = row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -40)), withVelocity: .slow, thenHoldForDuration: 0.3)
        try capture("13-find-drawer-dragged-40pt", in: app)
    }

    func testTitleWidthBudget() throws {
        executionTimeAllowance = 300
        for title in ["Coastal na…", "Coastal nav…", "Coastal navi…", "Coastal navig…", "Coastal naviga…"] {
            let app = XCUIApplication()
            app.launchArguments = ["-probe", "longtitle", "-variant", "spacer", "-title", title]
            app.launch()
            XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 30))
            try capture("14-longtitle-budget-\(title.count)-characters", in: app)
        }
    }

    func testFindLateAndKeptBar() throws {
        executionTimeAllowance = 420
        for variant in ["conditionalauto-shown", "conditionalauto-slow-active", "minimize-avoidhiding-active", "drawer-avoidhiding-active", "toolbar-searchtop"] {
            let app = launch("room", variant: variant)
            XCTAssertTrue(app.collectionViews.firstMatch.waitForExistence(timeout: 30))
            if variant.contains("active") {
                _ = app.keyboards.firstMatch.waitForExistence(timeout: 8)
            }
            if variant.contains("shown") {
                _ = app.searchFields.firstMatch.waitForExistence(timeout: 5)
            }
            try capture("13-find-\(variant)", in: app)
        }
        for variant in ["conditional", "conditionalauto", "drawer"] {
            let app = launch("room", variant: variant)
            XCTAssertTrue(app.buttons["Find"].waitForExistence(timeout: 30))
            if variant == "drawer" {
                let start = app.staticTexts["Step 3"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -40)), withVelocity: .slow, thenHoldForDuration: 0.3)
            }
            app.buttons["Find"].tap()
            guard app.keyboards.firstMatch.waitForExistence(timeout: 8) else {
                try capture("13-find-\(variant)-find-button-no-keyboard", in: app)
                continue
            }
            app.typeText("reef")
            try capture("13-find-\(variant)-find-button-active", in: app)
            let close = app.buttons["Close"].firstMatch
            guard close.waitForExistence(timeout: 5) else {
                try capture("13-find-\(variant)-find-button-no-close", in: app)
                continue
            }
            close.tap()
            _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 8)
            try capture("13-find-\(variant)-find-button-closed", in: app)
        }
        let app = launch("longtitle", variant: "nospacer-short")
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 30))
        try capture("14-longtitle-nospacer-short", in: app)
    }

    func testFindByTap() throws {
        executionTimeAllowance = 300
        for variant in ["minimize", "minimize-searchtop", "minimize-searchbottom", "toolbar"] {
            let app = launch("room", variant: variant)
            XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 30))
            let search = app.buttons["Search"].firstMatch
            guard search.waitForExistence(timeout: 5) else { continue }
            search.tap()
            guard app.keyboards.firstMatch.waitForExistence(timeout: 8) else {
                try capture("13-find-\(variant)-tapped-no-keyboard", in: app)
                continue
            }
            app.typeText("reef")
            try capture("13-find-\(variant)-tapped", in: app)
        }
    }

    func testLongTitles() throws {
        executionTimeAllowance = 300
        for variant in ["one", "spacer", "nospacer", "spacer-pretruncated", "spacer-principal", "spacer-principal-styled", "spacer-short"] {
            let app = launch("longtitle", variant: variant)
            XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 30))
            try capture("14-longtitle-\(variant)", in: app)
        }
    }

    func testMenu() throws {
        let app = launch("menu")
        app.buttons["More"].tap()
        XCTAssertTrue(app.buttons["Delete Roadmap"].waitForExistence(timeout: 10))
        try capture("01-menu-open", in: app)
    }

    func testMenuWithSymbols() throws {
        let app = launch("menu", variant: "symbols")
        app.buttons["More"].tap()
        XCTAssertTrue(app.buttons["Delete Roadmap"].waitForExistence(timeout: 10))
        try capture("01-menu-open-picker-symbols", in: app)
    }

    func testTitleMenu() throws {
        let app = launch("title", variant: "inline")
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 30))
        app.navigationBars.buttons["Learn to sail, Actions Menu"].tap()
        XCTAssertTrue(app.buttons["Guide"].waitForExistence(timeout: 10))
        try capture("02-title-inline-menu-open", in: app)
    }

    func testLargeTitleMenu() throws {
        let app = launch("title", variant: "large")
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 30))
        let title = app.staticTexts["Learn to sail"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        title.tap()
        _ = app.buttons["Guide"].waitForExistence(timeout: 5)
        try capture("02-title-large-after-title-tap", in: app)
    }

    func testLargeTitleScrolled() throws {
        let app = launch("title", variant: "large")
        XCTAssertTrue(app.staticTexts["Step 8"].waitForExistence(timeout: 30))
        app.staticTexts["Step 8"].press(forDuration: 0.1, thenDragTo: app.staticTexts["Step 3"], withVelocity: .slow, thenHoldForDuration: 0.3)
        try capture("02-title-large-scrolled", in: app)
    }

    func testRename() throws {
        let app = launch("rename")
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 30))
        app.navigationBars.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Rename"].waitForExistence(timeout: 10))
        try capture("03-rename-title-menu-open", in: app)
        app.buttons["Rename"].tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 10))
        try capture("03-rename-field", in: app)
    }

    func testSearchScrolled() throws {
        let app = launch("search", variant: "rest")
        XCTAssertTrue(app.staticTexts["Step 8"].waitForExistence(timeout: 30))
        app.staticTexts["Step 8"].press(forDuration: 0.1, thenDragTo: app.staticTexts["Step 3"], withVelocity: .slow, thenHoldForDuration: 0.3)
        try capture("06-search-rest-scrolled", in: app)
    }

    func testSearchAlwaysScrolled() throws {
        let app = launch("search", variant: "always")
        XCTAssertTrue(app.staticTexts["Step 8"].waitForExistence(timeout: 30))
        app.staticTexts["Step 8"].press(forDuration: 0.1, thenDragTo: app.staticTexts["Step 3"], withVelocity: .slow, thenHoldForDuration: 0.3)
        try capture("06-search-always-scrolled", in: app)
    }

    func testSwipeLeading() throws {
        let app = launch("swipe")
        let row = app.cells.firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)), withVelocity: .slow, thenHoldForDuration: 0.2)
        XCTAssertTrue(app.buttons["Complete"].waitForExistence(timeout: 10))
        try capture("09-swipe-leading-tall-row", in: app)
    }

    func testSwipeTrailing() throws {
        let app = launch("swipe")
        let row = app.cells.firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5)), withVelocity: .slow, thenHoldForDuration: 0.2)
        XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 10))
        try capture("09-swipe-trailing-tall-row", in: app)
    }

    func testSwipeShortRow() throws {
        let app = launch("swipe")
        let row = app.descendants(matching: .any)["swipe-short-row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)), withVelocity: .slow, thenHoldForDuration: 0.2)
        XCTAssertTrue(app.buttons["Complete"].waitForExistence(timeout: 10))
        try capture("09-swipe-leading-short-row", in: app)
    }
}
