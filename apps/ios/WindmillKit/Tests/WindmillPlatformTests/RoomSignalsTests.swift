import SwiftUI
import XCTest
@testable import WindmillPlatform

// What a room says outward, and what the shell is entitled to assume when it says nothing.
@MainActor
final class RoomSignalsTests: XCTestCase {
    private struct QuietRoom: ProductModule {
        let id = "quiet"
        let label = "Quiet"
        let symbol = "square"
        let entry = EntryDoor(verb: "v", line: "l", made: "m", back: "b")

        func room(_ account: Account) -> AnyView { AnyView(EmptyView()) }
        func hubLine(_ account: Account) -> HubLine { HubLine(eyebrow: "e", headline: "h") }
    }

    // Saying nothing means the shell keeps drawing the capsule over the room, as it always has.
    func testARoomThatDeclaresNothingDoesNotHostItsOwnTopChrome() {
        XCTAssertFalse(QuietRoom().hostsTopChrome)
    }

    // A room that has pushed nothing is at 0, which is the only depth where the leading edge means home.
    func testAnUnwrittenDepthIsTheRoot() {
        XCTAssertEqual(RoomDepthPreference.defaultValue, 0)
    }

    // A room writes its depth once, at its root. If a second writer ever appears the deepest wins, so
    // an open stack anywhere in the room keeps the shell off the leading edge.
    func testTheDeepestWriterWins() {
        var value = 0
        RoomDepthPreference.reduce(value: &value) { 2 }
        XCTAssertEqual(value, 2)

        RoomDepthPreference.reduce(value: &value) { 0 }
        XCTAssertEqual(value, 2)

        RoomDepthPreference.reduce(value: &value) { 5 }
        XCTAssertEqual(value, 5)
    }
}
