import UIKit
import XCTest

// What the room's chrome looks like once the platform has drawn it. Every claim here failed once on a
// running simulator and none of them can fail in a unit test: a control's colour is decided by the
// environment it renders in, and a navigation bar's margins are decided by the container it sits in.
final class RoomChromeUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-windmill.journey.asked", "YES", "-windmill.journey.lastRoom", "gym"]
        app.launch()
        XCTAssertTrue(app.buttons["Coach"].waitForExistence(timeout: 20), "the gym room never opened")
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

    // The two colours a control actually paints, read out of the middle of it — the ground it fills
    // itself with and the ink it puts on top. The middle only, because a rounded button's corners are
    // the screen behind it and would answer a question nobody asked.
    private func inkAgainstGround(inside element: XCUIElement) -> (ground: Int, ink: Int, ratio: Double)? {
        let shot = XCUIScreen.main.screenshot().image
        guard let cg = shot.cgImage else { return nil }
        let scale = CGFloat(cg.width) / shot.size.width
        let box = element.frame
        let rect = CGRect(x: (box.minX + box.width * 0.25) * scale,
                          y: (box.minY + box.height * 0.30) * scale,
                          width: box.width * 0.5 * scale,
                          height: box.height * 0.4 * scale).integral
        guard rect.width >= 4, rect.height >= 4, let crop = cg.cropping(to: rect) else { return nil }

        let width = crop.width, height = crop.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return nil
        }
        context.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))

        var counts: [Int: Int] = [:]
        for at in stride(from: 0, to: pixels.count, by: 4) {
            let hex = Int(pixels[at]) << 16 | Int(pixels[at + 1]) << 8 | Int(pixels[at + 2])
            counts[hex, default: 0] += 1
        }
        guard let ground = counts.max(by: { $0.value < $1.value })?.key else { return nil }
        let floor = max(8, (width * height) / 50)
        let ink = counts.filter { $0.value >= floor }
            .max { relative($0.key, ground) < relative($1.key, ground) }?.key
        guard let ink, ink != ground else { return nil }
        return (ground, ink, contrast(ground, ink))
    }

    private func relative(_ hex: Int, _ other: Int) -> Double { abs(luminance(hex) - luminance(other)) }

    private func luminance(_ hex: Int) -> Double {
        func channel(_ raw: Int) -> Double {
            let value = Double(raw) / 255
            return value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(hex >> 16 & 0xFF) + 0.7152 * channel(hex >> 8 & 0xFF)
            + 0.0722 * channel(hex & 0xFF)
    }

    private func contrast(_ one: Int, _ other: Int) -> Double {
        let high = max(luminance(one), luminance(other)), low = min(luminance(one), luminance(other))
        return (high + 0.05) / (low + 0.05)
    }

    private func hex(_ value: Int) -> String { String(format: "#%06X", value) }

    // `.tint` is an environment value, so a tint put on the TabView for the tab bar reaches every
    // control in all three tabs and every sheet they raise. It once painted this button's fill with
    // the room's brightest ink while the system painted its label white: 1.18:1, on the only door to
    // a movement the catalogue does not hold yet.
    func testThePickersCreateActionIsLegibleAgainstItsOwnFill() {
        app.navigationBars.buttons["New routine"].tap()
        XCTAssertTrue(app.buttons["Add movement"].waitForExistence(timeout: 10))
        app.buttons["Add movement"].tap()

        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("zzqqx")
        XCTAssertTrue(app.staticTexts["No movement by that name."].waitForExistence(timeout: 10),
                      "the picker drew no empty state for a query that matches nothing")

        let create = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Create")).firstMatch
        XCTAssertTrue(create.waitForExistence(timeout: 10), "the empty state lost its Create action")
        frame("fixc-no-match")

        guard let read = inkAgainstGround(inside: create) else {
            return XCTFail("the Create action drew one flat colour — no label was painted on it")
        }
        XCTAssertGreaterThanOrEqual(read.ratio, 4.5,
                                    "Create draws \(hex(read.ink)) on \(hex(read.ground)) — "
                                    + "\(String(format: "%.2f", read.ratio)):1")
    }

    // Settings is a `Form`, and each segmented `Picker` in it hides its own label: the group's name is
    // its section header, drawn once over the control.
    func testTheUnitsCardSaysWhatItIs() {
        let door = app.buttons["Gym settings"]
        XCTAssertTrue(door.waitForExistence(timeout: 20))
        if !door.isHittable { app.swipeUp() }
        door.tap()
        let footer = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@",
                                                          "Display only — nothing stored changes.")).firstMatch
        XCTAssertTrue(footer.waitForExistence(timeout: 10))
        frame("fixc-settings")

        XCTAssertTrue(app.staticTexts["Units"].exists,
                      "the kg | lb control is drawn with no name over it")
        for named in ["Rest timer", "Set confirmation"] {
            XCTAssertTrue(app.staticTexts[named].exists, "\(named) lost its head too")
        }
    }

    // The first root the room opens on is handed a navigation bar whose layout margins are zero, and
    // it never revisits them — the large title sits against the bezel for the whole visit unless the
    // lifter changes tab. The room states the margin instead, so this reads it on the root the room
    // opens on, before anything has been touched.
    func testEveryRootsLargeTitleSharesItsLeadingMarginWithTheContent() {
        // Present in both states of this root — the empty state's second action and, once routines
        // exist, the reach band — and inset by the room's own margin either way.
        let logging = app.buttons["Just start logging"].firstMatch
        XCTAssertTrue(logging.waitForExistence(timeout: 15), "the routines root drew no content to measure")
        frame("fixc-routines-root")
        let routines = app.navigationBars["Routines"].staticTexts["Routines"]
        XCTAssertTrue(routines.exists, "the routines root drew no large title")
        // Read before the tab changes: the bar goes with the tab, and so does the frame query.
        let margin = routines.frame.minX
        XCTAssertEqual(margin, logging.frame.minX, accuracy: 2,
                       "the title and the content under it start at different margins")

        app.tabBars.buttons["The log"].tap()
        let head = app.navigationBars["The log"].staticTexts["The log"]
        XCTAssertTrue(head.waitForExistence(timeout: 10), "the log root drew no large title")
        XCTAssertEqual(head.frame.minX, margin, accuracy: 2,
                       "the two roots put their large titles in different places")
    }
}
