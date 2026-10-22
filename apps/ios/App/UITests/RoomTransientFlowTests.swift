import XCTest
import UIKit

@MainActor final class RoomTransientFlowTests: XCTestCase {
  func testNativeTrashRequiresConfirmationAndLeavesNoUndo() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "shell-anonymous", "-onboarding-appearance", "light", "-gym-log-fixture"]
    app.launch()
    XCTAssertTrue(app.buttons["open-gym"].waitForExistence(timeout: 15)); app.buttons["open-gym"].tap()
    XCTAssertTrue(app.tabBars.buttons["The log"].waitForExistence(timeout: 10)); app.tabBars.buttons["The log"].tap()
    let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 20))
    let id = row.identifier
    row.swipeLeft()
    let trash = app.buttons["trash-swipe"]
    XCTAssertTrue(trash.wait(for: \.isHittable, toEqual: true, timeout: 5))
    XCTAssertEqual(trash.label, "Discard workout")
    XCTAssertTrue(app.buttons[id].exists)
    XCTAssertFalse(app.buttons["Discard"].exists)
    let image = try XCTUnwrap(trash.screenshot().image.cgImage)
    var pixel = [UInt8](repeating: 0, count: 4)
    pixel.withUnsafeMutableBytes { bytes in
      let context = CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      context?.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    }
    XCTAssertGreaterThan(Int(pixel[0]), Int(pixel[1]) + 30)
    XCTAssertGreaterThan(Int(pixel[0]), Int(pixel[2]) + 30)
    trash.tap()
    XCTAssertTrue(trash.waitForNonExistence(timeout: 5))
    let confirmation = app.buttons["Discard workout"]
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    app.cancelConfirmation()
    XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons[id].exists)
    app.buttons[id].swipeLeft()
    XCTAssertTrue(trash.wait(for: \.isHittable, toEqual: true, timeout: 5)); trash.tap()
    XCTAssertTrue(trash.waitForNonExistence(timeout: 5))
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5)); confirmation.tap()
    XCTAssertTrue(app.buttons[id].waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.buttons["gym-log-undo"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["gym-log-undo-band"].exists)
  }
}
